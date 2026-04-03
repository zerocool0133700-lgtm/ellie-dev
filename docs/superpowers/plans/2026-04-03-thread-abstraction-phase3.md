# Thread Abstraction Phase 3: Polish + Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thread-scope the dispatch system end-to-end — dispatch events carry thread_id, the side panel filters by active thread, the coordinator only sees dispatches from the current thread, and thread participant changes are handled gracefully.

**Architecture:** Add `thread_id` to DispatchEventPayload and RunState. The active dispatch context builder filters by thread. The frontend dispatch cards composable and side panel filter by active thread. Thread update events broadcast on participant changes. Edge cases for mid-conversation agent add/remove are handled in the thread API.

**Tech Stack:** TypeScript (Bun), Vue 3 (Nuxt 4), Tailwind CSS, WebSocket

**Spec:** `docs/superpowers/specs/2026-04-03-thread-abstraction-design.md` — Phase 3

**Depends on:** Phase 1 (thread data layer + routing), Phase 2 (frontend)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/dispatch-events.ts` | Modify | Add thread_id to DispatchEventPayload + WebSocket payload |
| `src/orchestration-tracker.ts` | Modify | Add thread_id to RunState |
| `src/active-dispatch-context.ts` | Modify | Filter by thread_id |
| `src/coordinator.ts` | Modify | Pass thread_id to dispatch events |
| `src/api/threads.ts` | Modify | Add update thread + participant change events |
| `src/http-routes.ts` | Modify | Add PATCH /api/threads/:id route |
| `ellie-home/app/composables/useDispatchCards.ts` | Modify | Add thread_id to DispatchCard, filter by active thread |
| `ellie-home/app/components/dispatch/DispatchSidePanel.vue` | Modify | Filter cards by active thread |
| `ellie-home/server/api/threads/[id].patch.ts` | Create | Nuxt proxy for thread update |
| `tests/active-dispatch-context-thread.test.ts` | Create | Thread-filtered context tests |

---

### Task 1: Add thread_id to dispatch events and orchestration tracker

**Files:**
- Modify: `src/dispatch-events.ts`
- Modify: `src/orchestration-tracker.ts`

- [ ] **Step 1: Add thread_id to DispatchEventPayload**

In `/home/ellie/ellie-dev/src/dispatch-events.ts`, find the `DispatchEventPayload` interface (around line 15). Add `thread_id`:

```typescript
export interface DispatchEventPayload {
  agent: string;
  title: string;
  work_item_id?: string | null;
  progress_line?: string | null;
  dispatch_type: "single" | "formation" | "round_table" | "delegation";
  duration_ms?: number;
  cost_usd?: number;
  thread_id?: string | null;  // ELLIE-1374 Phase 3
}
```

- [ ] **Step 2: Include thread_id in WebSocket payload**

In the `buildDispatchWebSocketPayload` function, add `thread_id` to the returned object:

```typescript
    thread_id: payload.thread_id ?? null,
```

Add it after the `dispatch_type` line in the return object.

- [ ] **Step 3: Include thread_id in ledger emission**

In the `emitDispatchEvent` function, add `thread_id` to the payload passed to `emitEvent`:

```typescript
      thread_id: payload.thread_id ?? null,
```

Add it in the payload object passed to `emitEvent()`.

- [ ] **Step 4: Add thread_id to RunState**

In `/home/ellie/ellie-dev/src/orchestration-tracker.ts`, find the `RunState` interface (around line 29). Add:

```typescript
  thread_id?: string;  // ELLIE-1374
```

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/dispatch-events.ts src/orchestration-tracker.ts
git commit -m "[THREADS-P3] feat: add thread_id to dispatch events and RunState (ELLIE-1374)"
```

---

### Task 2: Pass thread_id from coordinator to dispatch events

**Files:**
- Modify: `src/coordinator.ts`

- [ ] **Step 1: Read the coordinator dispatch section**

Read `/home/ellie/ellie-dev/src/coordinator.ts` and find where `emitDispatchEvent` is called (there should be 2-3 calls from Phase 1 — one for "dispatched", one for "completed"/"failed").

- [ ] **Step 2: Add threadId to CoordinatorOpts**

Check if `threadId` already exists on `CoordinatorOpts`. If not, add it:

```typescript
  threadId?: string;  // ELLIE-1374: thread context
```

