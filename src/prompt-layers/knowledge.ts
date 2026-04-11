/**
 * Layer 3: Knowledge Retrieval
 *
 * Three channels:
 *   A — Skill/reference trigger matching
 *   B — Filtered Forest retrieval (excludes voice summaries)
 *   C — Contextual expansion via semantic edges (stub for Task 7)
 *
 * See spec: docs/superpowers/specs/2026-04-06-layered-prompt-architecture-design.md
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { log } from "../logger.ts";
import type { SkillRegistryEntry, LayeredMode, KnowledgeResult } from "./types.ts";

const logger = log.child("knowledge-layer");

const BASE_DIR = join(import.meta.dir, "../..");
const BRIDGE_KEY = "bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a";
const KNOWLEDGE_BUDGET_BYTES = 4096;

// ── On-demand reference documents ───────────────────────────────────────────
// These load when the conversation topic matches, giving Ellie product knowledge.

const REFERENCE_DOCS: SkillRegistryEntry[] = [
  {
    name: "ecosystem",
    triggers: ["ellie life", "ellie learn", "ellie work", "leos", "ecosystem", "three products", "all three", "life learn work"],
    file: "config/identity/ecosystem.md",
    description: "LEOS ecosystem overview — Life, Learn, Work products",
  },
];

// ── Channel A: Skill trigger matching ─────────────────────────────────────────

/**
 * Pure function — checks if the user message contains any trigger phrases
 * from the skill registry. Returns matching entries. Case-insensitive.
 */
export function matchSkillTriggers(
  message: string,
  registry: SkillRegistryEntry[]
): SkillRegistryEntry[] {
  const lower = message.toLowerCase();
  return registry.filter(entry =>
    entry.triggers.some(trigger => lower.includes(trigger.toLowerCase()))
  );
}

/**
 * Load SKILL.md content from disk for matched entries.
 * Caps at 2 skill docs max.
 */
async function loadSkillDocs(matches: SkillRegistryEntry[]): Promise<string> {
  const capped = matches.slice(0, 2);
  const docs: string[] = [];

  for (const match of capped) {
    try {
      const filePath = join(BASE_DIR, match.file);
      const content = await readFile(filePath, "utf-8");
      docs.push(`### Skill: ${match.name}\n${content.trim()}`);
    } catch (err) {
      logger.warn("Failed to load skill doc", { file: match.file, err });
    }
  }

  return docs.join("\n\n");
}

// ── Channel B: Scope resolution & Forest retrieval ────────────────────────────

/** Personal keywords that indicate Dave is talking about personal life */
const PERSONAL_KEYWORDS = [
  "georgia", "wincy", "wife", "daughter", "family", "home", "personal",
  "dave", "my", "weekend",
];

/**
 * Returns true if the message contains any personal keyword as a whole word.
 */
function hasPersonalKeyword(lower: string): boolean {
  return PERSONAL_KEYWORDS.some(kw => {
    const re = new RegExp(`\\b${kw}\\b`, "i");
    return re.test(lower);
  });
}

/**
 * Pure function — determines the Forest scope_path to search based on mode
 * and message content.
 */
export function buildScopeFromMode(mode: LayeredMode, message: string): string {
  const lower = message.toLowerCase();

  switch (mode) {
    case "personal":
      return "Y";

    case "voice-casual": {
      return hasPersonalKeyword(lower) ? "Y" : "2";
    }

    case "dev-session": {
      // Multi-product queries should search at project root, not drill into one scope
      const productMentions = [
        /ellie.?life|life module/i,
        /ellie.?learn|learn module/i,
        /ellie.?work|work module/i,
      ].filter(p => p.test(message)).length;
      if (productMentions >= 2 || /\bleos\b|ecosystem|all three/i.test(lower)) {
        return "2";
      }

      if (lower.includes("forest") || lower.includes("tree") || lower.includes("branch")) {
        return "2/2";
      }
      if (lower.includes("relay") || lower.includes("ellie-dev") || lower.includes("chat relay")) {
        return "2/1";
      }
      if (lower.includes("dashboard") || lower.includes("ellie-home") || lower.includes("nuxt")) {
        return "2/3";
      }
      if (/ellie.?life|life module/i.test(message)) {
        return "2/5";
      }
      if (/ellie.?learn|learn module/i.test(message)) {
        return "2/6";
      }
      if (/ellie.?work|work module/i.test(message)) {
        return "2/7";
      }
      return "2/1";
    }

    case "planning":
      return "2";

    case "heartbeat":
      return "2";
  }
}

/**
 * Voice summary filter — matches content that should be excluded from
 * Forest retrieval results.
 */
export const VOICE_SUMMARY_FILTER =
  /^(?:Voice call \(\d+ exchanges?\)|Conversation summary:)/i;

interface BridgeMemory {
  content: string;
  type: string;
  scope_path: string;
}

interface BridgeResponse {
  memories: BridgeMemory[];
}

/**
 * Fetch memories from the Forest Bridge API and filter out voice summaries.
 */
