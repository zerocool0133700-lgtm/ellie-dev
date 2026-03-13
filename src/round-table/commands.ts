/**
 * Round Table Command Interface — ELLIE-702
 *
 * Slash commands for manually invoking and managing round table sessions.
 * Responsibilities:
 *   1. Parse `/roundtable` subcommands
 *   2. Start sessions with optional formation overrides
 *   3. Check session status and progress
 *   4. Debug controls: skip/retry phases, list formations
 *
 * All external dependencies (session manager, orchestrator) are injectable.
 */

import { log } from "../logger.ts";
import type { RoundTablePhaseType } from "../types/round-table.ts";
import { ROUND_TABLE_PHASES } from "../types/round-table.ts";
import {
  RoundTableSessionManager,
  executeRoundTableHandoff,
  type RoundTableRouterDeps,
  type ActiveRoundTableSession,
} from "./router-integration.ts";
import { FORMATION_REGISTRY } from "./convene.ts";

const logger = log.child("round-table-commands");

// ── Types ───────────────────────────────────────────────────────

/** Parsed subcommand from a /roundtable message. */
export interface ParsedCommand {
  /** The subcommand name. */
  subcommand: string;
  /** The query or arguments after the subcommand. */
  args: string;
  /** Parsed options extracted from the args. */
  options: CommandOptions;
}

/** Options that can be passed with commands. */
export interface CommandOptions {
  /** Force specific formations (--formations=boardroom,think-tank). */
  formations?: string[];
  /** Override delivery channel (--channel=dashboard). */
  channel?: string;
  /** Associate with a work item (--ticket=ELLIE-123). */
  workItemId?: string;
  /** Session ID for status/debug commands. */
  sessionId?: string;
  /** Phase for debug commands (--phase=discuss). */
  phase?: string;
}

/** Result of executing a round table command. */
export interface CommandResult {
  /** Whether the command executed successfully. */
  success: boolean;
  /** Human-readable output to display to the user. */
  output: string;
  /** Optional session ID if a session was created/referenced. */
  sessionId?: string;
}

/** Injectable dependencies for the command interface. */
export interface RoundTableCommandDeps {
  /** The round table router deps (for starting sessions). */
  routerDeps: RoundTableRouterDeps;
  /** The session manager (for tracking/status). */
  sessionManager: RoundTableSessionManager;
}

// ── Command Parsing ─────────────────────────────────────────────

/** Known subcommands. */
const SUBCOMMANDS = ["start", "status", "list", "formations", "help", "cancel"] as const;
type Subcommand = typeof SUBCOMMANDS[number];

/**
 * Parse a /roundtable command string into a structured command.
 *
 * Formats:
 *   /roundtable <query>              → start with query
 *   /roundtable start <query>        → explicit start
 *   /roundtable status [session_id]  → check status
 *   /roundtable list                 → list active sessions
 *   /roundtable formations           → list available formations
 *   /roundtable cancel [session_id]  → cancel a session
 *   /roundtable help                 → show help
 *
 * Options (anywhere in args):
 *   --formations=slug1,slug2   Force specific formations
 *   --channel=telegram         Override delivery channel
 *   --ticket=ELLIE-123         Associate with work item
 */
export function parseCommand(input: string): ParsedCommand {
  // Strip the /roundtable or /rt prefix
  let body = input
    .replace(/^\/(roundtable|round-table|rt)\s*/i, "")
    .trim();

  // Extract options from the body
  const options: CommandOptions = {};
  body = extractOptions(body, options);

  // Determine subcommand
  const firstWord = body.split(/\s+/)[0]?.toLowerCase() ?? "";

  if (SUBCOMMANDS.includes(firstWord as Subcommand)) {
    const args = body.slice(firstWord.length).trim();

    // For status/cancel, first arg might be a session ID
    if ((firstWord === "status" || firstWord === "cancel") && args && !args.startsWith("-")) {
      options.sessionId = args.split(/\s+/)[0];
    }

    return { subcommand: firstWord, args, options };
  }

  // No recognized subcommand — treat the whole body as a query for "start"
  if (body.length > 0) {
    return { subcommand: "start", args: body, options };
  }

  // Empty — show help
  return { subcommand: "help", args: "", options };
}

/**
 * Extract --option=value flags from the args string.
 * Returns the args string with options removed.
 */