- [ ] **Step 3: Pass thread_id to all emitDispatchEvent calls**

For each `emitDispatchEvent` call in the coordinator, add `thread_id` to the payload:

Find calls like:
```typescript
emitDispatchEvent(specEnvelope.id, "dispatched", {
  agent: input.agent,
  title: input.task.slice(0, 200),
  work_item_id: workItemId,
  dispatch_type: "single",
});
```

Add `thread_id: opts.threadId ?? null,` to each payload.

There should be ~2-3 `emitDispatchEvent` calls. Update all of them.

- [ ] **Step 4: Pass threadId from ellie-chat-handler**

In `/home/ellie/ellie-dev/src/ellie-chat-handler.ts`, find the `runCoordinatorLoop` call. Check if `threadId` is already passed (it may have been added in Phase 1 Task 8 as part of the opts). If not, add:

```typescript
            threadId: effectiveThreadId || undefined,
```

- [ ] **Step 5: Run tests**

```bash
cd /home/ellie/ellie-dev && bun test tests/coordinator.test.ts
```

Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/coordinator.ts src/ellie-chat-handler.ts
git commit -m "[THREADS-P3] feat: pass thread_id from coordinator to dispatch events (ELLIE-1374)"
```

---

### Task 3: Filter active dispatch context by thread

**Files:**
- Modify: `src/active-dispatch-context.ts`
- Create: `tests/active-dispatch-context-thread.test.ts`

- [ ] **Step 1: Write the test**

Create `/home/ellie/ellie-dev/tests/active-dispatch-context-thread.test.ts`:

```typescript
/**
 * Active dispatch context — thread filtering
 * ELLIE-1374 Phase 3
 */

import { describe, test, expect, mock } from "bun:test";

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: mock(), warn: mock(), error: mock(), debug: mock() }) },
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

import { buildActiveDispatchContext } from "../src/active-dispatch-context.ts";

