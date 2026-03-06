/**
 * ELLIE-567 — Ticket Context Card Tests
 *
 * Tests the pure content builders (path, card content, work history append,
 * handoff append) and the effectful writers (ensureContextCard, appendWorkHistory,
 * appendHandoffNote, readContextCard) with mocked fs/QMD.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mock fs + QMD ───────────────────────────────────────────────────────────

let _writtenFiles: Array<{ path: string; content: string }> = [];
let _readFiles: Map<string, string> = new Map();
let _mkdirCalls: string[] = [];
let _reindexCalls = 0;

mock.module("fs/promises", () => ({
  writeFile: mock(async (path: string, content: string) => {
    _writtenFiles.push({ path, content });
    _readFiles.set(path, content);
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
  buildContextCardPath,
  buildContextCardContent,
  buildWorkHistoryAppend,
  buildHandoffAppend,
  ensureContextCard,
  appendWorkHistory,
  appendHandoffNote,
  readContextCard,
} from "../src/ticket-context-card";

// ── Reset ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  _writtenFiles = [];
  _readFiles = new Map();
  _mkdirCalls = [];
  _reindexCalls = 0;
});

// ── buildContextCardPath ────────────────────────────────────────────────────

describe("buildContextCardPath", () => {
  test("builds path from work item ID", () => {
    expect(buildContextCardPath("ELLIE-567")).toBe("tickets/ELLIE-567.md");
  });

  test("handles different IDs", () => {
    expect(buildContextCardPath("ELLIE-100")).toBe("tickets/ELLIE-100.md");
  });
});

// ── buildContextCardContent ─────────────────────────────────────────────────

describe("buildContextCardContent", () => {
  test("builds card with all fields", () => {
    const content = buildContextCardContent({
      workItemId: "ELLIE-567",
      title: "Add ticket context cards",
      priority: "high",
      agent: "dev",
    });

    expect(content).toContain("type: ticket-context-card");
    expect(content).toContain("work_item_id: ELLIE-567");
    expect(content).toContain('title: "Add ticket context cards"');
    expect(content).toContain("priority: high");
    expect(content).toContain("# ELLIE-567 — Add ticket context cards");
    expect(content).toContain("**Status:** in-progress");
    expect(content).toContain("**Priority:** high");
    expect(content).toContain("**Last Agent:** dev");
    expect(content).toContain("## Work History");
    expect(content).toContain("## Files Involved");
    expect(content).toContain("## Handoff Notes");
  });

  test("omits optional fields when not provided", () => {
    const content = buildContextCardContent({
      workItemId: "ELLIE-100",
      title: "Test ticket",
    });

    expect(content).toContain("work_item_id: ELLIE-100");
    expect(content).not.toContain("priority:");
    expect(content).toContain("**Priority:** unknown");
    expect(content).not.toContain("**Last Agent:**");
  });

  test("escapes quotes in title", () => {
    const content = buildContextCardContent({
      workItemId: "ELLIE-200",
      title: 'Fix "broken" thing',
    });

    expect(content).toContain('title: "Fix \\"broken\\" thing"');
  });
});

// ── buildWorkHistoryAppend ──────────────────────────────────────────────────

describe("buildWorkHistoryAppend", () => {
  test("builds entry with all fields", () => {
    const entry = buildWorkHistoryAppend({
      agent: "dev",
      outcome: "completed",
      summary: "Implemented feature",
      durationMinutes: 45,
      timestamp: "2026-03-05T12:00:00Z",
    });

    expect(entry).toContain("### Session — 2026-03-05T12:00");
    expect(entry).toContain("**Outcome:** completed");
    expect(entry).toContain("**Agent:** dev");
    expect(entry).toContain("**Duration:** 45 minutes");
    expect(entry).toContain("**Summary:** Implemented feature");
  });

  test("omits optional fields", () => {
    const entry = buildWorkHistoryAppend({
      outcome: "timeout",
      timestamp: "2026-03-05T14:00:00Z",
    });

    expect(entry).toContain("**Outcome:** timeout");
    expect(entry).not.toContain("**Agent:**");
    expect(entry).not.toContain("**Duration:**");
    expect(entry).not.toContain("**Summary:**");
  });

  test("defaults timestamp to now", () => {
    const entry = buildWorkHistoryAppend({ outcome: "completed" });
    expect(entry).toMatch(/### Session — \d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
});

// ── buildHandoffAppend ──────────────────────────────────────────────────────

describe("buildHandoffAppend", () => {
  test("builds handoff with all fields", () => {
    const note = buildHandoffAppend({
      whatWasAttempted: "Tried to fix the bug",
      whatToDoDifferently: "Use a different approach",
      filesInvolved: ["src/foo.ts", "src/bar.ts"],
      blockers: ["Missing API key", "Test failures"],
      timestamp: "2026-03-05T15:00:00Z",
    });

    expect(note).toContain("### Handoff — 2026-03-05T15:00");
    expect(note).toContain("**What was attempted:** Tried to fix the bug");
    expect(note).toContain("**What to do differently:** Use a different approach");
    expect(note).toContain("**Files involved:**");
    expect(note).toContain("- `src/foo.ts`");
    expect(note).toContain("- `src/bar.ts`");
    expect(note).toContain("**Blockers:**");
    expect(note).toContain("- Missing API key");
    expect(note).toContain("- Test failures");
  });

  test("omits optional fields", () => {
    const note = buildHandoffAppend({
      whatWasAttempted: "Basic attempt",
      timestamp: "2026-03-05T15:00:00Z",
    });

    expect(note).toContain("**What was attempted:** Basic attempt");
    expect(note).not.toContain("**What to do differently:**");
    expect(note).not.toContain("**Files involved:**");
    expect(note).not.toContain("**Blockers:**");
  });

  test("defaults timestamp to now", () => {
    const note = buildHandoffAppend({ whatWasAttempted: "Test" });
    expect(note).toMatch(/### Handoff — \d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
});

// ── ensureContextCard ───────────────────────────────────────────────────────

describe("ensureContextCard", () => {
  test("creates card when it doesn't exist", async () => {
    const result = await ensureContextCard({
      workItemId: "ELLIE-567",
      title: "Context cards",
    });

    expect(result).toBe(true);
    expect(_writtenFiles).toHaveLength(1);
    expect(_writtenFiles[0].path).toBe("/test-vault/tickets/ELLIE-567.md");
    expect(_writtenFiles[0].content).toContain("# ELLIE-567 — Context cards");
    expect(_reindexCalls).toBe(1);
  });

  test("skips creation when card already exists", async () => {
    _readFiles.set(
      "/test-vault/tickets/ELLIE-567.md",
      "existing content",
    );

    const result = await ensureContextCard({
      workItemId: "ELLIE-567",
      title: "Context cards",
    });

    expect(result).toBe(true);
    expect(_writtenFiles).toHaveLength(0);
    expect(_reindexCalls).toBe(0);
  });

  test("creates parent directory", async () => {
    await ensureContextCard({
      workItemId: "ELLIE-567",
      title: "Test",
    });

    expect(_mkdirCalls.some((p) => p.includes("tickets"))).toBe(true);
  });
});

// ── appendWorkHistory ───────────────────────────────────────────────────────

describe("appendWorkHistory", () => {
  test("appends to existing card", async () => {
    const cardContent = buildContextCardContent({
      workItemId: "ELLIE-567",
      title: "Test",
    });
    _readFiles.set("/test-vault/tickets/ELLIE-567.md", cardContent);

    const result = await appendWorkHistory("ELLIE-567", "Test", {
      outcome: "completed",
      summary: "Done",
      timestamp: "2026-03-05T12:00:00Z",
    });

    expect(result).toBe(true);
    expect(_writtenFiles).toHaveLength(1);
    const written = _writtenFiles[0].content;
    expect(written).toContain("### Session — 2026-03-05T12:00");
    expect(written).toContain("**Outcome:** completed");
    expect(written).toContain("**Summary:** Done");
  });

  test("creates card first if it doesn't exist", async () => {
    const result = await appendWorkHistory("ELLIE-999", "New ticket", {
      outcome: "completed",
      summary: "Done",
      timestamp: "2026-03-05T12:00:00Z",
    });

    expect(result).toBe(true);
    // First write: card creation, second write: append
    expect(_writtenFiles.length).toBeGreaterThanOrEqual(1);
    const lastWrite = _writtenFiles[_writtenFiles.length - 1];
    expect(lastWrite.content).toContain("ELLIE-999");
    expect(lastWrite.content).toContain("**Outcome:** completed");
  });

  test("removes placeholder text", async () => {
    const cardContent = buildContextCardContent({
      workItemId: "ELLIE-567",
      title: "Test",
    });
    _readFiles.set("/test-vault/tickets/ELLIE-567.md", cardContent);

    await appendWorkHistory("ELLIE-567", "Test", {
      outcome: "completed",
      timestamp: "2026-03-05T12:00:00Z",
    });

    const written = _writtenFiles[_writtenFiles.length - 1].content;
    expect(written).not.toContain("*No sessions recorded yet.*");
  });

  test("triggers QMD reindex", async () => {
    const cardContent = buildContextCardContent({
      workItemId: "ELLIE-567",
      title: "Test",
    });
    _readFiles.set("/test-vault/tickets/ELLIE-567.md", cardContent);

    await appendWorkHistory("ELLIE-567", "Test", {
      outcome: "completed",
    });

    expect(_reindexCalls).toBeGreaterThanOrEqual(1);
  });
});

// ── appendHandoffNote ───────────────────────────────────────────────────────

describe("appendHandoffNote", () => {
  test("appends handoff to existing card", async () => {
    const cardContent = buildContextCardContent({
      workItemId: "ELLIE-567",
      title: "Test",
    });
    _readFiles.set("/test-vault/tickets/ELLIE-567.md", cardContent);

    const result = await appendHandoffNote("ELLIE-567", "Test", {
      whatWasAttempted: "Tried X",
      blockers: ["Missing Y"],
      timestamp: "2026-03-05T15:00:00Z",
    });

    expect(result).toBe(true);
    const written = _writtenFiles[_writtenFiles.length - 1].content;
    expect(written).toContain("### Handoff — 2026-03-05T15:00");
    expect(written).toContain("**What was attempted:** Tried X");
    expect(written).toContain("- Missing Y");
  });

  test("creates card first if it doesn't exist", async () => {
    const result = await appendHandoffNote("ELLIE-888", "New ticket", {
      whatWasAttempted: "Initial attempt",
      timestamp: "2026-03-05T15:00:00Z",
    });

    expect(result).toBe(true);
    expect(_writtenFiles.length).toBeGreaterThanOrEqual(1);
    const lastWrite = _writtenFiles[_writtenFiles.length - 1];
    expect(lastWrite.content).toContain("ELLIE-888");
    expect(lastWrite.content).toContain("**What was attempted:** Initial attempt");
  });

  test("removes placeholder text", async () => {
    const cardContent = buildContextCardContent({
      workItemId: "ELLIE-567",
      title: "Test",
    });
    _readFiles.set("/test-vault/tickets/ELLIE-567.md", cardContent);

    await appendHandoffNote("ELLIE-567", "Test", {
      whatWasAttempted: "Tried X",
      timestamp: "2026-03-05T15:00:00Z",
    });

    const written = _writtenFiles[_writtenFiles.length - 1].content;
    expect(written).not.toContain("*No handoff notes.*");
  });

  test("triggers QMD reindex", async () => {
    const cardContent = buildContextCardContent({
      workItemId: "ELLIE-567",
      title: "Test",
    });
    _readFiles.set("/test-vault/tickets/ELLIE-567.md", cardContent);

    await appendHandoffNote("ELLIE-567", "Test", {
      whatWasAttempted: "Test",
    });

    expect(_reindexCalls).toBeGreaterThanOrEqual(1);
  });
});

// ── readContextCard ─────────────────────────────────────────────────────────

describe("readContextCard", () => {
  test("returns content when card exists", async () => {
    _readFiles.set("/test-vault/tickets/ELLIE-567.md", "card content");

    const result = await readContextCard("ELLIE-567");
    expect(result).toBe("card content");
  });

  test("returns null when card doesn't exist", async () => {
    const result = await readContextCard("ELLIE-999");
    expect(result).toBeNull();
  });
});
