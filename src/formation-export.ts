/**
 * Formation Export/Import System — ELLIE-732
 *
 * Portable formation packages: export SKILL.md + config into a manifest,
 * scrub secrets, import with collision handling and auto-provisioning.
 *
 * Pure module — types, packaging, scrubbing, validation, collision detection.
 * No side effects (file I/O and DB calls are in the caller).
 */

// ── Types ────────────────────────────────────────────────────

/** Manifest format version. */
export const MANIFEST_VERSION = 1;

/** A formation export manifest (the JSON payload inside .formation.zip). */
export interface FormationManifest {
  version: number;
  exported_at: string;
  formation: {
    name: string;
    description: string;
    skill_md: string;
  };
  agents: ExportedAgent[];
  protocol: ExportedProtocol;
  heartbeat: ExportedHeartbeat | null;
  metadata: Record<string, unknown>;
}

export interface ExportedAgent {
  name: string;
  type: string;
  title: string | null;
  role: string;
  responsibility: string;
  model: string | null;
  capabilities: string[];
  skills: string[];
}

export interface ExportedProtocol {
  pattern: string;
  maxTurns: number;
  coordinator: string | null;
  turnOrder: string[] | null;
  requiresApproval: boolean;
  conflictResolution: string | null;
}

export interface ExportedHeartbeat {
  schedule: string;
  enabled: boolean;
  run_context: Record<string, unknown>;
}

/** Secret patterns that should be scrubbed from exports. */
export const SECRET_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|apikey)\s*[:=]\s*["']?[a-zA-Z0-9_\-]{20,}["']?/gi,
  /(?:secret|token|password|credential)\s*[:=]\s*["']?[a-zA-Z0-9_\-]{8,}["']?/gi,
  /sk-[a-zA-Z0-9]{20,}/g,           // OpenAI-style keys
  /bk_[a-f0-9]{40,}/g,              // Bridge keys
  /xoxb-[a-zA-Z0-9\-]+/g,          // Slack bot tokens
  /ghp_[a-zA-Z0-9]{36,}/g,          // GitHub PATs
  /Bearer\s+[a-zA-Z0-9_\-.]+/g,     // Bearer tokens
];

/** Placeholder for scrubbed secrets. */
export const SCRUBBED_PLACEHOLDER = "[SCRUBBED]";

// ── Collision Types ─────────────────────────────────────────

export type CollisionStrategy = "rename" | "skip" | "overwrite";

export interface AgentCollision {
  imported_name: string;
  existing_name: string;
  strategy: CollisionStrategy;
  renamed_to: string | null;
}

export interface ImportValidationResult {
  valid: boolean;
  errors: string[];
  collisions: AgentCollision[];
}

// ── Export ───────────────────────────────────────────────────

/**
 * Build a formation export manifest from components.
 * Pure function — caller provides the data.
 */
export function buildManifest(opts: {
  name: string;
  description: string;
  skill_md: string;
  agents: ExportedAgent[];
  protocol: ExportedProtocol;
  heartbeat?: ExportedHeartbeat | null;
  metadata?: Record<string, unknown>;
}): FormationManifest {
  return {
    version: MANIFEST_VERSION,
    exported_at: new Date().toISOString(),
    formation: {
      name: opts.name,
      description: opts.description,
      skill_md: opts.skill_md,
    },
    agents: opts.agents,
    protocol: opts.protocol,
    heartbeat: opts.heartbeat ?? null,
    metadata: opts.metadata ?? {},
  };
}

/**
 * Serialize a manifest to JSON string.
 */
export function serializeManifest(manifest: FormationManifest): string {
  return JSON.stringify(manifest, null, 2);
}

/**
 * Deserialize a manifest from JSON string.
 * Returns null if invalid JSON.
 */
export function deserializeManifest(json: string): FormationManifest | null {
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || !parsed.version || !parsed.formation) {
      return null;
    }
    return parsed as FormationManifest;
  } catch {
    return null;
  }
}

// ── Secret Scrubbing ────────────────────────────────────────

/**
 * Scrub secrets from a string using known patterns.
 * Returns the scrubbed string and the count of secrets found.
 */
export function scrubSecrets(input: string): { scrubbed: string; count: number } {
  let scrubbed = input;
  let count = 0;

  for (const pattern of SECRET_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    const matches = scrubbed.match(pattern);
    if (matches) {
      count += matches.length;
      scrubbed = scrubbed.replace(pattern, SCRUBBED_PLACEHOLDER);
    }
  }

  return { scrubbed, count };
}

/**
 * Recursively scrub string values in an object.
 */
function scrubObjectValues(obj: unknown): { obj: unknown; count: number } {
  let count = 0;

  if (typeof obj === "string") {
    const result = scrubSecrets(obj);
    return { obj: result.scrubbed, count: result.count };
  }

  if (Array.isArray(obj)) {
    const scrubbed = obj.map(item => {
      const r = scrubObjectValues(item);
      count += r.count;
      return r.obj;
    });
    return { obj: scrubbed, count };
  }

  if (obj && typeof obj === "object") {
    const scrubbed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const r = scrubObjectValues(value);
      count += r.count;
      scrubbed[key] = r.obj;
    }
    return { obj: scrubbed, count };
  }

  return { obj, count: 0 };
}

