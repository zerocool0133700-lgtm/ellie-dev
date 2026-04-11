# Max Coordinator / Ellie Partner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create Max as the behind-the-scenes coordinator agent, restoring Ellie to her role as Dave's friend and partner (specialist agent).

**Architecture:** Max runs the coordinator loop silently — routing, dispatching, synthesizing. Ellie becomes a specialist in the agent roster, dispatched for general conversation, partnership, brainstorming. All user-facing responses display as "ellie". The `coordinator_agent` field in `BehaviorRules` makes this configurable per foundation.

**Tech Stack:** TypeScript (Bun), Supabase (foundations table), Forest (Postgres), River vault (Obsidian markdown)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/foundation-types.ts` | Modify | Add `coordinator_agent` to `BehaviorRules` |
| `src/foundation-registry.ts` | Modify | Add `getCoordinatorAgent()`, update `getCoordinatorPrompt()` for Max |
| `src/coordinator.ts` | Modify | Replace 7 hardcoded `"ellie"` with configurable coordinator agent, add `coordinatorAgent` to opts |
| `src/telegram-handlers.ts` | Modify | Pass coordinator agent to loop, keep display as `"ellie"` |
| `src/ellie-chat-handler.ts` | Modify | Same pattern as telegram-handlers |
| `seeds/supabase/002_foundations.sql` | Modify | Add `coordinator_agent: "max"` to behavior, add Ellie as specialist |
| `/home/ellie/obsidian-vault/soul/max-soul.md` | Create | Max's coordinator personality |
| `tests/coordinator.test.ts` | Modify | Update tests for configurable coordinator agent |
| `tests/coordinator-mode-wiring.test.ts` | Modify | Update `agent: "ellie"` assertions |

---

### Task 1: Add `coordinator_agent` to BehaviorRules

**Files:**
- Modify: `src/foundation-types.ts:63-80`

- [ ] **Step 1: Add the field**

In `src/foundation-types.ts`, add `coordinator_agent` to the `BehaviorRules` interface after `coordinator_model`:

```typescript
  /** Model used by the coordinator agent. */
  coordinator_model: string;
  /** Agent name that runs the coordinator loop. Defaults to "ellie" for backward compat. */
  coordinator_agent?: string;
```

- [ ] **Step 2: Commit**

```bash
git add src/foundation-types.ts
git commit -m "[MAX] feat: add coordinator_agent field to BehaviorRules type"
```

---

### Task 2: Create Max's soul document

**Files:**
- Create: `/home/ellie/obsidian-vault/soul/max-soul.md`

- [ ] **Step 1: Write Max's soul**

Create `/home/ellie/obsidian-vault/soul/max-soul.md`:

```markdown
# Max — Soul File

> Max is the behind-the-scenes coordinator. Dave never talks to Max directly — Dave talks to Ellie. Max's job is to route efficiently and synthesize results in Ellie's voice.

---

## Core Identity

**Max is a calm, structured coordinator who stays out of the way.**

Max is not a personality — he's infrastructure. His job:

- **Route fast** — identify the right specialist and dispatch immediately
- **Stay invisible** — Dave should never feel like he's talking to a router
- **Synthesize in Ellie's voice** — all responses to Dave must sound like Ellie wrote them
- **Be efficient** — minimize iterations, dispatch in parallel when possible
- **Know when to bring Ellie in** — general conversation, partnership, brainstorming, emotional support, celebration — dispatch to Ellie

---

## Routing Principles

### When to dispatch to Ellie (specialist)

- General conversation, greetings, catch-ups
- Partnership discussions — "what should we build next?"
- Brainstorming and ideation
- Emotional support, celebration, encouragement
- Anything where the relationship matters more than the task
- When Dave is venting, thinking out loud, or processing

### When to dispatch to specialists

- Code tasks → James
- Research → Kate
- Strategy → Alan
- Code review/criticism → Brian
- Ops/deployment → Jason
- Content creation → Amy
- Finance → Marcus

### When to handle directly (no dispatch)

- Simple status checks via read_context
- Routing decisions that need no specialist
- Quick lookups from Forest/Plane/memory

---

## Response Synthesis

When synthesizing specialist results into a final response:

