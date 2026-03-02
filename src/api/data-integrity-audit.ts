/**
 * Data Integrity Audit (ELLIE-406 → ELLIE-412)
 *
 * Six checks for ES ↔ Supabase data integrity:
 *   1. ES vs Supabase message count cross-reference per day
 *   2. Orphaned messages (null conversation_id) per day
 *   3. Conversation stated vs actual message count integrity
 *   4. ID-level cross-reference — messages in ES but not SB, and vice versa
 *   5. Error log scan — save failures in ellie-logs for the audit window
 *   6. Per-day summary report
 *
 * Run weekly (Sunday 11 PM CST) alongside the channel gardener.
 * Run on-demand via:  bun run audit:data-integrity
 *                      GET /api/audit/data-integrity
 */

import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "../logger.ts";

const logger = log.child("data-integrity-audit");
const ES_URL = process.env.ELASTICSEARCH_URL || "";

// History file for trend tracking
const DATA_DIR = join(import.meta.dir, "../../data");
const HISTORY_FILE = join(DATA_DIR, "audit-history.jsonl");

// ── Types ─────────────────────────────────────────────────────

export interface DailyStats {
  date: string; // YYYY-MM-DD
  sbMessages: number;
  esMessages: number;
  esMatch: boolean;
  orphaned: number;
  conversations: number;
  brokenConvs: number; // conversations where stated != actual count
  esOnlyIds: string[]; // message IDs in ES but not Supabase
  sbOnlyIds: string[]; // message IDs in Supabase but not ES
  saveErrors: number; // error/warn log entries related to save failures
}

export interface AuditIssue {
  type: "es_mismatch" | "orphaned_messages" | "broken_conv_count" | "id_mismatch" | "save_errors";
  date: string;
  detail: string;
  count: number;
  ids?: string[]; // affected message IDs (for id_mismatch)
}

export interface AuditResult {
  clean: boolean;
  ranAt: string;
  lookbackDays: number;
  daily: DailyStats[];
  issues: AuditIssue[];
  totals: {
    sbMessages: number;
    esMessages: number;
    orphaned: number;
    brokenConvs: number;
    esOnly: number;
    sbOnly: number;
    saveErrors: number;
  };
  summary: string;
}

// ── Elasticsearch helpers ──────────────────────────────────────

async function esCount(from: string, to: string): Promise<number> {
  if (!ES_URL) return -1;
  try {
    const res = await fetch(`${ES_URL}/ellie-messages/_count`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        query: {
          range: {
            created_at: { gte: from, lt: to },
          },
        },
      }),
    });
    if (!res.ok) return -1;
    const data = (await res.json()) as { count: number };
    return data.count;
  } catch {
    return -1;
  }
}

/**
 * Fetch all message IDs from ES for a date range (scrolling if needed).
 * Returns empty set if ES is unavailable.
 */
