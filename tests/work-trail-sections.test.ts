/**
 * ELLIE-630 — Work trail section-aware insertion tests
 *
 * Tests for:
 * - insertIntoSection: routing content into the correct ## section
 * - buildFilesChangedTable: formatting git diff data
 * - appendWorkTrailProgress with section parameter (mocked fs)
 * - Integration: updates go into ## What Was Done, decisions into ## Decisions
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
  insertIntoSection,
  buildFilesChangedTable,
  buildWorkTrailStartContent,
  buildWorkTrailUpdateAppend,
  buildWorkTrailDecisionAppend,
  appendWorkTrailProgress,
} from "../src/work-trail-writer.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

const FIXED_TS = "2026-03-07T10:00:00.000Z";
const FIXED_DATE = "2026-03-07";

function buildSampleTrail(): string {
  return buildWorkTrailStartContent("ELLIE-630", "Activate work trails", "dev", FIXED_TS);
}

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

// ── insertIntoSection ────────────────────────────────────────────────────────

describe("insertIntoSection", () => {
  test("inserts content into ## What Was Done section", () => {
    const doc = buildSampleTrail();
    const result = insertIntoSection(doc, "## What Was Done", "- Completed step 1");
    expect(result).not.toBeNull();
    expect(result).toContain("## What Was Done");
    expect(result).toContain("- Completed step 1");
    // Content should be BEFORE ## Files Changed
    const whatIdx = result!.indexOf("- Completed step 1");
    const filesIdx = result!.indexOf("## Files Changed");
    expect(whatIdx).toBeLessThan(filesIdx);
  });

  test("inserts content into ## Decisions section", () => {
    const doc = buildSampleTrail();
    const result = insertIntoSection(doc, "## Decisions", "Chose approach A");
    expect(result).not.toBeNull();
    expect(result).toContain("Chose approach A");
    // Content should be AFTER ## Decisions heading
    const decisionsIdx = result!.indexOf("## Decisions");
    const contentIdx = result!.indexOf("Chose approach A");
    expect(contentIdx).toBeGreaterThan(decisionsIdx);
  });

  test("inserts content into ## Files Changed section", () => {
    const doc = buildSampleTrail();
    const result = insertIntoSection(doc, "## Files Changed", "| `src/foo.ts` | Modified |");
    expect(result).not.toBeNull();
    expect(result).toContain("| `src/foo.ts` | Modified |");
    // Should be between ## Files Changed and ## Decisions
    const filesIdx = result!.indexOf("## Files Changed");
    const contentIdx = result!.indexOf("| `src/foo.ts` | Modified |");
    const decisionsIdx = result!.indexOf("## Decisions");
    expect(contentIdx).toBeGreaterThan(filesIdx);
    expect(contentIdx).toBeLessThan(decisionsIdx);
  });

  test("removes HTML comment placeholders", () => {
    const doc = buildSampleTrail();
    const result = insertIntoSection(doc, "## What Was Done", "- Step 1");
    expect(result).not.toBeNull();
    expect(result).not.toContain("<!-- Step-by-step progress");
  });

  test("preserves existing content in section when appending", () => {
    const doc = buildSampleTrail();
    // First insert
    const r1 = insertIntoSection(doc, "## What Was Done", "- Step 1");
    expect(r1).not.toBeNull();
    // Second insert into the same section
    const r2 = insertIntoSection(r1!, "## What Was Done", "- Step 2");
    expect(r2).not.toBeNull();
    expect(r2).toContain("- Step 1");
    expect(r2).toContain("- Step 2");
  });

  test("returns null when section not found", () => {
    const doc = buildSampleTrail();
    const result = insertIntoSection(doc, "## Nonexistent Section", "content");
    expect(result).toBeNull();
  });

  test("preserves frontmatter", () => {
    const doc = buildSampleTrail();
    const result = insertIntoSection(doc, "## What Was Done", "- Step 1");
    expect(result).toContain("work_item_id: ELLIE-630");
    expect(result).toContain("status: in-progress");
  });

  test("preserves cross-refs footer", () => {
    const doc = buildSampleTrail();
    const result = insertIntoSection(doc, "## What Was Done", "- Step 1");
    expect(result).toContain("*Cross-refs: [[ELLIE-630]]");
  });

  test("preserves the table header in Files Changed", () => {
    const doc = buildSampleTrail();
    const result = insertIntoSection(doc, "## Files Changed", "| `a.ts` | Added |");
    expect(result).toContain("| File | Change |");
    expect(result).toContain("|------|--------|");
  });

  test("works with ## Context section", () => {
    const doc = buildSampleTrail();
    const result = insertIntoSection(doc, "## Context", "Found prior work on ELLIE-529");
    expect(result).not.toBeNull();
    expect(result).toContain("Found prior work on ELLIE-529");
    const ctxIdx = result!.indexOf("Found prior work on ELLIE-529");
    const whatIdx = result!.indexOf("## What Was Done");
    expect(ctxIdx).toBeLessThan(whatIdx);
  });
});

// ── buildFilesChangedTable ───────────────────────────────────────────────────

describe("buildFilesChangedTable", () => {
  test("formats file entries as markdown table rows", () => {
    const result = buildFilesChangedTable([
      { file: "src/api/search.ts", change: "Added" },
      { file: "src/http-routes.ts", change: "Modified" },
    ]);
    expect(result).toContain("| `src/api/search.ts` | Added |");
    expect(result).toContain("| `src/http-routes.ts` | Modified |");
  });

  test("returns placeholder for empty array", () => {
    const result = buildFilesChangedTable([]);
    expect(result).toContain("(none)");
  });

  test("handles single file", () => {
    const result = buildFilesChangedTable([{ file: "README.md", change: "Deleted" }]);
    expect(result).toBe("| `README.md` | Deleted |");
  });
});

// ── appendWorkTrailProgress with section ─────────────────────────────────────

describe("appendWorkTrailProgress with section param", () => {
  test("inserts update into ## What Was Done section", async () => {
    const trail = buildSampleTrail();
    mockReadFile.mockImplementation(() => Promise.resolve(trail));

    await appendWorkTrailProgress(
      "ELLIE-630",
      buildWorkTrailUpdateAppend("Completed the search API", FIXED_TS),
      FIXED_DATE,
      "## What Was Done",
    );

    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const [, content] = mockWriteFile.mock.calls[0] as [string, string, unknown];
    // Update should be inside ## What Was Done, before ## Files Changed
    const updateIdx = content.indexOf("Completed the search API");
    const filesIdx = content.indexOf("## Files Changed");
    expect(updateIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeLessThan(filesIdx);
  });

  test("inserts decision into ## Decisions section", async () => {
    const trail = buildSampleTrail();
    mockReadFile.mockImplementation(() => Promise.resolve(trail));

    await appendWorkTrailProgress(
      "ELLIE-630",
      buildWorkTrailDecisionAppend("Chose hybrid search", "dev", FIXED_TS),
      FIXED_DATE,
      "## Decisions",
    );

    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const [, content] = mockWriteFile.mock.calls[0] as [string, string, unknown];
    const decisionIdx = content.indexOf("Chose hybrid search");
    const decisionsHeadingIdx = content.indexOf("## Decisions");
    expect(decisionIdx).toBeGreaterThan(decisionsHeadingIdx);
  });

  test("falls back to end-append when section not found", async () => {
    const trail = buildSampleTrail();
    mockReadFile.mockImplementation(() => Promise.resolve(trail));

    await appendWorkTrailProgress(
      "ELLIE-630",
      "orphan content",
      FIXED_DATE,
      "## Nonexistent",
    );

    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const [, content] = mockWriteFile.mock.calls[0] as [string, string, unknown];
    // Should be appended at end since section doesn't exist
    expect(content).toContain("orphan content");
  });

  test("falls back to end-append when no existing file", async () => {
    // readFile throws ENOENT by default
    await appendWorkTrailProgress(
      "ELLIE-630",
      "fresh content",
      FIXED_DATE,
      "## What Was Done",
    );

    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const [, content] = mockWriteFile.mock.calls[0] as [string, string, unknown];
    expect(content).toContain("fresh content");
  });

  test("without section param, appends to end (legacy)", async () => {
    const trail = buildSampleTrail();
    mockReadFile.mockImplementation(() => Promise.resolve(trail));

    await appendWorkTrailProgress("ELLIE-630", "\n## Extra\n\nAppended at end\n", FIXED_DATE);

    const [, content] = mockWriteFile.mock.calls[0] as [string, string, unknown];
    // Should be at the very end
    expect(content.trimEnd().endsWith("Appended at end")).toBe(true);
  });
});

// ── End-to-end section flow ──────────────────────────────────────────────────

describe("end-to-end: multiple inserts into different sections", () => {
  test("updates and decisions end up in correct sections", () => {
    let doc = buildSampleTrail();

    // Simulate two updates
    doc = insertIntoSection(doc, "## What Was Done",
      buildWorkTrailUpdateAppend("Built the search endpoint", FIXED_TS))!;
    doc = insertIntoSection(doc, "## What Was Done",
      buildWorkTrailUpdateAppend("Added Cmd+K modal", FIXED_TS))!;

    // Simulate a decision
    doc = insertIntoSection(doc, "## Decisions",
      buildWorkTrailDecisionAppend("Used hybrid search for best results", "dev", FIXED_TS))!;

    // Simulate files changed
    doc = insertIntoSection(doc, "## Files Changed",
      buildFilesChangedTable([
        { file: "src/api/search.ts", change: "Added" },
        { file: "src/http-routes.ts", change: "Modified" },
      ]))!;

    // Verify ordering
    const whatIdx = doc.indexOf("## What Was Done");
    const update1Idx = doc.indexOf("Built the search endpoint");
    const update2Idx = doc.indexOf("Added Cmd+K modal");
    const filesIdx = doc.indexOf("## Files Changed");
    const fileEntryIdx = doc.indexOf("src/api/search.ts");
    const decisionsIdx = doc.indexOf("## Decisions");
    const decisionIdx = doc.indexOf("Used hybrid search");

    // Updates are inside ## What Was Done
    expect(update1Idx).toBeGreaterThan(whatIdx);
    expect(update2Idx).toBeGreaterThan(update1Idx);
    expect(update2Idx).toBeLessThan(filesIdx);

    // Files are inside ## Files Changed
    expect(fileEntryIdx).toBeGreaterThan(filesIdx);
    expect(fileEntryIdx).toBeLessThan(decisionsIdx);

    // Decision is inside ## Decisions
    expect(decisionIdx).toBeGreaterThan(decisionsIdx);

    // Frontmatter is preserved
    expect(doc).toContain("work_item_id: ELLIE-630");
    expect(doc).toContain("status: in-progress");

    // Footer is preserved
    expect(doc).toContain("*Cross-refs: [[ELLIE-630]]");
  });
});
