# Coordinator Visibility — Design Spec (v3 Final)

**Tickets:** ELLIE-1141, ELLIE-1148
**Date:** 2026-03-30
**Status:** Final — revised after two rounds of team review (Alan, Brian)

## Problem

When Ellie orchestrates multi-agent work, nobody can see what's happening. Dave loses track of what he asked Ellie to do. Ellie loses track of what she dispatched because her conversation history gets compacted. Agent questions and tool approvals get buried in ellie-chat. The existing orchestration system (`orchestration-tracker.ts`, `orchestration-ledger.ts`, `orchestration-dispatch.ts`) uses in-memory state that's lost on restart and a separate event ledger that doesn't integrate with task management. Multi-agent systems fail in interesting ways that need explicit handling.

## Solution

**GTD replaces the orchestration system as the single source of truth.** The existing orchestration tracker/ledger/dispatch/monitor modules are deprecated in favor of GTD-backed orchestration. Ellie creates parent GTD items for orchestration requests and sub-items for each agent dispatch. A Chrome extension side panel provides persistent visibility. WebSocket pushes real-time updates.

## What GTD Replaces

| Existing Module | What It Did | GTD Replacement |
|----------------|-------------|-----------------|
| `orchestration-tracker.ts` | In-memory active run tracking, heartbeats, staleness | GTD item status + `orchestration-monitor.ts` (already monitors GTD) |
| `orchestration-ledger.ts` | `orchestration_events` table in Forest DB | GTD items + `routing_decisions` table (from ELLIE-1132) for historical replay |
| `orchestration-dispatch.ts` | Tracked dispatch wrapper with locking + queue | Coordinator creates GTD items directly; locking via `parent_id` uniqueness |
| `orchestration-init.ts` | Startup recovery of orphaned runs | GTD orphan recovery (query open items on startup) |
| `dispatch-queue.ts` | In-memory per-work-item FIFO queue | GTD parent-child ordering |

**What stays:**
- `orchestration-monitor.ts` — already monitors GTD tasks for stalls. Expanded to cover orchestration items.
- `dispatch-envelope.ts` — continues tracking cost/tokens per dispatch. GTD items reference envelope IDs.
- `routing_decisions` table — continues capturing routing transparency (ELLIE-1132). The `/orchestrator` page reads from this for historical replay.
- `/orchestrator` page — coexists as historical session replay (reads `routing_decisions`, not the deprecated tracker)

**State mapping:**

| Old State (tracker) | GTD Status | When |
|---------------------|-----------|------|
| running | `open` | Agent actively working |
| stale | `open` (with elapsed time warning) | Agent hasn't heartbeated |
| completed | `done` | Agent finished successfully |
| failed | `failed` | Agent errored |
| timeout | `timed_out` | Exceeded staleness threshold |
| cancelled | `cancelled` | Manually cancelled |

## Architecture Overview

**Five components:**

1. **GTD schema updates** — `parent_id`, `created_by`, `is_orchestration`, `urgency`, extended status values
2. **GTD orchestration API** — tree queries, structured answer routing, auto-completion, staleness, orphan recovery
3. **GTD skill update** — teaches Ellie orchestration patterns, recovery, narration
4. **Dispatches page** (`/dispatches`) — real-time dashboard via WebSocket
5. **Chrome extension** — side panel loading `/dispatches` with badge count

**Telegram** is notification-only — narration of key moments. All interaction happens through the dispatches page / side panel.

## Component 1: GTD Schema Updates

### Modified Table: `todos` (Supabase)

```sql
ALTER TABLE todos ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES todos(id);
ALTER TABLE todos ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS is_orchestration BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS urgency TEXT CHECK (urgency IN ('blocking', 'normal', 'low'));
ALTER TABLE todos ADD COLUMN IF NOT EXISTS dispatch_envelope_id TEXT;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

CREATE INDEX idx_todos_parent ON todos(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX idx_todos_created_by ON todos(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX idx_todos_orchestration ON todos(is_orchestration) WHERE is_orchestration = true;
```

