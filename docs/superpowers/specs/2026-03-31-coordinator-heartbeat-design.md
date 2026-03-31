# Coordinator Heartbeat System

**Date:** 2026-03-31
**Status:** Draft
**Related:** ELLIE coordinator loop, overnight scheduler, foundation system

## Summary

A two-phase periodic heartbeat where the coordinator wakes on a fixed interval, runs a cheap pre-check against 6 data sources, and only invokes the full coordinator loop when something has actually changed. This gives Ellie proactive awareness — monitoring domains, surfacing issues, continuing background work, and producing periodic reports — without burning LLM tokens on silence.

## Design Decisions

- **Single coordinator heartbeat, not per-agent.** The coordinator decides who to dispatch based on the playbook/foundation. One timer, one decision-maker.
- **Two-phase approach.** Phase 1 is pure code (no LLM). Phase 2 reuses the existing coordinator loop. Most ticks cost zero tokens.
- **Deliver to last channel.** Heartbeat results go to whatever channel Dave last used. Silent if nothing noteworthy.
- **Fixed interval during active hours.** No adaptive scheduling — simple and predictable.
- **Bridges overnight, doesn't replace it.** Coordinator can trigger and monitor overnight sessions. Overnight keeps its Docker execution for heavy work.

## Architecture

### Phase 1: Pre-Check (No LLM)

A timer fires every N minutes during active hours. The pre-check queries 6 data sources concurrently via `Promise.allSettled` (not `Promise.all` — one failing source must not block the others). Each source query has a 5-second timeout. Failed sources log a warning and return `{ changed: false }` — they don't trigger Phase 2 or crash the tick.

| Source | Query Method | Delta Detection | Phase 2 Trigger |
|--------|-------------|-----------------|-----------------|
| Email (UMS) | UMS inbox API — unread count | Count increased since last tick | New unread emails |
| GitHub CI | GitHub API — workflow runs for watched repos | New failed/errored run IDs | CI run broke |
| Plane tickets | Bridge read — recently updated tickets | Any ticket `updated_at` > last tick | Ticket state/comment changes |
| Calendar | Google Calendar API — events in next 30 min | New event IDs in window | Upcoming meeting appeared |
| Forest | Forest bridge read — recent branches | New branch IDs since last tick | New knowledge written |
| GTD | `todos` table — open/overdue/completed | Status changes, new overdue items | Task overdue, completed, or newly scheduled |

Each source returns a `SourceDelta`:

```typescript
interface SourceDelta {
  source: "email" | "ci" | "plane" | "calendar" | "forest" | "gtd";
  changed: boolean;
  summary: string;        // Human-readable: "2 new emails"
  count: number;           // Number of changed items
  details?: unknown;       // Source-specific data for Phase 2 prompt
}
```

After each tick, the pre-check stores a `HeartbeatSnapshot` — a compact record of what it saw — so the next tick can compute deltas.

```typescript
interface HeartbeatSnapshot {
  email_unread_count: number;
  ci_run_ids: string[];              // Known workflow run IDs (last 20)
  plane_last_updated_at: string;     // Most recent ticket updated_at
  calendar_event_ids: string[];      // Event IDs in next-30-min window
  forest_branch_ids: string[];       // Recent branch IDs (last 20)
  gtd_open_count: number;
  gtd_overdue_ids: string[];
  gtd_completed_ids: string[];       // Recently completed (since last tick)
  captured_at: string;               // ISO timestamp
}
```

Each source adapter compares the current query result against the snapshot fields for its source and produces a `SourceDelta`. The snapshot is stored as JSONB in `heartbeat_state.last_snapshot`.

**Per-source Phase 2 cooldown:** To prevent flappy sources (CI failing repeatedly, chatty Plane tickets) from triggering Phase 2 every tick, each source has a `min_phase2_interval` (default 30 minutes). If a source triggered Phase 2 within the cooldown window, its delta is logged but does not trigger a new Phase 2 run. The cooldown is tracked per-source in `heartbeat_state.source_cooldowns` (JSONB map of source → last Phase 2 timestamp).

