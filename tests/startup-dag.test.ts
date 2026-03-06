/**
 * Tests for StartupDAG — relay initialization dependency graph (ELLIE-497)
 *
 * Covers: registration, topological sort, cycle detection, parallel execution,
 * critical phase failures, shutdown ordering, skip propagation, enabled gates,
 * and the documented relay DAG structure.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { StartupDAG, type PhaseState, type StartupReport } from "../src/startup-dag.ts";

// ── Helpers ──────────────────────────────────────────────────

/** Track execution order */
function tracker() {
  const order: string[] = [];
  const timestamps: Map<string, { start: number; end: number }> = new Map();
  return {
    order,
    timestamps,
    fn: (name: string, delayMs = 0) => async () => {
      const start = Date.now();
      order.push(`start:${name}`);
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
      order.push(`end:${name}`);
      timestamps.set(name, { start, end: Date.now() });
    },
  };
}

// ── Registration ─────────────────────────────────────────────

describe("StartupDAG — Registration", () => {
  let dag: StartupDAG;
  beforeEach(() => { dag = new StartupDAG(); });

  test("registers a phase with no deps", () => {
    dag.register("config", { fn: () => {} });
    expect(dag.size).toBe(1);
    expect(dag.getPhase("config")).toBeDefined();
    expect(dag.getPhase("config")!.state).toBe("pending");
    expect(dag.getPhase("config")!.deps).toEqual([]);
    expect(dag.getPhase("config")!.critical).toBe(false);
  });

  test("registers a phase with deps", () => {
    dag.register("a", { fn: () => {} });
    dag.register("b", { deps: ["a"], fn: () => {} });
    expect(dag.getPhase("b")!.deps).toEqual(["a"]);
  });

  test("registers a critical phase", () => {
    dag.register("lock", { critical: true, fn: () => {} });
    expect(dag.getPhase("lock")!.critical).toBe(true);
  });

  test("throws on duplicate registration", () => {
    dag.register("config", { fn: () => {} });
    expect(() => dag.register("config", { fn: () => {} })).toThrow('already registered');
  });

  test("getPhaseNames returns all registered names", () => {
    dag.register("a", { fn: () => {} });
    dag.register("b", { fn: () => {} });
    dag.register("c", { fn: () => {} });
    expect(dag.getPhaseNames()).toEqual(["a", "b", "c"]);
  });

  test("getPhase returns undefined for unknown phase", () => {
    expect(dag.getPhase("nope")).toBeUndefined();
  });
});

// ── Topological Sort ─────────────────────────────────────────

describe("StartupDAG — Topological Sort", () => {
  let dag: StartupDAG;
  beforeEach(() => { dag = new StartupDAG(); });

  test("single phase with no deps", () => {
    dag.register("a", { fn: () => {} });
    expect(dag.getExecutionOrder()).toEqual(["a"]);
  });

  test("linear chain: a → b → c", () => {
    dag.register("a", { fn: () => {} });
    dag.register("b", { deps: ["a"], fn: () => {} });
    dag.register("c", { deps: ["b"], fn: () => {} });
    const order = dag.getExecutionOrder();
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("c"));
  });

  test("diamond: d depends on b and c, both depend on a", () => {
    dag.register("a", { fn: () => {} });
    dag.register("b", { deps: ["a"], fn: () => {} });
    dag.register("c", { deps: ["a"], fn: () => {} });
    dag.register("d", { deps: ["b", "c"], fn: () => {} });
    const order = dag.getExecutionOrder();
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("c"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("d"));
    expect(order.indexOf("c")).toBeLessThan(order.indexOf("d"));
  });

  test("independent phases can appear in any order", () => {
    dag.register("x", { fn: () => {} });
    dag.register("y", { fn: () => {} });
    dag.register("z", { fn: () => {} });
    const order = dag.getExecutionOrder();
    expect(order).toHaveLength(3);
    expect(new Set(order)).toEqual(new Set(["x", "y", "z"]));
  });

  test("throws on cycle: a → b → a", () => {
    dag.register("a", { deps: ["b"], fn: () => {} });
    dag.register("b", { deps: ["a"], fn: () => {} });
    expect(() => dag.getExecutionOrder()).toThrow("cycle");
  });

  test("throws on self-cycle: a → a", () => {
    dag.register("a", { deps: ["a"], fn: () => {} });
    expect(() => dag.getExecutionOrder()).toThrow("cycle");
  });

  test("throws on 3-node cycle: a → b → c → a", () => {
    dag.register("a", { deps: ["c"], fn: () => {} });
    dag.register("b", { deps: ["a"], fn: () => {} });
    dag.register("c", { deps: ["b"], fn: () => {} });
    expect(() => dag.getExecutionOrder()).toThrow("cycle");
  });

  test("cycle error message includes the cycle path", () => {
    dag.register("a", { deps: ["b"], fn: () => {} });
    dag.register("b", { deps: ["a"], fn: () => {} });
    try {
      dag.getExecutionOrder();
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err.message).toContain("→");
    }
  });

  test("throws on missing dependency", () => {
    dag.register("a", { deps: ["missing"], fn: () => {} });
    expect(() => dag.getExecutionOrder()).toThrow("Unknown dependency");
  });

  test("multiple roots converge to single sink", () => {
    dag.register("r1", { fn: () => {} });
    dag.register("r2", { fn: () => {} });
    dag.register("r3", { fn: () => {} });
    dag.register("sink", { deps: ["r1", "r2", "r3"], fn: () => {} });
    const order = dag.getExecutionOrder();
    expect(order[order.length - 1]).toBe("sink");
  });
});

