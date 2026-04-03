# Dispatch Observability Phase 1: Event Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Standardize dispatch events into a unified schema, store dispatch outcomes, emit stall events, and establish a progress line protocol — the data foundation for dispatch cards, drill-down, and bidirectional awareness.

**Architecture:** Extend the existing `OrchestrationEvent` in Forest DB with structured payload fields. Add a `dispatch_outcomes` table. Wire stall detection to the unified event system. Broadcast all events to Ellie Chat WebSocket as `dispatch_event` messages. Specialists report structured data via working memory.

**Tech Stack:** TypeScript (Bun), postgres.js (Forest DB), WebSocket, bun:test

**Spec:** `docs/superpowers/specs/2026-04-03-dispatch-observability-design.md` — Phase 1 section

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `migrations/forest/20260403_dispatch_outcomes.sql` | Create | dispatch_outcomes table + stalled enum value |
| `src/dispatch-events.ts` | Create | Unified event emitter + WebSocket broadcaster + types |
| `src/dispatch-outcomes.ts` | Create | Outcome storage: write, read, retention |
| `src/progress-reporter.ts` | Create | `reportProgress()` helper |
| `src/orchestration-ledger.ts` | Modify | Add `"stalled"` to `OrchestrationEventType` |
| `src/orchestration-monitor.ts` | Modify | Wire stall detection to emit stalled events |
| `src/coordinator.ts` | Modify | Emit unified events + write outcomes on dispatch complete |
| `tests/dispatch-events.test.ts` | Create | Unified event emission tests |
| `tests/dispatch-outcomes.test.ts` | Create | Outcome storage tests |
| `tests/progress-reporter.test.ts` | Create | Progress line tests |

---

### Task 1: Database migration — dispatch_outcomes table + stalled enum

**Files:**
- Create: `migrations/forest/20260403_dispatch_outcomes.sql`

- [ ] **Step 1: Write the migration**

Create `/home/ellie/ellie-dev/migrations/forest/20260403_dispatch_outcomes.sql`:

```sql
-- Phase 1: Dispatch Observability — outcome storage + stalled event type
-- ELLIE-1309, ELLIE-1310

-- Add 'stalled' to the orchestration_event_type enum
ALTER TYPE orchestration_event_type ADD VALUE IF NOT EXISTS 'stalled';

-- Dispatch outcomes table
CREATE TABLE IF NOT EXISTS dispatch_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id TEXT NOT NULL UNIQUE,
  parent_run_id TEXT,
  agent TEXT NOT NULL,
  work_item_id TEXT,
  dispatch_type TEXT NOT NULL DEFAULT 'single',
  status TEXT NOT NULL,
  summary TEXT,
  files_changed TEXT[] DEFAULT '{}',
  decisions TEXT[] DEFAULT '{}',
  commits TEXT[] DEFAULT '{}',
  forest_writes TEXT[] DEFAULT '{}',
  duration_ms INTEGER,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd NUMERIC(10,4),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispatch_outcomes_run_id ON dispatch_outcomes(run_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_outcomes_work_item ON dispatch_outcomes(work_item_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_outcomes_created ON dispatch_outcomes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dispatch_outcomes_parent ON dispatch_outcomes(parent_run_id) WHERE parent_run_id IS NOT NULL;
```

- [ ] **Step 2: Apply the migration**

```bash
cd /home/ellie/ellie-dev && psql -U ellie -d ellie-forest -f migrations/forest/20260403_dispatch_outcomes.sql
```

Expected: CREATE TABLE, CREATE INDEX (no errors).

- [ ] **Step 3: Verify the table exists**

```bash
psql -U ellie -d ellie-forest -c "\d dispatch_outcomes"
```

Expected: Table with all columns listed.

- [ ] **Step 4: Verify the stalled enum value**

```bash
psql -U ellie -d ellie-forest -c "SELECT unnest(enum_range(NULL::orchestration_event_type));"
```

Expected: 9 values including `stalled`.

- [ ] **Step 5: Commit**

```bash
git add migrations/forest/20260403_dispatch_outcomes.sql
git commit -m "[DISPATCH-P1] migration: dispatch_outcomes table + stalled event type"
```

---

### Task 2: Unified dispatch event types and emitter

**Files:**
- Create: `src/dispatch-events.ts`
- Create: `tests/dispatch-events.test.ts`
- Modify: `src/orchestration-ledger.ts:84-92`

