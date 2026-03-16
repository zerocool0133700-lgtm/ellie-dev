import { describe, it, expect } from "bun:test";
import {
  findSectionInsertPoint,
  mergeIntoSection,
  stripFrontmatter,
  writeToRiver,
  type FileSystem,
  type WriterDeps,
} from "../src/capture/river-writer.ts";

// Mock helpers

function mockFs(files: Record<string, string> = {}): FileSystem & { written: Record<string, string>; dirs: string[] } {
  const written: Record<string, string> = {};
  const dirs: string[] = [];
  return {
    written,
    dirs,
    exists: async (path: string) => path in files,
    readFile: async (path: string) => {
      if (!(path in files)) throw new Error("ENOENT");
      return files[path];
    },
    writeFile: async (path: string, content: string) => { written[path] = content; },
    mkdir: async (path: string) => { dirs.push(path); },
  };
}

function mockSql(): any {
  const calls: any[] = [];
  const fn: any = function (...args: any[]) {
    calls.push(args);
    return Promise.resolve([]);
  };
  fn.calls = calls;
  return fn;
}

function mockQmd(): { reindex: (p: string) => Promise<void>; reindexed: string[] } {
  const reindexed: string[] = [];
  return { reindex: async (p) => { reindexed.push(p); }, reindexed };
}

function mockBridge(): { write: (...args: any[]) => Promise<void>; writes: any[] } {
  const writes: any[] = [];
  return { write: async (...args) => { writes.push(args); }, writes };
}

function createDeps(files: Record<string, string> = {}): WriterDeps & {
  _fs: ReturnType<typeof mockFs>;
  _sql: ReturnType<typeof mockSql>;
  _qmd: ReturnType<typeof mockQmd>;
  _bridge: ReturnType<typeof mockBridge>;
} {
  const fs = mockFs(files);
  const sql = mockSql();
  const qmd = mockQmd();
  const bridge = mockBridge();
  return { fs, sql, qmd, bridge, vaultPath: "/vault", _fs: fs, _sql: sql, _qmd: qmd, _bridge: bridge };
}

const SAMPLE_MD = `---
title: Test Doc
type: workflow
---

# Test Doc

## Overview

Existing content here.

## Steps

1. First step
`;

