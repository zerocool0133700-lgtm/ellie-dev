/**
 * Context Sections API — ELLIE-334
 *
 * Reads and writes prompt section content for the dashboard editor.
 * Each section has a type (file, forest, hardcoded, dynamic) and
 * editability based on its source.
 */

import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { log } from "../logger.ts";
import {
  getArchetypeContext,
  getPsyContext,
  getPhaseContext,
  getHealthContext,
} from "../prompt-builder.ts";
import { PROJECT_ROOT, getContextDocket } from "../relay-config.ts";
import { getSkillSnapshot } from "../skills/index.ts";
import { getOrchestrationContext } from "./orchestration-context.ts";

const logger = log.child("context-sections");

const SOUL_PATH = join(PROJECT_ROOT, "config", "soul.md");
const PROFILE_PATH = join(PROJECT_ROOT, "config", "profile.md");

export interface SectionInfo {
  type: "file" | "forest" | "hardcoded" | "dynamic";
  content: string | null;
  editable: boolean;
  note?: string;
  path?: string;
}

// ── Hardcoded section text (mirrors prompt-builder.ts) ──────

const HARDCODED_SECTIONS: Record<string, string> = {
  "memory-protocol":
    "MEMORY MANAGEMENT:\n" +
    "Two memory systems exist — use the right one:\n\n" +
    "1. CONVERSATION MEMORY ([REMEMBER:] tags) — for personal facts about the user:\n" +
    "   preferences, decisions, project details, personal info, things the user asked to remember.\n" +
    "   [REMEMBER: fact to store]\n" +
    "   [GOAL: goal text | DEADLINE: optional date]\n" +
    "   [DONE: search text for completed goal]\n\n" +
    "2. FOREST MEMORY ([MEMORY:] tags) — for work products:\n" +
    "   strategic analysis, code findings, bug discoveries, architectural decisions, hypotheses.\n" +
    "   These compound across sessions and are shared with other agents.\n\n" +
    "Use [REMEMBER:] freely for user context. Use [MEMORY:] for institutional knowledge.",

  "confirm-protocol":
    "ACTION CONFIRMATIONS:\n" +
    "Use [CONFIRM: description] for these actions INSTEAD of executing:\n" +
    "- Sending or replying to emails (send_gmail_message, /api/outlook/send, /api/outlook/reply)\n" +
    "- Creating or modifying calendar events (create_event, modify_event)\n" +
    "- Git push, posting to channels, modifying databases\n" +
    "- Any difficult-to-undo external action\n" +
    "Do NOT use [CONFIRM:] for:\n" +
    "- Read-only: searching email, reading messages, checking calendar, listing tasks\n" +
    "- Google Tasks management: creating/completing/updating tasks (low-stakes, easily reversible)\n" +
    "- Actions the user explicitly and directly asked you to do in simple terms\n" +
    "The user will see Approve/Deny buttons. If approved, you will be resumed with instructions to proceed.\n" +
    'Example: "I\'ll send the report now. [CONFIRM: Send weekly report email to alice@example.com]"\n' +
    "You can include multiple [CONFIRM:] tags if multiple actions need approval.",

  "dev-protocol":
    "DEV AGENT PROTOCOL:\n" +
    "1. Read the ticket and understand requirements\n" +
    "2. Implement code changes\n" +
    "3. Commit with [ELLIE-N] prefix (e.g., [ELLIE-5] Brief description)\n" +
    "4. Build if dashboard code changed: cd /home/ellie/ellie-home && bun run build\n" +
    "5. Restart affected service: sudo systemctl restart ellie-dashboard\n" +
    "   (for relay code: systemctl --user restart claude-telegram-relay)\n" +
    "6. Verify changes work\n" +
    "Do NOT call /api/work-session/complete — handled externally.",

  "playbook-commands":
    "ELLIE:: PLAYBOOK COMMANDS:\n" +
    "You can emit these tags to trigger infrastructure actions. Tags are stripped\n" +
    "before your message reaches the user.\n\n" +
    "  ELLIE:: send ELLIE-144 to dev\n" +
    "    Dispatches the dev agent to work on a ticket. You'll be notified when done.\n" +
    "    Use when: Dave asks to implement, fix, or build something on a specific ticket.\n\n" +
    "  ELLIE:: close ELLIE-144 \"summary of what was accomplished\"\n" +
    "    Closes a ticket: updates Plane to Done, deploys if needed.\n" +
    "    Use when: Work is verified complete on a ticket.\n\n" +
    "  ELLIE:: create ticket \"Title\" \"Description of work\"\n" +
    "    Creates a new ticket in Plane. Returns the identifier.\n" +
    "    Use when: New work should be tracked.\n\n" +
    "Rules:\n" +
    "- Place tags at the END of your response, after your conversational text\n" +
    "- You can include multiple tags in one response\n" +
    "- Dev dispatch is async — you'll get a notification when done\n" +
    "- Only use these when the user's request clearly warrants it",

  "work-commands":
    "WORK ITEM COMMANDS:\n" +
    "You can manage Plane work items via MCP tools (workspace: evelife, project: ELLIE).\n" +
    "- List open issues: mcp__plane__list_states, then query issues\n" +
    "- Create new issues when asked\n" +
    "- Use [ELLIE-N] prefix in commit messages when working on a tracked item",
};