- [ ] **Step 1: Add `"stalled"` to OrchestrationEventType**

In `/home/ellie/ellie-dev/src/orchestration-ledger.ts`, change lines 84-92:

```typescript
export type OrchestrationEventType =
  | "dispatched"
  | "heartbeat"
  | "progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "retried"
  | "timeout"
  | "stalled";
```

Also add `"stalled"` is NOT a terminal event — do NOT add it to `TERMINAL_EVENTS` on line 104. Stalled dispatches can still complete.

- [ ] **Step 2: Write the test file**

Create `/home/ellie/ellie-dev/tests/dispatch-events.test.ts`:

```typescript
/**
 * Dispatch events — unified event emitter + WebSocket broadcaster
 * ELLIE-1308
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// Mock dependencies
mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: mock(), warn: mock(), error: mock(), debug: mock() }) },
}));

const mockEmitEvent = mock(() => {});
mock.module("../src/orchestration-ledger.ts", () => ({
  emitEvent: mockEmitEvent,
}));

const mockBroadcast = mock(() => {});
mock.module("../src/relay-state.ts", () => ({
  broadcastToEllieChatClients: mockBroadcast,
  broadcastDispatchEvent: mockBroadcast,
}));

import {
  emitDispatchEvent,
  buildDispatchWebSocketPayload,
  type DispatchEventPayload,
} from "../src/dispatch-events.ts";

describe("dispatch-events", () => {
  beforeEach(() => {
    mockEmitEvent.mockClear();
    mockBroadcast.mockClear();
  });

  test("emitDispatchEvent writes to ledger and broadcasts to WebSocket", () => {
    emitDispatchEvent("run_123", "dispatched", {
      agent: "james",
      title: "Implement v2 API",
      work_item_id: "ELLIE-500",
      dispatch_type: "single",
    });

    expect(mockEmitEvent).toHaveBeenCalledTimes(1);
    const [runId, eventType, agentType, workItemId, payload] = mockEmitEvent.mock.calls[0];
    expect(runId).toBe("run_123");
    expect(eventType).toBe("dispatched");
    expect(agentType).toBe("james");
    expect(workItemId).toBe("ELLIE-500");
    expect(payload.agent).toBe("james");
    expect(payload.title).toBe("Implement v2 API");
    expect(payload.dispatch_type).toBe("single");

    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    const wsPayload = mockBroadcast.mock.calls[0][0];
    expect(wsPayload.type).toBe("dispatch_event");
    expect(wsPayload.run_id).toBe("run_123");
    expect(wsPayload.agent).toBe("james");
  });

  test("emitDispatchEvent includes progress_line when provided", () => {
    emitDispatchEvent("run_123", "progress", {
      agent: "james",
      title: "Implement v2 API",
      progress_line: "Running 12 tests...",
      dispatch_type: "single",
    });

    const payload = mockEmitEvent.mock.calls[0][4];
    expect(payload.progress_line).toBe("Running 12 tests...");
  });

  test("emitDispatchEvent includes terminal event fields", () => {
    emitDispatchEvent("run_123", "completed", {
      agent: "james",
      title: "Implement v2 API",
      dispatch_type: "single",
      duration_ms: 45000,
      cost_usd: 0.12,
    });

    const wsPayload = mockBroadcast.mock.calls[0][0];
    expect(wsPayload.duration_ms).toBe(45000);
    expect(wsPayload.cost_usd).toBe(0.12);
  });

  test("buildDispatchWebSocketPayload maps event_type to status correctly", () => {
    const dispatched = buildDispatchWebSocketPayload("run_1", "dispatched", { agent: "james", title: "test", dispatch_type: "single" });
    expect(dispatched.status).toBe("dispatched");

    const progress = buildDispatchWebSocketPayload("run_1", "progress", { agent: "james", title: "test", dispatch_type: "single" });
    expect(progress.status).toBe("in_progress");

    const completed = buildDispatchWebSocketPayload("run_1", "completed", { agent: "james", title: "test", dispatch_type: "single" });
    expect(completed.status).toBe("done");

    const failed = buildDispatchWebSocketPayload("run_1", "failed", { agent: "james", title: "test", dispatch_type: "single" });
    expect(failed.status).toBe("failed");

    const stalled = buildDispatchWebSocketPayload("run_1", "stalled", { agent: "james", title: "test", dispatch_type: "single" });
    expect(stalled.status).toBe("stalled");

    const cancelled = buildDispatchWebSocketPayload("run_1", "cancelled", { agent: "james", title: "test", dispatch_type: "single" });
    expect(cancelled.status).toBe("cancelled");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd /home/ellie/ellie-dev && bun test tests/dispatch-events.test.ts
```

