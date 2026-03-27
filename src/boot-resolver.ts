/**
 * Boot-up Packet Resolver — ELLIE-839
 *
 * Parses boot_requirements from creature YAML frontmatter and resolves
 * each layer at dispatch time before agent execution.
 *
 * 4-layer model:
 *   Identity      — soul, archetype, role bindings, agent name
 *   Capability    — tool access, skill eligibility, runtime
 *   Context       — work item, Forest search, service state
 *   Communication — produces/consumes contracts, channel config
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { log } from "./logger.ts";
import { loadCreature as loadUnifiedCreature, loadAllCreatures as loadAllUnifiedCreatures } from "./creature-loader.ts";

const logger = log.child("boot-resolver");

// ── Types ────────────────────────────────────────────────────────

export interface BootRequirements {
  identity: Record<string, unknown>[];
  capability: Record<string, unknown>[];
  context: Record<string, unknown>[];
  communication: Record<string, unknown>[];
}

export interface CreatureDef {
  name: string;
  role?: string;
  species?: string;
  cognitive_style?: string;
  description?: string;
  produces?: string[];
  consumes?: string[];
  boot_requirements?: BootRequirements;
  tools?: Record<string, unknown> | string[];
  autonomy?: Record<string, unknown>;
  body: string;
}

export type BootLayer = "identity" | "capability" | "context" | "communication";

export interface ResolvedLayer {
  layer: BootLayer;
  status: "resolved" | "partial" | "failed";
  resolved: Record<string, unknown>;
  missing: string[];
}

export interface BootResolution {
  agent: string;
  creature: string;
  layers: ResolvedLayer[];
  allResolved: boolean;
  summary: string;
}

export interface BootResolverContext {
  workItemId?: string;
  workItemTitle?: string;
  workItemDescription?: string;
  channel?: string;
  forestSearchResults?: string;
  serviceStates?: Record<string, string>;
  userProfile?: string;
  soulContent?: string;
}

// ── Creature file parsing ────────────────────────────────────────

const CREATURES_DIR = "creatures";
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

/**
 * Parse a creature markdown file into its definition.
 */
export function parseCreature(raw: string): CreatureDef | null {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return null;

  const yamlBlock = match[1];
  const body = match[2].trim();
  const fm = parseCreatureYaml(yamlBlock);

  if (!fm.name) return null;

  return {
    name: fm.name as string,
    role: fm.role as string | undefined,
    species: fm.species as string | undefined,
    cognitive_style: fm.cognitive_style as string | undefined,
    description: fm.description as string | undefined,
    produces: fm.produces as string[] | undefined,
    consumes: fm.consumes as string[] | undefined,
    boot_requirements: fm.boot_requirements as BootRequirements | undefined,
    tools: fm.tools as Record<string, unknown> | string[] | undefined,
    autonomy: fm.autonomy as Record<string, unknown> | undefined,
    body,
  };
}

/**
 * Load all creature definitions from the creatures/ directory.
 * Uses unified loader (ELLIE-1075) which supports both legacy .md files
 * and new directory structure (creatures/{name}/).
 */
export function loadCreatures(dir?: string): Map<string, CreatureDef> {
  const unified = loadAllUnifiedCreatures(dir);
  const result = new Map<string, CreatureDef>();
  for (const [key, def] of unified) {
    result.set(key, def);
  }
  return result;
}

/**
 * Get a creature by agent name (matches role or name field).
 * Uses unified loader (ELLIE-1075) which checks directory structure first,
 * then falls back to legacy .md file.
 */
export function getCreature(agentName: string, dir?: string): CreatureDef | null {
  return loadUnifiedCreature(agentName, dir) ?? null;
}

// ── Boot resolution ──────────────────────────────────────────────

/**
 * Resolve all 4 boot requirement layers for an agent.
 * Returns resolved values and any missing requirements.
 */
