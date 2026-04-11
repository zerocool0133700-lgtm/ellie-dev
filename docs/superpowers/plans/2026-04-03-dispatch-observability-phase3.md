# Dispatch Observability Phase 3: Inquiry Routing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When agents are actively working, Max classifies Dave's messages (about running work / new work / general), queues context for running agents via working memory, auto-redispatches on completion, and shows routing feedback in the UI.

**Architecture:** Active dispatch context is conditionally injected into Max's coordinator prompt. When Dave's message relates to running work, Max writes it to the agent's working memory `context_anchors` section. On dispatch completion, the coordinator checks for queued context and immediately redispatches. Routing feedback is broadcast as a WebSocket event.

**Tech Stack:** TypeScript (Bun), coordinator prompt engineering, working memory (Forest DB), WebSocket, Vue 3

**Spec:** `docs/superpowers/specs/2026-04-03-dispatch-observability-design.md` — Phase 3 section

**Depends on:** Phase 1 (unified events, orchestration ledger), Phase 2 (dispatch cards)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/active-dispatch-context.ts` | Create | Build active dispatch summary for coordinator prompt |
| `src/dispatch-context-queue.ts` | Create | Queue user context to agent working memory + check/flush on completion |
| `src/foundation-registry.ts` | Modify | Inject active dispatch context into coordinator prompt |
| `src/coordinator.ts` | Modify | Check queued context on dispatch completion, auto-redispatch |
| `tests/active-dispatch-context.test.ts` | Create | Tests for context building |
| `tests/dispatch-context-queue.test.ts` | Create | Tests for queue + flush |
| `ellie-home/app/composables/useEllieChat.ts` | Modify | Handle routing_feedback WebSocket messages |
| `ellie-home/app/pages/ellie-chat.vue` | Modify | Render routing feedback annotations |

---

### Task 1: Active dispatch context builder

**Files:**
- Create: `src/active-dispatch-context.ts`
- Create: `tests/active-dispatch-context.test.ts`

- [ ] **Step 1: Write the test file**

Create `/home/ellie/ellie-dev/tests/active-dispatch-context.test.ts`:

```typescript
/**
 * Active dispatch context — builds prompt context from running dispatches
 * ELLIE-1316
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

describe("active-dispatch-context", () => {
  test("returns null when no active dispatches", async () => {
    mockGetActiveRunStates.mockReturnValue([]);
    const result = await buildActiveDispatchContext();
    expect(result).toBeNull();
  });

  test("builds context string for active dispatches", async () => {
    mockGetActiveRunStates.mockReturnValue([
      { runId: "run_1", agentType: "dev", workItemId: "ELLIE-500", startedAt: Date.now() - 720000, status: "running" },
      { runId: "run_2", agentType: "research", workItemId: "ELLIE-501", startedAt: Date.now() - 180000, status: "running" },
    ]);
    mockGetRecentEvents.mockResolvedValue([
      { run_id: "run_1", event_type: "progress", payload: { agent: "james", title: "Implement v2 API", progress_line: "writing tests" }, created_at: new Date().toISOString() },
      { run_id: "run_2", event_type: "dispatched", payload: { agent: "kate", title: "Competitive analysis" }, created_at: new Date().toISOString() },
    ]);

    const result = await buildActiveDispatchContext();
    expect(result).not.toBeNull();
    expect(result).toContain("james");
    expect(result).toContain("ELLIE-500");
    expect(result).toContain("writing tests");
    expect(result).toContain("kate");
  });

  test("returns null when only completed runs exist", async () => {
    mockGetActiveRunStates.mockReturnValue([
      { runId: "run_1", agentType: "dev", status: "completed", startedAt: Date.now() - 60000 },
    ]);
    const result = await buildActiveDispatchContext();
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/ellie/ellie-dev && bun test tests/active-dispatch-context.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement active-dispatch-context.ts**

Create `/home/ellie/ellie-dev/src/active-dispatch-context.ts`:

```typescript
/**
 * Active Dispatch Context — ELLIE-1316
 *
 * Builds a summary of currently active dispatches for injection into
 * Max's coordinator prompt. Only included when dispatches are running.
 */

import { log } from "./logger.ts";
import { getActiveRunStates, type RunState } from "./orchestration-tracker.ts";
import { getRecentEvents, type OrchestrationEvent } from "./orchestration-ledger.ts";