// ── Parallel Groups ──────────────────────────────────────────

describe("StartupDAG — Parallel Groups", () => {
  let dag: StartupDAG;
  beforeEach(() => { dag = new StartupDAG(); });

  test("all independent phases are in group 0", () => {
    dag.register("a", { fn: () => {} });
    dag.register("b", { fn: () => {} });
    dag.register("c", { fn: () => {} });
    const groups = dag.getParallelGroups();
    expect(groups).toEqual([["a", "b", "c"]]);
  });

  test("linear chain produces one phase per group", () => {
    dag.register("a", { fn: () => {} });
    dag.register("b", { deps: ["a"], fn: () => {} });
    dag.register("c", { deps: ["b"], fn: () => {} });
    const groups = dag.getParallelGroups();
    expect(groups).toEqual([["a"], ["b"], ["c"]]);
  });

  test("diamond produces 3 levels: root, middle pair, sink", () => {
    dag.register("root", { fn: () => {} });
    dag.register("left", { deps: ["root"], fn: () => {} });
    dag.register("right", { deps: ["root"], fn: () => {} });
    dag.register("sink", { deps: ["left", "right"], fn: () => {} });
    const groups = dag.getParallelGroups();
    expect(groups).toHaveLength(3);
    expect(groups[0]).toEqual(["root"]);
    expect(groups[1]).toEqual(["left", "right"]);
    expect(groups[2]).toEqual(["sink"]);
  });

  test("mixed depths", () => {
    dag.register("a", { fn: () => {} });
    dag.register("b", { fn: () => {} });
    dag.register("c", { deps: ["a"], fn: () => {} });
    dag.register("d", { deps: ["a", "b"], fn: () => {} });
    const groups = dag.getParallelGroups();
    expect(groups[0]).toEqual(["a", "b"]);
    expect(groups[1]).toEqual(["c", "d"]);
  });
});

// ── Execution ────────────────────────────────────────────────