**Guards (skip tick if):**
- Outside active hours
- User message currently being processed (concurrency guard)
- Previous Phase 2 still running
- Relay started less than `startup_grace_minutes` ago

If all deltas have `changed: false`, the tick ends. No LLM call, no cost. The tick is logged to `heartbeat_ticks` with `phase_reached: 1`.

### Phase 2: Coordinator Loop (LLM)

If any delta has `changed: true`, the pre-check results are templated into a heartbeat prompt and injected as a synthetic user message into the coordinator loop.

**Heartbeat prompt template:**

```
Heartbeat check at {time} CST.

Changes since last check ({interval} ago):
- 📧 {email_summary}
- 🔧 {ci_summary}
- 📋 {plane_summary}
- 📅 {calendar_summary}
- 🌲 {forest_summary}
- ✅ {gtd_summary}

Review and act as needed per the current playbook.
```

Only sources with `changed: true` are included in the prompt.

The coordinator runs its normal Think-Act-Observe cycle using existing tools:
- `read_context` — get detail on specific items
- `dispatch_agent` — send specialists to handle issues
- `update_user` — notify Dave of important findings
- `start_overnight` — trigger overnight session if appropriate
- `complete` — finish the heartbeat turn

**Session isolation:** The heartbeat uses its own session key (`coordinator:heartbeat`) with its own `CoordinatorContext`. This keeps heartbeat conversation history separate from active user conversations. The dispatch envelope's `parent_id` traces specialist work back to the heartbeat session.

**Transcript pruning:** If the coordinator calls `complete()` without ever calling `update_user`, the heartbeat turn is pruned from the session transcript. This prevents "all clear" turns from accumulating and bloating context.

**Delivery:** Results from `update_user` go to the last-used channel, determined by the most recent entry in the `messages` table where `user_id` matches Dave's ID (same logic used by `deliverResponse` in `ws-delivery.ts`). If the coordinator finds nothing worth reporting after reviewing deltas, it calls `complete()` silently.

## Configuration

**`heartbeat_state` is the single source of truth for all heartbeat configuration.** No config in BehaviorRules — this avoids drift between two config locations. All heartbeat settings are read from and written to the `heartbeat_state` singleton row.

The `/heartbeat` command and dashboard UI read/write `heartbeat_state` directly. Foundation switching can update `heartbeat_state` if needed (e.g., different sources per foundation), but the table is authoritative.

