/**
 * Dispatch Pattern Analyzer Tests — ELLIE-587
 *
 * Validates:
 *  - Journal markdown parsing into structured entries
 *  - Start/end pair matching with duration calculation
 *  - Duration pattern detection by agent
 *  - Failure rate pattern detection by agent
 *  - Agent affinity (success rate) pattern detection
 *  - Confidence scaling by sample size
 *  - Forest finding payload construction
 *  - Full pipeline with mocked I/O
 */

import { describe, it, expect, mock } from "bun:test";
import {
  parseJournalEntries,
  matchDispatchPairs,
  detectDurationPatterns,
  detectFailureRatePatterns,
  detectAgentAffinityPatterns,
  analyzePatterns,
  confidenceForSampleSize,
  buildPatternFindings,
  writePatternsToForest,
  analyzeDispatchPatterns,
  type ParsedEntry,
  type CompletedDispatch,
  type ForestPatternFinding,
} from "../src/dispatch-pattern-analyzer.ts";

// Mock relay-config
mock.module("../src/relay-config.ts", () => ({
  RELAY_BASE_URL: "http://test-relay:3001",
}));

// ── Sample journal markdown ─────────────────────────────────────────────────

const SAMPLE_JOURNAL = `---
type: dispatch-journal
date: 2026-03-05
---

# Dispatch Journal — 2026-03-05

### ELLIE-100 — Started

- **Time:** 2026-03-05T10:00:00.000Z
- **Title:** Fix auth bug
- **Session:** \`session-1\`
- **Agent:** dev
- **Status:** in-progress

### ELLIE-100 — Completed

- **Time:** 2026-03-05T10:05:00.000Z
- **Outcome:** completed
- **Summary:** Fixed the auth bug

### ELLIE-101 — Started

- **Time:** 2026-03-05T11:00:00.000Z
- **Title:** Refactor parser
- **Session:** \`session-2\`
- **Agent:** dev
- **Status:** in-progress

### ELLIE-101 — Completed

- **Time:** 2026-03-05T11:10:00.000Z
- **Outcome:** completed
- **Duration:** 10 minutes
- **Summary:** Refactored parser module

### ELLIE-102 — Started

- **Time:** 2026-03-05T12:00:00.000Z
- **Title:** Deploy widget
- **Session:** \`session-3\`
- **Agent:** general
- **Status:** in-progress

### ELLIE-102 — Timeout

- **Time:** 2026-03-05T12:30:00.000Z
- **Outcome:** timeout
- **Agent:** general
- **Duration:** 30 minutes

### ELLIE-103 — Started

- **Time:** 2026-03-05T13:00:00.000Z
- **Title:** Research API options
- **Session:** \`session-4\`
- **Agent:** research
- **Status:** in-progress

### ELLIE-103 — Completed

- **Time:** 2026-03-05T13:15:00.000Z
- **Outcome:** completed
- **Summary:** Found best API
`;

// ── parseJournalEntries ─────────────────────────────────────────────────────

describe("parseJournalEntries", () => {
  it("parses all entries from a journal file", () => {
    const entries = parseJournalEntries(SAMPLE_JOURNAL);
    expect(entries.length).toBe(8);
  });

  it("extracts work item IDs", () => {
    const entries = parseJournalEntries(SAMPLE_JOURNAL);
    const ids = entries.map(e => e.workItemId);
    expect(ids).toContain("ELLIE-100");
    expect(ids).toContain("ELLIE-101");
    expect(ids).toContain("ELLIE-102");
    expect(ids).toContain("ELLIE-103");
  });

  it("parses start entries with title and agent", () => {
    const entries = parseJournalEntries(SAMPLE_JOURNAL);
    const start = entries.find(e => e.workItemId === "ELLIE-100" && e.event === "started");
    expect(start).toBeDefined();
    expect(start!.title).toBe("Fix auth bug");
    expect(start!.agent).toBe("dev");
    expect(start!.sessionId).toBe("session-1");
  });

  it("parses end entries with outcome", () => {
    const entries = parseJournalEntries(SAMPLE_JOURNAL);
    const end = entries.find(e => e.workItemId === "ELLIE-100" && e.event === "completed");
    expect(end).toBeDefined();
    expect(end!.summary).toBe("Fixed the auth bug");
  });

  it("parses explicit duration", () => {
    const entries = parseJournalEntries(SAMPLE_JOURNAL);
    const end = entries.find(e => e.workItemId === "ELLIE-101" && e.event === "completed");
    expect(end!.durationMinutes).toBe(10);
  });

  it("parses timeout outcome", () => {
    const entries = parseJournalEntries(SAMPLE_JOURNAL);
    const end = entries.find(e => e.workItemId === "ELLIE-102" && e.event === "timeout");
    expect(end).toBeDefined();
  });

  it("returns empty array for empty input", () => {
    expect(parseJournalEntries("")).toEqual([]);
    expect(parseJournalEntries("# Just a header")).toEqual([]);
  });
});

