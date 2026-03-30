/**
 * Centralized Slash Command Registry — ELLIE-1162
 *
 * All slash commands registered in one place. Parsed, dispatched,
 * and help-generated from registry metadata. Replaces ad-hoc
 * if-else blocks scattered across handler files.
 */

import { log } from "./logger.ts";

const logger = log.child("commands");

// ── Types ──────────────────────────────────────────────────

export interface CommandContext {
  text: string;           // Full message text
  channel: string;        // ellie-chat | telegram | google-chat
  userId: string;
  sendResponse: (text: string) => Promise<void>;
  getRegistry?: () => Promise<unknown>;  // Foundation registry
}

export interface CommandDefinition {
  name: string;           // e.g., "foundation"
  description: string;    // One-line description for /skills listing
  category: "system" | "skill" | "debug";
  subcommands?: string[]; // e.g., ["list", "help", "<name>"]
  handler: (args: string, ctx: CommandContext) => Promise<CommandResult>;
}

export interface CommandResult {
  handled: boolean;
  response?: string;
}

export interface ParsedCommand {
  name: string;           // e.g., "foundation"
  args: string;           // e.g., "help" or "software-dev"
  subcommand?: string;    // First arg if it matches a known subcommand
  raw: string;            // Original text
}

// ── Registry ───────────────────────────────────────────────

const commands = new Map<string, CommandDefinition>();

const RESERVED_NAMES = new Set([
  "skills", "help", "foundation", "plan",
]);

export function registerCommand(def: CommandDefinition): void {
  if (commands.has(def.name)) {
    logger.warn("Command already registered, overwriting", { name: def.name });
  }
  commands.set(def.name, def);
}

export function getCommand(name: string): CommandDefinition | undefined {
  return commands.get(name);
}

export function getAllCommands(): CommandDefinition[] {
  return Array.from(commands.values());
}

export function isReservedCommand(name: string): boolean {
  return RESERVED_NAMES.has(name);
}

// ── Parser ─────────────────────────────────────────────────

export function parseSlashCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  const parts = trimmed.split(/\s+/);
  const name = parts[0].slice(1).toLowerCase(); // Remove "/" prefix
  const args = trimmed.slice(parts[0].length).trim();
  const subcommand = parts[1]?.toLowerCase();

  return { name, args, subcommand, raw: trimmed };
}

// ── Dispatcher ─────────────────────────────────────────────

export async function dispatchCommand(
  text: string,
  ctx: CommandContext,
): Promise<CommandResult> {
  const parsed = parseSlashCommand(text);
  if (!parsed) return { handled: false };

  const def = commands.get(parsed.name);
  if (!def) return { handled: false };

  try {
    logger.info("Command dispatched", { name: parsed.name, args: parsed.args, channel: ctx.channel });
    const result = await def.handler(parsed.args, ctx);
    return result;
  } catch (err) {
    logger.error("Command handler error", { name: parsed.name, error: String(err) });
    return {
      handled: true,
      response: `Command /${parsed.name} failed: ${(err as Error).message}`,
    };
  }
}

// ── Help Generator ─────────────────────────────────────────

export function generateSkillsList(): string {
  const all = getAllCommands().sort((a, b) => a.name.localeCompare(b.name));
  const lines = [
    "Available commands — say /<name> help for details",
    "",
    ...all.map(cmd => `  /${cmd.name} — ${cmd.description}`),
  ];
  return lines.join("\n");
}

// ── Built-in Commands ──────────────────────────────────────

// /skills — list all available commands
registerCommand({
  name: "skills",
  description: "List all available skills and commands",
  category: "system",
  handler: async (_args, ctx) => {
    // Also include instant-command skills from SKILL.md files
    let skillLines = "";
    try {
      const { getSkillCommands } = await import("./skills/commands.ts");
      const skillCommands = await getSkillCommands();
      const registeredNames = new Set(getAllCommands().map(c => c.name));
      const extraSkills = skillCommands.filter(sc => !registeredNames.has(sc.name));
      if (extraSkills.length > 0) {
        skillLines = "\n" + extraSkills.map(sc => `  /${sc.name} — ${sc.description}`).join("\n");
      }
    } catch { /* non-critical */ }

    const response = generateSkillsList() + skillLines;
    return { handled: true, response };
  },
});

