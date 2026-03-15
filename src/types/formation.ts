/**
 * Formation Schema — ELLIE-673
 *
 * Formations are multi-agent coordination patterns. They define how
 * multiple agents collaborate on a shared task — who participates,
 * how they interact, and what protocols govern the conversation.
 *
 * Hierarchy:
 *   Archetypes (ELLIE-603) = HOW an agent behaves (behavioral DNA)
 *   Roles (ELLIE-605)      = WHAT an agent does (functional capabilities)
 *   Skills (ELLIE-217)     = Tools and actions available
 *   Formations (this)      = Multi-agent coordination patterns
 *
 * Formation files live in skills/formations/{name}/SKILL.md with
 * YAML frontmatter + markdown instructions.
 *
 * Pure module — types, parsing, and validation only, no side effects.
 */

// ── Core Types ──────────────────────────────────────────────────

/** An agent's role within a formation. */
export interface AgentRole {
  /** Agent name (must match an agent in the agents table). */
  agent: string;
  /** Role within this formation (e.g. "lead", "reviewer", "executor"). */
  role: string;
  /** What this agent is responsible for in the formation. */
  responsibility: string;
  /** Optional: override the agent's default model for this formation. */
  model?: string;
  /** Optional: skills this agent should have enabled. */
  skills?: string[];
  /** Whether this agent can initiate messages (vs only respond). Default: true. */
  canInitiate?: boolean;
}

/** Defines how agents interact within the formation. */
export interface InteractionProtocol {
  /** Pattern type: how messages flow between agents. */
  pattern: "round-robin" | "coordinator" | "debate" | "pipeline" | "free-form";
  /** Max turns before the formation auto-completes. 0 = unlimited. */
  maxTurns: number;
  /** Which agent coordinates (required for "coordinator" pattern). */
  coordinator?: string;
  /** Turn order for "round-robin" and "pipeline" patterns. Agent names. */
  turnOrder?: string[];
  /** Whether human approval is needed before the formation acts. */
  requiresApproval: boolean;
  /** How the formation resolves disagreements between agents. */
  conflictResolution?: "coordinator-decides" | "majority-vote" | "escalate-to-human";
}

/** Frontmatter fields for a formation SKILL.md file. */
export interface FormationFrontmatter {
  /** Formation name (unique identifier). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Agents participating and their roles. */
  agents: AgentRole[];
  /** How agents interact. */
  protocol: InteractionProtocol;
  /** Intent-routing triggers (when to activate this formation). */
  triggers?: string[];
  /** Minimum number of agents required to start. */
  minAgents?: number;
  /** Maximum duration in seconds before timeout. */
  timeoutSeconds?: number;
}

/** A parsed markdown section (H2 heading + content). */
export interface FormationSection {
  heading: string;
  content: string;
}

/** Complete parsed formation — frontmatter + sections + raw body. */
export interface FormationSchema {
  frontmatter: FormationFrontmatter;
  sections: FormationSection[];
  body: string;
}

/** Validation error with field path and message. */
export interface FormationValidationError {
  field: string;
  message: string;
}

/** Result of validating a formation file. */
export interface FormationValidationResult {
  valid: boolean;
  errors: FormationValidationError[];
}

// ── Database Types ──────────────────────────────────────────────

/** A formation session record (maps to formation_sessions table). */
export interface FormationSession {
  id: string;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  formation_name: string;
  state: FormationSessionState;
  turn_count: number;
  initiator_agent: string;
  channel: string;
  work_item_id: string | null;
  protocol: InteractionProtocol;
  participating_agents: string[];
  metadata: Record<string, unknown>;
  /** UUID of the agent that currently holds the checkout (FK to agents.id). */
  checked_out_by: string | null;
  /** When the checkout was acquired. */
  checked_out_at: Date | null;
  /** Checkout lifecycle status (separate from conversational `state`). */
  status: FormationCheckoutStatus;
}

export type FormationSessionState =
  | "active"
  | "paused"
  | "completed"
  | "failed"
  | "timed_out";

/** Checkout lifecycle status for formation sessions. */
export type FormationCheckoutStatus =
  | "pending"
  | "checked_out"
  | "in_progress"
  | "completed"
  | "failed";

/** A message within a formation session (maps to formation_messages table). */
export interface FormationMessage {
  id: string;
  created_at: Date;
  session_id: string;
  from_agent: string;
  to_agent: string | null;
  content: string;
  turn_number: number;
  message_type: FormationMessageType;
  metadata: Record<string, unknown>;
}

export type FormationMessageType =
  | "proposal"
  | "response"
  | "decision"
  | "escalation"
  | "system";

// ── Constants ───────────────────────────────────────────────────

