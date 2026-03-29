# Cleanup & Polish — Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire safe-to-remove orchestration modules, add cost cap enforcement to the coordinator, build the small-business foundation, and mark deprecated modules for future removal.

**Architecture:** Phase 3 is conservative — we only delete modules with zero production importers. Modules still used in production (`intent-classifier`, `agentmail`, `agent-exchange`) get a deprecation marker and stay until the coordinator fully replaces their functionality. Cost cap enforcement uses the existing `creature-cost-tracker.ts` pricing data integrated into the coordinator's dispatch envelope tracking.

**Tech Stack:** Bun + TypeScript, Supabase, existing coordinator + foundation infrastructure from Phases 1-2.

---

## Scope Decision: What Gets Retired vs. Deprecated

| Module | Action | Reason |
|--------|--------|--------|
| `src/agent-request.ts` | **DELETE** | No production importers — only test utilities |
| `src/agent-delegations.ts` | **DELETE** | No production importers — only test file |
| `src/agentmail.ts` | **DEPRECATE** | Active `/api/agentmail/webhooks` endpoint in http-routes.ts |
| `src/agent-exchange.ts` | **DEPRECATE** | Used by `exchange-timeout-handler.ts` in production |
| `src/intent-classifier.ts` | **DEPRECATE** | Critical for relay startup + non-coordinator routing fallback |

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/agent-request.ts` | Delete | Retired — coordinator handles requests |
| `src/agent-delegations.ts` | Delete | Retired — coordinator delegates natively |
| `tests/agent-delegations.test.ts` | Delete | Tests for retired module |
| `tests/dev-critic-review.test.ts` | Modify | Remove imports from retired modules |
| `src/agentmail.ts` | Modify | Add deprecation header |
| `src/agent-exchange.ts` | Modify | Add deprecation header |
| `src/intent-classifier.ts` | Modify | Add deprecation header |
| `src/coordinator.ts` | Modify | Add cost cap enforcement with daily tracking |
| `seeds/supabase/002_foundations.sql` | Modify | Add small-business foundation |
| `tests/coordinator-cost-cap.test.ts` | Create | Tests for cost cap enforcement |

---

### Task 1: Retire agent-request.ts and agent-delegations.ts

**Files:**
- Delete: `src/agent-request.ts`
- Delete: `src/agent-delegations.ts`
- Delete: `tests/agent-delegations.test.ts`
- Modify: `tests/dev-critic-review.test.ts`

- [ ] **Step 1: Check for any other importers we might have missed**

Run: `cd /home/ellie/ellie-dev && grep -rn "agent-request\|agent-delegations" src/ tests/ --include="*.ts" | grep -v "node_modules" | grep -v ".test.ts"`

Verify the only production results are the files themselves (self-references). If any unexpected importers appear, STOP and report.

- [ ] **Step 2: Remove imports from dev-critic-review.test.ts**

Read `tests/dev-critic-review.test.ts` and remove the imports of `_resetAgentRequestsForTesting` from `agent-request.ts` and `_resetExchangesForTesting` from `agent-exchange.ts`. Also remove any `beforeEach`/`afterEach` calls to these reset functions. Keep the rest of the test file intact — it may test other things.

If the test file ONLY tests agent-request/exchange/delegation functionality and has no other value, delete the entire file instead.

- [ ] **Step 3: Delete the retired modules**

```bash
cd /home/ellie/ellie-dev
rm src/agent-request.ts
rm src/agent-delegations.ts
rm tests/agent-delegations.test.ts
```

- [ ] **Step 4: Verify no build errors**

Run: `cd /home/ellie/ellie-dev && bun test tests/coordinator.test.ts tests/foundation-registry.test.ts 2>&1 | tail -5`

The coordinator tests should still pass. If any import errors appear from the deleted files, fix them.

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-dev && git add -A && git commit -m "chore: retire agent-request.ts and agent-delegations.ts — coordinator replaces both"
```

---

### Task 2: Mark Deprecated Modules