Expected: FAIL — `dispatch-events.ts` doesn't exist yet.

- [ ] **Step 4: Implement dispatch-events.ts**

Create `/home/ellie/ellie-dev/src/dispatch-events.ts`:

```typescript
/**
 * Unified Dispatch Events — ELLIE-1308
 *
 * Single entry point for emitting dispatch lifecycle events.
 * Writes to the Forest DB orchestration ledger AND broadcasts
 * to Ellie Chat WebSocket clients as `dispatch_event` messages.
 *
 * Replaces direct calls to emitEvent + broadcastDispatchEvent
 * with a unified function that does both.
 */

import { log } from "./logger.ts";
import { emitEvent, type OrchestrationEventType } from "./orchestration-ledger.ts";
import { broadcastDispatchEvent } from "./relay-state.ts";

const logger = log.child("dispatch-events");

// ── Types ──────────────────────────────────────────────────

export interface DispatchEventPayload {
  agent: string;
  title: string;
  work_item_id?: string | null;
  progress_line?: string | null;
  dispatch_type: "single" | "formation" | "round_table" | "delegation";
  /** Only on terminal events */
  duration_ms?: number;
  /** Only on terminal events — estimate, not invoiced */
  cost_usd?: number;
}

export type DispatchStatus =
  | "dispatched"
  | "in_progress"
  | "done"
  | "failed"
  | "stalled"
  | "cancelled";

// ── Status mapping ─────────────────────────────────────────

const EVENT_TO_STATUS: Record<string, DispatchStatus> = {
  dispatched: "dispatched",
  heartbeat: "in_progress",
  progress: "in_progress",
  completed: "done",
  failed: "failed",
  cancelled: "cancelled",
  retried: "in_progress",
  timeout: "failed",
  stalled: "stalled",
};

// ── WebSocket payload builder ──────────────────────────────

export function buildDispatchWebSocketPayload(
  runId: string,
  eventType: OrchestrationEventType,
  payload: DispatchEventPayload,
): Record<string, unknown> {
  return {
    type: "dispatch_event",
    run_id: runId,
    event_type: eventType,
    agent: payload.agent,
    title: payload.title,
    work_item_id: payload.work_item_id ?? null,
    progress_line: payload.progress_line ?? null,
    dispatch_type: payload.dispatch_type,
    status: EVENT_TO_STATUS[eventType] ?? "in_progress",
    timestamp: Date.now(),
    ...(payload.duration_ms != null ? { duration_ms: payload.duration_ms } : {}),
    ...(payload.cost_usd != null ? { cost_usd: payload.cost_usd } : {}),
  };
}

// ── Unified emitter ────────────────────────────────────────

/**
 * Emit a dispatch lifecycle event. Writes to Forest DB ledger first,
 * then broadcasts to Ellie Chat WebSocket. DB-first — if WebSocket
 * broadcast fails, the event is still persisted.
 */
export function emitDispatchEvent(
  runId: string,
  eventType: OrchestrationEventType,
  payload: DispatchEventPayload,
): void {
  // 1. Write to Forest DB ledger (fire-and-forget, resilient for terminal events)
  emitEvent(
    runId,
    eventType,
    payload.agent,
    payload.work_item_id ?? null,
    {
      agent: payload.agent,
      title: payload.title,
      work_item_id: payload.work_item_id ?? null,
      progress_line: payload.progress_line ?? null,
      dispatch_type: payload.dispatch_type,
      ...(payload.duration_ms != null ? { duration_ms: payload.duration_ms } : {}),
      ...(payload.cost_usd != null ? { cost_usd: payload.cost_usd } : {}),
    },
  );

  // 2. Broadcast to Ellie Chat WebSocket (best-effort)
  try {
    const wsPayload = buildDispatchWebSocketPayload(runId, eventType, payload);
    broadcastDispatchEvent(wsPayload);
  } catch (err) {
    logger.warn("WebSocket broadcast failed", { runId, eventType, error: err instanceof Error ? err.message : String(err) });
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd /home/ellie/ellie-dev && bun test tests/dispatch-events.test.ts
```