/**
 * Scrub secrets from a manifest (skill_md, metadata, run_context).
 * Returns a new manifest with secrets removed.
 */
export function scrubManifest(manifest: FormationManifest): {
  manifest: FormationManifest;
  total_scrubbed: number;
} {
  let totalScrubbed = 0;

  // Scrub skill_md
  const { scrubbed: scrubbedMd, count: mdCount } = scrubSecrets(manifest.formation.skill_md);
  totalScrubbed += mdCount;

  // Scrub metadata values recursively
  const { obj: scrubbedMetaObj, count: metaCount } = scrubObjectValues(manifest.metadata);
  totalScrubbed += metaCount;

  // Scrub heartbeat run_context
  let scrubbedHeartbeat = manifest.heartbeat;
  if (manifest.heartbeat) {
    const { obj: scrubbedHbObj, count: hbCount } = scrubObjectValues(manifest.heartbeat.run_context);
    totalScrubbed += hbCount;
    scrubbedHeartbeat = {
      ...manifest.heartbeat,
      run_context: scrubbedHbObj as Record<string, unknown>,
    };
  }

  return {
    manifest: {
      ...manifest,
      formation: {
        ...manifest.formation,
        skill_md: scrubbedMd,
      },
      metadata: scrubbedMetaObj as Record<string, unknown>,
      heartbeat: scrubbedHeartbeat,
    },
    total_scrubbed: totalScrubbed,
  };
}

// ── Import Validation ───────────────────────────────────────

/**
 * Validate a manifest for import.
 * Checks version, required fields, agent structure.
 */
export function validateManifest(manifest: FormationManifest): string[] {
  const errors: string[] = [];

  if (manifest.version !== MANIFEST_VERSION) {
    errors.push(`Unsupported manifest version: ${manifest.version} (expected ${MANIFEST_VERSION})`);
  }

  if (!manifest.formation.name?.trim()) {
    errors.push("Formation name is required");
  }

  if (!manifest.formation.skill_md?.trim()) {
    errors.push("Formation SKILL.md content is required");
  }

  if (!manifest.agents || manifest.agents.length === 0) {
    errors.push("At least one agent is required");
  }

  for (let i = 0; i < (manifest.agents?.length ?? 0); i++) {
    const agent = manifest.agents[i];
    if (!agent.name?.trim()) {
      errors.push(`Agent ${i}: name is required`);
    }
    if (!agent.type?.trim()) {
      errors.push(`Agent ${i}: type is required`);
    }
    if (!agent.role?.trim()) {
      errors.push(`Agent ${i}: role is required`);
    }
  }

  if (!manifest.protocol) {
    errors.push("Protocol is required");
  }

  return errors;
}

// ── Collision Detection ─────────────────────────────────────

/**
 * Detect agent name collisions between imported agents and existing ones.
 * Pure function — caller provides the existing agent names.
 */
export function detectCollisions(
  importedAgents: ExportedAgent[],
  existingAgentNames: Set<string>,
): AgentCollision[] {
  return importedAgents
    .filter(a => existingAgentNames.has(a.name))
    .map(a => ({
      imported_name: a.name,
      existing_name: a.name,
      strategy: "skip" as CollisionStrategy,
      renamed_to: null,
    }));
}

/**
 * Resolve collisions by applying a strategy.
 * Returns updated agent list with renames applied.
 */
export function resolveCollisions(
  agents: ExportedAgent[],
  collisions: AgentCollision[],
): ExportedAgent[] {
  const collisionMap = new Map(collisions.map(c => [c.imported_name, c]));

  return agents
    .map(agent => {
      const collision = collisionMap.get(agent.name);
      if (!collision) return agent;

      switch (collision.strategy) {
        case "skip":
          return null; // Will be filtered out
        case "rename":
          if (!collision.renamed_to) return null;
          return { ...agent, name: collision.renamed_to };
        case "overwrite":
          return agent; // Use imported version
        default:
          return null;
      }
    })
    .filter((a): a is ExportedAgent => a !== null);
}

/**
 * Generate a unique agent name by appending a suffix.
 */
export function generateUniqueName(
  baseName: string,
  existingNames: Set<string>,
): string {
  let suffix = 2;
  let candidate = `${baseName}-${suffix}`;
  while (existingNames.has(candidate)) {
    suffix++;
    candidate = `${baseName}-${suffix}`;
  }
  return candidate;
}

/**
 * Full import validation: validate manifest + detect collisions.
 */
export function validateImport(
  manifest: FormationManifest,
  existingAgentNames: Set<string>,
): ImportValidationResult {
  const errors = validateManifest(manifest);
  const collisions = errors.length === 0
    ? detectCollisions(manifest.agents, existingAgentNames)
    : [];

  return {
    valid: errors.length === 0,
    errors,
    collisions,
  };
}
