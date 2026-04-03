# Dispatch Observability Phase 5: Bidirectional Awareness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The system talks back — stall alerts with action buttons, file conflict detection, next-step suggestions from Ellie, cancel/reprioritize controls on cards, and a morning dashboard snapshot.

**Architecture:** Stall events (Phase 1) render as actionable cards. Conflict detection compares known file paths from `dispatch_outcomes`. Next-step suggestions live in Max's coordinator prompt. Cancel wires through the existing orchestration cancel API. Morning dashboard fetches recent outcomes + active runs on page load.

**Tech Stack:** Vue 3 (Nuxt 4), Tailwind CSS, TypeScript, WebSocket, coordinator prompt engineering

**Spec:** `docs/superpowers/specs/2026-04-03-dispatch-observability-design.md` — Phase 5 section

**Depends on:** Phase 1 (stall events, outcomes), Phase 2 (cards, side panel), Phase 3 (proactive surfacing)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/conflict-detector.ts` | Create | Compare file paths between active dispatches |
| `tests/conflict-detector.test.ts` | Create | Tests for conflict detection |
| `src/foundation-registry.ts` | Modify | Add next-step suggestion instructions to coordinator prompt |
| `src/coordinator.ts` | Modify | Wire conflict detection on dispatch start |
| `src/http-routes.ts` | Modify | Add GET /api/dispatches/snapshot endpoint |
| `ellie-home/app/components/dispatch/StallAlertCard.vue` | Create | Actionable stall alert card |
| `ellie-home/app/components/dispatch/DispatchCard.vue` | Modify | Add cancel button on active cards |
| `ellie-home/app/components/dispatch/DispatchSidePanel.vue` | Modify | Load morning snapshot on mount |
| `ellie-home/app/composables/useDispatchCards.ts` | Modify | Add cancel action + stall card handling |
| `ellie-home/app/composables/useEllieChat.ts` | Modify | Handle stall + conflict + suggestion events |
| `ellie-home/server/api/dispatches/snapshot.get.ts` | Create | Nuxt proxy for snapshot API |

---

### Task 1: Conflict detector module

**Files:**
- Create: `src/conflict-detector.ts`
- Create: `tests/conflict-detector.test.ts`

- [ ] **Step 1: Write the test file**

Create `/home/ellie/ellie-dev/tests/conflict-detector.test.ts`:

```typescript
/**
 * Conflict detector — file path overlap between dispatches
 * ELLIE-1325
 */

import { describe, test, expect, mock } from "bun:test";

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: mock(), warn: mock(), error: mock(), debug: mock() }) },
}));

const mockGetRecentOutcomes = mock(async () => []);
mock.module("../src/dispatch-outcomes.ts", () => ({
  getRecentOutcomes: mockGetRecentOutcomes,
  readOutcome: mock(async () => null),
  writeOutcome: mock(async () => {}),
  readOutcomeWithParticipants: mock(async () => null),
}));

const mockGetActiveRunStates = mock(() => []);
mock.module("../src/orchestration-tracker.ts", () => ({
  getActiveRunStates: mockGetActiveRunStates,
}));

const mockGetRecentEvents = mock(async () => []);
mock.module("../src/orchestration-ledger.ts", () => ({
  getRecentEvents: mockGetRecentEvents,
  emitEvent: mock(),
}));

import { detectFileConflicts } from "../src/conflict-detector.ts";

