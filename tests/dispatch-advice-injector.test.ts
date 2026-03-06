/**
 * ELLIE-571 — Dispatch Advice Injector Tests
 *
 * Tests the pure enrichment function and the effectful advice fetcher
 * that wires post-mortem learning into agent dispatch prompts.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mock logger + bridge-river ──────────────────────────────────────────────

mock.module("../src/logger.ts", () => ({
  log: {
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
    }),
  },
}));

mock.module("../src/api/bridge-river.ts", () => ({
  RIVER_ROOT: "/test-vault",
  qmdReindex: mock(async () => true),
  searchRiver: mock(async () => []),
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import {
  enrichPromptWithAdvice,
  getAdviceForDispatch,
} from "../src/dispatch-advice-injector";

import {
  buildDispatchAdvice,
  type PostMortemSummary,
  type DispatchAdvice,
} from "../src/post-mortem";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeAdvice(postMortems: PostMortemSummary[]): DispatchAdvice {
  return buildDispatchAdvice(postMortems);
}

function makeSummary(overrides: Partial<PostMortemSummary> = {}): PostMortemSummary {
  return {
    workItemId: "ELLIE-100",
    failureType: "timeout",
    whatHappened: "Ran out of time",
    whatToDoNextTime: "Commit after each file change",
    patternTags: ["timeout"],
    file: "post-mortems/ELLIE-100-2026-03-05.md",
    ...overrides,
  };
}

// ── enrichPromptWithAdvice (pure) ───────────────────────────────────────────

describe("enrichPromptWithAdvice", () => {
  test("appends advice to work item context", () => {
    const context = "ACTIVE WORK ITEM: ELLIE-100\nTitle: Fix the bug";
    const advice = makeAdvice([makeSummary()]);

    const enriched = enrichPromptWithAdvice(context, advice);

    expect(enriched).toContain("ACTIVE WORK ITEM: ELLIE-100");
    expect(enriched).toContain("## Past Failure Patterns");
    expect(enriched).toContain("Commit after each file change");
    expect(enriched).toContain("`timeout`");
  });

  test("returns original context when no post-mortems", () => {
    const context = "ACTIVE WORK ITEM: ELLIE-200\nTitle: New feature";
    const advice = makeAdvice([]);

    const enriched = enrichPromptWithAdvice(context, advice);

    expect(enriched).toBe(context);
  });

  test("includes pattern-based adjustments", () => {
    const context = "ACTIVE WORK ITEM: ELLIE-300";
    const advice = makeAdvice([
      makeSummary({
        workItemId: "ELLIE-300",
        patternTags: ["task-too-large"],
        whatToDoNextTime: "",
      }),
    ]);

    const enriched = enrichPromptWithAdvice(context, advice);

    expect(enriched).toContain("Break task");
  });

  test("includes multiple adjustments from multiple post-mortems", () => {
    const context = "ACTIVE WORK ITEM: ELLIE-400";
    const advice = makeAdvice([
      makeSummary({
        workItemId: "ELLIE-400",
        whatToDoNextTime: "Use smaller steps",
        patternTags: ["timeout"],
      }),
      makeSummary({
        workItemId: "ELLIE-400",
        whatToDoNextTime: "Check file types first",
        patternTags: ["missing-context"],
        failureType: "wrong_approach",
      }),
    ]);

    const enriched = enrichPromptWithAdvice(context, advice);

    expect(enriched).toContain("Use smaller steps");
    expect(enriched).toContain("Check file types first");
    expect(enriched).toContain("2 relevant post-mortem(s)");
  });
});

// ── getAdviceForDispatch (effectful) ────────────────────────────────────────

describe("getAdviceForDispatch", () => {
  test("returns advice when post-mortems found", async () => {
    const mockSearch = mock(async () => [
      {
        file: "post-mortems/ELLIE-100-2026-03-05.md",
        title: "PM",
        snippet: "work_item_id: ELLIE-100\nfailure_type: timeout\npattern_tags: [timeout]\n## What Happened\nToo slow\n## What To Do Next Time\nBe faster\n",
        score: 5,
      },
    ]);

    const advice = await getAdviceForDispatch("ELLIE-100", mockSearch);

    expect(advice).not.toBeNull();
    expect(advice!.relevantPostMortems).toHaveLength(1);
    expect(advice!.patternsSeen).toContain("timeout");
    expect(advice!.adjustments.length).toBeGreaterThan(0);
  });

  test("returns null when no post-mortems found", async () => {
    const mockSearch = mock(async () => []);

    const advice = await getAdviceForDispatch("ELLIE-999", mockSearch);

    expect(advice).toBeNull();
  });

  test("returns null when search throws", async () => {
    const mockSearch = mock(async () => {
      throw new Error("QMD down");
    });

    const advice = await getAdviceForDispatch("ELLIE-100", mockSearch);

    expect(advice).toBeNull();
  });

  test("filters non-post-mortem results", async () => {
    const mockSearch = mock(async () => [
      {
        file: "work-trails/ELLIE-100/trail.md",
        title: "Work Trail",
        snippet: "Not a post-mortem",
        score: 5,
      },
    ]);

    const advice = await getAdviceForDispatch("ELLIE-100", mockSearch);

    expect(advice).toBeNull();
  });

  test("passes work item ID through to search", async () => {
    const mockSearch = mock(async () => []);

    await getAdviceForDispatch("ELLIE-567", mockSearch);

    expect(mockSearch).toHaveBeenCalledWith("post-mortem ELLIE-567", 10);
  });

  test("returns advice with multiple post-mortems", async () => {
    const mockSearch = mock(async () => [
      {
        file: "post-mortems/ELLIE-200-2026-03-04.md",
        title: "PM1",
        snippet: "work_item_id: ELLIE-200\nfailure_type: timeout\npattern_tags: [timeout]\n## What Happened\nFirst timeout\n## What To Do Next Time\nCommit more often\n",
        score: 5,
      },
      {
        file: "post-mortems/ELLIE-200-2026-03-05.md",
        title: "PM2",
        snippet: "work_item_id: ELLIE-200\nfailure_type: crash\npattern_tags: [missing-context]\n## What Happened\nSecond crash\n## What To Do Next Time\nRead docs first\n",
        score: 4,
      },
    ]);

    const advice = await getAdviceForDispatch("ELLIE-200", mockSearch);

    expect(advice).not.toBeNull();
    expect(advice!.relevantPostMortems).toHaveLength(2);
    expect(advice!.adjustments).toContain("Commit more often");
    expect(advice!.adjustments).toContain("Read docs first");
  });
});

// ── Integration: enrichment with fetched advice ─────────────────────────────

describe("end-to-end: fetch + enrich", () => {
  test("enriches context when advice found", async () => {
    const mockSearch = mock(async () => [
      {
        file: "post-mortems/ELLIE-500-2026-03-05.md",
        title: "PM",
        snippet: "work_item_id: ELLIE-500\nfailure_type: timeout\npattern_tags: [timeout, task-too-large]\n## What Happened\nTook too long\n## What To Do Next Time\nSplit into phases\n",
        score: 5,
      },
    ]);

    const advice = await getAdviceForDispatch("ELLIE-500", mockSearch);
    const context = "ACTIVE WORK ITEM: ELLIE-500\nTitle: Big feature";

    const enriched = advice
      ? enrichPromptWithAdvice(context, advice)
      : context;

    expect(enriched).toContain("ACTIVE WORK ITEM: ELLIE-500");
    expect(enriched).toContain("## Past Failure Patterns");
    expect(enriched).toContain("Split into phases");
    expect(enriched).toContain("`timeout`");
    expect(enriched).toContain("`task-too-large`");
  });

  test("leaves context unchanged when no advice", async () => {
    const mockSearch = mock(async () => []);

    const advice = await getAdviceForDispatch("ELLIE-600", mockSearch);
    const context = "ACTIVE WORK ITEM: ELLIE-600";

    const enriched = advice
      ? enrichPromptWithAdvice(context, advice)
      : context;

    expect(enriched).toBe(context);
  });
});
