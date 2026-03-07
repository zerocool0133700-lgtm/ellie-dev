/**
 * ELLIE-559 — config-cache.ts tests
 *
 * Tests disk cache read/write roundtrip and missing key handling.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { writeToDisk, readFromDisk } from "../src/config-cache.ts";
import { rm } from "fs/promises";
import { join } from "path";

const TEST_KEY = "__test_config_cache_559";
const CACHE_DIR = join(process.cwd(), ".cache");

afterAll(async () => {
  // Clean up test file
  try {
    await rm(join(CACHE_DIR, `${TEST_KEY}.json`));
  } catch {}
});

// ── readFromDisk ─────────────────────────────────────────────

describe("readFromDisk", () => {
  test("returns null for missing key", async () => {
    const result = await readFromDisk("nonexistent_key_xyz_559");
    expect(result).toBeNull();
  });
});

// ── writeToDisk + readFromDisk roundtrip ─────────────────────

describe("writeToDisk / readFromDisk", () => {
  test("write and read back object", async () => {
    const data = { agents: ["dev", "research"], version: 3 };
    writeToDisk(TEST_KEY, data);
    // writeToDisk is fire-and-forget, give it time to flush
    await new Promise(r => setTimeout(r, 200));
    const result = await readFromDisk<typeof data>(TEST_KEY);
    expect(result).toEqual(data);
  });

  test("write and read back array", async () => {
    writeToDisk(TEST_KEY, [1, 2, 3]);
    await new Promise(r => setTimeout(r, 200));
    const result = await readFromDisk<number[]>(TEST_KEY);
    expect(result).toEqual([1, 2, 3]);
  });

  test("write and read back string", async () => {
    writeToDisk(TEST_KEY, "hello");
    await new Promise(r => setTimeout(r, 200));
    const result = await readFromDisk<string>(TEST_KEY);
    expect(result).toBe("hello");
  });
});
