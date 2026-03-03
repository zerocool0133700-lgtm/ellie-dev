/**
 * Job Intelligence — ELLIE-456
 *
 * Pattern extraction (J/4), compaction (J/2/3), and governance reference (J/5)
 * for the J (Jobs / Workshop) scope hierarchy.
 *
 * Schedule: 3:30 AM CST nightly (triggered by relay.ts).
 * HTTP:     POST /api/job-intelligence/run      — on-demand trigger
 *           GET  /api/job-intelligence/patterns  — list extracted patterns
 */

import Anthropic from "@anthropic-ai/sdk";
import type { IncomingMessage, ServerResponse } from "http";
import postgres from "postgres";
import { log } from "../logger.ts";
import { writeMemory, archiveMemory } from "../../../ellie-forest/src/index";
import { getRelayDeps, getNotifyCtx } from "../relay-state.ts";
import { notify } from "../notification-policy.ts";
import type { EntityType } from "../jobs-ledger.ts";

const logger = log.child("job-intelligence");

// ── DB ──────────────────────────────────────────────────────────────────────

let _db: ReturnType<typeof postgres> | null = null;
function db() {
  if (!_db) {
    _db = postgres({ host: "/var/run/postgresql", database: "ellie-forest", username: "ellie" });
  }
  return _db;
}

// ── Constants ────────────────────────────────────────────────────────────────

const PATTERN_THRESHOLD = 10;      // min touchpoints before pattern extraction runs
const COMPACT_OLDER_THAN_DAYS = 7; // compact touchpoints older than this
const PATTERN_COOLDOWN_MS = 24 * 60 * 60_000; // don't re-extract within 24h

/** Map EntityType → J/3/N scope path */
const ENTITY_SCOPE: Record<EntityType, string> = {
  dev:      "J/3/1",
  strategy: "J/3/2",
  research: "J/3/3",
  content:  "J/3/4",
  finance:  "J/3/5",
  critic:   "J/3/6",
  general:  "J/3/7",
};

const ALL_ENTITY_TYPES: EntityType[] = [
  "dev", "strategy", "research", "content", "finance", "critic", "general",
];

interface ExtractedPattern {
  title: string;
  description: string;
  confidence: number;
  evidence: string[];
}

// ── Governance Reference Seed ─────────────────────────────────────────────────

const GOVERNANCE_SEEDS = [
  {
    scope_path: "J/5/1",
    content: "Budget governance: MAX_COST_PER_EXECUTION = $2.00 USD hard limit per orchestrated execution (orchestrator.ts:147). COST_WARN_THRESHOLD = $0.50 USD logs a warning (orchestrator.ts:146). Jobs exceeding $2.00 are logged as errors; no automatic kill is in place.",
    confidence: 1.0,
  },
  {
    scope_path: "J/5/2",
    content: "Agent policies: Default model = claude-sonnet-4-6 ($3/1M input, $15/1M output). Pattern extraction uses claude-haiku-4-5-20251001 ($0.80/$4) to minimise meta-analysis cost. Retry cap: 3 per orchestrated step. Dev agents verified via git log after completion (verifyJobWork in jobs-ledger.ts).",
    confidence: 1.0,
  },
  {
    scope_path: "J/5/3",
    content: "Dispatch rules: executeTrackedDispatch → orchestration-dispatch.ts → startCreature(). creature_id from work-session/start wired into job at dispatch. Jobs without a tree_id have no Forest vine until attached during execution. J/3 touchpoints written at started/completed/blocker/failed lifecycle points (ELLIE-455).",
    confidence: 0.9,
  },
];

/**
 * Seed J/5 governance reference memories. Idempotent — skips if rows already exist.
 * Returns number of new rows written.
 */
export async function seedGovernanceReference(): Promise<number> {
  let seeded = 0;
  for (const seed of GOVERNANCE_SEEDS) {
    const existing = await db()<{ count: string }[]>`
      SELECT count(*) FROM shared_memories
      WHERE scope_path = ${seed.scope_path} AND type = 'fact' AND status = 'active'
    `.catch(() => [{ count: "1" }]); // on error, assume exists (safe default)

    if (Number(existing[0]?.count ?? 0) > 0) continue;

    await writeMemory({
      content: seed.content,
      type: "fact",
      scope_path: seed.scope_path,
      confidence: seed.confidence,
      tags: ["governance", "job-intelligence", "ellie-456"],
      metadata: { seeded_by: "job-intelligence", work_item_id: "ELLIE-456" },
    }).catch(err => {
      logger.warn("[gov] Seed write failed", { scope: seed.scope_path, err: err.message });
    });
    seeded++;
  }
  if (seeded > 0) logger.info(`[gov] Seeded ${seeded} governance reference memory(s)`);
  return seeded;
}

// ── Pattern Extraction ──────────────────────────────────────────────────────

