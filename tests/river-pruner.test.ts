/**
 * ELLIE-581 — River Document Pruner Tests
 *
 * Covers pure functions (extractDateFromPath, isExpired, buildArchivePath, getDocType)
 * and effectful pruneRiver() with mocked fs + QMD.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mock fs + QMD + logger ──────────────────────────────────────────────────

let _renamedFiles: Array<{ src: string; dest: string }> = [];
let _mkdirPaths: string[] = [];

// Simulated directory tree: dirPath → array of { name, isDirectory, children? }
interface FsEntry {
  name: string;
  isDirectory: boolean;
  children?: FsEntry[];
}
let _fsTree: Map<string, FsEntry[]> = new Map();

mock.module("fs/promises", () => ({
  readdir: mock(async (dirPath: string, _opts?: any) => {
    const entries = _fsTree.get(dirPath);
    if (!entries) throw new Error("ENOENT");
    return entries.map((e) => ({
      name: e.name,
      isDirectory: () => e.isDirectory,
    }));
  }),
  rename: mock(async (src: string, dest: string) => {
    _renamedFiles.push({ src, dest });
  }),
  mkdir: mock(async (path: string) => {
    _mkdirPaths.push(path);
  }),
  stat: mock(async () => ({ isFile: () => true })),
}));

let _qmdReindexCalled = false;
mock.module("../src/api/bridge-river.ts", () => ({
  RIVER_ROOT: "/test-vault",
  qmdReindex: mock(async () => {
    _qmdReindexCalled = true;
    return true;
  }),
}));

mock.module("../src/logger.ts", () => ({
  log: {
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  },
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import {
  extractDateFromPath,
  isExpired,
  buildArchivePath,
  getDocType,
  pruneRiver,
  DEFAULT_TTL_POLICY,
  ARCHIVE_DIR,
} from "../src/river-pruner.ts";

// ── Reset ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  _renamedFiles = [];
  _mkdirPaths = [];
  _fsTree = new Map();
  _qmdReindexCalled = false;
});

// ── Helper ──────────────────────────────────────────────────────────────────

function seedDir(path: string, entries: FsEntry[]): void {
  _fsTree.set(path, entries);
}

// ── Pure function tests ─────────────────────────────────────────────────────

describe("extractDateFromPath", () => {
  test("extracts date from journal filename", () => {
    expect(extractDateFromPath("2026-03-05.md")).toBe("2026-03-05");
  });

  test("extracts date from post-mortem filename", () => {
    expect(extractDateFromPath("ELLIE-567-2026-03-05.md")).toBe("2026-03-05");
  });

  test("extracts date from work-trail filename", () => {
    expect(extractDateFromPath("ELLIE-530/ELLIE-530-2026-03-05.md")).toBe(
      "2026-03-05",
    );
  });

  test("returns null when no date present", () => {
    expect(extractDateFromPath("active-tickets.md")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(extractDateFromPath("")).toBeNull();
  });
});

describe("isExpired", () => {
  test("returns true when document is older than TTL", () => {
    expect(isExpired("2025-01-01", 90, "2025-06-01")).toBe(true);
  });

  test("returns false when document is within TTL", () => {
    expect(isExpired("2025-05-01", 90, "2025-06-01")).toBe(false);
  });

  test("returns false when document is exactly at TTL boundary", () => {
    // 90 days from 2025-01-01 = 2025-04-01 — at exactly 90 days, not expired
    expect(isExpired("2025-01-01", 90, "2025-04-01")).toBe(false);
  });

  test("returns true when document is one day past TTL", () => {
    expect(isExpired("2025-01-01", 90, "2025-04-02")).toBe(true);
  });

  test("uses current date when no reference date provided", () => {
    // A date from 2020 with 90-day TTL should definitely be expired
    expect(isExpired("2020-01-01", 90)).toBe(true);
  });
});

describe("buildArchivePath", () => {
  test("prepends .archive to relative path", () => {
    expect(buildArchivePath("dispatch-journal/2025-06-01.md")).toBe(
      ".archive/dispatch-journal/2025-06-01.md",
    );
  });

  test("works with nested paths", () => {
    expect(
      buildArchivePath("work-trails/ELLIE-530/ELLIE-530-2025-06-01.md"),
    ).toBe(".archive/work-trails/ELLIE-530/ELLIE-530-2025-06-01.md");
  });
});

describe("getDocType", () => {
  test("returns first path segment for nested path", () => {
    expect(getDocType("dispatch-journal/2025-06-01.md")).toBe(
      "dispatch-journal",
    );
  });

  test("returns first segment for deeply nested path", () => {
    expect(getDocType("work-trails/ELLIE-530/ELLIE-530-2025-06-01.md")).toBe(
      "work-trails",
    );
  });

  test("returns the whole string when no slash present", () => {
    expect(getDocType("README.md")).toBe("README.md");
  });
});

describe("DEFAULT_TTL_POLICY", () => {
  test("has expected doc types", () => {
    expect(DEFAULT_TTL_POLICY["dispatch-journal"]).toBe(90);
    expect(DEFAULT_TTL_POLICY["post-mortems"]).toBe(365);
    expect(DEFAULT_TTL_POLICY["work-trails"]).toBe(180);
    expect(DEFAULT_TTL_POLICY["dashboards"]).toBeNull();
    expect(DEFAULT_TTL_POLICY["tickets"]).toBeNull();
  });
});

describe("ARCHIVE_DIR", () => {
  test("is .archive", () => {
    expect(ARCHIVE_DIR).toBe(".archive");
  });
});

// ── Effectful pruneRiver tests ──────────────────────────────────────────────

describe("pruneRiver", () => {
  test("returns zero counts when directories don't exist", async () => {
    // No directories seeded — all readdir calls will throw ENOENT
    const result = await pruneRiver({
      riverRoot: "/test-vault",
      referenceDate: "2026-03-05",
    });

    expect(result.scanned).toBe(0);
    expect(result.archived).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.archivedFiles).toEqual([]);
  });

  test("archives expired journal files", async () => {
    seedDir("/test-vault/dispatch-journal", [
      { name: "2025-11-01.md", isDirectory: false }, // ~124 days old → expired (90d TTL)
      { name: "2026-02-15.md", isDirectory: false }, // ~18 days old → not expired
    ]);

    const result = await pruneRiver({
      riverRoot: "/test-vault",
      referenceDate: "2026-03-05",
      policy: { "dispatch-journal": 90 },
    });

    expect(result.scanned).toBe(2);
    expect(result.archived).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.archivedFiles).toEqual(["dispatch-journal/2025-11-01.md"]);

    // Verify rename was called with correct paths
    expect(_renamedFiles).toHaveLength(1);
    expect(_renamedFiles[0].src).toBe(
      "/test-vault/dispatch-journal/2025-11-01.md",
    );
    expect(_renamedFiles[0].dest).toBe(
      "/test-vault/.archive/dispatch-journal/2025-11-01.md",
    );
  });

  test("skips files without a date in the filename", async () => {
    seedDir("/test-vault/dispatch-journal", [
      { name: "README.md", isDirectory: false },
    ]);

    const result = await pruneRiver({
      riverRoot: "/test-vault",
      referenceDate: "2026-03-05",
      policy: { "dispatch-journal": 90 },
    });

    expect(result.scanned).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.archived).toBe(0);
  });

  test("skips doc types with null TTL", async () => {
    // Dashboards have null TTL — should never be scanned
    seedDir("/test-vault/dashboards", [
      { name: "active-tickets.md", isDirectory: false },
    ]);

    const result = await pruneRiver({
      riverRoot: "/test-vault",
      referenceDate: "2026-03-05",
      policy: { dashboards: null },
    });

    expect(result.scanned).toBe(0);
    expect(result.archived).toBe(0);
  });

  test("handles subdirectories (work-trails pattern)", async () => {
    seedDir("/test-vault/work-trails", [
      {
        name: "ELLIE-530",
        isDirectory: true,
      },
    ]);
    seedDir("/test-vault/work-trails/ELLIE-530", [
      { name: "ELLIE-530-2025-06-01.md", isDirectory: false }, // ~277 days old → expired (180d TTL)
      { name: "ELLIE-530-2026-02-01.md", isDirectory: false }, // ~32 days old → not expired
    ]);

    const result = await pruneRiver({
      riverRoot: "/test-vault",
      referenceDate: "2026-03-05",
      policy: { "work-trails": 180 },
    });

    expect(result.scanned).toBe(2);
    expect(result.archived).toBe(1);
    expect(result.archivedFiles).toEqual([
      "work-trails/ELLIE-530/ELLIE-530-2025-06-01.md",
    ]);
    expect(_renamedFiles[0].dest).toBe(
      "/test-vault/.archive/work-trails/ELLIE-530/ELLIE-530-2025-06-01.md",
    );
  });

  test("skips .archive directories during scan", async () => {
    seedDir("/test-vault/dispatch-journal", [
      { name: ".archive", isDirectory: true },
      { name: "2025-11-01.md", isDirectory: false },
    ]);

    const result = await pruneRiver({
      riverRoot: "/test-vault",
      referenceDate: "2026-03-05",
      policy: { "dispatch-journal": 90 },
    });

    // Only 1 file scanned — .archive dir skipped entirely
    expect(result.scanned).toBe(1);
    expect(result.archived).toBe(1);
  });

  test("dry run does not rename or reindex", async () => {
    seedDir("/test-vault/dispatch-journal", [
      { name: "2025-01-01.md", isDirectory: false },
    ]);

    const result = await pruneRiver({
      riverRoot: "/test-vault",
      referenceDate: "2026-03-05",
      policy: { "dispatch-journal": 90 },
      dryRun: true,
    });

    expect(result.archived).toBe(1);
    expect(result.archivedFiles).toEqual(["dispatch-journal/2025-01-01.md"]);
    // No actual file operations
    expect(_renamedFiles).toHaveLength(0);
    expect(_mkdirPaths).toHaveLength(0);
    expect(_qmdReindexCalled).toBe(false);
  });

  test("triggers QMD reindex after archiving files", async () => {
    seedDir("/test-vault/dispatch-journal", [
      { name: "2025-01-01.md", isDirectory: false },
    ]);

    await pruneRiver({
      riverRoot: "/test-vault",
      referenceDate: "2026-03-05",
      policy: { "dispatch-journal": 90 },
    });

    expect(_qmdReindexCalled).toBe(true);
  });

  test("does not reindex when nothing was archived", async () => {
    seedDir("/test-vault/dispatch-journal", [
      { name: "2026-03-01.md", isDirectory: false }, // 4 days old → not expired
    ]);

    await pruneRiver({
      riverRoot: "/test-vault",
      referenceDate: "2026-03-05",
      policy: { "dispatch-journal": 90 },
    });

    expect(_qmdReindexCalled).toBe(false);
  });

  test("continues on per-file error and increments error count", async () => {
    seedDir("/test-vault/dispatch-journal", [
      { name: "2025-01-01.md", isDirectory: false },
      { name: "2025-01-02.md", isDirectory: false },
    ]);

    // Make rename fail for the first file
    const { rename } = await import("fs/promises");
    let callCount = 0;
    (rename as ReturnType<typeof mock>).mockImplementation(
      async (src: string, dest: string) => {
        callCount++;
        if (callCount === 1) throw new Error("permission denied");
        _renamedFiles.push({ src, dest });
      },
    );

    const result = await pruneRiver({
      riverRoot: "/test-vault",
      referenceDate: "2026-03-05",
      policy: { "dispatch-journal": 90 },
    });

    expect(result.scanned).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.archived).toBe(1); // Second file still archived
  });

  test("handles multiple doc types in a single run", async () => {
    seedDir("/test-vault/dispatch-journal", [
      { name: "2025-01-01.md", isDirectory: false }, // expired
    ]);
    seedDir("/test-vault/post-mortems", [
      { name: "ELLIE-100-2024-01-01.md", isDirectory: false }, // expired (365d)
      { name: "ELLIE-101-2026-01-01.md", isDirectory: false }, // not expired
    ]);

    const result = await pruneRiver({
      riverRoot: "/test-vault",
      referenceDate: "2026-03-05",
      policy: { "dispatch-journal": 90, "post-mortems": 365 },
    });

    expect(result.scanned).toBe(3);
    expect(result.archived).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.archivedFiles).toContain("dispatch-journal/2025-01-01.md");
    expect(result.archivedFiles).toContain(
      "post-mortems/ELLIE-100-2024-01-01.md",
    );
  });
});