1. **Channel Ellie's voice** — warm, conversational, uses "we" framing, celebrates progress
2. **Use forest vocabulary naturally** — trees, branches, groves, seeds
3. **Be concise but complete** — respect Dave's time and attention
4. **Connect to context** — reference what Dave is working on, what matters to him
5. **Never sound robotic** — Max's synthesis should be indistinguishable from Ellie talking directly

---

## What Max Never Does

- Introduces himself — Dave doesn't know Max exists
- Uses cold/corporate language in responses
- Over-explains routing decisions
- Dispatches when a simple read_context would suffice
- Skips Ellie for conversations that need warmth
```

- [ ] **Step 2: Verify the file exists**

```bash
cat /home/ellie/obsidian-vault/soul/max-soul.md | head -5
```

Expected: The first 5 lines of Max's soul file.

- [ ] **Step 3: Commit**

```bash
git -C /home/ellie/obsidian-vault add soul/max-soul.md
git -C /home/ellie/obsidian-vault commit -m "Add Max coordinator soul document"
```

Note: The obsidian-vault may not be a git repo (it's Syncthing-managed). If the commit fails, skip — the file is already in place.

---

### Task 3: Update foundation-registry with `getCoordinatorAgent()` and new prompt

**Files:**
- Modify: `src/foundation-registry.ts:41-262`

- [ ] **Step 1: Add DEFAULT_BEHAVIOR coordinator_agent**

In `src/foundation-registry.ts`, update the `DEFAULT_BEHAVIOR` constant (around line 41) to include `coordinator_agent`:

```typescript
const DEFAULT_BEHAVIOR: BehaviorRules = {
  approvals: {},
  proactivity: "medium",
  tone: "helpful and concise",
  escalation: "Ask the user when uncertain about scope or intent.",
  max_loop_iterations: 50,
  cost_cap_session: 50,
  cost_cap_daily: 200,
  coordinator_model: "claude-sonnet-4-6",
  coordinator_agent: "max",
};
```

- [ ] **Step 2: Add `getCoordinatorAgent()` method**

Add this method to the `FoundationRegistry` class, after `getRecipes()` (around line 178):

```typescript
  /** Return the coordinator agent name from the active foundation. Defaults to "max". */
  getCoordinatorAgent(): string {
    return this.getBehavior().coordinator_agent ?? "max";
  }
```

- [ ] **Step 3: Update `getCoordinatorPrompt()` for Max**

Replace the coordinator prompt generation (lines 222-261) — the return statement inside `getCoordinatorPrompt()`. The method signature and everything before the return stays the same. Replace:

```typescript
    return `You are Ellie, Dave's coordinator assistant. You manage a team of specialist agents. Your job: understand what Dave needs, dispatch the right specialists, and synthesize their results into a clear response.
```

With:

```typescript
    const coordinatorAgent = this.getCoordinatorAgent();

    return `You are ${coordinatorAgent === "max" ? "Max, Dave's behind-the-scenes coordinator" : `${coordinatorAgent}, Dave's coordinator assistant`}. You manage a team of specialist agents.${coordinatorAgent === "max" ? " Dave talks to Ellie — not you. Your job: route efficiently, dispatch the right specialists, and synthesize results in Ellie's voice (warm, conversational, uses 'we' framing, forest vocabulary, celebrates progress)." : " Your job: understand what Dave needs, dispatch the right specialists, and synthesize their results into a clear response."}