// /help — alias for /skills
registerCommand({
  name: "help",
  description: "Show available commands (same as /skills)",
  category: "system",
  handler: async (args, ctx) => {
    const skillsCmd = commands.get("skills");
    if (skillsCmd) return skillsCmd.handler(args, ctx);
    return { handled: true, response: "No help available." };
  },
});

// /plan on|off — toggle planning mode
registerCommand({
  name: "plan",
  description: "Toggle planning mode — longer idle timeout for extended conversations",
  category: "system",
  subcommands: ["on", "off"],
  handler: async (args, _ctx) => {
    const { setPlanningMode, getPlanningMode } = await import("./context-mode.ts");
    const match = args.match(/^(on|off)$/i);
    if (!match) {
      const current = getPlanningMode() ? "ON" : "OFF";
      return { handled: true, response: `Planning mode is ${current}. Use /plan on or /plan off to toggle.` };
    }
    setPlanningMode(match[1].toLowerCase() === "on");
    const msg = getPlanningMode()
      ? "Planning mode ON — conversation will persist for up to 60 minutes of idle time."
      : "Planning mode OFF — reverting to 10-minute idle timeout.";
    return { handled: true, response: msg };
  },
});

// /foundation — manage foundations
registerCommand({
  name: "foundation",
  description: "Manage agent teams and foundations — list, switch, help",
  category: "system",
  subcommands: ["list", "help"],
  handler: async (args, _ctx) => {
    const { parseFoundationCommand, executeFoundationCommand } = await import("./foundation-commands.ts");
    const cmd = parseFoundationCommand(`/foundation ${args}`);

    // Get the foundation registry
    let registry = null;
    try {
      const { getRelayDeps } = await import("./relay-state.ts");
      const { supabase } = getRelayDeps();
      if (supabase) {
        const { FoundationRegistry, createSupabaseFoundationStore } = await import("./foundation-registry.ts");
        const reg = new FoundationRegistry(createSupabaseFoundationStore(supabase));
        await reg.refresh();
        registry = reg;
      }
    } catch { /* non-critical */ }

    const result = await executeFoundationCommand(cmd, registry);
    return { handled: true, response: result.output };
  },
});

// /ticket — create Plane ticket from context
registerCommand({
  name: "ticket",
  description: "Create a Plane ticket from conversation context",
  category: "skill",
  handler: async (args, ctx) => {
    // This is complex — delegates to the existing handler logic
    // For now, return a message directing to the full handler
    return { handled: false }; // Let the existing handler catch it
  },
});

// /agentmail — email commands
registerCommand({
  name: "agentmail",
  description: "Send, receive, and manage email — check inbox, send messages, reply",
  category: "skill",
  subcommands: ["help", "status", "list", "send", "reply"],
  handler: async (args, ctx) => {
    const sub = args.split(/\s+/)[0] || "";

    if (sub === "help") {
      // Delegate to instant command system
      return { handled: false };
    }

    if (sub === "status") {
      const { isAgentMailEnabled, getAgentMailConfig } = await import("./agentmail.ts");
      const enabled = isAgentMailEnabled();
      const config = enabled ? getAgentMailConfig() : null;
      const output = enabled
        ? `AgentMail is configured.\nInbox: ${config?.inboxEmail || "unknown"}`
        : "AgentMail is not configured. Missing AGENTMAIL_API_KEY, AGENTMAIL_INBOX_EMAIL, or AGENTMAIL_WEBHOOK_SECRET in .env";
      return { handled: true, response: output };
    }

    if (sub === "list") {
      const { isAgentMailEnabled, listThreads } = await import("./agentmail.ts");
      if (!isAgentMailEnabled()) {
        return { handled: true, response: "AgentMail is not configured. Run /agentmail status for details." };
      }
      const limit = parseInt(args.split(/\s+/)[1] || "10", 10);
      const result = await listThreads();
      if (!result || !result.threads || result.threads.length === 0) {
        return { handled: true, response: "No email threads found." };
      }
      const lines = result.threads.slice(0, limit).map((t: Record<string, unknown>) =>
        `- ${t.subject || "(no subject)"} — ${t.updated_at || ""}`
      );
      return { handled: true, response: `Email threads (${lines.length}):\n${lines.join("\n")}` };
    }

    // send, reply — fall through to coordinator
    return { handled: false };
  },
});