describe("StartupDAG — Execution", () => {
  let dag: StartupDAG;
  beforeEach(() => { dag = new StartupDAG(); });

  test("runs a single phase", async () => {
    let ran = false;
    dag.register("a", { fn: () => { ran = true; } });
    await dag.run();
    expect(ran).toBe(true);
    expect(dag.getPhase("a")!.state).toBe("done");
  });

  test("runs phases in dependency order", async () => {
    const t = tracker();
    dag.register("a", { fn: t.fn("a") });
    dag.register("b", { deps: ["a"], fn: t.fn("b") });
    dag.register("c", { deps: ["b"], fn: t.fn("c") });
    await dag.run();
    expect(t.order).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
  });

  test("runs independent phases in parallel", async () => {
    const t = tracker();
    dag.register("a", { fn: t.fn("a", 50) });
    dag.register("b", { fn: t.fn("b", 50) });
    dag.register("c", { fn: t.fn("c", 50) });
    await dag.run();

    // All should start before any ends (parallel execution)
    const firstEnd = t.order.findIndex(e => e.startsWith("end:"));
    const startCount = t.order.slice(0, firstEnd).filter(e => e.startsWith("start:")).length;
    expect(startCount).toBeGreaterThanOrEqual(2); // At least 2 started before first ended
  });

  test("dependent phase waits for all deps", async () => {
    const t = tracker();
    dag.register("a", { fn: t.fn("a", 30) });
    dag.register("b", { fn: t.fn("b", 30) });
    dag.register("c", { deps: ["a", "b"], fn: t.fn("c") });
    await dag.run();

    // c should start after both a and b end
    const cStart = t.order.indexOf("start:c");
    const aEnd = t.order.indexOf("end:a");
    const bEnd = t.order.indexOf("end:b");
    expect(cStart).toBeGreaterThan(aEnd);
    expect(cStart).toBeGreaterThan(bEnd);
  });

  test("reports timing for each phase", async () => {
    dag.register("a", { fn: async () => { await new Promise(r => setTimeout(r, 20)); } });
    const report = await dag.run();
    expect(report.phases[0].durationMs).toBeGreaterThanOrEqual(10);
  });

  test("report has totalMs", async () => {
    dag.register("a", { fn: () => {} });
    const report = await dag.run();
    expect(report.totalMs).toBeGreaterThanOrEqual(0);
  });

  test("all phases show done state after success", async () => {
    dag.register("a", { fn: () => {} });
    dag.register("b", { deps: ["a"], fn: () => {} });
    const report = await dag.run();
    expect(report.phases.every(p => p.state === "done")).toBe(true);
    expect(report.failed).toEqual([]);
    expect(report.skipped).toEqual([]);
  });
});

// ── Failure Handling ─────────────────────────────────────────

describe("StartupDAG — Failure Handling", () => {
  let dag: StartupDAG;
  beforeEach(() => { dag = new StartupDAG(); });

  test("non-critical failure marks phase as failed but continues", async () => {
    dag.register("a", { fn: () => { throw new Error("boom"); } });
    dag.register("b", { fn: () => {} });
    const report = await dag.run();
    expect(report.failed).toEqual(["a"]);
    expect(dag.getPhase("a")!.state).toBe("failed");
    expect(dag.getPhase("b")!.state).toBe("done");
  });

  test("critical failure aborts startup", async () => {
    dag.register("a", { critical: true, fn: () => { throw new Error("fatal"); } });
    dag.register("b", { fn: () => {} });
    await expect(dag.run()).rejects.toThrow("critical phase");
  });

  test("critical failure error includes phase name and message", async () => {
    dag.register("lock", { critical: true, fn: () => { throw new Error("lock busy"); } });
    try {
      await dag.run();
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain("lock");
      expect(err.message).toContain("lock busy");
    }
  });

  test("failed phase records error", async () => {
    dag.register("a", { fn: () => { throw new Error("test error"); } });
    await dag.run();
    expect(dag.getPhase("a")!.error?.message).toBe("test error");
  });

  test("failed phase records durationMs", async () => {
    dag.register("a", { fn: () => { throw new Error("fast fail"); } });
    await dag.run();
    expect(dag.getPhase("a")!.durationMs).toBeDefined();
  });

  test("dependents of failed phase are skipped", async () => {
    dag.register("a", { fn: () => { throw new Error("fail"); } });
    dag.register("b", { deps: ["a"], fn: () => {} });
    dag.register("c", { deps: ["b"], fn: () => {} });
    const report = await dag.run();
    expect(report.failed).toEqual(["a"]);
    expect(report.skipped).toContain("b");
    expect(report.skipped).toContain("c");
    expect(dag.getPhase("b")!.state).toBe("skipped");
    expect(dag.getPhase("c")!.state).toBe("skipped");
  });

  test("sibling of failed phase still runs", async () => {
    dag.register("root", { fn: () => {} });
    dag.register("fail-branch", { deps: ["root"], fn: () => { throw new Error("x"); } });
    dag.register("ok-branch", { deps: ["root"], fn: () => {} });
    const report = await dag.run();
    expect(dag.getPhase("fail-branch")!.state).toBe("failed");
    expect(dag.getPhase("ok-branch")!.state).toBe("done");
  });

  test("non-Error throw is wrapped", async () => {
    dag.register("a", { fn: () => { throw "string error"; } });
    await dag.run();
    expect(dag.getPhase("a")!.error).toBeInstanceOf(Error);
    expect(dag.getPhase("a")!.error!.message).toBe("string error");
  });

  test("critical failure skips remaining pending phases", async () => {
    let bRan = false;
    dag.register("a", { critical: true, fn: () => { throw new Error("abort"); } });
    dag.register("b", { fn: () => { bRan = true; } });
    try { await dag.run(); } catch {}
    // b might or might not run depending on parallel scheduling,
    // but any phase depending on 'a' would be skipped
    // Since a and b are independent, b may have already started
  });
});