/** Required H2 sections in every formation SKILL.md file. */
export const REQUIRED_FORMATION_SECTIONS = [
  "Objective",
  "Agent Roles",
  "Interaction Flow",
] as const;

/** Valid interaction patterns. */
export const VALID_PATTERNS = [
  "round-robin",
  "coordinator",
  "debate",
  "pipeline",
  "free-form",
] as const;

/** Valid conflict resolution strategies. */
export const VALID_CONFLICT_RESOLUTIONS = [
  "coordinator-decides",
  "majority-vote",
  "escalate-to-human",
] as const;

/** Valid formation session states. */
export const VALID_SESSION_STATES = [
  "active",
  "paused",
  "completed",
  "failed",
  "timed_out",
] as const;

/** Valid checkout statuses. */
export const VALID_CHECKOUT_STATUSES = [
  "pending",
  "checked_out",
  "in_progress",
  "completed",
  "failed",
] as const;

/** Valid formation message types. */
export const VALID_MESSAGE_TYPES = [
  "proposal",
  "response",
  "decision",
  "escalation",
  "system",
] as const;

// ── Parsing ─────────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

/**
 * Parse a formation SKILL.md file into its schema components.
 * Returns null if the file has no valid frontmatter with a name field.
 */
export function parseFormation(raw: string): FormationSchema | null {
  const fmMatch = raw.match(FRONTMATTER_RE);
  if (!fmMatch) return null;

  const yamlBlock = fmMatch[1];
  const body = fmMatch[2].trim();

  const fm = parseFormationYaml(yamlBlock);

  if (typeof fm.name !== "string" || !fm.name.trim()) return null;

  const agents = parseAgentRoles(fm.agents);
  const protocol = parseProtocol(fm.protocol);

  const frontmatter: FormationFrontmatter = {
    name: fm.name as string,
    description: typeof fm.description === "string" ? fm.description : "",
    agents,
    protocol,
  };

  if (Array.isArray(fm.triggers)) {
    frontmatter.triggers = fm.triggers as string[];
  }
  if (typeof fm.minAgents === "number") {
    frontmatter.minAgents = fm.minAgents;
  }
  if (typeof fm.timeoutSeconds === "number") {
    frontmatter.timeoutSeconds = fm.timeoutSeconds;
  }

  const sections = parseSections(body);
  return { frontmatter, sections, body };
}

/**
 * Extract H2 sections from markdown body.
 */
