/**
 * ELLIE-580 — Dashboard Startup Reconciliation Tests
 *
 * Verifies that reconcileDashboard() correctly cleans up stale "in progress"
 * entries on relay startup by cross-referencing Plane state and Forest sessions.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mock fs + QMD + logger ──────────────────────────────────────────────────

let _writtenFiles: Array<{ path: string; content: string }> = [];
let _readFiles: Map<string, string> = new Map();

mock.module("fs/promises", () => ({
  writeFile: mock(async (path: string, content: string) => {
    _writtenFiles.push({ path, content });
    _readFiles.set(path, content);
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
  reconcileDashboard,
  buildDashboardContent,
  readDashboardState,
  dashboardOnStart,
  type DashboardState,
  type ReconciliationDeps,
} from "../src/active-tickets-dashboard.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

const DASHBOARD_FULL_PATH = "/test-vault/dashboards/active-tickets.md";

function seedDashboard(state: DashboardState): void {
  const content = buildDashboardContent(state);
  _readFiles.set(DASHBOARD_FULL_PATH, content);
}

function makeDeps(overrides: Partial<ReconciliationDeps> = {}): ReconciliationDeps {
  return {
    isWorkItemDone: overrides.isWorkItemDone ?? (async () => false),
    hasActiveSession: overrides.hasActiveSession ?? (async () => true),
  };
}

beforeEach(() => {
  _writtenFiles = [];
  _readFiles = new Map();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("reconcileDashboard (ELLIE-580)", () => {
  test("returns zero counts when dashboard is empty", async () => {
    const result = await reconcileDashboard(makeDeps());
    expect(result.checked).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.stale).toBe(0);
    expect(result.errors).toBe(0);
  });

  test("returns zero counts when no in-progress entries", async () => {
    seedDashboard({
      inProgress: [],
      blocked: [],
      completedToday: [
        {
          workItemId: "ELLIE-100",
          title: "Done one",
          completedAt: "2026-03-05T12:00:00Z",
          summary: "All done",
        },
      ],
      lastUpdated: "2026-03-05T12:00:00Z",
    });

    const result = await reconcileDashboard(makeDeps());
    expect(result.checked).toBe(0);
    expect(result.removed).toBe(0);
  });

  test("removes entries that are Done in Plane", async () => {
    seedDashboard({
      inProgress: [
        {
          workItemId: "ELLIE-200",
          title: "Completed ticket",
          startedAt: "2026-03-05T10:00:00Z",
        },
        {
          workItemId: "ELLIE-201",
          title: "Still active",
          startedAt: "2026-03-05T10:00:00Z",
        },
      ],
      blocked: [],
      completedToday: [],
      lastUpdated: "2026-03-05T10:00:00Z",
    });

    const result = await reconcileDashboard(
      makeDeps({
        isWorkItemDone: async (id) => id === "ELLIE-200",
        hasActiveSession: async () => true,
      }),
    );

    expect(result.checked).toBe(2);
    expect(result.removed).toBe(1);
    expect(result.stale).toBe(0);

    // Dashboard should have been rewritten without ELLIE-200
    const state = await readDashboardState();
    expect(state.inProgress).toHaveLength(1);
    expect(state.inProgress[0].workItemId).toBe("ELLIE-201");
  });

  test("marks entries as stale when no active Forest session", async () => {
    seedDashboard({
      inProgress: [
        {
          workItemId: "ELLIE-300",
          title: "Orphaned ticket",
          startedAt: "2026-03-05T08:00:00Z",
        },
      ],
      blocked: [],
      completedToday: [],
      lastUpdated: "2026-03-05T08:00:00Z",
    });

    const result = await reconcileDashboard(
      makeDeps({
        isWorkItemDone: async () => false,
        hasActiveSession: async () => false,
      }),
    );

    expect(result.checked).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.stale).toBe(1);

    // Dashboard should mark entry with (stale)
    const state = await readDashboardState();
    expect(state.inProgress).toHaveLength(1);
    expect(state.inProgress[0].lastUpdate).toContain("STALE");
  });

  test("handles mixed: some done, some stale, some active", async () => {
    seedDashboard({
      inProgress: [
        {
          workItemId: "ELLIE-400",
          title: "Done in Plane",
          startedAt: "2026-03-05T09:00:00Z",
        },
        {
          workItemId: "ELLIE-401",
          title: "No session (stale)",
          startedAt: "2026-03-05T09:00:00Z",
        },
        {
          workItemId: "ELLIE-402",
          title: "Active and healthy",
          startedAt: "2026-03-05T09:00:00Z",
        },
      ],
      blocked: [],
      completedToday: [],
      lastUpdated: "2026-03-05T09:00:00Z",
    });

    const result = await reconcileDashboard(
      makeDeps({
        isWorkItemDone: async (id) => id === "ELLIE-400",
        hasActiveSession: async (id) => id === "ELLIE-402",
      }),
    );

    expect(result.checked).toBe(3);
    expect(result.removed).toBe(1);
    expect(result.stale).toBe(1);
    expect(result.errors).toBe(0);

    const state = await readDashboardState();
    expect(state.inProgress).toHaveLength(2);

    const staleEntry = state.inProgress.find(
      (t) => t.workItemId === "ELLIE-401",
    );
    expect(staleEntry!.lastUpdate).toContain("STALE");

    const activeEntry = state.inProgress.find(
      (t) => t.workItemId === "ELLIE-402",
    );
    expect(activeEntry!.lastUpdate).not.toContain("STALE");
  });

  test("does not rewrite dashboard when nothing changed", async () => {
    seedDashboard({
      inProgress: [
        {
          workItemId: "ELLIE-500",
          title: "All good",
          startedAt: "2026-03-05T10:00:00Z",
        },
      ],
      blocked: [],
      completedToday: [],
      lastUpdated: "2026-03-05T10:00:00Z",
    });

    _writtenFiles = []; // Clear any writes from seed

    const result = await reconcileDashboard(
      makeDeps({
        isWorkItemDone: async () => false,
        hasActiveSession: async () => true,
      }),
    );

    expect(result.checked).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.stale).toBe(0);

    // No rewrite should have happened
    expect(_writtenFiles).toHaveLength(0);
  });

  test("counts errors when a Plane check fails", async () => {
    seedDashboard({
      inProgress: [
        {
          workItemId: "ELLIE-600",
          title: "Bad ticket",
          startedAt: "2026-03-05T10:00:00Z",
        },
        {
          workItemId: "ELLIE-601",
          title: "Good ticket",
          startedAt: "2026-03-05T10:00:00Z",
        },
      ],
      blocked: [],
      completedToday: [],
      lastUpdated: "2026-03-05T10:00:00Z",
    });

    const result = await reconcileDashboard(
      makeDeps({
        isWorkItemDone: async (id) => {
          if (id === "ELLIE-600") throw new Error("Plane API timeout");
          return false;
        },
        hasActiveSession: async () => true,
      }),
    );

    expect(result.checked).toBe(2);
    expect(result.errors).toBe(1);
    // The good ticket should still be checked
    expect(result.removed).toBe(0);
  });

  test("preserves blocked and completedToday entries", async () => {
    seedDashboard({
      inProgress: [
        {
          workItemId: "ELLIE-700",
          title: "Done ticket",
          startedAt: "2026-03-05T10:00:00Z",
        },
      ],
      blocked: [
        {
          workItemId: "ELLIE-701",
          title: "Blocked one",
          blocker: "Missing API key",
          since: "2026-03-05T10:00:00Z",
        },
      ],
      completedToday: [
        {
          workItemId: "ELLIE-702",
          title: "Finished",
          completedAt: "2026-03-05T11:00:00Z",
          summary: "All done",
        },
      ],
      lastUpdated: "2026-03-05T10:00:00Z",
    });

    await reconcileDashboard(
      makeDeps({
        isWorkItemDone: async () => true,
      }),
    );

    const state = await readDashboardState();
    expect(state.inProgress).toHaveLength(0);
    expect(state.blocked).toHaveLength(1);
    expect(state.completedToday).toHaveLength(1);
  });

  test("is serialized with other dashboard operations via mutex", async () => {
    seedDashboard({
      inProgress: [
        {
          workItemId: "ELLIE-800",
          title: "Will be stale",
          startedAt: "2026-03-05T10:00:00Z",
        },
      ],
      blocked: [],
      completedToday: [],
      lastUpdated: "2026-03-05T10:00:00Z",
    });

    // Run reconcile and a dashboardOnStart concurrently
    await Promise.all([
      reconcileDashboard(
        makeDeps({
          isWorkItemDone: async () => false,
          hasActiveSession: async (id) => {
            // Simulate slow Plane check
            await new Promise((r) => setTimeout(r, 30));
            return false;
          },
        }),
      ),
      dashboardOnStart({
        workItemId: "ELLIE-NEW",
        title: "New ticket",
        startedAt: "2026-03-05T12:00:00Z",
      }),
    ]);

    // Both operations should have completed without data loss
    const state = await readDashboardState();
    const ids = state.inProgress.map((t) => t.workItemId);
    // ELLIE-800 should be there (stale), ELLIE-NEW should also be there
    expect(ids).toContain("ELLIE-NEW");
  });
});
