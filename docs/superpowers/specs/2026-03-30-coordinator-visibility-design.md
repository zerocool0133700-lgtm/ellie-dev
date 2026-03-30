# Coordinator Visibility — Design Spec (v2)

**Tickets:** ELLIE-1141, ELLIE-1148
**Date:** 2026-03-30
**Status:** Draft — revised after team review (Alan, Brian)

## Problem

When Ellie orchestrates multi-agent work, nobody can see what's happening. Dave loses track of what he asked Ellie to do. Ellie loses track of what she dispatched because her conversation history gets compacted. Agent questions and tool approvals get buried in ellie-chat. There's no persistent, shared view of orchestration state. Multi-agent systems fail in interesting ways — orphaned tasks, stuck dispatches, answers arriving after compaction — that need explicit handling.

## Solution

Use GTD as the single source of truth for all orchestration state. Ellie creates parent GTD items for orchestration requests and sub-items for each agent dispatch. A Chrome extension side panel provides persistent visibility across all Ellie Home pages — showing dispatch trees, agent questions, and tool approvals in one surface. WebSocket pushes real-time updates.

## Architecture Overview

**GTD is the nervous system.** Every dispatch, every agent question, every status change is a GTD item. Ellie reads GTD to know what's in flight. Dave reads GTD (via the side panel) to see what needs attention.

**Five components:**

1. **GTD schema updates** — `parent_id` and `created_by` columns + failure states
2. **GTD orchestration API** — tree queries, answer routing, auto-completion, staleness management
3. **GTD skill update** — teaches Ellie orchestration patterns, recovery, narration
4. **Dispatches page** (`/dispatches`) — real-time dashboard via WebSocket
5. **Chrome extension** — side panel loading `/dispatches` with badge count

**Telegram** is notification-only — narration of key moments ("Brian has a question"), never an interaction point. All answers and approvals happen through the dispatches page / side panel.

## Component 1: GTD Schema Updates

### Modified Table: `todos` (Supabase)

```sql
ALTER TABLE todos ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES todos(id);
ALTER TABLE todos ADD COLUMN IF NOT EXISTS created_by TEXT;

CREATE INDEX idx_todos_parent ON todos(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX idx_todos_created_by ON todos(created_by) WHERE created_by IS NOT NULL;
```

- `parent_id` — links sub-items to their parent. Max depth: 3 levels (parent → agent dispatch → user question). API enforces this limit.
- `created_by` — who created this item: `dave`, `ellie`, `brian`, `james`, etc. TEXT, not FK — validated at API level against known agent names.

### Extended Status Values

The existing `status` enum needs additional values for failure handling:

```sql
-- Add new status values (if using CHECK constraint, update it)
-- Existing: inbox, open, waiting_for, someday, done, cancelled
-- New: failed, timed_out
```

| Status | Meaning |
|--------|---------|
| `open` | Active — agent is working on it |
| `waiting_for` | Blocked — waiting on another person/agent |
| `done` | Completed successfully |
| `failed` | Agent crashed or errored out |
| `timed_out` | Exceeded staleness threshold with no progress |
| `cancelled` | Manually cancelled by Dave or Ellie |

### Orchestration Item Hierarchy (max 3 levels)

```
Level 1 — Parent: "Review + test ELLIE-1124"
  assigned_to: ellie, created_by: dave, status: open
  │
  ├─ Level 2 — Child: "Critique ELLIE-1124 architecture"
  │    assigned_agent: critic, assigned_to: brian, created_by: ellie, parent_id: ^
  │    │
  │    └─ Level 3 — Grandchild: "Should auth module be in scope?"
  │         assigned_to: dave, created_by: brian, parent_id: ^
  │
  └─ Level 2 — Child: "Write tests for ELLIE-1124"
       assigned_agent: dev, assigned_to: james, created_by: ellie, parent_id: ^
```

## Component 2: GTD Orchestration API

