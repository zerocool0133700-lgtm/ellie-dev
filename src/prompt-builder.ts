/**
 * Prompt Builder + Personality Context
 *
 * Extracted from relay.ts — ELLIE-184.
 * Contains: buildPrompt, personality context loaders (archetype/psy/phase/health),
 * runPostMessageAssessment, planning mode state.
 */

import { readFile } from "fs/promises";
import { watch, type FSWatcher } from "fs";
import { log } from "./logger.ts";

const logger = log.child("prompt-builder");
import { join, dirname } from "path";
import type Anthropic from "@anthropic-ai/sdk";
import { isOutlookConfigured, getOutlookEmail } from "./outlook.ts";
import { isPlaneConfigured } from "./plane.ts";
import {
  trimSearchContext,
  applyTokenBudget,
  mapHealthToMemoryCategory,
  type PromptSection,
} from "./relay-utils.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

// ── Planning mode state ─────────────────────────────────────

let planningMode = false;
export function getPlanningMode(): boolean { return planningMode; }
export function setPlanningMode(v: boolean): void { planningMode = v; }

// ── Agent mode config ───────────────────────────────────────

const AGENT_MODE = process.env.AGENT_MODE !== "false";

// ── User identity ───────────────────────────────────────────

export const USER_NAME = process.env.USER_NAME || "";
export const USER_TIMEZONE = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

// ── Soul context (hot-reloaded on file change — ELLIE-244) ──

const SOUL_PATH = join(PROJECT_ROOT, "soul.md");
const PROFILE_PATH = join(PROJECT_ROOT, "config", "profile.md");

let soulContext = "";
try {
  soulContext = await readFile(SOUL_PATH, "utf-8");
} catch {
  // No soul file yet — that's fine
}

// ── Profile context (hot-reloaded on file change — ELLIE-244) ──

let profileContext = "";
try {
  profileContext = await readFile(PROFILE_PATH, "utf-8");
} catch {
  // No profile yet — that's fine
}

// ── File watchers for personality files (ELLIE-244) ─────────

const RELOAD_DEBOUNCE_MS = 500;
let soulReloadTimer: ReturnType<typeof setTimeout> | null = null;
let profileReloadTimer: ReturnType<typeof setTimeout> | null = null;
const personalityWatchers: FSWatcher[] = [];

function watchPersonalityFiles(): void {
  // Watch soul.md
  try {
    const w = watch(SOUL_PATH, (_event) => {
      if (soulReloadTimer) clearTimeout(soulReloadTimer);
      soulReloadTimer = setTimeout(async () => {
        try {
          soulContext = await readFile(SOUL_PATH, "utf-8");
          logger.info("Reloaded soul.md");
        } catch {
          soulContext = "";
          logger.info("soul.md removed or unreadable — cleared");
        }
        soulReloadTimer = null;
      }, RELOAD_DEBOUNCE_MS);
    });
    personalityWatchers.push(w);
  } catch {
    // File doesn't exist yet — that's fine
  }

  // Watch profile.md
  try {
    const w = watch(PROFILE_PATH, (_event) => {
      if (profileReloadTimer) clearTimeout(profileReloadTimer);
      profileReloadTimer = setTimeout(async () => {
        try {
          profileContext = await readFile(PROFILE_PATH, "utf-8");
          logger.info("Reloaded config/profile.md");
        } catch {
          profileContext = "";
          logger.info("config/profile.md removed or unreadable — cleared");
        }
        profileReloadTimer = null;
      }, RELOAD_DEBOUNCE_MS);
    });
    personalityWatchers.push(w);
  } catch {
    // File doesn't exist yet — that's fine
  }

  if (personalityWatchers.length > 0) {
    console.log(`[prompt-builder] Watching ${personalityWatchers.length} personality files for changes`);
  }
}

/** Stop personality file watchers. Call on shutdown. */
export function stopPersonalityWatchers(): void {
  for (const w of personalityWatchers) w.close();
  personalityWatchers.length = 0;
}

