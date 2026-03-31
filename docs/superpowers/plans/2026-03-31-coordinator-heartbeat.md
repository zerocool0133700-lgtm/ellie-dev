# Coordinator Heartbeat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Ellie proactive awareness via a two-phase periodic heartbeat — a cheap pre-check against 6 data sources, and a full coordinator loop only when something changed.

**Architecture:** Phase 1 (pure code, no LLM) queries 6 sources via Promise.allSettled with 5s timeouts, compares against a stored snapshot, and only triggers Phase 2 (existing coordinator loop) when deltas are found. heartbeat_state singleton table is the sole config + state authority. Per-source cooldowns prevent flappy Phase 2 triggers. Atomic check-and-set prevents double-tick races.

**Tech Stack:** TypeScript/Bun, Supabase (heartbeat_state + heartbeat_ticks), existing coordinator loop, existing UMS/bridge/calendar APIs

**Spec:** `docs/superpowers/specs/2026-03-31-coordinator-heartbeat-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `migrations/supabase/20260331_heartbeat.sql` | Schema: heartbeat_state + heartbeat_ticks tables |
| `src/heartbeat/types.ts` | Shared types: SourceDelta, HeartbeatSnapshot, HeartbeatConfig |
| `src/heartbeat/state.ts` | Read/write heartbeat_state singleton, atomic tick guard, snapshot storage |
| `src/heartbeat/sources/email.ts` | UMS inbox unread count source adapter |
| `src/heartbeat/sources/ci.ts` | GitHub CI workflow run status adapter |
| `src/heartbeat/sources/plane.ts` | Plane recently updated tickets adapter |
| `src/heartbeat/sources/calendar.ts` | Calendar upcoming events adapter |
| `src/heartbeat/sources/forest.ts` | Forest recent branches/decisions adapter |
| `src/heartbeat/sources/gtd.ts` | GTD open/overdue/completed adapter |
| `src/heartbeat/pre-check.ts` | Phase 1 — run all sources via allSettled, compute deltas, apply cooldowns |
| `src/heartbeat/prompt.ts` | Template deltas into coordinator heartbeat message |
| `src/heartbeat/timer.ts` | setInterval management, active hours gating, concurrency guard, tick orchestration |
| `src/heartbeat/init.ts` | Relay startup/shutdown hooks |
| `tests/heartbeat-precheck.test.ts` | Tests for delta detection, cooldowns, snapshot comparison |
| `tests/heartbeat-timer.test.ts` | Tests for active hours, parseTime, tick guards |

### Modified Files

| File | Change |
|------|--------|
| `src/relay.ts` | Import and initialize heartbeat in startup DAG |
| `src/foundation-registry.ts` | On switchTo(), update heartbeat_state config |
| `src/command-registry.ts` or relay command handler | Register /heartbeat command |

---

## Task 1: Schema — heartbeat_state + heartbeat_ticks

**Files:**
- Create: `migrations/supabase/20260331_heartbeat.sql`

- [ ] **Step 1: Write the migration**

```sql
-- ELLIE-1164: Coordinator Heartbeat System