function extractOptions(args: string, options: CommandOptions): string {
  let cleaned = args;

  // --formations=slug1,slug2
  const formationsMatch = cleaned.match(/--formations?=([^\s]+)/i);
  if (formationsMatch) {
    options.formations = formationsMatch[1].split(",").map(s => s.trim()).filter(Boolean);
    cleaned = cleaned.replace(formationsMatch[0], "").trim();
  }

  // --channel=name
  const channelMatch = cleaned.match(/--channel=([^\s]+)/i);
  if (channelMatch) {
    options.channel = channelMatch[1];
    cleaned = cleaned.replace(channelMatch[0], "").trim();
  }

  // --ticket=ELLIE-123
  const ticketMatch = cleaned.match(/--ticket=([^\s]+)/i);
  if (ticketMatch) {
    options.workItemId = ticketMatch[1];
    cleaned = cleaned.replace(ticketMatch[0], "").trim();
  }

  // --phase=discuss
  const phaseMatch = cleaned.match(/--phase=([^\s]+)/i);
  if (phaseMatch) {
    options.phase = phaseMatch[1];
    cleaned = cleaned.replace(phaseMatch[0], "").trim();
  }

  // Collapse any double spaces left by mid-string option removal
  cleaned = cleaned.replace(/\s{2,}/g, " ").trim();

  return cleaned;
}

// ── Command Execution ───────────────────────────────────────────

/**
 * Execute a parsed round table command.
 */
export async function executeCommand(
  deps: RoundTableCommandDeps,
  command: ParsedCommand,
  context?: { channel?: string; workItemId?: string },
): Promise<CommandResult> {
  const effectiveChannel = command.options.channel ?? context?.channel ?? "telegram";
  const effectiveWorkItem = command.options.workItemId ?? context?.workItemId;

  switch (command.subcommand) {
    case "start":
      return executeStart(deps, command.args, effectiveChannel, effectiveWorkItem, command.options.formations);
    case "status":
      return executeStatus(deps.sessionManager, command.options.sessionId, effectiveChannel);
    case "list":
      return executeList(deps.sessionManager);
    case "formations":
      return executeFormations();
    case "cancel":
      return executeCancel(deps.sessionManager, command.options.sessionId, effectiveChannel);
    case "help":
      return executeHelp();
    default:
      return { success: false, output: `Unknown subcommand: "${command.subcommand}". Use /roundtable help for usage.` };
  }
}

/**
 * Start a new round table session.
 */
async function executeStart(
  deps: RoundTableCommandDeps,
  query: string,
  channel: string,
  workItemId?: string,
  formations?: string[],
): Promise<CommandResult> {
  if (!query) {
    return {
      success: false,
      output: "Please provide a query for the round table.\n\nUsage: `/roundtable <your question>`",
    };
  }

  logger.info("Starting round table via command", { query: query.slice(0, 100), channel });

  // Validate formation overrides if provided
  if (formations && formations.length > 0) {
    const validSlugs = FORMATION_REGISTRY.map(f => f.slug);
    const invalid = formations.filter(f => !validSlugs.includes(f));
    if (invalid.length > 0) {
      return {
        success: false,
        output: `Unknown formation(s): ${invalid.join(", ")}\n\nAvailable: ${validSlugs.join(", ")}`,
      };
    }
  }

  const result = await executeRoundTableHandoff(
    deps.routerDeps,
    deps.sessionManager,
    query,
    { channel, workItemId, initiatorAgent: "general" },
  );

  if (!result.accepted) {
    return {
      success: false,
      output: result.error ?? "Round table session could not be started.",
      sessionId: result.sessionId,
    };
  }

  if (result.output) {
    return {
      success: true,
      output: result.output,
      sessionId: result.sessionId,
    };
  }

  return {
    success: false,
    output: `Round table session ${result.sessionId} failed: ${result.error ?? "unknown error"}`,
    sessionId: result.sessionId,
  };
}

/**
 * Check status of a round table session.
 */
function executeStatus(
  manager: RoundTableSessionManager,
  sessionId?: string,
  channel?: string,
): CommandResult {
  let session: ActiveRoundTableSession | null = null;

  if (sessionId) {
    session = manager.getSession(sessionId);
  } else if (channel) {
    session = manager.getActiveSessionForChannel(channel);
  }

  if (!session) {
    const hint = sessionId
      ? `Session "${sessionId}" not found.`
      : "No active round table session on this channel.";
    return { success: false, output: hint };
  }

  const lines: string[] = [];
  lines.push(`**Round Table Session** \`${session.sessionId}\``);
  lines.push(`**Status:** ${session.status}`);
  lines.push(`**Query:** ${session.query.slice(0, 200)}`);
  lines.push(`**Channel:** ${session.channel}`);
  if (session.workItemId) {
    lines.push(`**Work Item:** ${session.workItemId}`);
  }
  lines.push(`**Started:** ${session.startedAt.toISOString()}`);

  if (session.status === "completed" && session.output) {
    lines.push("");
    lines.push("**Output:**");
    lines.push(session.output.slice(0, 500));
    if (session.output.length > 500) {
      lines.push("_(truncated)_");
    }
  }

  if (session.status === "failed" && session.output) {
    lines.push("");
    lines.push(`**Error:** ${session.output}`);
  }

  return {
    success: true,
    output: lines.join("\n"),
    sessionId: session.sessionId,
  };
}