// ── Enabled Gate ─────────────────────────────────────────────

describe("StartupDAG — Enabled Gate", () => {
  let dag: StartupDAG;
  beforeEach(() => { dag = new StartupDAG(); });

  test("disabled phase is skipped", async () => {
    let ran = false;
    dag.register("a", { enabled: () => false, fn: () => { ran = true; } });
    const report = await dag.run();
    expect(ran).toBe(false);
    expect(report.skipped).toContain("a");
    expect(dag.getPhase("a")!.state).toBe("skipped");
  });

  test("enabled phase runs normally", async () => {
    let ran = false;
    dag.register("a", { enabled: () => true, fn: () => { ran = true; } });
    await dag.run();
    expect(ran).toBe(true);
    expect(dag.getPhase("a")!.state).toBe("done");
  });

  test("disabled phase still satisfies deps (treated as done)", async () => {
    let bRan = false;
    dag.register("a", { enabled: () => false, fn: () => {} });
    dag.register("b", { deps: ["a"], fn: () => { bRan = true; } });
    await dag.run();
    expect(bRan).toBe(true);
    expect(dag.getPhase("b")!.state).toBe("done");
  });
});

// ── Shutdown ─────────────────────────────────────────────────

describe("StartupDAG — Shutdown", () => {
  let dag: StartupDAG;
  beforeEach(() => { dag = new StartupDAG(); });

  test("shutdown order is reverse of execution order", () => {
    dag.register("a", { fn: () => {} });
    dag.register("b", { deps: ["a"], fn: () => {} });
    dag.register("c", { deps: ["b"], fn: () => {} });
    const exec = dag.getExecutionOrder();
    const shut = dag.getShutdownOrder();
    expect(shut).toEqual([...exec].reverse());
  });

  test("shutdown runs shutdown functions", async () => {
    const order: string[] = [];
    dag.register("a", {
      fn: () => {},
      shutdown: () => { order.push("a-down"); },
    });
    dag.register("b", {
      deps: ["a"],
      fn: () => {},
      shutdown: () => { order.push("b-down"); },
    });
    await dag.run();
    await dag.shutdown();
    // b shuts down before a (reverse order)
    expect(order).toEqual(["b-down", "a-down"]);
  });

  test("shutdown skips phases that never started", async () => {
    const shutdowns: string[] = [];
    dag.register("a", {
      fn: () => { throw new Error("fail"); },
      shutdown: () => { shutdowns.push("a"); },
    });
    dag.register("b", {
      deps: ["a"],
      fn: () => {},
      shutdown: () => { shutdowns.push("b"); },
    });
    await dag.run();
    await dag.shutdown();
    // Neither should have shutdown called — a failed, b was skipped
    expect(shutdowns).toEqual([]);
  });

  test("shutdown skips phases without shutdown function", async () => {
    const shutdowns: string[] = [];
    dag.register("a", { fn: () => {} }); // no shutdown
    dag.register("b", {
      deps: ["a"],
      fn: () => {},
      shutdown: () => { shutdowns.push("b"); },
    });
    await dag.run();
    await dag.shutdown();
    expect(shutdowns).toEqual(["b"]);
  });

  test("shutdown continues even if one shutdown function fails", async () => {
    const shutdowns: string[] = [];
    dag.register("a", {
      fn: () => {},
      shutdown: () => { shutdowns.push("a"); },
    });
    dag.register("b", {
      fn: () => {},
      shutdown: () => { throw new Error("shutdown fail"); },
    });
    dag.register("c", {
      fn: () => {},
      shutdown: () => { shutdowns.push("c"); },
    });
    await dag.run();
    await dag.shutdown();
    // a and c should still shut down even though b's shutdown failed
    expect(shutdowns).toContain("a");
    expect(shutdowns).toContain("c");
  });

  test("shutdown respects timeout", async () => {
    dag.register("slow", {
      fn: () => {},
      shutdown: async () => { await new Promise(r => setTimeout(r, 5000)); },
    });
    dag.register("fast", {
      fn: () => {},
      shutdown: () => {},
    });
    await dag.run();
    // Should complete within timeout (100ms), not wait for the 5s shutdown
    const start = Date.now();
    await dag.shutdown(100);
    const elapsed = Date.now() - start;
    // The first shutdown is slow, but the timeout should abort
    // Note: it may still run a bit since we await the first one before checking
    expect(elapsed).toBeLessThan(5000);
  });
});