-- heartbeat_state: singleton row, BOTH config AND runtime state
CREATE TABLE IF NOT EXISTS heartbeat_state (
  id TEXT PRIMARY KEY DEFAULT 'singleton',
  -- Config
  enabled BOOLEAN NOT NULL DEFAULT false,
  interval_ms INT NOT NULL DEFAULT 900000,
  active_start TEXT NOT NULL DEFAULT '07:00',
  active_end TEXT NOT NULL DEFAULT '22:00',
  sources TEXT[] NOT NULL DEFAULT '{"email","ci","plane","calendar","forest","gtd"}',
  startup_grace_ms INT NOT NULL DEFAULT 120000,
  min_phase2_interval_ms INT NOT NULL DEFAULT 1800000,
  -- Runtime state
  last_tick_at TIMESTAMPTZ,
  last_phase2_at TIMESTAMPTZ,
  last_snapshot JSONB,
  source_cooldowns JSONB DEFAULT '{}',
  consecutive_skips INT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Insert singleton row
INSERT INTO heartbeat_state (id) VALUES ('singleton') ON CONFLICT DO NOTHING;

-- heartbeat_ticks: append-only log of every tick
CREATE TABLE IF NOT EXISTS heartbeat_ticks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tick_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  phase_reached INT NOT NULL,
  deltas JSONB,
  actions_taken JSONB,
  cost_usd NUMERIC(8,4) DEFAULT 0,
  duration_ms INT,
  foundation TEXT,
  skipped_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_heartbeat_ticks_at ON heartbeat_ticks(tick_at DESC);
```

- [ ] **Step 2: Apply via Supabase Management API**

```bash
cd /home/ellie/ellie-dev && source .env
SQL=$(cat migrations/supabase/20260331_heartbeat.sql)
curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg q "$SQL" '{query: $q}')"
```

- [ ] **Step 3: Commit**

```bash
git add migrations/supabase/20260331_heartbeat.sql
git commit -m "[ELLIE-1164] Add heartbeat_state + heartbeat_ticks tables"
```

---

## Task 2: Shared Types

**Files:**
- Create: `src/heartbeat/types.ts`

- [ ] **Step 1: Create types**

```typescript
/**
 * Coordinator Heartbeat — Shared Types (ELLIE-1164)
 */

export type HeartbeatSource = "email" | "ci" | "plane" | "calendar" | "forest" | "gtd";

export interface SourceDelta {
  source: HeartbeatSource;
  changed: boolean;
  summary: string;
  count: number;
  details?: unknown;
  error?: string;
}

export interface HeartbeatSnapshot {
  email_unread_count: number;
  ci_run_ids: string[];
  plane_last_updated_at: string;
  calendar_event_ids: string[];
  forest_branch_ids: string[];
  gtd_open_count: number;
  gtd_overdue_ids: string[];
  gtd_completed_ids: string[];
  captured_at: string;
}

export interface HeartbeatConfig {
  enabled: boolean;
  interval_ms: number;
  active_start: string;
  active_end: string;
  sources: HeartbeatSource[];
  startup_grace_ms: number;
  min_phase2_interval_ms: number;
}

export interface HeartbeatState extends HeartbeatConfig {
  last_tick_at: string | null;
  last_phase2_at: string | null;
  last_snapshot: HeartbeatSnapshot | null;
  source_cooldowns: Record<string, string>;
  consecutive_skips: number;
}

export interface TickRecord {
  phase_reached: 1 | 2;
  deltas: SourceDelta[];
  actions_taken?: unknown;
  cost_usd: number;
  duration_ms: number;
  foundation: string;
  skipped_reason?: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/heartbeat/types.ts
git commit -m "[ELLIE-1164] Add heartbeat shared types"
```

---

## Task 3: State Manager

**Files:**
- Create: `src/heartbeat/state.ts`
- Create: `tests/heartbeat-state.test.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, it, expect } from "bun:test";

describe("heartbeat state", () => {
  it("isInActiveHours returns true during active window", async () => {
    const { isInActiveHours } = await import("../src/heartbeat/state");
    // 10 AM is within 07:00-22:00
    const date = new Date("2026-03-31T10:00:00-06:00"); // CST
    expect(isInActiveHours("07:00", "22:00", date)).toBe(true);
  });

  it("isInActiveHours returns false outside window", async () => {
    const { isInActiveHours } = await import("../src/heartbeat/state");
    const date = new Date("2026-03-31T23:00:00-06:00"); // 11 PM CST
    expect(isInActiveHours("07:00", "22:00", date)).toBe(false);
  });

  it("isSourceOnCooldown returns true within cooldown", async () => {
    const { isSourceOnCooldown } = await import("../src/heartbeat/state");
    const cooldowns = { ci: new Date(Date.now() - 10 * 60 * 1000).toISOString() }; // 10 min ago
    expect(isSourceOnCooldown("ci", cooldowns, 30 * 60 * 1000)).toBe(true); // 30 min cooldown
  });

  it("isSourceOnCooldown returns false after cooldown", async () => {
    const { isSourceOnCooldown } = await import("../src/heartbeat/state");
    const cooldowns = { ci: new Date(Date.now() - 60 * 60 * 1000).toISOString() }; // 60 min ago
    expect(isSourceOnCooldown("ci", cooldowns, 30 * 60 * 1000)).toBe(false); // 30 min cooldown
  });
});
```

- [ ] **Step 2: Implement state.ts**

```typescript
/**
 * Heartbeat State Manager — ELLIE-1164
 * Reads/writes heartbeat_state singleton. Atomic tick guard.
 */

