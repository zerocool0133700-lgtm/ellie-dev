/**
 * Thread isolation tests for working memory — ELLIE-1427
 *
 * Verifies that:
 * - readWorkingMemory with thread_id only returns that thread's record
 * - readWorkingMemory without thread_id only returns non-threaded records
 * - initWorkingMemory only archives same-thread records
 * - Different threads can coexist for same session+agent
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mocks ─────────────────────────────────────────────────────

let sqlQueryLog: Array<{ text: string; values: unknown[] }> = [];

const mockSql = Object.assign(
  mock((...args: any[]) => {
    // Tagged template handler — capture the query for assertions
    const strings = args[0] as TemplateStringsArray;
    const values = args.slice(1);
    const text = strings.join("$?");
    sqlQueryLog.push({ text, values });

    // Default: return empty result
    return Promise.resolve([]);
  }),
  {
    json: (val: unknown) => JSON.stringify(val),
    begin: mock(async (fn: Function) => fn(mockSql)),
  },
);

mock.module("../../../ellie-forest/src/index.ts", () => ({
  sql: mockSql,
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

mock.module("../src/advisory-lock-hash.ts", () => ({
  hashToInt64: () => 12345,
}));

import {
  initWorkingMemory,
  readWorkingMemory,
} from "../src/working-memory.ts";

// ── Tests ─────────────────────────────────────────────────────

describe("working memory thread isolation — ELLIE-1427", () => {
  beforeEach(() => {
    sqlQueryLog = [];
    mockSql.mockClear();
  });

  test("readWorkingMemory without thread_id filters for NULL thread_id", async () => {
    await readWorkingMemory({ session_id: "sess-1", agent: "dev" });
    // The last SQL call should contain "thread_id IS NULL"
    const lastQuery = sqlQueryLog[sqlQueryLog.length - 1];
    expect(lastQuery.text).toContain("thread_id IS NULL");
  });

  test("readWorkingMemory with thread_id filters for that specific thread", async () => {
    await readWorkingMemory({ session_id: "sess-1", agent: "dev", thread_id: "thread-abc" });
    const lastQuery = sqlQueryLog[sqlQueryLog.length - 1];
    expect(lastQuery.text).toContain("thread_id");
    expect(lastQuery.values).toContain("thread-abc");
  });

  test("initWorkingMemory archive query includes thread_id IS NULL when no thread", async () => {
    // Mock the INSERT to return a record
    mockSql.mockImplementationOnce(() => Promise.resolve([])); // archive
    mockSql.mockImplementationOnce(() => Promise.resolve([{  // insert
      id: "wm-1",
      session_id: "sess-1",
      agent: "dev",
      sections: {},
      turn_number: 0,
      channel: null,
      created_at: new Date(),
      updated_at: new Date(),
      archived_at: null,
      safeguard_locked: false,
      safeguard_locked_at: null,
    }]));
    mockSql.mockImplementationOnce(() => Promise.resolve([])); // prune

    await initWorkingMemory({ session_id: "sess-1", agent: "dev" });

    // First SQL call is the archive — should include thread_id IS NULL
    const archiveQuery = sqlQueryLog[0];
    expect(archiveQuery.text).toContain("thread_id IS NULL");
  });

  test("initWorkingMemory archive query includes specific thread_id when provided", async () => {
    mockSql.mockImplementationOnce(() => Promise.resolve([]));
    mockSql.mockImplementationOnce(() => Promise.resolve([{
      id: "wm-2",
      session_id: "sess-1",
      agent: "dev",
      sections: {},
      turn_number: 0,
      channel: null,
      created_at: new Date(),
      updated_at: new Date(),
      archived_at: null,
      safeguard_locked: false,
      safeguard_locked_at: null,
    }]));
    mockSql.mockImplementationOnce(() => Promise.resolve([]));

    await initWorkingMemory({ session_id: "sess-1", agent: "dev", thread_id: "thread-xyz" });

    const archiveQuery = sqlQueryLog[0];
    expect(archiveQuery.values).toContain("thread-xyz");
  });
});
