/**
 * ELLIE-514 — API layer tests: data integrity audit pure functions.
 *
 * Tests formatAuditReport() — a pure table formatter that takes an
 * AuditResult and returns a human-readable ASCII table with issue details.
 * No I/O, no Supabase, no Elasticsearch.
 */

import { describe, test, expect, mock } from "bun:test";

// ── Mock logger ───────────────────────────────────────────────────────────────

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { formatAuditReport } from "../src/api/data-integrity-audit.ts";
import type { AuditResult, DailyStats } from "../src/api/data-integrity-audit.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeDailyStats(overrides: Partial<DailyStats> = {}): DailyStats {
  return {
    date: "2026-03-04",
    sbMessages: 100,
    esMessages: 100,
    esMatch: true,
    orphaned: 0,
    conversations: 50,
    brokenConvs: 0,
    esOnlyIds: [],
    sbOnlyIds: [],
    saveErrors: 0,
    ...overrides,
  };
}

function makeCleanResult(overrides: Partial<AuditResult> = {}): AuditResult {
  return {
    clean: true,
    ranAt: "2026-03-04T10:00:00.000Z",
    lookbackDays: 1,
    daily: [makeDailyStats()],
    issues: [],
    totals: {
      sbMessages: 100, esMessages: 100,
      orphaned: 0, brokenConvs: 0,
      esOnly: 0, sbOnly: 0, saveErrors: 0,
    },
    summary: "✅ All clear — 1-day audit passed. 100 messages, 0 issues.",
    ...overrides,
  };
}

function makeIssueResult(): AuditResult {
  return {
    clean: false,
    ranAt: "2026-03-04T10:00:00.000Z",
    lookbackDays: 2,
    daily: [
      makeDailyStats({ date: "2026-03-03", sbMessages: 90, esMessages: 95, esMatch: false }),
      makeDailyStats({ date: "2026-03-04", orphaned: 3 }),
    ],
    issues: [
      {
        type: "es_mismatch",
        date: "2026-03-03",
        detail: "ES has 95 messages, SB has 90",
        count: 5,
      },
      {
        type: "orphaned_messages",
        date: "2026-03-04",
        detail: "3 messages with null conversation_id",
        count: 3,
      },
    ],
    totals: {
      sbMessages: 190, esMessages: 195,
      orphaned: 3, brokenConvs: 0,
      esOnly: 0, sbOnly: 0, saveErrors: 0,
    },
    summary: "⚠️ 2 issue(s) found in 2-day audit",
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("formatAuditReport — header", () => {
  test("includes the audit date extracted from ranAt", () => {
    expect(formatAuditReport(makeCleanResult())).toContain("2026-03-04");
  });

  test("includes lookback days in the header", () => {
    expect(formatAuditReport(makeCleanResult())).toContain("1 days");
  });

  test("shows CLEAN status for a clean result", () => {
    expect(formatAuditReport(makeCleanResult())).toContain("CLEAN");
  });

  test("shows ISSUES FOUND status for a non-clean result", () => {
    expect(formatAuditReport(makeIssueResult())).toContain("ISSUES FOUND");
  });
});

describe("formatAuditReport — table", () => {
  test("table header contains SB msg column", () => {
    expect(formatAuditReport(makeCleanResult())).toContain("SB msg");
  });

  test("table header contains ES msg column", () => {
    expect(formatAuditReport(makeCleanResult())).toContain("ES msg");
  });

  test("table header contains Orphan column", () => {
    expect(formatAuditReport(makeCleanResult())).toContain("Orphan");
  });

  test("daily row includes the date", () => {
    expect(formatAuditReport(makeCleanResult())).toContain("2026-03-04");
  });

  test("shows ✅ for matched ES count", () => {
    expect(formatAuditReport(makeCleanResult())).toContain("✅");
  });

  test("shows ❌ for mismatched ES count", () => {
    expect(formatAuditReport(makeIssueResult())).toContain("❌");
  });

  test("shows N/A when esMessages is -1 (ES unavailable)", () => {
    const result = makeCleanResult({
      daily: [makeDailyStats({ esMessages: -1 })],
    });
    expect(formatAuditReport(result)).toContain("N/A");
  });

  test("shows N/A in save errors column when saveErrors is -1", () => {
    const result = makeCleanResult({
      daily: [makeDailyStats({ saveErrors: -1 })],
    });
    expect(formatAuditReport(result)).toContain("N/A");
  });

  test("multiple daily rows all appear in output", () => {
    const result = makeIssueResult();
    const report = formatAuditReport(result);
    expect(report).toContain("2026-03-03");
    expect(report).toContain("2026-03-04");
  });
});

describe("formatAuditReport — issues section", () => {
  test("issues section present when there are issues", () => {
    const report = formatAuditReport(makeIssueResult());
    expect(report).toContain("Issues:");
  });

  test("issue detail text appears in issues section", () => {
    const report = formatAuditReport(makeIssueResult());
    expect(report).toContain("ES has 95 messages, SB has 90");
    expect(report).toContain("3 messages with null conversation_id");
  });

  test("no issues section when result is clean", () => {
    expect(formatAuditReport(makeCleanResult())).not.toContain("Issues:");
  });

  test("issue IDs appear when provided", () => {
    const result = makeCleanResult({
      clean: false,
      issues: [{
        type: "id_mismatch",
        date: "2026-03-04",
        detail: "2 message(s) in ES but not Supabase",
        count: 2,
        ids: ["abc123", "def456"],
      }],
    });
    const report = formatAuditReport(result);
    expect(report).toContain("abc123");
    expect(report).toContain("def456");
  });

  test("shows first 5 IDs then truncates with total count", () => {
    const ids = ["id1", "id2", "id3", "id4", "id5", "id6", "id7"];
    const result = makeCleanResult({
      clean: false,
      issues: [{
        type: "id_mismatch",
        date: "2026-03-04",
        detail: "7 message(s) in ES but not Supabase",
        count: 7,
        ids,
      }],
    });
    const report = formatAuditReport(result);
    expect(report).toContain("id1");
    expect(report).toContain("7 total");
    // id6 should NOT appear (only first 5 shown)
    expect(report).not.toContain("id6");
  });
});

describe("formatAuditReport — totals", () => {
  test("includes a Totals: line", () => {
    expect(formatAuditReport(makeCleanResult())).toContain("Totals:");
  });

  test("totals line mentions SB messages", () => {
    expect(formatAuditReport(makeCleanResult())).toContain("SB messages");
  });

  test("totals line includes orphaned count", () => {
    expect(formatAuditReport(makeCleanResult())).toContain("orphaned");
  });

  test("totals line includes broken conv counts", () => {
    expect(formatAuditReport(makeCleanResult())).toContain("broken conv counts");
  });
});
