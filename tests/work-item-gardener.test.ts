/**
 * ELLIE-407 — Work Item Gardener tests
 *
 * Tests for the pure detector functions:
 *  - detectOrphanedSessions
 *  - detectStaleSessions
 *  - detectMismatches
 *  - detectDeadAgents
 *  - runAllDetectors
 *  - formatFindings
 *
 * All detectors are pure — they take snapshot data and return findings.
 * No Supabase, Plane API, or Forest DB mocking needed.
 */

import { describe, test, expect } from "bun:test";
import {
  detectOrphanedSessions,
  detectStaleSessions,
  detectMismatches,
  detectDeadAgents,
  runAllDetectors,
  formatFindings,
  type WorkItemSnapshot,
  type AgentSnapshot,
  type GardenerFinding,
} from "../src/api/work-item-gardener.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

const NOW = new Date("2026-03-07T12:00:00.000Z");

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
}

function makeSnapshot(overrides: Partial<WorkItemSnapshot>): WorkItemSnapshot {
  return {
    workItemId: "ELLIE-100",
    planeName: "Test ticket",
    planeState: "started",
    ...overrides,
  };
}

function makeAgent(overrides: Partial<AgentSnapshot>): AgentSnapshot {
  return {
    agentName: "dev",
    status: "idle",
    lastActiveAt: NOW.toISOString(),
    ...overrides,
  };
}

// ── detectOrphanedSessions ────────────────────────────────────────────────────