```sql
-- heartbeat_state holds BOTH config AND runtime state
CREATE TABLE heartbeat_state (
  id TEXT PRIMARY KEY DEFAULT 'singleton',
  -- Config fields
  enabled BOOLEAN NOT NULL DEFAULT false,
  interval_ms INT NOT NULL DEFAULT 900000,       -- 15 min
  active_start TEXT NOT NULL DEFAULT '07:00',     -- CST
  active_end TEXT NOT NULL DEFAULT '22:00',       -- CST
  sources TEXT[] NOT NULL DEFAULT '{"email","ci","plane","calendar","forest","gtd"}',
  startup_grace_ms INT NOT NULL DEFAULT 120000,   -- 2 min
  min_phase2_interval_ms INT NOT NULL DEFAULT 1800000, -- 30 min per-source cooldown
  -- Runtime state
  last_tick_at TIMESTAMPTZ,
  last_phase2_at TIMESTAMPTZ,
  last_snapshot JSONB,                            -- HeartbeatSnapshot
  source_cooldowns JSONB DEFAULT '{}',            -- { "ci": "2026-03-31T..." }
  consecutive_skips INT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

**Atomic tick guard:** To prevent double-tick races (read-modify-write on the singleton), the tick uses an atomic check-and-set:

```sql
UPDATE heartbeat_state
SET last_tick_at = now(), updated_at = now()
WHERE id = 'singleton' AND (last_tick_at IS NULL OR last_tick_at < $1)
RETURNING *;
```

If the `RETURNING` clause returns no rows, another tick is already running — skip.

**Foundation-level control:** Switching foundations can update `heartbeat_state` (sources, interval) via the foundation switch handler. But `heartbeat_state` remains authoritative — the foundation just writes new values to it.

**Existing coordinator settings that apply:**
- `proactivity` (from BehaviorRules) — influences how aggressively the coordinator acts on deltas in Phase 2
- `max_loop_iterations` (from BehaviorRules) — caps Phase 2 thinking depth

## Overnight Bridge

The heartbeat bridges to the overnight scheduler in two directions:

**Triggering:** During late-evening heartbeats, if the coordinator sees queued GTD tasks marked for overnight work, it can call the existing `start_overnight` tool. Foundation behavior rules can include guidance like "if after 10pm and overnight-eligible tasks exist, start a session."

**Monitoring:** During morning heartbeats, the coordinator checks if an overnight session ran. If it did, it reads results (PRs created, tasks completed/failed) and sends Dave a morning summary via `update_user`.

## Lifecycle

| Event | Heartbeat Behavior |
|-------|-------------------|
| Relay starts | Timer created, grace period, first tick after grace |
| Foundation switch | Timer reconfigured with new interval/sources/active hours |
| User sends message | Current tick skipped if Phase 2 running; timer continues |
| Relay shutdown | Timer cleared, in-flight Phase 2 completes (with timeout) |
| Active hours start | First tick fires, normal interval begins |
| Active hours end | Timer continues but ticks are no-ops until next window |

## Observability

- **`heartbeat_ticks` table:** Each tick logged with timestamp, phase reached (1 or 2), deltas found, actions taken, cost.
- **Agent monitor panel:** Existing `spawn_status`/`spawn_announcement` WebSocket events fire when Phase 2 dispatches specialists.
- **`/heartbeat status` command:** Shows last tick time, next scheduled, deltas from last run, enabled state.

## Database

### `heartbeat_ticks` table (Supabase)

```sql
CREATE TABLE heartbeat_ticks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tick_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  phase_reached INT NOT NULL,          -- 1 or 2
  deltas JSONB,                        -- SourceDelta[] from pre-check
  actions_taken JSONB,                 -- Summary of Phase 2 actions
  cost_usd NUMERIC(8,4) DEFAULT 0,
  duration_ms INT,
  foundation TEXT,                     -- Active foundation at tick time
  skipped_reason TEXT                  -- If tick was skipped, why
);
```

### `heartbeat_state` table (Supabase)

See Configuration section above — `heartbeat_state` holds both config and runtime state in a single singleton row. The full schema is defined there.

## New Files

| File | Purpose |
|------|---------|
| `src/heartbeat/timer.ts` | setInterval management, active hours gating, concurrency guard |
| `src/heartbeat/pre-check.ts` | Phase 1 — query 6 sources, compute deltas, snapshot comparison |
| `src/heartbeat/sources/*.ts` | Individual source adapters (email.ts, ci.ts, plane.ts, calendar.ts, forest.ts, gtd.ts) |
| `src/heartbeat/prompt.ts` | Template deltas into coordinator heartbeat message |
| `src/heartbeat/state.ts` | Read/write heartbeat_state, store snapshots |
| `src/heartbeat/init.ts` | Relay startup/shutdown hooks, foundation switch handler |
| `migrations/supabase/YYYYMMDD_heartbeat.sql` | heartbeat_ticks + heartbeat_state tables |

## Integration Points

- **`src/relay.ts`** — Add heartbeat init to startup DAG (depth 1, depends on supabase)
- **`src/foundation-registry.ts`** — On `switchTo()`, reconfigure heartbeat timer
- **`src/coordinator.ts`** — No changes needed; heartbeat injects via existing `runCoordinatorLoop()`
- **`src/command-registry.ts`** — Register `/heartbeat` command (status/enable/disable)
- **`src/periodic-tasks.ts`** — Heartbeat runs its own timer, not via periodic-tasks (needs its own interval logic)

## Out of Scope

- Per-agent heartbeats — coordinator handles all dispatch decisions
- Adaptive intervals — fixed interval keeps complexity low
- Replacing overnight scheduler — heartbeat bridges to it, doesn't replace it
- Custom data source plugins — fixed set of 6 sources for now