/**
 * List all active round table sessions.
 */
function executeList(manager: RoundTableSessionManager): CommandResult {
  const active = manager.getActiveSessions();

  if (active.length === 0) {
    return { success: true, output: "No active round table sessions." };
  }

  const lines: string[] = [];
  lines.push(`**Active Round Table Sessions** (${active.length})`);
  lines.push("");

  for (const session of active) {
    const age = Math.round((Date.now() - session.startedAt.getTime()) / 1000);
    lines.push(`- \`${session.sessionId}\` — ${session.query.slice(0, 80)} (${session.channel}, ${age}s)`);
  }

  return { success: true, output: lines.join("\n") };
}

/**
 * List available formations.
 */
function executeFormations(): CommandResult {
  const lines: string[] = [];
  lines.push("**Available Formations**");
  lines.push("");

  for (const f of FORMATION_REGISTRY) {
    lines.push(`- **${f.slug}** — ${f.description}`);
    if (f.triggers.length > 0) {
      lines.push(`  Triggers: ${f.triggers.slice(0, 5).join(", ")}`);
    }
  }

  lines.push("");
  lines.push("Use `--formations=slug1,slug2` to override formation selection.");

  return { success: true, output: lines.join("\n") };
}

/**
 * Cancel an active round table session.
 */
function executeCancel(
  manager: RoundTableSessionManager,
  sessionId?: string,
  channel?: string,
): CommandResult {
  let session: ActiveRoundTableSession | null = null;

  if (sessionId) {
    session = manager.getSession(sessionId);
  } else if (channel) {
    session = manager.getActiveSessionForChannel(channel);
  }

  if (!session) {
    return {
      success: false,
      output: sessionId
        ? `Session "${sessionId}" not found.`
        : "No active round table session to cancel.",
    };
  }

  if (session.status !== "active") {
    return {
      success: false,
      output: `Session "${session.sessionId}" is already ${session.status}.`,
    };
  }

  manager.failSession(session.sessionId, "Cancelled by user");

  return {
    success: true,
    output: `Round table session \`${session.sessionId}\` cancelled.`,
    sessionId: session.sessionId,
  };
}

/**
 * Show help text.
 */
function executeHelp(): CommandResult {
  const help = `**Round Table Commands**

\`/roundtable <query>\` — Start a round table discussion
\`/roundtable start <query>\` — Same as above (explicit)
\`/roundtable status [session_id]\` — Check session progress
\`/roundtable list\` — List active sessions
\`/roundtable formations\` — List available formations
\`/roundtable cancel [session_id]\` — Cancel an active session
\`/roundtable help\` — Show this help

**Options** (add anywhere in command):
\`--formations=slug1,slug2\` — Force specific formations
\`--channel=telegram\` — Override delivery channel
\`--ticket=ELLIE-123\` — Associate with a work item

**Examples:**
\`/roundtable What should our Q2 strategy be?\`
\`/rt start Should we hire or contract? --formations=boardroom,billing-ops\`
\`/roundtable status\``;

  return { success: true, output: help };
}

// ── Convenience Entry Point ─────────────────────────────────────

/**
 * Full pipeline: parse a /roundtable message and execute it.
 * This is the main entry point called by the relay.
 */
export async function handleRoundTableCommand(
  deps: RoundTableCommandDeps,
  message: string,
  context?: { channel?: string; workItemId?: string },
): Promise<CommandResult> {
  const command = parseCommand(message);
  logger.info("Round table command parsed", {
    subcommand: command.subcommand,
    hasArgs: command.args.length > 0,
  });
  return executeCommand(deps, command, context);
}

// ── Testing Helpers ─────────────────────────────────────────────

/**
 * Create mock command deps for testing.
 */
export function _makeMockCommandDeps(
  rtResult?: { sessionId: string; output: string; success: boolean; error?: string },
): RoundTableCommandDeps {
  return {
    routerDeps: {
      runRoundTable: async () =>
        rtResult ?? {
          sessionId: "rt-cmd-1",
          output: "Round table result: balanced expansion recommended.",
          success: true,
        },
    },
    sessionManager: new RoundTableSessionManager({ maxConcurrentSessions: 3 }),
  };
}
