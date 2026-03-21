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
import { sanitizeUserMessage } from "./sanitize.ts";
import { buildSourceHierarchyInstruction } from "./source-hierarchy.ts";
import { getActiveRunStates } from "./orchestration-tracker.ts";
import { getChildrenForParent } from "./session-spawn.ts";
import {
  getCachedWorkingMemory,
  setWorkingMemoryCache,
  clearWorkingMemoryCache,
  _injectWorkingMemoryForTesting,
} from "./working-memory.ts";
import { getPendingCommitmentsForPrompt } from "./pending-commitments-prompt.ts";
import { getWorkflowProgressForPrompt } from "./workflow-progress-tracker.ts";
import { getIdentityPromptSections } from "./prompt-identity-injector.ts";
export { setWorkingMemoryCache, getCachedWorkingMemory, clearWorkingMemoryCache, _injectWorkingMemoryForTesting };

// ELLIE-639: Emoji guidance cache — set by relay on startup / pref change
let _emojiGuidanceCache: string | null = null;

/** Set emoji guidance for prompt injection. Call with null to disable. */
export function setEmojiGuidanceCache(guidance: string | null): void {
  _emojiGuidanceCache = guidance;
}

/** Get current emoji guidance (for testing). */
export function getEmojiGuidanceCache(): string | null {
  return _emojiGuidanceCache;
}

/** Inject emoji guidance for testing without going through the preference system. */
export function _injectEmojiGuidanceForTesting(guidance: string | null): void {
  _emojiGuidanceCache = guidance;
}

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
    logger.info(`Watching ${personalityWatchers.length} personality files for changes`);
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
let _riverDocCacheTtlMs = 300_000; // 5 min
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
  "commitment-framework": "frameworks/commitment-framework.md",
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
  brian: "brian-owl",
  amy: "amy-ant",
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

// ── Per-agent role loader (ELLIE-611) ─────────────────────────
// Loads role context from config/roles/{role}.md via the ODS role-loader.
// Parallel to getAgentArchetype above — same cache pattern.

const _agentRoleCache: Map<string, { content: string; loadedAt: number }> = new Map();
const AGENT_ROLE_CACHE_MS = 60_000;
const ROLES_DIR = join(PROJECT_ROOT, "config", "roles");

/** Map agent names to their role file names (from DEFAULT_BINDINGS). */
const AGENT_ROLE_MAP: Record<string, string> = {
  dev: "dev",
  general: "general",
  research: "researcher",
  strategy: "strategy",
  brian: "critic",
  amy: "content",
  critic: "critic",
  content: "content",
  finance: "finance",
  ops: "ops",
};

/**
 * Load a role file for an agent.
 * Returns the role body (no frontmatter) for injection into prompts.
 */