async function fetchForestKnowledge(
  message: string,
  scopePath: string
): Promise<string> {
  try {
    const res = await fetch("http://localhost:3001/api/bridge/read", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-key": BRIDGE_KEY,
      },
      body: JSON.stringify({
        query: message,
        scope_path: scopePath,
        match_count: 10,
        match_threshold: 0.4,
      }),
    });

    if (!res.ok) {
      logger.warn("Forest bridge read failed", { status: res.status });
      return "";
    }

    const data = (await res.json()) as BridgeResponse;
    const memories = (data.memories ?? []).filter(
      m => !VOICE_SUMMARY_FILTER.test(m.content) && m.type !== "summary"
    );

    if (memories.length === 0) return "";

    const lines = memories.map(
      m => `- [${m.type}, ${m.scope_path}] ${m.content}`
    );
    return `## KNOWLEDGE\n${lines.join("\n")}`;
  } catch (err) {
    logger.warn("Forest bridge fetch error", { err });
    return "";
  }
}

/**
 * Cross-scope river-ingest retrieval.
 *
 * `/api/bridge/read` already does descendant-scope matching when given an
 * ancestor `scope_path`, so a single read against `2/river-ingest` returns
 * memories from every `2/river-ingest/{folder}` sub-scope. We don't need to
 * enumerate child scopes — the parent query handles it.
 *
 * The header is rewritten to "## KNOWLEDGE (river-ingest)" so the merge
 * downstream can distinguish it from the scope-targeted forest result.
 */
async function fetchRiverIngestKnowledge(message: string): Promise<string> {
  const result = await fetchForestKnowledge(message, "2/river-ingest");
  if (!result || result.trim().length === 0) return "";
  return result.replace(/^##\s+KNOWLEDGE\b/i, "## KNOWLEDGE (river-ingest)");
}

// ── Channel C: Contextual expansion (stub) ────────────────────────────────────

/**
 * Stub — will call getRelatedKnowledge and getGroveKnowledgeContext
 * from context-sources.ts in Task 7.
 */
async function fetchContextualExpansion(
  _message: string,
  _agent?: string
): Promise<string> {
  return "";
}

// ── Orchestration ─────────────────────────────────────────────────────────────

/**
 * Orchestrates all 3 knowledge channels.
 * Returns empty result for heartbeat mode (no retrieval needed).
 */
export async function retrieveKnowledge(
  message: string | null,
  mode: LayeredMode,
  agent?: string
): Promise<KnowledgeResult> {
  // Heartbeat: no knowledge retrieval
  if (mode === "heartbeat") {
    return { skillDocs: "", forestKnowledge: "", expansion: "" };
  }

  // Null / empty message: no retrieval
  if (!message || message.trim() === "") {
    return { skillDocs: "", forestKnowledge: "", expansion: "" };
  }

  const scopePath = buildScopeFromMode(mode, message);

  // Load skill registry lazily to avoid circular imports
  const { loadSkillRegistry } = await import("./identity.ts");

  const [registry, forestKnowledge, expansion, riverIngestKnowledge] = await Promise.all([
    loadSkillRegistry(),
    fetchForestKnowledge(message, scopePath),
    fetchContextualExpansion(message, agent),
    // After the heartbeat early-return, we ALWAYS try the river-ingest fan-out.
    // (LayeredMode has no "surface" literal in this codebase; heartbeat is the only
    // special case and is already handled above.)
    fetchRiverIngestKnowledge(message),
  ]);

  // Channel A: match triggers and load docs (skills + reference docs)
  const skillMatches = matchSkillTriggers(message, registry);
  const refMatches = matchSkillTriggers(message, REFERENCE_DOCS);
  const allMatches = [...skillMatches, ...refMatches];
  const skillDocs = await loadSkillDocs(allMatches);

  // Merge the two forest knowledge strings (scope-targeted + cross-scope river-ingest)
  const mergedForest = [forestKnowledge, riverIngestKnowledge]
    .filter((s) => s && s.trim().length > 0)
    .join("\n\n");

  return { skillDocs, forestKnowledge: mergedForest, expansion };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

/**
 * Renders the knowledge result into a single string under a 4KB budget.
 * Trimming priority: expansion first, then forestKnowledge, skills are kept.
 *
 * Pure function — no I/O.
 */
export function renderKnowledge(result: KnowledgeResult): string {
  const { skillDocs, forestKnowledge, expansion } = result;

  if (!skillDocs && !forestKnowledge && !expansion) return "";

  const encoder = new TextEncoder();

  // Build sections array in priority order (skills > forest > expansion)
  let skillPart = skillDocs.trim();
  let forestPart = forestKnowledge.trim();
  let expansionPart = expansion.trim();

  // Calculate sizes
  const combined = () =>
    [skillPart, forestPart, expansionPart].filter(Boolean).join("\n\n");

  // Trim expansion first if over budget
  if (encoder.encode(combined()).length > KNOWLEDGE_BUDGET_BYTES) {
    expansionPart = "";
  }

  // Trim forest next if still over budget
  if (encoder.encode(combined()).length > KNOWLEDGE_BUDGET_BYTES) {
    // Truncate forest to fit remaining budget
    const skillBytes = encoder.encode(skillPart).length;
    const remaining = KNOWLEDGE_BUDGET_BYTES - skillBytes - 10; // small buffer
    if (remaining > 0 && forestPart) {
      const forestBytes = encoder.encode(forestPart);
      if (forestBytes.length > remaining) {
        const decoder = new TextDecoder();
        forestPart = decoder.decode(forestBytes.slice(0, remaining)) + "…";
      }
    } else {
      forestPart = "";
    }
  }

  const parts = [skillPart, forestPart, expansionPart].filter(Boolean);
  return parts.join("\n\n");
}
