/**
 * ELLIE-632 — Dispatch ↔ Forest cross-referencing tests
 *
 * Tests for three new capabilities:
 *
 * 1. dispatch-memory-tracker: in-memory accumulator for Forest memory IDs
 * 2. Forest writers (decision/finding): session_id in metadata + memory tracking
 * 3. Dispatch journal end entries: memoryIds field rendering
 */

import { describe, test, expect, beforeEach } from "bun:test";

// ── dispatch-memory-tracker (pure, no mocks needed) ─────────────────────────

import {
  trackMemoryId,
  getTrackedMemoryIds,
  clearTrackedMemoryIds,
  _resetForTesting,
} from "../src/dispatch-memory-tracker.ts";

beforeEach(() => {
  _resetForTesting();
});

describe("dispatch-memory-tracker", () => {
  test("returns empty array when no IDs tracked", () => {
    expect(getTrackedMemoryIds("ELLIE-1")).toEqual([]);
  });

  test("tracks a single memory ID", () => {
    trackMemoryId("ELLIE-1", "mem-aaa");
    expect(getTrackedMemoryIds("ELLIE-1")).toEqual(["mem-aaa"]);
  });

  test("tracks multiple memory IDs for same work item", () => {
    trackMemoryId("ELLIE-1", "mem-aaa");
    trackMemoryId("ELLIE-1", "mem-bbb");
    trackMemoryId("ELLIE-1", "mem-ccc");
    expect(getTrackedMemoryIds("ELLIE-1")).toEqual(["mem-aaa", "mem-bbb", "mem-ccc"]);
  });

  test("isolates tracking between work items", () => {
    trackMemoryId("ELLIE-1", "mem-aaa");
    trackMemoryId("ELLIE-2", "mem-bbb");
    expect(getTrackedMemoryIds("ELLIE-1")).toEqual(["mem-aaa"]);
    expect(getTrackedMemoryIds("ELLIE-2")).toEqual(["mem-bbb"]);
  });

  test("clearTrackedMemoryIds removes only specified work item", () => {
    trackMemoryId("ELLIE-1", "mem-aaa");
    trackMemoryId("ELLIE-2", "mem-bbb");
    clearTrackedMemoryIds("ELLIE-1");
    expect(getTrackedMemoryIds("ELLIE-1")).toEqual([]);
    expect(getTrackedMemoryIds("ELLIE-2")).toEqual(["mem-bbb"]);
  });

  test("clearTrackedMemoryIds is safe on unknown work item", () => {
    clearTrackedMemoryIds("ELLIE-999");
    expect(getTrackedMemoryIds("ELLIE-999")).toEqual([]);
  });

  test("_resetForTesting clears all tracked state", () => {
    trackMemoryId("ELLIE-1", "mem-aaa");
    trackMemoryId("ELLIE-2", "mem-bbb");
    _resetForTesting();
    expect(getTrackedMemoryIds("ELLIE-1")).toEqual([]);
    expect(getTrackedMemoryIds("ELLIE-2")).toEqual([]);
  });

  test("preserves insertion order", () => {
    trackMemoryId("ELLIE-1", "first");
    trackMemoryId("ELLIE-1", "second");
    trackMemoryId("ELLIE-1", "third");
    const ids = getTrackedMemoryIds("ELLIE-1");
    expect(ids[0]).toBe("first");
    expect(ids[2]).toBe("third");
  });
});

// ── buildForestDecision — session_id in metadata ────────────────────────────

import { buildForestDecision } from "../src/decision-forest-writer.ts";

describe("buildForestDecision — session_id (ELLIE-632)", () => {
  test("includes session_id in metadata when provided", () => {
    const result = buildForestDecision("ELLIE-100", "Using X", "dev", "session-abc-123");
    expect(result.metadata.session_id).toBe("session-abc-123");
  });

  test("omits session_id when not provided", () => {
    const result = buildForestDecision("ELLIE-100", "Using X", "dev");
    expect(result.metadata.session_id).toBeUndefined();
  });

  test("omits session_id when explicitly undefined", () => {
    const result = buildForestDecision("ELLIE-100", "Using X", "dev", undefined);
    expect(result.metadata.session_id).toBeUndefined();
  });

  test("preserves all existing fields when session_id added", () => {
    const result = buildForestDecision("ELLIE-100", "msg", "dev", "sess-1");
    expect(result.type).toBe("decision");
    expect(result.scope_path).toBe("2/1");
    expect(result.confidence).toBe(0.8);
    expect(result.metadata.work_item_id).toBe("ELLIE-100");
    expect(result.metadata.source).toBe("work-session");
    expect(result.metadata.agent).toBe("dev");
  });
});

