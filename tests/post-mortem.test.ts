/**
 * ELLIE-569 — Post-Mortem Meta-Learning Tests
 *
 * Tests the pure content builders (path, content, snippet parser, dispatch advice,
 * prompt formatting) and the effectful writers/searchers with mocked fs/QMD.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mock fs + QMD ───────────────────────────────────────────────────────────

let _writtenFiles: Array<{ path: string; content: string }> = [];
let _mkdirCalls: string[] = [];
let _reindexCalls = 0;

mock.module("fs/promises", () => ({
  writeFile: mock(async (path: string, content: string) => {
    _writtenFiles.push({ path, content });
  }),
  readFile: mock(async (path: string) => {
    // ELLIE-575: Return content if file was previously written (same test)
    const found = _writtenFiles.find(f => f.path === path);
    if (found) return found.content;
    throw new Error("ENOENT");
  }),
  mkdir: mock(async (path: string) => {
    _mkdirCalls.push(path);
  }),
}));

mock.module("../src/api/bridge-river.ts", () => ({
  RIVER_ROOT: "/test-vault",
  qmdReindex: mock(async () => {
    _reindexCalls++;
    return true;
  }),
  searchRiver: mock(async () => []),
}));

mock.module("../src/logger.ts", () => ({
  log: {
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
    }),
  },
}));

mock.module("../src/relay-config.ts", () => ({
  RELAY_BASE_URL: "http://test-relay:3001",
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import {
  buildPostMortemPath,
  buildPostMortemContent,
  parsePostMortemSnippet,
  buildDispatchAdvice,
  formatAdviceForPrompt,
  writePostMortem,
  findNextAvailablePath,
  searchPostMortems,
  getDispatchAdvice,
  classifyPauseReason,
  confidenceForFailureType,
  buildForestFinding,
  writePostMortemToForest,
  type PostMortemData,
  type PostMortemSummary,
  type ForestFinding,
} from "../src/post-mortem";

// ── Reset ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  _writtenFiles = [];
  _mkdirCalls = [];
  _reindexCalls = 0;
});

// ── buildPostMortemPath ─────────────────────────────────────────────────────

describe("buildPostMortemPath", () => {
  test("builds path with explicit date", () => {
    expect(buildPostMortemPath("ELLIE-567", "2026-03-05")).toBe(
      "post-mortems/ELLIE-567-2026-03-05.md",
    );
  });

  test("builds path with today's date", () => {
    const path = buildPostMortemPath("ELLIE-100");
    expect(path).toMatch(/^post-mortems\/ELLIE-100-\d{4}-\d{2}-\d{2}\.md$/);
  });
});

// ── buildPostMortemContent ──────────────────────────────────────────────────

describe("buildPostMortemContent", () => {
  test("builds content with all fields", () => {
    const content = buildPostMortemContent({
      workItemId: "ELLIE-567",
      title: "Add context cards",
      agent: "dev",
      failureType: "timeout",
      whatHappened: "Agent ran out of time on large test suite",
      whyItFailed: "Task was too large for single session",
      whatToDoNextTime: "Break into smaller phases, commit after each",
      filesInvolved: ["src/foo.ts", "tests/foo.test.ts"],
      durationMinutes: 30,
      patternTags: ["task-too-large", "timeout"],
      timestamp: "2026-03-05T12:00:00Z",
    });

    expect(content).toContain("type: post-mortem");
    expect(content).toContain("work_item_id: ELLIE-567");
    expect(content).toContain("failure_type: timeout");
    expect(content).toContain("timestamp: 2026-03-05T12:00:00Z");
    expect(content).toContain("pattern_tags: [task-too-large, timeout]");
    expect(content).toContain("agent: dev");
    expect(content).toContain("duration_minutes: 30");
    expect(content).toContain("# Post-Mortem: ELLIE-567 — Add context cards");
    expect(content).toContain("> Timeout at 2026-03-05T12:00");
    expect(content).toContain("## What Happened");
    expect(content).toContain("Agent ran out of time on large test suite");
    expect(content).toContain("## Why It Failed");
    expect(content).toContain("Task was too large for single session");
    expect(content).toContain("## What To Do Next Time");
    expect(content).toContain("Break into smaller phases, commit after each");
    expect(content).toContain("## Files Involved");
    expect(content).toContain("- `src/foo.ts`");
    expect(content).toContain("## Pattern Tags");
    expect(content).toContain("- `task-too-large`");
  });

  test("builds minimal content", () => {
    const content = buildPostMortemContent({
      workItemId: "ELLIE-100",
      title: "Test",
      failureType: "crash",
      whatHappened: "Process exited unexpectedly",
      timestamp: "2026-03-05T14:00:00Z",
    });

    expect(content).toContain("work_item_id: ELLIE-100");
    expect(content).toContain("failure_type: crash");
    expect(content).toContain("## What Happened");
    expect(content).toContain("Process exited unexpectedly");
    expect(content).not.toContain("## Why It Failed");
    expect(content).not.toContain("## What To Do Next Time");
    expect(content).not.toContain("## Files Involved");
    expect(content).not.toContain("## Pattern Tags");
    expect(content).not.toContain("agent:");
  });

  test("capitalizes failure type in header", () => {
    const content = buildPostMortemContent({
      workItemId: "ELLIE-100",
      title: "Test",
      failureType: "wrong_approach",
      whatHappened: "Used wrong tool",
      timestamp: "2026-03-05T14:00:00Z",
    });

    expect(content).toContain("> Wrong approach at 2026-03-05T14:00");
  });
});

// ── parsePostMortemSnippet ──────────────────────────────────────────────────

describe("parsePostMortemSnippet", () => {
  test("parses full post-mortem snippet", () => {
    const snippet = [
      "work_item_id: ELLIE-567",
      "failure_type: timeout",
      "pattern_tags: [task-too-large, timeout]",
      "",
      "## What Happened",
      "Agent ran out of time",
      "",
      "## What To Do Next Time",
      "Break into phases",
    ].join("\n");

    const result = parsePostMortemSnippet("post-mortems/ELLIE-567-2026-03-05.md", snippet);

    expect(result).not.toBeNull();
    expect(result!.workItemId).toBe("ELLIE-567");
    expect(result!.failureType).toBe("timeout");
    expect(result!.whatHappened).toBe("Agent ran out of time");
    expect(result!.whatToDoNextTime).toBe("Break into phases");
    expect(result!.patternTags).toEqual(["task-too-large", "timeout"]);
  });

  test("extracts work item ID from file path when not in snippet", () => {
    const result = parsePostMortemSnippet(
      "post-mortems/ELLIE-100-2026-03-05.md",
      "## What Happened\nSomething failed\n",
    );

    expect(result).not.toBeNull();
    expect(result!.workItemId).toBe("ELLIE-100");
  });

  test("returns null when no ID found", () => {
    const result = parsePostMortemSnippet("random/file.md", "no id here");
    expect(result).toBeNull();
  });

  test("handles empty pattern tags", () => {
    const snippet = "work_item_id: ELLIE-100\nfailure_type: crash\n## What Happened\nBoom\n";
    const result = parsePostMortemSnippet("post-mortems/ELLIE-100.md", snippet);

    expect(result!.patternTags).toEqual([]);
  });
});

// ── buildDispatchAdvice ─────────────────────────────────────────────────────

describe("buildDispatchAdvice", () => {
  test("builds advice from post-mortems", () => {
    const postMortems: PostMortemSummary[] = [
      {
        workItemId: "ELLIE-100",
        failureType: "timeout",
        whatHappened: "Ran out of time",
        whatToDoNextTime: "Commit after each file change",
        patternTags: ["timeout"],
        file: "post-mortems/ELLIE-100-2026-03-05.md",
      },
    ];

    const advice = buildDispatchAdvice(postMortems);

    expect(advice.relevantPostMortems).toHaveLength(1);
    expect(advice.adjustments).toContain("Commit after each file change");
    expect(advice.patternsSeen).toContain("timeout");
    // timeout pattern should trigger "commit incrementally" advice
    expect(advice.adjustments.some((a) => a.includes("incremental"))).toBe(true);
  });

  test("adds task-too-large advice", () => {
    const postMortems: PostMortemSummary[] = [
      {
        workItemId: "ELLIE-200",
        failureType: "timeout",
        whatHappened: "Too much work",
        whatToDoNextTime: "",
        patternTags: ["task-too-large"],
        file: "pm.md",
      },
    ];

    const advice = buildDispatchAdvice(postMortems);

    expect(advice.adjustments.some((a) => a.includes("Break task"))).toBe(true);
  });

  test("adds missing-context advice", () => {
    const postMortems: PostMortemSummary[] = [
      {
        workItemId: "ELLIE-300",
        failureType: "wrong_approach",
        whatHappened: "Didn't understand codebase",
        whatToDoNextTime: "",
        patternTags: ["missing-context"],
        file: "pm.md",
      },
    ];

    const advice = buildDispatchAdvice(postMortems);

    expect(advice.adjustments.some((a) => a.includes("context"))).toBe(true);
  });

  test("deduplicates pattern tags", () => {
    const postMortems: PostMortemSummary[] = [
      {
        workItemId: "ELLIE-100",
        failureType: "timeout",
        whatHappened: "X",
        whatToDoNextTime: "",
        patternTags: ["timeout", "task-too-large"],
        file: "pm1.md",
      },
      {
        workItemId: "ELLIE-200",
        failureType: "timeout",
        whatHappened: "Y",
        whatToDoNextTime: "",
        patternTags: ["timeout"],
        file: "pm2.md",
      },
    ];

    const advice = buildDispatchAdvice(postMortems);

    const timeoutCount = advice.patternsSeen.filter((p) => p === "timeout").length;
    expect(timeoutCount).toBe(1);
  });

  test("empty post-mortems returns empty advice", () => {
    const advice = buildDispatchAdvice([]);

    expect(advice.relevantPostMortems).toHaveLength(0);
    expect(advice.adjustments).toHaveLength(0);
    expect(advice.patternsSeen).toHaveLength(0);
  });
});

// ── formatAdviceForPrompt ───────────────────────────────────────────────────

describe("formatAdviceForPrompt", () => {
  test("formats advice with adjustments and patterns", () => {
    const advice = buildDispatchAdvice([
      {
        workItemId: "ELLIE-100",
        failureType: "timeout",
        whatHappened: "Ran out of time",
        whatToDoNextTime: "Commit more often",
        patternTags: ["timeout"],
        file: "pm.md",
      },
    ]);

    const formatted = formatAdviceForPrompt(advice);

    expect(formatted).toContain("## Past Failure Patterns");
    expect(formatted).toContain("1 relevant post-mortem(s)");
    expect(formatted).toContain("### Dispatch Adjustments");
    expect(formatted).toContain("- Commit more often");
    expect(formatted).toContain("`timeout`");
  });

  test("returns empty string for no post-mortems", () => {
    const advice = buildDispatchAdvice([]);
    expect(formatAdviceForPrompt(advice)).toBe("");
  });
});

// ── writePostMortem (effectful) ─────────────────────────────────────────────

describe("writePostMortem", () => {
  test("writes post-mortem to River", async () => {
    const result = await writePostMortem({
      workItemId: "ELLIE-567",
      title: "Test failure",
      failureType: "timeout",
      whatHappened: "Ran out of time",
      timestamp: "2026-03-05T12:00:00Z",
    });

    expect(result).toBe(true);
    expect(_writtenFiles).toHaveLength(1);
    expect(_writtenFiles[0].path).toBe("/test-vault/post-mortems/ELLIE-567-2026-03-05.md");
    expect(_writtenFiles[0].content).toContain("failure_type: timeout");
    expect(_reindexCalls).toBe(1);
  });

  test("creates parent directory", async () => {
    await writePostMortem({
      workItemId: "ELLIE-100",
      title: "Test",
      failureType: "crash",
      whatHappened: "Boom",
      timestamp: "2026-03-05T12:00:00Z",
    });

    expect(_mkdirCalls.some((p) => p.includes("post-mortems"))).toBe(true);
  });

  test("writes second post-mortem with sequence number (ELLIE-575)", async () => {
    // First write
    await writePostMortem({
      workItemId: "ELLIE-200",
      title: "First failure",
      failureType: "timeout",
      whatHappened: "First timeout",
      timestamp: "2026-03-05T12:00:00Z",
    });

    // Second write — same ticket, same day
    await writePostMortem({
      workItemId: "ELLIE-200",
      title: "Second failure",
      failureType: "crash",
      whatHappened: "Then it crashed",
      timestamp: "2026-03-05T14:00:00Z",
    });

    expect(_writtenFiles).toHaveLength(2);
    expect(_writtenFiles[0].path).toBe("/test-vault/post-mortems/ELLIE-200-2026-03-05.md");
    expect(_writtenFiles[1].path).toBe("/test-vault/post-mortems/ELLIE-200-2026-03-05-2.md");
    expect(_writtenFiles[0].content).toContain("First timeout");
    expect(_writtenFiles[1].content).toContain("Then it crashed");
  });

  test("writes third post-mortem with sequence -3 (ELLIE-575)", async () => {
    // Write three post-mortems for same ticket on same day
    for (let i = 0; i < 3; i++) {
      await writePostMortem({
        workItemId: "ELLIE-300",
        title: `Failure ${i + 1}`,
        failureType: "timeout",
        whatHappened: `Failure number ${i + 1}`,
        timestamp: "2026-03-05T12:00:00Z",
      });
    }

    expect(_writtenFiles).toHaveLength(3);
    expect(_writtenFiles[0].path).toBe("/test-vault/post-mortems/ELLIE-300-2026-03-05.md");
    expect(_writtenFiles[1].path).toBe("/test-vault/post-mortems/ELLIE-300-2026-03-05-2.md");
    expect(_writtenFiles[2].path).toBe("/test-vault/post-mortems/ELLIE-300-2026-03-05-3.md");
  });
});

// ── findNextAvailablePath (ELLIE-575) ───────────────────────────────────────

describe("findNextAvailablePath", () => {
  test("returns base path when no file exists", async () => {
    const existsFn = async () => false;
    const path = await findNextAvailablePath("post-mortems/ELLIE-100-2026-03-05.md", 99, existsFn);
    expect(path).toBe("post-mortems/ELLIE-100-2026-03-05.md");
  });

  test("returns -2 path when base exists", async () => {
    const existsFn = async (p: string) => p.endsWith("ELLIE-100-2026-03-05.md");
    const path = await findNextAvailablePath("post-mortems/ELLIE-100-2026-03-05.md", 99, existsFn);
    expect(path).toBe("post-mortems/ELLIE-100-2026-03-05-2.md");
  });

  test("returns -3 path when base and -2 exist", async () => {
    const existing = new Set([
      "/test-vault/post-mortems/ELLIE-100-2026-03-05.md",
      "/test-vault/post-mortems/ELLIE-100-2026-03-05-2.md",
    ]);
    const existsFn = async (p: string) => existing.has(p);
    const path = await findNextAvailablePath("post-mortems/ELLIE-100-2026-03-05.md", 99, existsFn);
    expect(path).toBe("post-mortems/ELLIE-100-2026-03-05-3.md");
  });

  test("respects maxSeq limit", async () => {
    // All paths exist
    const existsFn = async () => true;
    const path = await findNextAvailablePath("post-mortems/ELLIE-100-2026-03-05.md", 3, existsFn);
    expect(path).toBe("post-mortems/ELLIE-100-2026-03-05-4.md");
  });
});

// ── searchPostMortems (effectful with injected deps) ────────────────────────

describe("searchPostMortems", () => {
  test("filters and parses post-mortem results", async () => {
    const mockSearch = mock(async () => [
      {
        file: "post-mortems/ELLIE-100-2026-03-05.md",
        title: "Post-Mortem",
        snippet: "work_item_id: ELLIE-100\nfailure_type: timeout\n## What Happened\nTimed out\n## What To Do Next Time\nBe faster\n",
        score: 5,
      },
      {
        file: "work-trails/ELLIE-100/trail.md",
        title: "Work Trail",
        snippet: "Not a post-mortem",
        score: 3,
      },
    ]);

    const results = await searchPostMortems("ELLIE-100", mockSearch);

    expect(results).toHaveLength(1);
    expect(results[0].workItemId).toBe("ELLIE-100");
    expect(results[0].failureType).toBe("timeout");
  });

  test("returns empty array for no matches", async () => {
    const mockSearch = mock(async () => []);
    const results = await searchPostMortems("ELLIE-999", mockSearch);
    expect(results).toHaveLength(0);
  });

  test("prepends 'post-mortem' to search query", async () => {
    const mockSearch = mock(async () => []);
    await searchPostMortems("ELLIE-100", mockSearch);
    expect(mockSearch).toHaveBeenCalledWith("post-mortem ELLIE-100", 10);
  });
});

// ── getDispatchAdvice (effectful with injected deps) ────────────────────────

describe("getDispatchAdvice", () => {
  test("returns advice from search results", async () => {
    const mockSearch = mock(async () => [
      {
        file: "post-mortems/ELLIE-200-2026-03-05.md",
        title: "PM",
        snippet:
          "work_item_id: ELLIE-200\nfailure_type: timeout\npattern_tags: [timeout]\n## What Happened\nToo slow\n## What To Do Next Time\nUse smaller steps\n",
        score: 5,
      },
    ]);

    const advice = await getDispatchAdvice("ELLIE-200", mockSearch);

    expect(advice.relevantPostMortems).toHaveLength(1);
    expect(advice.adjustments.length).toBeGreaterThan(0);
    expect(advice.patternsSeen).toContain("timeout");
  });

  test("returns empty advice when no post-mortems found", async () => {
    const mockSearch = mock(async () => []);
    const advice = await getDispatchAdvice("ELLIE-999", mockSearch);

    expect(advice.relevantPostMortems).toHaveLength(0);
    expect(advice.adjustments).toHaveLength(0);
  });
});

// ── classifyPauseReason (ELLIE-573) ─────────────────────────────────────────

describe("classifyPauseReason", () => {
  test("classifies timeout reasons", () => {
    expect(classifyPauseReason("Timed out on large test suite").failureType).toBe("timeout");
    expect(classifyPauseReason("Task timeout after 300s").failureType).toBe("timeout");
    expect(classifyPauseReason("Ran out of time building").failureType).toBe("timeout");
    expect(classifyPauseReason("Took too long to compile").failureType).toBe("timeout");
  });

  test("classifies crash reasons", () => {
    expect(classifyPauseReason("Agent crashed due to OOM").failureType).toBe("crash");
    expect(classifyPauseReason("Process killed by signal").failureType).toBe("crash");
    expect(classifyPauseReason("Out of memory on large file").failureType).toBe("crash");
    expect(classifyPauseReason("Fatal error in subprocess").failureType).toBe("crash");
    expect(classifyPauseReason("Force-killed by OOM killer").failureType).toBe("crash");
  });

  test("classifies wrong_approach reasons", () => {
    expect(classifyPauseReason("Wrong approach — need to refactor first").failureType).toBe("wrong_approach");
    expect(classifyPauseReason("Went down the wrong path with the schema").failureType).toBe("wrong_approach");
    expect(classifyPauseReason("Bad strategy for this migration").failureType).toBe("wrong_approach");
  });

  test("classifies blocked reasons", () => {
    expect(classifyPauseReason("Blocked on code review").failureType).toBe("blocked");
    expect(classifyPauseReason("Missing API credentials").failureType).toBe("blocked");
    expect(classifyPauseReason("Waiting on Dave for approval").failureType).toBe("blocked");
    expect(classifyPauseReason("Permission denied to deploy").failureType).toBe("blocked");
    expect(classifyPauseReason("Need access to production DB").failureType).toBe("blocked");
  });

  test("classifies unrecognized reasons as unknown", () => {
    const result = classifyPauseReason("Lunch break");
    expect(result.failureType).toBe("unknown");
    expect(result.patternTags).toEqual(["unclassified"]);
  });

  test("returns correct patternTags for each type", () => {
    expect(classifyPauseReason("Timed out").patternTags).toEqual(["timeout"]);
    expect(classifyPauseReason("Agent crashed").patternTags).toEqual(["crash"]);
    expect(classifyPauseReason("Wrong approach").patternTags).toEqual(["wrong-approach"]);
    expect(classifyPauseReason("Blocked on review").patternTags).toEqual(["blocked"]);
    expect(classifyPauseReason("Taking a nap").patternTags).toEqual(["unclassified"]);
  });

  test("is case-insensitive", () => {
    expect(classifyPauseReason("TIMED OUT").failureType).toBe("timeout");
    expect(classifyPauseReason("CRASHED").failureType).toBe("crash");
    expect(classifyPauseReason("BLOCKED").failureType).toBe("blocked");
  });

  test("timeout takes priority over blocked when both match", () => {
    // "timed out" should match timeout before "blocked" patterns
    expect(classifyPauseReason("Timed out waiting on API").failureType).toBe("timeout");
  });

  test("crash takes priority over blocked", () => {
    // "killed" matches crash, even if "blocked" might also appear
    expect(classifyPauseReason("Process killed while blocked").failureType).toBe("crash");
  });
});

// ── confidenceForFailureType (ELLIE-584) ────────────────────────────────────

describe("confidenceForFailureType", () => {
  test("timeout returns 0.7", () => {
    expect(confidenceForFailureType("timeout")).toBe(0.7);
  });

  test("crash returns 0.8", () => {
    expect(confidenceForFailureType("crash")).toBe(0.8);
  });

  test("wrong_approach returns 0.9", () => {
    expect(confidenceForFailureType("wrong_approach")).toBe(0.9);
  });

  test("blocked returns 0.9", () => {
    expect(confidenceForFailureType("blocked")).toBe(0.9);
  });

  test("unknown returns 0.6", () => {
    expect(confidenceForFailureType("unknown")).toBe(0.6);
  });
});

// ── buildForestFinding (ELLIE-584) ──────────────────────────────────────────

describe("buildForestFinding", () => {
  test("builds finding with all fields", () => {
    const finding = buildForestFinding({
      workItemId: "ELLIE-567",
      title: "Add context cards",
      agent: "dev",
      failureType: "timeout",
      whatHappened: "Agent ran out of time",
      whyItFailed: "Task too large for single session",
      whatToDoNextTime: "Break into smaller phases",
      patternTags: ["timeout", "task-too-large"],
      timestamp: "2026-03-05T12:00:00Z",
    });

    expect(finding.type).toBe("finding");
    expect(finding.scope_path).toBe("2/1");
    expect(finding.confidence).toBe(0.7);
    expect(finding.content).toContain("ELLIE-567");
    expect(finding.content).toContain("timeout");
    expect(finding.content).toContain("Root cause: Task too large");
    expect(finding.content).toContain("Lesson: Break into smaller phases");
    expect(finding.metadata.work_item_id).toBe("ELLIE-567");
    expect(finding.metadata.failure_type).toBe("timeout");
    expect(finding.metadata.agent).toBe("dev");
    expect(finding.metadata.pattern_tags).toEqual(["timeout", "task-too-large"]);
  });

  test("builds finding with minimal fields", () => {
    const finding = buildForestFinding({
      workItemId: "ELLIE-100",
      title: "Test",
      failureType: "crash",
      whatHappened: "Process exited unexpectedly",
    });

    expect(finding.confidence).toBe(0.8);
    expect(finding.content).toContain("ELLIE-100");
    expect(finding.content).toContain("What happened: Process exited unexpectedly");
    expect(finding.metadata.source).toBe("post-mortem");
  });

  test("includes whatHappened when no root cause or lesson", () => {
    const finding = buildForestFinding({
      workItemId: "ELLIE-200",
      title: "Unknown failure",
      failureType: "unknown",
      whatHappened: "Something went wrong",
    });

    expect(finding.content).toContain("What happened: Something went wrong");
    expect(finding.confidence).toBe(0.6);
  });

  test("omits whatHappened when root cause and lesson are present", () => {
    const finding = buildForestFinding({
      workItemId: "ELLIE-300",
      title: "Known bug",
      failureType: "wrong_approach",
      whatHappened: "Used wrong API endpoint",
      whyItFailed: "Endpoint was deprecated",
      whatToDoNextTime: "Check API docs first",
    });

    expect(finding.content).not.toContain("What happened:");
    expect(finding.content).toContain("Root cause: Endpoint was deprecated");
    expect(finding.content).toContain("Lesson: Check API docs first");
  });
});

// ── writePostMortemToForest (ELLIE-584) ─────────────────────────────────────

describe("writePostMortemToForest", () => {
  const sampleData: PostMortemData = {
    workItemId: "ELLIE-567",
    title: "Test failure",
    failureType: "timeout",
    whatHappened: "Ran out of time",
    whyItFailed: "Too much work",
    whatToDoNextTime: "Break into phases",
    timestamp: "2026-03-05T12:00:00Z",
  };

  test("calls fetch with correct URL and headers", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    const mockFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url as string;
      capturedInit = init;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await writePostMortemToForest(sampleData, mockFetch);

    expect(capturedUrl).toBe("http://test-relay:3001/api/bridge/write");
    expect(capturedInit!.method).toBe("POST");
    const headers = capturedInit!.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["x-bridge-key"]).toContain("bk_");
  });

  test("sends correct finding payload", async () => {
    let capturedBody: ForestFinding | null = null;

    const mockFetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await writePostMortemToForest(sampleData, mockFetch);

    expect(capturedBody!.type).toBe("finding");
    expect(capturedBody!.scope_path).toBe("2/1");
    expect(capturedBody!.confidence).toBe(0.7);
    expect(capturedBody!.content).toContain("ELLIE-567");
    expect(capturedBody!.metadata.work_item_id).toBe("ELLIE-567");
    expect(capturedBody!.metadata.failure_type).toBe("timeout");
  });

  test("returns true on successful write", async () => {
    const mockFetch = mock(async () => {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await writePostMortemToForest(sampleData, mockFetch);
    expect(result).toBe(true);
  });

  test("returns false on HTTP error", async () => {
    const mockFetch = mock(async () => {
      return new Response("Internal Server Error", { status: 500 });
    }) as unknown as typeof fetch;

    const result = await writePostMortemToForest(sampleData, mockFetch);
    expect(result).toBe(false);
  });

  test("returns false on network error", async () => {
    const mockFetch = mock(async () => {
      throw new Error("Connection refused");
    }) as unknown as typeof fetch;

    const result = await writePostMortemToForest(sampleData, mockFetch);
    expect(result).toBe(false);
  });

  test("does not throw on failure (fire-and-forget)", async () => {
    const mockFetch = mock(async () => {
      throw new Error("Network down");
    }) as unknown as typeof fetch;

    // Should not throw
    const result = await writePostMortemToForest(sampleData, mockFetch);
    expect(result).toBe(false);
  });
});
