/**
 * ELLIE-531 — Work Trail Writer tests
 *
 * Covers all functions in src/work-trail-writer.ts:
 *
 * Pure builders (no mocking):
 * - buildWorkTrailStartContent: frontmatter, title, required sections
 * - buildWorkTrailUpdateAppend: structure, message inclusion
 * - buildWorkTrailCompleteAppend: structure, summary inclusion
 *
 * Effectful writers (mocked fs/promises + bridge-river):
 * - writeWorkTrailStart: creates dir + file, skips existing, returns false on error
 * - appendWorkTrailProgress: appends to existing, creates if absent, returns false on error
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
  buildWorkTrailStartContent,
  buildWorkTrailUpdateAppend,
  buildWorkTrailCompleteAppend,
  writeWorkTrailStart,
  appendWorkTrailProgress,
} from "../src/work-trail-writer.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

const FIXED_TS = "2026-03-04T12:00:00.000Z";
const FIXED_DATE = "2026-03-04";

beforeEach(() => {
  // Reset call counts AND implementations to clean defaults every test
  mockWriteFile.mockClear();
  mockWriteFile.mockImplementation(() => Promise.resolve());

  mockMkdir.mockClear();
  mockMkdir.mockImplementation(() => Promise.resolve());

  mockQmdReindex.mockClear();
  mockQmdReindex.mockImplementation(() => Promise.resolve(true));

  // Default: readFile fails (file doesn't exist)
  mockReadFile.mockClear();
  mockReadFile.mockImplementation(() => Promise.reject(new Error("ENOENT")));
});

// ── buildWorkTrailStartContent ────────────────────────────────────────────────

describe("buildWorkTrailStartContent — frontmatter", () => {
  test("contains work_item_id in frontmatter", () => {
    const content = buildWorkTrailStartContent("ELLIE-531", "My Title", undefined, FIXED_TS);
    expect(content).toContain("work_item_id: ELLIE-531");
  });

  test("contains status: in-progress", () => {
    const content = buildWorkTrailStartContent("ELLIE-531", "My Title", undefined, FIXED_TS);
    expect(content).toContain("status: in-progress");
  });

  test("contains started_at from provided timestamp", () => {
    const content = buildWorkTrailStartContent("ELLIE-531", "My Title", undefined, FIXED_TS);
    expect(content).toContain(`started_at: ${FIXED_TS}`);
  });

  test("defaults agent to claude-code when not provided", () => {
    const content = buildWorkTrailStartContent("ELLIE-531", "My Title", undefined, FIXED_TS);
    expect(content).toContain("agent: claude-code");
  });

  test("uses provided agent name", () => {
    const content = buildWorkTrailStartContent("ELLIE-531", "My Title", "dev-ant", FIXED_TS);
    expect(content).toContain("agent: dev-ant");
  });

  test("frontmatter block is properly delimited with ---", () => {
    const content = buildWorkTrailStartContent("ELLIE-531", "My Title", undefined, FIXED_TS);
    expect(content).toMatch(/^---\n/);
    expect(content).toContain("\n---\n");
  });

  test("contains completed_at: null", () => {
    const content = buildWorkTrailStartContent("ELLIE-531", "My Title", undefined, FIXED_TS);
    expect(content).toContain("completed_at: null");
  });

  test("contains scope_path: 2/1", () => {
    const content = buildWorkTrailStartContent("ELLIE-531", "My Title", undefined, FIXED_TS);
    expect(content).toContain("scope_path: 2/1");
  });
});

describe("buildWorkTrailStartContent — body", () => {
  test("H1 title contains work_item_id and title", () => {
    const content = buildWorkTrailStartContent("ELLIE-531", "Wire Sessions", undefined, FIXED_TS);
    expect(content).toContain("# Work Trail: ELLIE-531 — Wire Sessions");
  });

  test("contains ## Context section", () => {
    const content = buildWorkTrailStartContent("ELLIE-531", "Title", undefined, FIXED_TS);
    expect(content).toContain("## Context");
  });

  test("contains ## What Was Done section", () => {
    const content = buildWorkTrailStartContent("ELLIE-531", "Title", undefined, FIXED_TS);
    expect(content).toContain("## What Was Done");
  });

  test("contains ## Files Changed section", () => {
    const content = buildWorkTrailStartContent("ELLIE-531", "Title", undefined, FIXED_TS);
    expect(content).toContain("## Files Changed");
  });

  test("contains ## Decisions section", () => {
    const content = buildWorkTrailStartContent("ELLIE-531", "Title", undefined, FIXED_TS);
    expect(content).toContain("## Decisions");
  });

  test("contains cross-ref footer with ticket ID", () => {
    const content = buildWorkTrailStartContent("ELLIE-531", "Title", undefined, FIXED_TS);
    expect(content).toContain("[[ELLIE-531]]");
  });

  test("includes date from startedAt in body intro", () => {
    const content = buildWorkTrailStartContent("ELLIE-531", "Title", undefined, FIXED_TS);
    expect(content).toContain(FIXED_DATE);
  });
});

// ── buildWorkTrailUpdateAppend ────────────────────────────────────────────────

describe("buildWorkTrailUpdateAppend", () => {
  test("contains the update message", () => {
    const result = buildWorkTrailUpdateAppend("Finished writing tests", FIXED_TS);
    expect(result).toContain("Finished writing tests");
  });

  test("contains 'Update' header", () => {
    const result = buildWorkTrailUpdateAppend("Some progress", FIXED_TS);
    expect(result).toContain("Update");
  });

  test("contains provided timestamp", () => {
    const result = buildWorkTrailUpdateAppend("msg", FIXED_TS);
    expect(result).toContain(FIXED_TS);
  });

  test("starts with newline for clean appending", () => {
    const result = buildWorkTrailUpdateAppend("msg", FIXED_TS);
    expect(result).toMatch(/^\n/);
  });

  test("different messages produce different output", () => {
    const a = buildWorkTrailUpdateAppend("message A", FIXED_TS);
    const b = buildWorkTrailUpdateAppend("message B", FIXED_TS);
    expect(a).not.toBe(b);
  });
});

// ── buildWorkTrailCompleteAppend ──────────────────────────────────────────────

describe("buildWorkTrailCompleteAppend", () => {
  test("contains the summary text", () => {
    const result = buildWorkTrailCompleteAppend("All done. Tests pass.", FIXED_TS);
    expect(result).toContain("All done. Tests pass.");
  });

  test("contains 'Completion Summary' heading", () => {
    const result = buildWorkTrailCompleteAppend("Summary", FIXED_TS);
    expect(result).toContain("## Completion Summary");
  });

  test("contains 'Completed at' label with timestamp", () => {
    const result = buildWorkTrailCompleteAppend("Summary", FIXED_TS);
    expect(result).toContain("**Completed at:**");
    expect(result).toContain(FIXED_TS);
  });

  test("starts with newline for clean appending", () => {
    const result = buildWorkTrailCompleteAppend("Summary", FIXED_TS);
    expect(result).toMatch(/^\n/);
  });
});

// ── writeWorkTrailStart ───────────────────────────────────────────────────────

describe("writeWorkTrailStart — creates new file", () => {
  test("creates parent directory", async () => {
    await writeWorkTrailStart("ELLIE-531", "Test Title", "claude-code", FIXED_DATE);
    expect(mockMkdir).toHaveBeenCalledTimes(1);
    const [dirArg] = mockMkdir.mock.calls[0] as [string, unknown];
    expect(dirArg).toContain("ELLIE-531");
  });

  test("writes file when it doesn't exist", async () => {
    await writeWorkTrailStart("ELLIE-531", "Test Title", "claude-code", FIXED_DATE);
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  });

  test("written file path contains ticket ID and date", async () => {
    await writeWorkTrailStart("ELLIE-531", "Test Title", undefined, FIXED_DATE);
    const [pathArg] = mockWriteFile.mock.calls[0] as [string, unknown, unknown];
    expect(pathArg).toContain("ELLIE-531");
    expect(pathArg).toContain(FIXED_DATE);
    expect(pathArg).toContain(MOCK_RIVER_ROOT);
  });

  test("written content includes title", async () => {
    await writeWorkTrailStart("ELLIE-531", "Wire Sessions", undefined, FIXED_DATE);
    const [, contentArg] = mockWriteFile.mock.calls[0] as [string, string, unknown];
    expect(contentArg).toContain("Wire Sessions");
  });

  test("triggers qmdReindex after write", async () => {
    await writeWorkTrailStart("ELLIE-531", "Title", undefined, FIXED_DATE);
    expect(mockQmdReindex).toHaveBeenCalledTimes(1);
  });

  test("returns true on success", async () => {
    const result = await writeWorkTrailStart("ELLIE-531", "Title", undefined, FIXED_DATE);
    expect(result).toBe(true);
  });
});

describe("writeWorkTrailStart — file already exists", () => {
  test("skips writing when file already exists", async () => {
    mockReadFile.mockImplementation(() => Promise.resolve("existing content"));

    await writeWorkTrailStart("ELLIE-531", "Title", undefined, FIXED_DATE);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  test("returns true even when file already exists", async () => {
    mockReadFile.mockImplementation(() => Promise.resolve("existing content"));

    const result = await writeWorkTrailStart("ELLIE-531", "Title", undefined, FIXED_DATE);
    expect(result).toBe(true);
  });

  test("does not call qmdReindex when skipping", async () => {
    mockReadFile.mockImplementation(() => Promise.resolve("existing content"));

    await writeWorkTrailStart("ELLIE-531", "Title", undefined, FIXED_DATE);
    expect(mockQmdReindex).not.toHaveBeenCalled();
  });
});

describe("writeWorkTrailStart — error handling", () => {
  test("returns false when mkdir throws", async () => {
    mockMkdir.mockImplementation(() => Promise.reject(new Error("EACCES")));

    const result = await writeWorkTrailStart("ELLIE-531", "Title", undefined, FIXED_DATE);
    expect(result).toBe(false);
  });

  test("returns false when writeFile throws", async () => {
    mockWriteFile.mockImplementation(() => Promise.reject(new Error("ENOSPC")));

    const result = await writeWorkTrailStart("ELLIE-531", "Title", undefined, FIXED_DATE);
    expect(result).toBe(false);
  });

  test("does not throw on error — non-fatal", async () => {
    mockWriteFile.mockImplementation(() => Promise.reject(new Error("ENOSPC")));

    await expect(
      writeWorkTrailStart("ELLIE-531", "Title", undefined, FIXED_DATE)
    ).resolves.toBe(false);
  });
});

// ── appendWorkTrailProgress ───────────────────────────────────────────────────

describe("appendWorkTrailProgress — file exists", () => {
  test("reads existing content before appending", async () => {
    mockReadFile.mockImplementation(() => Promise.resolve("# Existing\n\n## Context\n"));

    await appendWorkTrailProgress("ELLIE-531", "\n### Update\n\nDone\n", FIXED_DATE);
    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });

  test("written content includes existing content + appended content", async () => {
    const existing = "# Existing\n\n## Context\n";
    const append = "\n### Update\n\nNew progress\n";
    mockReadFile.mockImplementation(() => Promise.resolve(existing));

    await appendWorkTrailProgress("ELLIE-531", append, FIXED_DATE);
    const [, writtenContent] = mockWriteFile.mock.calls[0] as [string, string, unknown];
    expect(writtenContent).toContain("# Existing");
    expect(writtenContent).toContain("New progress");
  });

  test("appended content comes after existing content", async () => {
    const existing = "# Header\n";
    const append = "\n### New\n";
    mockReadFile.mockImplementation(() => Promise.resolve(existing));

    await appendWorkTrailProgress("ELLIE-531", append, FIXED_DATE);
    const [, writtenContent] = mockWriteFile.mock.calls[0] as [string, string, unknown];
    expect(writtenContent.indexOf("# Header")).toBeLessThan(writtenContent.indexOf("### New"));
  });

  test("trims trailing whitespace from existing before appending", async () => {
    mockReadFile.mockImplementation(() => Promise.resolve("# Header\n\n   \n"));

    await appendWorkTrailProgress("ELLIE-531", "\n### New\n", FIXED_DATE);
    const [, writtenContent] = mockWriteFile.mock.calls[0] as [string, string, unknown];
    // Should not have excessive trailing whitespace before the append
    expect(writtenContent).not.toContain("   \n\n### New");
  });

  test("triggers qmdReindex after write", async () => {
    mockReadFile.mockImplementation(() => Promise.resolve("existing"));

    await appendWorkTrailProgress("ELLIE-531", "\nappend\n", FIXED_DATE);
    expect(mockQmdReindex).toHaveBeenCalledTimes(1);
  });

  test("returns true on success", async () => {
    mockReadFile.mockImplementation(() => Promise.resolve("existing"));

    const result = await appendWorkTrailProgress("ELLIE-531", "\nstuff\n", FIXED_DATE);
    expect(result).toBe(true);
  });
});

describe("appendWorkTrailProgress — file does not exist", () => {
  test("creates directory when file is absent", async () => {
    // readFile already throws ENOENT by default
    await appendWorkTrailProgress("ELLIE-531", "\nContent\n", FIXED_DATE);
    expect(mockMkdir).toHaveBeenCalledTimes(1);
  });

  test("creates new file with appended content", async () => {
    await appendWorkTrailProgress("ELLIE-531", "\nContent\n", FIXED_DATE);
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const [, writtenContent] = mockWriteFile.mock.calls[0] as [string, string, unknown];
    expect(writtenContent).toContain("Content");
  });

  test("returns true when file is absent (creates it)", async () => {
    const result = await appendWorkTrailProgress("ELLIE-531", "\nContent\n", FIXED_DATE);
    expect(result).toBe(true);
  });
});

describe("appendWorkTrailProgress — error handling", () => {
  test("returns false when writeFile throws", async () => {
    mockReadFile.mockImplementation(() => Promise.resolve("existing"));
    mockWriteFile.mockImplementation(() => Promise.reject(new Error("ENOSPC")));

    const result = await appendWorkTrailProgress("ELLIE-531", "\nContent\n", FIXED_DATE);
    expect(result).toBe(false);
  });

  test("does not throw on error — non-fatal", async () => {
    mockWriteFile.mockImplementation(() => Promise.reject(new Error("ENOSPC")));

    await expect(
      appendWorkTrailProgress("ELLIE-531", "\nContent\n", FIXED_DATE)
    ).resolves.toBe(false);
  });
});

// ── Path correctness ──────────────────────────────────────────────────────────

describe("path convention", () => {
  test("writeWorkTrailStart writes to work-trails/{ID}/{ID}-{date}.md", async () => {
    await writeWorkTrailStart("ELLIE-531", "Title", undefined, FIXED_DATE);
    const [pathArg] = mockWriteFile.mock.calls[0] as [string, unknown, unknown];
    expect(pathArg).toBe(`${MOCK_RIVER_ROOT}/work-trails/ELLIE-531/ELLIE-531-${FIXED_DATE}.md`);
  });

  test("appendWorkTrailProgress appends to work-trails/{ID}/{ID}-{date}.md", async () => {
    mockReadFile.mockImplementation(() => Promise.resolve("existing"));
    await appendWorkTrailProgress("ELLIE-531", "\nContent\n", FIXED_DATE);
    const [pathArg] = mockWriteFile.mock.calls[0] as [string, unknown, unknown];
    expect(pathArg).toBe(`${MOCK_RIVER_ROOT}/work-trails/ELLIE-531/ELLIE-531-${FIXED_DATE}.md`);
  });
});