/** Force-clear all personality caches (soul, profile, archetype, psy, phase, health). */
export function clearPersonalityCache(): void {
  _archetypeLastLoaded = 0;
  _psyLastLoaded = 0;
  _phaseLastLoaded = 0;
  _healthLastLoaded = 0;
  logger.info("All personality caches invalidated");
}

// Start watchers immediately
watchPersonalityFiles();

// ── Personality context loaders (60s TTL each) ──────────────

let _archetypeContext = "";
let _archetypeLastLoaded = 0;
const ARCHETYPE_CACHE_MS = 60_000;

export async function getArchetypeContext(): Promise<string> {
  const now = Date.now();
  if (_archetypeContext && now - _archetypeLastLoaded < ARCHETYPE_CACHE_MS) return _archetypeContext;
  try {
    const { getChainOwnerArchetype } = await import('../../ellie-forest/src/people');
    const { buildArchetypePrompt } = await import('../../ellie-forest/src/archetypes');
    const prefs = await getChainOwnerArchetype();
    _archetypeContext = buildArchetypePrompt(prefs.archetype as any, prefs.flavor as any);
    _archetypeLastLoaded = now;
  } catch {
    // No archetype set yet — soul alone is enough
  }
  return _archetypeContext;
}

let _psyContext = "";
let _psyLastLoaded = 0;
const PSY_CACHE_MS = 60_000;

export async function getPsyContext(): Promise<string> {
  const now = Date.now();
  if (_psyContext && now - _psyLastLoaded < PSY_CACHE_MS) return _psyContext;
  try {
    const { getChainOwnerPsy } = await import('../../ellie-forest/src/people');
    const { buildPsyPrompt } = await import('../../ellie-forest/src/psy');
    const psy = await getChainOwnerPsy();
    _psyContext = buildPsyPrompt(psy);
    _psyLastLoaded = now;
  } catch {
    // No psy profile yet — archetype alone is enough
  }
  return _psyContext;
}

let _phaseContext = "";
let _phaseLastLoaded = 0;
const PHASE_CACHE_MS = 60_000;

export async function getPhaseContext(): Promise<string> {
  const now = Date.now();
  if (_phaseContext && now - _phaseLastLoaded < PHASE_CACHE_MS) return _phaseContext;
  try {
    const { getChainOwnerPhase } = await import('../../ellie-forest/src/people');
    const { buildPhasePrompt } = await import('../../ellie-forest/src/phases');
    const phase = await getChainOwnerPhase();
    _phaseContext = buildPhasePrompt(phase);
    _phaseLastLoaded = now;
  } catch {
    // No phase data yet — psy alone is enough
  }
  return _phaseContext;
}

let _healthContext = "";
let _healthLastLoaded = 0;
const HEALTH_CACHE_MS = 60_000;

export async function getHealthContext(): Promise<string> {
  const now = Date.now();
  if (_healthContext && now - _healthLastLoaded < HEALTH_CACHE_MS) return _healthContext;
  try {
    const { getChainOwnerHealth } = await import('../../ellie-forest/src/people');
    const { buildHealthPrompt } = await import('../../ellie-forest/src/health');
    const health = await getChainOwnerHealth();
    _healthContext = buildHealthPrompt(health);
    _healthLastLoaded = now;
  } catch {
    // No health profile yet — other context is enough
  }
  return _healthContext;
}

// ── Post-message psy assessment (ELLIE-164) ─────────────────