async function esMessageIds(from: string, to: string): Promise<Set<string>> {
  if (!ES_URL) return new Set();
  const ids = new Set<string>();
  try {
    // Use scroll API for large result sets
    const size = 5000;
    let scrollId: string | undefined;
    const firstRes = await fetch(`${ES_URL}/ellie-messages/_search?scroll=1m`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        query: { range: { created_at: { gte: from, lt: to } } },
        _source: false,
        size,
      }),
    });
    if (!firstRes.ok) return ids;
    const firstData = (await firstRes.json()) as {
      _scroll_id?: string;
      hits?: { hits?: Array<{ _id: string }> };
    };
    scrollId = firstData._scroll_id;
    for (const hit of firstData.hits?.hits ?? []) ids.add(hit._id);

    // Continue scrolling if there are more results
    while (scrollId && firstData.hits?.hits && firstData.hits.hits.length >= size) {
      const scrollRes = await fetch(`${ES_URL}/_search/scroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ scroll: "1m", scroll_id: scrollId }),
      });
      if (!scrollRes.ok) break;
      const scrollData = (await scrollRes.json()) as {
        _scroll_id?: string;
        hits?: { hits?: Array<{ _id: string }> };
      };
      const hits = scrollData.hits?.hits ?? [];
      if (hits.length === 0) break;
      for (const hit of hits) ids.add(hit._id);
      scrollId = scrollData._scroll_id;
      if (hits.length < size) break;
    }

    // Clean up scroll context
    if (scrollId) {
      fetch(`${ES_URL}/_search/scroll`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scroll_id: scrollId }),
      }).catch(() => {});
    }
  } catch {
    logger.warn("ES message ID fetch failed");
  }
  return ids;
}

/**
 * Scan ellie-logs for save/write failures in a date range.
 * Returns count of error/warn entries related to message persistence.
 */
async function esSaveErrorCount(from: string, to: string): Promise<number> {
  if (!ES_URL) return -1;
  try {
    const res = await fetch(`${ES_URL}/ellie-logs/_count`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        query: {
          bool: {
            must: [
              { range: { timestamp: { gte: from, lt: to } } },
              { terms: { level: ["error", "warn"] } },
              {
                bool: {
                  should: [
                    { match_phrase: { message: "save" } },
                    { match_phrase: { message: "insert" } },
                    { match_phrase: { message: "write" } },
                    { match_phrase: { message: "persist" } },
                    { match_phrase: { "module": "message-sender" } },
                    { match_phrase: { "module": "conversations" } },
                  ],
                  minimum_should_match: 1,
                },
              },
            ],
          },
        },
      }),
    });
    if (!res.ok) return -1;
    const data = (await res.json()) as { count: number };
    return data.count;
  } catch {
    return -1;
  }
}

// ── Supabase helpers ──────────────────────────────────────────

async function sbMessageCount(
  supabase: SupabaseClient,
  from: string,
  to: string
): Promise<number> {
  const { count, error } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .gte("created_at", from)
    .lt("created_at", to);

  if (error) {
    logger.warn("SB message count error", error);
    return -1;
  }
  return count ?? 0;
}

async function sbOrphanCount(
  supabase: SupabaseClient,
  from: string,
  to: string
): Promise<number> {
  const { count, error } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .is("conversation_id", null)
    .gte("created_at", from)
    .lt("created_at", to);

  if (error) {
    logger.warn("SB orphan count error", error);
    return -1;
  }
  return count ?? 0;
}

/**
 * Fetch all message IDs from Supabase for a date range.
 * Uses pagination to handle large result sets.
 */
async function sbMessageIds(
  supabase: SupabaseClient,
  from: string,
  to: string
): Promise<Set<string>> {
  const ids = new Set<string>();
  const pageSize = 1000;
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from("messages")
      .select("id")
      .gte("created_at", from)
      .lt("created_at", to)
      .range(offset, offset + pageSize - 1);

    if (error) {
      logger.warn("SB message ID fetch error", error);
      break;
    }
    for (const row of data ?? []) ids.add(row.id);
    hasMore = (data?.length ?? 0) === pageSize;
    offset += pageSize;
  }

  return ids;
}

/**
 * Check conversation count integrity for a date window.
 * Returns conversations where stated message_count != actual linked message count.
 */
async function checkConvIntegrity(
  supabase: SupabaseClient,
  from: string,
  to: string
): Promise<{ total: number; broken: number }> {
  // Get all conversations in the window
  const { data: convs, error: convsErr } = await supabase
    .from("conversations")
    .select("id, message_count")
    .gte("started_at", from)
    .lt("started_at", to);

  if (convsErr || !convs || convs.length === 0) {
    if (convsErr) logger.warn("Conv fetch error", convsErr);
    return { total: 0, broken: 0 };
  }

  // Get all messages linked to these conversations in one query, group in JS
  const convIds = convs.map((c) => c.id);
  const { data: msgs, error: msgsErr } = await supabase
    .from("messages")
    .select("conversation_id")
    .in("conversation_id", convIds);

  if (msgsErr) {
    logger.warn("Messages fetch error for integrity check", msgsErr);
    return { total: convs.length, broken: -1 };
  }

  // Build actual count map
  const actualCounts: Record<string, number> = {};
  for (const m of msgs ?? []) {
    if (m.conversation_id) {
      actualCounts[m.conversation_id] = (actualCounts[m.conversation_id] ?? 0) + 1;
    }
  }

  let broken = 0;
  for (const c of convs) {
    const actual = actualCounts[c.id] ?? 0;
    if (c.message_count !== actual) broken++;
  }

  return { total: convs.length, broken };
}

// ── Main audit function ────────────────────────────────────────

export async function runDataIntegrityAudit(
  supabase: SupabaseClient,
  opts?: { lookbackDays?: number }
): Promise<AuditResult> {
  const lookbackDays = opts?.lookbackDays ?? 7;
  const ranAt = new Date().toISOString();
  const daily: DailyStats[] = [];
  const issues: AuditIssue[] = [];

  logger.info(`Starting data integrity audit (${lookbackDays} days)`);

  // Build date buckets
  const now = new Date();
  for (let d = lookbackDays - 1; d >= 0; d--) {
    const dayStart = new Date(now);
    dayStart.setUTCDate(now.getUTCDate() - d);
    dayStart.setUTCHours(0, 0, 0, 0);

    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayStart.getUTCDate() + 1);

    const from = dayStart.toISOString();
    const to = dayEnd.toISOString();
    const date = dayStart.toISOString().slice(0, 10);

    // Run all checks for this day in parallel
    const [sbCount, esCount_, orphaned, convResult, esIds, sbIds, saveErrs] = await Promise.all([
      sbMessageCount(supabase, from, to),
      esCount(from, to),
      sbOrphanCount(supabase, from, to),
      checkConvIntegrity(supabase, from, to),
      esMessageIds(from, to),
      sbMessageIds(supabase, from, to),
      esSaveErrorCount(from, to),
    ]);

    // ID-level cross-reference
    const esOnlyIds: string[] = [];
    const sbOnlyIds: string[] = [];
    if (esIds.size > 0 || sbIds.size > 0) {
      for (const id of esIds) {
        if (!sbIds.has(id)) esOnlyIds.push(id);
      }
      for (const id of sbIds) {
        if (!esIds.has(id)) sbOnlyIds.push(id);
      }
    }

    const esMatch = esCount_ === -1 ? true : sbCount === esCount_; // skip ES check if ES unavailable
    const stats: DailyStats = {
      date,
      sbMessages: sbCount,
      esMessages: esCount_,
      esMatch,
      orphaned,
      conversations: convResult.total,
      brokenConvs: convResult.broken,
      esOnlyIds,
      sbOnlyIds,
      saveErrors: saveErrs,
    };
    daily.push(stats);

    // Collect issues
    if (!esMatch && esCount_ !== -1) {
      issues.push({
        type: "es_mismatch",
        date,
        detail: `ES has ${esCount_} messages, SB has ${sbCount}`,
        count: Math.abs(esCount_ - sbCount),
      });
    }
    if (orphaned > 0) {
      issues.push({
        type: "orphaned_messages",
        date,
        detail: `${orphaned} messages with null conversation_id`,
        count: orphaned,
      });
    }
    if (convResult.broken > 0) {
      issues.push({
        type: "broken_conv_count",
        date,
        detail: `${convResult.broken} of ${convResult.total} conversations have mismatched message_count`,
        count: convResult.broken,
      });
    }
    if (esOnlyIds.length > 0) {
      issues.push({
        type: "id_mismatch",
        date,
        detail: `${esOnlyIds.length} message(s) in ES but not Supabase`,
        count: esOnlyIds.length,
        ids: esOnlyIds.slice(0, 20), // cap at 20 for report readability
      });
    }
    if (sbOnlyIds.length > 0) {
      issues.push({
        type: "id_mismatch",
        date,
        detail: `${sbOnlyIds.length} message(s) in Supabase but not ES`,
        count: sbOnlyIds.length,
        ids: sbOnlyIds.slice(0, 20),
      });
    }
    if (saveErrs > 0) {
      issues.push({
        type: "save_errors",
        date,
        detail: `${saveErrs} save-related error/warn entries in ellie-logs`,
        count: saveErrs,
      });
    }
  }

  const totals = {
    sbMessages: daily.reduce((s, d) => s + Math.max(d.sbMessages, 0), 0),
    esMessages: daily.reduce((s, d) => s + Math.max(d.esMessages, 0), 0),
    orphaned: daily.reduce((s, d) => s + Math.max(d.orphaned, 0), 0),
    brokenConvs: daily.reduce((s, d) => s + Math.max(d.brokenConvs, 0), 0),
    esOnly: daily.reduce((s, d) => s + d.esOnlyIds.length, 0),
    sbOnly: daily.reduce((s, d) => s + d.sbOnlyIds.length, 0),
    saveErrors: daily.reduce((s, d) => s + Math.max(d.saveErrors, 0), 0),
  };

  const clean = issues.length === 0;

  // Build human-readable summary
  const summaryLines: string[] = [];
  if (clean) {
    summaryLines.push(
      `✅ All clear — ${lookbackDays}-day audit passed. ${totals.sbMessages} messages, 0 issues.`
    );
  } else {
    summaryLines.push(`⚠️ ${issues.length} issue(s) found in ${lookbackDays}-day audit:`);
    for (const issue of issues) {
      summaryLines.push(`  • [${issue.date}] ${issue.detail}`);
    }
    summaryLines.push(
      `Totals: ${totals.sbMessages} SB msgs, ${totals.orphaned} orphaned, ${totals.brokenConvs} broken convs, ${totals.esOnly} ES-only, ${totals.sbOnly} SB-only, ${totals.saveErrors} save errors.`
    );
  }
  const summary = summaryLines.join("\n");

  const result: AuditResult = {
    clean,
    ranAt,
    lookbackDays,
    daily,
    issues,
    totals,
    summary,
  };

  // Persist to history file for trend tracking
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(HISTORY_FILE, JSON.stringify(result) + "\n", "utf8");
  } catch (err) {
    logger.warn("Failed to write audit history", err);
  }

  logger.info(
    `Audit complete: ${issues.length} issue(s), ${totals.orphaned} orphaned, ${totals.brokenConvs} broken convs, ${totals.esOnly + totals.sbOnly} ID mismatches, ${totals.saveErrors} save errors`
  );

  return result;
}

// ── Pretty-print for CLI ──────────────────────────────────────

export function formatAuditReport(result: AuditResult): string {
  const lines: string[] = [
    `Data Integrity Audit — ${result.ranAt.slice(0, 10)}`,
    `Lookback: ${result.lookbackDays} days  |  Status: ${result.clean ? "✅ CLEAN" : "⚠️  ISSUES FOUND"}`,
    "",
    "┌──────────────┬────────┬────────┬──────────┬────────┬──────────┬─────────┬─────────┬────────┐",
    "│ Date         │ SB msg │ ES msg │ ES match │ Orphan │ BrokenCV │ ES-only │ SB-only │ Errors │",
    "├──────────────┼────────┼────────┼──────────┼────────┼──────────┼─────────┼─────────┼────────┤",
  ];

  for (const d of result.daily) {
    const es = d.esMessages === -1 ? "  N/A " : String(d.esMessages).padStart(6);
    const match = d.esMessages === -1 ? "  N/A  " : d.esMatch ? "  ✅   " : "  ❌   ";
    const esOnly = String(d.esOnlyIds.length).padStart(7);
    const sbOnly = String(d.sbOnlyIds.length).padStart(7);
    const errs = d.saveErrors === -1 ? "  N/A " : String(d.saveErrors).padStart(6);
    lines.push(
      `│ ${d.date} │ ${String(d.sbMessages).padStart(6)} │${es} │${match} │ ${String(d.orphaned).padStart(6)} │ ${String(d.brokenConvs).padStart(8)} │${esOnly} │${sbOnly} │${errs} │`
    );
  }

  lines.push("└──────────────┴────────┴────────┴──────────┴────────┴──────────┴─────────┴─────────┴────────┘", "");

  if (result.issues.length > 0) {
    lines.push("Issues:");
    for (const issue of result.issues) {
      lines.push(`  ⚠️  [${issue.date}] ${issue.detail}`);
      if (issue.ids && issue.ids.length > 0) {
        lines.push(`       IDs: ${issue.ids.slice(0, 5).join(", ")}${issue.ids.length > 5 ? ` ... (${issue.ids.length} total)` : ""}`);
      }
    }
    lines.push("");
  }

  lines.push(
    `Totals: ${result.totals.sbMessages} SB messages | ${result.totals.orphaned} orphaned | ${result.totals.brokenConvs} broken conv counts | ${result.totals.esOnly} ES-only | ${result.totals.sbOnly} SB-only | ${result.totals.saveErrors} save errors`
  );

  return lines.join("\n");
}