import { log } from "../logger.ts";
import { getRelayDeps } from "../relay-state.ts";
import type { HeartbeatState, HeartbeatSnapshot, TickRecord, HeartbeatSource } from "./types.ts";

const logger = log.child("heartbeat-state");

export function isInActiveHours(start: string, end: string, now: Date = new Date()): boolean {
  const [startH, startM] = start.split(":").map(Number);
  const [endH, endM] = end.split(":").map(Number);
  const cst = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const currentMinutes = cst.getHours() * 60 + cst.getMinutes();
  const startMinutes = startH * 60 + (startM || 0);
  const endMinutes = endH * 60 + (endM || 0);
  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

export function isSourceOnCooldown(
  source: string,
  cooldowns: Record<string, string>,
  minIntervalMs: number,
): boolean {
  const lastPhase2 = cooldowns[source];
  if (!lastPhase2) return false;
  return Date.now() - new Date(lastPhase2).getTime() < minIntervalMs;
}

export async function getHeartbeatState(): Promise<HeartbeatState | null> {
  const { supabase } = getRelayDeps();
  if (!supabase) return null;
  const { data } = await supabase.from("heartbeat_state").select("*").eq("id", "singleton").single();
  return data as HeartbeatState | null;
}

export async function atomicClaimTick(beforeTimestamp: string): Promise<HeartbeatState | null> {
  const { supabase } = getRelayDeps();
  if (!supabase) return null;
  // Atomic: only succeeds if no other tick has claimed since beforeTimestamp
  const { data, error } = await supabase
    .from("heartbeat_state")
    .update({ last_tick_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", "singleton")
    .or(`last_tick_at.is.null,last_tick_at.lt.${beforeTimestamp}`)
    .select("*")
    .single();
  if (error || !data) return null;
  return data as HeartbeatState;
}

export async function saveSnapshot(snapshot: HeartbeatSnapshot): Promise<void> {
  const { supabase } = getRelayDeps();
  if (!supabase) return;
  await supabase
    .from("heartbeat_state")
    .update({ last_snapshot: snapshot, updated_at: new Date().toISOString() })
    .eq("id", "singleton");
}

export async function updateCooldown(source: HeartbeatSource, cooldowns: Record<string, string>): Promise<void> {
  const { supabase } = getRelayDeps();
  if (!supabase) return;
  const updated = { ...cooldowns, [source]: new Date().toISOString() };
  await supabase
    .from("heartbeat_state")
    .update({ source_cooldowns: updated, last_phase2_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", "singleton");
}

export async function logTick(record: TickRecord): Promise<void> {
  const { supabase } = getRelayDeps();
  if (!supabase) return;
  await supabase.from("heartbeat_ticks").insert({
    phase_reached: record.phase_reached,
    deltas: record.deltas,
    actions_taken: record.actions_taken,
    cost_usd: record.cost_usd,
    duration_ms: record.duration_ms,
    foundation: record.foundation,
    skipped_reason: record.skipped_reason,
  });
}

export async function updateConfig(updates: Partial<HeartbeatState>): Promise<void> {
  const { supabase } = getRelayDeps();
  if (!supabase) return;
  await supabase.from("heartbeat_state").update({ ...updates, updated_at: new Date().toISOString() }).eq("id", "singleton");
}
```

- [ ] **Step 3: Run tests, commit**

```bash
bun test tests/heartbeat-state.test.ts
git add src/heartbeat/state.ts src/heartbeat/types.ts tests/heartbeat-state.test.ts
git commit -m "[ELLIE-1164] Add heartbeat state manager with atomic tick guard"
```

---

## Task 4: Source Adapters (6 files)

**Files:**
- Create: `src/heartbeat/sources/email.ts`
- Create: `src/heartbeat/sources/ci.ts`
- Create: `src/heartbeat/sources/plane.ts`
- Create: `src/heartbeat/sources/calendar.ts`
- Create: `src/heartbeat/sources/forest.ts`
- Create: `src/heartbeat/sources/gtd.ts`

Each adapter exports one function: `check(snapshot: HeartbeatSnapshot | null): Promise<{ delta: SourceDelta; snapshotUpdate: Partial<HeartbeatSnapshot> }>`.

- [ ] **Step 1: Implement all 6 adapters**

Each adapter:
1. Queries its data source using existing relay APIs/Supabase
2. Compares result against the relevant snapshot fields
3. Returns a delta (changed/not changed + summary) and snapshot updates

**Pattern (each file follows this):**

```typescript
import { getRelayDeps } from "../../relay-state.ts";
import type { SourceDelta, HeartbeatSnapshot } from "../types.ts";

const SOURCE_TIMEOUT = 5000; // 5 seconds

export async function check(snapshot: HeartbeatSnapshot | null): Promise<{
  delta: SourceDelta;
  snapshotUpdate: Partial<HeartbeatSnapshot>;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOURCE_TIMEOUT);

  try {
    // Query the data source
    // Compare against snapshot
    // Return delta + snapshot update
  } catch (err) {
    return {
      delta: { source: "SOURCE_NAME", changed: false, summary: "Check failed", count: 0, error: (err as Error).message },
      snapshotUpdate: {},
    };
  } finally {
    clearTimeout(timeout);
  }
}
```

**email.ts** — query Supabase messages table for unread count, compare against `snapshot.email_unread_count`

**ci.ts** — query GitHub API for recent workflow runs (via MCP if available, or bridge), compare run IDs against `snapshot.ci_run_ids`

**plane.ts** — query Plane API for recently updated tickets, compare `updated_at` against `snapshot.plane_last_updated_at`

**calendar.ts** — query `calendar_intel` table for events in next 30 min, compare event IDs against `snapshot.calendar_event_ids`

**forest.ts** — query Forest bridge for recent branch activity, compare against `snapshot.forest_branch_ids`

**gtd.ts** — query `todos` table for open/overdue counts and recently completed, compare against snapshot fields

- [ ] **Step 2: Commit**

```bash
git add src/heartbeat/sources/
git commit -m "[ELLIE-1164] Add 6 heartbeat source adapters"
```

---

## Task 5: Pre-Check Engine

**Files:**
- Create: `src/heartbeat/pre-check.ts`
- Create: `tests/heartbeat-precheck.test.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, it, expect } from "bun:test";

describe("heartbeat pre-check", () => {
  it("mergeSnapshots combines partial updates", async () => {
    const { mergeSnapshots } = await import("../src/heartbeat/pre-check");
    const base = { email_unread_count: 5, gtd_open_count: 10 } as any;
    const updates = [{ email_unread_count: 7 }, { gtd_open_count: 12 }];
    const merged = mergeSnapshots(base, updates);
    expect(merged.email_unread_count).toBe(7);
    expect(merged.gtd_open_count).toBe(12);
  });

  it("filterCooledDown removes sources on cooldown", async () => {
    const { filterCooledDown } = await import("../src/heartbeat/pre-check");
    const deltas = [
      { source: "ci", changed: true, summary: "1 failed", count: 1 },
      { source: "gtd", changed: true, summary: "2 overdue", count: 2 },
    ] as any[];
    const cooldowns = { ci: new Date().toISOString() }; // ci just triggered
    const filtered = filterCooledDown(deltas, cooldowns, 30 * 60 * 1000);
    expect(filtered.length).toBe(1);
    expect(filtered[0].source).toBe("gtd");
  });
});
```

- [ ] **Step 2: Implement pre-check.ts**

```typescript
/**
 * Heartbeat Pre-Check — ELLIE-1164
 * Phase 1: Query all sources via allSettled, compute deltas, apply cooldowns.
 */

import { log } from "../logger.ts";
import { isSourceOnCooldown } from "./state.ts";
import type { SourceDelta, HeartbeatSnapshot, HeartbeatSource } from "./types.ts";

const logger = log.child("heartbeat-precheck");

type SourceChecker = (snapshot: HeartbeatSnapshot | null) => Promise<{
  delta: SourceDelta;
  snapshotUpdate: Partial<HeartbeatSnapshot>;
}>;

const SOURCE_MODULES: Record<HeartbeatSource, string> = {
  email: "./sources/email.ts",
  ci: "./sources/ci.ts",
  plane: "./sources/plane.ts",
  calendar: "./sources/calendar.ts",
  forest: "./sources/forest.ts",
  gtd: "./sources/gtd.ts",
};

export async function runPreCheck(
  sources: HeartbeatSource[],
  snapshot: HeartbeatSnapshot | null,
): Promise<{ deltas: SourceDelta[]; newSnapshot: HeartbeatSnapshot }> {
  const checkers = await Promise.all(
    sources.map(async (s) => {
      const mod = await import(SOURCE_MODULES[s]) as { check: SourceChecker };
      return { source: s, check: mod.check };
    }),
  );

  const results = await Promise.allSettled(
    checkers.map(({ check }) => check(snapshot)),
  );

  const deltas: SourceDelta[] = [];
  const snapshotUpdates: Partial<HeartbeatSnapshot>[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const source = sources[i];
    if (result.status === "fulfilled") {
      deltas.push(result.value.delta);
      snapshotUpdates.push(result.value.snapshotUpdate);
    } else {
      logger.warn("Source check failed", { source, error: result.reason?.message });
      deltas.push({ source, changed: false, summary: "Check failed", count: 0, error: result.reason?.message });
    }
  }

  const newSnapshot = mergeSnapshots(snapshot, snapshotUpdates);
  return { deltas, newSnapshot };
}

export function mergeSnapshots(
  base: HeartbeatSnapshot | null,
  updates: Partial<HeartbeatSnapshot>[],
): HeartbeatSnapshot {
  const defaults: HeartbeatSnapshot = {
    email_unread_count: 0,
    ci_run_ids: [],
    plane_last_updated_at: "",
    calendar_event_ids: [],
    forest_branch_ids: [],
    gtd_open_count: 0,
    gtd_overdue_ids: [],
    gtd_completed_ids: [],
    captured_at: new Date().toISOString(),
  };
  const merged = { ...defaults, ...base };
  for (const update of updates) {
    Object.assign(merged, update);
  }
  merged.captured_at = new Date().toISOString();
  return merged;
}

export function filterCooledDown(
  deltas: SourceDelta[],
  cooldowns: Record<string, string>,
  minIntervalMs: number,
): SourceDelta[] {
  return deltas.filter((d) => {
    if (!d.changed) return false;
    if (isSourceOnCooldown(d.source, cooldowns, minIntervalMs)) {
      logger.info("Source on cooldown, skipping Phase 2 trigger", { source: d.source });
      return false;
    }
    return true;
  });
}
```

- [ ] **Step 3: Run tests, commit**

```bash
bun test tests/heartbeat-precheck.test.ts
git add src/heartbeat/pre-check.ts tests/heartbeat-precheck.test.ts
git commit -m "[ELLIE-1164] Add heartbeat pre-check engine with cooldowns"
```

---

## Task 6: Prompt Template

**Files:**
- Create: `src/heartbeat/prompt.ts`

- [ ] **Step 1: Implement prompt builder**

```typescript
/**
 * Heartbeat Prompt Template — ELLIE-1164
 * Converts deltas into a coordinator heartbeat message.
 */

import type { SourceDelta } from "./types.ts";

const ICONS: Record<string, string> = {
  email: "📧",
  ci: "🔧",
  plane: "📋",
  calendar: "📅",
  forest: "🌲",
  gtd: "✅",
};

export function buildHeartbeatPrompt(deltas: SourceDelta[], intervalMinutes: number): string {
  const now = new Date().toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });
  const changedDeltas = deltas.filter((d) => d.changed);

  if (changedDeltas.length === 0) return "";

  const lines = changedDeltas.map((d) => `- ${ICONS[d.source] || "•"} ${d.summary}`);

  return `Heartbeat check at ${now} CST.

Changes since last check (${intervalMinutes} min ago):
${lines.join("\n")}

Review and act as needed per the current playbook.`;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/heartbeat/prompt.ts
git commit -m "[ELLIE-1164] Add heartbeat prompt template"
```

---

## Task 7: Timer + Tick Orchestration

**Files:**
- Create: `src/heartbeat/timer.ts`
- Create: `tests/heartbeat-timer.test.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, it, expect } from "bun:test";

describe("heartbeat timer", () => {
  it("shouldSkipTick returns startup_grace when relay just started", async () => {
    const { shouldSkipTick } = await import("../src/heartbeat/timer");
    const result = shouldSkipTick({
      relayStartedAt: Date.now() - 30000, // 30s ago
      startupGraceMs: 120000,
      isProcessingMessage: false,
      isPhase2Running: false,
      isInActiveHours: true,
    });
    expect(result).toBe("startup_grace");
  });

  it("shouldSkipTick returns null when all clear", async () => {
    const { shouldSkipTick } = await import("../src/heartbeat/timer");
    const result = shouldSkipTick({
      relayStartedAt: Date.now() - 300000,
      startupGraceMs: 120000,
      isProcessingMessage: false,
      isPhase2Running: false,
      isInActiveHours: true,
    });
    expect(result).toBeNull();
  });

  it("shouldSkipTick returns outside_active_hours", async () => {
    const { shouldSkipTick } = await import("../src/heartbeat/timer");
    const result = shouldSkipTick({
      relayStartedAt: Date.now() - 300000,
      startupGraceMs: 120000,
      isProcessingMessage: false,
      isPhase2Running: false,
      isInActiveHours: false,
    });
    expect(result).toBe("outside_active_hours");
  });
});
```

- [ ] **Step 2: Implement timer.ts**

The timer module manages the setInterval, runs ticks, gates on active hours and guards, and orchestrates Phase 1 → Phase 2.

Key functions:
- `shouldSkipTick(opts)` — returns skip reason or null
- `startHeartbeat()` — reads config from heartbeat_state, starts interval
- `stopHeartbeat()` — clears interval
- `tick()` — the main tick function: claim atomic lock → run pre-check → if deltas, run Phase 2 → log tick
- Phase 2: calls `runCoordinatorLoop()` with heartbeat prompt, session key `coordinator:heartbeat`

- [ ] **Step 3: Run tests, commit**

```bash
bun test tests/heartbeat-timer.test.ts
git add src/heartbeat/timer.ts tests/heartbeat-timer.test.ts
git commit -m "[ELLIE-1164] Add heartbeat timer with tick orchestration"
```

---

## Task 8: Init + Relay Wiring

**Files:**
- Create: `src/heartbeat/init.ts`
- Modify: `src/relay.ts`
- Modify: `src/foundation-registry.ts`

- [ ] **Step 1: Create init.ts**

```typescript
/**
 * Heartbeat Init — ELLIE-1164
 * Relay startup/shutdown hooks.
 */

import { log } from "../logger.ts";
import { startHeartbeat, stopHeartbeat } from "./timer.ts";
import { getHeartbeatState } from "./state.ts";

const logger = log.child("heartbeat-init");

export async function initHeartbeat(): Promise<void> {
  const state = await getHeartbeatState();
  if (!state) {
    logger.warn("heartbeat_state not found, skipping init");
    return;
  }
  if (!state.enabled) {
    logger.info("Heartbeat disabled in config");
    return;
  }
  startHeartbeat();
  logger.info("Heartbeat initialized", { interval_ms: state.interval_ms, sources: state.sources });
}

export async function shutdownHeartbeat(): Promise<void> {
  stopHeartbeat();
  logger.info("Heartbeat stopped");
}
```

- [ ] **Step 2: Wire into relay.ts**

Add to the startup DAG (depth 1, after supabase):

```typescript
import { initHeartbeat, shutdownHeartbeat } from "./heartbeat/init.ts";

// In startup sequence:
{ const _done = startPhase("heartbeat");
  initHeartbeat().then(() => _done()).catch(err => { _done(); logger.warn("Heartbeat init failed", err); });
}

// In shutdown:
shutdownHeartbeat();
```

- [ ] **Step 3: Wire foundation switch**

In `foundation-registry.ts`, after `switchTo()` completes, update heartbeat config:

```typescript
// After setting active foundation:
try {
  const { updateConfig } = await import("./heartbeat/state.ts");
  const { stopHeartbeat, startHeartbeat } = await import("./heartbeat/timer.ts");
  stopHeartbeat();
  // Foundation can define heartbeat overrides in its behavior rules
  // For now, just restart with current heartbeat_state config
  startHeartbeat();
} catch { /* heartbeat may not be initialized */ }
```

- [ ] **Step 4: Register /heartbeat command**

Register a command that shows status, enables/disables:

```typescript
registerCommand({
  name: "heartbeat",
  description: "Show heartbeat status or enable/disable",
  category: "system",
  handler: async (args, ctx) => {
    const { getHeartbeatState, updateConfig } = await import("./heartbeat/state.ts");
    const sub = args[0];
    if (sub === "enable") {
      await updateConfig({ enabled: true });
      const { startHeartbeat } = await import("./heartbeat/timer.ts");
      startHeartbeat();
      return { handled: true, response: "Heartbeat enabled." };
    }
    if (sub === "disable") {
      await updateConfig({ enabled: false });
      const { stopHeartbeat } = await import("./heartbeat/timer.ts");
      stopHeartbeat();
      return { handled: true, response: "Heartbeat disabled." };
    }
    // Default: show status
    const state = await getHeartbeatState();
    if (!state) return { handled: true, response: "Heartbeat state not found." };
    return {
      handled: true,
      response: `Heartbeat: ${state.enabled ? "ON" : "OFF"}\nInterval: ${state.interval_ms / 60000}m\nLast tick: ${state.last_tick_at || "never"}\nSources: ${state.sources?.join(", ")}`,
    };
  },
});
```

- [ ] **Step 5: Commit**

```bash
git add src/heartbeat/init.ts src/relay.ts src/foundation-registry.ts
git commit -m "[ELLIE-1164] Wire heartbeat into relay startup + foundation switch + /heartbeat command"
```

---

## Summary

| Task | Component | What It Does |
|------|-----------|-------------|
| 1 | Schema | heartbeat_state + heartbeat_ticks tables |
| 2 | Types | Shared interfaces for deltas, snapshots, config |
| 3 | State | Singleton read/write, atomic tick guard, cooldown checks |
| 4 | Sources | 6 adapters (email, ci, plane, calendar, forest, gtd) |
| 5 | Pre-Check | Phase 1 engine — allSettled, delta computation, cooldowns |
| 6 | Prompt | Template deltas into coordinator message |
| 7 | Timer | Tick orchestration, active hours, guards, Phase 1 → Phase 2 |
| 8 | Init | Relay startup/shutdown, foundation switch, /heartbeat command |
