/**
 * Prompt Builder + Personality Context
 *
 * Extracted from relay.ts — ELLIE-184.
 * Contains: buildPrompt, personality context loaders (archetype/psy/phase/health),
 * runPostMessageAssessment, planning mode state.
 */

import { readFile, readdir } from "fs/promises";
import { watch, type FSWatcher } from "fs";
import { log } from "./logger.ts";
import { parseCreatureProfile, setCreatureProfile, getCreatureProfile, validateSectionLabels } from "./creature-profile.ts";

const logger = log.child("prompt-builder");
import { join, dirname } from "path";
import type Anthropic from "@anthropic-ai/sdk";
import { isOutlookConfigured, getOutlookEmail } from "./outlook.ts";
import { isPlaneConfigured } from "./plane.ts";
import {
  trimSearchContext,
  applyTokenBudget,
  estimateTokens,
  mapHealthToMemoryCategory,
  type PromptSection,
} from "./relay-utils.ts";
import { getLastResolvedStrategy, getStrategyExcludedSections, getStrategyTokenBudget, getStrategySectionPriorities } from "./context-sources.ts";
import type { ContextMode } from "./context-mode.ts";
import { getModeSectionPriorities, getModeTokenBudget } from "./context-mode.ts";
import { freshnessTracker, buildStalenessWarning } from "./context-freshness.ts";
import type { ChannelContextProfile } from "./api/mode-profile.ts";
import { buildSourceHierarchyInstruction } from "./source-hierarchy.ts";
import { getActiveRunStates } from "./orchestration-tracker.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

// ── ELLIE-383: Build metrics (last prompt's section breakdown) ──

export interface BuildMetrics {
  sections: Array<{ label: string; tokens: number; priority: number }>;
  totalTokens: number;
  sectionCount: number;
  budget: number;
  mode?: string;
  creature?: string;
  /** ELLIE-534: River doc cache hits/misses during this buildPrompt call. */
  riverCacheHits: number;
  riverCacheMisses: number;
}

// ── ELLIE-534: River doc performance metrics ─────────────────

export interface RiverDocFetchResult {
  durationMs: number;
  status: "loaded" | "failed";
  errorMessage?: string;
}

export interface RiverDocMetrics {
  /** Timing data from the most recent _refreshRiverDocs() call, or null if none yet. */
  lastRefresh: {
    startedAt: number;
    durationMs: number;
    loaded: number;
    failed: number;
    docs: Record<string, RiverDocFetchResult>;
  } | null;
  /** Cumulative cache access counts since last reset. */
  cacheHits: number;
  cacheMisses: number;
  /** Stale content returned (TTL expired) — background refresh was triggered. */
  staleHits: number;
}

let _riverDocMetrics: RiverDocMetrics = {
  lastRefresh: null,
  cacheHits: 0,
  cacheMisses: 0,
  staleHits: 0,
};

/** Get River doc cache and refresh performance metrics (ELLIE-534). */
export function getRiverDocMetrics(): RiverDocMetrics {
  return { ..._riverDocMetrics, lastRefresh: _riverDocMetrics.lastRefresh ? { ..._riverDocMetrics.lastRefresh, docs: { ..._riverDocMetrics.lastRefresh.docs } } : null };
}

/** Reset River doc metrics and release any in-flight lock — for unit tests only. */
export function _resetRiverMetricsForTesting(): void {
  _riverDocMetrics = { lastRefresh: null, cacheHits: 0, cacheMisses: 0, staleHits: 0 };
  _riverRefreshInFlight = false;
}

let _lastBuildMetrics: BuildMetrics | null = null;

/** Get metrics from the most recent buildPrompt call. */
export function getLastBuildMetrics(): BuildMetrics | null { return _lastBuildMetrics; }

// ── Planning mode state ─────────────────────────────────────

let planningMode = false;
export function getPlanningMode(): boolean { return planningMode; }
export function setPlanningMode(v: boolean): void { planningMode = v; }

// ── Agent mode config ───────────────────────────────────────

const AGENT_MODE = process.env.AGENT_MODE !== "false";

// ── User identity ───────────────────────────────────────────

export const USER_NAME = process.env.USER_NAME || "";
import { USER_TIMEZONE } from "./timezone.ts";

// ── Soul context (hot-reloaded on file change — ELLIE-244) ──

const SOUL_PATH = join(PROJECT_ROOT, "config", "soul.md");
const PROFILE_PATH = join(PROJECT_ROOT, "config", "profile.md");

let soulContext = "";
try {
  soulContext = await readFile(SOUL_PATH, "utf-8");
} catch {
  // No soul file yet — that's fine
}

// ── Profile context (hot-reloaded on file change — ELLIE-244) ──

let profileContext = "";
try {
  profileContext = await readFile(PROFILE_PATH, "utf-8");
} catch {
  // No profile yet — that's fine
}

// ── File watchers for personality files (ELLIE-244) ─────────

const RELOAD_DEBOUNCE_MS = 500;
let soulReloadTimer: ReturnType<typeof setTimeout> | null = null;
let profileReloadTimer: ReturnType<typeof setTimeout> | null = null;
const personalityWatchers: FSWatcher[] = [];

function watchPersonalityFiles(): void {
  // Watch soul.md
  try {
    const w = watch(SOUL_PATH, (_event) => {
      if (soulReloadTimer) clearTimeout(soulReloadTimer);
      soulReloadTimer = setTimeout(async () => {
        try {
          soulContext = await readFile(SOUL_PATH, "utf-8");
          logger.info("Reloaded soul.md");
        } catch {
          soulContext = "";
          logger.info("soul.md removed or unreadable — cleared");
        }
        soulReloadTimer = null;
      }, RELOAD_DEBOUNCE_MS);
    });
    personalityWatchers.push(w);
  } catch {
    // File doesn't exist yet — that's fine
  }

  // Watch profile.md
  try {
    const w = watch(PROFILE_PATH, (_event) => {
      if (profileReloadTimer) clearTimeout(profileReloadTimer);
      profileReloadTimer = setTimeout(async () => {
        try {
          profileContext = await readFile(PROFILE_PATH, "utf-8");
          logger.info("Reloaded config/profile.md");
        } catch {
          profileContext = "";
          logger.info("config/profile.md removed or unreadable — cleared");
        }
        profileReloadTimer = null;
      }, RELOAD_DEBOUNCE_MS);
    });
    personalityWatchers.push(w);
  } catch {
    // File doesn't exist yet — that's fine
  }

  if (personalityWatchers.length > 0) {
    console.log(`[prompt-builder] Watching ${personalityWatchers.length} personality files for changes`);
  }
}