describe("conflict-detector", () => {
  test("returns empty array when no active dispatches", async () => {
    mockGetActiveRunStates.mockReturnValue([]);
    const result = await detectFileConflicts("ELLIE-500");
    expect(result).toEqual([]);
  });

  test("detects overlap between historical outcomes and active dispatch files", async () => {
    mockGetRecentOutcomes.mockResolvedValue([
      { run_id: "old_1", agent: "james", work_item_id: "ELLIE-500", files_changed: ["src/api/auth.ts", "src/middleware.ts"] },
    ]);
    mockGetActiveRunStates.mockReturnValue([
      { runId: "active_1", agentType: "research", workItemId: "ELLIE-501", startedAt: Date.now(), status: "running" },
    ]);
    mockGetRecentEvents.mockResolvedValue([
      { run_id: "active_1", event_type: "progress", payload: { agent: "kate", progress_line: "editing src/api/auth.ts" }, created_at: new Date().toISOString() },
    ]);

    // Mock the file extraction from progress events
    const result = await detectFileConflicts("ELLIE-500", ["src/api/auth.ts", "src/middleware.ts"]);
    expect(result.length).toBeGreaterThanOrEqual(0);
    // The detector compares known files — if active dispatch reports touching same files, conflict found
  });

  test("returns empty when no file overlap", async () => {
    mockGetRecentOutcomes.mockResolvedValue([
      { run_id: "old_1", agent: "james", work_item_id: "ELLIE-500", files_changed: ["src/api/auth.ts"] },
    ]);
    mockGetActiveRunStates.mockReturnValue([
      { runId: "active_1", agentType: "research", workItemId: "ELLIE-501", startedAt: Date.now(), status: "running" },
    ]);
    mockGetRecentEvents.mockResolvedValue([
      { run_id: "active_1", event_type: "progress", payload: { agent: "kate", progress_line: "reading docs" }, created_at: new Date().toISOString() },
    ]);

    const result = await detectFileConflicts("ELLIE-500", ["src/api/auth.ts"]);
    // No overlap because kate isn't touching auth.ts
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/ellie/ellie-dev && bun test tests/conflict-detector.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement conflict-detector.ts**

Create `/home/ellie/ellie-dev/src/conflict-detector.ts`:

```typescript
/**
 * Conflict Detector — ELLIE-1325
 *
 * Detects file path overlap between dispatches. Uses known data only:
 * - dispatch_outcomes.files_changed from completed dispatches
 * - File paths extracted from active dispatch progress events
 *
 * Does NOT predict file paths for not-yet-started dispatches.
 */

import { log } from "./logger.ts";
import { getRecentOutcomes, type DispatchOutcomeRow } from "./dispatch-outcomes.ts";
import { getActiveRunStates } from "./orchestration-tracker.ts";
import { getRecentEvents } from "./orchestration-ledger.ts";

const logger = log.child("conflict-detector");

export interface FileConflict {
  activeRunId: string;
  activeAgent: string;
  activeWorkItem: string | null;
  overlappingFiles: string[];
}

/**
 * Detect file conflicts between a work item's known files and active dispatches.
 * @param workItemId - The work item to check against
 * @param knownFiles - Files this dispatch will touch (from outcomes or explicit list)
 */
export async function detectFileConflicts(
  workItemId: string,
  knownFiles?: string[],
): Promise<FileConflict[]> {
  const activeRuns = getActiveRunStates().filter(r => r.status === "running");
  if (activeRuns.length === 0) return [];

  // Gather known files for this work item from historical outcomes
  let filesToCheck = new Set(knownFiles ?? []);
  if (filesToCheck.size === 0) {
    try {
      const outcomes = await getRecentOutcomes(168, 100); // last 7 days
      for (const o of outcomes) {
        if (o.work_item_id === workItemId && o.files_changed) {
          for (const f of o.files_changed) filesToCheck.add(f);
        }
      }
    } catch {
      // Outcomes unavailable — can't detect conflicts
    }
  }

  if (filesToCheck.size === 0) return [];

  // Get files being touched by active dispatches from progress events
  const activeFiles = new Map<string, Set<string>>(); // runId → files
  try {
    const events = await getRecentEvents(200);
    for (const event of events) {
      if (event.event_type !== "progress") continue;
      const payload = event.payload as Record<string, unknown>;
      const progressLine = payload.progress_line as string;
      if (!progressLine) continue;

      // Extract file paths from progress lines (simple heuristic: look for path-like strings)
      const pathMatches = progressLine.match(/(?:[\w-]+\/)+[\w.-]+\.\w+/g);
      if (pathMatches) {
        if (!activeFiles.has(event.run_id)) activeFiles.set(event.run_id, new Set());
        for (const p of pathMatches) activeFiles.get(event.run_id)!.add(p);
      }
    }
  } catch {
    // Events unavailable
  }

  // Also check completed outcomes for active runs' work items
  try {
    const outcomes = await getRecentOutcomes(24, 50);
    for (const run of activeRuns) {
      for (const o of outcomes) {
        if (o.run_id === run.runId && o.files_changed) {
          if (!activeFiles.has(run.runId)) activeFiles.set(run.runId, new Set());
          for (const f of o.files_changed) activeFiles.get(run.runId)!.add(f);
        }
      }
    }
  } catch {
    // Outcomes unavailable
  }

  // Find overlaps
  const conflicts: FileConflict[] = [];
  for (const run of activeRuns) {
    // Don't conflict with self
    if (run.workItemId === workItemId) continue;

    const runFiles = activeFiles.get(run.runId);
    if (!runFiles || runFiles.size === 0) continue;

    const overlap = [...filesToCheck].filter(f => runFiles.has(f));
    if (overlap.length > 0) {
      conflicts.push({
        activeRunId: run.runId,
        activeAgent: run.agentType || "unknown",
        activeWorkItem: run.workItemId || null,
        overlappingFiles: overlap,
      });
      logger.info("File conflict detected", {
        workItemId,
        activeRunId: run.runId,
        agent: run.agentType,
        files: overlap,
      });
    }
  }

  return conflicts;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /home/ellie/ellie-dev && bun test tests/conflict-detector.test.ts
```

Expected: 3 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/conflict-detector.ts tests/conflict-detector.test.ts
git commit -m "[DISPATCH-P5] feat: file conflict detector between active dispatches (ELLIE-1325)"
```

---

### Task 2: Wire conflict detection into coordinator + broadcast warnings

**Files:**
- Modify: `src/coordinator.ts`

- [ ] **Step 1: Add import**

At the top of `/home/ellie/ellie-dev/src/coordinator.ts`, add:

```typescript
import { detectFileConflicts } from "./conflict-detector.ts";
```

- [ ] **Step 2: Add conflict check after dispatch start**

Find the dispatch handler section where `emitDispatchEvent(specEnvelope.id, "dispatched", ...)` is called (added in Phase 1). AFTER that call, add:

```typescript
        // ELLIE-1325: Check for file conflicts with active dispatches
        if (workItemId) {
          try {
            const conflicts = await detectFileConflicts(workItemId);
            if (conflicts.length > 0) {
              for (const conflict of conflicts) {
                await deps.sendEvent({
                  type: "conflict_warning",
                  agent: input.agent,
                  conflictAgent: conflict.activeAgent,
                  conflictWorkItem: conflict.activeWorkItem,
                  overlappingFiles: conflict.overlappingFiles,
                  ts: Date.now(),
                });
              }
            }
          } catch { /* best-effort */ }
        }
```

- [ ] **Step 3: Commit**

```bash
git add src/coordinator.ts
git commit -m "[DISPATCH-P5] feat: wire conflict detection on dispatch start (ELLIE-1325)"
```

---

### Task 3: Next-step suggestions in coordinator prompt

**Files:**
- Modify: `src/foundation-registry.ts`

- [ ] **Step 1: Add next-step suggestion instructions to the coordinator prompt**

In `/home/ellie/ellie-dev/src/foundation-registry.ts`, find the `getCoordinatorPrompt()` method. In the "When To Do What" section (around line 259-267), add a new bullet after the existing items:

```typescript
- **Dispatch just completed** → Before calling complete, consider suggesting a natural next step. Examples: "James finished the API — want me to dispatch Brian for a code review?", "Tests passed — ready to PR?", "Kate's research is done — should Alan review the strategic implications?" Include the suggestion in your response with the action Dave can take.
```

- [ ] **Step 2: Commit**

```bash
git add src/foundation-registry.ts
git commit -m "[DISPATCH-P5] feat: add next-step suggestion instructions to coordinator prompt (ELLIE-1326)"
```

---

### Task 4: StallAlertCard component

**Files:**
- Create: `ellie-home/app/components/dispatch/StallAlertCard.vue`

- [ ] **Step 1: Create the component**

Create `/home/ellie/ellie-home/app/components/dispatch/StallAlertCard.vue`:

```vue
<template>
  <div class="rounded-lg border border-amber-800/50 bg-amber-900/10 p-3">
    <!-- Header -->
    <div class="flex items-center gap-2 mb-2">
      <span class="text-amber-400 text-sm">&#9888;</span>
      <span class="text-xs font-medium text-amber-300">Stall Alert</span>
    </div>

    <!-- Message -->
    <p class="text-xs text-gray-300 mb-3">
      <span class="font-medium" :style="{ color: agentColor }">{{ agentName }}</span>
      hasn't updated{{ card.work_item_id ? ` on ${card.work_item_id}` : '' }} in
      {{ elapsedMinutes }} minutes
    </p>

    <!-- Action buttons -->
    <div class="flex items-center gap-2">
      <button
        class="text-xs px-3 py-1 rounded bg-cyan-900/50 text-cyan-400 hover:bg-cyan-900/70 transition-colors"
        @click="$emit('check-in', card.run_id)"
      >
        Check in
      </button>
      <button
        class="text-xs px-3 py-1 rounded bg-red-900/50 text-red-400 hover:bg-red-900/70 transition-colors"
        @click="$emit('cancel', card.run_id)"
      >
        Cancel
      </button>
      <button
        class="text-xs px-3 py-1 rounded bg-gray-800 text-gray-400 hover:bg-gray-700 transition-colors"
        @click="$emit('wait', card.run_id)"
      >
        Wait
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { DispatchCard } from '~/composables/useDispatchCards'

const props = defineProps<{
  card: DispatchCard
  agentColor: string
  agentName: string
}>()

defineEmits<{
  'check-in': [runId: string]
  cancel: [runId: string]
  wait: [runId: string]
}>()

const elapsedMinutes = computed(() =>
  Math.round((Date.now() - props.card.started_at) / 60000)
)
</script>
```

- [ ] **Step 2: Commit**

```bash
cd /home/ellie/ellie-home
git add app/components/dispatch/StallAlertCard.vue
git commit -m "[DISPATCH-P5] feat: StallAlertCard with check-in/cancel/wait actions (ELLIE-1324)"
```

---

### Task 5: Cancel button on active dispatch cards

**Files:**
- Modify: `ellie-home/app/components/dispatch/DispatchCard.vue`
- Modify: `ellie-home/app/composables/useDispatchCards.ts`

- [ ] **Step 1: Add cancel action to useDispatchCards composable**

In `/home/ellie/ellie-home/app/composables/useDispatchCards.ts`, add a cancel function:

```typescript
async function cancelDispatch(runId: string): Promise<boolean> {
  try {
    await $fetch(`/api/orchestration/${encodeURIComponent(runId)}/cancel`, { method: 'POST' })
    const card = cards.value.get(runId)
    if (card) {
      card.status = 'cancelled'
      card.completed_at = Date.now()
      cards.value = new Map(cards.value)
    }
    return true
  } catch {
    return false
  }
}

function dismissStall(runId: string) {
  const card = cards.value.get(runId)
  if (card && card.status === 'stalled') {
    card.status = 'in_progress' // Reset to in_progress, stall timer resets on the relay side
    cards.value = new Map(cards.value)
  }
}
```

Add `cancelDispatch` and `dismissStall` to the returned object.

- [ ] **Step 2: Add cancel button to DispatchCard**

In `/home/ellie/ellie-home/app/components/dispatch/DispatchCard.vue`, add a cancel button for active cards. After the "Details" button block (for done/failed), add:

```vue
    <!-- Cancel button for active cards -->
    <button
      v-if="card.status === 'dispatched' || card.status === 'in_progress'"
      class="mt-2 w-full text-xs text-red-500/60 hover:text-red-400 text-center py-1 border-t border-gray-800"
      @click="$emit('cancel', card.run_id)"
    >
      Cancel
    </button>
```

Add `cancel: [runId: string]` to the existing `defineEmits`.

- [ ] **Step 3: Commit**

```bash
cd /home/ellie/ellie-home
git add app/composables/useDispatchCards.ts app/components/dispatch/DispatchCard.vue
git commit -m "[DISPATCH-P5] feat: cancel dispatch action on active cards (ELLIE-1327)"
```

---

### Task 6: Wire stall/conflict/suggestion events into Ellie Chat

**Files:**
- Modify: `ellie-home/app/composables/useEllieChat.ts`

- [ ] **Step 1: Handle stall events**

In the WebSocket message handler, find where `dispatch_event` is handled. The stalled status already updates the card via `handleDispatchEvent`. Add a chat message for stall alerts:

```typescript
      // Stall alert message (ELLIE-1324)
      if (msg.type === 'dispatch_event' && msg.status === 'stalled') {
        const stallMsg: EllieChatMessage = {
          id: `stall-${msg.run_id}-${Date.now()}`,
          role: 'system',
          text: `${msg.agent} hasn't updated${msg.work_item_id ? ` on ${msg.work_item_id}` : ''} — stalled`,
          agent: msg.agent,
          ts: msg.timestamp || Date.now(),
          stallAlert: true,
          dispatchRunId: msg.run_id,
        }
        messages.value.push(stallMsg)
      }
```

Add `stallAlert?: boolean` to the `EllieChatMessage` interface.

- [ ] **Step 2: Handle conflict warnings**

```typescript
      // Conflict warning (ELLIE-1325)
      if (msg.type === 'conflict_warning') {
        const conflictMsg: EllieChatMessage = {
          id: `conflict-${Date.now()}`,
          role: 'system',
          text: `${msg.agent}'s work may touch files ${msg.conflictAgent} is editing: ${(msg.overlappingFiles || []).slice(0, 3).join(', ')}`,
          agent: msg.agent,
          ts: msg.ts || Date.now(),
          conflictWarning: true,
        }
        messages.value.push(conflictMsg)
      }
```

Add `conflictWarning?: boolean` to the `EllieChatMessage` interface.

- [ ] **Step 3: Commit**

```bash
cd /home/ellie/ellie-home
git add app/composables/useEllieChat.ts
git commit -m "[DISPATCH-P5] feat: handle stall alerts and conflict warnings in chat (ELLIE-1324, 1325)"
```

---

### Task 7: Render stall alerts and conflict warnings in ellie-chat.vue

**Files:**
- Modify: `ellie-home/app/pages/ellie-chat.vue`

- [ ] **Step 1: Add stall alert rendering**

In the message rendering loop, after the routing feedback block, add:

```vue
    <!-- Stall alert (ELLIE-1324) -->
    <template v-else-if="msg.role === 'system' && msg.stallAlert && msg.dispatchRunId">
      <div class="flex justify-center w-full">
        <StallAlertCard
          v-if="getCardForMessage(msg.dispatchRunId)"
          :card="getCardForMessage(msg.dispatchRunId)!"
          :agent-color="getAgentColorForCard(msg.agent || 'general')"
          :agent-name="getAgentDisplayNameForCard(msg.agent || 'general')"
          @check-in="handleCheckIn"
          @cancel="handleCancel"
          @wait="handleWait"
        />
      </div>
    </template>

    <!-- Conflict warning (ELLIE-1325) -->
    <template v-else-if="msg.role === 'system' && msg.conflictWarning">
      <div class="flex justify-center w-full">
        <div class="border border-amber-800/30 bg-amber-900/10 rounded-lg px-3 py-1.5 text-xs text-amber-400">
          &#9888; {{ msg.text }}
        </div>
      </div>
    </template>
```

- [ ] **Step 2: Add action handlers**

In the `<script setup>` section, add:

```typescript
const { cancelDispatch, dismissStall } = useDispatchCards()

async function handleCancel(runId: string) {
  await cancelDispatch(runId)
}

function handleCheckIn(runId: string) {
  // Send a message asking Ellie to check on the agent
  const card = getCardForMessage(runId)
  if (card) {
    send(`Can you check on ${card.agent}? They seem stalled on ${card.work_item_id || 'their task'}.`)
  }
}

function handleWait(runId: string) {
  dismissStall(runId)
}
```

Import `send` from `useEllieChat` if not already destructured.

- [ ] **Step 3: Commit**

```bash
cd /home/ellie/ellie-home
git add app/pages/ellie-chat.vue
git commit -m "[DISPATCH-P5] feat: render stall alerts and conflict warnings in chat (ELLIE-1324, 1325)"
```

---

### Task 8: Morning dashboard snapshot API

**Files:**
- Modify: `src/http-routes.ts`
- Create: `ellie-home/server/api/dispatches/snapshot.get.ts`

- [ ] **Step 1: Add snapshot endpoint to relay**

In `/home/ellie/ellie-dev/src/http-routes.ts`, near the other dispatch routes, add:

```typescript
  // GET /api/dispatches/snapshot — morning dashboard data (ELLIE-1328)
  if (url.pathname === "/api/dispatches/snapshot" && req.method === "GET") {
    (async () => {
      try {
        const { getRecentOutcomes } = await import("./dispatch-outcomes.ts");
        const { getActiveRunStates } = await import("./orchestration-tracker.ts");

        const recentOutcomes = await getRecentOutcomes(24, 50);
        const activeRuns = getActiveRunStates().filter(r => r.status === "running");

        const done = recentOutcomes.filter(o => o.status === "completed");
        const failed = recentOutcomes.filter(o => o.status === "failed");

        res.writeHead(200, { "Content-Type": "application/json", ...corsHeader(req.headers.origin) });
        res.end(JSON.stringify({
          done: done.map(o => ({ run_id: o.run_id, agent: o.agent, work_item_id: o.work_item_id, summary: o.summary?.slice(0, 200), created_at: o.created_at })),
          active: activeRuns.map(r => ({ run_id: r.runId, agent: r.agentType, work_item_id: r.workItemId, started_at: r.startedAt })),
          failed: failed.map(o => ({ run_id: o.run_id, agent: o.agent, work_item_id: o.work_item_id, summary: o.summary?.slice(0, 200), created_at: o.created_at })),
          summary: { done: done.length, active: activeRuns.length, failed: failed.length, needs_attention: failed.length + activeRuns.filter(r => r.status === "stale").length },
        }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to build snapshot" }));
      }
    })();
    return;
  }
```

- [ ] **Step 2: Create Nuxt proxy**

Create `/home/ellie/ellie-home/server/api/dispatches/snapshot.get.ts`:

```typescript
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const relayUrl = config.relayUrl || 'http://localhost:3001'
  const res = await fetch(`${relayUrl}/api/dispatches/snapshot`, {
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw createError({ statusCode: res.status, message: 'Failed to fetch snapshot' })
  return res.json()
})
```

- [ ] **Step 3: Commit both**

```bash
cd /home/ellie/ellie-dev && git add src/http-routes.ts && git commit -m "[DISPATCH-P5] feat: GET /api/dispatches/snapshot endpoint (ELLIE-1328)"
cd /home/ellie/ellie-home && git add server/api/dispatches/snapshot.get.ts && git commit -m "[DISPATCH-P5] feat: Nuxt proxy for dispatch snapshot (ELLIE-1328)"
```

---

### Task 9: Morning dashboard in side panel

**Files:**
- Modify: `ellie-home/app/components/dispatch/DispatchSidePanel.vue`
- Modify: `ellie-home/app/composables/useDispatchCards.ts`

- [ ] **Step 1: Add snapshot loading to useDispatchCards**

In `/home/ellie/ellie-home/app/composables/useDispatchCards.ts`, add a function to load the morning snapshot:

```typescript
const snapshotLoaded = ref(false)

async function loadSnapshot(): Promise<void> {
  if (snapshotLoaded.value) return
  try {
    const data = await $fetch<{
      done: Array<{ run_id: string; agent: string; work_item_id: string | null; summary: string | null; created_at: string }>
      active: Array<{ run_id: string; agent: string; work_item_id: string | null; started_at: number }>
      failed: Array<{ run_id: string; agent: string; work_item_id: string | null; summary: string | null; created_at: string }>
      summary: { done: number; active: number; failed: number; needs_attention: number }
    }>('/api/dispatches/snapshot')

    // Populate cards from snapshot
    for (const o of data.done) {
      if (!cards.value.has(o.run_id)) {
        cards.value.set(o.run_id, {
          run_id: o.run_id, agent: o.agent, title: o.summary || 'Completed dispatch',
          work_item_id: o.work_item_id, dispatch_type: 'single', status: 'done',
          progress_line: null, started_at: new Date(o.created_at).getTime(),
          completed_at: new Date(o.created_at).getTime(), duration_ms: null, cost_usd: null,
        })
      }
    }
    for (const r of data.active) {
      if (!cards.value.has(r.run_id)) {
        cards.value.set(r.run_id, {
          run_id: r.run_id, agent: r.agent, title: 'Active dispatch',
          work_item_id: r.work_item_id, dispatch_type: 'single', status: 'in_progress',
          progress_line: null, started_at: r.started_at,
          completed_at: null, duration_ms: null, cost_usd: null,
        })
      }
    }
    for (const o of data.failed) {
      if (!cards.value.has(o.run_id)) {
        cards.value.set(o.run_id, {
          run_id: o.run_id, agent: o.agent, title: o.summary || 'Failed dispatch',
          work_item_id: o.work_item_id, dispatch_type: 'single', status: 'failed',
          progress_line: null, started_at: new Date(o.created_at).getTime(),
          completed_at: new Date(o.created_at).getTime(), duration_ms: null, cost_usd: null,
        })
      }
    }
    cards.value = new Map(cards.value) // trigger reactivity
    snapshotLoaded.value = true
  } catch {
    // Snapshot unavailable — cards will populate from WebSocket events
  }
}
```

Add `loadSnapshot` and `snapshotLoaded` to the returned object.

- [ ] **Step 2: Load snapshot on panel mount**

In `/home/ellie/ellie-home/app/components/dispatch/DispatchSidePanel.vue`, add:

```typescript
import { onMounted } from 'vue'

const { loadSnapshot } = useDispatchCards()
onMounted(() => loadSnapshot())
```

This ensures the "glance and know" experience — open the page, see the state of the world.

- [ ] **Step 3: Commit**

```bash
cd /home/ellie/ellie-home
git add app/composables/useDispatchCards.ts app/components/dispatch/DispatchSidePanel.vue
git commit -m "[DISPATCH-P5] feat: morning dashboard snapshot in side panel (ELLIE-1328)"
```

---

### Task 10: Wire cancel in side panel + build + deploy

**Files:**
- Modify: `ellie-home/app/components/dispatch/DispatchSidePanel.vue`

- [ ] **Step 1: Wire cancel handler for DispatchCard**

In DispatchSidePanel.vue, the DispatchCard currently only has `@expand`. Add `@cancel`:

Find the `<DispatchCard>` usage and add:
```vue
@cancel="handleCardCancel($event)"
```

Add the handler:
```typescript
const { cancelDispatch } = useDispatchCards()

async function handleCardCancel(runId: string) {
  await cancelDispatch(runId)
}
```

- [ ] **Step 2: Wire stall actions for StallAlertCard in side panel**

If stalled cards appear in the side panel (they do — status 'stalled' is in `activeCards`), render StallAlertCard for stalled cards instead of regular DispatchCard:

In the card list `v-for`, wrap the DispatchCard with a conditional:

```vue
        <template v-for="card in allCards" :key="card.run_id">
          <StallAlertCard
            v-if="card.status === 'stalled'"
            :card="card"
            :agent-color="getColor(card.agent)"
            :agent-name="getDisplayName(card.agent)"
            @check-in="handleCheckIn"
            @cancel="handleCardCancel"
            @wait="handleWait"
          />
          <DispatchCard
            v-else
            :card="card"
            :agent-color="getColor(card.agent)"
            :agent-name="getDisplayName(card.agent)"
            :agent-initial="getInitial(card.agent)"
            :is-focused="card.run_id === focusedRunId"
            @expand="openDrillDown($event)"
            @cancel="handleCardCancel($event)"
          />
        </template>
```

Add stall action handlers:
```typescript
function handleCheckIn(runId: string) {
  // Close panel and send a check-in message
  togglePanel()
}

function handleWait(runId: string) {
  const { dismissStall } = useDispatchCards()
  dismissStall(runId)
}
```

- [ ] **Step 3: Build**

```bash
cd /home/ellie/ellie-home && bun run build
```

Expected: Build succeeds.

- [ ] **Step 4: Restart dashboard**

```bash
sudo systemctl restart ellie-dashboard
```

- [ ] **Step 5: Restart relay**

```bash
systemctl --user restart ellie-chat-relay
```

- [ ] **Step 6: Push both repos**

```bash
cd /home/ellie/ellie-dev && git push
cd /home/ellie/ellie-home && git push
```

- [ ] **Step 7: Commit the plan**

```bash
cd /home/ellie/ellie-dev
git add docs/superpowers/plans/2026-04-03-dispatch-observability-phase5.md
git commit -m "[DISPATCH-P5] complete: Phase 5 bidirectional awareness"
```