// ── matchDispatchPairs ──────────────────────────────────────────────────────

describe("matchDispatchPairs", () => {
  it("matches start/end pairs into completed dispatches", () => {
    const entries = parseJournalEntries(SAMPLE_JOURNAL);
    const dispatches = matchDispatchPairs(entries);
    expect(dispatches.length).toBe(4);
  });

  it("calculates duration from timestamps when not explicit", () => {
    const entries = parseJournalEntries(SAMPLE_JOURNAL);
    const dispatches = matchDispatchPairs(entries);
    const d100 = dispatches.find(d => d.workItemId === "ELLIE-100");
    expect(d100!.durationMinutes).toBe(5); // 10:00 → 10:05
  });

  it("uses explicit duration when provided", () => {
    const entries = parseJournalEntries(SAMPLE_JOURNAL);
    const dispatches = matchDispatchPairs(entries);
    const d101 = dispatches.find(d => d.workItemId === "ELLIE-101");
    expect(d101!.durationMinutes).toBe(10);
  });

  it("inherits agent from start entry if not on end entry", () => {
    const entries = parseJournalEntries(SAMPLE_JOURNAL);
    const dispatches = matchDispatchPairs(entries);
    const d100 = dispatches.find(d => d.workItemId === "ELLIE-100");
    expect(d100!.agent).toBe("dev");
  });

  it("preserves outcome from end entry", () => {
    const entries = parseJournalEntries(SAMPLE_JOURNAL);
    const dispatches = matchDispatchPairs(entries);
    const d102 = dispatches.find(d => d.workItemId === "ELLIE-102");
    expect(d102!.outcome).toBe("timeout");
  });

  it("returns empty array for no entries", () => {
    expect(matchDispatchPairs([])).toEqual([]);
  });

  it("skips orphaned start entries (no matching end)", () => {
    const entries: ParsedEntry[] = [
      { workItemId: "ELLIE-999", event: "started", agent: "dev" },
    ];
    expect(matchDispatchPairs(entries)).toEqual([]);
  });
});

// ── detectDurationPatterns ──────────────────────────────────────────────────

describe("detectDurationPatterns", () => {
  it("computes average duration per agent for completed dispatches", () => {
    const dispatches: CompletedDispatch[] = [
      { workItemId: "E-1", agent: "dev", outcome: "completed", durationMinutes: 10 },
      { workItemId: "E-2", agent: "dev", outcome: "completed", durationMinutes: 20 },
      { workItemId: "E-3", agent: "research", outcome: "completed", durationMinutes: 30 },
    ];
    const patterns = detectDurationPatterns(dispatches);
    const dev = patterns.find(p => p.agent === "dev");
    expect(dev!.avgMinutes).toBe(15);
    expect(dev!.count).toBe(2);
  });

  it("excludes non-completed dispatches", () => {
    const dispatches: CompletedDispatch[] = [
      { workItemId: "E-1", agent: "dev", outcome: "completed", durationMinutes: 10 },
      { workItemId: "E-2", agent: "dev", outcome: "timeout", durationMinutes: 60 },
    ];
    const patterns = detectDurationPatterns(dispatches);
    const dev = patterns.find(p => p.agent === "dev");
    expect(dev!.avgMinutes).toBe(10);
    expect(dev!.count).toBe(1);
  });

  it("skips dispatches without duration", () => {
    const dispatches: CompletedDispatch[] = [
      { workItemId: "E-1", agent: "dev", outcome: "completed" },
    ];
    expect(detectDurationPatterns(dispatches)).toEqual([]);
  });

  it("skips dispatches without agent", () => {
    const dispatches: CompletedDispatch[] = [
      { workItemId: "E-1", outcome: "completed", durationMinutes: 10 },
    ];
    expect(detectDurationPatterns(dispatches)).toEqual([]);
  });
});

// ── detectFailureRatePatterns ───────────────────────────────────────────────