Expected: 6 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add src/dispatch-events.ts src/orchestration-ledger.ts tests/dispatch-events.test.ts
git commit -m "[DISPATCH-P1] feat: unified dispatch event emitter with WebSocket broadcast (ELLIE-1308)"
```

---

### Task 3: Dispatch outcome storage

**Files:**
- Create: `src/dispatch-outcomes.ts`
- Create: `tests/dispatch-outcomes.test.ts`

- [ ] **Step 1: Write the test file**

Create `/home/ellie/ellie-dev/tests/dispatch-outcomes.test.ts`:

```typescript
/**
 * Dispatch outcomes — storage and retrieval
 * ELLIE-1309
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// Mock Forest DB
const mockInsert = mock(async () => [{ id: "test-uuid" }]);
const mockSelect = mock(async () => []);
const mockDelete = mock(async () => []);

const mockSql = Object.assign(
  mock((..._args: unknown[]) => mockSelect()),
  { unsafe: mock((..._args: unknown[]) => mockSelect()) },
);

mock.module("../../ellie-forest/src/db", () => ({ default: mockSql }));
mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: mock(), warn: mock(), error: mock(), debug: mock() }) },
}));

import {
  writeOutcome,
  readOutcome,
  type DispatchOutcome,
} from "../src/dispatch-outcomes.ts";

describe("dispatch-outcomes", () => {
  beforeEach(() => {
    mockSql.mockClear();
  });

  test("writeOutcome inserts a row with all fields", async () => {
    const outcome: DispatchOutcome = {
      run_id: "run_123",
      agent: "james",
      work_item_id: "ELLIE-500",
      dispatch_type: "single",
      status: "completed",
      summary: "Implemented the v2 API endpoint",
      files_changed: ["src/api/v2.ts", "tests/api/v2.test.ts"],
      decisions: ["Used Express router over Hono"],
      commits: ["abc123"],
      forest_writes: ["mem_456"],
      duration_ms: 45000,
      tokens_in: 12000,
      tokens_out: 3000,
      cost_usd: 0.12,
    };

    await writeOutcome(outcome);
    expect(mockSql).toHaveBeenCalled();
  });

  test("writeOutcome handles missing optional fields", async () => {
    const outcome: DispatchOutcome = {
      run_id: "run_456",
      agent: "kate",
      dispatch_type: "single",
      status: "completed",
    };

    await writeOutcome(outcome);
    expect(mockSql).toHaveBeenCalled();
  });

  test("readOutcome returns null for unknown run_id", async () => {
    mockSql.mockImplementationOnce(async () => []);
    const result = await readOutcome("nonexistent");
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /home/ellie/ellie-dev && bun test tests/dispatch-outcomes.test.ts
```

Expected: FAIL — `dispatch-outcomes.ts` doesn't exist yet.

- [ ] **Step 3: Implement dispatch-outcomes.ts**

Create `/home/ellie/ellie-dev/src/dispatch-outcomes.ts`:

```typescript
/**
 * Dispatch Outcomes — ELLIE-1309
 *
 * Stores and retrieves structured summaries of completed dispatches.
 * Data source for the drill-down view (Phase 4) and conflict detection (Phase 5).
 *
 * Specialists report outcome data via working memory sections:
 * - investigation_state → progress
 * - decision_log → decisions
 * - context_anchors → file paths, commit SHAs
 *
 * The coordinator reads these after dispatch and calls writeOutcome().
 */

import { log } from "./logger.ts";

const logger = log.child("dispatch-outcomes");

// Lazy Forest DB (same pattern as orchestration-ledger.ts)
let _sql: ReturnType<typeof import("postgres").default> | null = null;

async function getSql() {
  if (_sql) return _sql;
  const mod = await import("../../ellie-forest/src/db");
  _sql = mod.default;
  return _sql;
}

// ── Types ──────────────────────────────────────────────────

export interface DispatchOutcome {
  run_id: string;
  parent_run_id?: string | null;
  agent: string;
  work_item_id?: string | null;
  dispatch_type: "single" | "formation" | "round_table" | "delegation";
  status: string;
  summary?: string | null;
  files_changed?: string[];
  decisions?: string[];
  commits?: string[];
  forest_writes?: string[];
  duration_ms?: number | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  cost_usd?: number | null;
}