## IMPORTANT: Ellie is a specialist
When Dave wants general conversation, partnership, brainstorming, emotional support, or when the relationship matters more than the task — dispatch to **ellie**. She is Dave's friend and partner. Do NOT handle these yourself — Ellie's voice and warmth are irreplaceable.
```

The rest of the prompt (Foundation, Tools, When To Do What, Specialists, Recipes, Communication Style sections) stays exactly the same.

- [ ] **Step 4: Run existing tests**

```bash
cd /home/ellie/ellie-dev && bun test tests/coordinator.test.ts
```

Expected: Tests should still pass (they don't hardcode "ellie" in assertions).

- [ ] **Step 5: Commit**

```bash
git add src/foundation-registry.ts
git commit -m "[MAX] feat: add getCoordinatorAgent() and update coordinator prompt for Max"
```

---

### Task 4: Make coordinator.ts use configurable agent name

**Files:**
- Modify: `src/coordinator.ts`

This task replaces 7 hardcoded `"ellie"` references with a dynamic coordinator agent name.

- [ ] **Step 1: Add `coordinatorAgent` to CoordinatorOpts**

In `src/coordinator.ts`, add to the `CoordinatorOpts` interface (around line 61-86):

```typescript
export interface CoordinatorOpts {
  message: string;
  channel: string;
  userId: string;
  foundation: string;
  systemPrompt: string;
  model: string;
  agentRoster: string[];
  deps: CoordinatorDeps;
  registry?: FoundationRegistry;
  coordinatorAgent?: string;  // NEW: defaults to "max"
  maxIterations?: number;
  sessionTimeoutMs?: number;
  costCapUsd?: number;
  workItemId?: string;
  resumeState?: CoordinatorPausedState;
  _testResponses?: Array<{
    stop_reason: string;
    content: Array<Record<string, unknown>>;
    usage: { input_tokens: number; output_tokens: number };
  }>;
  _apiCallFn?: () => Promise<{
    stop_reason: string;
    content: Array<Record<string, unknown>>;
    usage: { input_tokens: number; output_tokens: number };
  }>;
}
```

- [ ] **Step 2: Resolve effective coordinator agent in runCoordinatorLoop**

In `runCoordinatorLoop()`, after the existing destructuring (around line 139-151), add:

```typescript
  const effectiveCoordinatorAgent = opts.coordinatorAgent
    ?? opts.registry?.getCoordinatorAgent()
    ?? "max";
```

- [ ] **Step 3: Replace hardcoded "ellie" on line 184 (envelope creation)**

Change:

```typescript
    agent: "ellie",
```

To:

```typescript
    agent: effectiveCoordinatorAgent,
```

- [ ] **Step 4: Replace hardcoded "ellie" on line 393 (formatQuestionMessage agentName)**

Change:

```typescript
          agentName: "ellie",
```

To:

```typescript
          agentName: "ellie",  // Always display as Ellie (she's the face)
```

This one stays as `"ellie"` — it's the display name Dave sees. Leave it unchanged.

- [ ] **Step 5: Replace hardcoded "ellie" on line 415 (GTD question item createdBy)**

Change:

```typescript
              createdBy: "ellie",
```

To:

```typescript
              createdBy: effectiveCoordinatorAgent,
```

- [ ] **Step 6: Replace hardcoded "ellie" on line 451 (paused state questionMetadata agentName)**

Change:

```typescript
            agentName: "ellie",
```

To:

```typescript
            agentName: "ellie",  // Display name stays Ellie
```

This one also stays — it's the display name. Leave unchanged.

- [ ] **Step 7: Replace hardcoded "ellie" on line 494 (GTD orchestration parent createdBy)**

Change:

```typescript
            createdBy: "ellie",
```

To:

```typescript
            createdBy: effectiveCoordinatorAgent,
```

- [ ] **Step 8: Replace hardcoded "ellie" on line 547 (GTD dispatch child createdBy)**

Change:

```typescript
                createdBy: "ellie",
```

To:

```typescript
                createdBy: effectiveCoordinatorAgent,
```

- [ ] **Step 9: Replace hardcoded "ellie" on line 735 (defensive ask_user handler agentName)**

Change:

```typescript
        agentName: "ellie",
```

To:

```typescript
        agentName: "ellie",  // Display name stays Ellie
```

Leave unchanged — display name.

- [ ] **Step 10: Update buildCoordinatorDeps working memory references**

In `buildCoordinatorDeps()` (around lines 1145-1187), the working memory calls use `agent: "ellie"`. These should use the coordinator agent. Add a `coordinatorAgent` parameter to the `buildCoordinatorDeps` options:

Find the function signature for `buildCoordinatorDeps` and add `coordinatorAgent?: string` to its options. Then replace the 4 occurrences of `agent: "ellie"` within it:

Line 1145:
```typescript
      const record = await readWorkingMemory({ session_id: sessionId, agent: coordinatorAgent });
```

Line 1169:
```typescript
      const record = await readWorkingMemory({ session_id: sessionId, agent: coordinatorAgent });
```

Line 1179:
```typescript
      await update({ session_id: sessionId, agent: coordinatorAgent, sections });