export function resolveBootRequirements(
  creature: CreatureDef,
  ctx: BootResolverContext,
): BootResolution {
  const reqs = creature.boot_requirements;
  if (!reqs) {
    return {
      agent: creature.role ?? creature.name,
      creature: creature.name,
      layers: [],
      allResolved: true,
      summary: "No boot requirements declared",
    };
  }

  const layers: ResolvedLayer[] = [
    resolveIdentity(reqs.identity ?? [], creature, ctx),
    resolveCapability(reqs.capability ?? [], creature, ctx),
    resolveContext(reqs.context ?? [], creature, ctx),
    resolveCommunication(reqs.communication ?? [], creature, ctx),
  ];

  const allResolved = layers.every(l => l.status === "resolved");
  const missing = layers.flatMap(l => l.missing);

  return {
    agent: creature.role ?? creature.name,
    creature: creature.name,
    layers,
    allResolved,
    summary: allResolved
      ? "All boot requirements resolved"
      : `Missing: ${missing.join(", ")}`,
  };
}

// ── Layer resolvers ──────────────────────────────────────────────

function resolveIdentity(
  requirements: Record<string, unknown>[],
  creature: CreatureDef,
  ctx: BootResolverContext,
): ResolvedLayer {
  const resolved: Record<string, unknown> = {};
  const missing: string[] = [];

  for (const req of requirements) {
    for (const [key, value] of Object.entries(req)) {
      switch (key) {
        case "agent_name":
          resolved.agent_name = creature.name;
          break;
        case "role":
          resolved.role = creature.role ?? creature.name;
          break;
        case "work_item_id":
          if (ctx.workItemId) {
            resolved.work_item_id = ctx.workItemId;
          } else if (value === "required") {
            missing.push("work_item_id");
          }
          break;
        case "user_profile":
          if (ctx.userProfile) {
            resolved.user_profile = ctx.userProfile;
          } else {
            resolved.user_profile = "Dave (CST, dyslexia-friendly, audio-first)";
          }
          break;
        case "soul_file":
          resolved.soul_file = ctx.soulContent ?? "available";
          break;
        case "channel_state":
          resolved.channel_state = ctx.channel ?? "unknown";
          break;
        default:
          resolved[key] = value;
      }
    }
  }

  return {
    layer: "identity",
    status: missing.length === 0 ? "resolved" : "failed",
    resolved,
    missing,
  };
}

function resolveCapability(
  requirements: Record<string, unknown>[],
  creature: CreatureDef,
  ctx: BootResolverContext,
): ResolvedLayer {
  const resolved: Record<string, unknown> = {};
  const missing: string[] = [];

  for (const req of requirements) {
    for (const [key, value] of Object.entries(req)) {
      switch (key) {
        case "codebase_access":
          // Check if codebase directories exist
          const repos = Array.isArray(value) ? value : [value];
          resolved.codebase_access = repos;
          break;
        case "database_access":
          resolved.database_access = Array.isArray(value) ? value : [value];
          break;
        case "runtime":
          resolved.runtime = value;
          break;
        case "search_apis":
          resolved.search_apis = "available";
          break;
        case "forest_access":
          resolved.forest_access = "available";
          break;
        case "codebase_read_access":
          resolved.codebase_read_access = "available";
          break;
        case "specialist_registry":
          resolved.specialist_registry = "available";
          break;
        case "tool_access_map":
          resolved.tool_access_map = creature.tools ?? {};
          break;
        default:
          resolved[key] = value;
      }
    }
  }

  return {
    layer: "capability",
    status: missing.length === 0 ? "resolved" : "partial",
    resolved,
    missing,
  };
}