const PATTERN_SYSTEM = `You are Ellie's Job Intelligence system. Analyze recent job touchpoints \
from a single agent scope and extract 1-3 concrete behavioral patterns.

A pattern must describe a recurring behavior, tendency, or outcome observed across multiple jobs. \
Focus on: typical duration/cost ranges, common failure modes, decision or blocker tendencies, \
efficiency observations.

Return a valid JSON array only — no markdown fences, no extra text:
[{"title":"...","description":"...","confidence":0.0,"evidence":["..."]}]

Return [] if no clear pattern spans at least 3 jobs. confidence must be 0.0–1.0.`;

async function callClaudeForPatterns(
  anthropic: Anthropic,
  entityType: EntityType,
  touchpoints: Array<{ content: string; metadata: Record<string, unknown>; created_at: string }>,
): Promise<ExtractedPattern[]> {
  const payload = touchpoints.slice(0, 30).map(t => ({
    content: t.content,
    duration_ms: t.metadata?.duration_ms ?? null,
    cost_usd: t.metadata?.cost_usd ?? null,
    tokens: t.metadata?.tokens ?? null,
    date: t.created_at,
  }));

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: PATTERN_SYSTEM,
    messages: [{
      role: "user",
      content: `Agent: ${entityType}\n\n${touchpoints.length} touchpoints:\n${JSON.stringify(payload, null, 2)}`,
    }],
  });

  const text = response.content.find(b => b.type === "text")?.text ?? "[]";
  const parsed = JSON.parse(text.trim());
  if (!Array.isArray(parsed)) throw new Error("Non-array response");
  return parsed as ExtractedPattern[];
}

/**
 * Check if pattern extraction threshold is met for an entity type.
 * If so, call Claude Haiku to extract patterns and write them to J/4/4.
 * Fire-and-forget safe — catches all errors internally.
 */
export async function checkAndExtractPatterns(entityType: EntityType): Promise<number> {
  const { anthropic } = getRelayDeps();
  if (!anthropic) return 0;

  const scopePath = ENTITY_SCOPE[entityType];

  // Fetch recent completed/started touchpoints for this entity scope
  const rows = await db()<{ id: string; content: string; metadata: Record<string, unknown>; created_at: string }[]>`
    SELECT id, content, metadata, created_at
    FROM shared_memories
    WHERE scope_path = ${scopePath}
      AND status = 'active'
      AND (
        metadata->>'touchpoint' = 'completed'
        OR metadata->>'touchpoint' = 'started'
      )
    ORDER BY created_at DESC
    LIMIT 50
  `.catch(() => []);

  if (rows.length < PATTERN_THRESHOLD) return 0;

  // Skip if we extracted patterns for this entity type recently
  const lastPattern = await db()<{ created_at: string }[]>`
    SELECT created_at FROM shared_memories
    WHERE scope_path IN ('J/4/1', 'J/4/2', 'J/4/3', 'J/4/4')
      AND type = 'pattern'
      AND metadata->>'entity_type' = ${entityType}
      AND status = 'active'
    ORDER BY created_at DESC LIMIT 1
  `.catch(() => []);

  if (lastPattern[0]) {
    const age = Date.now() - new Date(lastPattern[0].created_at).getTime();
    if (age < PATTERN_COOLDOWN_MS) return 0;
  }

  try {
    const patterns = await callClaudeForPatterns(anthropic, entityType, rows);
    if (!patterns.length) return 0;

    for (const p of patterns) {
      await writeMemory({
        content: `[Pattern: ${p.title}] ${p.description}`,
        type: "pattern",
        scope_path: "J/4/4",
        confidence: Math.max(0, Math.min(1, p.confidence)),
        tags: ["job-pattern", entityType, "ellie-456"],
        metadata: {
          entity_type: entityType,
          source_scope: scopePath,
          evidence: p.evidence,
          touchpoint_count: rows.length,
          work_item_id: "ELLIE-456",
        },
      }).catch(err => logger.warn("[patterns] Write failed", { err: err.message }));
    }

    logger.info(`[patterns] ${patterns.length} pattern(s) extracted for ${entityType}`);
    return patterns.length;
  } catch (err: unknown) {
    logger.error("[patterns] Extraction failed", { entityType, err });
    return 0;
  }
}

// ── Compaction ────────────────────────────────────────────────────────────────

const COMPACT_SYSTEM = `You are Ellie's Job Intelligence compactor. Summarise a batch of old job \
touchpoints into 2-3 sentences capturing: what was done, outcomes (success/failure rates), \
and any notable costs or durations. Be specific and factual. Output plain text only.`;