/** Stop personality file watchers. Call on shutdown. */
export function stopPersonalityWatchers(): void {
  for (const w of personalityWatchers) w.close();
  personalityWatchers.length = 0;
}

/** Force-clear all personality caches (soul, profile, archetype, psy, phase, health, River docs). */
export function clearPersonalityCache(): void {
  _archetypeLastLoaded = 0;
  _psyLastLoaded = 0;
  _phaseLastLoaded = 0;
  _healthLastLoaded = 0;
  _riverDocs.clear();
  logger.info("All personality + River doc caches invalidated");
}

// Start watchers immediately
watchPersonalityFiles();

// ── River-backed protocol docs (ELLIE-150, ELLIE-532) ───────
// Pre-loaded at startup, stale-while-revalidate on configurable TTL.
// buildPrompt reads synchronously; falls back to hardcoded strings if QMD unavailable.
// ELLIE-532: Added soul, configurable TTL, frontmatter priority, and test helpers.

interface RiverDocEntry {
  content: string;
  loadedAt: number;
  frontmatter?: Record<string, unknown>;
}

const _riverDocs = new Map<string, RiverDocEntry>();
/** Default TTL — overridable via setRiverDocCacheTtl(). */
let _riverDocCacheTtlMs = 60_000;
let _riverRefreshInFlight = false;

/** Maps prompt section keys to River vault paths. */
const RIVER_DOC_PATHS: Record<string, string> = {
  "soul": "soul/soul.md",
  "memory-protocol": "prompts/protocols/memory-management.md",
  "confirm-protocol": "prompts/protocols/action-confirmations.md",
  "dev-agent-template": "templates/dev-agent-base.md",
  // ELLIE-535: remaining specialist agents
  "research-agent-template": "templates/research-agent-base.md",
  "strategy-agent-template": "templates/strategy-agent-base.md",
  // ELLIE-536: remaining hardcoded protocols
  "forest-writes": "prompts/protocols/forest-writes.md",
  "playbook-commands": "prompts/protocols/playbook-commands.md",
  "work-commands": "prompts/protocols/work-commands.md",
  "planning-mode": "prompts/protocols/planning-mode.md",
};

/**
 * Synchronous read from River doc cache.
 * Returns cached body content or null on miss.
 * Triggers background refresh when TTL has expired (stale-while-revalidate).
 * ELLIE-534: Increments cacheHits / cacheMisses / staleHits metrics.
 */
export function getCachedRiverDoc(key: string): string | null {
  const entry = _riverDocs.get(key);
  if (!entry) {
    _riverDocMetrics.cacheMisses++;
    return null;
  }
  // Use >= so TTL=0 always triggers a stale-while-revalidate (no grace period)
  if (Date.now() - entry.loadedAt >= _riverDocCacheTtlMs && !_riverRefreshInFlight) {
    _riverDocMetrics.staleHits++;
    _refreshRiverDocs().catch(() => {});
  } else {
    _riverDocMetrics.cacheHits++;
  }
  return entry.content;
}

/**
 * Return the section_priority from a River doc's frontmatter, or defaultPriority if absent.
 * Frontmatter key checked: "section_priority".
 */
function getRiverDocPriority(key: string, defaultPriority: number): number {
  const entry = _riverDocs.get(key);
  const p = entry?.frontmatter?.["section_priority"];
  if (typeof p === "number" && p >= 1 && p <= 9) return p;
  return defaultPriority;
}

/** Refresh all registered River docs from QMD. Non-fatal. ELLIE-534: tracks per-doc timing. */
async function _refreshRiverDocs(): Promise<void> {
  if (_riverRefreshInFlight) return;
  _riverRefreshInFlight = true;
  const refreshStart = Date.now();
  const docResults: Record<string, RiverDocFetchResult> = {};
  let loaded = 0;
  let failed = 0;
  try {
    const { getRiverDoc, parseFrontmatter } = await import("./api/bridge-river.ts");
    await Promise.allSettled(
      Object.entries(RIVER_DOC_PATHS).map(async ([key, path]) => {
        const docStart = Date.now();
        try {
          const raw = await getRiverDoc(path);
          const durationMs = Date.now() - docStart;
          if (raw) {
            const { frontmatter, body } = parseFrontmatter(raw);
            _riverDocs.set(key, { content: body || raw, loadedAt: Date.now(), frontmatter });
            logger.debug(`River doc loaded: ${key}`);
            docResults[key] = { durationMs, status: "loaded" };
            loaded++;
          } else {
            docResults[key] = { durationMs, status: "failed", errorMessage: "empty response" };
            failed++;
          }
        } catch (err) {
          docResults[key] = {
            durationMs: Date.now() - docStart,
            status: "failed",
            errorMessage: err instanceof Error ? err.message : String(err),
          };
          failed++;
        }
      }),
    );
    logger.info(`River docs refreshed: ${loaded}/${Object.keys(RIVER_DOC_PATHS).length}`);
  } catch {
    // QMD unavailable — buildPrompt uses hardcoded fallbacks
  } finally {
    _riverRefreshInFlight = false;
    _riverDocMetrics.lastRefresh = {
      startedAt: refreshStart,
      durationMs: Date.now() - refreshStart,
      loaded,
      failed,
      docs: docResults,
    };
  }
}

// Initial load (non-blocking — first requests use fallbacks until cache warms)
_refreshRiverDocs().catch(() => {});