describe("ELLIE-771: River write pipeline", () => {
  describe("findSectionInsertPoint", () => {
    it("finds existing section and returns position after it", () => {
      const result = findSectionInsertPoint(SAMPLE_MD, "Overview");
      expect(result.found).toBe(true);
      expect(result.position).toBeGreaterThan(0);
    });

    it("finds section before next heading", () => {
      const result = findSectionInsertPoint(SAMPLE_MD, "Overview");
      expect(result.found).toBe(true);
      // Position should be before "## Steps"
      const before = SAMPLE_MD.slice(0, result.position);
      expect(before).toContain("Existing content here.");
      expect(before).not.toContain("## Steps");
    });

    it("returns not found for missing section", () => {
      const result = findSectionInsertPoint(SAMPLE_MD, "Nonexistent");
      expect(result.found).toBe(false);
      expect(result.position).toBe(SAMPLE_MD.length);
    });

    it("is case-insensitive", () => {
      const result = findSectionInsertPoint(SAMPLE_MD, "overview");
      expect(result.found).toBe(true);
    });

    it("handles section at end of file", () => {
      const result = findSectionInsertPoint(SAMPLE_MD, "Steps");
      expect(result.found).toBe(true);
    });
  });

  describe("mergeIntoSection", () => {
    it("appends to end when no section specified", () => {
      const result = mergeIntoSection("# Existing\n\nContent", "New stuff", null);
      expect(result).toContain("# Existing");
      expect(result).toContain("Content");
      expect(result).toContain("New stuff");
      expect(result.indexOf("Content")).toBeLessThan(result.indexOf("New stuff"));
    });

    it("inserts into existing section", () => {
      const result = mergeIntoSection(SAMPLE_MD, "Additional overview content", "Overview");
      expect(result).toContain("Existing content here.");
      expect(result).toContain("Additional overview content");
      expect(result).toContain("## Steps");
    });

    it("creates new section if not found", () => {
      const result = mergeIntoSection(SAMPLE_MD, "Trigger info", "Triggers");
      expect(result).toContain("## Triggers");
      expect(result).toContain("Trigger info");
    });

    it("preserves existing content structure", () => {
      const result = mergeIntoSection(SAMPLE_MD, "Extra", "Overview");
      expect(result).toContain("# Test Doc");
      expect(result).toContain("## Steps");
      expect(result).toContain("1. First step");
    });
  });

  describe("stripFrontmatter", () => {
    it("strips YAML frontmatter", () => {
      const result = stripFrontmatter("---\ntitle: Test\n---\n\n# Content");
      expect(result).toBe("# Content");
    });

    it("returns content as-is if no frontmatter", () => {
      expect(stripFrontmatter("# Just content")).toBe("# Just content");
    });

    it("handles missing closing delimiter", () => {
      expect(stripFrontmatter("---\ntitle: Test\nNo close")).toBe("---\ntitle: Test\nNo close");
    });
  });

  describe("writeToRiver", () => {
    it("creates new file when target doesn't exist", async () => {
      const deps = createDeps();
      const result = await writeToRiver({
        capture_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        target_path: "workflows/deploy.md",
        target_section: null,
        markdown: "---\ntitle: Deploy\n---\n\n# Deploy\n\nContent",
      }, deps);

      expect(result.success).toBe(true);
      expect(result.action).toBe("created");
      expect(result.file_path).toBe("/vault/workflows/deploy.md");
      expect(result.bytes_written).toBeGreaterThan(0);
      expect(deps._fs.written["/vault/workflows/deploy.md"]).toContain("# Deploy");
      expect(deps._fs.dirs).toContain("/vault/workflows");
    });

    it("merges into existing file", async () => {
      const deps = createDeps({ "/vault/workflows/deploy.md": SAMPLE_MD });
      const result = await writeToRiver({
        capture_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        target_path: "workflows/deploy.md",
        target_section: "Overview",
        markdown: "---\ntitle: Extra\n---\n\nNew overview detail",
      }, deps);

      expect(result.success).toBe(true);
      expect(result.action).toBe("merged");
      const written = deps._fs.written["/vault/workflows/deploy.md"];
      expect(written).toContain("Existing content here.");
      expect(written).toContain("New overview detail");
    });

    it("strips frontmatter when merging", async () => {
      const deps = createDeps({ "/vault/ref.md": "# Ref\n\nExisting" });
      await writeToRiver({
        capture_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        target_path: "ref.md",
        target_section: null,
        markdown: "---\ntitle: Dup\n---\n\nNew content",
      }, deps);

      const written = deps._fs.written["/vault/ref.md"];
      // Should not have duplicate frontmatter
      const fmCount = (written.match(/^---$/gm) || []).length;
      expect(fmCount).toBe(0); // Original had no frontmatter, merged stripped it
    });

    it("updates capture queue status to written", async () => {
      const deps = createDeps();
      await writeToRiver({
        capture_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        target_path: "test.md",
        target_section: null,
        markdown: "# Test",
      }, deps);

      expect(deps._sql.calls.length).toBe(1);
    });

    it("triggers QMD reindex", async () => {
      const deps = createDeps();
      await writeToRiver({
        capture_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        target_path: "workflows/new.md",
        target_section: null,
        markdown: "# New",
      }, deps);

      expect(deps._qmd.reindexed).toContain("workflows/new.md");
    });

    it("logs to Forest bridge", async () => {
      const deps = createDeps();
      await writeToRiver({
        capture_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        target_path: "decisions/pick-db.md",
        target_section: null,
        markdown: "# Pick DB",
      }, deps);

      expect(deps._bridge.writes.length).toBe(1);
      expect(deps._bridge.writes[0][0]).toContain("created");
      expect(deps._bridge.writes[0][0]).toContain("decisions/pick-db.md");
    });

    it("returns dry_run result without writing", async () => {
      const deps = createDeps();
      const result = await writeToRiver({
        capture_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        target_path: "test.md",
        target_section: null,
        markdown: "# Test content",
        dry_run: true,
      }, deps);

      expect(result.success).toBe(true);
      expect(result.action).toBe("dry_run");
      expect(result.bytes_written).toBeGreaterThan(0);
      expect(Object.keys(deps._fs.written)).toHaveLength(0);
      expect(deps._sql.calls).toHaveLength(0);
      expect(deps._qmd.reindexed).toHaveLength(0);
    });

    it("handles write errors gracefully", async () => {
      const deps = createDeps();
      deps.fs.writeFile = async () => { throw new Error("Disk full"); };

      const result = await writeToRiver({
        capture_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        target_path: "test.md",
        target_section: null,
        markdown: "# Test",
      }, deps);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Disk full");
    });

    it("survives QMD reindex failure", async () => {
      const deps = createDeps();
      deps.qmd.reindex = async () => { throw new Error("QMD down"); };

      const result = await writeToRiver({
        capture_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        target_path: "test.md",
        target_section: null,
        markdown: "# Test",
      }, deps);

      expect(result.success).toBe(true);
    });

    it("survives Forest bridge failure", async () => {
      const deps = createDeps();
      deps.bridge.write = async () => { throw new Error("Bridge down"); };

      const result = await writeToRiver({
        capture_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        target_path: "test.md",
        target_section: null,
        markdown: "# Test",
      }, deps);

      expect(result.success).toBe(true);
    });
  });
});