// ── Section content reader ──────────────────────────────────

export async function getSectionContents(): Promise<Record<string, SectionInfo>> {
  const sections: Record<string, SectionInfo> = {};

  // File-backed sections
  try {
    const soul = await readFile(SOUL_PATH, "utf-8");
    sections.soul = { type: "file", content: soul, editable: true, path: "config/soul.md" };
  } catch {
    sections.soul = { type: "file", content: "", editable: true, path: "config/soul.md" };
  }

  try {
    const profile = await readFile(PROFILE_PATH, "utf-8");
    sections.profile = { type: "file", content: profile, editable: true, path: "config/profile.md" };
  } catch {
    sections.profile = { type: "file", content: "", editable: true, path: "config/profile.md" };
  }

  // Forest DB sections
  const [archetype, psy, phase, health] = await Promise.all([
    getArchetypeContext().catch(() => ""),
    getPsyContext().catch(() => ""),
    getPhaseContext().catch(() => ""),
    getHealthContext().catch(() => ""),
  ]);

  sections.archetype = { type: "forest", content: archetype, editable: false, note: "Managed via Forest DB" };
  sections.psy = { type: "forest", content: psy, editable: false, note: "Managed via Forest DB" };
  sections.phase = { type: "forest", content: phase, editable: false, note: "Managed via Forest DB" };
  sections.health = { type: "forest", content: health, editable: false, note: "Managed via Forest DB" };

  // Hardcoded sections
  for (const [name, content] of Object.entries(HARDCODED_SECTIONS)) {
    sections[name] = { type: "hardcoded", content, editable: false };
  }

  // Dynamic sections
  try {
    const docket = await getContextDocket();
    sections["context-docket"] = { type: "dynamic", content: docket || null, editable: false, note: "Generated from dashboard context API" };
  } catch {
    sections["context-docket"] = { type: "dynamic", content: null, editable: false, note: "Generated from dashboard context API" };
  }

  try {
    const snapshot = await getSkillSnapshot();
    sections.skills = { type: "dynamic", content: snapshot.prompt || null, editable: false, note: `${snapshot.skills.length} skills loaded` };
  } catch {
    sections.skills = { type: "dynamic", content: null, editable: false, note: "Skills snapshot unavailable" };
  }

  sections.queue = { type: "dynamic", content: null, editable: false, note: "Agent queue — items injected per conversation" };

  try {
    const orchStatus = await getOrchestrationContext();
    sections["orchestration-status"] = { type: "dynamic", content: orchStatus || null, editable: false, note: "Active agent runs + recent completions" };
  } catch {
    sections["orchestration-status"] = { type: "dynamic", content: null, editable: false, note: "Orchestration status unavailable" };
  }

  // Per-conversation sections (can't preview without a conversation)
  sections.conversation = { type: "dynamic", content: null, editable: false, note: "Per-conversation message history" };
  sections["structured-context"] = { type: "dynamic", content: null, editable: false, note: "Per-agent structured context from DB" };
  sections["agent-memory"] = { type: "dynamic", content: null, editable: false, note: "Work session notes + creature memories" };
  sections["forest-awareness"] = { type: "dynamic", content: null, editable: false, note: "Forest bridge awareness query" };
  sections.search = { type: "dynamic", content: null, editable: false, note: "Elasticsearch results per query" };
  sections["work-item"] = { type: "dynamic", content: null, editable: false, note: "Plane work item context" };

  return sections;
}

// ── Section content writer ──────────────────────────────────

export async function updateSectionContent(name: string, content: string): Promise<{ ok: boolean; error?: string }> {
  switch (name) {
    case "soul":
      await writeFile(SOUL_PATH, content, "utf-8");
      logger.info("Updated soul.md via dashboard");
      return { ok: true };

    case "profile":
      await writeFile(PROFILE_PATH, content, "utf-8");
      logger.info("Updated profile.md via dashboard");
      return { ok: true };

    default:
      return { ok: false, error: `Section "${name}" is not editable` };
  }
}
