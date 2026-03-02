/**
 * Skill System Types — ELLIE-217
 *
 * OpenClaw-compatible skill definitions for Ellie OS.
 */

export interface SkillFrontmatter {
  name: string;
  description: string;
  userInvocable?: boolean;
  always?: boolean;
  os?: string[];
  requires?: {
    bins?: string[];
    env?: string[];
    credentials?: string[];  // vault domain names (e.g. "github.com", "miro.com")
  };
  install?: SkillInstallSpec[];
  // Ellie-specific extensions
  agent?: string;           // pin to a specific agent (dev, research, etc.)
  mcp?: string;             // MCP tool pattern this skill uses (e.g. "mcp__github__*")
  triggers?: string[];      // intent-routing hints
  help?: string;            // how to get credentials / setup info (shown in dashboard)
  instant_commands?: string[];  // subcommands that return static content (no Claude call)
  // Tool dispatch
  "command-dispatch"?: "tool";
  "command-tool"?: string;
  "command-arg-mode"?: "raw";
}

export interface SkillInstallSpec {
  kind: "brew" | "npm" | "apt" | "download";
  label: string;
  package?: string;
  url?: string;
}

export interface SkillEntry {
  name: string;
  description: string;
  instructions: string;       // raw markdown body (after frontmatter)
  frontmatter: SkillFrontmatter;
  sourceDir: string;
  sourcePriority: number;     // lower = higher priority
}

export interface SkillSnapshot {
  prompt: string;             // XML block for system prompt injection
  skills: SkillEntry[];       // filtered eligible skills
  version: number;            // bumped on change
  totalChars: number;         // prompt char count
}

export interface SkillCommand {
  name: string;               // slash command name (e.g. "github")
  skillName: string;          // original skill name
  description: string;
  dispatch?: {
    kind: "tool";
    toolName: string;
    argMode?: "raw";
  };
  agent?: string;
}

// Limits (aligned with OpenClaw defaults)
export const SKILL_LIMITS = {
  maxSkillFileBytes: 256_000,       // 256KB per SKILL.md
  maxSkillsInPrompt: 150,           // max skills injected
  maxSkillsPromptChars: 30_000,     // total prompt char cap
} as const;