export function parseSections(body: string): FormationSection[] {
  const sections: FormationSection[] = [];
  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  for (const line of body.split("\n")) {
    const h2Match = line.match(/^## (.+)$/);
    if (h2Match) {
      if (currentHeading !== null) {
        sections.push({
          heading: currentHeading,
          content: currentLines.join("\n").trim(),
        });
      }
      currentHeading = h2Match[1].trim();
      currentLines = [];
    } else if (currentHeading !== null) {
      currentLines.push(line);
    }
  }

  if (currentHeading !== null) {
    sections.push({
      heading: currentHeading,
      content: currentLines.join("\n").trim(),
    });
  }

  return sections;
}

// ── Validation ──────────────────────────────────────────────────

/**
 * Validate a formation schema against requirements.
 */
export function validateFormation(schema: FormationSchema): FormationValidationResult {
  const errors: FormationValidationError[] = [];

  // Frontmatter validation
  if (!schema.frontmatter.name.trim()) {
    errors.push({ field: "frontmatter.name", message: "name is required" });
  }

  if (!schema.frontmatter.description.trim()) {
    errors.push({ field: "frontmatter.description", message: "description is required" });
  }

  if (schema.frontmatter.agents.length === 0) {
    errors.push({ field: "frontmatter.agents", message: "at least one agent role is required" });
  }

  // Validate each agent role
  for (let i = 0; i < schema.frontmatter.agents.length; i++) {
    const agent = schema.frontmatter.agents[i];
    if (!agent.agent.trim()) {
      errors.push({ field: `frontmatter.agents[${i}].agent`, message: "agent name is required" });
    }
    if (!agent.role.trim()) {
      errors.push({ field: `frontmatter.agents[${i}].role`, message: "role is required" });
    }
    if (!agent.responsibility.trim()) {
      errors.push({ field: `frontmatter.agents[${i}].responsibility`, message: "responsibility is required" });
    }
  }

  // Validate protocol
  const protocol = schema.frontmatter.protocol;
  if (!VALID_PATTERNS.includes(protocol.pattern as typeof VALID_PATTERNS[number])) {
    errors.push({ field: "frontmatter.protocol.pattern", message: `pattern must be one of: ${VALID_PATTERNS.join(", ")}` });
  }

  if (protocol.pattern === "coordinator" && !protocol.coordinator) {
    errors.push({ field: "frontmatter.protocol.coordinator", message: "coordinator is required for coordinator pattern" });
  }

  if (protocol.coordinator) {
    const agentNames = schema.frontmatter.agents.map(a => a.agent);
    if (!agentNames.includes(protocol.coordinator)) {
      errors.push({ field: "frontmatter.protocol.coordinator", message: `coordinator "${protocol.coordinator}" is not in the agents list` });
    }
  }

  if (protocol.turnOrder) {
    const agentNames = new Set(schema.frontmatter.agents.map(a => a.agent));
    for (const name of protocol.turnOrder) {
      if (!agentNames.has(name)) {
        errors.push({ field: "frontmatter.protocol.turnOrder", message: `turn order agent "${name}" is not in the agents list` });
      }
    }
  }

  if (protocol.conflictResolution &&
      !VALID_CONFLICT_RESOLUTIONS.includes(protocol.conflictResolution as typeof VALID_CONFLICT_RESOLUTIONS[number])) {
    errors.push({ field: "frontmatter.protocol.conflictResolution", message: `must be one of: ${VALID_CONFLICT_RESOLUTIONS.join(", ")}` });
  }

  if (schema.frontmatter.minAgents !== undefined && schema.frontmatter.minAgents < 1) {
    errors.push({ field: "frontmatter.minAgents", message: "minAgents must be at least 1" });
  }

  if (schema.frontmatter.timeoutSeconds !== undefined && schema.frontmatter.timeoutSeconds <= 0) {
    errors.push({ field: "frontmatter.timeoutSeconds", message: "timeoutSeconds must be positive" });
  }

  // Section validation
  const headings = new Set(schema.sections.map(s => s.heading.toLowerCase().trim()));

  for (const required of REQUIRED_FORMATION_SECTIONS) {
    if (!headings.has(required.toLowerCase())) {
      errors.push({
        field: `sections.${required}`,
        message: `Required section "## ${required}" is missing`,
      });
    }
  }

  for (const section of schema.sections) {
    if (REQUIRED_FORMATION_SECTIONS.some(r => r.toLowerCase() === section.heading.toLowerCase().trim())) {
      if (!section.content.trim()) {
        errors.push({
          field: `sections.${section.heading}`,
          message: `Section "## ${section.heading}" is empty`,
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate raw markdown string — parse + validate in one step.
 */
export function validateFormationFile(raw: string): {
  schema: FormationSchema | null;
  validation: FormationValidationResult;
} {
  const schema = parseFormation(raw);

  if (!schema) {
    return {
      schema: null,
      validation: {
        valid: false,
        errors: [{ field: "file", message: "Could not parse formation file — missing or invalid frontmatter with name field" }],
      },
    };
  }

  return { schema, validation: validateFormation(schema) };
}

// ── Queries ─────────────────────────────────────────────────────

/**
 * Get a specific section from a parsed formation by heading.
 */
export function getSection(schema: FormationSchema, heading: string): FormationSection | null {
  const normalized = heading.toLowerCase().trim();
  return schema.sections.find(s => s.heading.toLowerCase().trim() === normalized) ?? null;
}

/**
 * List all section headings in a formation.
 */
export function listSectionHeadings(schema: FormationSchema): string[] {
  return schema.sections.map(s => s.heading);
}

/**
 * Check if a formation has all required sections.
 */
export function hasAllRequiredSections(schema: FormationSchema): boolean {
  const headings = new Set(schema.sections.map(s => s.heading.toLowerCase().trim()));
  return REQUIRED_FORMATION_SECTIONS.every(r => headings.has(r.toLowerCase()));
}

/**
 * Get missing required sections.
 */
export function getMissingSections(schema: FormationSchema): string[] {
  const headings = new Set(schema.sections.map(s => s.heading.toLowerCase().trim()));
  return REQUIRED_FORMATION_SECTIONS.filter(r => !headings.has(r.toLowerCase()));
}

/**
 * Get all agent names from a formation.
 */
export function getAgentNames(schema: FormationSchema): string[] {
  return schema.frontmatter.agents.map(a => a.agent);
}

// ── YAML Parsing Helpers ────────────────────────────────────────

/**
 * Parse formation YAML frontmatter.
 * Handles the nested agents[] and protocol{} structures via JSON embedded in YAML.
 */
function parseFormationYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split("\n");
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();

    if (!trimmed || trimmed.startsWith("#")) {
      i++;
      continue;
    }

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = trimmed.substring(0, colonIdx).trim();
    const rawValue = trimmed.substring(colonIdx + 1).trim();

    // JSON value (array or object) on same line
    if (rawValue.startsWith("[") || rawValue.startsWith("{")) {
      try {
        result[key] = JSON.parse(rawValue);
        i++;
        continue;
      } catch {
        // Not valid JSON on this line — try multiline
      }
    }

    // Inline array: [item1, item2]
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      const inner = rawValue.slice(1, -1);
      result[key] = inner
        .split(",")
        .map(s => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      i++;
      continue;
    }

    // Scalar value on same line
    if (rawValue && !rawValue.endsWith(":")) {
      result[key] = parseScalar(rawValue);
      i++;
      continue;
    }

    // No value — check for multiline JSON block or nested YAML
    if (!rawValue || rawValue === "") {
      i++;
      const blockLines: string[] = [];
      while (i < lines.length) {
        const nextLine = lines[i];
        const nextTrimmed = nextLine.trim();

        if (!nextTrimmed || nextTrimmed.startsWith("#")) {
          blockLines.push(nextLine);
          i++;
          continue;
        }

        const indent = nextLine.length - nextLine.trimStart().length;
        if (indent > 0) {
          blockLines.push(nextTrimmed);
          i++;
          continue;
        }

        break;
      }

      const blockText = blockLines.map(l => l.trim()).filter(Boolean).join("\n");
      if (blockText) {
        // Try parsing as JSON
        try {
          result[key] = JSON.parse(blockText);
          continue;
        } catch {
          // Store as string
          result[key] = blockText;
          continue;
        }
      }
      continue;
    }

    i++;
  }

  return result;
}

function parseScalar(val: string): string | number | boolean {
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  if (val === "true") return true;
  if (val === "false") return false;
  const num = Number(val);
  if (!isNaN(num) && val !== "") return num;
  return val;
}

function parseAgentRoles(raw: unknown): AgentRole[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item: Record<string, unknown>) => ({
    agent: typeof item.agent === "string" ? item.agent : "",
    role: typeof item.role === "string" ? item.role : "",
    responsibility: typeof item.responsibility === "string" ? item.responsibility : "",
    model: typeof item.model === "string" ? item.model : undefined,
    skills: Array.isArray(item.skills) ? (item.skills as string[]) : undefined,
    canInitiate: typeof item.canInitiate === "boolean" ? item.canInitiate : undefined,
  }));
}

function parseProtocol(raw: unknown): InteractionProtocol {
  if (!raw || typeof raw !== "object") {
    return { pattern: "free-form", maxTurns: 0, requiresApproval: false };
  }
  const obj = raw as Record<string, unknown>;
  return {
    pattern: (typeof obj.pattern === "string" ? obj.pattern : "free-form") as InteractionProtocol["pattern"],
    maxTurns: typeof obj.maxTurns === "number" ? obj.maxTurns : 0,
    coordinator: typeof obj.coordinator === "string" ? obj.coordinator : undefined,
    turnOrder: Array.isArray(obj.turnOrder) ? (obj.turnOrder as string[]) : undefined,
    requiresApproval: typeof obj.requiresApproval === "boolean" ? obj.requiresApproval : false,
    conflictResolution: typeof obj.conflictResolution === "string"
      ? (obj.conflictResolution as InteractionProtocol["conflictResolution"])
      : undefined,
  };
}

// ── Testing Helpers ─────────────────────────────────────────────

export function _makeMockFormationFrontmatter(
  overrides: Partial<FormationFrontmatter> = {},
): FormationFrontmatter {
  return {
    name: "test-formation",
    description: "A test formation for unit tests",
    agents: [
      { agent: "dev", role: "lead", responsibility: "Write implementation code" },
      { agent: "critic", role: "reviewer", responsibility: "Review and critique code" },
    ],
    protocol: {
      pattern: "coordinator",
      maxTurns: 10,
      coordinator: "dev",
      requiresApproval: false,
      conflictResolution: "coordinator-decides",
    },
    ...overrides,
  };
}

export function _makeMockFormationMarkdown(
  overrides: Partial<FormationFrontmatter> = {},
): string {
  const fm = _makeMockFormationFrontmatter(overrides);
  return `---
name: ${fm.name}
description: ${fm.description}
agents: ${JSON.stringify(fm.agents)}
protocol: ${JSON.stringify(fm.protocol)}
${fm.triggers ? `triggers: ${JSON.stringify(fm.triggers)}` : ""}
${fm.minAgents ? `minAgents: ${fm.minAgents}` : ""}
${fm.timeoutSeconds ? `timeoutSeconds: ${fm.timeoutSeconds}` : ""}
---

## Objective

Coordinate agents to accomplish the formation's goal.

## Agent Roles

${fm.agents.map(a => `- **${a.agent}** (${a.role}): ${a.responsibility}`).join("\n")}

## Interaction Flow

1. Lead proposes implementation approach
2. Reviewer critiques the proposal
3. Lead incorporates feedback and finalizes
`;
}
