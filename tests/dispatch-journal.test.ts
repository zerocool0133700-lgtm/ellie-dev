/**
 * ELLIE-565 — Dispatch Journal Tests
 *
 * Tests the pure content builders (buildJournalPath, buildJournalHeader,
 * buildStartEntry, buildEndEntry) and the effectful appendJournalEntry
 * with mocked fs/QMD dependencies.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Track fs + QMD calls ────────────────────────────────────────────────────

let _writtenFiles: Array<{ path: string; content: string }> = [];
let _readFiles: Map<string, string> = new Map();
let _mkdirCalls: string[] = [];
let _reindexCalls = 0;

mock.module("fs/promises", () => ({
  writeFile: mock(async (path: string, content: string) => {
    _writtenFiles.push({ path, content });
  }),
  readFile: mock(async (path: string) => {
    const content = _readFiles.get(path);
    if (content === undefined) throw new Error("ENOENT");
    return content;
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

// ── Import after mocks ──────────────────────────────────────────────────────

import {
  buildJournalPath,
  buildJournalHeader,
  buildStartEntry,
  buildEndEntry,
  appendJournalEntry,
  journalDispatchStart,
  journalDispatchEnd,
} from "../src/dispatch-journal";

// ── Reset state ─────────────────────────────────────────────────────────────

beforeEach(() => {
  _writtenFiles = [];
  _readFiles = new Map();
  _mkdirCalls = [];
  _reindexCalls = 0;
});

// ── buildJournalPath ────────────────────────────────────────────────────────

describe("buildJournalPath", () => {
  test("builds path with explicit date", () => {
    expect(buildJournalPath("2026-03-05")).toBe("dispatch-journal/2026-03-05.md");
  });

  test("builds path with today's date when no date given", () => {
    const path = buildJournalPath();
    expect(path).toMatch(/^dispatch-journal\/\d{4}-\d{2}-\d{2}\.md$/);
  });
});

// ── buildJournalHeader ──────────────────────────────────────────────────────

describe("buildJournalHeader", () => {
  test("builds frontmatter + H1 with date", () => {
    const header = buildJournalHeader("2026-03-05");

    expect(header).toContain("---");
    expect(header).toContain("type: dispatch-journal");
    expect(header).toContain("date: 2026-03-05");
    expect(header).toContain("# Dispatch Journal — 2026-03-05");
  });

  test("defaults to today's date", () => {
    const header = buildJournalHeader();
    const today = new Date().toISOString().slice(0, 10);
    expect(header).toContain(`date: ${today}`);
  });
});

// ── buildStartEntry ─────────────────────────────────────────────────────────

describe("buildStartEntry", () => {
  test("builds start entry with all fields", () => {
    const entry = buildStartEntry({
      workItemId: "ELLIE-565",
      title: "Add dispatch journal",
      agent: "dev",
      sessionId: "session-abc",
      pid: 12345,
      startedAt: "2026-03-05T12:00:00Z",
    });

    expect(entry).toContain("### ELLIE-565 — Started");
    expect(entry).toContain("**Time:** 2026-03-05T12:00:00Z");
    expect(entry).toContain("**Title:** Add dispatch journal");
    expect(entry).toContain("**Session:** `session-abc`");
    expect(entry).toContain("**Agent:** dev");
    expect(entry).toContain("**PID:** 12345");
    expect(entry).toContain("**Status:** in-progress");
  });

  test("omits agent and PID when not provided", () => {
    const entry = buildStartEntry({
      workItemId: "ELLIE-100",
      title: "Test",
      sessionId: "sess-1",
    });

    expect(entry).toContain("### ELLIE-100 — Started");
    expect(entry).not.toContain("**Agent:**");
    expect(entry).not.toContain("**PID:**");
  });

  test("defaults startedAt to now when not provided", () => {
    const entry = buildStartEntry({
      workItemId: "ELLIE-100",
      title: "Test",
      sessionId: "sess-1",
    });

    // Should contain a valid ISO timestamp
    expect(entry).toMatch(/\*\*Time:\*\* \d{4}-\d{2}-\d{2}T/);
  });
});

// ── buildEndEntry ───────────────────────────────────────────────────────────

describe("buildEndEntry", () => {
  test("builds completed entry with all fields", () => {
    const entry = buildEndEntry({
      workItemId: "ELLIE-565",
      agent: "dev",
      outcome: "completed",
      summary: "Journal module added",
      durationMinutes: 15,
      endedAt: "2026-03-05T12:15:00Z",
    });

    expect(entry).toContain("### ELLIE-565 — Completed");
    expect(entry).toContain("**Time:** 2026-03-05T12:15:00Z");
    expect(entry).toContain("**Outcome:** completed");
    expect(entry).toContain("**Agent:** dev");
    expect(entry).toContain("**Duration:** 15 minutes");
    expect(entry).toContain("**Summary:** Journal module added");
  });

  test("builds timeout entry", () => {
    const entry = buildEndEntry({
      workItemId: "ELLIE-500",
      outcome: "timeout",
      durationMinutes: 30,
    });

    expect(entry).toContain("### ELLIE-500 — Timeout");
    expect(entry).toContain("**Outcome:** timeout");
    expect(entry).toContain("**Duration:** 30 minutes");
  });

  test("builds crashed entry", () => {
    const entry = buildEndEntry({
      workItemId: "ELLIE-500",
      outcome: "crashed",
    });

    expect(entry).toContain("### ELLIE-500 — Crashed");
    expect(entry).toContain("**Outcome:** crashed");
  });

  test("builds paused entry with reason as summary", () => {
    const entry = buildEndEntry({
      workItemId: "ELLIE-500",
      outcome: "paused",
      summary: "Waiting on design review",
    });

    expect(entry).toContain("### ELLIE-500 — Paused");
    expect(entry).toContain("**Summary:** Waiting on design review");
  });

  test("builds blocked entry", () => {
    const entry = buildEndEntry({
      workItemId: "ELLIE-500",
      outcome: "blocked",
      summary: "Missing API key",
    });

    expect(entry).toContain("### ELLIE-500 — Blocked");
  });

  test("omits optional fields when not provided", () => {
    const entry = buildEndEntry({
      workItemId: "ELLIE-500",
      outcome: "completed",
    });

    expect(entry).not.toContain("**Agent:**");
    expect(entry).not.toContain("**Duration:**");
    expect(entry).not.toContain("**Summary:**");
  });
});

// ── appendJournalEntry ──────────────────────────────────────────────────────

describe("appendJournalEntry", () => {
  test("creates new file with header when file doesn't exist", async () => {
    const result = await appendJournalEntry(
      "\n### ELLIE-565 — Started\n",
      "2026-03-05",
    );

    expect(result).toBe(true);
    expect(_writtenFiles).toHaveLength(1);

    const written = _writtenFiles[0];
    expect(written.path).toBe("/test-vault/dispatch-journal/2026-03-05.md");
    expect(written.content).toContain("# Dispatch Journal — 2026-03-05");
    expect(written.content).toContain("### ELLIE-565 — Started");
  });

  test("appends to existing file", async () => {
    _readFiles.set(
      "/test-vault/dispatch-journal/2026-03-05.md",
      "---\ntype: dispatch-journal\ndate: 2026-03-05\n---\n\n# Dispatch Journal — 2026-03-05\n\n### ELLIE-100 — Started\n",
    );

    const result = await appendJournalEntry(
      "\n### ELLIE-200 — Started\n",
      "2026-03-05",
    );

    expect(result).toBe(true);
    const written = _writtenFiles[0];
    expect(written.content).toContain("### ELLIE-100 — Started");
    expect(written.content).toContain("### ELLIE-200 — Started");
  });

  test("creates parent directory", async () => {
    await appendJournalEntry("\nentry\n", "2026-03-05");

    expect(_mkdirCalls.some((p) => p.includes("dispatch-journal"))).toBe(true);
  });

  test("triggers QMD reindex", async () => {
    await appendJournalEntry("\nentry\n", "2026-03-05");

    expect(_reindexCalls).toBe(1);
  });

  test("returns false on error", async () => {
    // Force mkdir to throw
    const { mkdir } = await import("fs/promises");
    (mkdir as ReturnType<typeof mock>).mockImplementationOnce(() => {
      throw new Error("permission denied");
    });

    const result = await appendJournalEntry("\nentry\n", "2026-03-05");
    expect(result).toBe(false);
  });
});

// ── journalDispatchStart ────────────────────────────────────────────────────

describe("journalDispatchStart", () => {
  test("writes start entry to journal", async () => {
    const result = await journalDispatchStart({
      workItemId: "ELLIE-565",
      title: "Add dispatch journal",
      agent: "dev",
      sessionId: "sess-123",
      pid: 9999,
      startedAt: "2026-03-05T12:00:00Z",
    });

    expect(result).toBe(true);
    expect(_writtenFiles).toHaveLength(1);
    expect(_writtenFiles[0].content).toContain("### ELLIE-565 — Started");
    expect(_writtenFiles[0].content).toContain("**PID:** 9999");
  });
});

// ── journalDispatchEnd ──────────────────────────────────────────────────────

describe("journalDispatchEnd", () => {
  test("writes end entry to journal", async () => {
    const result = await journalDispatchEnd({
      workItemId: "ELLIE-565",
      agent: "dev",
      outcome: "completed",
      summary: "Done",
      durationMinutes: 10,
      endedAt: "2026-03-05T12:10:00Z",
    });

    expect(result).toBe(true);
    expect(_writtenFiles).toHaveLength(1);
    expect(_writtenFiles[0].content).toContain("### ELLIE-565 — Completed");
    expect(_writtenFiles[0].content).toContain("**Duration:** 10 minutes");
  });

  test("writes timeout entry", async () => {
    await journalDispatchEnd({
      workItemId: "ELLIE-500",
      outcome: "timeout",
      durationMinutes: 30,
    });

    expect(_writtenFiles[0].content).toContain("### ELLIE-500 — Timeout");
  });
});