### New Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `GET /api/dispatches/active` | GET | Active orchestration trees with children |
| `POST /api/dispatches/answer` | POST | Submit Dave's answer to an agent question |
| `POST /api/dispatches/cancel` | POST | Cancel a stuck dispatch |
| `GET /api/dispatches/approvals` | GET | Pending tool approvals (proxy to relay) |
| `POST /api/dispatches/approve` | POST | Approve tool action (proxy to relay's existing approval API) |
| `POST /api/dispatches/deny` | POST | Deny tool action (proxy to relay's existing approval API) |

### Active Dispatches Response Schema

```typescript
interface DispatchTree {
  id: string;                    // parent GTD item ID
  content: string;               // task description
  status: string;                // open, done, failed, etc.
  created_by: string;            // who created it
  assigned_to: string;           // who owns it
  assigned_agent: string | null; // agent type
  created_at: string;
  elapsed_ms: number;            // time since creation
  children: DispatchChild[];     // agent dispatch sub-items
}

interface DispatchChild {
  id: string;
  content: string;
  status: string;
  assigned_agent: string;
  assigned_to: string;
  created_by: string;
  created_at: string;
  elapsed_ms: number;
  question: DispatchQuestion | null;  // grandchild if exists
}

interface DispatchQuestion {
  id: string;
  content: string;               // the question text
  assigned_to: string;           // "dave"
  created_by: string;            // agent who asked
  status: string;                // open = needs answer, done = answered
  created_at: string;
}
```

Sort: most recently created parent first. Only return trees where at least one item is not `done`/`cancelled`.

### Answer Flow

When Dave types an answer in the dispatch panel:

1. `POST /api/dispatches/answer` with `{ question_item_id: string, parent_dispatch_id: string, answer_text: string }`
2. Backend marks the question GTD item as `done` with answer stored in metadata: `{ answer: "..." }`
3. Backend sends answer to ellie-chat as a synthetic user message with full GTD context:
   `[Answer to brian's question (gtd:{question_item_id}, parent:{parent_dispatch_id}): "{answer_text}"]`
4. This re-enters the coordinator loop. Ellie can parse the GTD IDs to know exactly which dispatch this answer belongs to — survives compaction.
5. The parent agent item status updates back to `open` when Ellie re-dispatches.

### Tool Approval Proxying

The `/api/dispatches/approve` and `/api/dispatches/deny` endpoints are thin proxies to the relay's existing tool approval API (already used by ellie-chat). They are not a parallel system — they call the same `respondToApproval()` function. The dispatches page just gives them a different UI surface.

### Auto-Completion of Parent Items

When all children of a parent item reach a terminal state (`done`, `failed`, `timed_out`, `cancelled`), the parent is automatically updated:

- If all children are `done` → parent status = `done`
- If any child is `failed`/`timed_out` → parent status = `waiting_for` (needs Ellie's attention to retry or report)

This is implemented as an **API-level trigger** — when any child item status changes, the API checks sibling statuses and updates the parent. Not dependent on Ellie's memory.

```typescript
async function checkParentCompletion(parentId: string): Promise<void> {
  const children = await getChildItems(parentId);
  const allTerminal = children.every(c => ['done', 'failed', 'timed_out', 'cancelled'].includes(c.status));
  if (!allTerminal) return;

  const allDone = children.every(c => c.status === 'done');
  const newStatus = allDone ? 'done' : 'waiting_for';
  await updateItemStatus(parentId, newStatus);
}
```

### Staleness Detection and Cleanup

A periodic check (every 60 seconds) scans for stale orchestration items:

| Condition | Threshold | Action |
|-----------|-----------|--------|
| Agent dispatch `open` with no progress | 30 minutes | Mark as `timed_out`, notify Dave |
| User question `open` with no answer | No auto-timeout (Dave answers when ready) | Show elapsed time in UI |
| Parent item with all children terminal | Immediate | Auto-complete parent (see above) |

Stale items show elapsed time indicators in the UI: "working (4m)" → "working (32m ⚠️)" → "timed out (35m ✕)"

Manual cancel: Dave can cancel any item from the dispatches page. Cancelling a parent cancels all its open children.

### Orphan Recovery

On relay startup, the overnight init (already wired in ELLIE-1148) scans for orphaned orchestration items:

```typescript
async function recoverOrphanedDispatches(): Promise<number> {
  // Find open orchestration items (has children) that have been open > 2 hours
  // with no coordinator session active
  const orphans = await findOrphanedParents({ maxAge: 2 * 60 * 60 * 1000 });

  for (const orphan of orphans) {
    // Mark stale children as timed_out
    await timeoutStaleChildren(orphan.id, { maxAge: 30 * 60 * 1000 });
    // Check if parent should auto-complete
    await checkParentCompletion(orphan.id);
  }

  return orphans.length;
}
```

When Ellie starts a fresh session and finds open orchestration items she didn't create (orphans from a previous session):
- She reads them from GTD: `GET /api/gtd/items?assigned_to=ellie&status=open`
- If children are still `open`, she can re-dispatch or cancel
- If children are `timed_out`/`failed`, she reports the status to Dave
- The GTD skill teaches her this recovery pattern

## Component 3: GTD Skill Update

### Updated Skill: `skills/gtd/SKILL.md`

New sections added to the existing GTD skill:

#### Orchestration Pattern

When coordinating multi-agent work:

1. **Create a parent item** for the overall request:
   - `POST /api/gtd/items` with `content`, `assigned_to: "ellie"`, `created_by: "ellie"`, `source_ref: "ELLIE-XXX"` if ticket-linked
   - This is your tracking anchor — all dispatches link back to it

2. **Create sub-items** for each agent dispatch:
   - `POST /api/gtd/items` with `parent_id: {parent}`, `assigned_agent: "dev"`, `assigned_to: "james"`, `created_by: "ellie"`
   - Content describes the specific task for that agent
   - Max depth: 3 levels (parent → dispatch → question)

3. **When an agent has a question for Dave:**
   - Create a sub-item under the agent's item: `parent_id: {agent_item}`, `assigned_to: "dave"`, `created_by: {agent_name}`
   - Content is the question text
   - Use `update_user` to narrate: "Brian has a question about scope — check the dispatch panel"

4. **When Dave answers** (arrives as synthetic message with GTD IDs):
   - Parse the GTD IDs from the message: `[Answer to brian's question (gtd:{id}, parent:{id}): "..."]`
   - Resume the agent's work with the answer
   - The question item is already marked done by the dispatches API

5. **Track completion:**
   - Parent auto-completes when all children reach terminal state (API handles this)
   - When parent completes, synthesize results and respond to Dave

6. **Recovery after compaction or fresh session:**
   - Read your active GTD items: `GET /api/gtd/items?assigned_to=ellie&status=open`
   - For each parent with `parent_id IS NULL`, read children to see what's in flight
   - Items with `timed_out` or `failed` status need your attention — report to Dave or retry
   - This is your source of truth — not the conversation history

#### Narration Pattern

Proactively narrate key moments via `update_user`:
- "I'm dispatching Brian for the architecture critique and James for the tests."
- "Brian has a question for you — check the dispatch panel."
- "James is done with the tests. Still waiting on Brian."
- "Brian's dispatch timed out after 30 minutes. I'll try again or skip — what do you prefer?"
- "All agents are done. Here's the synthesis..."

### Coordinator Integration

The coordinator's dispatch flow changes:

1. **Before dispatch:** Create parent GTD item (if first dispatch in this request) and child item for the agent
2. **After dispatch completes:** Update child item status to `done` (API triggers parent check)
3. **On dispatch failure:** Update child item status to `failed` with error in metadata
4. **On compaction:** Read active GTD items to rebuild awareness. Inject summary into working memory `task_stack`
5. **On ask_user:** Create grandchild item assigned to Dave

## Component 4: Dispatches Page (`/dispatches`)

### Real-Time Updates via WebSocket

The dispatches page connects to the relay's existing WebSocket server. New event types:

```typescript
// Server → Client events
{ type: "dispatch_update", tree: DispatchTree }       // full tree refresh
{ type: "dispatch_child_update", child: DispatchChild } // single child changed
{ type: "approval_pending", approval: ToolApproval }   // new tool approval
{ type: "approval_resolved", id: string }              // approval answered
```

The relay broadcasts these events when GTD orchestration items change. Polling at 10 seconds as fallback if WebSocket disconnects.

### Layout

**Header:** "Dispatches" title + badge counts (active, needs you)

**Needs Your Attention (top, highlighted):**
- Agent questions with inline answer box
- Tool approvals with Approve / Deny buttons
- Orange left border, prominent placement

**Active Dispatches:**
- Tree view of each parent item with indented children
- Color-coded left borders:
  - **Green** — Ellie orchestrating (parent)
  - **Blue** — agent working
  - **Orange** — needs Dave's input
  - **Red** — failed or timed out
  - **Gray** — done
- Elapsed time per item: "4m", "32m ⚠️"
- Cancel button (✕) on each active item

**Completed (collapsed by default):**
- Recently completed orchestration trees, faded

**Empty state:** "No active dispatches. Ellie will create items here when orchestrating multi-agent work."

### API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `GET /api/dispatches/active` | GET | Active orchestration trees |
| `POST /api/dispatches/answer` | POST | Submit answer `{ question_item_id, parent_dispatch_id, answer_text }` |
| `POST /api/dispatches/cancel` | POST | Cancel item `{ item_id }` — cascades to children |
| `GET /api/dispatches/approvals` | GET | Pending tool approvals (proxy) |
| `POST /api/dispatches/approve` | POST | Approve tool `{ approval_id }` (proxy to relay) |
| `POST /api/dispatches/deny` | POST | Deny tool `{ approval_id }` (proxy to relay) |

## Component 5: Chrome Extension Side Panel

### Extension Structure (Manifest V3)

```
ellie-dispatch-extension/
  manifest.json       — side panel declaration, permissions
  sidepanel.html      — iframe loading /dispatches
  background.js       — badge count polling
  icons/              — extension icons (16, 48, 128)
```

### manifest.json

```json
{
  "manifest_version": 3,
  "name": "Ellie Dispatches",
  "version": "1.0",
  "description": "Ellie OS dispatch panel — see what agents are working on",
  "permissions": ["sidePanel"],
  "side_panel": {
    "default_path": "sidepanel.html"
  },
  "background": {
    "service_worker": "background.js"
  },
  "icons": {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  },
  "host_permissions": ["https://dashboard.ellie-labs.dev/*"]
}
```

### Authentication

The side panel loads `https://dashboard.ellie-labs.dev/dispatches` in an iframe. Since the dashboard runs behind Cloudflare tunnel on the same domain Dave is already authenticated on, the iframe inherits the browser's session cookies. No additional auth needed — it's the same origin as the dashboard tabs Dave already has open.

If future auth is added to the dashboard, the iframe will participate in the same cookie-based session automatically.

### Badge Count

`background.js` polls `https://dashboard.ellie-labs.dev/api/dispatches/badge` every 10 seconds:

```typescript
// Returns: { needs_attention: number }
```

Sets the extension badge text and color:
- `needs_attention > 0` → orange badge with count
- `needs_attention === 0` → no badge

### Why an iframe

The `/dispatches` page is a full Nuxt page. The extension just frames it:
- One codebase (not duplicated in the extension)
- Updates to `/dispatches` automatically appear in the extension
- Extension is a thin shell — ~30 lines of JS

## Build Order

1. **GTD schema** — add `parent_id`, `created_by`, extended status values
2. **GTD orchestration API** — tree queries, answer routing, auto-completion, staleness, orphan recovery, cancel
3. **Coordinator integration** — create GTD items on dispatch, read on compaction, parse answer messages
4. **GTD skill update** — orchestration pattern, recovery, narration instructions
5. **Dispatches page** — `/dispatches` with WebSocket real-time updates, answer box, approval buttons, cancel
6. **Chrome extension** — side panel shell + badge count

### Acceptance Criteria Per Phase

| Phase | Done When |
|-------|-----------|
| 1. Schema | `parent_id` and `created_by` columns exist, new status values work |
| 2. API | `/api/dispatches/active` returns correct tree structure, answer flow works end-to-end, stale items get timed out, parent auto-completes |
| 3. Coordinator | Ellie creates GTD items when dispatching, reads them after compaction, parses answer messages with GTD IDs |
| 4. Skill | Ellie correctly uses the orchestration pattern in a multi-agent dispatch scenario |
| 5. Dispatches page | Real-time tree updates via WebSocket, inline answers work, approvals work, cancel works |
| 6. Extension | Side panel opens on Ellie Home, badge shows correct count, iframe loads and interacts correctly |

## What This Does NOT Cover

- Telegram as an answer/interaction surface (notification-only by design — builds happen at the desktop)
- Historical orchestration replay (use existing `/orchestrator` session replay)
- Automated retry of failed dispatches (manual re-dispatch via Ellie)
- Mobile notification for "waiting on you" items
- Agent-to-agent communication without going through Ellie
- GTD weekly review changes (orchestration items are transient)
