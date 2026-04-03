/**
 * Dispatch Outcomes — ELLIE-1309
 *
 * Stores and retrieves structured summaries of completed dispatches.
 * Specialists report outcome data via working memory sections.
 * The coordinator reads these after dispatch and calls writeOutcome().
 */

import { log } from "./logger.ts";

const logger = log.child("dispatch-outcomes");

let _sql: ReturnType<typeof import("postgres").default> | null = null;

async function getSql() {
  if (_sql) return _sql;
  const mod = await import("../../ellie-forest/src/db");
  _sql = mod.default;
  return _sql;
}

export interface DispatchOutcome {
  run_id: string;
  parent_run_id?: string | null;
  agent: string;
  work_item_id?: string | null;
  dispatch_type: "single" | "formation" | "round_table" | "delegation";
  status: string;
  summary?: string | null;
  files_changed?: string[];
  decisions?: string[];
  commits?: string[];
  forest_writes?: string[];
  duration_ms?: number | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  cost_usd?: number | null;
}

export interface DispatchOutcomeRow extends DispatchOutcome {
  id: string;
  created_at: string;
}

export async function writeOutcome(outcome: DispatchOutcome): Promise<void> {
  try {
    const sql = await getSql();
    await sql`
      INSERT INTO dispatch_outcomes (
        run_id, parent_run_id, agent, work_item_id, dispatch_type,
        status, summary, files_changed, decisions, commits,
        forest_writes, duration_ms, tokens_in, tokens_out, cost_usd
      ) VALUES (
        ${outcome.run_id},
        ${outcome.parent_run_id ?? null},
        ${outcome.agent},
        ${outcome.work_item_id ?? null},
        ${outcome.dispatch_type},
        ${outcome.status},
        ${outcome.summary ?? null},
        ${outcome.files_changed ?? []},
        ${outcome.decisions ?? []},
        ${outcome.commits ?? []},
        ${outcome.forest_writes ?? []},
        ${outcome.duration_ms ?? null},
        ${outcome.tokens_in ?? null},
        ${outcome.tokens_out ?? null},
        ${outcome.cost_usd ?? null}
      )
      ON CONFLICT (run_id) DO UPDATE SET
        status = EXCLUDED.status,
        summary = EXCLUDED.summary,
        files_changed = EXCLUDED.files_changed,
        decisions = EXCLUDED.decisions,
        commits = EXCLUDED.commits,
        forest_writes = EXCLUDED.forest_writes,
        duration_ms = EXCLUDED.duration_ms,
        tokens_in = EXCLUDED.tokens_in,
        tokens_out = EXCLUDED.tokens_out,
        cost_usd = EXCLUDED.cost_usd
    `;
    logger.info("Outcome written", { run_id: outcome.run_id, agent: outcome.agent, status: outcome.status });
  } catch (err) {
    logger.error("Failed to write outcome", { run_id: outcome.run_id, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function readOutcome(runId: string): Promise<DispatchOutcomeRow | null> {
  try {
    const sql = await getSql();
    const rows = await sql`
      SELECT * FROM dispatch_outcomes WHERE run_id = ${runId}
    `;
    if (rows.length === 0) return null;
    return rows[0] as unknown as DispatchOutcomeRow;
  } catch (err) {
    logger.error("Failed to read outcome", { run_id: runId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export async function readOutcomeWithParticipants(runId: string): Promise<{
  outcome: DispatchOutcomeRow;
  participants: DispatchOutcomeRow[];
} | null> {
  try {
    const sql = await getSql();
    const [outcome] = await sql`
      SELECT * FROM dispatch_outcomes WHERE run_id = ${runId}
    `;
    if (!outcome) return null;

    const participants = await sql`
      SELECT * FROM dispatch_outcomes
      WHERE parent_run_id = ${runId}
      ORDER BY created_at ASC
    `;

    return {
      outcome: outcome as unknown as DispatchOutcomeRow,
      participants: participants as unknown as DispatchOutcomeRow[],
    };
  } catch (err) {
    logger.error("Failed to read outcome with participants", { run_id: runId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export async function getRecentOutcomes(hours = 24, limit = 50): Promise<DispatchOutcomeRow[]> {
  try {
    const sql = await getSql();
    const rows = await sql`
      SELECT * FROM dispatch_outcomes
      WHERE created_at > NOW() - INTERVAL '1 hour' * ${hours}
        AND parent_run_id IS NULL
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows as unknown as DispatchOutcomeRow[];
  } catch (err) {
    logger.error("Failed to get recent outcomes", { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}