export async function runPostMessageAssessment(
  userMessage: string,
  assistantResponse: string,
  anthropic: Anthropic | null,
): Promise<void> {
  const start = Date.now();
  try {
    const { getChainOwnerPsy, updateChainOwnerPsy,
            getChainOwnerPhase, updateChainOwnerPhase,
            getChainOwnerHealth, updateChainOwnerHealth } = await import('../../ellie-forest/src/people');
    const { buildAssessmentPrompt, parseAssessmentResult,
            applyAssessment } = await import('../../ellie-forest/src/assessment');

    const [psy, phase, health] = await Promise.all([
      getChainOwnerPsy(),
      getChainOwnerPhase(),
      getChainOwnerHealth(),
    ]);

    // ── Rule-based assessment ────────────────────────────────
    const now = new Date().toISOString();
    const lastInteraction = phase.last_interaction_at;
    const gapMs = lastInteraction
      ? Date.now() - new Date(lastInteraction).getTime()
      : Infinity;
    const FOUR_HOURS = 4 * 60 * 60 * 1000;
    const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;

    const ruleResult = {
      message_count_increment: 2,
      is_new_conversation: gapMs > FOUR_HOURS,
      is_return_after_absence: gapMs > THREE_DAYS,
      is_initiated_contact: gapMs > FOUR_HOURS,
      timestamp: now,
    };

    // ── Claude haiku assessment ──────────────────────────────
    let claudeResult = null;
    if (anthropic) {
      try {
        const prompt = buildAssessmentPrompt(userMessage, assistantResponse);
        const response = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 800,
          messages: [{ role: "user", content: prompt }],
        });
        const text = response.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
        claudeResult = parseAssessmentResult(text);
        if (!claudeResult) {
          logger.warn("Failed to parse haiku response", { response: text.substring(0, 200) });
        }
      } catch (err: any) {
        logger.error("Haiku call failed", err);
      }
    }

    // ── Apply + persist ──────────────────────────────────────
    const { psy: newPsy, phase: newPhase, health: newHealth } = applyAssessment(psy, phase, health, claudeResult, ruleResult);

    await Promise.all([
      updateChainOwnerPsy(newPsy),
      updateChainOwnerPhase(newPhase),
      updateChainOwnerHealth(newHealth),
    ]);

    // Invalidate cached contexts — next message picks up new profiles
    _psyLastLoaded = 0;
    _phaseLastLoaded = 0;
    _healthLastLoaded = 0;

    // Write health observations to shared_memories for searchability
    if (claudeResult?.health?.length) {
      try {
        const { writeMemory } = await import('../../ellie-forest/src/shared-memory');
        for (const signal of claudeResult.health) {
          await writeMemory({
            content: `[health:${signal.category}] ${signal.summary}`,
            type: 'fact',
            scope: 'global',
            confidence: 0.6,
            tags: ['health', signal.category],
            metadata: { source: 'health_assessment', is_goal: signal.is_goal },
            cognitive_type: 'factual',
            category: mapHealthToMemoryCategory(signal.category),
          });
        }
      } catch (memErr: any) {
        logger.warn("Health memory write failed", memErr);
      }
    }

    // Write classified memories from perception layer
    if (claudeResult?.memories?.length) {
      try {
        const { writeMemory } = await import('../../ellie-forest/src/shared-memory');
        for (const mem of claudeResult.memories) {
          await writeMemory({
            content: mem.content,
            type: mem.cognitive_type === 'factual' ? 'fact' : 'finding',
            scope: 'global',
            confidence: mem.importance,
            tags: ['perception', mem.cognitive_type, mem.category],
            metadata: { source: 'perception_layer' },
            cognitive_type: mem.cognitive_type as any,
            category: mem.category as any,
            emotional_valence: mem.emotional_valence ?? undefined,
            emotional_intensity: mem.emotional_intensity ?? undefined,
            duration: mem.duration as any,
          });
        }
      } catch (memErr: any) {
        logger.warn("Memory perception write failed", memErr);
      }
    }

    if (newPhase.phase !== phase.phase) {
      console.log(`[assessment] Phase transition: ${phase.phase_name} -> ${newPhase.phase_name}`);
    }

    console.log(`[assessment] Completed in ${Date.now() - start}ms` +
      (claudeResult ? ` (mbti:${claudeResult.mbti.length} enn:${claudeResult.enneagram.length} health:${claudeResult.health.length} mem:${claudeResult.memories.length})` : " (rules only)"));
  } catch (err: any) {
    logger.error("Assessment failed", err);
  }
}