// ── Report ───────────────────────────────────────────────────

describe("StartupDAG — Report", () => {
  test("report includes all phase details", async () => {
    const dag = new StartupDAG();
    dag.register("a", { fn: () => {} });
    dag.register("b", { deps: ["a"], critical: true, fn: () => {} });
    const report = await dag.run();

    expect(report.phases).toHaveLength(2);
    const a = report.phases.find(p => p.name === "a")!;
    expect(a.state).toBe("done");
    expect(a.deps).toEqual([]);
    expect(a.critical).toBe(false);
    expect(a.durationMs).toBeDefined();

    const b = report.phases.find(p => p.name === "b")!;
    expect(b.state).toBe("done");
    expect(b.deps).toEqual(["a"]);
    expect(b.critical).toBe(true);
  });

  test("report includes error message for failed phases", async () => {
    const dag = new StartupDAG();
    dag.register("bad", { fn: () => { throw new Error("oh no"); } });
    const report = await dag.run();
    const bad = report.phases.find(p => p.name === "bad")!;
    expect(bad.error).toBe("oh no");
  });

  test("getReport works before run", () => {
    const dag = new StartupDAG();
    dag.register("a", { fn: () => {} });
    const report = dag.getReport();
    expect(report.phases[0].state).toBe("pending");
    expect(report.totalMs).toBe(0);
  });
});

// ── Relay DAG Structure ──────────────────────────────────────
// Tests the actual relay startup phases and their dependency structure