function resolveContext(
  requirements: Record<string, unknown>[],
  creature: CreatureDef,
  ctx: BootResolverContext,
): ResolvedLayer {
  const resolved: Record<string, unknown> = {};
  const missing: string[] = [];

  for (const req of requirements) {
    for (const [key, value] of Object.entries(req)) {
      switch (key) {
        case "work_item_details":
          if (ctx.workItemTitle) {
            resolved.work_item_details = {
              title: ctx.workItemTitle,
              description: ctx.workItemDescription ?? "",
            };
          } else if (ctx.workItemId) {
            resolved.work_item_details = { id: ctx.workItemId, pending: true };
          }
          break;
        case "forest_search":
        case "prior_research_on_topic":
        case "related_forest_entries":
        case "prior_decisions_on_topic":
          resolved[key] = ctx.forestSearchResults ?? "pending";
          break;
        case "service_state":
          resolved.service_state = ctx.serviceStates ?? "available";
          break;
        case "test_environment":
          resolved.test_environment = "ready";
          break;
        case "forest_recent_context":
          resolved.forest_recent_context = ctx.forestSearchResults ?? "pending";
          break;
        case "active_goals":
          resolved.active_goals = "pending";
          break;
        case "pending_actions":
          resolved.pending_actions = "pending";
          break;
        case "relevant_work_items":
          resolved.relevant_work_items = ctx.workItemId ? [ctx.workItemId] : [];
          break;
        default:
          resolved[key] = value;
      }
    }
  }

  return {
    layer: "context",
    status: missing.length === 0 ? "resolved" : "partial",
    resolved,
    missing,
  };
}

function resolveCommunication(
  requirements: Record<string, unknown>[],
  creature: CreatureDef,
  ctx: BootResolverContext,
): ResolvedLayer {
  const resolved: Record<string, unknown> = {};
  const missing: string[] = [];

  for (const req of requirements) {
    for (const [key, value] of Object.entries(req)) {
      switch (key) {
        case "output_format":
        case "output_format_preference":
          resolved.output_format = value;
          break;
        case "evidence_structure":
          resolved.evidence_structure = value;
          break;
        case "recommendation_format":
          resolved.recommendation_format = value;
          break;
        case "progress_reports":
          resolved.progress_reports = value;
          break;
        case "decision_logging":
          resolved.decision_logging = value;
          break;
        case "channel_mode":
          resolved.channel_mode = ctx.channel ?? "telegram";
          break;
        case "user_energy_level":
          resolved.user_energy_level = "normal";
          break;
        case "detail_level_expected":
          resolved.detail_level_expected = "standard";
          break;
        default:
          resolved[key] = value;
      }
    }
  }

  // Always include produces/consumes from creature
  if (creature.produces) resolved.produces = creature.produces;
  if (creature.consumes) resolved.consumes = creature.consumes;

  return {
    layer: "communication",
    status: missing.length === 0 ? "resolved" : "partial",
    resolved,
    missing,
  };
}

// ── Boot packet formatting ───────────────────────────────────────

/**
 * Format a boot resolution as a prompt-injectable string.
 * Returns a markdown block suitable for injection into the agent prompt.
 */
export function formatBootPacket(resolution: BootResolution): string {
  const lines: string[] = [
    `## Boot Packet — ${resolution.creature} (${resolution.agent})`,
    "",
  ];

  for (const layer of resolution.layers) {
    lines.push(`### ${layer.layer.charAt(0).toUpperCase() + layer.layer.slice(1)} [${layer.status}]`);
    for (const [k, v] of Object.entries(layer.resolved)) {
      const display = typeof v === "object" ? JSON.stringify(v) : String(v);
      lines.push(`- **${k}**: ${display}`);
    }
    if (layer.missing.length > 0) {
      lines.push(`- **MISSING**: ${layer.missing.join(", ")}`);
    }
    lines.push("");
  }

  if (!resolution.allResolved) {
    lines.push(`> Warning: ${resolution.summary}`);
  }

  return lines.join("\n");
}

// ── Validation ───────────────────────────────────────────────────

/**
 * Validate that a boot resolution has all required layers resolved.
 * Returns true if dispatch should proceed, false if it should be blocked.
 */
