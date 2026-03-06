/**
 * ELLIE-630 — Work trail activation tests
 *
 * Tests for new functions added to activate work trail writes:
 *
 * Pure builders:
 * - buildWorkTrailDecisionAppend: decision formatting with agent/timestamp
 * - updateWorkTrailFrontmatter: frontmatter field updates
 *
 * Effectful writers (mocked fs/promises + bridge-river):
 * - finalizeWorkTrail: reads existing, updates frontmatter, writes back
 * - finalizeWorkTrail: handles missing file, parse failure, write error
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mocks (must come before imports) ─────────────────────────────────────────

const mockWriteFile = mock(() => Promise.resolve());
const mockMkdir = mock(() => Promise.resolve());
const mockReadFile = mock(() => Promise.reject(new Error("ENOENT")));

mock.module("fs/promises", () => ({
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
  readFile: mockReadFile,
}));

const mockQmdReindex = mock(() => Promise.resolve(true));
const MOCK_RIVER_ROOT = "/tmp/river-test";

mock.module("../src/api/bridge-river.ts", () => ({
  RIVER_ROOT: MOCK_RIVER_ROOT,
  qmdReindex: mockQmdReindex,
}));

mock.module("../src/logger.ts", () => ({
  log: {
    child: () => ({
      info: mock(),
      warn: mock(),
      error: mock(),
    }),
  },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import {
  buildWorkTrailDecisionAppend,
  updateWorkTrailFrontmatter,
  finalizeWorkTrail,
} from "../src/work-trail-writer.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

const FIXED_TS = "2026-03-06T14:00:00.000Z";
const FIXED_DATE = "2026-03-06";

const SAMPLE_WORK_TRAIL = [
  "---",
  "work_item_id: ELLIE-630",
  "agent: dev",
  "status: in-progress",
  "started_at: 2026-03-06T12:00:00.000Z",
  "completed_at: null",
  "scope_path: 2/1",
  "---",
  "",
  "# Work Trail: ELLIE-630 — Activate work trails",
  "",
  "## Context",
  "",
  "## What Was Done",
  "",
  "## Files Changed",
  "",
  "## Decisions",
  "",
].join("\n");

beforeEach(() => {
  mockWriteFile.mockClear();
  mockWriteFile.mockImplementation(() => Promise.resolve());

  mockMkdir.mockClear();
  mockMkdir.mockImplementation(() => Promise.resolve());

  mockQmdReindex.mockClear();
  mockQmdReindex.mockImplementation(() => Promise.resolve(true));

  mockReadFile.mockClear();
  mockReadFile.mockImplementation(() => Promise.reject(new Error("ENOENT")));
});

// ── buildWorkTrailDecisionAppend ─────────────────────────────────────────────

describe("buildWorkTrailDecisionAppend", () => {
  test("contains the decision message", () => {
    const result = buildWorkTrailDecisionAppend("Using ES over plain SQL", undefined, FIXED_TS);
    expect(result).toContain("Using ES over plain SQL");
  });

  test("contains 'Decision' header", () => {
    const result = buildWorkTrailDecisionAppend("msg", undefined, FIXED_TS);
    expect(result).toContain("### Decision");
  });

  test("contains provided timestamp", () => {
    const result = buildWorkTrailDecisionAppend("msg", undefined, FIXED_TS);
    expect(result).toContain(FIXED_TS);
  });

  test("includes agent name when provided", () => {
    const result = buildWorkTrailDecisionAppend("msg", "dev-ant", FIXED_TS);
    expect(result).toContain("**dev-ant:**");
  });

  test("omits agent prefix when not provided", () => {
    const result = buildWorkTrailDecisionAppend("msg", undefined, FIXED_TS);
    expect(result).not.toContain("**");
  });

  test("starts with newline for clean appending", () => {
    const result = buildWorkTrailDecisionAppend("msg", undefined, FIXED_TS);
    expect(result).toMatch(/^\n/);
  });

  test("different messages produce different output", () => {
    const a = buildWorkTrailDecisionAppend("approach A", undefined, FIXED_TS);
    const b = buildWorkTrailDecisionAppend("approach B", undefined, FIXED_TS);
    expect(a).not.toBe(b);
  });

  test("uses current time when ts not provided", () => {
    const result = buildWorkTrailDecisionAppend("msg");
    // Should contain a timestamp-like string (ISO 8601 pattern)
    expect(result).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

// ── updateWorkTrailFrontmatter ───────────────────────────────────────────────

describe("updateWorkTrailFrontmatter", () => {
  test("updates status field", () => {
    const result = updateWorkTrailFrontmatter(SAMPLE_WORK_TRAIL, { status: "done" });
    expect(result).not.toBeNull();
    expect(result).toContain("status: done");
    expect(result).not.toContain("status: in-progress");
  });

  test("updates completed_at field", () => {
    const result = updateWorkTrailFrontmatter(SAMPLE_WORK_TRAIL, { completed_at: FIXED_TS });
    expect(result).not.toBeNull();
    expect(result).toContain(`completed_at: ${FIXED_TS}`);
    expect(result).not.toContain("completed_at: null");
  });

  test("updates multiple fields at once", () => {
    const result = updateWorkTrailFrontmatter(SAMPLE_WORK_TRAIL, {
      status: "done",
      completed_at: FIXED_TS,
    });
    expect(result).toContain("status: done");
    expect(result).toContain(`completed_at: ${FIXED_TS}`);
  });

  test("preserves non-updated fields", () => {
    const result = updateWorkTrailFrontmatter(SAMPLE_WORK_TRAIL, { status: "done" });
    expect(result).toContain("work_item_id: ELLIE-630");
    expect(result).toContain("agent: dev");
    expect(result).toContain("scope_path: 2/1");
  });

  test("preserves body content after frontmatter", () => {
    const result = updateWorkTrailFrontmatter(SAMPLE_WORK_TRAIL, { status: "done" });
    expect(result).toContain("# Work Trail: ELLIE-630");
    expect(result).toContain("## Context");
    expect(result).toContain("## What Was Done");
  });

  test("adds new fields if not present", () => {
    const result = updateWorkTrailFrontmatter(SAMPLE_WORK_TRAIL, { new_field: "value" });
    expect(result).toContain("new_field: value");
  });

  test("returns null for content without frontmatter delimiters", () => {
    const result = updateWorkTrailFrontmatter("# Just a heading\n\nSome body text.", { status: "done" });
    expect(result).toBeNull();
  });

  test("returns null for content with only one delimiter", () => {
    const result = updateWorkTrailFrontmatter("---\nstatus: in-progress\nNo closing delimiter", { status: "done" });
    expect(result).toBeNull();
  });
});

// ── finalizeWorkTrail ────────────────────────────────────────────────────────

describe("finalizeWorkTrail — success", () => {
  test("reads existing file", async () => {
    mockReadFile.mockImplementation(() => Promise.resolve(SAMPLE_WORK_TRAIL));

    await finalizeWorkTrail("ELLIE-630", FIXED_TS, FIXED_DATE);
    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });

  test("writes updated content with status=done", async () => {
    mockReadFile.mockImplementation(() => Promise.resolve(SAMPLE_WORK_TRAIL));

    await finalizeWorkTrail("ELLIE-630", FIXED_TS, FIXED_DATE);
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const [, content] = mockWriteFile.mock.calls[0] as [string, string, unknown];
    expect(content).toContain("status: done");
  });

  test("writes updated content with completed_at", async () => {
    mockReadFile.mockImplementation(() => Promise.resolve(SAMPLE_WORK_TRAIL));

    await finalizeWorkTrail("ELLIE-630", FIXED_TS, FIXED_DATE);
    const [, content] = mockWriteFile.mock.calls[0] as [string, string, unknown];
    expect(content).toContain(`completed_at: ${FIXED_TS}`);
  });

  test("preserves body content", async () => {
    mockReadFile.mockImplementation(() => Promise.resolve(SAMPLE_WORK_TRAIL));

    await finalizeWorkTrail("ELLIE-630", FIXED_TS, FIXED_DATE);
    const [, content] = mockWriteFile.mock.calls[0] as [string, string, unknown];
    expect(content).toContain("# Work Trail: ELLIE-630");
    expect(content).toContain("## Context");
  });

  test("triggers qmdReindex after write", async () => {
    mockReadFile.mockImplementation(() => Promise.resolve(SAMPLE_WORK_TRAIL));

    await finalizeWorkTrail("ELLIE-630", FIXED_TS, FIXED_DATE);
    expect(mockQmdReindex).toHaveBeenCalledTimes(1);
  });

  test("returns true on success", async () => {
    mockReadFile.mockImplementation(() => Promise.resolve(SAMPLE_WORK_TRAIL));

    const result = await finalizeWorkTrail("ELLIE-630", FIXED_TS, FIXED_DATE);
    expect(result).toBe(true);
  });

  test("writes to correct path", async () => {
    mockReadFile.mockImplementation(() => Promise.resolve(SAMPLE_WORK_TRAIL));

    await finalizeWorkTrail("ELLIE-630", FIXED_TS, FIXED_DATE);
    const [pathArg] = mockWriteFile.mock.calls[0] as [string, unknown, unknown];
    expect(pathArg).toBe(`${MOCK_RIVER_ROOT}/work-trails/ELLIE-630/ELLIE-630-${FIXED_DATE}.md`);
  });

  test("uses current time when completedAt not provided", async () => {
    mockReadFile.mockImplementation(() => Promise.resolve(SAMPLE_WORK_TRAIL));

    await finalizeWorkTrail("ELLIE-630", undefined, FIXED_DATE);
    const [, content] = mockWriteFile.mock.calls[0] as [string, string, unknown];
    // Should contain a real ISO timestamp (not "null")
    expect(content).toMatch(/completed_at: \d{4}-\d{2}-\d{2}T/);
  });
});

describe("finalizeWorkTrail — file not found", () => {
  test("returns false when file doesn't exist", async () => {
    // readFile throws ENOENT by default
    const result = await finalizeWorkTrail("ELLIE-630", FIXED_TS, FIXED_DATE);
    expect(result).toBe(false);
  });

  test("does not write when file doesn't exist", async () => {
    await finalizeWorkTrail("ELLIE-630", FIXED_TS, FIXED_DATE);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  test("does not reindex when file doesn't exist", async () => {
    await finalizeWorkTrail("ELLIE-630", FIXED_TS, FIXED_DATE);
    expect(mockQmdReindex).not.toHaveBeenCalled();
  });
});

describe("finalizeWorkTrail — error handling", () => {
  test("returns false when content has no frontmatter", async () => {
    mockReadFile.mockImplementation(() => Promise.resolve("# No frontmatter\n\nJust body."));

    const result = await finalizeWorkTrail("ELLIE-630", FIXED_TS, FIXED_DATE);
    expect(result).toBe(false);
  });

  test("returns false when writeFile throws", async () => {
    mockReadFile.mockImplementation(() => Promise.resolve(SAMPLE_WORK_TRAIL));
    mockWriteFile.mockImplementation(() => Promise.reject(new Error("ENOSPC")));

    const result = await finalizeWorkTrail("ELLIE-630", FIXED_TS, FIXED_DATE);
    expect(result).toBe(false);
  });

  test("does not throw on error — non-fatal", async () => {
    mockWriteFile.mockImplementation(() => Promise.reject(new Error("ENOSPC")));
    mockReadFile.mockImplementation(() => Promise.resolve(SAMPLE_WORK_TRAIL));

    await expect(
      finalizeWorkTrail("ELLIE-630", FIXED_TS, FIXED_DATE)
    ).resolves.toBe(false);
  });
});