export interface DispatchOutcomeRow extends DispatchOutcome {
  id: string;
  created_at: string;
}

// ── Write ──────────────────────────────────────────────────

export async function writeOutcome(outcome: DispatchOutcome): Promise<void> {
  try {
    const sql = await getSql();
    await sql`
      INSERT INTO dispatch_outcomes (
        run_id, parent_run_id, agent, work_item_id, dispatch_type,
        status, summary, files_changed, decisions, commits,
        forest_writes, duration_ms, tokens_in, tokens_out, cost_usd
      ) VALUES (
        ${outcome.run_id},
        ${outcome.parent_run_id ?? null},
        ${outcome.agent},
        ${outcome.work_item_id ?? null},
        ${outcome.dispatch_type},
        ${outcome.status},
        ${outcome.summary ?? null},
        ${outcome.files_changed ?? []},
        ${outcome.decisions ?? []},
        ${outcome.commits ?? []},
        ${outcome.forest_writes ?? []},
        ${outcome.duration_ms ?? null},
        ${outcome.tokens_in ?? null},
        ${outcome.tokens_out ?? null},
        ${outcome.cost_usd ?? null}
      )
      ON CONFLICT (run_id) DO UPDATE SET
        status = EXCLUDED.status,
        summary = EXCLUDED.summary,
        files_changed = EXCLUDED.files_changed,
        decisions = EXCLUDED.decisions,
        commits = EXCLUDED.commits,
        forest_writes = EXCLUDED.forest_writes,
        duration_ms = EXCLUDED.duration_ms,
        tokens_in = EXCLUDED.tokens_in,
        tokens_out = EXCLUDED.tokens_out,
        cost_usd = EXCLUDED.cost_usd
    `;
    logger.info("Outcome written", { run_id: outcome.run_id, agent: outcome.agent, status: outcome.status });
  } catch (err) {
    logger.error("Failed to write outcome", { run_id: outcome.run_id, error: err instanceof Error ? err.message : String(err) });
  }
}

// ── Read ───────────────────────────────────────────────────

