/**
 * Skill Commands — ELLIE-217
 *
 * Extracts user-invocable slash commands from eligible skills.
 * Supports instant commands that bypass the Claude pipeline entirely.
 */

import { getSkillSnapshot } from "./snapshot.ts";
import type { SkillCommand, SkillEntry } from "./types.ts";

/**
 * Get all user-invocable slash commands from eligible skills.
 */
export async function getSkillCommands(): Promise<SkillCommand[]> {
  const snapshot = await getSkillSnapshot();
  const commands: SkillCommand[] = [];

  for (const skill of snapshot.skills) {
    if (!skill.frontmatter.userInvocable) continue;

    const cmd: SkillCommand = {
      name: skill.name,
      skillName: skill.name,
      description: skill.description,
      agent: skill.frontmatter.agent,
    };

    // Tool dispatch: /command → MCP tool directly
    if (skill.frontmatter["command-dispatch"] === "tool" && skill.frontmatter["command-tool"]) {
      cmd.dispatch = {
        kind: "tool",
        toolName: skill.frontmatter["command-tool"],
        argMode: skill.frontmatter["command-arg-mode"],
      };
    }

    commands.push(cmd);
  }

  return commands;
}

/**
 * Match a user message against skill slash commands.
 * Returns the matched command and remaining args, or null.
 */
export async function matchSkillCommand(text: string): Promise<{
  command: SkillCommand;
  args: string;
} | null> {
  const normalized = text.trim().toLowerCase();
  if (!normalized.startsWith("/")) return null;

  const commands = await getSkillCommands();

  for (const cmd of commands) {
    const prefix = `/${cmd.name}`;
    if (normalized === prefix || normalized.startsWith(prefix + " ")) {
      const args = text.trim().substring(prefix.length).trim();
      return { command: cmd, args };
    }
  }

  return null;
}

/**
 * Match an instant command — a subcommand that returns static skill content
 * without invoking the Claude pipeline. Returns the response text or null.
 *
 * Instant commands are defined in SKILL.md frontmatter:
 *   instant_commands: [help]
 *
 * For "help", extracts the ## Commands section from the skill body.
 */
export async function matchInstantCommand(text: string): Promise<{
  skillName: string;
  subcommand: string;
  response: string;
} | null> {
  const normalized = text.trim().toLowerCase();
  if (!normalized.startsWith("/")) return null;

  const snapshot = await getSkillSnapshot();

  for (const skill of snapshot.skills) {
    if (!skill.frontmatter.userInvocable) continue;
    if (!skill.frontmatter.instant_commands?.length) continue;

    const prefix = `/${skill.name}`;
    if (!normalized.startsWith(prefix)) continue;

    const args = normalized.substring(prefix.length).trim();
    const subcommand = args.split(/\s+/)[0] || "";

    if (!subcommand) continue;
    if (!skill.frontmatter.instant_commands.includes(subcommand)) continue;

    const response = buildInstantResponse(skill, subcommand);
    if (!response) continue;

    return { skillName: skill.name, subcommand, response };
  }

  return null;
}

/**
 * Build the response text for an instant command.
 */
function buildInstantResponse(skill: SkillEntry, subcommand: string): string | null {
  switch (subcommand) {
    case "help":
      return extractHelpSection(skill);
    default:
      return null;
  }
}

/**
 * Extract the ## Commands section from a skill body for /help responses.
 * Falls back to the skill description if no Commands section exists.
 */
function extractHelpSection(skill: SkillEntry): string {
  const body = skill.instructions;
  const header = `**/${skill.name}** — ${skill.description}\n\n`;

  // Split body by ## headers and find the Commands section
  const sections = body.split(/\n(?=## )/);
  const commandsSection = sections.find(s => s.startsWith("## Commands"));
  if (commandsSection) {
    // Strip the ## Commands header itself, keep just the content
    const content = commandsSection.replace(/^## Commands\s*\n/, "").trim();
    return header + content;
  }

  // Fallback: return skill description
  return `**/${skill.name}** — ${skill.description}\n\nNo detailed help available for this skill.`;
}