export function canDispatch(resolution: BootResolution): { allowed: boolean; reason?: string } {
  // Identity layer failures are blocking (missing work_item_id when required)
  const identityLayer = resolution.layers.find(l => l.layer === "identity");
  if (identityLayer?.status === "failed") {
    return { allowed: false, reason: `Identity requirements not met: ${identityLayer.missing.join(", ")}` };
  }

  // Other layers are soft — allow dispatch with warnings
  return { allowed: true };
}

// ── Simple YAML parser for creature frontmatter ──────────────────

function parseCreatureYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) { i++; continue; }

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) { i++; continue; }

    const key = trimmed.substring(0, colonIdx).trim();
    const rawValue = trimmed.substring(colonIdx + 1).trim();

    // Inline value
    if (rawValue && !rawValue.startsWith("[") && rawValue !== "") {
      // Check for inline array: [a, b, c]
      if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
        result[key] = rawValue.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      } else {
        result[key] = rawValue.replace(/^["']|["']$/g, "");
      }
      i++;
      continue;
    }

    // Inline array
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      result[key] = rawValue.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      i++;
      continue;
    }

    // Nested block: check next lines for indented items
    const nested: Record<string, unknown>[] = [];
    const nestedObj: Record<string, unknown> = {};
    const listItems: string[] = [];
    let isObj = false;
    let isList = false;
    i++;

    while (i < lines.length) {
      const nextLine = lines[i];
      const nextTrimmed = nextLine.trim();
      if (!nextTrimmed || nextTrimmed.startsWith("#")) { i++; continue; }

      const indent = nextLine.length - nextLine.trimStart().length;
      if (indent <= 0 && nextTrimmed.includes(":") && !nextTrimmed.startsWith("-")) break;

      if (nextTrimmed.startsWith("- ")) {
        isList = true;
        const itemVal = nextTrimmed.substring(2).trim();
        // Check if it's a key: value pair
        const kvMatch = itemVal.match(/^(\w[\w_]*)\s*:\s*(.+)$/);
        if (kvMatch) {
          nested.push({ [kvMatch[1]]: parseValue(kvMatch[2].trim()) });
        } else {
          listItems.push(itemVal.replace(/^["']|["']$/g, ""));
        }
        i++;
        continue;
      }

      // Nested key: value (indented)
      if (nextTrimmed.includes(":")) {
        isObj = true;
        const nColon = nextTrimmed.indexOf(":");
        const nKey = nextTrimmed.substring(0, nColon).trim();
        const nVal = nextTrimmed.substring(nColon + 1).trim();
        if (nVal) {
          nestedObj[nKey] = parseValue(nVal);
        } else {
          // Sub-sub block (e.g., boot_requirements layers)
          const subItems: Record<string, unknown>[] = [];
          i++;
          while (i < lines.length) {
            const subLine = lines[i];
            const subTrimmed = subLine.trim();
            if (!subTrimmed) { i++; continue; }
            const subIndent = subLine.length - subLine.trimStart().length;
            if (subIndent <= indent + 2 && subTrimmed.includes(":") && !subTrimmed.startsWith("-")) break;
            if (subTrimmed.startsWith("- ")) {
              const subVal = subTrimmed.substring(2).trim();
              const subKv = subVal.match(/^(\w[\w_]*)\s*:\s*(.+)$/);
              if (subKv) {
                subItems.push({ [subKv[1]]: parseValue(subKv[2].trim()) });
              } else {
                subItems.push({ [subVal]: true });
              }
            }
            i++;
          }
          nestedObj[nKey] = subItems;
          continue;
        }
        i++;
        continue;
      }

      break;
    }

    if (nested.length > 0) {
      result[key] = nested;
    } else if (isList && listItems.length > 0) {
      result[key] = listItems;
    } else if (isObj) {
      result[key] = nestedObj;
    }
  }

  return result;
}

function parseValue(val: string): unknown {
  if (val === "true") return true;
  if (val === "false") return false;
  if (val === "required") return "required";
  if (val.startsWith("[") && val.endsWith("]")) {
    return val.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  }
  if (!isNaN(Number(val)) && val !== "") return Number(val);
  return val.replace(/^["']|["']$/g, "");
}