**Files:**
- Modify: `src/agentmail.ts`
- Modify: `src/agent-exchange.ts`
- Modify: `src/intent-classifier.ts`

- [ ] **Step 1: Add deprecation header to agentmail.ts**

Add at the very top of `src/agentmail.ts`, before existing comments:

```typescript
/**
 * @deprecated ELLIE-COORDINATOR: This module is deprecated and will be removed
 * when the coordinator loop fully replaces inter-agent communication.
 * The coordinator passes context between agents directly — agentmail is no longer
 * needed for new workflows. Kept for the /api/agentmail/webhooks endpoint.
 * Target removal: Phase 4 (after webhook migration to coordinator).
 */
```

- [ ] **Step 2: Add deprecation header to agent-exchange.ts**

Add at the very top of `src/agent-exchange.ts`:

```typescript
/**
 * @deprecated ELLIE-COORDINATOR: This module is deprecated and will be removed
 * when the coordinator loop fully replaces agent collaboration.
 * The coordinator mediates agent-to-agent work directly.
 * Kept for exchange-timeout-handler.ts dependency.
 * Target removal: Phase 4 (after timeout handler migration to coordinator).
 */
```

- [ ] **Step 3: Add deprecation header to intent-classifier.ts**

Add at the very top of `src/intent-classifier.ts`:

```typescript
/**
 * @deprecated ELLIE-COORDINATOR: This module is deprecated and will be removed
 * when COORDINATOR_MODE becomes the permanent default.
 * The coordinator IS the classifier — it decomposes and routes using the Messages API.
 * Kept for: relay startup (initClassifier), non-coordinator fallback path,
 * and the ExecutionMode type used by orchestrator-types/costs/workflow-templates.
 * Target removal: Phase 4 (after ExecutionMode type migration + coordinator-only mode).
 */
```

- [ ] **Step 4: Commit**

```bash
cd /home/ellie/ellie-dev && git add src/agentmail.ts src/agent-exchange.ts src/intent-classifier.ts && git commit -m "chore: mark agentmail, agent-exchange, intent-classifier as deprecated"
```

---

### Task 3: Cost Cap Enforcement