describe("detectFailureRatePatterns", () => {
  it("computes failure rate per agent", () => {
    const dispatches: CompletedDispatch[] = [
      { workItemId: "E-1", agent: "dev", outcome: "completed" },
      { workItemId: "E-2", agent: "dev", outcome: "timeout" },
      { workItemId: "E-3", agent: "dev", outcome: "completed" },
      { workItemId: "E-4", agent: "general", outcome: "crashed" },
    ];
    const patterns = detectFailureRatePatterns(dispatches);
    const dev = patterns.find(p => p.agent === "dev");
    expect(dev!.failureRate).toBeCloseTo(0.33, 1);
    expect(dev!.totalDispatches).toBe(3);
    expect(dev!.failures).toBe(1);

    const general = patterns.find(p => p.agent === "general");
    expect(general!.failureRate).toBe(1);
  });

  it("returns 0 failure rate when all succeed", () => {
    const dispatches: CompletedDispatch[] = [
      { workItemId: "E-1", agent: "dev", outcome: "completed" },
      { workItemId: "E-2", agent: "dev", outcome: "completed" },
    ];
    const patterns = detectFailureRatePatterns(dispatches);
    expect(patterns[0].failureRate).toBe(0);
  });
});

// ── detectAgentAffinityPatterns ─────────────────────────────────────────────

describe("detectAgentAffinityPatterns", () => {
  it("computes success rate per agent", () => {
    const dispatches: CompletedDispatch[] = [
      { workItemId: "E-1", agent: "dev", outcome: "completed" },
      { workItemId: "E-2", agent: "dev", outcome: "completed" },
      { workItemId: "E-3", agent: "dev", outcome: "timeout" },
      { workItemId: "E-4", agent: "research", outcome: "completed" },
    ];
    const patterns = detectAgentAffinityPatterns(dispatches);
    const dev = patterns.find(p => p.agent === "dev");
    expect(dev!.successRate).toBeCloseTo(0.67, 1);
    expect(dev!.completions).toBe(2);
    expect(dev!.failures).toBe(1);

    const research = patterns.find(p => p.agent === "research");
    expect(research!.successRate).toBe(1);
  });
});

// ── confidenceForSampleSize ─────────────────────────────────────────────────

describe("confidenceForSampleSize", () => {
  it("returns 0.5 for very small samples", () => {
    expect(confidenceForSampleSize(1)).toBe(0.5);
    expect(confidenceForSampleSize(4)).toBe(0.5);
  });

  it("returns 0.6 for 5-9 samples", () => {
    expect(confidenceForSampleSize(5)).toBe(0.6);
    expect(confidenceForSampleSize(9)).toBe(0.6);
  });

  it("returns 0.7 for 10-19 samples", () => {
    expect(confidenceForSampleSize(10)).toBe(0.7);
    expect(confidenceForSampleSize(19)).toBe(0.7);
  });

  it("returns 0.8 for 20-49 samples", () => {
    expect(confidenceForSampleSize(20)).toBe(0.8);
    expect(confidenceForSampleSize(49)).toBe(0.8);
  });

  it("returns 0.9 for 50+ samples", () => {
    expect(confidenceForSampleSize(50)).toBe(0.9);
    expect(confidenceForSampleSize(1000)).toBe(0.9);
  });
});

// ── buildPatternFindings ────────────────────────────────────────────────────

describe("buildPatternFindings", () => {
  it("builds duration findings for agents with 2+ data points", () => {
    const patterns = analyzePatterns([
      { workItemId: "E-1", agent: "dev", outcome: "completed", durationMinutes: 10 },
      { workItemId: "E-2", agent: "dev", outcome: "completed", durationMinutes: 20 },
    ]);
    const findings = buildPatternFindings(patterns);
    const duration = findings.find(f => f.metadata.pattern_type === "duration");
    expect(duration).toBeDefined();
    expect(duration!.content).toContain("dev");
    expect(duration!.content).toContain("15 minutes");
    expect(duration!.type).toBe("finding");
    expect(duration!.scope_path).toBe("2/1");
  });

  it("skips duration findings with < 2 data points", () => {
    const patterns = analyzePatterns([
      { workItemId: "E-1", agent: "dev", outcome: "completed", durationMinutes: 10 },
    ]);
    const findings = buildPatternFindings(patterns);
    expect(findings.filter(f => f.metadata.pattern_type === "duration")).toEqual([]);
  });

  it("builds failure rate findings when failures exist", () => {
    const patterns = analyzePatterns([
      { workItemId: "E-1", agent: "dev", outcome: "completed" },
      { workItemId: "E-2", agent: "dev", outcome: "timeout" },
    ]);
    const findings = buildPatternFindings(patterns);
    const fr = findings.find(f => f.metadata.pattern_type === "failure-rate");
    expect(fr).toBeDefined();
    expect(fr!.content).toContain("50%");
  });

  it("skips failure rate findings when no failures", () => {
    const patterns = analyzePatterns([
      { workItemId: "E-1", agent: "dev", outcome: "completed" },
      { workItemId: "E-2", agent: "dev", outcome: "completed" },
    ]);
    const findings = buildPatternFindings(patterns);
    expect(findings.filter(f => f.metadata.pattern_type === "failure-rate")).toEqual([]);
  });

  it("builds agent affinity findings for 3+ dispatches", () => {
    const patterns = analyzePatterns([
      { workItemId: "E-1", agent: "dev", outcome: "completed" },
      { workItemId: "E-2", agent: "dev", outcome: "completed" },
      { workItemId: "E-3", agent: "dev", outcome: "timeout" },
    ]);
    const findings = buildPatternFindings(patterns);
    const aa = findings.find(f => f.metadata.pattern_type === "agent-affinity");
    expect(aa).toBeDefined();
    expect(aa!.content).toContain("67%");
  });

  it("skips agent affinity findings for < 3 dispatches", () => {
    const patterns = analyzePatterns([
      { workItemId: "E-1", agent: "dev", outcome: "completed" },
      { workItemId: "E-2", agent: "dev", outcome: "completed" },
    ]);
    const findings = buildPatternFindings(patterns);
    expect(findings.filter(f => f.metadata.pattern_type === "agent-affinity")).toEqual([]);
  });

  it("returns empty array when no patterns meet thresholds", () => {
    const patterns = analyzePatterns([]);
    expect(buildPatternFindings(patterns)).toEqual([]);
  });
});