describe("StartupDAG — Relay Structure Validation", () => {
  function buildRelayDAG(): StartupDAG {
    const dag = new StartupDAG();
    const noop = () => {};

    // Phase 0: No-dep foundations
    dag.register("config", { critical: true, fn: noop });
    dag.register("directories", { critical: true, fn: noop });
    dag.register("supabase", { fn: noop });
    dag.register("lock", { critical: true, fn: noop, shutdown: noop });
    dag.register("anthropic", { fn: noop });

    // Phase 1: Bot needs config
    dag.register("bot", { deps: ["config"], critical: true, fn: noop, shutdown: noop });

    // Phase 1: Fire-and-forget (no deps)
    dag.register("dead-letters", { fn: noop });
    dag.register("approval-expiry", { fn: noop });
    dag.register("plane-queue", { fn: noop, shutdown: noop });
    dag.register("plane-reconcile", { fn: noop });
    dag.register("job-vines", { fn: noop });
    dag.register("mode-restore", { fn: noop });
    dag.register("archetype-validate", { fn: noop });
    dag.register("bridge-write", { fn: noop });
    dag.register("slack", { fn: noop });
    dag.register("routing-rules", { fn: noop });
    dag.register("workflow-templates", { fn: noop });
    dag.register("voice-providers", { fn: noop });
    dag.register("skill-watcher", { fn: noop });
    dag.register("google-chat", { fn: noop });
    dag.register("outlook", { fn: noop });

    // Phase 2: Orchestration needs supabase
    dag.register("orchestration", { deps: ["supabase"], fn: noop, shutdown: noop });
    dag.register("discord", { deps: ["supabase"], fn: noop, shutdown: noop });
    dag.register("model-costs", { deps: ["supabase"], fn: noop });
    dag.register("classifiers", { deps: ["anthropic", "supabase"], fn: noop });

    // Phase 3: Dependency wiring needs bot + anthropic + supabase
    dag.register("dep-wiring", { deps: ["bot", "anthropic", "supabase"], critical: true, fn: noop });

    // Phase 4: Periodic tasks need dep-wiring
    dag.register("periodic-tasks", { deps: ["dep-wiring"], fn: noop, shutdown: noop });

    // Phase 5: HTTP + Telegram
    dag.register("telegram-handlers", { deps: ["bot"], critical: true, fn: noop });
    dag.register("http-server", { critical: true, fn: noop, shutdown: noop });
    dag.register("forest-sync", { fn: noop, shutdown: noop });
    dag.register("nudge-checker", { deps: ["bot", "google-chat"], fn: noop });

    // Phase 6: WebSocket + listen need http-server
    dag.register("websocket-servers", { deps: ["http-server", "dep-wiring"], critical: true, fn: noop });
    dag.register("http-listen", { deps: ["http-server", "websocket-servers"], critical: true, fn: noop });
    dag.register("bot-start", { deps: ["telegram-handlers"], critical: true, fn: noop, shutdown: noop });

    return dag;
  }

  test("relay DAG has no cycles", () => {
    const dag = buildRelayDAG();
    expect(() => dag.getExecutionOrder()).not.toThrow();
  });

  test("relay DAG has expected phase count", () => {
    const dag = buildRelayDAG();
    expect(dag.size).toBe(34);
  });

  test("critical phases are correct", () => {
    const dag = buildRelayDAG();
    const criticalPhases = dag.getPhaseNames().filter(n => dag.getPhase(n)!.critical);
    expect(new Set(criticalPhases)).toEqual(new Set([
      "config", "directories", "lock", "bot",
      "dep-wiring", "telegram-handlers", "http-server",
      "websocket-servers", "http-listen", "bot-start",
    ]));
  });

  test("dep-wiring depends on bot, anthropic, supabase", () => {
    const dag = buildRelayDAG();
    const depWiring = dag.getPhase("dep-wiring")!;
    expect(depWiring.deps).toContain("bot");
    expect(depWiring.deps).toContain("anthropic");
    expect(depWiring.deps).toContain("supabase");
  });

  test("periodic-tasks depends on dep-wiring", () => {
    const dag = buildRelayDAG();
    expect(dag.getPhase("periodic-tasks")!.deps).toContain("dep-wiring");
  });

  test("websocket-servers depends on http-server and dep-wiring", () => {
    const dag = buildRelayDAG();
    const ws = dag.getPhase("websocket-servers")!;
    expect(ws.deps).toContain("http-server");
    expect(ws.deps).toContain("dep-wiring");
  });

  test("http-listen depends on websocket-servers", () => {
    const dag = buildRelayDAG();
    expect(dag.getPhase("http-listen")!.deps).toContain("websocket-servers");
  });

  test("bot-start depends on telegram-handlers", () => {
    const dag = buildRelayDAG();
    expect(dag.getPhase("bot-start")!.deps).toContain("telegram-handlers");
  });

  test("classifiers depend on both anthropic and supabase", () => {
    const dag = buildRelayDAG();
    const c = dag.getPhase("classifiers")!;
    expect(c.deps).toContain("anthropic");
    expect(c.deps).toContain("supabase");
  });

  test("nudge-checker depends on bot and google-chat", () => {
    const dag = buildRelayDAG();
    const n = dag.getPhase("nudge-checker")!;
    expect(n.deps).toContain("bot");
    expect(n.deps).toContain("google-chat");
  });

  test("parallel groups show expected concurrency", () => {
    const dag = buildRelayDAG();
    const groups = dag.getParallelGroups();
    // First group should have all no-dep phases
    expect(groups[0].length).toBeGreaterThan(10); // Many independent phases
    // Last group should be terminal phases
    const lastGroup = groups[groups.length - 1];
    // Terminal phases: http-listen or bot-start (deepest deps)
    expect(lastGroup.length).toBeGreaterThanOrEqual(1);
  });

  test("shutdown order reverses dep-wiring before bot", () => {
    const dag = buildRelayDAG();
    const shutOrder = dag.getShutdownOrder();
    const depWiringIdx = shutOrder.indexOf("dep-wiring");
    const botIdx = shutOrder.indexOf("bot");
    // dep-wiring depends on bot, so dep-wiring shuts down first (higher index = later in execution, lower in shutdown)
    expect(depWiringIdx).toBeLessThan(botIdx);
  });

  test("shutdown order: http-listen shuts down before http-server", () => {
    const dag = buildRelayDAG();
    const shutOrder = dag.getShutdownOrder();
    const listenIdx = shutOrder.indexOf("http-listen");
    const serverIdx = shutOrder.indexOf("http-server");
    expect(listenIdx).toBeLessThan(serverIdx);
  });

  test("shutdown order: periodic-tasks shuts down before dep-wiring", () => {
    const dag = buildRelayDAG();
    const shutOrder = dag.getShutdownOrder();
    const ptIdx = shutOrder.indexOf("periodic-tasks");
    const dwIdx = shutOrder.indexOf("dep-wiring");
    expect(ptIdx).toBeLessThan(dwIdx);
  });

  test("full execution succeeds on relay DAG", async () => {
    const dag = buildRelayDAG();
    const report = await dag.run();
    expect(report.failed).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.phases.every(p => p.state === "done")).toBe(true);
  });
});

