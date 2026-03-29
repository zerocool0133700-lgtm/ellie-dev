/**
 * Foundation slash command — parse + execute.
 *
 * Extracted from ellie-chat-handler.ts for testability (ELLIE-1114).
 * All external dependencies are injectable via FoundationCommandDeps.
 */

import type { Foundation } from "./foundation-registry.ts";

// ── Types ───────────────────────────────────────────────────────

export interface ParsedFoundationCommand {
  subcommand: "list" | "switch" | "help";
  args: string;
}

export interface FoundationCommandResult {
  success: boolean;
  output: string;
}

/** Injectable subset of FoundationRegistry used by the command. */
export interface FoundationCommandDeps {
  listAll: () => Foundation[];
  getActive: () => Foundation | null;
  switchTo: (name: string) => Promise<Foundation>;
}

// ── Parse ───────────────────────────────────────────────────────

export function parseFoundationCommand(text: string): ParsedFoundationCommand {
  const parts = text.trim().split(/\s+/);
  const sub = parts[1];

  if (!sub || sub === "list") {
    return { subcommand: "list", args: "" };
  }

  if (sub === "help") {
    return { subcommand: "help", args: "" };
  }

  return { subcommand: "switch", args: sub };
}

// ── Execute ─────────────────────────────────────────────────────

export async function executeFoundationCommand(
  cmd: ParsedFoundationCommand,
  deps: FoundationCommandDeps | null,
): Promise<FoundationCommandResult> {
  if (!deps) {
    return { success: false, output: "Foundation system not available (no database connection)." };
  }

  if (cmd.subcommand === "help") {
    return {
      success: true,
      output: [
        "/foundation — Manage your active agent team",
        "",
        "Commands:",
        "  /foundation list     — Show all foundations and which is active",
        "  /foundation <name>   — Switch to a different foundation",
        "  /foundation help     — Show this help",
        "",
        "A foundation defines your agent team, their tools, coordination recipes, and behavior style.",
        "Switch foundations to change how Ellie works — from software development to life management to small business.",
      ].join("\n"),
    };
  }

  if (cmd.subcommand === "list") {
    const all = deps.listAll();
    if (all.length === 0) {
      return { success: true, output: "No foundations configured." };
    }
    const active = deps.getActive();
    const lines = all.map((f) => {
      const marker = f.name === active?.name ? "→ " : "  ";
      const count = f.agents.length;
      return `${marker}${f.name} — ${f.description} (${count} agent${count !== 1 ? "s" : ""})`;
    });
    return { success: true, output: `Foundations:\n${lines.join("\n")}` };
  }

  // switch
  try {
    const switched = await deps.switchTo(cmd.args);
    const count = switched.agents.length;
    const agentNames = switched.agents.map((a) => a.name).join(", ");
    return {
      success: true,
      output: `Switched to ${switched.name} — ${switched.description}\n${count} agent${count !== 1 ? "s" : ""}: ${agentNames}`,
    };
  } catch (err) {
    return {
      success: false,
      output: `Failed to switch: ${(err as Error).message}`,
    };
  }
}