```

Line 1187:
```typescript
          body: JSON.stringify({ session_id: sessionId, agent: coordinatorAgent }),
```

Where `coordinatorAgent` is resolved from the function parameter, defaulting to `"max"`.

- [ ] **Step 11: Run tests**

```bash
cd /home/ellie/ellie-dev && bun test tests/coordinator.test.ts
```

Expected: PASS

- [ ] **Step 12: Commit**

```bash
git add src/coordinator.ts
git commit -m "[MAX] refactor: make coordinator agent configurable, replace hardcoded ellie references"
```

---

### Task 5: Update telegram-handlers.ts

**Files:**
- Modify: `src/telegram-handlers.ts:684-719`

- [ ] **Step 1: Update the runCoordinatorLoop call**

Around line 684, update the call to pass `coordinatorAgent` and update the fallback prompt:

Change the fallback prompt on line 690 from:

```typescript
        systemPrompt: (foundationRegistry ? await foundationRegistry.getCoordinatorPrompt() : null) || "You are Ellie, a coordinator for Dave. You manage a team of specialist agents. When a request needs specialist capabilities, ALWAYS dispatch the right agent using dispatch_agent. Check each agent's skills in the roster to match the right agent to the task. For greetings or simple chat, use complete directly.",
```

To:

```typescript
        coordinatorAgent: foundationRegistry?.getCoordinatorAgent() || "max",
        systemPrompt: (foundationRegistry ? await foundationRegistry.getCoordinatorPrompt() : null) || "You are Max, Dave's behind-the-scenes coordinator. Dave talks to Ellie — not you. Route efficiently, dispatch specialists, synthesize results in Ellie's voice. For general conversation or partnership, dispatch to ellie. For specialist tasks, dispatch the right agent.",
```

- [ ] **Step 2: Keep the display name as "ellie"**

Line 719 already sends as `"ellie"`:
```typescript
      const cleanedResponse = await sendWithApprovals(ctx, coordinatorResult.response, session.sessionId, "ellie");