/** Set the River doc cache TTL. Use in tests to control expiry behaviour. */
export function setRiverDocCacheTtl(ms: number): void {
  _riverDocCacheTtlMs = ms;
}

/** Force-clear River doc cache. */
export function clearRiverDocCache(): void {
  _riverDocs.clear();
  logger.info("River doc cache cleared");
}

/**
 * Trigger a River doc refresh explicitly.
 * Returns when all registered docs have been fetched (or failed non-fatally).
 */
export async function refreshRiverDocs(): Promise<void> {
  return _refreshRiverDocs();
}

/**
 * Inject a River doc directly into the cache — for unit tests only.
 * Avoids needing to mock bridge-river.ts or run QMD in tests.
 */
export function _injectRiverDocForTesting(
  key: string,
  content: string,
  frontmatter?: Record<string, unknown>,
): void {
  _riverDocs.set(key, { content, loadedAt: Date.now(), frontmatter });
}

// ── Personality context loaders (60s TTL each) ──────────────

let _archetypeContext = "";
let _archetypeLastLoaded = 0;
const ARCHETYPE_CACHE_MS = 60_000;

export async function getArchetypeContext(): Promise<string> {
  const now = Date.now();
  if (_archetypeContext && now - _archetypeLastLoaded < ARCHETYPE_CACHE_MS) return _archetypeContext;
  try {
    const { getChainOwnerArchetype } = await import('../../ellie-forest/src/people');
    const { buildArchetypePrompt } = await import('../../ellie-forest/src/archetypes');
    const prefs = await getChainOwnerArchetype();
    _archetypeContext = buildArchetypePrompt(
      prefs.archetype as import('../../ellie-forest/src/archetypes').ArchetypeId,
      prefs.flavor as import('../../ellie-forest/src/archetypes').FlavorId,
    );
    _archetypeLastLoaded = now;
  } catch {
    // No archetype set yet — soul alone is enough
  }
  return _archetypeContext;
}

// ── Per-agent archetype loader ───────────────────────────────
// ELLIE-413-416: Forest-backed profiles are tried first for mapped agents.
// Falls back to config/archetypes/{name}.md, then to the Forest chain-owner.

const _agentArchetypeCache: Map<string, { content: string; loadedAt: number }> = new Map();
const AGENT_ARCHETYPE_CACHE_MS = 60_000;
const ARCHETYPES_DIR = join(PROJECT_ROOT, "config", "archetypes");

/** Maps short agent names to their Forest profile names. */
const AGENT_PROFILE_MAP: Record<string, string> = {
  general: "general-squirrel",
  dev: "dev-ant",
  research: "research-squirrel",
  strategy: "strategy-squirrel",
};

/**
 * Load a creature-specific archetype.
 * Priority: Forest profile (creature+role layers) → file-based → Forest chain-owner.
 */
export async function getAgentArchetype(agentName?: string): Promise<string> {
  if (!agentName) return getArchetypeContext();

  const normalized = agentName.toLowerCase().replace(/[^a-z0-9-]/g, "");
  const cached = _agentArchetypeCache.get(normalized);
  if (cached && Date.now() - cached.loadedAt < AGENT_ARCHETYPE_CACHE_MS) return cached.content;

  // ELLIE-413-416: Try Forest-backed profile (creature + role layers)
  const forestProfileName = AGENT_PROFILE_MAP[normalized];
  if (forestProfileName) {
    try {
      const { buildCreatureRoleContent } = await import("./agent-profile-builder.ts");
      const built = await buildCreatureRoleContent(forestProfileName);
      if (built) {
        setCreatureProfile(normalized, {
          section_priorities: built.wiring.section_priorities,
          token_budget: built.wiring.token_budget,
          allowed_skills: built.wiring.skills,
        });
        _agentArchetypeCache.set(normalized, { content: built.content, loadedAt: Date.now() });
        logger.info(`Archetype ${normalized}: loaded from Forest (${built.layersLoaded.join(", ")})`);
        return built.content;
      }
    } catch (err) {
      logger.warn(`Archetype ${normalized}: Forest profile load failed, falling back to file`, err instanceof Error ? err.message : err);
    }
  }

  // Fall back to file-based archetype
  try {
    const filePath = join(ARCHETYPES_DIR, `${normalized}.md`);
    const raw = await readFile(filePath, "utf-8");
    // ELLIE-367: Parse creature profile from frontmatter, cache body without frontmatter
    const { profile, body } = parseCreatureProfile(raw);
    if (profile) {
      const badLabels = validateSectionLabels(profile);
      if (badLabels.length > 0) {
        logger.warn(`Archetype ${normalized}: unknown section_priorities labels (typos?): ${badLabels.join(", ")}`);
      }
      setCreatureProfile(normalized, profile);
    } else {
      // ELLIE-374: Warn when frontmatter parse yields no profile
      logger.warn(`Archetype ${normalized}: no creature profile parsed from frontmatter (missing section_priorities?)`);
    }
    _agentArchetypeCache.set(normalized, { content: body, loadedAt: Date.now() });
    return body;
  } catch (err: unknown) {
    // ELLIE-374: Log fallback so it's visible, not silent
    logger.warn(`Archetype ${normalized}: file load failed, falling back to Forest chain-owner`, err instanceof Error ? err.message : err);
    return getArchetypeContext();
  }
}

/**
 * ELLIE-374: Validate all archetype files on startup.
 * Logs warnings for missing files, parse failures, or missing profile keys.
 */