- `parent_id` — links sub-items to parent. No enforced depth limit — UI renders any depth, API validates known patterns.
- `created_by` — who created this item. Validated at API level against known agent names + "dave".
- `is_orchestration` — separates orchestration items from personal GTD. Personal views filter `WHERE is_orchestration = false`. Dispatches page filters `WHERE is_orchestration = true`.
- `urgency` — `blocking` (agent can't continue without this), `normal` (default), `low`. Blocking items surface first in the dispatches panel.
- `dispatch_envelope_id` — links to `dispatch_envelope.id` for cost/token tracking.
- `metadata` — JSONB for answers, error details, agent context. Avoids schema bloat for flexible data.

### Extended Status Values

```sql
-- Existing: inbox, open, waiting_for, someday, done, cancelled
-- Add: failed, timed_out
```

| Status | Meaning |
|--------|---------|
| `open` | Active — agent is working on it |
| `waiting_for` | Blocked — waiting on another person/agent |
| `done` | Completed successfully |
| `failed` | Agent crashed or errored out |
| `timed_out` | Exceeded staleness threshold |
| `cancelled` | Manually cancelled |

### Orchestration Hierarchy

```
Parent: "Review + test ELLIE-1124"
  is_orchestration: true, assigned_to: ellie, created_by: dave, status: open
  │
  ├─ Child: "Critique architecture"
  │    is_orchestration: true, assigned_agent: critic, created_by: ellie
  │    dispatch_envelope_id: dsp_abc123
  │    │
  │    └─ Grandchild: "Should auth module be in scope?"
  │         is_orchestration: true, assigned_to: dave, created_by: brian
  │         urgency: blocking
  │
  └─ Child: "Write tests"
       is_orchestration: true, assigned_agent: dev, created_by: ellie
       dispatch_envelope_id: dsp_def456
```

## Component 2: GTD Orchestration API

### GTD Write Points in the Dispatch Chain

Exactly where GTD items get created/updated in the existing code:

1. **`coordinator-tools.ts` → `dispatch_agent` handler:** Before calling the specialist, create the child GTD item (`is_orchestration: true`, `assigned_agent`, `parent_id`). Store the returned GTD item ID.
2. **`coordinator-tools.ts` → `dispatch_agent` result:** After specialist returns, update the child GTD item status (`done` or `failed`). Store result summary in `metadata`.
3. **`coordinator-tools.ts` → `ask_user` handler:** Create a grandchild GTD item (`assigned_to: dave`, `urgency: blocking`, `parent_id: agent's item`).
4. **`coordinator.ts` → loop start:** If first dispatch in this conversation, create the parent GTD item. Subsequent dispatches link to it via `parent_id`.
5. **`coordinator.ts` → on compaction:** Read active GTD items (`assigned_to: ellie, is_orchestration: true, status: open`) and inject summary into working memory `task_stack`.

### Structured Answer Routing

Answers from Dave are routed via **working memory context anchors**, not synthetic string messages.

When Dave answers a question via the dispatches panel:
1. `POST /api/dispatches/answer` with `{ question_item_id, answer_text }`
2. Backend marks the question GTD item as `done` with `metadata: { answer: answer_text }`
3. Backend writes to the coordinator's working memory `context_anchors`:
   ```json
   {
     "type": "agent_answer",
     "question_item_id": "uuid",
     "parent_item_id": "uuid",
     "agent": "brian",
     "question": "Should auth module be in scope?",
     "answer": "Yes, include auth"
   }
   ```
4. Backend sends a brief notification to ellie-chat: "Dave answered Brian's question" — this nudges the coordinator to check working memory on the next turn.
5. The coordinator reads `context_anchors`, finds the structured answer, and routes it to the correct agent. Survives compaction because working memory is persistent.

### Auto-Completion of Parent Items

When any child item's status changes, the API runs `checkParentCompletion()` inside a database transaction to prevent race conditions from concurrent child completions:

```sql
-- Atomic check: lock parent row, check all children, update if terminal
UPDATE todos SET status = CASE
  WHEN (SELECT bool_and(status IN ('done','failed','timed_out','cancelled'))
        FROM todos WHERE parent_id = $parent_id) THEN
    CASE WHEN (SELECT bool_and(status = 'done')
               FROM todos WHERE parent_id = $parent_id) THEN 'done'
    ELSE 'waiting_for'
    END
  ELSE status
END
WHERE id = $parent_id AND is_orchestration = true;
```

- All children `done` → parent `done`
- Any child `failed`/`timed_out` → parent `waiting_for` (Ellie needs to decide: retry or report)

### Staleness Detection

Merged into existing `orchestration-monitor.ts` (already polls GTD every 60s with adaptive thresholds):

| Condition | Threshold | Action |
|-----------|-----------|--------|
| Agent dispatch `open`, no updates | 30 min (configurable per agent type) | Mark `timed_out`, notify Dave |
| User question `open` | No auto-timeout | Show elapsed time, surface as `blocking` |
| Parent with all children terminal | Immediate | Auto-complete (transaction above) |

Existing adaptive thresholds from the monitor are preserved: dev/strategy agents get longer (8-10 min before warning), ops agents shorter (2 min). These escalate before the hard 30-min timeout.

### Orphan Recovery

On relay startup (already wired in ELLIE-1148 `overnight/init.ts`), scan for orphaned orchestration items:

1. Query: `SELECT * FROM todos WHERE is_orchestration = true AND status IN ('open', 'waiting_for') AND updated_at < NOW() - INTERVAL '2 hours'`
2. For each orphan: timeout stale children, run `checkParentCompletion()`
3. Log recovered count

When Ellie starts a fresh session:
- GTD skill instructs her to read active orchestration items first
- Items with `timed_out` or `failed` children need her attention
- She reports status to Dave or retries

### Cancel Flow

`POST /api/dispatches/cancel` with `{ item_id }`:
1. Mark the item as `cancelled`
2. Cascade: mark all open children as `cancelled`
3. Run `checkParentCompletion()` on the parent

### New API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `GET /api/dispatches/active` | GET | Active orchestration trees |
| `POST /api/dispatches/answer` | POST | Submit answer `{ question_item_id, answer_text }` |
| `POST /api/dispatches/cancel` | POST | Cancel item + children `{ item_id }` |
| `GET /api/dispatches/approvals` | GET | Pending tool approvals (proxy to relay) |
| `POST /api/dispatches/approve` | POST | Approve tool `{ approval_id }` (proxy to relay's existing approval API) |
| `POST /api/dispatches/deny` | POST | Deny tool `{ approval_id }` (proxy to relay's existing approval API) |
| `GET /api/dispatches/badge` | GET | Badge count `{ needs_attention: number }` |

### Active Dispatches Response Schema

```typescript
interface DispatchTree {
  id: string;
  content: string;
  status: string;
  created_by: string;
  assigned_to: string;
  assigned_agent: string | null;
  urgency: string | null;
  created_at: string;
  elapsed_ms: number;
  dispatch_envelope_id: string | null;
  metadata: Record<string, unknown>;
  children: DispatchTree[];  // recursive — any depth
}
```

Sort: `urgency = 'blocking'` first, then by `created_at` descending. Only return trees where at least one item is not terminal.

### Tool Approval Proxying

`/api/dispatches/approve` and `/api/dispatches/deny` are thin proxies to the relay's existing `respondToApproval()` function (used by ellie-chat). Not a parallel system — same backend, different UI surface.

## Component 3: GTD Skill Update

### Updated Skill: `skills/gtd/SKILL.md`

New orchestration sections:

#### Orchestration Pattern

When coordinating multi-agent work:

1. **Create a parent item** for the overall request:
   - `POST /api/gtd/items` with `content`, `assigned_to: "ellie"`, `created_by: "ellie"`, `is_orchestration: true`
   - Link to ticket via `source_ref: "ELLIE-XXX"` if applicable

2. **Create sub-items** for each agent dispatch:
   - `POST /api/gtd/items` with `parent_id`, `assigned_agent`, `assigned_to: {agent_name}`, `created_by: "ellie"`, `is_orchestration: true`
   - Set `dispatch_envelope_id` after dispatch completes

3. **When an agent has a question for Dave:**
   - Create sub-item: `parent_id: {agent_item}`, `assigned_to: "dave"`, `created_by: {agent}`, `urgency: "blocking"` if the agent can't continue without the answer, `"normal"` otherwise
   - Narrate: "Brian has a question — check the dispatch panel"

4. **When Dave answers** (appears in working memory `context_anchors`):
   - Read the structured answer from `context_anchors`
   - Route the answer to the correct agent using the `question_item_id` and `parent_item_id`
   - Resume the agent's work

5. **Track completion:**
   - Parent auto-completes at API level — don't track this yourself
   - When you see your parent item is `done`, synthesize results and respond to Dave
   - When parent is `waiting_for` (some children failed), report status and ask Dave whether to retry or skip

6. **Recovery after compaction or fresh session:**
   - Read: `GET /api/gtd/items?assigned_to=ellie&is_orchestration=true&status=open`
   - For each parent, check children to see what's in flight
   - `timed_out` / `failed` children need your attention
   - This is your source of truth — not the conversation history

#### Narration Pattern

Proactively narrate via `update_user`:
- "Dispatching Brian (critique) and James (tests)."
- "Brian has a blocking question — check the dispatch panel."
- "James is done. Still waiting on Brian."
- "Brian's dispatch timed out. Retry or skip?"
- "All done. Here's the synthesis..."

### Coordinator Changes

1. **`coordinator-tools.ts`:** `dispatch_agent` handler creates GTD child item before dispatch, updates status after
2. **`coordinator-tools.ts`:** `ask_user` handler creates GTD grandchild item assigned to Dave
3. **`coordinator.ts`:** On compaction, read active GTD orchestration items into working memory `task_stack`
4. **`coordinator.ts`:** On loop start, check `context_anchors` for pending answers from Dave

## Component 4: Dispatches Page (`/dispatches`)

### Real-Time Updates via WebSocket

Connects to the relay's **ellie-chat WebSocket server** (same one the dashboard already uses for agent monitor events). New event types:

```typescript
// Server → Client
{ type: "dispatch_update", tree: DispatchTree }
{ type: "dispatch_child_update", item: DispatchTree }
{ type: "approval_pending", approval: ToolApproval }
{ type: "approval_resolved", id: string }
```

The relay broadcasts these when GTD orchestration items change. Falls back to 10-second polling if WebSocket disconnects.

Authentication: same as existing ellie-chat WebSocket — the dashboard already authenticates via the `x-bridge-key` header on WS connection.

### Layout

**Needs Your Attention (top, orange section):**
- `urgency: blocking` questions with inline answer box
- Tool approvals with Approve / Deny buttons
- Notification sound when new blocking items arrive

**Active Dispatches:**
- Tree view with color-coded left borders:
  - **Green** — Ellie orchestrating (parent)
  - **Blue** — agent working
  - **Orange** — needs Dave's input
  - **Red** — failed or timed out
  - **Gray** — done
- Elapsed time per item with warning indicator at staleness threshold
- Cancel button on each active item
- Expand/collapse for completed sub-trees
- Multiple active parent items displayed simultaneously

**Bulk Actions Bar** (when failures exist):
- "Cancel all failed" — cancels all `failed` items
- "Retry timed out" — resets `timed_out` items to `open` for Ellie to re-dispatch

**Completed (collapsed by default):**
- Recently completed orchestration trees, faded

### Error/Offline Handling

- WebSocket disconnect: show "Reconnecting..." banner, fall back to polling
- Dashboard unreachable: Chrome extension shows "Dashboard offline" with retry button
- API errors: inline error messages per failed action, not page-level crashes

## Component 5: Chrome Extension Side Panel

### Extension Structure (Manifest V3)

```
ellie-dispatch-extension/
  manifest.json
  sidepanel.html      — iframe loading /dispatches
  background.js       — badge count polling
  icons/
```

### Authentication

The side panel loads `https://dashboard.ellie-labs.dev/dispatches` in an iframe. Dashboard runs behind Cloudflare tunnel on the same domain Dave is already authenticated on — the iframe inherits browser session cookies. The WebSocket inside the iframe authenticates the same way the main dashboard does (bridge key from the Nuxt server config).

### Badge Count

`background.js` polls `/api/dispatches/badge` every 10 seconds:
- `needs_attention > 0` → orange badge with count
- `needs_attention === 0` → no badge (clean)

### Offline Handling

When dashboard is unreachable:
- Badge shows "!" indicator
- Side panel content shows "Dashboard offline — retrying every 30s"
- Auto-reconnects when dashboard comes back

## Deprecation Plan

After GTD orchestration is validated:

| Module | Action | When |
|--------|--------|------|
| `orchestration-tracker.ts` | Remove — GTD items replace in-memory run tracking | After build phase 3 |
| `orchestration-ledger.ts` | Remove — `orchestration_events` table superseded by GTD items + `routing_decisions` | After build phase 3 |
| `orchestration-dispatch.ts` | Remove — coordinator creates GTD items directly | After build phase 3 |
| `orchestration-init.ts` | Merge recovery logic into GTD orphan recovery, then remove | After build phase 3 |
| `dispatch-queue.ts` | Remove — GTD parent-child ordering replaces in-memory queue | After build phase 3 |
| `OrchestrationPanel.vue` | Remove from dashboard layout | After build phase 5 |
| `/orchestrator` page | Keep — reads from `routing_decisions` for historical replay, independent of tracker | No change |

The `orchestration-monitor.ts` module stays but is expanded to cover orchestration GTD items alongside personal task stall detection.

## Build Order

1. **GTD schema** — `parent_id`, `created_by`, `is_orchestration`, `urgency`, `dispatch_envelope_id`, `metadata`, extended statuses
2. **GTD orchestration API** — tree queries, structured answer routing via working memory, auto-completion with transaction, staleness merged into monitor, orphan recovery, cancel cascade, badge count
3. **Coordinator integration** — GTD writes in `coordinator-tools.ts`, compaction recovery, `context_anchors` answer reading
4. **GTD skill update** — orchestration pattern, recovery, narration
5. **Dispatches page** — `/dispatches` with WebSocket, answer box, approvals, cancel, bulk actions, expand/collapse, notification sound
6. **Chrome extension** — side panel, badge count, offline handling
7. **Deprecation** — remove old orchestration modules after validation

### Acceptance Criteria

| Phase | Done When |
|-------|-----------|
| 1 | New columns exist, `is_orchestration` filter works, personal GTD views unaffected |
| 2 | Active tree query returns correct hierarchy, answer writes to working memory, auto-completion is transactional, staleness timeouts fire, orphans recovered on startup, cancel cascades |
| 3 | Ellie creates GTD items when dispatching, reads them after compaction, reads answers from `context_anchors`, multi-agent fan-out creates correct parent + children |
| 4 | Ellie uses orchestration pattern in a 2+ agent dispatch, recovers after simulated compaction |
| 5 | Real-time tree updates, inline answers reach coordinator, approvals work, cancel works, bulk actions work, notification sound fires |
| 6 | Side panel opens, badge count correct, offline handling works |
| 7 | Old modules removed, no regressions, `/orchestrator` replay still works |

## What This Does NOT Cover

- Telegram as an answer/interaction surface (notification-only — builds happen at the desktop)
- Automated retry of failed dispatches (manual via Ellie after Dave's decision)
- Mobile notifications
- Agent-to-agent communication without going through Ellie
- GTD weekly review changes (orchestration items are transient, filtered out of personal views)