describe("active-dispatch-context thread filtering", () => {
  test("filters to only dispatches in the given thread", async () => {
    mockGetActiveRunStates.mockReturnValue([
      { runId: "run_1", agentType: "dev", workItemId: "ELLIE-500", startedAt: Date.now() - 60000, status: "running", thread_id: "thread-A" },
      { runId: "run_2", agentType: "research", workItemId: "ELLIE-501", startedAt: Date.now() - 30000, status: "running", thread_id: "thread-B" },
    ]);
    mockGetRecentEvents.mockResolvedValue([
      { run_id: "run_1", event_type: "dispatched", payload: { agent: "james", title: "v2 API" }, created_at: new Date().toISOString() },
      { run_id: "run_2", event_type: "dispatched", payload: { agent: "kate", title: "Research" }, created_at: new Date().toISOString() },
    ]);

    const result = await buildActiveDispatchContext("thread-A");
    expect(result).not.toBeNull();
    expect(result).toContain("james");
    expect(result).not.toContain("kate");
  });

  test("returns all dispatches when no thread filter", async () => {
    mockGetActiveRunStates.mockReturnValue([
      { runId: "run_1", agentType: "dev", startedAt: Date.now(), status: "running", thread_id: "thread-A" },
      { runId: "run_2", agentType: "research", startedAt: Date.now(), status: "running", thread_id: "thread-B" },
    ]);
    mockGetRecentEvents.mockResolvedValue([
      { run_id: "run_1", event_type: "dispatched", payload: { agent: "james", title: "Work" }, created_at: new Date().toISOString() },
      { run_id: "run_2", event_type: "dispatched", payload: { agent: "kate", title: "Research" }, created_at: new Date().toISOString() },
    ]);

    const result = await buildActiveDispatchContext();
    expect(result).not.toBeNull();
    expect(result).toContain("james");
    expect(result).toContain("kate");
  });
});
```

- [ ] **Step 2: Add thread filtering to buildActiveDispatchContext**

In `/home/ellie/ellie-dev/src/active-dispatch-context.ts`, add an optional `threadId` parameter:

```typescript
export async function buildActiveDispatchContext(threadId?: string): Promise<string | null> {
  let runs = getActiveRunStates().filter(r => r.status === "running");

  // ELLIE-1374 Phase 3: Filter by thread if provided
  if (threadId) {
    runs = runs.filter(r => (r as any).thread_id === threadId);
  }

  if (runs.length === 0) return null;
```

- [ ] **Step 3: Run tests**

```bash
cd /home/ellie/ellie-dev && bun test tests/active-dispatch-context-thread.test.ts
```

Expected: 2 pass, 0 fail.

- [ ] **Step 4: Pass threadId from foundation-registry**

In `/home/ellie/ellie-dev/src/foundation-registry.ts`, find where `buildActiveDispatchContext()` is called (in `getCoordinatorPrompt`). It was added in Phase 3 of dispatch observability. Pass the thread_id if available.

The issue: `getCoordinatorPrompt()` doesn't have access to thread_id. The simplest fix: make it a parameter.

Add `threadId?: string` to `getCoordinatorPrompt()`:

```typescript
  async getCoordinatorPrompt(threadId?: string): Promise<string> {
```

Then pass it to `buildActiveDispatchContext`:

```typescript
      const dispatchCtx = await buildActiveDispatchContext(threadId);
```

In `coordinator.ts`, where `getCoordinatorPrompt()` is called (around line 169), pass the thread:

```typescript
  const effectivePrompt = opts.registry ? await opts.registry.getCoordinatorPrompt(opts.threadId) : systemPrompt;
```

- [ ] **Step 5: Commit**

```bash
git add src/active-dispatch-context.ts src/foundation-registry.ts src/coordinator.ts tests/active-dispatch-context-thread.test.ts
git commit -m "[THREADS-P3] feat: filter active dispatch context by thread (ELLIE-1374)"
```

---

### Task 4: Thread-scoped dispatch cards in frontend

**Files:**
- Modify: `ellie-home/app/composables/useDispatchCards.ts`
- Modify: `ellie-home/app/components/dispatch/DispatchSidePanel.vue`

- [ ] **Step 1: Add thread_id to DispatchCard interface**

In `/home/ellie/ellie-home/app/composables/useDispatchCards.ts`, find the `DispatchCard` interface. Add:

```typescript
  thread_id: string | null
```

- [ ] **Step 2: Populate thread_id from dispatch events**

In the `handleDispatchEvent` function, when creating a new card, set `thread_id`:

```typescript
      thread_id: msg.thread_id ?? null,
```

Add it to the card creation object.

- [ ] **Step 3: Add thread-filtered computed**

Add a computed that filters cards by active thread:

```typescript
import { useThreads } from './useThreads'
```

Then add:

```typescript
const threadFilteredCards = computed(() => {
  const { activeThreadId } = useThreads()
  const tid = activeThreadId.value
  if (!tid) return allCards.value
  return allCards.value.filter(c => c.thread_id === tid || c.thread_id === null)
})
```

Export `threadFilteredCards` from the composable.

- [ ] **Step 4: Use filtered cards in DispatchSidePanel**

In `/home/ellie/ellie-home/app/components/dispatch/DispatchSidePanel.vue`, change the card list to use `threadFilteredCards` instead of `allCards`:

Find the destructuring from `useDispatchCards()` and add `threadFilteredCards`. Then replace `allCards` with `threadFilteredCards` in the template `v-for` and in the summary line counts.

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-home
git add app/composables/useDispatchCards.ts app/components/dispatch/DispatchSidePanel.vue
git commit -m "[THREADS-P3] feat: thread-scoped dispatch cards in side panel (ELLIE-1374)"
```

---

### Task 5: Thread update API + participant change events

**Files:**
- Modify: `src/api/threads.ts`
- Modify: `src/http-routes.ts`
- Create: `ellie-home/server/api/threads/[id].patch.ts`

- [ ] **Step 1: Add updateThread function**

In `/home/ellie/ellie-dev/src/api/threads.ts`, add:

```typescript
export async function updateThread(
  supabase: SupabaseClient,
  threadId: string,
  updates: { name?: string; routing_mode?: string; direct_agent?: string | null },
): Promise<void> {
  const { error } = await supabase
    .from("chat_threads")
    .update(updates)
    .eq("id", threadId);

  if (error) throw new Error(error.message);

  // Broadcast update
  try {
    broadcastToEllieChatClients({
      type: "thread_updated",
      thread: { id: threadId, ...updates },
    });
  } catch { /* best-effort */ }

  logger.info("Thread updated", { id: threadId, updates });
}
```

- [ ] **Step 2: Add participant change broadcasting to existing functions**

In the existing `addParticipant` and `removeParticipant` functions, add WebSocket broadcasts after the DB operation:

For `addParticipant`, after the upsert:
```typescript
  try {
    broadcastToEllieChatClients({
      type: "thread_updated",
      thread: { id: threadId },
      change: { type: "participant_added", agent },
    });
  } catch { /* best-effort */ }
```

For `removeParticipant`, after the delete:
```typescript
  try {
    broadcastToEllieChatClients({
      type: "thread_updated",
      thread: { id: threadId },
      change: { type: "participant_removed", agent },
    });
  } catch { /* best-effort */ }
```

- [ ] **Step 3: Wire PATCH route in http-routes.ts**

In `/home/ellie/ellie-dev/src/http-routes.ts`, find the thread routes (added in Phase 1 Task 4). Add a PATCH route:

```typescript
  // PATCH /api/threads/:id
  if (threadMatch && req.method === "PATCH") {
    (async () => {
      try {
        const body = await readBody(req);
        const { updateThread } = await import("./api/threads.ts");
        const { getRelayDeps } = await import("./relay-deps.ts");
        const { supabase } = getRelayDeps();
        await updateThread(supabase!, threadMatch[1], body);
        res.writeHead(200, { "Content-Type": "application/json", ...corsHeader(req.headers.origin) });
        res.end(JSON.stringify({ ok: true }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    })();
    return;
  }
```

Note: `threadMatch` was defined for the GET route — make sure the PATCH handler is inside the same `if (threadMatch)` block or after a fresh match check.

- [ ] **Step 4: Create Nuxt proxy**

Create `/home/ellie/ellie-home/server/api/threads/[id].patch.ts`:

```typescript
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const relayUrl = config.relayUrl || 'http://localhost:3001'
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'Missing thread ID' })
  const body = await readBody(event)
  const res = await fetch(`${relayUrl}/api/threads/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw createError({ statusCode: res.status, message: 'Failed to update thread' })
  return res.json()
})
```

- [ ] **Step 5: Handle thread_updated in frontend**

In `/home/ellie/ellie-home/app/composables/useEllieChat.ts`, find the `thread_created` handler (added in Phase 2 Task 4). After it, add:

```typescript
      if (msg.type === 'thread_updated' && msg.thread) {
        const { fetchThreads } = useThreads()
        fetchThreads() // Refresh thread list to pick up changes
      }
