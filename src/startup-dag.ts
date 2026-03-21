/**
 * Startup DAG — Explicit dependency graph for relay initialization (ELLIE-497)
 *
 * Models the relay's startup sequence as a directed acyclic graph.
 * Each phase declares its dependencies, and the engine runs them in
 * topological order — parallel where possible, sequential where required.
 *
 * Shutdown runs in reverse topological order.
 *
 * Usage:
 *   const dag = new StartupDAG();
 *   dag.register('supabase', { fn: initSupabase });
 *   dag.register('periodic-tasks', { deps: ['supabase', 'anthropic'], fn: initTasks });
 *   await dag.run();
 *   // later...
 *   await dag.shutdown();
 */

import { log } from "./logger.ts";

const logger = log.child("startup");

// ── Types ────────────────────────────────────────────────────

export type PhaseState = "pending" | "running" | "done" | "failed" | "skipped";

export interface PhaseOptions {
  /** Phases that must complete before this one starts */
  deps?: string[];
  /** If true, failure aborts the entire startup. Default: false */
  critical?: boolean;
  /** The initialization function */
  fn: () => Promise<void> | void;
  /** Optional cleanup function for graceful shutdown */
  shutdown?: () => Promise<void> | void;
  /** If provided, phase is skipped when this returns false */
  enabled?: () => boolean;
}

export interface PhaseEntry {
  name: string;
  deps: string[];
  critical: boolean;
  fn: () => Promise<void> | void;
  shutdownFn?: () => Promise<void> | void;
  enabled?: () => boolean;
  state: PhaseState;
  startedAt?: number;
  durationMs?: number;
  error?: Error;
}

export interface StartupReport {
  phases: Array<{
    name: string;
    state: PhaseState;
    durationMs?: number;
    error?: string;
    deps: string[];
    critical: boolean;
  }>;
  totalMs: number;
  failed: string[];
  skipped: string[];
}

// ── DAG Engine ───────────────────────────────────────────────

export class StartupDAG {
  private phases = new Map<string, PhaseEntry>();
  private _startedAt = 0;
  private _totalMs = 0;

  /**
   * Register a phase with optional dependencies and shutdown logic.
   * Throws if the name is already registered.
   */
  register(name: string, opts: PhaseOptions): void {
    if (this.phases.has(name)) {
      throw new Error(`Phase "${name}" is already registered`);
    }
    this.phases.set(name, {
      name,
      deps: opts.deps ?? [],
      critical: opts.critical ?? false,
      fn: opts.fn,
      shutdownFn: opts.shutdown,
      enabled: opts.enabled,
      state: "pending",
    });
  }

  /**
   * Topological sort — returns phase names in valid execution order.
   * Throws on cycles or missing dependencies.
   */
  getExecutionOrder(): string[] {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const order: string[] = [];

    const visit = (name: string, path: string[]): void => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        const cycle = [...path.slice(path.indexOf(name)), name];
        throw new Error(`Dependency cycle detected: ${cycle.join(" → ")}`);
      }

      const phase = this.phases.get(name);
      if (!phase) {
        throw new Error(`Unknown dependency "${name}" referenced by "${path[path.length - 1]}"`);
      }