export async function readOutcome(runId: string): Promise<DispatchOutcomeRow | null> {
  try {
    const sql = await getSql();
    const rows = await sql`
      SELECT * FROM dispatch_outcomes WHERE run_id = ${runId}
    `;
    if (rows.length === 0) return null;
    return rows[0] as unknown as DispatchOutcomeRow;
  } catch (err) {
    logger.error("Failed to read outcome", { run_id: runId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Read outcome + child participants for formations/round tables */
export async function readOutcomeWithParticipants(runId: string): Promise<{
  outcome: DispatchOutcomeRow;
  participants: DispatchOutcomeRow[];
} | null> {
  try {
    const sql = await getSql();
    const [outcome] = await sql`
      SELECT * FROM dispatch_outcomes WHERE run_id = ${runId}
    `;
    if (!outcome) return null;

    const participants = await sql`
      SELECT * FROM dispatch_outcomes
      WHERE parent_run_id = ${runId}
      ORDER BY created_at ASC
    `;

    return {
      outcome: outcome as unknown as DispatchOutcomeRow,
      participants: participants as unknown as DispatchOutcomeRow[],
    };
  } catch (err) {
    logger.error("Failed to read outcome with participants", { run_id: runId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Get recent outcomes for the morning dashboard view */
export async function getRecentOutcomes(hours = 24, limit = 50): Promise<DispatchOutcomeRow[]> {
  try {
    const sql = await getSql();
    const rows = await sql`
      SELECT * FROM dispatch_outcomes
      WHERE created_at > NOW() - INTERVAL '1 hour' * ${hours}
        AND parent_run_id IS NULL
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows as unknown as DispatchOutcomeRow[];
  } catch (err) {
    logger.error("Failed to get recent outcomes", { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /home/ellie/ellie-dev && bun test tests/dispatch-outcomes.test.ts
```

Expected: 3 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/dispatch-outcomes.ts tests/dispatch-outcomes.test.ts
git commit -m "[DISPATCH-P1] feat: dispatch outcome storage with read/write/participants (ELLIE-1309)"
```

---

### Task 4: Progress reporter

**Files:**
- Create: `src/progress-reporter.ts`
- Create: `tests/progress-reporter.test.ts`

- [ ] **Step 1: Write the test file**

Create `/home/ellie/ellie-dev/tests/progress-reporter.test.ts`:

```typescript
/**
 * Progress reporter — extracts progress from working memory
 * ELLIE-1311
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: mock(), warn: mock(), error: mock(), debug: mock() }) },
}));

const mockEmitDispatchEvent = mock(() => {});
mock.module("../src/dispatch-events.ts", () => ({
  emitDispatchEvent: mockEmitDispatchEvent,
}));

import { reportProgress, extractProgressLine } from "../src/progress-reporter.ts";

describe("progress-reporter", () => {
  beforeEach(() => {
    mockEmitDispatchEvent.mockClear();
  });

  test("reportProgress emits a progress event", () => {
    reportProgress("run_123", "james", "Implement v2 API", "Reading schema files...");

    expect(mockEmitDispatchEvent).toHaveBeenCalledTimes(1);
    const [runId, eventType, payload] = mockEmitDispatchEvent.mock.calls[0];
    expect(runId).toBe("run_123");
    expect(eventType).toBe("progress");
    expect(payload.agent).toBe("james");
    expect(payload.progress_line).toBe("Reading schema files...");
  });

  test("reportProgress truncates long progress lines to 100 chars", () => {
    const longLine = "A".repeat(200);
    reportProgress("run_123", "james", "test", longLine);

    const payload = mockEmitDispatchEvent.mock.calls[0][2];
    expect(payload.progress_line.length).toBeLessThanOrEqual(103); // 100 + "..."
  });

  test("extractProgressLine extracts last meaningful line from investigation_state", () => {
    const state = `Looking at src/relay.ts for the startup sequence.
Found the HTTP server setup on line 475.
Writing new endpoint handler...`;

    const line = extractProgressLine(state);
    expect(line).toBe("Writing new endpoint handler...");
  });

  test("extractProgressLine returns null for empty state", () => {
    expect(extractProgressLine("")).toBeNull();
    expect(extractProgressLine(null as unknown as string)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /home/ellie/ellie-dev && bun test tests/progress-reporter.test.ts
```

Expected: FAIL — `progress-reporter.ts` doesn't exist yet.

- [ ] **Step 3: Implement progress-reporter.ts**

Create `/home/ellie/ellie-dev/src/progress-reporter.ts`:

```typescript
/**
 * Progress Reporter — ELLIE-1311
 *
 * Emits progress events for running dispatches. The coordinator calls
 * reportProgress() after reading a specialist's working memory.
 *
 * Progress lines are short (max 100 chars), human-readable, present-tense:
 * - "Reading schema files..."
 * - "Running 12 tests — 8 passed so far"
 * - "Committed: add v2 auth endpoint"
 */

import { log } from "./logger.ts";
import { emitDispatchEvent } from "./dispatch-events.ts";

const logger = log.child("progress-reporter");

const MAX_PROGRESS_LINE_LENGTH = 100;

/**
 * Emit a progress event for a running dispatch.
 */
export function reportProgress(
  runId: string,
  agent: string,
  title: string,
  progressLine: string,
  workItemId?: string | null,
): void {
  const truncated = progressLine.length > MAX_PROGRESS_LINE_LENGTH
    ? progressLine.slice(0, MAX_PROGRESS_LINE_LENGTH) + "..."
    : progressLine;

  emitDispatchEvent(runId, "progress", {
    agent,
    title,
    progress_line: truncated,
    work_item_id: workItemId,
    dispatch_type: "single", // progress events don't change dispatch type
  });

  logger.debug("Progress reported", { runId: runId.slice(0, 8), agent, line: truncated });
}

/**
 * Extract the last meaningful line from a specialist's investigation_state
 * working memory section. Returns null if empty or unparseable.
 */
export function extractProgressLine(investigationState: string): string | null {
  if (!investigationState) return null;

  const lines = investigationState
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("---"));

  if (lines.length === 0) return null;

  // Return the last non-empty line — most recent progress
  return lines[lines.length - 1];
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /home/ellie/ellie-dev && bun test tests/progress-reporter.test.ts
```

Expected: 4 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/progress-reporter.ts tests/progress-reporter.test.ts
git commit -m "[DISPATCH-P1] feat: progress reporter with working memory extraction (ELLIE-1311)"
```

---

### Task 5: Wire stall detection to emit unified events

**Files:**
- Modify: `src/orchestration-monitor.ts`

- [ ] **Step 1: Read the orchestration monitor's stall detection logic**

Read `/home/ellie/ellie-dev/src/orchestration-monitor.ts` to find the `checkForStalledTasks()` function and understand where stalls are detected and escalated.

- [ ] **Step 2: Import emitDispatchEvent and wire stall emission**

At the top of `orchestration-monitor.ts`, add the import:

```typescript
import { emitDispatchEvent } from "./dispatch-events.ts";
```

Then find the code path where a stalled task is detected (where it calls `_notifyFn` to escalate to Dave). Before or alongside the notification call, add:

```typescript
// Emit unified stalled event for dashboard cards
emitDispatchEvent(runId, "stalled", {
  agent: task.assigned_agent || "unknown",
  title: task.content?.slice(0, 200) || "Unknown task",
  work_item_id: task.metadata?.work_item_id as string || null,
  dispatch_type: "single",
});
```

The exact location depends on the code structure — the implementer should read the file and find where stalls are detected. The `runId` comes from the task's `dispatch_envelope_id` or a related field. If no `run_id` is available from the GTD task, use the task ID as a fallback.

- [ ] **Step 3: Run existing monitor tests to verify no regression**

```bash
cd /home/ellie/ellie-dev && bun test tests/orchestration-*.test.ts
```

Expected: All existing tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/orchestration-monitor.ts
git commit -m "[DISPATCH-P1] feat: wire stall detection to emit unified dispatch events (ELLIE-1310)"
```

---

### Task 6: Wire coordinator to emit unified events + write outcomes

**Files:**
- Modify: `src/coordinator.ts`

This is the integration task — connecting the new modules to the coordinator's dispatch flow.

- [ ] **Step 1: Add imports to coordinator.ts**

At the top of `/home/ellie/ellie-dev/src/coordinator.ts`, add:

```typescript
import { emitDispatchEvent } from "./dispatch-events.ts";
import { writeOutcome } from "./dispatch-outcomes.ts";
import { reportProgress, extractProgressLine } from "./progress-reporter.ts";
```

- [ ] **Step 2: Emit `dispatched` event when specialist is dispatched**

In the `dispatchCalls` handler (around line 528), after the existing `spawn_status` event, add a unified event emission:

```typescript
        // Unified dispatch event (ELLIE-1308)
        emitDispatchEvent(specEnvelope.id, "dispatched", {
          agent: input.agent,
          title: input.task.slice(0, 200),
          work_item_id: workItemId,
          dispatch_type: "single",
        });
```

Keep the existing `spawn_status` for backward compatibility.

- [ ] **Step 3: Emit `completed`/`failed` event and write outcome on dispatch completion**

After the existing `spawn_announcement` event (around line 600-614), add:

```typescript
            // Unified dispatch event (ELLIE-1308)
            emitDispatchEvent(specEnvelope.id, specResult.status === "error" ? "failed" : "completed", {
              agent: input.agent,
              title: input.task.slice(0, 200),
              work_item_id: workItemId,
              dispatch_type: "single",
              duration_ms: specResult.duration_ms,
              cost_usd: completed.cost_usd,
            });

            // Write dispatch outcome (ELLIE-1309)
            writeOutcome({
              run_id: specEnvelope.id,
              agent: input.agent,
              work_item_id: workItemId,
              dispatch_type: "single",
              status: specResult.status === "error" ? "failed" : "completed",
              summary: specResult.output?.slice(0, 1000) || null,
              duration_ms: specResult.duration_ms,
              tokens_in: specResult.tokens_used,
              tokens_out: 0,
              cost_usd: completed.cost_usd,
            });
```

Note: Outcome `files_changed`, `decisions`, `commits`, and `forest_writes` are populated later by reading the specialist's working memory. For this initial wiring, we write the basic outcome and the coordinator can enrich it in a follow-up iteration by reading working memory after dispatch.

- [ ] **Step 4: Run coordinator tests**

```bash
cd /home/ellie/ellie-dev && bun test tests/coordinator.test.ts
```

Expected: All existing tests pass (the new imports are fire-and-forget, shouldn't break existing behavior).

- [ ] **Step 5: Commit**

```bash
git add src/coordinator.ts
git commit -m "[DISPATCH-P1] feat: wire coordinator to emit unified events + write outcomes (ELLIE-1308, 1309)"
```

---

### Task 7: Outcome API endpoint

**Files:**
- Modify: `src/http-routes.ts`

- [ ] **Step 1: Add the outcome API route**

In `/home/ellie/ellie-dev/src/http-routes.ts`, find the dispatch-related API routes (search for `/api/dispatches/`). Add a new route:

```typescript
  // GET /api/dispatches/:run_id/outcome — ELLIE-1321
  if (method === "GET" && pathname.match(/^\/api\/dispatches\/[^/]+\/outcome$/)) {
    const runId = pathname.split("/")[3];
    const bridgeKey = headers.get("x-bridge-key");
    if (!bridgeKey || !isValidBridgeKey(bridgeKey)) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    const { readOutcomeWithParticipants } = await import("./dispatch-outcomes.ts");
    const result = await readOutcomeWithParticipants(runId);
    if (!result) return jsonResponse({ error: "Outcome not found" }, 404);
    return jsonResponse({
      ...result.outcome,
      participants: result.participants.length > 0 ? result.participants : undefined,
    });
  }
```

The `isValidBridgeKey` and `jsonResponse` functions should already exist in the file — use whatever patterns the existing dispatch routes use for auth and response formatting.

- [ ] **Step 2: Run a quick smoke test**

After restarting the relay, test the endpoint:

```bash
curl -s http://localhost:3001/api/dispatches/nonexistent/outcome \
  -H "x-bridge-key: bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a" | head -1
```

Expected: `{"error":"Outcome not found"}` (404).

- [ ] **Step 3: Commit**

```bash
git add src/http-routes.ts
git commit -m "[DISPATCH-P1] feat: GET /api/dispatches/:run_id/outcome endpoint (ELLIE-1321)"
```

---

### Task 8: Backward-compatible WebSocket emission

**Files:**
- Modify: `src/coordinator.ts`

The spec requires keeping `spawn_status` and `spawn_announcement` alongside the new `dispatch_event` until the dashboard migrates. This is already the case from Task 6 — we added the new events without removing the old ones.

- [ ] **Step 1: Verify both old and new events are emitted**

Read the coordinator.ts dispatch section and confirm:
- `spawn_status` (line ~531) still fires on dispatch start
- `spawn_announcement` (line ~603) still fires on dispatch completion
- `dispatch_event` (Task 6 additions) also fires for both

- [ ] **Step 2: Add a comment marking the old events for removal**

Add a comment above each `spawn_status` and `spawn_announcement` emission:

```typescript
        // DEPRECATED: Remove after dashboard migrates to dispatch_event (ELLIE-1308)
```

- [ ] **Step 3: Commit**

```bash
git add src/coordinator.ts
git commit -m "[DISPATCH-P1] chore: mark spawn_status/announcement as deprecated (ELLIE-1308)"
```

---

### Task 9: Run full test suite and verify

- [ ] **Step 1: Run all new tests**

```bash
cd /home/ellie/ellie-dev && bun test tests/dispatch-events.test.ts tests/dispatch-outcomes.test.ts tests/progress-reporter.test.ts
```

Expected: All pass.

- [ ] **Step 2: Run coordinator tests**

```bash
bun test tests/coordinator.test.ts tests/coordinator-tools.test.ts tests/coordinator-context.test.ts
```

Expected: All existing tests pass.

- [ ] **Step 3: Run orchestration tests**

```bash
bun test tests/orchestration-dispatch.test.ts tests/orchestration-tracker.test.ts
```

Expected: All existing tests pass.

- [ ] **Step 4: Restart the relay**

```bash
systemctl --user restart ellie-chat-relay
```

- [ ] **Step 5: Verify health**

```bash
curl -s http://localhost:3001/health | python3 -c "import sys,json; d=json.load(sys.stdin); print('Status:', d['status'])"
```

Expected: `Status: ok` (after health check interval runs).

- [ ] **Step 6: Verify dispatch_outcomes table is accessible**

```bash
psql -U ellie -d ellie-forest -c "SELECT count(*) FROM dispatch_outcomes;"
```

Expected: `0` (no outcomes yet — they'll populate on next dispatch).

- [ ] **Step 7: Final commit**

```bash
git add docs/superpowers/plans/2026-04-03-dispatch-observability-phase1.md
git commit -m "[DISPATCH-P1] complete: Phase 1 dispatch event layer"
```