export async function validateArchetypes(): Promise<{ valid: number; warnings: string[] }> {
  const warnings: string[] = [];
  let valid = 0;
  try {
    const files = await readdir(ARCHETYPES_DIR);
    const archetypes = files.filter(f => f.endsWith(".md"));
    if (archetypes.length === 0) {
      warnings.push("No archetype files found in config/archetypes/");
      logger.warn("ELLIE-374: No archetype files found", { dir: ARCHETYPES_DIR });
      return { valid: 0, warnings };
    }
    for (const file of archetypes) {
      const name = file.replace(".md", "");
      try {
        const raw = await readFile(join(ARCHETYPES_DIR, file), "utf-8");
        const { profile } = parseCreatureProfile(raw);
        if (!profile) {
          warnings.push(`${name}: no creature profile (missing section_priorities)`);
        } else {
          if (!profile.token_budget) warnings.push(`${name}: no token_budget in frontmatter`);
          if (!profile.allowed_skills?.length) warnings.push(`${name}: no allowed_skills in frontmatter`);
          const badLabels = validateSectionLabels(profile);
          if (badLabels.length > 0) warnings.push(`${name}: unknown section_priorities labels: ${badLabels.join(", ")}`);
          valid++;
        }
      } catch (err: unknown) {
        warnings.push(`${name}: failed to read — ${err instanceof Error ? err.message : err}`);
      }
    }
    if (warnings.length > 0) {
      logger.warn(`ELLIE-374: Archetype validation: ${valid} valid, ${warnings.length} warning(s)`, { warnings });
    } else {
      logger.info(`ELLIE-374: All ${valid} archetypes validated successfully`);
    }
  } catch (err: unknown) {
    warnings.push(`Cannot read archetypes directory: ${err instanceof Error ? err.message : err}`);
    logger.error("ELLIE-374: Archetype validation failed", err);
  }
  return { valid, warnings };
}

let _psyContext = "";
let _psyLastLoaded = 0;
const PSY_CACHE_MS = 60_000;

export async function getPsyContext(): Promise<string> {
  const now = Date.now();
  if (_psyContext && now - _psyLastLoaded < PSY_CACHE_MS) return _psyContext;
  try {
    const { getChainOwnerPsy, getChainOwnerCalibration } = await import('../../ellie-forest/src/people');
    const { buildPsyPrompt } = await import('../../ellie-forest/src/psy');
    const [psy, calibrationLevel] = await Promise.all([
      getChainOwnerPsy(),
      getChainOwnerCalibration(),
    ]);
    _psyContext = buildPsyPrompt(psy, { calibrationLevel });
    _psyLastLoaded = now;
  } catch {
    // No psy profile yet — archetype alone is enough
  }
  return _psyContext;
}

let _phaseContext = "";
let _phaseLastLoaded = 0;
const PHASE_CACHE_MS = 60_000;

export async function getPhaseContext(): Promise<string> {
  const now = Date.now();
  if (_phaseContext && now - _phaseLastLoaded < PHASE_CACHE_MS) return _phaseContext;
  try {
    const { getChainOwnerPhase } = await import('../../ellie-forest/src/people');
    const { buildPhasePrompt } = await import('../../ellie-forest/src/phases');
    const phase = await getChainOwnerPhase();
    _phaseContext = buildPhasePrompt(phase);
    _phaseLastLoaded = now;
  } catch {
    // No phase data yet — psy alone is enough
  }
  return _phaseContext;
}

let _healthContext = "";
let _healthLastLoaded = 0;
const HEALTH_CACHE_MS = 60_000;

export async function getHealthContext(): Promise<string> {
  const now = Date.now();
  if (_healthContext && now - _healthLastLoaded < HEALTH_CACHE_MS) return _healthContext;
  try {
    const { getChainOwnerHealth } = await import('../../ellie-forest/src/people');
    const { buildHealthPrompt } = await import('../../ellie-forest/src/health');
    const health = await getChainOwnerHealth();
    _healthContext = buildHealthPrompt(health);
    _healthLastLoaded = now;
  } catch {
    // No health profile yet — other context is enough
  }
  return _healthContext;
}

// ── Post-message psy assessment (ELLIE-164) ─────────────────

export async function runPostMessageAssessment(
  userMessage: string,
  assistantResponse: string,
  anthropic: Anthropic | null,
): Promise<void> {
  const start = Date.now();
  try {
    const { getChainOwnerPsy, updateChainOwnerPsy,
            getChainOwnerPhase, updateChainOwnerPhase,
            getChainOwnerHealth, updateChainOwnerHealth } = await import('../../ellie-forest/src/people');
    const { buildAssessmentPrompt, parseAssessmentResult,
            applyAssessment } = await import('../../ellie-forest/src/assessment');

    const [psy, phase, health] = await Promise.all([
      getChainOwnerPsy(),
      getChainOwnerPhase(),
      getChainOwnerHealth(),
    ]);

    // ── Rule-based assessment ────────────────────────────────
    const now = new Date().toISOString();
    const lastInteraction = phase.last_interaction_at;
    const gapMs = lastInteraction
      ? Date.now() - new Date(lastInteraction).getTime()
      : Infinity;
    const FOUR_HOURS = 4 * 60 * 60 * 1000;
    const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;

    const ruleResult = {
      message_count_increment: 2,
      is_new_conversation: gapMs > FOUR_HOURS,
      is_return_after_absence: gapMs > THREE_DAYS,
      is_initiated_contact: gapMs > FOUR_HOURS,
      timestamp: now,
    };

    // ── Claude haiku assessment ──────────────────────────────
    let claudeResult = null;
    if (anthropic) {
      try {
        const prompt = buildAssessmentPrompt(userMessage, assistantResponse);
        const response = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 800,
          messages: [{ role: "user", content: prompt }],
        });
        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
        claudeResult = parseAssessmentResult(text);
        if (!claudeResult) {
          logger.warn("Failed to parse haiku response", { response: text.substring(0, 200) });
        }
      } catch (err: unknown) {
        logger.error("Haiku call failed", err);
      }
    }

    // ── Apply + persist ──────────────────────────────────────
    const { psy: newPsy, phase: newPhase, health: newHealth } = applyAssessment(psy, phase, health, claudeResult, ruleResult);

    await Promise.all([
      updateChainOwnerPsy(newPsy),
      updateChainOwnerPhase(newPhase),
      updateChainOwnerHealth(newHealth),
    ]);

    // Invalidate cached contexts — next message picks up new profiles
    _psyLastLoaded = 0;
    _phaseLastLoaded = 0;
    _healthLastLoaded = 0;

    // Write health observations to shared_memories for searchability
    if (claudeResult?.health?.length) {
      try {
        const { writeMemory } = await import('../../ellie-forest/src/shared-memory');
        for (const signal of claudeResult.health) {
          await writeMemory({
            content: `[health:${signal.category}] ${signal.summary}`,
            type: 'fact',
            scope: 'global',
            confidence: 0.6,
            tags: ['health', signal.category],
            metadata: { source: 'health_assessment', is_goal: signal.is_goal },
            cognitive_type: 'factual',
            category: mapHealthToMemoryCategory(signal.category),
          });
        }
      } catch (memErr: unknown) {
        logger.warn("Health memory write failed", memErr);
      }
    }

    // Write classified memories from perception layer
    if (claudeResult?.memories?.length) {
      try {
        const { writeMemory } = await import('../../ellie-forest/src/shared-memory');
        for (const mem of claudeResult.memories) {
          await writeMemory({
            content: mem.content,
            type: mem.cognitive_type === 'factual' ? 'fact' : 'finding',
            scope: 'global',
            confidence: mem.importance,
            tags: ['perception', mem.cognitive_type, mem.category],
            metadata: { source: 'perception_layer' },
            cognitive_type: mem.cognitive_type as import('../../ellie-forest/src/types').CognitiveType,
            category: mem.category as import('../../ellie-forest/src/types').MemoryCategory,
            emotional_valence: mem.emotional_valence ?? undefined,
            emotional_intensity: mem.emotional_intensity ?? undefined,
            duration: mem.duration as import('../../ellie-forest/src/types').MemoryDuration,
          });
        }
      } catch (memErr: unknown) {
        logger.warn("Memory perception write failed", memErr);
      }
    }

    if (newPhase.phase !== phase.phase) {
      console.log(`[assessment] Phase transition: ${phase.phase_name} -> ${newPhase.phase_name}`);
    }

    console.log(`[assessment] Completed in ${Date.now() - start}ms` +
      (claudeResult ? ` (mbti:${claudeResult.mbti.length} enn:${claudeResult.enneagram.length} health:${claudeResult.health.length} mem:${claudeResult.memories.length})` : " (rules only)"));
  } catch (err: unknown) {
    logger.error("Assessment failed", err);
  }
}