const logger = log.child("active-dispatch-context");

/**
 * Build a markdown summary of active dispatches for the coordinator prompt.
 * Returns null if no dispatches are running (caller should skip injection).
 */
export async function buildActiveDispatchContext(): Promise<string | null> {
  const runs = getActiveRunStates().filter(r => r.status === "running");
  if (runs.length === 0) return null;

  // Get recent events to enrich with progress lines and titles
  let events: OrchestrationEvent[] = [];
  try {
    events = await getRecentEvents(100);
  } catch {
    // If ledger is unavailable, build context from tracker state only
  }

  // Build a map of run_id → latest event info
  const eventsByRun = new Map<string, { agent: string; title: string; progress_line: string | null }>();
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    const existing = eventsByRun.get(event.run_id);
    // Keep the most recent event's data (events are DESC ordered)
    if (!existing) {
      eventsByRun.set(event.run_id, {
        agent: (payload.agent as string) || event.agent_type || "unknown",
        title: (payload.title as string) || "Unknown task",
        progress_line: (payload.progress_line as string) || null,
      });
    }
  }

  const lines: string[] = [];
  for (const run of runs) {
    const info = eventsByRun.get(run.runId);
    const agent = info?.agent || run.agentType || "unknown";
    const title = info?.title || run.message || "Unknown task";
    const progress = info?.progress_line ? `, last progress: "${info.progress_line}"` : "";
    const elapsedMin = Math.round((Date.now() - run.startedAt) / 60000);
    const workItem = run.workItemId ? ` on ${run.workItemId}` : "";

    lines.push(`- **${agent}** is working${workItem}: "${title}" (${elapsedMin} min elapsed${progress})`);
  }

  return `## Active Dispatches
${lines.join("\n")}

When Dave's message relates to active work:
- Queue the context for that agent and tell Dave it's queued
When it's new work:
- Dispatch normally
When it's general conversation:
- Dispatch to Ellie`;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /home/ellie/ellie-dev && bun test tests/active-dispatch-context.test.ts
```

Expected: 3 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/active-dispatch-context.ts tests/active-dispatch-context.test.ts
git commit -m "[DISPATCH-P3] feat: active dispatch context builder for coordinator prompt (ELLIE-1316)"
```

---

### Task 2: Dispatch context queue (working memory)

**Files:**
- Create: `src/dispatch-context-queue.ts`
- Create: `tests/dispatch-context-queue.test.ts`

- [ ] **Step 1: Write the test file**

Create `/home/ellie/ellie-dev/tests/dispatch-context-queue.test.ts`:

```typescript
/**
 * Dispatch context queue — queue user context via working memory
 * ELLIE-1317
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: mock(), warn: mock(), error: mock(), debug: mock() }) },
}));

const mockUpdateWM = mock(async () => null);
const mockReadWM = mock(async () => null);
mock.module("../src/working-memory.ts", () => ({
  updateWorkingMemory: mockUpdateWM,
  readWorkingMemory: mockReadWM,
}));

import {
  queueContextForAgent,
  checkQueuedContext,
  clearQueuedContext,
  QUEUED_CONTEXT_MARKER,
} from "../src/dispatch-context-queue.ts";

describe("dispatch-context-queue", () => {
  beforeEach(() => {
    mockUpdateWM.mockClear();
    mockReadWM.mockClear();
  });

  test("queueContextForAgent writes to working memory context_anchors", async () => {
    await queueContextForAgent("session_1", "james", "actually use the v2 API");

    expect(mockUpdateWM).toHaveBeenCalledTimes(1);
    const call = mockUpdateWM.mock.calls[0][0];
    expect(call.agent).toBe("james");
    expect(call.sections.context_anchors).toContain(QUEUED_CONTEXT_MARKER);
    expect(call.sections.context_anchors).toContain("actually use the v2 API");
  });

  test("checkQueuedContext returns messages when markers exist", async () => {
    mockReadWM.mockResolvedValue({
      sections: {
        context_anchors: `Some existing anchor\n${QUEUED_CONTEXT_MARKER} actually use the v2 API\n${QUEUED_CONTEXT_MARKER} also check the tests`,
      },
    });

    const messages = await checkQueuedContext("session_1", "james");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain("actually use the v2 API");
    expect(messages[1]).toContain("also check the tests");
  });

  test("checkQueuedContext returns empty array when no markers", async () => {
    mockReadWM.mockResolvedValue({
      sections: {
        context_anchors: "Some existing anchor without markers",
      },
    });

    const messages = await checkQueuedContext("session_1", "james");
    expect(messages).toHaveLength(0);
  });

  test("checkQueuedContext returns empty array when no working memory", async () => {
    mockReadWM.mockResolvedValue(null);
    const messages = await checkQueuedContext("session_1", "james");
    expect(messages).toHaveLength(0);
  });

  test("clearQueuedContext removes marker lines from context_anchors", async () => {
    mockReadWM.mockResolvedValue({
      sections: {
        context_anchors: `Important anchor\n${QUEUED_CONTEXT_MARKER} queued message\nAnother anchor`,
      },
    });

    await clearQueuedContext("session_1", "james");

    expect(mockUpdateWM).toHaveBeenCalledTimes(1);
    const sections = mockUpdateWM.mock.calls[0][0].sections;
    expect(sections.context_anchors).toContain("Important anchor");
    expect(sections.context_anchors).toContain("Another anchor");
    expect(sections.context_anchors).not.toContain(QUEUED_CONTEXT_MARKER);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/ellie/ellie-dev && bun test tests/dispatch-context-queue.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement dispatch-context-queue.ts**

Create `/home/ellie/ellie-dev/src/dispatch-context-queue.ts`:

```typescript
/**
 * Dispatch Context Queue — ELLIE-1317
 *
 * Queues Dave's messages for running agents via working memory.
 * When a dispatch completes, the coordinator checks for queued context
 * and auto-redispatches the agent with it.
 *
 * Uses working memory context_anchors section — persists in Forest DB,
 * survives relay restarts.
 */

