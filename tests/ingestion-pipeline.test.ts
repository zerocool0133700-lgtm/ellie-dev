import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { computeSourceHash, checkDedup, recordHash } from "../src/ingestion-pipeline";

describe("computeSourceHash", () => {
  test("produces stable SHA-256 hex", () => {
    const buf = Buffer.from("hello world");
    const h1 = computeSourceHash(buf);
    const h2 = computeSourceHash(buf);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });

  test("different content yields different hash", () => {
    const a = computeSourceHash(Buffer.from("hello"));
    const b = computeSourceHash(Buffer.from("world"));
    expect(a).not.toBe(b);
  });
});

describe("checkDedup + recordHash", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ingest-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("checkDedup returns null when no .hashes.jsonl exists", async () => {
    const result = await checkDedup(tmpDir, "abc123");
    expect(result).toBeNull();
  });

  test("recordHash creates .hashes.jsonl and checkDedup finds it", async () => {
    await recordHash(tmpDir, {
      sha256: "abc123",
      filename: "paper.pdf",
      md_path: "research/paper.md",
      ingested_at: "2026-04-06T15:30:00Z",
    });

    const result = await checkDedup(tmpDir, "abc123");
    expect(result).not.toBeNull();
    expect(result?.filename).toBe("paper.pdf");
    expect(result?.md_path).toBe("research/paper.md");
  });

  test("checkDedup with wrong hash returns null", async () => {
    await recordHash(tmpDir, {
      sha256: "abc123",
      filename: "paper.pdf",
      md_path: "research/paper.md",
      ingested_at: "2026-04-06T15:30:00Z",
    });

    const result = await checkDedup(tmpDir, "different-hash");
    expect(result).toBeNull();
  });

  test("multiple records appended without overwriting", async () => {
    await recordHash(tmpDir, { sha256: "h1", filename: "a.pdf", md_path: "a.md", ingested_at: "t1" });
    await recordHash(tmpDir, { sha256: "h2", filename: "b.pdf", md_path: "b.md", ingested_at: "t2" });

    const a = await checkDedup(tmpDir, "h1");
    const b = await checkDedup(tmpDir, "h2");
    expect(a?.filename).toBe("a.pdf");
    expect(b?.filename).toBe("b.pdf");
  });
});