// ── buildPrompt ─────────────────────────────────────────────

export function buildPrompt(
  userMessage: string,
  contextDocket?: string,
  relevantContext?: string,
  elasticContext?: string,
  channel: string = "telegram",
  agentConfig?: { system_prompt?: string | null; name?: string; tools_enabled?: string[] },
  workItemContext?: string,
  structuredContext?: string,
  recentMessages?: string,
  skillContext?: { name: string; description: string },
  forestContext?: string,
  agentMemoryContext?: string,
  sessionIds?: { tree_id: string; branch_id?: string; creature_id?: string; entity_id?: string; work_item_id?: string },
  archetypeContext?: string,
  psyContext?: string,
  phaseContext?: string,
  healthContext?: string,
  queueContext?: string,
  incidentContext?: string,
  awarenessContext?: string,
  skillsPrompt?: string,
): string {
  const channelLabel = channel === "google-chat" ? "Google Chat" : channel === "ellie-chat" ? "Ellie Chat (dashboard)" : "Telegram";

  // ── Assemble prompt as prioritized sections (ELLIE-185) ──
  // Priority: 1 = never trim, 2 = essential, 3 = important, 4-6 = context, 7-9 = trim first
  const sections: PromptSection[] = [];

  // Priority 1: User message (never trimmed)
  sections.push({ label: "user-message", content: `\nUser: ${userMessage}`, priority: 1 });

  // Priority 2: Soul + personality (small, defines who Ellie is)
  if (soulContext) sections.push({ label: "soul", content: `# Ellie Soul\n${soulContext}\n---\n`, priority: 2 });
  if (archetypeContext) sections.push({ label: "archetype", content: `# Behavioral Archetype\n${archetypeContext}\n---\n`, priority: 2 });
  if (psyContext) sections.push({ label: "psy", content: `# Psychological Profile\n${psyContext}\n---\n`, priority: 2 });
  if (phaseContext) sections.push({ label: "phase", content: `# Relationship Phase\n${phaseContext}\n---\n`, priority: 2 });
  if (healthContext) sections.push({ label: "health", content: `# Health & Life Context\n${healthContext}\n---\n`, priority: 3 });

  // Priority 2: Base system prompt
  const basePrompt = agentConfig?.system_prompt
    ? `${agentConfig.system_prompt}\nYou are responding via ${channelLabel}. Keep responses concise and conversational.`
    : `You are a personal AI assistant responding via ${channelLabel}. Keep responses concise and conversational.`;
  sections.push({ label: "base-prompt", content: basePrompt, priority: 2 });

  // Priority 2: Skill context
  if (skillContext) {
    sections.push({ label: "skill", content:
      `\nACTIVE SKILL: ${skillContext.name}` +
      `\nTask: ${skillContext.description}` +
      `\nFocus your response on this specific capability. Use the appropriate tools to fulfill this request.`,
    priority: 2 });
  }

  // Priority 2: Tool capabilities
  if (AGENT_MODE) {
    const toolHeader = agentConfig?.tools_enabled?.length
      ? `You have access to these tools: ${agentConfig.tools_enabled.join(", ")}.`
      : "You have full tool access: Read, Edit, Write, Bash, Glob, Grep, WebSearch, WebFetch.";

    const mcpDetails =
      "You also have MCP tools:\n" +
      "- Google Workspace (user_google_email: zerocool0133700@gmail.com):\n" +
      "  Gmail: search_gmail_messages, get_gmail_message_content, send_gmail_message (send requires [CONFIRM])\n" +
      "  Calendar: get_events, create_event (create/modify requires [CONFIRM])\n" +
      "  Tasks: list_tasks, create_task, update_task, get_task\n" +
      "  Also: Drive, Docs, Sheets, Forms, Contacts\n" +
      "  Your system context already includes an unread email signal and pending Google Tasks.\n" +
      "  Use Gmail MCP tools to read full email content, reply to threads, or draft messages.\n" +
      "- GitHub, Memory, Sequential Thinking\n" +
      "- Plane (project management — workspace: evelife at plane.ellie-labs.dev)\n" +
      "- Brave Search (mcp__brave-search__brave_web_search, mcp__brave-search__brave_local_search)\n" +
      "- Miro (diagrams, docs, tables), Excalidraw (drawings, diagrams)\n" +
      "- Forest Bridge (mcp__forest-bridge__forest_read, forest_write, forest_list, forest_scopes):\n" +
      "  Your persistent knowledge graph. Use forest_read to search past decisions/findings/facts.\n" +
      "  Use forest_write to record important discoveries, decisions, or facts that should persist.\n" +
      "  Scopes: 2/1=ellie-dev, 2/2=ellie-forest, 2/3=ellie-home, 2/4=ellie-os-app\n" +
      (isOutlookConfigured()
        ? "- Microsoft Outlook (" + getOutlookEmail() + "):\n" +
          "  Available via HTTP API (use curl from Bash):\n" +
          "  - GET http://localhost:3001/api/outlook/unread — list unread messages\n" +
          "  - GET http://localhost:3001/api/outlook/search?q=QUERY — search messages\n" +
          "  - GET http://localhost:3001/api/outlook/message/MESSAGE_ID — get full message\n" +
          "  - POST http://localhost:3001/api/outlook/send -d '{\"subject\":\"...\",\"body\":\"...\",\"to\":[\"...\"]}' (requires [CONFIRM])\n" +
          "  - POST http://localhost:3001/api/outlook/reply -d '{\"messageId\":\"...\",\"comment\":\"...\"}' (requires [CONFIRM])\n" +
          "  Your system context already includes an Outlook unread email signal.\n"
        : "");

    sections.push({ label: "tools", content:
      toolHeader + " " + mcpDetails +
      "Use them freely to answer questions — read files, run commands, search code, browse the web, check email, manage calendar. " +
      "IMPORTANT: NEVER run sudo commands, NEVER install packages (apt, npm -g, brew), NEVER run commands that require interactive input or confirmation. " +
      "If a task would require sudo or installing software, tell the user what to run instead. " +
      "The user is reading on a phone. After using tools, give a concise final answer (not the raw tool output). " +
      "If a task requires multiple steps, just do them — don't ask for permission.",
    priority: 2 });
  }

  // Priority 2: Identity + time
  if (USER_NAME) sections.push({ label: "user-name", content: `You are speaking with ${USER_NAME}.`, priority: 2 });
  const now = new Date().toLocaleString("en-US", { timeZone: USER_TIMEZONE, dateStyle: "full", timeStyle: "short" });
  sections.push({ label: "time", content: `Current date/time: ${now} (${USER_TIMEZONE}).`, priority: 2 });

  // Priority 3: Protocols (static text, important but can be trimmed in extreme cases)
  sections.push({ label: "memory-protocol", content:
    "\nMEMORY MANAGEMENT:" +
      "\nTwo memory systems exist — use the right one:" +
      "\n" +
      "\n1. CONVERSATION MEMORY ([REMEMBER:] tags) — for personal facts about the user:" +
      "\n   preferences, decisions, project details, personal info, things the user asked to remember." +
      "\n   [REMEMBER: fact to store]" +
      "\n   [GOAL: goal text | DEADLINE: optional date]" +
      "\n   [DONE: search text for completed goal]" +
      "\n" +
      "\n2. FOREST MEMORY ([MEMORY:] tags) — for work products:" +
      "\n   strategic analysis, code findings, bug discoveries, architectural decisions, hypotheses." +
      "\n   These compound across sessions and are shared with other agents." +
      (sessionIds ? "" : "\n   (No active work session — forest writes unavailable.)") +
      "\n" +
      "\nUse [REMEMBER:] freely for user context. Use [MEMORY:] for institutional knowledge.",
  priority: 3 });

  sections.push({ label: "confirm-protocol", content:
    "\nACTION CONFIRMATIONS:" +
      "\nUse [CONFIRM: description] for these actions INSTEAD of executing:" +
      "\n- Sending or replying to emails (send_gmail_message, /api/outlook/send, /api/outlook/reply)" +
      "\n- Creating or modifying calendar events (create_event, modify_event)" +
      "\n- Git push, posting to channels, modifying databases" +
      "\n- Any difficult-to-undo external action" +
      "\nDo NOT use [CONFIRM:] for:" +
      "\n- Read-only: searching email, reading messages, checking calendar, listing tasks" +
      "\n- Google Tasks management: creating/completing/updating tasks (low-stakes, easily reversible)" +
      "\n- Actions the user explicitly and directly asked you to do in simple terms" +
      "\nThe user will see Approve/Deny buttons. If approved, you will be resumed with instructions to proceed." +
      '\nExample: "I\'ll send the report now. [CONFIRM: Send weekly report email to alice@example.com]"' +
      "\nYou can include multiple [CONFIRM:] tags if multiple actions need approval.",
  priority: 3 });

  if (sessionIds) {
    sections.push({ label: "forest-memory-writes", content:
      "\nFOREST MEMORY WRITES (IMPORTANT):" +
      "\nYou are working in an active forest session. Record your findings with [MEMORY:] tags." +
      "\nInclude at least one [MEMORY:] tag when you:" +
      "\n  - Discover a fact, bug, or root cause" +
      "\n  - Make an architectural or implementation decision" +
      "\n  - Form a hypothesis about what's happening" +
      "\n  - Complete a task or milestone" +
      "\n" +
      "\nExamples:" +
      "\n  [MEMORY: The login endpoint returns 401 when the token is expired]" +
      "\n  [MEMORY:decision: Using Redis for caching because latency requirements are <10ms]" +
      "\n  [MEMORY:hypothesis:0.6: The race condition is in the session cleanup goroutine]" +
      "\n" +
      "\nFormat: [MEMORY:type:confidence: content] — type and confidence optional." +
      "\nTypes: finding, decision, hypothesis, fact, pattern. Default: finding" +
      "\nConfidence: 0.6 (speculative) → 0.9 (verified). Default: 0.7" +
      "\nThese memories compound — future agents see your findings and build on them." +
      "\nAlways include [MEMORY:] tags in your response text, never omit them.",
    priority: 3 });
  }

  // Priority 3: Full conversation thread (ELLIE-202 — primary context source, ground truth)
  if (recentMessages) sections.push({ label: "conversation", content: `\n${recentMessages}`, priority: 3 });

  // Priority 3: Active incidents — always visible when something is on fire
  if (incidentContext) sections.push({ label: "incidents", content: `\n${incidentContext}`, priority: 3 });

  // Priority 4: Skills prompt block (ELLIE-217 — eligible skills from SKILL.md files)
  if (skillsPrompt) sections.push({ label: "skills", content: `\n${skillsPrompt}`, priority: 4 });

  // Priority 4: Queue items for this agent (ELLIE-201 — injected on new session)
  if (queueContext) sections.push({ label: "queue", content: `\n${queueContext}`, priority: 4 });

  // Priority 5: Variable context sources (can grow large)
  if (profileContext) sections.push({ label: "profile", content: `\nProfile:\n${profileContext}`, priority: 5 });
  if (structuredContext) sections.push({ label: "structured-context", content: `\n${structuredContext}`, priority: 5 });
  if (contextDocket) sections.push({ label: "context-docket", content: `\nCONTEXT:\n${contextDocket}`, priority: 6 });
  if (agentMemoryContext) sections.push({ label: "agent-memory", content: agentMemoryContext, priority: 5 });
  if (awarenessContext) sections.push({ label: "forest-awareness", content: `\n${awarenessContext}`, priority: 5 });

  // Priority 7: Search results (already trimmed by trimSearchContext, lowest variable priority)
  const searchBlock = trimSearchContext([relevantContext || '', elasticContext || '', forestContext || '']);
  if (searchBlock) sections.push({ label: "search", content: `\n${searchBlock}`, priority: 7 });

  // Priority 3: Work item + dispatch protocols
  if (workItemContext) sections.push({ label: "work-item", content: workItemContext, priority: 3 });

  const isGeneralAgent = !agentConfig?.name || agentConfig.name === "general";

  if (workItemContext?.includes("ACTIVE WORK ITEM") && !isGeneralAgent) {
    sections.push({ label: "dev-protocol", content:
      "\nDEV AGENT PROTOCOL:" +
        "\n1. Read the ticket and understand requirements" +
        "\n2. Implement code changes" +
        "\n3. Commit with [ELLIE-N] prefix (e.g., [ELLIE-5] Brief description)" +
        "\n4. Build if dashboard code changed: cd /home/ellie/ellie-home && bun run build" +
        "\n5. Restart affected service: sudo systemctl restart ellie-dashboard" +
        "\n   (for relay code: systemctl --user restart claude-telegram-relay)" +
        "\n6. Verify changes work" +
        "\nDo NOT call /api/work-session/complete — handled externally.",
    priority: 3 });
  }

  if (isPlaneConfigured()) {
    if (isGeneralAgent) {
      sections.push({ label: "playbook-commands", content:
        "\nELLIE:: PLAYBOOK COMMANDS:" +
          "\nYou can emit these tags to trigger infrastructure actions. Tags are stripped" +
          "\nbefore your message reaches the user." +
          "\n" +
          "\n  ELLIE:: send ELLIE-144 to dev" +
          "\n    Dispatches the dev agent to work on a ticket. You'll be notified when done." +
          "\n    Use when: Dave asks to implement, fix, or build something on a specific ticket." +
          "\n" +
          "\n  ELLIE:: close ELLIE-144 \"summary of what was accomplished\"" +
          "\n    Closes a ticket: updates Plane to Done, deploys if needed." +
          "\n    Use when: Work is verified complete on a ticket." +
          "\n" +
          "\n  ELLIE:: create ticket \"Title\" \"Description of work\"" +
          "\n    Creates a new ticket in Plane. Returns the identifier." +
          "\n    Use when: New work should be tracked." +
          "\n" +
          "\nRules:" +
          "\n- Place tags at the END of your response, after your conversational text" +
          "\n- You can include multiple tags in one response" +
          "\n- Dev dispatch is async — you'll get a notification when done" +
          "\n- Only use these when the user's request clearly warrants it",
      priority: 3 });
    }
    sections.push({ label: "work-commands", content:
      "\nWORK ITEM COMMANDS:" +
        "\nYou can manage Plane work items via MCP tools (workspace: evelife, project: ELLIE)." +
        "\n- List open issues: mcp__plane__list_states, then query issues" +
        "\n- Create new issues when asked" +
        "\n- Use [ELLIE-N] prefix in commit messages when working on a tracked item",
    priority: 3 });
  }

  // Planning mode context
  if (planningMode) {
    sections.push({ label: "planning-mode", content:
      "\nPLANNING MODE ACTIVE:" +
      "\nYou are in an extended planning session. The user is working through requirements," +
      "\narchitecture, or design decisions. Maintain continuity and context across messages." +
      "\nDo not suggest ending the session — the user will deactivate planning mode when done.",
    priority: 3 });
  }

  // ── Apply token budget (ELLIE-185) ──
  return applyTokenBudget(sections);
}