describe("detectOrphanedSessions", () => {
  test("detects In Progress ticket with no Forest tree", () => {
    const findings = detectOrphanedSessions([
      makeSnapshot({ planeState: "started" }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("orphaned_session");
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].description).toContain("no Forest tree exists");
  });

  test("detects In Progress ticket with dormant Forest tree", () => {
    const findings = detectOrphanedSessions([
      makeSnapshot({
        planeState: "started",
        forestTreeId: "tree-1",
        forestTreeState: "dormant",
      }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("orphaned_session");
    expect(findings[0].description).toContain("dormant");
  });

  test("detects In Progress ticket with archived Forest tree", () => {
    const findings = detectOrphanedSessions([
      makeSnapshot({
        planeState: "started",
        forestTreeId: "tree-2",
        forestTreeState: "archived",
      }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("orphaned_session");
  });

  test("ignores In Progress ticket with growing Forest tree", () => {
    const findings = detectOrphanedSessions([
      makeSnapshot({
        planeState: "started",
        forestTreeId: "tree-3",
        forestTreeState: "growing",
      }),
    ]);
    expect(findings).toHaveLength(0);
  });

  test("ignores completed tickets", () => {
    const findings = detectOrphanedSessions([
      makeSnapshot({ planeState: "completed" }),
    ]);
    expect(findings).toHaveLength(0);
  });

  test("ignores unstarted tickets", () => {
    const findings = detectOrphanedSessions([
      makeSnapshot({ planeState: "unstarted" }),
    ]);
    expect(findings).toHaveLength(0);
  });

  test("includes workItemId in findings", () => {
    const findings = detectOrphanedSessions([
      makeSnapshot({ workItemId: "ELLIE-42", planeState: "started" }),
    ]);
    expect(findings[0].workItemId).toBe("ELLIE-42");
  });

  test("handles multiple orphaned items", () => {
    const findings = detectOrphanedSessions([
      makeSnapshot({ workItemId: "ELLIE-1", planeState: "started" }),
      makeSnapshot({ workItemId: "ELLIE-2", planeState: "started", forestTreeId: "t2", forestTreeState: "composted" }),
      makeSnapshot({ workItemId: "ELLIE-3", planeState: "started", forestTreeId: "t3", forestTreeState: "growing" }),
    ]);
    expect(findings).toHaveLength(2);
  });
});

// ── detectStaleSessions ───────────────────────────────────────────────────────

describe("detectStaleSessions", () => {
  test("detects growing tree with 24h+ no activity", () => {
    const findings = detectStaleSessions([
      makeSnapshot({
        forestTreeId: "tree-1",
        forestTreeState: "growing",
        forestLastActivity: hoursAgo(30),
      }),
    ], NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("stale_session");
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].evidence.ageHours).toBe(30);
  });

  test("detects seedling tree with 24h+ no activity", () => {
    const findings = detectStaleSessions([
      makeSnapshot({
        forestTreeId: "tree-1",
        forestTreeState: "seedling",
        forestLastActivity: hoursAgo(48),
      }),
    ], NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("stale_session");
  });

  test("escalates to critical after 72h", () => {
    const findings = detectStaleSessions([
      makeSnapshot({
        forestTreeId: "tree-1",
        forestTreeState: "growing",
        forestLastActivity: hoursAgo(80),
      }),
    ], NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("critical");
  });

  test("ignores growing tree with recent activity", () => {
    const findings = detectStaleSessions([
      makeSnapshot({
        forestTreeId: "tree-1",
        forestTreeState: "growing",
        forestLastActivity: hoursAgo(2),
      }),
    ], NOW);
    expect(findings).toHaveLength(0);
  });

  test("ignores dormant trees", () => {
    const findings = detectStaleSessions([
      makeSnapshot({
        forestTreeId: "tree-1",
        forestTreeState: "dormant",
        forestLastActivity: hoursAgo(100),
      }),
    ], NOW);
    expect(findings).toHaveLength(0);
  });

  test("ignores mature trees", () => {
    const findings = detectStaleSessions([
      makeSnapshot({
        forestTreeId: "tree-1",
        forestTreeState: "mature",
        forestLastActivity: hoursAgo(100),
      }),
    ], NOW);
    expect(findings).toHaveLength(0);
  });

  test("uses forestCreatedAt when no lastActivity", () => {
    const findings = detectStaleSessions([
      makeSnapshot({
        forestTreeId: "tree-1",
        forestTreeState: "growing",
        forestCreatedAt: hoursAgo(30),
      }),
    ], NOW);
    expect(findings).toHaveLength(1);
  });

  test("ignores snapshots without a Forest tree", () => {
    const findings = detectStaleSessions([
      makeSnapshot({ planeState: "started" }),
    ], NOW);
    expect(findings).toHaveLength(0);
  });
});

// ── detectMismatches ──────────────────────────────────────────────────────────

describe("detectMismatches", () => {
  test("detects Plane=completed but Forest=growing", () => {
    const findings = detectMismatches([
      makeSnapshot({
        planeState: "completed",
        forestTreeId: "tree-1",
        forestTreeState: "growing",
      }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("state_mismatch");
    expect(findings[0].title).toContain("Plane=done");
    expect(findings[0].title).toContain("Forest=growing");
  });

  test("detects Plane=completed but Forest=seedling", () => {
    const findings = detectMismatches([
      makeSnapshot({
        planeState: "completed",
        forestTreeId: "tree-1",
        forestTreeState: "seedling",
      }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("state_mismatch");
  });

  test("detects Plane=completed but Forest=nursery", () => {
    const findings = detectMismatches([
      makeSnapshot({
        planeState: "completed",
        forestTreeId: "tree-1",
        forestTreeState: "nursery",
      }),
    ]);
    expect(findings).toHaveLength(1);
  });

  test("detects Plane=started but Forest=mature", () => {
    const findings = detectMismatches([
      makeSnapshot({
        planeState: "started",
        forestTreeId: "tree-1",
        forestTreeState: "mature",
      }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("state_mismatch");
    expect(findings[0].title).toContain("Plane=in-progress");
    expect(findings[0].title).toContain("Forest=mature");
  });

  test("no mismatch when Plane=completed and Forest=dormant", () => {
    const findings = detectMismatches([
      makeSnapshot({
        planeState: "completed",
        forestTreeId: "tree-1",
        forestTreeState: "dormant",
      }),
    ]);
    expect(findings).toHaveLength(0);
  });

  test("no mismatch when Plane=started and Forest=growing", () => {
    const findings = detectMismatches([
      makeSnapshot({
        planeState: "started",
        forestTreeId: "tree-1",
        forestTreeState: "growing",
      }),
    ]);
    expect(findings).toHaveLength(0);
  });

  test("ignores snapshots without Forest tree", () => {
    const findings = detectMismatches([
      makeSnapshot({ planeState: "completed" }),
    ]);
    expect(findings).toHaveLength(0);
  });
});

// ── detectDeadAgents ──────────────────────────────────────────────────────────

describe("detectDeadAgents", () => {
  test("detects busy agent inactive for 2+ hours", () => {
    const findings = detectDeadAgents([
      makeAgent({
        status: "busy",
        sessionId: "session-1",
        lastActiveAt: hoursAgo(3),
      }),
    ], NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("dead_agent");
    expect(findings[0].agentName).toBe("dev");
    expect(findings[0].severity).toBe("warning");
  });

  test("escalates to critical after 12h", () => {
    const findings = detectDeadAgents([
      makeAgent({
        status: "busy",
        sessionId: "session-1",
        lastActiveAt: hoursAgo(15),
      }),
    ], NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("critical");
  });

  test("ignores busy agent active recently", () => {
    const findings = detectDeadAgents([
      makeAgent({
        status: "busy",
        sessionId: "session-1",
        lastActiveAt: hoursAgo(1),
      }),
    ], NOW);
    expect(findings).toHaveLength(0);
  });

  test("ignores idle agents", () => {
    const findings = detectDeadAgents([
      makeAgent({ status: "idle", lastActiveAt: hoursAgo(100) }),
    ], NOW);
    expect(findings).toHaveLength(0);
  });

  test("ignores offline agents", () => {
    const findings = detectDeadAgents([
      makeAgent({ status: "offline", lastActiveAt: hoursAgo(100) }),
    ], NOW);
    expect(findings).toHaveLength(0);
  });

  test("ignores busy agent without session", () => {
    const findings = detectDeadAgents([
      makeAgent({ status: "busy", lastActiveAt: hoursAgo(5) }),
    ], NOW);
    expect(findings).toHaveLength(0);
  });

  test("includes workItemId when available", () => {
    const findings = detectDeadAgents([
      makeAgent({
        status: "busy",
        sessionId: "s-1",
        lastActiveAt: hoursAgo(4),
        workItemId: "ELLIE-99",
      }),
    ], NOW);
    expect(findings[0].workItemId).toBe("ELLIE-99");
    expect(findings[0].description).toContain("ELLIE-99");
  });

  test("handles multiple dead agents", () => {
    const findings = detectDeadAgents([
      makeAgent({ agentName: "dev", status: "busy", sessionId: "s-1", lastActiveAt: hoursAgo(5) }),
      makeAgent({ agentName: "research", status: "busy", sessionId: "s-2", lastActiveAt: hoursAgo(3) }),
      makeAgent({ agentName: "content", status: "idle", lastActiveAt: hoursAgo(100) }),
    ], NOW);
    expect(findings).toHaveLength(2);
  });
});

// ── runAllDetectors ───────────────────────────────────────────────────────────

describe("runAllDetectors", () => {
  test("combines findings from all detectors", () => {
    const snapshots: WorkItemSnapshot[] = [
      // Orphaned: In Progress, no Forest tree
      makeSnapshot({ workItemId: "ELLIE-1", planeState: "started" }),
      // Stale: growing but 30h no activity
      makeSnapshot({
        workItemId: "ELLIE-2",
        planeState: "started",
        forestTreeId: "t2",
        forestTreeState: "growing",
        forestLastActivity: hoursAgo(30),
      }),
      // Mismatch: completed but growing
      makeSnapshot({
        workItemId: "ELLIE-3",
        planeState: "completed",
        forestTreeId: "t3",
        forestTreeState: "growing",
        forestLastActivity: hoursAgo(1),
      }),
    ];
    const agents: AgentSnapshot[] = [
      makeAgent({ agentName: "critic", status: "busy", sessionId: "s-1", lastActiveAt: hoursAgo(5) }),
    ];

    const findings = runAllDetectors(snapshots, agents, NOW);

    const types = findings.map(f => f.type);
    expect(types).toContain("orphaned_session");
    expect(types).toContain("stale_session");
    expect(types).toContain("state_mismatch");
    expect(types).toContain("dead_agent");
    expect(findings.length).toBeGreaterThanOrEqual(4);
  });

  test("returns empty array when everything is healthy", () => {
    const snapshots: WorkItemSnapshot[] = [
      makeSnapshot({
        planeState: "started",
        forestTreeId: "t1",
        forestTreeState: "growing",
        forestLastActivity: hoursAgo(1),
      }),
    ];
    const agents: AgentSnapshot[] = [
      makeAgent({ status: "idle" }),
    ];

    const findings = runAllDetectors(snapshots, agents, NOW);
    expect(findings).toHaveLength(0);
  });

  test("handles empty inputs", () => {
    const findings = runAllDetectors([], [], NOW);
    expect(findings).toHaveLength(0);
  });
});

// ── formatFindings ────────────────────────────────────────────────────────────

describe("formatFindings", () => {
  test("returns all-clear message for no findings", () => {
    const result = formatFindings([]);
    expect(result).toContain("all clear");
  });

  test("includes issue count", () => {
    const findings: GardenerFinding[] = [
      {
        type: "orphaned_session",
        workItemId: "ELLIE-1",
        title: "Orphaned: ELLIE-1",
        description: "Test",
        evidence: {},
        severity: "warning",
        suggestedAction: "Fix it",
      },
    ];
    const result = formatFindings(findings);
    expect(result).toContain("1 issue(s) found");
  });

  test("groups findings by type", () => {
    const findings: GardenerFinding[] = [
      {
        type: "orphaned_session",
        title: "Orphaned: ELLIE-1",
        description: "Test",
        evidence: {},
        severity: "warning",
        suggestedAction: "Fix",
      },
      {
        type: "stale_session",
        title: "Stale: ELLIE-2",
        description: "Test",
        evidence: {},
        severity: "warning",
        suggestedAction: "Fix",
      },
      {
        type: "orphaned_session",
        title: "Orphaned: ELLIE-3",
        description: "Test",
        evidence: {},
        severity: "warning",
        suggestedAction: "Fix",
      },
    ];
    const result = formatFindings(findings);
    expect(result).toContain("Orphaned Sessions");
    expect(result).toContain("Stale Sessions");
    expect(result).toContain("3 issue(s) found");
  });

  test("includes severity markers", () => {
    const findings: GardenerFinding[] = [
      {
        type: "stale_session",
        title: "Stale: ELLIE-1",
        description: "Test",
        evidence: {},
        severity: "critical",
        suggestedAction: "Fix",
      },
    ];
    const result = formatFindings(findings);
    expect(result).toContain("[!]");
  });

  test("shows type labels correctly", () => {
    const findings: GardenerFinding[] = [
      { type: "dead_agent", agentName: "dev", title: "Dead: dev", description: "T", evidence: {}, severity: "warning", suggestedAction: "F" },
      { type: "state_mismatch", title: "Mismatch: ELLIE-5", description: "T", evidence: {}, severity: "warning", suggestedAction: "F" },
    ];
    const result = formatFindings(findings);
    expect(result).toContain("Dead Agents");
    expect(result).toContain("State Mismatches");
  });
});
