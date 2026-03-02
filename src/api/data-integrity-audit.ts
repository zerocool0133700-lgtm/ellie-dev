/**
 * Data Integrity Audit (ELLIE-406 automation)
 *
 * Runs the same 4 checks performed manually during the Feb 23-28 incident review:
 *   1. ES vs Supabase message count cross-reference per day
 *   2. Orphaned messages (null conversation_id) per day
 *   3. Conversation stated vs actual message count integrity
 *   4. Per-day summary report
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
}

export interface AuditIssue {
  type: "es_mismatch" | "orphaned_messages" | "broken_conv_count";
  date: string;
  detail: string;
  count: number;
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
    const [sbCount, esCount_, orphaned, convResult] = await Promise.all([
      sbMessageCount(supabase, from, to),
      esCount(from, to),
      sbOrphanCount(supabase, from, to),
      checkConvIntegrity(supabase, from, to),
    ]);

    const esMatch = esCount_ === -1 ? true : sbCount === esCount_; // skip ES check if ES unavailable
    const stats: DailyStats = {
      date,
      sbMessages: sbCount,
      esMessages: esCount_,
      esMatch,
      orphaned,
      conversations: convResult.total,
      brokenConvs: convResult.broken,
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
  }

  const totals = {
    sbMessages: daily.reduce((s, d) => s + Math.max(d.sbMessages, 0), 0),
    esMessages: daily.reduce((s, d) => s + Math.max(d.esMessages, 0), 0),
    orphaned: daily.reduce((s, d) => s + Math.max(d.orphaned, 0), 0),
    brokenConvs: daily.reduce((s, d) => s + Math.max(d.brokenConvs, 0), 0),
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
      `Totals: ${totals.sbMessages} SB msgs, ${totals.orphaned} orphaned, ${totals.brokenConvs} broken convs.`
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
    `Audit complete: ${issues.length} issue(s), ${totals.orphaned} orphaned, ${totals.brokenConvs} broken convs`
  );

  return result;
}

// ── Pretty-print for CLI ──────────────────────────────────────

export function formatAuditReport(result: AuditResult): string {
  const lines: string[] = [
    `Data Integrity Audit — ${result.ranAt.slice(0, 10)}`,
    `Lookback: ${result.lookbackDays} days  |  Status: ${result.clean ? "✅ CLEAN" : "⚠️  ISSUES FOUND"}`,
    "",
    "┌──────────────┬────────┬────────┬──────────┬────────┬──────────┐",
    "│ Date         │ SB msg │ ES msg │ ES match │ Orphan │ BrokenCV │",
    "├──────────────┼────────┼────────┼──────────┼────────┼──────────┤",
  ];

  for (const d of result.daily) {
    const es = d.esMessages === -1 ? "  N/A " : String(d.esMessages).padStart(6);
    const match = d.esMessages === -1 ? "  N/A  " : d.esMatch ? "  ✅   " : "  ❌   ";
    lines.push(
      `│ ${d.date} │ ${String(d.sbMessages).padStart(6)} │${es} │${match} │ ${String(d.orphaned).padStart(6)} │ ${String(d.brokenConvs).padStart(8)} │`
    );
  }

  lines.push("└──────────────┴────────┴────────┴──────────┴────────┴──────────┘", "");

  if (result.issues.length > 0) {
    lines.push("Issues:");
    for (const issue of result.issues) {
      lines.push(`  ⚠️  [${issue.date}] ${issue.detail}`);
    }
    lines.push("");
  }

  lines.push(
    `Totals: ${result.totals.sbMessages} SB messages | ${result.totals.orphaned} orphaned | ${result.totals.brokenConvs} broken conv counts`
  );

  return lines.join("\n");
}