```

This stays unchanged. Ellie is the face.

- [ ] **Step 3: Update buildCoordinatorDeps call**

Pass `coordinatorAgent` to `buildCoordinatorDeps` on line 693:

```typescript
        deps: buildCoordinatorDeps({
          sessionId: session.sessionId,
          channel: "telegram",
          coordinatorAgent: foundationRegistry?.getCoordinatorAgent() || "max",
          sendFn: async (_ch, msg) => { await ctx.reply(msg); },
```

- [ ] **Step 4: Commit**

```bash
git add src/telegram-handlers.ts
git commit -m "[MAX] feat: pass coordinator agent to coordinator loop in telegram handler"
```

---

### Task 6: Update ellie-chat-handler.ts

**Files:**
- Modify: `src/ellie-chat-handler.ts:1229-1291`

- [ ] **Step 1: Update the runCoordinatorLoop call**

Around line 1229, add `coordinatorAgent` and update the fallback prompt:

Change line 1235 from:

```typescript
            systemPrompt: (foundationRegistry ? await foundationRegistry.getCoordinatorPrompt() : null) || "You are Ellie, a coordinator for Dave. Dispatch specialists for capabilities you don't have.",
```

To:

```typescript
            coordinatorAgent: foundationRegistry?.getCoordinatorAgent() || "max",
            systemPrompt: (foundationRegistry ? await foundationRegistry.getCoordinatorPrompt() : null) || "You are Max, Dave's behind-the-scenes coordinator. Dave talks to Ellie — not you. Route efficiently, dispatch specialists, synthesize results in Ellie's voice.",
```

- [ ] **Step 2: Keep display names as "ellie"**

Lines 1276 and 1291 send as `agent: "ellie"` — these stay unchanged. Ellie is the face.

- [ ] **Step 3: Update buildCoordinatorDeps if used**

Check if `ellie-chat-handler.ts` builds its own coordinator deps and pass `coordinatorAgent` there too. Follow the same pattern as Task 5 Step 3.

- [ ] **Step 4: Commit**

```bash
git add src/ellie-chat-handler.ts
git commit -m "[MAX] feat: pass coordinator agent to coordinator loop in ellie-chat handler"
```

---

### Task 7: Update foundation seed — add Ellie as specialist, Max as coordinator

**Files:**
- Modify: `seeds/supabase/002_foundations.sql`

- [ ] **Step 1: Add Ellie to the software-dev agent roster**

In the software-dev foundation's agents JSON array (after marcus, before the closing `]`), add:

```json
    ,{
      "name": "ellie",
      "role": "partner",
      "model": "claude-sonnet-4-6",
      "tools": [
        "forest_bridge_read", "forest_bridge_write",
        "plane_mcp", "memory_extraction", "qmd_search",
        "brave_web_search", "google_workspace"
      ],
      "prompt_key": "soul"
    }
```

- [ ] **Step 2: Add `coordinator_agent` to the behavior JSON**

In the software-dev foundation's behavior JSON, add `coordinator_agent`:

```json
  {
    "proactivity": "high",
    "tone": "direct/technical",
    "escalation": "block_and_ask",
    "max_loop_iterations": 10,
    "cost_cap_session": 2.00,
    "cost_cap_daily": 20.00,
    "coordinator_model": "claude-sonnet-4-6",
    "coordinator_agent": "max"
  }
```

- [ ] **Step 3: Add Ellie and coordinator_agent to life-management foundation too**

Add `"coordinator_agent": "max"` to the life-management behavior JSON. Add Ellie as a specialist in that roster too (same definition as above).

- [ ] **Step 4: Add coordinator_agent to small-business foundation**

Add `"coordinator_agent": "max"` to the small-business behavior JSON. Add Ellie as a specialist there too.

- [ ] **Step 5: Apply the seed**

```bash
cd /home/ellie/ellie-dev && bun run seed
```

Or manually run:
```bash
psql -U ellie -d ellie-forest -f seeds/supabase/002_foundations.sql
```

Note: The seed is applied to Supabase, not local Postgres. If `bun run seed` doesn't handle Supabase seeds, use the Supabase MCP or SQL editor.

- [ ] **Step 6: Commit**

```bash
git add seeds/supabase/002_foundations.sql
git commit -m "[MAX] data: add Ellie as specialist agent, set Max as coordinator in all foundations"
```

---

### Task 8: Update tests

**Files:**
- Modify: `tests/coordinator-mode-wiring.test.ts`

- [ ] **Step 1: Update agent assertion in coordinator-mode-wiring test**

Line 477 asserts `expect(responseMsg!.agent).toBe("ellie")` — this should remain `"ellie"` because the test checks the display agent, which is still Ellie. Verify and leave unchanged.

Line 500-501 checks for typing messages with `agent: "ellie"` — also display-level, leave unchanged.

- [ ] **Step 2: Run all coordinator tests**

```bash
cd /home/ellie/ellie-dev && bun test tests/coordinator.test.ts tests/coordinator-tools.test.ts tests/coordinator-context.test.ts tests/coordinator-cost-cap.test.ts tests/coordinator-mode-wiring.test.ts
```

Expected: All PASS. If any fail due to the changes, fix the specific assertion.

- [ ] **Step 3: Run full test suite**

```bash
cd /home/ellie/ellie-dev && bun test
```

Expected: No regressions.

- [ ] **Step 4: Commit any test fixes**

```bash
git add tests/
git commit -m "[MAX] test: update coordinator tests for configurable coordinator agent"
```

---

### Task 9: Restart and verify

- [ ] **Step 1: Restart the relay**

```bash
systemctl --user restart claude-telegram-relay
```

- [ ] **Step 2: Check logs for startup**

```bash
journalctl --user -u claude-telegram-relay --since "1 min ago" | head -30
```

Expected: No errors. Foundation registry loads with `coordinator_agent: "max"`.

- [ ] **Step 3: Send a test message via Telegram**

Send "hey Ellie, how's it going?" via Telegram. Expected:
- Max routes this to Ellie (specialist) since it's general conversation
- Response comes back in Ellie's voice
- Dave sees "ellie" as the sender

- [ ] **Step 4: Send a task message via Telegram**

Send "can you check the status of ELLIE-5?" via Telegram. Expected:
- Max handles this via read_context (no dispatch needed for a simple lookup)
- Response synthesized in Ellie's voice

- [ ] **Step 5: Final commit if any adjustments needed**

```bash
git add -A && git commit -m "[MAX] fix: post-deploy adjustments"
```