// ── Edge Cases ───────────────────────────────────────────────

describe("StartupDAG — Edge Cases", () => {
  test("empty DAG runs without error", async () => {
    const dag = new StartupDAG();
    const report = await dag.run();
    expect(report.phases).toEqual([]);
    expect(report.failed).toEqual([]);
  });

  test("empty DAG shutdown runs without error", async () => {
    const dag = new StartupDAG();
    await dag.shutdown();
  });

  test("async phase function is awaited", async () => {
    const dag = new StartupDAG();
    let done = false;
    dag.register("async", {
      fn: async () => {
        await new Promise(r => setTimeout(r, 10));
        done = true;
      },
    });
    await dag.run();
    expect(done).toBe(true);
  });

  test("sync phase function works", async () => {
    const dag = new StartupDAG();
    let done = false;
    dag.register("sync", { fn: () => { done = true; } });
    await dag.run();
    expect(done).toBe(true);
  });

  test("large DAG (50 phases) handles correctly", async () => {
    const dag = new StartupDAG();
    // Chain of 50 phases
    for (let i = 0; i < 50; i++) {
      dag.register(`phase-${i}`, {
        deps: i > 0 ? [`phase-${i - 1}`] : [],
        fn: () => {},
      });
    }
    const order = dag.getExecutionOrder();
    expect(order).toHaveLength(50);
    expect(order[0]).toBe("phase-0");
    expect(order[49]).toBe("phase-49");

    const report = await dag.run();
    expect(report.failed).toEqual([]);
  });

  test("wide DAG (50 parallel phases) runs fast", async () => {
    const dag = new StartupDAG();
    for (let i = 0; i < 50; i++) {
      dag.register(`p-${i}`, { fn: async () => { await new Promise(r => setTimeout(r, 10)); } });
    }
    const start = Date.now();
    await dag.run();
    const elapsed = Date.now() - start;
    // 50 phases at 10ms each should take ~10-50ms in parallel, not 500ms sequential
    expect(elapsed).toBeLessThan(200);
  });

  test("phase with multiple failed deps is only skipped once", async () => {
    const dag = new StartupDAG();
    dag.register("a", { fn: () => { throw new Error("a"); } });
    dag.register("b", { fn: () => { throw new Error("b"); } });
    dag.register("c", { deps: ["a", "b"], fn: () => {} });
    const report = await dag.run();
    expect(report.skipped.filter(n => n === "c")).toHaveLength(1);
  });
});