// ── buildForestFinding — session_id in metadata ─────────────────────────────

import { buildForestFinding } from "../src/finding-forest-writer.ts";

describe("buildForestFinding — session_id (ELLIE-632)", () => {
  test("includes session_id in metadata when provided", () => {
    const result = buildForestFinding("ELLIE-200", "Bug found", "dev", 0.7, "session-def-456");
    expect(result.metadata.session_id).toBe("session-def-456");
  });

  test("omits session_id when not provided", () => {
    const result = buildForestFinding("ELLIE-200", "Bug found", "dev", 0.7);
    expect(result.metadata.session_id).toBeUndefined();
  });

  test("preserves all existing fields when session_id added", () => {
    const result = buildForestFinding("ELLIE-200", "msg", "dev", 0.9, "sess-2");
    expect(result.type).toBe("finding");
    expect(result.scope_path).toBe("2/1");
    expect(result.confidence).toBe(0.9);
    expect(result.metadata.work_item_id).toBe("ELLIE-200");
    expect(result.metadata.source).toBe("work-session");
    expect(result.metadata.agent).toBe("dev");
  });
});

// ── writeDecisionToForest — memory ID tracking ─────────────────────────────

import { writeDecisionToForest } from "../src/decision-forest-writer.ts";

describe("writeDecisionToForest — memory tracking (ELLIE-632)", () => {
  test("tracks memory_id from Bridge response", async () => {
    const mockFetch = async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response(JSON.stringify({ success: true, memory_id: "mem-decision-1" }), { status: 200 });
    };

    await writeDecisionToForest("ELLIE-300", "Decision X", "dev", mockFetch as typeof fetch, "sess-1");
    expect(getTrackedMemoryIds("ELLIE-300")).toContain("mem-decision-1");
  });

  test("passes session_id through to payload", async () => {
    let capturedBody: any = null;
    const mockFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ success: true, memory_id: "mem-2" }), { status: 200 });
    };

    await writeDecisionToForest("ELLIE-301", "Decision Y", "dev", mockFetch as typeof fetch, "sess-abc");
    expect(capturedBody.metadata.session_id).toBe("sess-abc");
  });

  test("does not track when response has no memory_id", async () => {
    const mockFetch = async () => {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    await writeDecisionToForest("ELLIE-302", "Decision Z", undefined, mockFetch as typeof fetch);
    expect(getTrackedMemoryIds("ELLIE-302")).toEqual([]);
  });

  test("does not track on failed response", async () => {
    const mockFetch = async () => new Response("error", { status: 500 });
    await writeDecisionToForest("ELLIE-303", "msg", undefined, mockFetch as typeof fetch);
    expect(getTrackedMemoryIds("ELLIE-303")).toEqual([]);
  });
});

// ── writeFindingToForest — memory ID tracking ───────────────────────────────

import { writeFindingToForest } from "../src/finding-forest-writer.ts";

describe("writeFindingToForest — memory tracking (ELLIE-632)", () => {
  test("tracks memory_id from Bridge response", async () => {
    const mockFetch = async () => {
      return new Response(JSON.stringify({ success: true, memory_id: "mem-finding-1" }), { status: 200 });
    };

    await writeFindingToForest("ELLIE-400", "Found bug", "dev", 0.8, mockFetch as typeof fetch, "sess-1");
    expect(getTrackedMemoryIds("ELLIE-400")).toContain("mem-finding-1");
  });

  test("passes session_id through to payload", async () => {
    let capturedBody: any = null;
    const mockFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ success: true, memory_id: "mem-3" }), { status: 200 });
    };

    await writeFindingToForest("ELLIE-401", "Finding Y", "dev", 0.7, mockFetch as typeof fetch, "sess-def");
    expect(capturedBody.metadata.session_id).toBe("sess-def");
  });

  test("does not track on failed response", async () => {
    const mockFetch = async () => new Response("error", { status: 500 });
    await writeFindingToForest("ELLIE-402", "msg", undefined, undefined, mockFetch as typeof fetch);
    expect(getTrackedMemoryIds("ELLIE-402")).toEqual([]);
  });
});

// ── buildEndEntry — memoryIds rendering ─────────────────────────────────────

import { buildEndEntry } from "../src/dispatch-journal.ts";