```

- [ ] **Step 6: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/api/threads.ts src/http-routes.ts
git commit -m "[THREADS-P3] feat: thread update API + participant change events (ELLIE-1374)"

cd /home/ellie/ellie-home
git add server/api/threads/\[id\].patch.ts app/composables/useEllieChat.ts
git commit -m "[THREADS-P3] feat: Nuxt proxy for thread update + handle thread_updated (ELLIE-1374)"
```

---

### Task 6: Build, deploy, verify

- [ ] **Step 1: Run all tests**

```bash
cd /home/ellie/ellie-dev && bun test tests/active-dispatch-context-thread.test.ts tests/coordinator.test.ts tests/thread-context.test.ts tests/direct-chat.test.ts
```

Expected: All pass.

- [ ] **Step 2: Build dashboard**

```bash
cd /home/ellie/ellie-home && bun run build
```

Expected: Build succeeds.

- [ ] **Step 3: Restart services**

```bash
systemctl --user restart ellie-chat-relay
sudo systemctl restart ellie-dashboard
```

- [ ] **Step 4: Verify**

```bash
curl -s http://localhost:3001/health | python3 -c "import sys,json; d=json.load(sys.stdin); print('Relay:', d['status'])"
curl -s http://localhost:3001/api/threads | python3 -c "import sys,json; d=json.load(sys.stdin); print('Threads:', len(d.get('threads',[])))"
```

- [ ] **Step 5: Push both repos**

```bash
cd /home/ellie/ellie-dev && git push
cd /home/ellie/ellie-home && git push
```

- [ ] **Step 6: Commit the plan**

```bash
cd /home/ellie/ellie-dev
git add docs/superpowers/plans/2026-04-03-thread-abstraction-phase3.md
git commit -m "[THREADS-P3] complete: Phase 3 thread polish + integration"
```
