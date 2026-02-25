/**
 * Skill Commands — ELLIE-217
 *
 * Extracts user-invocable slash commands from eligible skills.
 */

import { getSkillSnapshot } from "./snapshot.ts";
import type { SkillCommand } from "./types.ts";

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