describe("buildEndEntry — memoryIds (ELLIE-632)", () => {
  test("includes Forest Memories line when memoryIds provided", () => {
    const result = buildEndEntry({
      workItemId: "ELLIE-500",
      outcome: "completed",
      summary: "Done",
      memoryIds: ["mem-aaa", "mem-bbb"],
    });
    expect(result).toContain("**Forest Memories:**");
    expect(result).toContain("`mem-aaa`");
    expect(result).toContain("`mem-bbb`");
  });

  test("omits Forest Memories line when no memoryIds", () => {
    const result = buildEndEntry({
      workItemId: "ELLIE-501",
      outcome: "completed",
    });
    expect(result).not.toContain("Forest Memories");
  });

  test("omits Forest Memories line when memoryIds is empty array", () => {
    const result = buildEndEntry({
      workItemId: "ELLIE-502",
      outcome: "completed",
      memoryIds: [],
    });
    expect(result).not.toContain("Forest Memories");
  });

  test("renders single memory ID correctly", () => {
    const result = buildEndEntry({
      workItemId: "ELLIE-503",
      outcome: "completed",
      memoryIds: ["mem-single"],
    });
    expect(result).toContain("`mem-single`");
    // No trailing comma for single item
    expect(result).not.toContain("`, `");
  });

  test("renders multiple memory IDs as comma-separated backtick list", () => {
    const result = buildEndEntry({
      workItemId: "ELLIE-504",
      outcome: "completed",
      memoryIds: ["id-1", "id-2", "id-3"],
    });
    expect(result).toContain("`id-1`, `id-2`, `id-3`");
  });

  test("preserves all existing fields when memoryIds added", () => {
    const result = buildEndEntry({
      workItemId: "ELLIE-505",
      outcome: "completed",
      agent: "dev",
      summary: "All done",
      durationMinutes: 15,
      memoryIds: ["mem-x"],
      endedAt: "2026-03-06T18:00:00Z",
    });
    expect(result).toContain("ELLIE-505 — Completed");
    expect(result).toContain("**Agent:** dev");
    expect(result).toContain("**Summary:** All done");
    expect(result).toContain("**Duration:** 15 minutes");
    expect(result).toContain("**Forest Memories:** `mem-x`");
    expect(result).toContain("2026-03-06T18:00:00Z");
  });

  test("Forest Memories line appears after Summary", () => {
    const result = buildEndEntry({
      workItemId: "ELLIE-506",
      outcome: "completed",
      summary: "Summary text",
      memoryIds: ["mem-after"],
    });
    const summaryIdx = result.indexOf("**Summary:**");
    const memoriesIdx = result.indexOf("**Forest Memories:**");
    expect(memoriesIdx).toBeGreaterThan(summaryIdx);
  });
});

// ── End-to-end scenario: full cross-reference flow ──────────────────────────

describe("cross-reference flow (ELLIE-632)", () => {
  test("decision write → tracker → journal end contains memory IDs", async () => {
    // Step 1: Agent writes a decision during session
    const mockFetch = async () => {
      return new Response(JSON.stringify({ success: true, memory_id: "mem-e2e-decision" }), { status: 200 });
    };
    await writeDecisionToForest("ELLIE-600", "Chose approach A", "dev", mockFetch as typeof fetch, "tree-e2e");

    // Step 2: Agent writes a finding during session
    const mockFetch2 = async () => {
      return new Response(JSON.stringify({ success: true, memory_id: "mem-e2e-finding" }), { status: 200 });
    };
    await writeFindingToForest("ELLIE-600", "Found root cause", "dev", 0.8, mockFetch2 as typeof fetch, "tree-e2e");

    // Step 3: At dispatch end, get tracked IDs
    const memoryIds = getTrackedMemoryIds("ELLIE-600");
    expect(memoryIds).toEqual(["mem-e2e-decision", "mem-e2e-finding"]);

    // Step 4: Build journal end entry with memory IDs
    const journalEnd = buildEndEntry({
      workItemId: "ELLIE-600",
      outcome: "completed",
      summary: "Done",
      memoryIds,
    });
    expect(journalEnd).toContain("`mem-e2e-decision`");
    expect(journalEnd).toContain("`mem-e2e-finding`");

    // Step 5: Clear tracking
    clearTrackedMemoryIds("ELLIE-600");
    expect(getTrackedMemoryIds("ELLIE-600")).toEqual([]);
  });

  test("session_id enables Forest → dispatch tracing", () => {
    const sessionId = "tree-trace-test";

    // Decision payload contains session_id for reverse lookup
    const decision = buildForestDecision("ELLIE-601", "Decision", "dev", sessionId);
    expect(decision.metadata.session_id).toBe(sessionId);

    // Finding payload also contains session_id
    const finding = buildForestFinding("ELLIE-601", "Finding", "dev", 0.7, sessionId);
    expect(finding.metadata.session_id).toBe(sessionId);

    // Both can be queried by session_id to find all Forest nodes from this dispatch
  });
});
