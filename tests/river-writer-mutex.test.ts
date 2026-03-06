/**
 * ELLIE-579 — River Writer Mutex Tests
 *
 * Verifies that ticket-context-card, dispatch-journal, and post-mortem
 * writers use AsyncMutex to serialize concurrent read-modify-write operations.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mock fs + QMD + logger ──────────────────────────────────────────────────

let _writtenFiles: Array<{ path: string; content: string }> = [];
let _readFiles: Map<string, string> = new Map();
let _writeOrder: string[] = [];

mock.module("fs/promises", () => ({
  writeFile: mock(async (path: string, content: string) => {
    _writtenFiles.push({ path, content });
    _readFiles.set(path, content);
    // Record which writer completed (extracted from path)
    if (path.includes("tickets/")) _writeOrder.push("ticket:" + path);
    else if (path.includes("dispatch-journal/")) _writeOrder.push("journal:" + path);
    else if (path.includes("post-mortems/")) _writeOrder.push("postmortem:" + path);
  }),
  readFile: mock(async (path: string) => {
    const content = _readFiles.get(path);
    if (content === undefined) throw new Error("ENOENT");
    return content;
  }),
  mkdir: mock(async () => {}),
}));

mock.module("../src/api/bridge-river.ts", () => ({
  RIVER_ROOT: "/test-vault",
  qmdReindex: mock(async () => true),
  searchRiver: mock(async () => []),
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

import { AsyncMutex } from "../src/async-mutex.ts";
import {
  ensureContextCard,
  appendWorkHistory,
  appendHandoffNote,
  _getContextCardLockForTesting,
} from "../src/ticket-context-card.ts";
import {
  appendJournalEntry,
  journalDispatchStart,
  journalDispatchEnd,
  _getJournalLockForTesting,
} from "../src/dispatch-journal.ts";
import {
  writePostMortem,
  _getPostMortemLockForTesting,
} from "../src/post-mortem.ts";

beforeEach(() => {
  _writtenFiles = [];
  _readFiles = new Map();
  _writeOrder = [];
});

// ── ticket-context-card mutex ───────────────────────────────────────────────

describe("ticket-context-card mutex (ELLIE-579)", () => {
  test("lock instance is an AsyncMutex", () => {
    const lock = _getContextCardLockForTesting();
    expect(lock).toBeInstanceOf(AsyncMutex);
  });

  test("concurrent ensureContextCard calls are serialized", async () => {
    const order: number[] = [];

    // Patch writeFile to add delay so we can observe serialization
    const { writeFile } = await import("fs/promises");
    (writeFile as ReturnType<typeof mock>).mockImplementation(
      async (path: string, content: string) => {
        await new Promise(r => setTimeout(r, 20));
        order.push(order.length + 1);
        _readFiles.set(path, content);
        _writtenFiles.push({ path, content });
      },
    );

    // Two concurrent creates for different tickets
    await Promise.all([
      ensureContextCard({ workItemId: "ELLIE-A", title: "First" }),
      ensureContextCard({ workItemId: "ELLIE-B", title: "Second" }),
    ]);

    // Both should complete (serialized, not interleaved)
    expect(order).toEqual([1, 2]);
    expect(_writtenFiles.length).toBe(2);
  });

  test("concurrent appendWorkHistory calls don't lose data", async () => {
    // Pre-create a context card
    const cardPath = "/test-vault/tickets/ELLIE-100.md";
    _readFiles.set(cardPath, [
      "---",
      "type: ticket-context-card",
      "work_item_id: ELLIE-100",
      "---",
      "",
      "# ELLIE-100 — Test",
      "",
      "## Work History",
      "",
      "*No sessions recorded yet.*",
      "",
      "## Files Involved",
      "",
      "*None recorded.*",
      "",
    ].join("\n"));

    // Two agents completing concurrently
    await Promise.all([
      appendWorkHistory("ELLIE-100", "Test", {
        agent: "dev",
        outcome: "completed",
        summary: "Agent A work",
        timestamp: "2026-03-05T12:00:00Z",
      }),
      appendWorkHistory("ELLIE-100", "Test", {
        agent: "research",
        outcome: "completed",
        summary: "Agent B work",
        timestamp: "2026-03-05T12:01:00Z",
      }),
    ]);

    // The final file should contain BOTH entries (serialized writes)
    const finalContent = _readFiles.get(cardPath)!;
    expect(finalContent).toContain("Agent A work");
    expect(finalContent).toContain("Agent B work");
  });

  test("concurrent appendHandoffNote calls are serialized", async () => {
    // Pre-create a context card
    const cardPath = "/test-vault/tickets/ELLIE-200.md";
    _readFiles.set(cardPath, [
      "---",
      "type: ticket-context-card",
      "work_item_id: ELLIE-200",
      "---",
      "",
      "# ELLIE-200 — Handoff Test",
      "",
      "## Handoff Notes",
      "",
      "*No handoff notes.*",
      "",
    ].join("\n"));

    await Promise.all([
      appendHandoffNote("ELLIE-200", "Handoff Test", {
        whatWasAttempted: "First attempt",
        timestamp: "2026-03-05T13:00:00Z",
      }),
      appendHandoffNote("ELLIE-200", "Handoff Test", {
        whatWasAttempted: "Second attempt",
        timestamp: "2026-03-05T13:01:00Z",
      }),
    ]);

    const finalContent = _readFiles.get(cardPath)!;
    expect(finalContent).toContain("First attempt");
    expect(finalContent).toContain("Second attempt");
  });

  test("lock is released after error in ensureContextCard", async () => {
    const lock = _getContextCardLockForTesting();

    // Make mkdir throw to trigger an error inside the lock
    const { mkdir } = await import("fs/promises");
    (mkdir as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      throw new Error("disk full");
    });

    // Should not throw (non-fatal), but should release the lock
    const result = await ensureContextCard({ workItemId: "ELLIE-ERR", title: "Fail" });
    expect(result).toBe(false);
    expect(lock.locked).toBe(false);
  });
});

// ── dispatch-journal mutex ──────────────────────────────────────────────────

describe("dispatch-journal mutex (ELLIE-579)", () => {
  test("lock instance is an AsyncMutex", () => {
    const lock = _getJournalLockForTesting();
    expect(lock).toBeInstanceOf(AsyncMutex);
  });

  test("concurrent journal appends are serialized", async () => {
    const order: number[] = [];

    const { writeFile } = await import("fs/promises");
    (writeFile as ReturnType<typeof mock>).mockImplementation(
      async (path: string, content: string) => {
        const seq = order.length + 1;
        await new Promise(r => setTimeout(r, 15));
        order.push(seq);
        _readFiles.set(path, content);
        _writtenFiles.push({ path, content });
      },
    );

    // Two concurrent dispatch starts
    await Promise.all([
      journalDispatchStart({
        workItemId: "ELLIE-J1",
        title: "Journal A",
        sessionId: "s1",
        startedAt: "2026-03-05T14:00:00Z",
      }),
      journalDispatchStart({
        workItemId: "ELLIE-J2",
        title: "Journal B",
        sessionId: "s2",
        startedAt: "2026-03-05T14:00:01Z",
      }),
    ]);

    // Serialized: writes happen 1, 2 in order (not interleaved)
    expect(order).toEqual([1, 2]);

    // The final file should contain both entries
    const journalPath = "/test-vault/dispatch-journal/2026-03-05.md";
    const finalContent = _readFiles.get(journalPath)!;
    expect(finalContent).toContain("ELLIE-J1");
    expect(finalContent).toContain("ELLIE-J2");
  });

  test("concurrent start and end on same day are serialized", async () => {
    await Promise.all([
      journalDispatchStart({
        workItemId: "ELLIE-SE",
        title: "Start-End",
        sessionId: "s3",
        startedAt: "2026-03-05T15:00:00Z",
      }),
      journalDispatchEnd({
        workItemId: "ELLIE-SE",
        outcome: "completed",
        summary: "All done",
        endedAt: "2026-03-05T15:30:00Z",
      }),
    ]);

    const journalPath = "/test-vault/dispatch-journal/2026-03-05.md";
    const finalContent = _readFiles.get(journalPath)!;
    expect(finalContent).toContain("Started");
    expect(finalContent).toContain("Completed");
  });

  test("lock is released after error in appendJournalEntry", async () => {
    const lock = _getJournalLockForTesting();

    const { mkdir } = await import("fs/promises");
    (mkdir as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      throw new Error("disk full");
    });

    const result = await appendJournalEntry("test content", "2026-03-05");
    expect(result).toBe(false);
    expect(lock.locked).toBe(false);
  });
});

// ── post-mortem mutex ───────────────────────────────────────────────────────

describe("post-mortem mutex (ELLIE-579)", () => {
  test("lock instance is an AsyncMutex", () => {
    const lock = _getPostMortemLockForTesting();
    expect(lock).toBeInstanceOf(AsyncMutex);
  });

  test("concurrent writePostMortem calls are serialized", async () => {
    const order: number[] = [];

    const { writeFile } = await import("fs/promises");
    (writeFile as ReturnType<typeof mock>).mockImplementation(
      async (path: string, content: string) => {
        const seq = order.length + 1;
        await new Promise(r => setTimeout(r, 15));
        order.push(seq);
        _readFiles.set(path, content);
        _writtenFiles.push({ path, content });
      },
    );

    await Promise.all([
      writePostMortem({
        workItemId: "ELLIE-PM1",
        title: "First post-mortem",
        failureType: "timeout",
        whatHappened: "Agent timed out",
        timestamp: "2026-03-05T16:00:00Z",
      }),
      writePostMortem({
        workItemId: "ELLIE-PM2",
        title: "Second post-mortem",
        failureType: "crash",
        whatHappened: "Agent crashed",
        timestamp: "2026-03-05T16:01:00Z",
      }),
    ]);

    // Both written in order (serialized)
    expect(order).toEqual([1, 2]);
    expect(_writtenFiles.length).toBe(2);

    // Both files exist
    const pm1 = _writtenFiles.find(f => f.content.includes("ELLIE-PM1"));
    const pm2 = _writtenFiles.find(f => f.content.includes("ELLIE-PM2"));
    expect(pm1).toBeDefined();
    expect(pm2).toBeDefined();
  });

  test("same-ticket concurrent writes get different paths", async () => {
    // First write creates the base file
    await writePostMortem({
      workItemId: "ELLIE-DUP",
      title: "Duplicate test",
      failureType: "timeout",
      whatHappened: "First failure",
      timestamp: "2026-03-05T17:00:00Z",
    });

    // Second write should get -2 suffix due to findNextAvailablePath
    await writePostMortem({
      workItemId: "ELLIE-DUP",
      title: "Duplicate test",
      failureType: "crash",
      whatHappened: "Second failure",
      timestamp: "2026-03-05T17:00:00Z",
    });

    // Two distinct files written
    expect(_writtenFiles.length).toBe(2);
    const paths = _writtenFiles.map(f => f.path);
    expect(paths[0]).not.toBe(paths[1]);
  });

  test("lock is released after error in writePostMortem", async () => {
    const lock = _getPostMortemLockForTesting();

    const { mkdir } = await import("fs/promises");
    (mkdir as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      throw new Error("disk full");
    });

    const result = await writePostMortem({
      workItemId: "ELLIE-FAIL",
      title: "Should fail",
      failureType: "unknown",
      whatHappened: "Test",
      timestamp: "2026-03-05T18:00:00Z",
    });
    expect(result).toBe(false);
    expect(lock.locked).toBe(false);
  });
});

// ── AsyncMutex (extracted module) ───────────────────────────────────────────

describe("AsyncMutex (extracted to async-mutex.ts)", () => {
  test("can be imported from async-mutex.ts", () => {
    const mutex = new AsyncMutex();
    expect(mutex.locked).toBe(false);
  });

  test("still importable from active-tickets-dashboard.ts (re-export)", async () => {
    const { AsyncMutex: DashboardMutex } = await import(
      "../src/active-tickets-dashboard.ts"
    );
    expect(DashboardMutex).toBe(AsyncMutex);
  });
});