async function compactScopeGroup(
  anthropic: Anthropic,
  scopePath: string,
  rows: Array<{ id: string; content: string; metadata: Record<string, unknown>; created_at: string }>,
): Promise<boolean> {
  const payload = rows.map(r => ({
    content: r.content,
    duration_ms: r.metadata?.duration_ms ?? null,
    cost_usd: r.metadata?.cost_usd ?? null,
    date: r.created_at,
  }));

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 512,
    system: COMPACT_SYSTEM,
    messages: [{
      role: "user",
      content: `Scope: ${scopePath}\n${rows.length} touchpoints:\n${JSON.stringify(payload, null, 2)}`,
    }],
  });

  const summary = response.content.find(b => b.type === "text")?.text?.trim();
  if (!summary) return false;

  const oldest = rows.at(-1)?.created_at ?? new Date().toISOString();
  const newest = rows[0]?.created_at ?? new Date().toISOString();

  await writeMemory({
    content: `[Compact: ${scopePath}] ${summary}`,
    type: "finding",
    scope_path: "J/2/3",
    confidence: 0.8,
    tags: ["job-compact", "ellie-456"],
    metadata: {
      source_scope: scopePath,
      compacted_count: rows.length,
      period_start: oldest,
      period_end: newest,
      work_item_id: "ELLIE-456",
    },
  });

  // Archive the originals
  for (const row of rows) {
    await archiveMemory(row.id).catch(() => {});
  }

  return true;
}

/**
 * Find J/3/* touchpoints older than COMPACT_OLDER_THAN_DAYS, summarise each
 * scope's batch via Claude Haiku, write to J/2/3, and archive the originals.
 * Returns total number of touchpoints archived.
 */
export async function compactOldTouchpoints(anthropic: Anthropic | null): Promise<number> {
  if (!anthropic) return 0;

  const cutoff = new Date(Date.now() - COMPACT_OLDER_THAN_DAYS * 24 * 60 * 60_000).toISOString();

  const rows = await db()<{
    id: string; content: string; scope_path: string;
    metadata: Record<string, unknown>; created_at: string
  }[]>`
    SELECT id, content, scope_path, metadata, created_at
    FROM shared_memories
    WHERE scope_path LIKE 'J/3/%'
      AND status = 'active'
      AND created_at < ${cutoff}
    ORDER BY scope_path, created_at DESC
  `.catch(() => []);

  if (!rows.length) {
    logger.info("[compact] No old touchpoints to compact");
    return 0;
  }

  // Group by scope_path
  const byScope: Record<string, typeof rows> = {};
  for (const row of rows) {
    (byScope[row.scope_path] ??= []).push(row);
  }

  let totalCompacted = 0;
  for (const [scopePath, scopeRows] of Object.entries(byScope)) {
    try {
      const ok = await compactScopeGroup(anthropic, scopePath, scopeRows);
      if (ok) {
        totalCompacted += scopeRows.length;
        logger.info(`[compact] ${scopeRows.length} touchpoint(s) compacted from ${scopePath}`);
      }
    } catch (err: unknown) {
      logger.error("[compact] Failed for scope", { scopePath, err });
    }
  }

  return totalCompacted;
}

// ── Full Nightly Run ──────────────────────────────────────────────────────────

/**
 * Full nightly intelligence run:
 * 1. Seed governance reference (idempotent).
 * 2. Extract patterns for all entity types that have hit the threshold.
 * 3. Compact old touchpoints into J/2/3.
 */
export async function runNightlyJobIntelligence(): Promise<{
  governance: number;
  patterns: number;
  compacted: number;
}> {
  const { anthropic } = getRelayDeps();

  const governance = await seedGovernanceReference();

  let patterns = 0;
  if (anthropic) {
    for (const et of ALL_ENTITY_TYPES) {
      patterns += await checkAndExtractPatterns(et).catch(() => 0);
    }
  }

  const compacted = await compactOldTouchpoints(anthropic ?? null);

  if (patterns > 0 || compacted > 0) {
    notify(getNotifyCtx(), {
      event: "rollup",
      telegramMessage: `~ Job Intelligence: ${patterns} pattern(s) extracted, ${compacted} touchpoints compacted.`,
    });
  }

  logger.info("[job-intel] Nightly run complete", { governance, patterns, compacted });
  return { governance, patterns, compacted };
}

// ── HTTP Handlers ─────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/** POST /api/job-intelligence/run — on-demand trigger */
export async function jobIntelligenceRunHandler(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const result = await runNightlyJobIntelligence();
    sendJson(res, 200, { ok: true, ...result });
  } catch (err: unknown) {
    logger.error("jobIntelligenceRunHandler error", err);
    sendJson(res, 500, { error: "Job intelligence run failed" });
  }
}

/** GET /api/job-intelligence/patterns — list extracted patterns from J/4 */
export async function jobPatternsHandler(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const patterns = await db()<{
      id: string; content: string; scope_path: string;
      confidence: number; created_at: string; metadata: Record<string, unknown>
    }[]>`
      SELECT id, content, scope_path, confidence, created_at, metadata
      FROM shared_memories
      WHERE scope_path LIKE 'J/4/%'
        AND type = 'pattern'
        AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 100
    `.catch(() => []);

    sendJson(res, 200, { patterns });
  } catch (err: unknown) {
    logger.error("jobPatternsHandler error", err);
    sendJson(res, 500, { error: "Failed to fetch patterns" });
  }
}