export async function getAgentRoleContext(agentName?: string): Promise<string> {
  if (!agentName) return "";

  const normalized = agentName.toLowerCase().replace(/[^a-z0-9-]/g, "");
  const cached = _agentRoleCache.get(normalized);
  if (cached && Date.now() - cached.loadedAt < AGENT_ROLE_CACHE_MS) return cached.content;

  const roleName = AGENT_ROLE_MAP[normalized];
  if (!roleName) return "";

  try {
    const filePath = join(ROLES_DIR, `${roleName}.md`);
    const raw = await readFile(filePath, "utf-8");
    // Strip YAML frontmatter, return body only
    const fmMatch = raw.match(/^---\s*\n[\s\S]*?\n---\s*\n?([\s\S]*)$/);
    const body = fmMatch ? fmMatch[1].trim() : raw.trim();
    _agentRoleCache.set(normalized, { content: body, loadedAt: Date.now() });
    logger.info(`Role ${normalized}: loaded from ${roleName}.md`);
    return body;
  } catch {
    logger.debug(`Role ${normalized}: no role file found (${roleName}.md)`);
    return "";
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

// ── Cognitive load context (ELLIE-338) ───────────────────────

let _cognitiveLoadHint = "";
let _cognitiveLoadLastChecked = 0;
const COGNITIVE_LOAD_CACHE_MS = 5 * 60_000;

export async function getCognitiveLoadContext(supabase?: unknown): Promise<string> {
  const now = Date.now();
  if (_cognitiveLoadHint && now - _cognitiveLoadLastChecked < COGNITIVE_LOAD_CACHE_MS) return _cognitiveLoadHint;
  try {
    const { runCognitiveLoadDetection, formatLoadHint } = await import("./api/cognitive-load.ts");
    const result = await runCognitiveLoadDetection(supabase as Parameters<typeof runCognitiveLoadDetection>[0]);
    _cognitiveLoadHint = formatLoadHint(result);
    _cognitiveLoadLastChecked = now;
  } catch {
    // Cognitive load detection is non-critical — skip silently
  }
  return _cognitiveLoadHint;
}

// ── Commitment follow-up context (ELLIE-339) ────────────────

let _commitmentFollowUpCtx = "";
let _commitmentFollowUpAt = 0;
const COMMITMENT_FOLLOWUP_CACHE_MS = 10 * 60_000;

export function _getCommitmentFollowUpCache(): { _commitmentFollowUpContext: string } {
  if (Date.now() - _commitmentFollowUpAt > COMMITMENT_FOLLOWUP_CACHE_MS) {
    return { _commitmentFollowUpContext: "" };
  }
  return { _commitmentFollowUpContext: _commitmentFollowUpCtx };
}

export async function getCommitmentFollowUpContext(supabase?: unknown): Promise<string> {
  const now = Date.now();
  if (_commitmentFollowUpCtx && now - _commitmentFollowUpAt < COMMITMENT_FOLLOWUP_CACHE_MS) return _commitmentFollowUpCtx;
  try {
    const { getCommitmentContext } = await import("./api/commitment-tracker.ts");
    _commitmentFollowUpCtx = await getCommitmentContext(supabase as Parameters<typeof getCommitmentContext>[0]);
    _commitmentFollowUpAt = now;
  } catch {
    // Non-critical
  }
  return _commitmentFollowUpCtx;
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
        const prompt = buildAssessmentPrompt(sanitizeUserMessage(userMessage), assistantResponse);
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

    // ELLIE-941: Record phase transitions as episodic memories
    if (newPhase.phase !== phase.phase) {
      logger.info(`Phase transition: ${phase.phase_name} -> ${newPhase.phase_name}`);
      try {
        const { writeMemory } = await import('../../ellie-forest/src/shared-memory');
        await writeMemory({
          content: `Relationship phase advanced: ${phase.phase_name} → ${newPhase.phase_name}. Message count: ${newPhase.message_count}, trust signals: ${newPhase.trust_signals.count}.`,
          type: 'finding',
          scope: 'global',
          confidence: 0.9,
          tags: ['phase-transition', 'relationship'],
          metadata: { source: 'phase_engine', from_phase: phase.phase, to_phase: newPhase.phase },
          cognitive_type: 'episodic',
          category: 'relationships',
        });
      } catch (err: unknown) {
        logger.warn("Phase transition memory write failed", err);
      }
    }

    logger.info(`Completed in ${Date.now() - start}ms` +
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
  roleContext?: string,
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
  fullWorkingMemory?: boolean,
): string {
  const channelLabel = channel === "google-chat" ? "Google Chat" : channel === "ellie-chat" ? "Ellie Chat (dashboard)" : channel === "email" ? "Email (via AgentMail — replies are sent back as email to the sender)" : "Telegram";

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
  // ELLIE-555: sanitize user message before embedding in prompt
  sections.push({ label: "user-message", content: `\nUser: ${sanitizeUserMessage(userMessage)}`, priority: 1 });

  // Priority 2: Soul + personality (small, defines who Ellie is)
  // ELLIE-525: Soul only for primary Ellie — saves ~2,500 tokens per downstream agent call.
  // ELLIE-532: Prefer River soul doc when cached; fall back to config/soul.md.
  if (isGeneralAgent) {
    const riverSoul = getCachedRiverDoc("soul");
    const effectiveSoul = riverSoul || soulContext;
    if (effectiveSoul) sections.push({ label: "soul", content: `# Ellie Soul\n${effectiveSoul}\n---\n`, priority: 2 });
  }
  if (archetypeContext) sections.push({ label: "archetype", content: `# Behavioral Archetype\n${archetypeContext}\n---\n`, priority: 2 });
  // ELLIE-611: Inject agent role context (WHAT the agent does) at priority 5
  if (roleContext) sections.push({ label: "identity-role", content: `# Agent Role\n${roleContext}\n---\n`, priority: 5 });

  // ELLIE-616: Inject ODS identity sections (archetype at priority 3, role at priority 5)
  // Only inject when legacy params are absent — avoids duplicate content during migration.
  if (!archetypeContext || !roleContext) {
    try {
      const agentName = agentConfig?.name || "general";
      const identitySections = getIdentityPromptSections(agentName);
      for (const section of identitySections) {
        // Skip archetype if legacy archetypeContext is already present
        if (section.label === "identity-archetype" && archetypeContext) continue;
        // Skip role if legacy roleContext is already present
        if (section.label === "identity-role" && roleContext) continue;
        sections.push(section);
      }
    } catch (e) {
      logger.warn("ODS identity injection failed (non-fatal)", { error: e instanceof Error ? e.message : String(e) });
    }
  }

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
      `- Google Workspace (user_google_email: ${process.env.USER_GOOGLE_EMAIL || "not configured"}):\n` +
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

  // Priority 2: Working memory (ELLIE-539)
  // Resumption prompt is always injected when present — gives the agent instant
  // context continuity without requiring compression detection.
  // Full working memory (all 7 sections) is injected on demand when fullWorkingMemory=true.
  {
    const agentName = agentConfig?.name || "general";
    const wm = getCachedWorkingMemory(agentName);
    if (wm) {
      const s = wm.sections;
      if (fullWorkingMemory) {
        // Full pull: all non-empty sections
        const parts: string[] = [];
        if (s.session_identity)    parts.push(`**Session:** ${s.session_identity}`);
        if (s.task_stack)          parts.push(`**Tasks:**\n${s.task_stack}`);
        if (s.conversation_thread) parts.push(`**Thread:** ${s.conversation_thread}`);
        if (s.investigation_state) parts.push(`**Investigation:**\n${s.investigation_state}`);
        if (s.decision_log)        parts.push(`**Decisions:**\n${s.decision_log}`);
        if (s.context_anchors)     parts.push(`**Anchors:** ${s.context_anchors}`);
        if (s.resumption_prompt)   parts.push(`**Resumption:** ${s.resumption_prompt}`);
        if (parts.length > 0) {
          sections.push({
            label: "working-memory-full",
            content: `\nWORKING MEMORY — ${agentName}:\n${parts.join("\n")}`,
            priority: 2,
          });
        }
      } else if (s.resumption_prompt?.trim()) {
        // Resumption-only: lightweight always-on injection
        sections.push({
          label: "working-memory-resumption",
          content: `\nRESUMPTION CONTEXT:\n${s.resumption_prompt}`,
          priority: 2,
        });
      }
    }
  }

  // Priority 2: Pending commitments (ELLIE-590)
  // Injected when there are in-flight promises — ensures agents never forget them.
  {
    const commitmentsSection = getPendingCommitmentsForPrompt();
    if (commitmentsSection) {
      sections.push({ label: "pending-commitments", content: commitmentsSection, priority: 2 });
    }
  }

  // ELLIE-339: Commitment follow-ups — gentle reminders for stated intentions
  if (healthContext) {
    // healthContext is reused for cognitive load (ELLIE-338) above;
    // commitment follow-ups are injected separately via getCommitmentContext()
  }
  {
    const { _commitmentFollowUpContext } = _getCommitmentFollowUpCache();
    if (_commitmentFollowUpContext) {
      sections.push({ label: "commitment-followups", content: `\n${_commitmentFollowUpContext}`, priority: 4 });
    }
  }

  // Priority 2: Active workflow progress (ELLIE-595)
  // Injected when multi-step workflows are in flight — shows step status to coordinator.
  {
    const workflowSection = getWorkflowProgressForPrompt();
    if (workflowSection) {
      sections.push({ label: "workflow-progress", content: workflowSection, priority: 2 });
    }
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

  // Priority 4: Emoji guidance (ELLIE-639 — contextual emoji in responses)
  {
    const emojiGuidance = _emojiGuidanceCache;
    if (emojiGuidance) sections.push({ label: "emoji-guidance", content: `\n${emojiGuidance}`, priority: 4 });
  }

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

  // ELLIE-942/952: Active sub-agent spawns — show parent what children are doing.
  // Check multiple ID candidates since parentSessionId in spawn records may be
  // a Forest tree_id, agent session_id, or work_item_id depending on the caller.
  {
    const candidateIds = [sessionIds?.tree_id, sessionIds?.work_item_id].filter(Boolean) as string[];
    let spawnChildren: ReturnType<typeof getChildrenForParent> = [];
    for (const id of candidateIds) {
      spawnChildren = getChildrenForParent(id);
      if (spawnChildren.length > 0) break;
    }
    if (spawnChildren.length > 0) {
      const lines = ["SPAWNED SUB-AGENTS:"];
      for (const child of spawnChildren) {
        const elapsed = Math.floor((Date.now() - child.createdAt) / 1000);
        const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m`;
        const stateIcon = child.state === "completed" ? "done" : child.state === "failed" ? "FAILED" : child.state === "timed_out" ? "TIMED OUT" : "running";
        const result = child.resultText ? ` — ${child.resultText.slice(0, 100)}` : "";
        lines.push(`- ${child.targetAgentName}: ${stateIcon} (${elapsedStr})${result}`);
      }
      sections.push({ label: "spawn-status", content: `\n${lines.join("\n")}`, priority: 4 });
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

  // Commitment Framework — River-backed routing system for how the general agent handles commitments.
  // Injected at P3 for general agent only. Use cases loaded on-demand via QMD/file read.
  if (isGeneralAgent) {
    const riverCommitmentFramework = getCachedRiverDoc("commitment-framework");
    if (riverCommitmentFramework) {
      sections.push({ label: "commitment-framework", content: `\nCOMMITMENT FRAMEWORK:\n${riverCommitmentFramework}`, priority: getRiverDocPriority("commitment-framework", 3) });
    }
  }

  // ELLIE-338: Cognitive load awareness hint — injected when load is moderate or higher
  if (healthContext) {
    sections.push({ label: "cognitive-load-hint", content: `\n${healthContext}`, priority: 4 });
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