      visiting.add(name);
      for (const dep of phase.deps) {
        visit(dep, [...path, name]);
      }
      visiting.delete(name);
      visited.add(name);
      order.push(name);
    };

    for (const name of this.phases.keys()) {
      visit(name, []);
    }

    return order;
  }

  /**
   * Run all phases in dependency order.
   * Phases with satisfied deps run in parallel.
   * Returns a report of what happened.
   */
  async run(): Promise<StartupReport> {
    this._startedAt = Date.now();

    // Validate the DAG first (throws on cycles/missing deps)
    this.getExecutionOrder();

    // Track which phases are done
    const done = new Set<string>();       // completed or disabled — satisfies deps
    const failed = new Set<string>();     // threw an error
    const depFailed = new Set<string>();  // skipped because a dep failed/was dep-skipped
    const skipped = new Set<string>();    // all skipped phases (for report)
    let aborted = false;

    // Check if a phase has all its deps satisfied
    const depsReady = (phase: PhaseEntry): boolean => {
      return phase.deps.every(d => done.has(d));
    };

    // Check if a phase should be skipped because a dep failed (not just disabled)
    const hasBrokenDep = (phase: PhaseEntry): boolean => {
      return phase.deps.some(d => failed.has(d) || depFailed.has(d));
    };

    // Process phases in waves until all are resolved
    const pending = new Set(this.phases.keys());
    const maxIterations = this.phases.size * 2; // Safety guard: 2x phase count
    let iterations = 0;

    while (pending.size > 0 && !aborted) {
      iterations++;
      if (iterations > maxIterations) {
        const remaining = [...pending].join(", ");
        throw new Error(`Startup loop detected after ${iterations} iterations — stuck phases: ${remaining}`);
      }

      // Find phases whose deps are all done
      const ready: PhaseEntry[] = [];
      for (const name of pending) {
        const phase = this.phases.get(name)!;
        if (hasBrokenDep(phase)) {
          phase.state = "skipped";
          depFailed.add(name);
          skipped.add(name);
          pending.delete(name);
          logger.warn(`[startup] SKIP ${name} — dependency failed`);
        } else if (depsReady(phase)) {
          ready.push(phase);
        }
      }

      if (ready.length === 0 && pending.size > 0) {
        // Deadlock — should not happen after topological validation
        const remaining = [...pending].join(", ");
        throw new Error(`Startup deadlock — stuck phases: ${remaining}`);
      }

      // Run all ready phases in parallel
      await Promise.all(
        ready.map(async (phase) => {
          pending.delete(phase.name);

          // Check enabled gate
          if (phase.enabled && !phase.enabled()) {
            phase.state = "skipped";
            skipped.add(phase.name);
            done.add(phase.name); // Treat as "done" for dependency resolution
            logger.info(`[startup] SKIP ${phase.name} — disabled`);
            return;
          }

          phase.state = "running";
          phase.startedAt = Date.now();
          logger.info(`[startup] START ${phase.name}`);

          try {
            await phase.fn();
            phase.state = "done";
            phase.durationMs = Date.now() - phase.startedAt;
            done.add(phase.name);
            logger.info(`[startup] DONE  ${phase.name} (${phase.durationMs}ms)`);
          } catch (err) {
            phase.state = "failed";
            phase.durationMs = Date.now() - phase.startedAt;
            phase.error = err instanceof Error ? err : new Error(String(err));
            failed.add(phase.name);
            logger.error(`[startup] FAIL  ${phase.name} (${phase.durationMs}ms)`, {
              error: phase.error.message,
            });

            if (phase.critical) {
              aborted = true;
              logger.error(`[startup] ABORT — critical phase "${phase.name}" failed`);
            }
          }
        })
      );
    }

    // Skip remaining phases if aborted
    if (aborted) {
      for (const name of pending) {
        const phase = this.phases.get(name)!;
        phase.state = "skipped";
        skipped.add(name);
      }
    }

    this._totalMs = Date.now() - this._startedAt;

    const report = this.getReport();
    logger.info(`[startup] Complete in ${this._totalMs}ms — ${done.size} done, ${failed.size} failed, ${skipped.size} skipped`);

    if (aborted) {
      const criticalError = [...failed]
        .map(n => this.phases.get(n)!)
        .find(p => p.critical);
      throw new Error(
        `Startup aborted: critical phase "${criticalError?.name}" failed — ${criticalError?.error?.message}`
      );
    }

    return report;
  }

  /**
   * Graceful shutdown — runs shutdown functions in reverse topological order.
   * Each phase's shutdown runs only after its dependents have shut down.
   */
  async shutdown(timeoutMs = 30_000): Promise<void> {
    const order = this.getExecutionOrder().reverse();
    logger.info(`[shutdown] Starting graceful shutdown (${order.length} phases)...`);
    const start = Date.now();

    for (const name of order) {
      const remaining = timeoutMs - (Date.now() - start);
      if (remaining <= 0) {
        logger.warn(`[shutdown] Timeout after ${timeoutMs}ms — aborting remaining phases`);
        break;
      }
      const phase = this.phases.get(name)!;
      if (!phase.shutdownFn) continue;
      if (phase.state !== "done") continue; // Only shut down phases that started

      logger.info(`[shutdown] Stopping ${name}...`);
      try {
        await Promise.race([
          phase.shutdownFn(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error(`shutdown timeout for ${name}`)), remaining)
          ),
        ]);
        logger.info(`[shutdown] Stopped ${name}`);
      } catch (err) {
        logger.error(`[shutdown] Error stopping ${name}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info(`[shutdown] Complete in ${Date.now() - start}ms`);
  }

  /**
   * Get current state of all phases.
   */
  getReport(): StartupReport {
    const phases: StartupReport["phases"] = [];
    const failedNames: string[] = [];
    const skippedNames: string[] = [];

    for (const [, phase] of this.phases) {
      phases.push({
        name: phase.name,
        state: phase.state,
        durationMs: phase.durationMs,
        error: phase.error?.message,
        deps: phase.deps,
        critical: phase.critical,
      });
      if (phase.state === "failed") failedNames.push(phase.name);
      if (phase.state === "skipped") skippedNames.push(phase.name);
    }

    return {
      phases,
      totalMs: this._totalMs,
      failed: failedNames,
      skipped: skippedNames,
    };
  }

  /**
   * Get the shutdown order (reverse of execution order).
   */
  getShutdownOrder(): string[] {
    return this.getExecutionOrder().reverse();
  }

  /**
   * Get phase count.
   */
  get size(): number {
    return this.phases.size;
  }

  /**
   * Get a specific phase's state.
   */
  getPhase(name: string): PhaseEntry | undefined {
    return this.phases.get(name);
  }

  /**
   * Get all phase names.
   */
  getPhaseNames(): string[] {
    return [...this.phases.keys()];
  }

  /**
   * Get phases that can run in parallel (same dependency depth).
   * Returns arrays of phase names grouped by depth level.
   */
  getParallelGroups(): string[][] {
    const depths = new Map<string, number>();

    const getDepth = (name: string, visited = new Set<string>()): number => {
      if (depths.has(name)) return depths.get(name)!;
      if (visited.has(name)) return 0; // cycle guard
      visited.add(name);

      const phase = this.phases.get(name)!;
      if (phase.deps.length === 0) {
        depths.set(name, 0);
        return 0;
      }
      const maxDep = Math.max(...phase.deps.map(d => getDepth(d, visited)));
      const depth = maxDep + 1;
      depths.set(name, depth);
      return depth;
    };

    for (const name of this.phases.keys()) {
      getDepth(name);
    }

    // Group by depth
    const groups = new Map<number, string[]>();
    for (const [name, depth] of depths) {
      if (!groups.has(depth)) groups.set(depth, []);
      groups.get(depth)!.push(name);
    }

    // Sort by depth and return
    return [...groups.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, names]) => names.sort());
  }
}

// ── Relay Startup Phases (ELLIE-497) ─────────────────────────
//
// This documents the full initialization DAG for the relay.
// See relay.ts for the actual registration calls.
//
// PHASE                     DEPS                            CRITICAL  SHUTDOWN
// ─────────────────────────────────────────────────────────────────────────────
// config                    (none)                          yes       -
// directories               (none)                          yes       -
// supabase                  (none)                          no        -
// lock                      (none)                          yes       release-lock
// bot                       config                          yes       bot.stop()
// anthropic                 (none)                          no        -
// dead-letters              (none)                          no        -
// approval-expiry           (none)                          no        -
// plane-queue               (none)                          no        stop-worker
// plane-reconcile           (none)                          no        -
// orchestration             supabase                        no        stop-watchdog + reconciler
// job-vines                 (none)                          no        -
// mode-restore              (none)                          no        -
// archetype-validate        (none)                          no        -
// bridge-write              (none)                          no        -
// dep-wiring                bot, anthropic, supabase        yes       -
// periodic-tasks            dep-wiring                      no        stop-all-tasks
// discord                   supabase                        no        stop-gateway
// slack                     (none)                          no        -
// classifiers               anthropic, supabase             no        -
// routing-rules             (none)                          no        -
// workflow-templates        (none)                          no        -
// model-costs               supabase                        no        -
// voice-providers           (none)                          no        -
// skill-watcher             (none)                          no        -
// telegram-handlers         bot                             yes       -
// http-server               (none)                          yes       server.close()
// google-chat               (none)                          no        -
// outlook                   (none)                          no        -
// nudge-checker             bot, google-chat                no        -
// forest-sync               (none)                          no        stop-sync
// websocket-servers         http-server, dep-wiring         yes       -
// http-listen               http-server, websocket-servers  yes       -
// bot-start                 telegram-handlers               yes       -
//
// SHUTDOWN ORDER (reverse topological):
// bot-start → http-listen → websocket-servers → nudge-checker →
// forest-sync → telegram-handlers → periodic-tasks → discord →
// slack → classifiers → orchestration → plane-queue →
// approval-expiry → http-server → dep-wiring → lock → bot →
// (remaining phases have no shutdown)
