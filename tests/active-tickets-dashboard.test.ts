/**
 * ELLIE-566 — Active Tickets Dashboard Tests
 *
 * Tests the pure state operations, content builder, markdown parser,
 * and effectful lifecycle hooks with mocked fs/QMD.
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
    // Also store for subsequent reads
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
  emptyState,
  addInProgress,
  markCompleted,
  markBlocked,
  removeInProgress,
  pruneOldCompleted,
  buildDashboardContent,
  parseDashboardContent,
  dashboardOnStart,
  dashboardOnComplete,
  dashboardOnPause,
  dashboardOnBlocked,
  AsyncMutex,
  _getDashboardLockForTesting,
  type DashboardState,
  type TicketEntry,
  type CompletedEntry,
  type BlockedEntry,
} from "../src/active-tickets-dashboard";

// ── Reset ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  _writtenFiles = [];
  _readFiles = new Map();
  _mkdirCalls = [];
  _reindexCalls = 0;
});

// ── emptyState ──────────────────────────────────────────────────────────────

describe("emptyState", () => {
  test("creates state with empty arrays", () => {
    const state = emptyState();
    expect(state.inProgress).toHaveLength(0);
    expect(state.blocked).toHaveLength(0);
    expect(state.completedToday).toHaveLength(0);
    expect(state.lastUpdated).toBeTruthy();
  });
});

// ── addInProgress ───────────────────────────────────────────────────────────

describe("addInProgress", () => {
  test("adds ticket to in-progress", () => {
    const state = emptyState();
    const entry: TicketEntry = {
      workItemId: "ELLIE-566",
      title: "Add dashboard",
      agent: "dev",
      startedAt: "2026-03-05T12:00:00Z",
    };

    const updated = addInProgress(state, entry);

    expect(updated.inProgress).toHaveLength(1);
    expect(updated.inProgress[0].workItemId).toBe("ELLIE-566");
  });

  test("replaces existing ticket with same ID", () => {
    let state = emptyState();
    state = addInProgress(state, {
      workItemId: "ELLIE-566",
      title: "Old title",
      startedAt: "2026-03-05T12:00:00Z",
    });
    state = addInProgress(state, {
      workItemId: "ELLIE-566",
      title: "New title",
      startedAt: "2026-03-05T13:00:00Z",
    });

    expect(state.inProgress).toHaveLength(1);
    expect(state.inProgress[0].title).toBe("New title");
  });

  test("preserves other tickets", () => {
    let state = emptyState();
    state = addInProgress(state, {
      workItemId: "ELLIE-100",
      title: "First",
      startedAt: "2026-03-05T12:00:00Z",
    });
    state = addInProgress(state, {
      workItemId: "ELLIE-200",
      title: "Second",
      startedAt: "2026-03-05T12:05:00Z",
    });

    expect(state.inProgress).toHaveLength(2);
  });
});

// ── markCompleted ───────────────────────────────────────────────────────────

describe("markCompleted", () => {
  test("moves ticket from in-progress to completed", () => {
    let state = emptyState();
    state = addInProgress(state, {
      workItemId: "ELLIE-566",
      title: "Dashboard",
      startedAt: "2026-03-05T12:00:00Z",
    });

    const completed: CompletedEntry = {
      workItemId: "ELLIE-566",
      title: "Dashboard",
      completedAt: "2026-03-05T13:00:00Z",
      summary: "Done",
      durationMinutes: 60,
    };

    const updated = markCompleted(state, completed);

    expect(updated.inProgress).toHaveLength(0);
    expect(updated.completedToday).toHaveLength(1);
    expect(updated.completedToday[0].summary).toBe("Done");
  });

  test("also removes from blocked", () => {
    let state = emptyState();
    state = markBlocked(state, {
      workItemId: "ELLIE-500",
      title: "Blocked",
      blocker: "Missing API",
      since: "2026-03-05T12:00:00Z",
    });

    state = markCompleted(state, {
      workItemId: "ELLIE-500",
      title: "Blocked",
      completedAt: "2026-03-05T14:00:00Z",
      summary: "Unblocked and done",
    });

    expect(state.blocked).toHaveLength(0);
    expect(state.completedToday).toHaveLength(1);
  });
});

// ── markBlocked ─────────────────────────────────────────────────────────────

describe("markBlocked", () => {
  test("moves ticket from in-progress to blocked", () => {
    let state = emptyState();
    state = addInProgress(state, {
      workItemId: "ELLIE-500",
      title: "Something",
      startedAt: "2026-03-05T12:00:00Z",
    });

    const blocked: BlockedEntry = {
      workItemId: "ELLIE-500",
      title: "Something",
      blocker: "Waiting on API key",
      since: "2026-03-05T12:30:00Z",
    };

    state = markBlocked(state, blocked);

    expect(state.inProgress).toHaveLength(0);
    expect(state.blocked).toHaveLength(1);
    expect(state.blocked[0].blocker).toBe("Waiting on API key");
  });

  test("replaces existing blocked entry for same ticket", () => {
    let state = emptyState();
    state = markBlocked(state, {
      workItemId: "ELLIE-500",
      title: "X",
      blocker: "Old blocker",
      since: "2026-03-05T12:00:00Z",
    });
    state = markBlocked(state, {
      workItemId: "ELLIE-500",
      title: "X",
      blocker: "New blocker",
      since: "2026-03-05T13:00:00Z",
    });

    expect(state.blocked).toHaveLength(1);
    expect(state.blocked[0].blocker).toBe("New blocker");
  });
});

// ── removeInProgress ────────────────────────────────────────────────────────

describe("removeInProgress", () => {
  test("removes ticket by ID", () => {
    let state = emptyState();
    state = addInProgress(state, {
      workItemId: "ELLIE-100",
      title: "To remove",
      startedAt: "2026-03-05T12:00:00Z",
    });
    state = addInProgress(state, {
      workItemId: "ELLIE-200",
      title: "Keep",
      startedAt: "2026-03-05T12:00:00Z",
    });

    state = removeInProgress(state, "ELLIE-100");

    expect(state.inProgress).toHaveLength(1);
    expect(state.inProgress[0].workItemId).toBe("ELLIE-200");
  });

  test("no-op if ticket not in progress", () => {
    const state = emptyState();
    const updated = removeInProgress(state, "ELLIE-999");
    expect(updated.inProgress).toHaveLength(0);
  });
});

// ── pruneOldCompleted ───────────────────────────────────────────────────────

describe("pruneOldCompleted", () => {
  test("keeps entries from today", () => {
    let state = emptyState();
    state = markCompleted(state, {
      workItemId: "ELLIE-100",
      title: "Today",
      completedAt: "2026-03-05T12:00:00Z",
      summary: "Done",
    });

    const pruned = pruneOldCompleted(state, "2026-03-05");

    expect(pruned.completedToday).toHaveLength(1);
  });

  test("removes entries from yesterday", () => {
    let state = emptyState();
    state = markCompleted(state, {
      workItemId: "ELLIE-100",
      title: "Yesterday",
      completedAt: "2026-03-04T23:00:00Z",
      summary: "Old",
    });

    const pruned = pruneOldCompleted(state, "2026-03-05");

    expect(pruned.completedToday).toHaveLength(0);
  });
});

// ── buildDashboardContent ───────────────────────────────────────────────────

describe("buildDashboardContent", () => {
  test("builds empty dashboard", () => {
    const content = buildDashboardContent(emptyState());

    expect(content).toContain("# Active Tickets Dashboard");
    expect(content).toContain("## In Progress");
    expect(content).toContain("*No tickets in progress.*");
    expect(content).toContain("## Blocked");
    expect(content).toContain("*No blocked tickets.*");
    expect(content).toContain("## Completed Today");
    expect(content).toContain("*No tickets completed today.*");
  });

  test("builds dashboard with in-progress tickets", () => {
    let state = emptyState();
    state = addInProgress(state, {
      workItemId: "ELLIE-566",
      title: "Dashboard",
      agent: "dev",
      startedAt: "2026-03-05T12:00:00Z",
    });

    const content = buildDashboardContent(state);

    expect(content).toContain("| ELLIE-566 | Dashboard | dev |");
    expect(content).not.toContain("*No tickets in progress.*");
  });

  test("builds dashboard with blocked tickets", () => {
    let state = emptyState();
    state = markBlocked(state, {
      workItemId: "ELLIE-500",
      title: "Stuck",
      blocker: "Missing key",
      since: "2026-03-05T12:00:00Z",
    });

    const content = buildDashboardContent(state);

    expect(content).toContain("| ELLIE-500 | Stuck | Missing key |");
  });

  test("builds dashboard with completed tickets", () => {
    let state = emptyState();
    state = markCompleted(state, {
      workItemId: "ELLIE-564",
      title: "Verifier",
      agent: "dev",
      completedAt: "2026-03-05T13:00:00Z",
      summary: "Added verifier",
      durationMinutes: 10,
    });

    const content = buildDashboardContent(state);

    expect(content).toContain("| ELLIE-564 | Verifier | dev |");
    expect(content).toContain("| 10m |");
    expect(content).toContain("| Added verifier |");
  });

  test("includes frontmatter", () => {
    const content = buildDashboardContent(emptyState());

    expect(content).toContain("---");
    expect(content).toContain("type: active-tickets-dashboard");
    expect(content).toContain("last_updated:");
  });
});

// ── parseDashboardContent ───────────────────────────────────────────────────

describe("parseDashboardContent", () => {
  test("roundtrips through build and parse", () => {
    let state = emptyState();
    state.lastUpdated = "2026-03-05T12:00:00Z";
    state = addInProgress(state, {
      workItemId: "ELLIE-566",
      title: "Dashboard",
      agent: "dev",
      startedAt: "2026-03-05T12:00:00Z",
    });
    state = markCompleted(state, {
      workItemId: "ELLIE-564",
      title: "Verifier",
      completedAt: "2026-03-05T11:00:00Z",
      summary: "Done",
      durationMinutes: 8,
    });

    const content = buildDashboardContent(state);
    const parsed = parseDashboardContent(content);

    expect(parsed.inProgress).toHaveLength(1);
    expect(parsed.inProgress[0].workItemId).toBe("ELLIE-566");
    expect(parsed.completedToday).toHaveLength(1);
    expect(parsed.completedToday[0].workItemId).toBe("ELLIE-564");
  });

  test("returns empty state for empty content", () => {
    const parsed = parseDashboardContent("");

    expect(parsed.inProgress).toHaveLength(0);
    expect(parsed.blocked).toHaveLength(0);
    expect(parsed.completedToday).toHaveLength(0);
  });

  test("parses blocked section", () => {
    let state = emptyState();
    state = markBlocked(state, {
      workItemId: "ELLIE-500",
      title: "Stuck",
      blocker: "Need API key",
      since: "2026-03-05T12:00:00Z",
    });

    const content = buildDashboardContent(state);
    const parsed = parseDashboardContent(content);

    expect(parsed.blocked).toHaveLength(1);
    expect(parsed.blocked[0].blocker).toBe("Need API key");
  });
});

// ── Effectful lifecycle hooks ───────────────────────────────────────────────

describe("dashboardOnStart", () => {
  test("creates dashboard and adds ticket", async () => {
    await dashboardOnStart({
      workItemId: "ELLIE-566",
      title: "Dashboard",
      agent: "dev",
      startedAt: "2026-03-05T12:00:00Z",
    });

    expect(_writtenFiles).toHaveLength(1);
    expect(_writtenFiles[0].content).toContain("ELLIE-566");
    expect(_writtenFiles[0].content).toContain("## In Progress");
    expect(_reindexCalls).toBe(1);
  });
});

describe("dashboardOnComplete", () => {
  test("moves ticket to completed", async () => {
    // Start a ticket first
    await dashboardOnStart({
      workItemId: "ELLIE-566",
      title: "Dashboard",
      startedAt: "2026-03-05T12:00:00Z",
    });

    // Complete it
    await dashboardOnComplete({
      workItemId: "ELLIE-566",
      title: "Dashboard",
      completedAt: "2026-03-05T13:00:00Z",
      summary: "Done",
      durationMinutes: 60,
    });

    // Last write should have ELLIE-566 in completed, not in-progress
    const lastWrite = _writtenFiles[_writtenFiles.length - 1];
    expect(lastWrite.content).toContain("## Completed Today");
    expect(lastWrite.content).toContain("ELLIE-566");
    expect(lastWrite.content).toContain("Done");
  });
});

describe("dashboardOnPause", () => {
  test("removes ticket from in-progress", async () => {
    await dashboardOnStart({
      workItemId: "ELLIE-100",
      title: "Test",
      startedAt: "2026-03-05T12:00:00Z",
    });

    await dashboardOnPause("ELLIE-100");

    const lastWrite = _writtenFiles[_writtenFiles.length - 1];
    expect(lastWrite.content).toContain("*No tickets in progress.*");
  });
});

describe("dashboardOnBlocked", () => {
  test("moves ticket to blocked section", async () => {
    await dashboardOnStart({
      workItemId: "ELLIE-100",
      title: "Test",
      startedAt: "2026-03-05T12:00:00Z",
    });

    await dashboardOnBlocked({
      workItemId: "ELLIE-100",
      title: "Test",
      blocker: "Missing credentials",
      since: "2026-03-05T12:30:00Z",
    });

    const lastWrite = _writtenFiles[_writtenFiles.length - 1];
    expect(lastWrite.content).toContain("## Blocked");
    expect(lastWrite.content).toContain("Missing credentials");
    expect(lastWrite.content).toContain("*No tickets in progress.*");
  });
});

// ── AsyncMutex (ELLIE-574) ──────────────────────────────────────────────────

describe("AsyncMutex", () => {
  test("executes fn and returns result", async () => {
    const mutex = new AsyncMutex();
    const result = await mutex.withLock(async () => 42);
    expect(result).toBe(42);
  });

  test("starts unlocked", () => {
    const mutex = new AsyncMutex();
    expect(mutex.locked).toBe(false);
    expect(mutex.queueLength).toBe(0);
  });

  test("is locked during execution", async () => {
    const mutex = new AsyncMutex();
    let wasLocked = false;

    await mutex.withLock(async () => {
      wasLocked = mutex.locked;
    });

    expect(wasLocked).toBe(true);
    expect(mutex.locked).toBe(false);
  });

  test("serializes concurrent operations", async () => {
    const mutex = new AsyncMutex();
    const order: number[] = [];

    const p1 = mutex.withLock(async () => {
      await new Promise(r => setTimeout(r, 30));
      order.push(1);
    });
    const p2 = mutex.withLock(async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);

    expect(order).toEqual([1, 2]);
  });

  test("releases lock even if fn throws", async () => {
    const mutex = new AsyncMutex();

    await mutex.withLock(async () => {
      throw new Error("boom");
    }).catch(() => {});

    expect(mutex.locked).toBe(false);

    // Should be able to acquire again
    const result = await mutex.withLock(async () => "ok");
    expect(result).toBe("ok");
  });

  test("times out when lock held too long", async () => {
    const mutex = new AsyncMutex();

    // Hold the lock for 200ms
    const holder = mutex.withLock(async () => {
      await new Promise(r => setTimeout(r, 200));
    });

    // Try to acquire with 50ms timeout
    let timedOut = false;
    try {
      await mutex.withLock(async () => {}, 50);
    } catch (err: any) {
      timedOut = true;
      expect(err.message).toContain("timed out");
    }

    expect(timedOut).toBe(true);
    await holder; // Clean up
  });

  test("queued operations execute in order", async () => {
    const mutex = new AsyncMutex();
    const order: string[] = [];

    const p1 = mutex.withLock(async () => {
      await new Promise(r => setTimeout(r, 20));
      order.push("A");
    });
    const p2 = mutex.withLock(async () => {
      order.push("B");
    });
    const p3 = mutex.withLock(async () => {
      order.push("C");
    });

    await Promise.all([p1, p2, p3]);

    expect(order).toEqual(["A", "B", "C"]);
  });

  test("reports queue length", async () => {
    const mutex = new AsyncMutex();
    let queueLen = 0;

    const p1 = mutex.withLock(async () => {
      await new Promise(r => setTimeout(r, 50));
      queueLen = mutex.queueLength;
    });
    // Queue two more
    const p2 = mutex.withLock(async () => {});
    const p3 = mutex.withLock(async () => {});

    await Promise.all([p1, p2, p3]);

    expect(queueLen).toBe(2);
  });
});

// ── Concurrent dashboard operations (ELLIE-574) ────────────────────────────

describe("concurrent dashboard operations (ELLIE-574)", () => {
  test("concurrent starts produce correct merged output", async () => {
    // Launch two starts concurrently — both should appear
    await Promise.all([
      dashboardOnStart({
        workItemId: "ELLIE-A",
        title: "First",
        agent: "dev",
        startedAt: "2026-03-05T12:00:00Z",
      }),
      dashboardOnStart({
        workItemId: "ELLIE-B",
        title: "Second",
        agent: "research",
        startedAt: "2026-03-05T12:00:01Z",
      }),
    ]);

    const lastWrite = _writtenFiles[_writtenFiles.length - 1];
    expect(lastWrite.content).toContain("ELLIE-A");
    expect(lastWrite.content).toContain("ELLIE-B");
  });

  test("concurrent start and complete don't lose data", async () => {
    // Pre-populate with a ticket
    await dashboardOnStart({
      workItemId: "ELLIE-X",
      title: "Existing",
      startedAt: "2026-03-05T12:00:00Z",
    });

    // Concurrent: start a new one + complete the existing one
    await Promise.all([
      dashboardOnStart({
        workItemId: "ELLIE-Y",
        title: "New",
        startedAt: "2026-03-05T12:01:00Z",
      }),
      dashboardOnComplete({
        workItemId: "ELLIE-X",
        title: "Existing",
        completedAt: "2026-03-05T12:02:00Z",
        summary: "Done",
      }),
    ]);

    const lastWrite = _writtenFiles[_writtenFiles.length - 1];
    // Both operations should have been serialized
    expect(lastWrite.content).toContain("ELLIE-Y");
    // ELLIE-X should be in completed or removed from in-progress
    expect(lastWrite.content).toContain("## Completed Today");
  });

  test("dashboard lock is shared across lifecycle hooks", () => {
    const lock = _getDashboardLockForTesting();
    expect(lock).toBeInstanceOf(AsyncMutex);
  });
});