**Files:**
- Modify: `src/coordinator.ts`
- Create: `tests/coordinator-cost-cap.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/coordinator-cost-cap.test.ts
import { describe, test, expect } from "bun:test";
import {
  runCoordinatorLoop,
  type CoordinatorDeps,
} from "../src/coordinator";

function createMockDeps(overrides?: Partial<CoordinatorDeps>): CoordinatorDeps {
  return {
    callSpecialist: overrides?.callSpecialist ?? (async (agent, task) => ({
      agent,
      status: "completed" as const,
      output: `${agent} done`,
      tokens_used: 500,
      duration_ms: 1000,
    })),
    sendMessage: async () => {},
    readForest: async () => "",
    readPlane: async () => "",
    readMemory: async () => "",
    readSessions: async () => "",
    getWorkingMemorySummary: async () => "",
    updateWorkingMemory: async () => {},
    promoteToForest: async () => {},
    logEnvelope: async () => {},
  };
}

describe("Coordinator cost cap enforcement", () => {
  test("session cost cap triggers safety rail", async () => {
    // Set a very low cost cap ($0.001) — even one API call should exceed it
    const result = await runCoordinatorLoop({
      message: "Do lots of work",
      channel: "test",
      userId: "test",
      foundation: "test",
      systemPrompt: "You are a test coordinator.",
      model: "claude-sonnet-4-6",
      agentRoster: ["james"],
      deps: createMockDeps(),
      costCapUsd: 0.001,
      _testResponses: [
        // First iteration — coordinator dispatches
        {
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: "tu_1", name: "dispatch_agent", input: { agent: "james", task: "work" } },
          ],
          usage: { input_tokens: 50000, output_tokens: 5000 }, // ~$0.225 at sonnet rates
        },
        // Second iteration — should not be reached due to cost cap
        {
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: "tu_2", name: "complete", input: { response: "Done" } },
          ],
          usage: { input_tokens: 5000, output_tokens: 100 },
        },
      ],
    });

    expect(result.hitSafetyRail).toBe(true);
    expect(result.response).toContain("cost");
    expect(result.loopIterations).toBeLessThanOrEqual(2);
  });

  test("totalCostUsd is computed correctly in result", async () => {
    const result = await runCoordinatorLoop({
      message: "Quick task",
      channel: "test",
      userId: "test",
      foundation: "test",
      systemPrompt: "You are a test coordinator.",
      model: "claude-sonnet-4-6",
      agentRoster: ["james"],
      deps: createMockDeps(),
      _testResponses: [
        {
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: "tu_1", name: "complete", input: { response: "Done" } },
          ],
          usage: { input_tokens: 1000, output_tokens: 100 },
        },
      ],
    });

    expect(result.totalCostUsd).toBeGreaterThan(0);
    // Sonnet: 1000 input tokens = $0.003, 100 output = $0.0015
    expect(result.totalCostUsd).toBeLessThan(0.01);
  });

  test("cost includes specialist dispatch envelopes", async () => {
    const result = await runCoordinatorLoop({
      message: "Dispatch and complete",
      channel: "test",
      userId: "test",
      foundation: "test",
      systemPrompt: "You are a test coordinator.",
      model: "claude-sonnet-4-6",
      agentRoster: ["james"],
      deps: createMockDeps(),
      _testResponses: [
        {
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: "tu_1", name: "dispatch_agent", input: { agent: "james", task: "work" } },
          ],
          usage: { input_tokens: 5000, output_tokens: 200 },
        },
        {
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: "tu_2", name: "complete", input: { response: "All done" } },
          ],
          usage: { input_tokens: 6000, output_tokens: 100 },
        },
      ],
    });

    // Should have at least 2 envelopes: coordinator + specialist
    expect(result.envelopes.length).toBeGreaterThanOrEqual(2);
    expect(result.response).toBe("All done");
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `cd /home/ellie/ellie-dev && bun test tests/coordinator-cost-cap.test.ts`

The coordinator already has cost cap logic from Phase 1 — these tests may already pass. If they do, great — mark as verified. If they fail, fix the coordinator.

- [ ] **Step 3: Verify cost cap logic in coordinator.ts**

Read `src/coordinator.ts` and verify:
1. The cost cap check happens at the start of each iteration (before the API call)
2. `computeCost` is called with the current `totalTokensIn` and `totalTokensOut`
3. The result's `totalCostUsd` includes both coordinator and specialist envelope costs
4. The safety rail message mentions "cost"

If the cost check uses `computeCost(model, totalTokensIn, totalTokensOut)` — this only tracks coordinator API costs, not specialist costs. For a more accurate total, sum all envelope costs:
```typescript
const currentCost = envelopes.reduce((sum, e) => sum + e.cost_usd, 0) + computeCost(effectiveModel, totalTokensIn, totalTokensOut);
```

Make this change if needed.

- [ ] **Step 4: Run tests to verify**

Run: `cd /home/ellie/ellie-dev && bun test tests/coordinator-cost-cap.test.ts tests/coordinator.test.ts`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-dev && git add src/coordinator.ts tests/coordinator-cost-cap.test.ts && git commit -m "feat: add cost cap enforcement tests and verify coordinator tracking"
```

---

### Task 4: Small Business Foundation

**Files:**
- Modify: `seeds/supabase/002_foundations.sql`

- [ ] **Step 1: Add small-business foundation to the seed file**

Append to `seeds/supabase/002_foundations.sql`, after the life-management INSERT:

```sql
-- Small Business Foundation
DELETE FROM foundations WHERE name = 'small-business';

INSERT INTO foundations (name, description, icon, version, agents, recipes, behavior, active)
VALUES (
  'small-business',
  'Small business management — finances, content, scheduling, client outreach',
  'briefcase',
  1,
  '[
    {"name": "marcus", "role": "finance", "tools": ["plane_mcp", "forest_bridge_read", "forest_bridge_write", "memory_extraction", "transaction_import", "receipt_parsing"], "model": "claude-sonnet-4-6"},
    {"name": "amy", "role": "content", "tools": ["google_workspace", "forest_bridge_read", "qmd_search", "brave_web_search", "memory_extraction"], "model": "claude-sonnet-4-6"},
    {"name": "scheduler", "role": "calendar", "tools": ["google_workspace", "forest_bridge", "memory_extraction"], "model": "claude-sonnet-4-6"},
    {"name": "outreach", "role": "client-comms", "tools": ["google_workspace", "brave_web_search", "forest_bridge", "memory_extraction"], "model": "claude-sonnet-4-6"}
  ]'::jsonb,
  '[
    {"name": "invoice-review", "pattern": "pipeline", "steps": ["marcus", "outreach"], "trigger": "monthly or on request"},
    {"name": "social-post", "pattern": "pipeline", "steps": ["amy", "outreach"], "trigger": "on request"},
    {"name": "monthly-pnl", "pattern": "fan-out", "agents": ["marcus", "scheduler"], "trigger": "first of month"}
  ]'::jsonb,
  jsonb_build_object(
    'approvals', jsonb_build_object('send_email', 'always_confirm', 'spending', 'always_confirm', 'client_comms', 'always_confirm', 'tracking', 'auto', 'plane_update', 'auto'),
    'proactivity', 'high',
    'tone', 'professional, clear, action-oriented',
    'escalation', 'flag and continue',
    'max_loop_iterations', 8,
    'cost_cap_session', 1.50,
    'cost_cap_daily', 15.00,
    'coordinator_model', 'claude-sonnet-4-6'
  ),
  false
);
```

- [ ] **Step 2: Apply to database**

Run:
```bash
source .env && curl -s -X POST "https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query" \
  -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"query\": $(cat seeds/supabase/002_foundations.sql | tr '\n' ' ' | jq -Rs .)}"
```

- [ ] **Step 3: Verify all three foundations exist**

Run:
```bash
source .env && curl -s -X POST "https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query" \
  -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"query": "SELECT name, active, jsonb_array_length(agents) as agent_count FROM foundations ORDER BY name;"}'
```

Expected: Three rows — life-management (4 agents), small-business (4 agents), software-dev (7 agents, active)

- [ ] **Step 4: Commit**

```bash
cd /home/ellie/ellie-dev && git add seeds/supabase/002_foundations.sql && git commit -m "feat: add small-business foundation (4 agents, 3 recipes)"
```

---

### Task 5: End-to-End Validation

- [ ] **Step 1: Run all tests**

Run: `cd /home/ellie/ellie-dev && bun test tests/coordinator.test.ts tests/coordinator-cost-cap.test.ts tests/coordinator-tools.test.ts tests/coordinator-context.test.ts tests/dispatch-envelope.test.ts tests/foundation-registry.test.ts tests/foundation-types.test.ts`
Expected: All pass

- [ ] **Step 2: Restart relay**

Run: `systemctl --user restart claude-telegram-relay`

- [ ] **Step 3: Test /foundation list**

In Ellie Chat, send: `/foundation list`
Expected: Three foundations listed — software-dev (active), life-management, small-business

- [ ] **Step 4: Test small-business foundation**

Send: `/foundation small-business`
Expected: Switches to small-business with 4 agents (marcus, amy, scheduler, outreach)

- [ ] **Step 5: Test coordinator uses small-business agents**

Send a message about invoicing or content. Verify logs show small-business agents.

- [ ] **Step 6: Switch back and verify**

Send: `/foundation software-dev`
Verify: Back to the full dev team.

---

## Summary

| Task | What It Does | Risk |
|------|-------------|------|
| 1 | Delete agent-request.ts + agent-delegations.ts | Low — no production importers |
| 2 | Deprecation headers on 3 modules | Zero — comments only |
| 3 | Cost cap enforcement tests | Low — verifying existing behavior |
| 4 | Small-business foundation seed | Low — additive DB change |
| 5 | End-to-end validation | Zero — testing only |

**Total:** 2 files deleted, 3 deprecated, 1 test file created, 1 seed updated, 5 commits.