// ── buildPrompt ─────────────────────────────────────────────

export function buildPrompt(
  userMessage: string,
  contextDocket?: string,
  relevantContext?: string,
  elasticContext?: string,
  channel: string = "telegram",
  agentConfig?: { system_prompt?: string | null; name?: string; tools_enabled?: string[] },
  workItemContext?: string,
  structuredContext?: string,
  recentMessages?: string,
  skillContext?: { name: string; description: string },
  forestContext?: string,
  agentMemoryContext?: string,
  sessionIds?: { tree_id: string; branch_id?: string; creature_id?: string; entity_id?: string; work_item_id?: string },
  archetypeContext?: string,
  psyContext?: string,
  phaseContext?: string,
  healthContext?: string,
  queueContext?: string,
  incidentContext?: string,
  awarenessContext?: string,
  skillsPrompt?: string,
  contextMode?: ContextMode,
  refreshedSources?: string[],
  channelProfile?: ChannelContextProfile | null,
  groundTruthConflicts?: string,
  crossChannelCorrections?: string,
  commandBarContext?: string,
): string {
  const channelLabel = channel === "google-chat" ? "Google Chat" : channel === "ellie-chat" ? "Ellie Chat (dashboard)" : "Telegram";

  // ELLIE-534: Snapshot River cache counters at build start to compute per-build delta
  const _riverHitsAtStart = _riverDocMetrics.cacheHits;
  const _riverMissesAtStart = _riverDocMetrics.cacheMisses;

  // ── Assemble prompt as prioritized sections (ELLIE-185) ──
  // Priority: 1 = never trim, 2 = essential, 3 = important, 4-6 = context, 7-9 = trim first
  const sections: PromptSection[] = [];

  // ELLIE-525: Only primary Ellie (general agent) loads soul.md.
  // Downstream agents (dev, critic, research, finance, strategy, ops) are tools,
  // not user-facing personalities — they don't need warmth or identity instructions.
  const isGeneralAgent = !agentConfig?.name || agentConfig.name === "general";

  // Priority 1: User message (never trimmed)
  sections.push({ label: "user-message", content: `\nUser: ${userMessage}`, priority: 1 });

  // Priority 2: Soul + personality (small, defines who Ellie is)
  // ELLIE-525: Soul only for primary Ellie — saves ~2,500 tokens per downstream agent call.
  // ELLIE-532: Prefer River soul doc when cached; fall back to config/soul.md.
  if (isGeneralAgent) {
    const riverSoul = getCachedRiverDoc("soul");
    const effectiveSoul = riverSoul || soulContext;
    if (effectiveSoul) sections.push({ label: "soul", content: `# Ellie Soul\n${effectiveSoul}\n---\n`, priority: 2 });
  }
  if (archetypeContext) sections.push({ label: "archetype", content: `# Behavioral Archetype\n${archetypeContext}\n---\n`, priority: 2 });
  if (psyContext) sections.push({ label: "psy", content: `# Psychological Profile\n${psyContext}\n---\n`, priority: 2 });
  if (phaseContext) sections.push({ label: "phase", content: `# Relationship Phase\n${phaseContext}\n---\n`, priority: 2 });
  if (healthContext) sections.push({ label: "health", content: `# Health & Life Context\n${healthContext}\n---\n`, priority: 3 });

  // Command bar context (ELLIE-400) — priority configurable per channel, default 2
  if (commandBarContext) sections.push({ label: "command-bar-context", content: commandBarContext, priority: channelProfile?.contextPriority ?? 2 });

  // Priority 2: Base system prompt
  const basePrompt = agentConfig?.system_prompt
    ? `${agentConfig.system_prompt}\nYou are responding via ${channelLabel}. Keep responses concise and conversational.`
    : `You are a personal AI assistant responding via ${channelLabel}. Keep responses concise and conversational.`;
  sections.push({ label: "base-prompt", content: basePrompt, priority: 2 });

  // Priority 2: Skill context
  if (skillContext) {
    sections.push({ label: "skill", content:
      `\nACTIVE SKILL: ${skillContext.name}` +
      `\nTask: ${skillContext.description}` +
      `\nFocus your response on this specific capability. Use the appropriate tools to fulfill this request.`,
    priority: 2 });
  }

  // Priority 2: Tool capabilities
  if (AGENT_MODE) {
    const toolHeader = agentConfig?.tools_enabled?.length
      ? `You have access to these tools: ${agentConfig.tools_enabled.join(", ")}.`
      : "You have full tool access: Read, Edit, Write, Bash, Glob, Grep, WebSearch, WebFetch.";

    const mcpDetails =
      "You also have MCP tools:\n" +
      "- Google Workspace (user_google_email: zerocool0133700@gmail.com):\n" +
      "  Gmail: search_gmail_messages, get_gmail_message_content, send_gmail_message (send requires [CONFIRM])\n" +
      "  Calendar: get_events, create_event (create/modify requires [CONFIRM])\n" +
      "  Tasks: list_tasks, create_task, update_task, get_task\n" +
      "  Also: Drive, Docs, Sheets, Forms, Contacts\n" +
      "  Your system context already includes an unread email signal and pending Google Tasks.\n" +
      "  Use Gmail MCP tools to read full email content, reply to threads, or draft messages.\n" +
      "- GitHub, Memory, Sequential Thinking\n" +
      "- Plane (project management — workspace: evelife at plane.ellie-labs.dev)\n" +
      "- Brave Search (mcp__brave-search__brave_web_search, mcp__brave-search__brave_local_search)\n" +
      "- Miro (diagrams, docs, tables), Excalidraw (drawings, diagrams)\n" +
      "- Forest Bridge (mcp__forest-bridge__forest_read, forest_write, forest_list, forest_scopes):\n" +
      "  Your persistent knowledge graph. Use forest_read to search past decisions/findings/facts.\n" +
      "  Use forest_write to record important discoveries, decisions, or facts that should persist.\n" +
      "  Scopes: 2/1=ellie-dev, 2/2=ellie-forest, 2/3=ellie-home, 2/4=ellie-os-app\n" +
      "- QMD (mcp__qmd__deep_search, vector_search, search, get, multi_get, status):\n" +
      "  Document search across the ellie-river knowledge base.\n" +
      "  Use deep_search for best results, vector_search for semantic/meaning queries,\n" +
      "  search for exact keyword matches. Use get/multi_get to fetch full document content.\n" +
      (isOutlookConfigured()
        ? "- Microsoft Outlook (" + getOutlookEmail() + "):\n" +
          "  Available via HTTP API (use curl from Bash):\n" +
          "  - GET http://localhost:3001/api/outlook/unread — list unread messages\n" +
          "  - GET http://localhost:3001/api/outlook/search?q=QUERY — search messages\n" +
          "  - GET http://localhost:3001/api/outlook/message/MESSAGE_ID — get full message\n" +
          "  - POST http://localhost:3001/api/outlook/send -d '{\"subject\":\"...\",\"body\":\"...\",\"to\":[\"...\"]}' (requires [CONFIRM])\n" +
          "  - POST http://localhost:3001/api/outlook/reply -d '{\"messageId\":\"...\",\"comment\":\"...\"}' (requires [CONFIRM])\n" +
          "  Your system context already includes an Outlook unread email signal.\n"
        : "");

    sections.push({ label: "tools", content:
      toolHeader + " " + mcpDetails +
      "Use them freely to answer questions — read files, run commands, search code, browse the web, check email, manage calendar. " +
      "IMPORTANT: NEVER run sudo commands, NEVER install packages (apt, npm -g, brew), NEVER run commands that require interactive input or confirmation. " +
      "If a task would require sudo or installing software, tell the user what to run instead. " +
      "The user is reading on a phone. After using tools, give a concise final answer (not the raw tool output). " +
      "If a task requires multiple steps, just do them — don't ask for permission.",
    priority: 2 });
  }

  // Priority 2: Identity + time
  if (USER_NAME) sections.push({ label: "user-name", content: `You are speaking with ${USER_NAME}.`, priority: 2 });
  const now = new Date().toLocaleString("en-US", { timeZone: USER_TIMEZONE, dateStyle: "full", timeStyle: "short" });
  sections.push({ label: "time", content: `Current date/time: ${now} (${USER_TIMEZONE}).`, priority: 2 });

  // ELLIE-334: Inject current channel context so the model knows which sub-channel it's in
  if (channelProfile?.channelName) {
    sections.push({ label: "channel-context", content:
      `\nCURRENT CHANNEL: ${channelProfile.channelName}` +
      `\nChannel mode: ${channelProfile.contextMode}` +
      `\nThis conversation is scoped to the "${channelProfile.channelName}" sub-channel. ` +
      `Stay focused on topics relevant to this channel's purpose.`,
      priority: 2 });
  }

  // Priority 3: Protocols — River-backed, River is source of truth (ELLIE-150, ELLIE-532, ELLIE-537)
  // Sections are omitted when the River doc is unavailable (no hardcoded fallback).
  // Priority is overridable via section_priority in River doc frontmatter.
  {
    const riverMemory = getCachedRiverDoc("memory-protocol");
    if (riverMemory) {
      const sessionNote = sessionIds ? "" : "\n\n(No active work session — forest writes unavailable.)";
      sections.push({ label: "memory-protocol", content: `\nMEMORY MANAGEMENT:\n${riverMemory}${sessionNote}`, priority: getRiverDocPriority("memory-protocol", 3) });
    }
  }

  {
    const riverConfirm = getCachedRiverDoc("confirm-protocol");
    if (riverConfirm) {
      sections.push({ label: "confirm-protocol", content: `\nACTION CONFIRMATIONS:\n${riverConfirm}`, priority: getRiverDocPriority("confirm-protocol", 3) });
    }
  }

  if (sessionIds) {
    // ELLIE-536/537: River-backed, section omitted when unavailable.
    const riverForestWrites = getCachedRiverDoc("forest-writes");
    if (riverForestWrites) {
      sections.push({ label: "forest-memory-writes", content: `\nFOREST MEMORY WRITES (IMPORTANT):\n${riverForestWrites}`, priority: getRiverDocPriority("forest-writes", 3) });
    }
  }

  // Priority 3: Full conversation thread (ELLIE-202 — primary context source, ground truth)
  if (recentMessages) sections.push({ label: "conversation", content: `\n${recentMessages}`, priority: 3 });

  // Priority 3: Active incidents — always visible when something is on fire
  if (incidentContext) sections.push({ label: "incidents", content: `\n${incidentContext}`, priority: 3 });

  // Priority 4: Skills prompt block (ELLIE-217 — eligible skills from SKILL.md files)
  if (skillsPrompt) sections.push({ label: "skills", content: `\n${skillsPrompt}`, priority: 4 });

  // Priority 4: Queue items for this agent (ELLIE-201 — injected on new session)
  if (queueContext) sections.push({ label: "queue", content: `\n${queueContext}`, priority: 4 });

  // Priority 4: Orchestration status — ELLIE-351 (in-memory, zero latency)
  {
    const runs = getActiveRunStates();
    if (runs.length > 0) {
      const lines = ["ACTIVE AGENT RUNS:"];
      for (const r of runs) {
        const elapsed = Math.floor((Date.now() - r.startedAt) / 1000);
        const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m`;
        const hb = Math.floor((Date.now() - r.lastHeartbeat) / 1000);
        const hbStr = hb < 10 ? "now" : hb < 60 ? `${hb}s ago` : `${Math.floor(hb / 60)}m ago`;
        const workItem = r.workItemId ? ` on ${r.workItemId}` : "";
        const stale = r.status === "stale" ? " [STALE]" : "";
        lines.push(`- ${r.agentType} agent${workItem} (running ${elapsedStr}, last heartbeat ${hbStr})${stale}`);
      }
      sections.push({ label: "orchestration-status", content: `\n${lines.join("\n")}`, priority: 4 });
    }
  }

  // Priority 5: Variable context sources (can grow large)
  if (profileContext) sections.push({ label: "profile", content: `\nProfile:\n${profileContext}`, priority: 5 });
  if (structuredContext) sections.push({ label: "structured-context", content: `\n${structuredContext}`, priority: 5 });
  if (contextDocket) sections.push({ label: "context-docket", content: `\nCONTEXT:\n${contextDocket}`, priority: 6 });
  if (agentMemoryContext) sections.push({ label: "agent-memory", content: agentMemoryContext, priority: 5 });
  if (awarenessContext) sections.push({ label: "forest-awareness", content: `\n${awarenessContext}`, priority: 5 });

  // Priority 7: Search results (already trimmed by trimSearchContext, lowest variable priority)
  const searchBlock = trimSearchContext([relevantContext || '', elasticContext || '', forestContext || '']);
  if (searchBlock) sections.push({ label: "search", content: `\n${searchBlock}`, priority: 7 });

  // Priority 8: Context freshness timestamps (ELLIE-327)
  const freshnessBlock = freshnessTracker.getAllTimestamps();
  if (freshnessBlock) {
    sections.push({ label: "freshness", content: `\nCONTEXT FRESHNESS:\n${freshnessBlock}`, priority: 8 });
  }

  // Priority 3: Staleness warning (ELLIE-328) — visible when critical sources are aging/stale
  if (contextMode) {
    const stalenessWarning = buildStalenessWarning(contextMode, refreshedSources);
    if (stalenessWarning) {
      sections.push({ label: "staleness-warning", content: `\n${stalenessWarning}`, priority: 3 });
    }
  }

  // Priority 3: Source hierarchy instruction (ELLIE-250 Phase 3)
  sections.push({ label: "source-hierarchy", content: `\n${buildSourceHierarchyInstruction()}`, priority: 3 });

  // Priority 3: Ground truth conflicts (ELLIE-250 Phase 3)
  // Injected by chat handler when conflicts are detected — passed via groundTruthConflicts param
  if (groundTruthConflicts) {
    sections.push({ label: "ground-truth-conflicts", content: `\n${groundTruthConflicts}`, priority: 3 });
  }

  // Priority 5: Cross-channel corrections (ELLIE-250 Phase 3)
  if (crossChannelCorrections) {
    sections.push({ label: "cross-channel-corrections", content: `\n${crossChannelCorrections}`, priority: 5 });
  }

  // Priority 3: Work item + dispatch protocols
  if (workItemContext) sections.push({ label: "work-item", content: workItemContext, priority: 3 });

  if (workItemContext?.includes("ACTIVE WORK ITEM") && agentConfig?.name === "dev") {
    // ELLIE-533/535/537: River-backed, section omitted when unavailable.
    const riverDevTemplate = getCachedRiverDoc("dev-agent-template");
    if (riverDevTemplate) {
      sections.push({ label: "dev-protocol", content: `\nDEV AGENT PROTOCOL:\n${riverDevTemplate}`, priority: getRiverDocPriority("dev-agent-template", 3) });
    }
  }

  // ELLIE-535/537: Research agent protocol — River-backed, section omitted when unavailable.
  if (agentConfig?.name === "research") {
    const riverResearchTemplate = getCachedRiverDoc("research-agent-template");
    if (riverResearchTemplate) {
      sections.push({ label: "research-protocol", content: `\nRESEARCH AGENT PROTOCOL:\n${riverResearchTemplate}`, priority: getRiverDocPriority("research-agent-template", 3) });
    }
  }

  // ELLIE-535/537: Strategy agent protocol — River-backed, section omitted when unavailable.
  if (agentConfig?.name === "strategy") {
    const riverStrategyTemplate = getCachedRiverDoc("strategy-agent-template");
    if (riverStrategyTemplate) {
      sections.push({ label: "strategy-protocol", content: `\nSTRATEGY AGENT PROTOCOL:\n${riverStrategyTemplate}`, priority: getRiverDocPriority("strategy-agent-template", 3) });
    }
  }

  if (isPlaneConfigured()) {
    if (isGeneralAgent) {
      // ELLIE-536/537: River-backed, section omitted when unavailable.
      const riverPlaybook = getCachedRiverDoc("playbook-commands");
      if (riverPlaybook) {
        sections.push({ label: "playbook-commands", content: `\nELLIE:: PLAYBOOK COMMANDS:\n${riverPlaybook}`, priority: getRiverDocPriority("playbook-commands", 3) });
      }
    }
    // ELLIE-536/537: River-backed, section omitted when unavailable.
    const riverWorkCommands = getCachedRiverDoc("work-commands");
    if (riverWorkCommands) {
      sections.push({ label: "work-commands", content: `\nWORK ITEM COMMANDS:\n${riverWorkCommands}`, priority: getRiverDocPriority("work-commands", 3) });
    }
  }

  // Planning mode context — ELLIE-536/537: River-backed, section omitted when unavailable.
  if (planningMode) {
    const riverPlanningMode = getCachedRiverDoc("planning-mode");
    if (riverPlanningMode) {
      sections.push({ label: "planning-mode", content: `\nPLANNING MODE ACTIVE:\n${riverPlanningMode}`, priority: getRiverDocPriority("planning-mode", 3) });
    }
  }

  // ── ELLIE-261: Apply strategy mode section filtering + budget ──
  // ── ELLIE-262: Apply per-mode soul/personality priority overrides ──
  const activeStrategy = getLastResolvedStrategy();
  const sectionPriorityOverrides = getStrategySectionPriorities(activeStrategy);
  // ELLIE-378: Track priority overrides for conflict logging
  const priorityConflicts: Array<{ label: string; from: number; to: number; source: string }> = [];
  for (const s of sections) {
    if (sectionPriorityOverrides[s.label] !== undefined) {
      s.priority = sectionPriorityOverrides[s.label];
    }
  }

  // ── ELLIE-325: Apply message-level mode priorities (override strategy) ──
  if (contextMode) {
    const modePriorities = getModeSectionPriorities(contextMode);
    for (const s of sections) {
      if (modePriorities[s.label] !== undefined) {
        const prev = s.priority;
        s.priority = modePriorities[s.label];
        if (prev !== s.priority) {
          priorityConflicts.push({ label: s.label, from: prev, to: s.priority, source: `mode:${contextMode}` });
        }
      }
    }
    // NOTE: Suppression deferred to after creature overrides — creature profiles
    // can rescue mode-suppressed sections (e.g. deep-work suppresses archetype:8,
    // but dev creature needs archetype:1). Single pass below handles both.
  }

  // ── ELLIE-367: Apply creature-specific section priorities (override mode) ──
  const creatureProfile = getCreatureProfile(agentConfig?.name);
  if (creatureProfile?.section_priorities) {
    for (const s of sections) {
      if (creatureProfile.section_priorities[s.label] !== undefined) {
        const prev = s.priority;
        s.priority = creatureProfile.section_priorities[s.label];
        if (prev !== s.priority) {
          priorityConflicts.push({ label: s.label, from: prev, to: s.priority, source: `creature:${agentConfig?.name}` });
        }
      }
    }
  }

  // ELLIE-378: Log priority conflicts between layers
  if (priorityConflicts.length > 0) {
    logger.info("Priority overrides applied", {
      mode: contextMode,
      creature: agentConfig?.name,
      strategy: activeStrategy,
      conflicts: priorityConflicts,
    });
  }

  // ── Suppress sections with priority >= 7 (after all priority layers applied) ──
  const SUPPRESS_THRESHOLD = 7;
  const suppCount = sections.filter(s => s.priority >= SUPPRESS_THRESHOLD).length;
  if (suppCount > 0) {
    for (let i = sections.length - 1; i >= 0; i--) {
      if (sections[i].priority >= SUPPRESS_THRESHOLD) sections.splice(i, 1);
    }
    logger.debug(`Suppressed ${suppCount} sections (priority >= ${SUPPRESS_THRESHOLD}, mode=${contextMode}, creature=${agentConfig?.name})`);
  }

  const excludedSections = getStrategyExcludedSections(activeStrategy);
  let filteredSections = excludedSections.size > 0
    ? sections.filter(s => !excludedSections.has(s.label))
    : sections;

  // ── ELLIE-334: Apply channel suppressed sections ──
  if (channelProfile?.suppressedSections?.length) {
    const suppressed = new Set(channelProfile.suppressedSections);
    filteredSections = filteredSections.filter(s => !suppressed.has(s.label));
  }

  // ── Apply token budget (ELLIE-185 + ELLIE-261 + ELLIE-334 + ELLIE-367 + ELLIE-446) ──
  // Creature budget (agent-specific) > channel profile budget > mode budget > strategy budget.
  // ELLIE-446: Creature budget must win — a specialist agent's wiring (e.g. dev-ant: 40k)
  // should not be capped by the conversation mode's channel profile (e.g. general: 24k).
  const budget = creatureProfile?.token_budget
    ? creatureProfile.token_budget
    : channelProfile?.tokenBudget
      ? channelProfile.tokenBudget
      : contextMode
        ? getModeTokenBudget(contextMode)
        : getStrategyTokenBudget(activeStrategy);

  // ── ELLIE-383: Capture build metrics before budget trimming ──
  const sectionMetrics = filteredSections.map(s => ({
    label: s.label,
    tokens: estimateTokens(s.content),
    priority: s.priority,
  }));
  const totalTokens = sectionMetrics.reduce((sum, s) => sum + s.tokens, 0);
  _lastBuildMetrics = {
    sections: sectionMetrics,
    totalTokens,
    sectionCount: filteredSections.length,
    budget,
    mode: contextMode,
    creature: agentConfig?.name,
    // ELLIE-534: River cache performance for this build
    riverCacheHits: _riverDocMetrics.cacheHits - _riverHitsAtStart,
    riverCacheMisses: _riverDocMetrics.cacheMisses - _riverMissesAtStart,
  };

  return applyTokenBudget(filteredSections, budget);
}