// ── writePatternsToForest ───────────────────────────────────────────────────

describe("writePatternsToForest", () => {
  it("writes findings to Bridge API", async () => {
    const calls: string[] = [];
    const mockFetch = async (url: string | URL | Request) => {
      calls.push(url as string);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    const findings: ForestPatternFinding[] = [
      { content: "test1", type: "finding", scope_path: "2/1", confidence: 0.7, metadata: { source: "test", pattern_type: "duration", sample_size: 5 } },
      { content: "test2", type: "finding", scope_path: "2/1", confidence: 0.8, metadata: { source: "test", pattern_type: "failure-rate", sample_size: 10 } },
    ];

    const written = await writePatternsToForest(findings, mockFetch as typeof fetch);
    expect(written).toBe(2);
    expect(calls.length).toBe(2);
  });

  it("returns 0 for empty findings", async () => {
    const mockFetch = async () => new Response("ok", { status: 200 });
    const written = await writePatternsToForest([], mockFetch as typeof fetch);
    expect(written).toBe(0);
  });

  it("counts only successful writes", async () => {
    let callNum = 0;
    const mockFetch = async () => {
      callNum++;
      if (callNum === 1) return new Response("error", { status: 500 });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    const findings: ForestPatternFinding[] = [
      { content: "f1", type: "finding", scope_path: "2/1", confidence: 0.7, metadata: { source: "test", pattern_type: "duration", sample_size: 5 } },
      { content: "f2", type: "finding", scope_path: "2/1", confidence: 0.7, metadata: { source: "test", pattern_type: "duration", sample_size: 5 } },
    ];

    const written = await writePatternsToForest(findings, mockFetch as typeof fetch);
    expect(written).toBe(1);
  });

  it("handles network errors gracefully", async () => {
    const mockFetch = async () => { throw new Error("ECONNREFUSED"); };
    const findings: ForestPatternFinding[] = [
      { content: "f1", type: "finding", scope_path: "2/1", confidence: 0.7, metadata: { source: "test", pattern_type: "duration", sample_size: 5 } },
    ];
    const written = await writePatternsToForest(findings, mockFetch as typeof fetch);
    expect(written).toBe(0);
  });
});

// ── analyzeDispatchPatterns (full pipeline) ─────────────────────────────────

describe("analyzeDispatchPatterns", () => {
  it("runs full pipeline with mocked I/O", async () => {
    const mockReadDir = async () => ["2026-03-05.md"] as any;
    const mockReadFile = async () => SAMPLE_JOURNAL as any;
    const fetchCalls: string[] = [];
    const mockFetch = async (url: string | URL | Request) => {
      fetchCalls.push(url as string);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    const result = await analyzeDispatchPatterns(
      "/fake/river",
      mockFetch as typeof fetch,
      mockReadDir as typeof readdir,
      mockReadFile as typeof readFile,
    );

    expect(result.patterns.totalDispatches).toBe(4);
    expect(result.patterns.duration.length).toBeGreaterThan(0);
    expect(result.patterns.dateRange.earliest).toBe("2026-03-05");
    expect(result.patterns.dateRange.latest).toBe("2026-03-05");
  });

  it("returns empty patterns when no journal files exist", async () => {
    const mockReadDir = async () => { throw new Error("ENOENT"); };

    const result = await analyzeDispatchPatterns(
      "/fake/river",
      undefined,
      mockReadDir as typeof readdir,
    );

    expect(result.patterns.totalDispatches).toBe(0);
    expect(result.findingsWritten).toBe(0);
  });
});