import { log } from "./logger.ts";
import { updateWorkingMemory, readWorkingMemory } from "./working-memory.ts";

const logger = log.child("dispatch-context-queue");

export const QUEUED_CONTEXT_MARKER = "[QUEUED from Dave]";

/**
 * Queue a message from Dave for a running agent.
 * Writes to the agent's working memory context_anchors section.
 */
export async function queueContextForAgent(
  sessionId: string,
  agent: string,
  message: string,
): Promise<void> {
  const timestamp = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  const markerLine = `${QUEUED_CONTEXT_MARKER} @ ${timestamp}: ${message}`;

  try {
    await updateWorkingMemory({
      session_id: sessionId,
      agent,
      sections: {
        context_anchors: markerLine,
      },
    });
    logger.info("Context queued for agent", { agent, messagePreview: message.slice(0, 100) });
  } catch (err) {
    logger.error("Failed to queue context", { agent, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Check if an agent has queued context from Dave.
 * Returns the queued messages (without markers), or empty array.
 */
export async function checkQueuedContext(
  sessionId: string,
  agent: string,
): Promise<string[]> {
  try {
    const record = await readWorkingMemory({ session_id: sessionId, agent });
    if (!record) return [];

    const anchors = record.sections?.context_anchors;
    if (!anchors || typeof anchors !== "string") return [];

    return anchors
      .split("\n")
      .filter(line => line.includes(QUEUED_CONTEXT_MARKER))
      .map(line => line.replace(/\[QUEUED from Dave\] @ \d{2}:\d{2}: /, "").trim())
      .filter(msg => msg.length > 0);
  } catch (err) {
    logger.error("Failed to check queued context", { agent, error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/**
 * Clear queued context markers from an agent's working memory.
 * Called after auto-redispatch.
 */
export async function clearQueuedContext(
  sessionId: string,
  agent: string,
): Promise<void> {
  try {
    const record = await readWorkingMemory({ session_id: sessionId, agent });
    if (!record) return;

    const anchors = record.sections?.context_anchors;
    if (!anchors || typeof anchors !== "string") return;

    const cleaned = anchors
      .split("\n")
      .filter(line => !line.includes(QUEUED_CONTEXT_MARKER))
      .join("\n")
      .trim();

    await updateWorkingMemory({
      session_id: sessionId,
      agent,
      sections: { context_anchors: cleaned },
    });
    logger.info("Queued context cleared", { agent });
  } catch (err) {
    logger.error("Failed to clear queued context", { agent, error: err instanceof Error ? err.message : String(err) });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /home/ellie/ellie-dev && bun test tests/dispatch-context-queue.test.ts
```

Expected: 5 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/dispatch-context-queue.ts tests/dispatch-context-queue.test.ts
git commit -m "[DISPATCH-P3] feat: dispatch context queue via working memory (ELLIE-1317)"
```

---

### Task 3: Inject active dispatch context into coordinator prompt

**Files:**
- Modify: `src/foundation-registry.ts`

- [ ] **Step 1: Read the getCoordinatorPrompt method**

Read `/home/ellie/ellie-dev/src/foundation-registry.ts` around lines 189-279 to understand the prompt structure.

- [ ] **Step 2: Add active dispatch context injection**

The `getCoordinatorPrompt()` method is `async` and returns a template string. At the end of the method, before the closing backtick and return, we need to conditionally append active dispatch context.

Find the end of the return template string (around line 278, just before the closing backtick). Change the method to build the prompt in parts:

After the `coordinatorAgent` variable assignment (line 228) and before the `return` statement, add:

```typescript
    // ELLIE-1316: Conditionally inject active dispatch context
    let activeDispatchSection = "";
    try {
      const { buildActiveDispatchContext } = await import("./active-dispatch-context.ts");
      const dispatchCtx = await buildActiveDispatchContext();
      if (dispatchCtx) {
        activeDispatchSection = `\n\n${dispatchCtx}`;
      }
    } catch {
      // Active dispatch context unavailable — proceed without
    }
```

Then at the very end of the template string (just before the closing backtick on line ~278), append:

```
${activeDispatchSection}
```

So the end of the return statement looks like:

```typescript
- Escalation: ${behavior.escalation}${activeDispatchSection}`;
```

- [ ] **Step 3: Run existing tests**

```bash
cd /home/ellie/ellie-dev && bun test tests/foundation-registry.test.ts
```

Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add src/foundation-registry.ts
git commit -m "[DISPATCH-P3] feat: conditionally inject active dispatch context into coordinator prompt (ELLIE-1316)"
```

---

### Task 4: Auto-redispatch on queued context

**Files:**
- Modify: `src/coordinator.ts`

- [ ] **Step 1: Read the dispatch completion section**

Read `/home/ellie/ellie-dev/src/coordinator.ts` around lines 568-620 — the section where a specialist dispatch completes and the result is processed.

- [ ] **Step 2: Add import**

At the top of coordinator.ts, add:

```typescript
import { checkQueuedContext, clearQueuedContext } from "./dispatch-context-queue.ts";
```

- [ ] **Step 3: Add queued context check after dispatch completion**

After the existing outcome write (the `writeOutcome()` call added in Phase 1, around line 630), add:

```typescript
            // ELLIE-1317: Check for queued context from Dave — auto-redispatch if present
            try {
              const sessionId = opts.deps ? "coordinator" : "default";
              const queuedMessages = await checkQueuedContext(sessionId, input.agent);
              if (queuedMessages.length > 0) {
                logger.info("Queued context found — auto-redispatching", { agent: input.agent, messageCount: queuedMessages.length });
                await clearQueuedContext(sessionId, input.agent);
                // Re-dispatch the same agent with completed results + queued context
                const redispatchTask = `Continue your previous work. Here are additional instructions from Dave that came in while you were working:\n\n${queuedMessages.map(m => `- ${m}`).join("\n")}\n\nYour previous result:\n${specResult.output?.slice(0, 2000) || "No output"}`;
                const redispatchResult = await deps.callSpecialist(input.agent, redispatchTask, input.context, input.timeout_ms);
                // Update the result to use the redispatch output
                return { toolId, result: redispatchResult.output || specResult.output };
              }
            } catch (err) {
              logger.warn("Queued context check failed", { agent: input.agent, error: err instanceof Error ? err.message : String(err) });
            }
```

IMPORTANT: This goes inside the dispatch promise handler, after the outcome write but before the return. Read the code carefully to find the right insertion point. The `return { toolId, result }` statement for each dispatch promise is what sends the result back to the coordinator loop.

- [ ] **Step 4: Run coordinator tests**

```bash
cd /home/ellie/ellie-dev && bun test tests/coordinator.test.ts
```

Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/coordinator.ts
git commit -m "[DISPATCH-P3] feat: auto-redispatch with queued context on dispatch completion (ELLIE-1317)"
```

---

### Task 5: Routing feedback WebSocket event

**Files:**
- Modify: `src/coordinator.ts`

- [ ] **Step 1: Add routing feedback emission**

When the coordinator identifies a message as `about_running_work` (which happens when Max decides to queue context instead of dispatching), Max should emit a routing feedback event via `sendEvent`. This is prompt-driven — Max decides to queue. But we need to emit the feedback when `queueContextForAgent` is called.

In `dispatch-context-queue.ts`, add a WebSocket broadcast after successful queue:

```typescript
import { broadcastDispatchEvent } from "./relay-state.ts";
```

And at the end of `queueContextForAgent`, after the successful `updateWorkingMemory` call:

```typescript
    // Broadcast routing feedback to UI
    try {
      broadcastDispatchEvent({
        type: "routing_feedback",
        agent,
        message: `Queued for ${agent}`,
        ts: Date.now(),
      });
    } catch { /* best-effort */ }
```

- [ ] **Step 2: Commit**

```bash
git add src/dispatch-context-queue.ts
git commit -m "[DISPATCH-P3] feat: routing feedback WebSocket event on context queue (ELLIE-1318)"
```

---

### Task 6: Routing feedback in Ellie Chat UI

**Files:**
- Modify: `ellie-home/app/composables/useEllieChat.ts`
- Modify: `ellie-home/app/pages/ellie-chat.vue`

- [ ] **Step 1: Handle routing_feedback in useEllieChat**

In `/home/ellie/ellie-home/app/composables/useEllieChat.ts`, find the WebSocket message handler. Add a case for `routing_feedback` near the `dispatch_event` handler:

```typescript
      // Routing feedback (ELLIE-1318) — show where Dave's message was routed
      if (msg.type === 'routing_feedback') {
        const feedbackMsg: EllieChatMessage = {
          id: `feedback-${Date.now()}`,
          role: 'system',
          text: msg.message || `Queued for ${msg.agent}`,
          agent: msg.agent,
          ts: msg.ts || Date.now(),
          routingFeedback: true,
        }
        messages.value.push(feedbackMsg)
      }
```

Add `routingFeedback?: boolean` to the `EllieChatMessage` interface.

- [ ] **Step 2: Render routing feedback in ellie-chat.vue**

In `/home/ellie/ellie-home/app/pages/ellie-chat.vue`, in the message rendering loop, add a case for routing feedback messages (after the dispatch inline indicator block):

```vue
    <!-- Routing feedback annotation (ELLIE-1318) -->
    <template v-if="msg.role === 'system' && msg.routingFeedback">
      <div class="flex justify-center w-full">
        <span class="text-[10px] text-gray-600 italic px-2 py-0.5">
          → {{ msg.text }}
        </span>
      </div>
    </template>
```

- [ ] **Step 3: Build**

```bash
cd /home/ellie/ellie-home && bun run build
```

Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
cd /home/ellie/ellie-home
git add app/composables/useEllieChat.ts app/pages/ellie-chat.vue
git commit -m "[DISPATCH-P3] feat: routing feedback annotations in Ellie Chat (ELLIE-1318)"
```

---

### Task 7: Run tests, restart, verify

- [ ] **Step 1: Run all new tests**

```bash
cd /home/ellie/ellie-dev && bun test tests/active-dispatch-context.test.ts tests/dispatch-context-queue.test.ts
```

Expected: 8 pass, 0 fail.

- [ ] **Step 2: Run coordinator tests**

```bash
bun test tests/coordinator.test.ts
```

Expected: All pass.

- [ ] **Step 3: Restart relay**

```bash
systemctl --user restart ellie-chat-relay
```

- [ ] **Step 4: Rebuild and restart dashboard**

```bash
cd /home/ellie/ellie-home && bun run build && sudo systemctl restart ellie-dashboard
```

- [ ] **Step 5: Verify health**

```bash
curl -s http://localhost:3001/health | python3 -c "import sys,json; d=json.load(sys.stdin); print('Status:', d['status'])"
```

Expected: `Status: ok`

- [ ] **Step 6: Push both repos**

```bash
cd /home/ellie/ellie-dev && git push
cd /home/ellie/ellie-home && git push
```

- [ ] **Step 7: Commit the plan**

```bash
cd /home/ellie/ellie-dev
git add docs/superpowers/plans/2026-04-03-dispatch-observability-phase3.md
git commit -m "[DISPATCH-P3] complete: Phase 3 inquiry routing"
```
