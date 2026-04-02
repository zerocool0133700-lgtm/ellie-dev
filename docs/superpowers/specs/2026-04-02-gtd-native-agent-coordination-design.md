# GTD-Native Agent Coordination — Enhanced

**Date:** 2026-04-02
**Status:** Draft (revised after team review)
**Inspired by:** [Optio](https://github.com/jonwiggins/optio) dispatch trees + per-task answer boxes, [Orloj](https://github.com/OrlojHQ/orloj) reconciliation loops + typed message envelopes
**Builds on:** ELLIE-1150, ELLIE-1151, ELLIE-1152, ELLIE-1153, ELLIE-1154

## Problem

Multi-agent coordination through Telegram chat has three failure modes:

1. **Post-dispatch amnesia** — agents return results but the coordinator loses track after context compaction. GTD orchestration items exist (ELLIE-1152) but aren't used as the recovery source during working memory rebuild.
2. **Ask/resume brittleness** — answers don't always land cleanly, or the coordinator resumes with stale context. The in-memory ask-user queue (`ask-user-queue.ts`) has no structured metadata about what the agent actually needs.
3. **Question multiplexing collisions** — when multiple agents ask questions simultaneously, they arrive as a serial stream in Telegram. Dave's answer to agent A gets attributed to agent B. One question can overwrite another. Questions are sometimes poorly framed, making answers ambiguous when fed back into the loop.

Separately, visibility is fragmented. The `/dispatches` page exists but isn't integrated into the GTD kanban workflow. Agent activity is tracked across the in-memory orchestration tracker, dispatch envelopes, orchestration_events (Forest), and GTD items (Supabase) — with no single view that ties them together.

## Current State

Significant infrastructure already exists:

**Supabase `todos` table** (ELLIE-1151) already has:
- `parent_id` (UUID) — tree structure for orchestration
- `dispatch_envelope_id` (TEXT) — links to relay dispatch envelopes
- `is_orchestration` (BOOLEAN) — marks orchestration items
- `urgency` (TEXT) — 'blocking' | 'normal' | 'low'
- `metadata` (JSONB) — stores answers via `metadata.answer`
- `assigned_agent`, `assigned_to`, `created_by` — agent/user assignment
- Status constraint includes: 'inbox', 'open', 'waiting_for', 'someday', 'done', 'cancelled', 'failed', 'timed_out'

**`gtd-orchestration.ts`** (ELLIE-1152) implements:
- 3-level tree: `createOrchestrationParent()` → `createDispatchChild()` → `createQuestionItem()`
- `getActiveOrchestrationTrees()` — returns tree structures for UI

**Atomic DB operations** (ELLIE-1154):
- `check_parent_completion_atomic()` — serialized parent status updates
- `answer_question_atomic()` — writes `metadata.answer`, marks done, checks parent
- `cancel_item_cascade()` — recursive cancellation
- `update_item_status_atomic()` — status + metadata merge + parent check

**API endpoints** (ELLIE-1153):
- `GET /api/dispatches/active` — returns dispatch trees (50 most recent, urgency-sorted)
- `POST /api/dispatches/answer` — answer a question by item ID
- `POST /api/dispatches/cancel` — cascade cancel
- `GET /api/dispatches/badge` — count of items needing attention

**In-memory ask-user queue** (`ask-user-queue.ts`, ELLIE-1267):
- `enqueueQuestion()` / `answerQuestion()` with promise-based resolution
- 5-minute timeout per question

**orchestration_events table** (Forest DB):
- Append-only audit trail: dispatched, heartbeat, progress, completed, failed, cancelled, retried, timeout
- Fields: `run_id`, `event_type`, `agent_type`, `work_item_id`, `payload` (JSONB)

**Working memory** (ELLIE-538/539):
- 7-section session-scoped document surviving context compression
- `context_anchors` section already stores answer routing data
- Three-tier compaction: hot (messages) → warm (working memory) → cold (Forest snapshots)

## Solution

This spec proposes **targeted enhancements** to the existing infrastructure, not a rebuild:

1. Add `item_type` enum for cleaner item classification (replacing boolean `is_orchestration`)
2. Add structured question metadata to the existing `metadata` column
3. Enforce mandatory "what I need from you" fields on every agent question
4. Wire context compaction recovery through working memory (not a parallel system)
5. Add Telegram question disambiguation with short IDs
6. Build kanban integration and Agent Questions page in ellie-home
7. Write progress events to the existing `orchestration_events` table (not a per-item activity log)

## Data Model Changes

### New: `item_type` column (Postgres enum)

Add to `todos` table as a Postgres enum, replacing the boolean `is_orchestration`:

```sql
CREATE TYPE todo_item_type AS ENUM ('task', 'agent_dispatch', 'agent_question', 'approval');
ALTER TABLE todos ADD COLUMN item_type todo_item_type NOT NULL DEFAULT 'task';

-- Migrate existing data
UPDATE todos SET item_type = 'agent_dispatch' WHERE is_orchestration = true AND assigned_to != 'dave';
UPDATE todos SET item_type = 'agent_question' WHERE is_orchestration = true AND assigned_to = 'dave' AND urgency IS NOT NULL;
```

This is strictly better than `is_orchestration` boolean — it distinguishes dispatch items from questions from approvals without querying `assigned_to` or `urgency`.

### Enhanced: `metadata` column conventions

No new column. Use the existing `metadata` JSONB column with structured conventions for question items:

```json
{
  "answer": "Use JWT",
  "answered_at": "2026-04-02T12:07:00Z",
  "answered_via": "dashboard",
  "question_id": "q-7f3a2b",
  "what_i_need": "Pick one. This decides the session store implementation and whether we need Redis.",
  "decision_unlocked": "Session store implementation approach",
  "answer_format": "choice",
  "choices": ["JWT", "Session cookies"]
}
```

The `answer` field already exists (written by `answer_question_atomic()`). The new fields (`question_id`, `what_i_need`, `decision_unlocked`, `answer_format`, `choices`) are additive — old question items without them continue to work.

### Existing fields used as-is

| Field | Already exists | Used for |
|---|---|---|
| `parent_id` | Yes | Tree structure (3 levels) |
| `dispatch_envelope_id` | Yes | Links to relay envelope |
| `assigned_agent` | Yes | Which agent (james/kate/alan) |
| `assigned_to` | Yes | 'dave' for questions, agent name for dispatches |
| `urgency` | Yes | 'blocking' for critical questions |
| `metadata` | Yes | Structured question/answer data |

### No activity_log column

Progress events go to the existing `orchestration_events` table in Forest DB. This avoids:
- Write amplification from JSONB array appends on a hot table
- Row-level contention when multiple agents update simultaneously
- JSONB bloat on the todos table

The orchestration_events table is purpose-built for append-only event streams with its own `run_id` grouping.

### Item type → kanban column mapping

| item_type | Created by | Kanban column | Card appearance |
|---|---|---|---|
| `task` | Dave (manual) | inbox → open → waiting → done | Normal GTD card |
| `agent_dispatch` | Coordinator on dispatch | open → done/cancelled | Agent avatar, colored left border, progress bar |
| `agent_question` | Agent via ask_user | waiting_for | Agent avatar, question text, "What I need" box, answer controls |
| `approval` | Agent needing tool approval | waiting_for | Agent avatar, approve/deny buttons |

## Coordinator Enhancements (Relay Side)

### Mandatory question metadata

Update the `ask_user` tool definition in `coordinator-tools.ts` to require structured fields:

```typescript
{
  name: 'ask_user',
  input_schema: {
    type: 'object',
    required: ['question', 'what_i_need', 'decision_unlocked'],
    properties: {
      question: { type: 'string' },
      what_i_need: { type: 'string', description: 'What format/decision you need from Dave' },
      decision_unlocked: { type: 'string', description: 'What you will do once answered' },
      answer_format: { enum: ['text', 'choice', 'approve_deny'], default: 'text' },
      choices: { type: 'array', items: { type: 'string' } }
    }
  }
}
```

If Claude omits `what_i_need` or `decision_unlocked`, the tool call returns a validation error and Claude must retry. This ensures every question Dave sees is actionable.

### GTD question creation with metadata

When `ask_user` is called, `createQuestionItem()` in `gtd-orchestration.ts` now passes the structured metadata:

```typescript
await createQuestionItem(supabase, {
  parent_id: agentDispatchItemId,
  content: question,
  assigned_to: 'dave',
  urgency: 'blocking',
  metadata: {
    question_id: generateShortId(), // e.g. "q-7f3a"
    what_i_need: toolInput.what_i_need,
    decision_unlocked: toolInput.decision_unlocked,
    answer_format: toolInput.answer_format ?? 'text',
    choices: toolInput.choices ?? null
  }
})
```

### Progress events to orchestration_events

Instead of a per-item `activity_log`, the relay writes condensed progress events to the existing `orchestration_events` table in Forest:

```typescript
await insertOrchestrationEvent({
  run_id: dispatchEnvelopeId,
  event_type: 'progress',
  agent_type: 'james',
  work_item_id: ticketId,
  payload: { phase: 'reading', detail: 'src/auth-middleware.ts' }
})
```

Events are already grouped by `run_id` (which maps to `dispatch_envelope_id` on the todo). The dashboard queries by `run_id` to build the activity timeline for a given dispatch card.

### Context compaction recovery via working memory

**Who triggers:** The `CoordinatorContext` class, during its existing compaction handler (warm/hot/critical pressure levels).

**How it integrates:** After compaction, the coordinator calls a new function `rebuildDispatchStateFromGTD()` that:

1. Queries `getActiveOrchestrationTrees()` for this session's coordinator parent item
2. Formats the tree state into a structured summary
3. Writes it to the working memory `task_stack` section via the existing `PATCH /api/working-memory/update` endpoint

```typescript
async function rebuildDispatchStateFromGTD(
  sessionId: string, 
  coordinatorParentId: string
): Promise<void> {
  const trees = await getActiveOrchestrationTrees(supabase)
  const thisSession = trees.find(t => t.id === coordinatorParentId)
  if (!thisSession) return

  const summary = formatDispatchSummary(thisSession)
  // e.g. "ACTIVE: james (auth middleware, waiting q-7f3a), kate (query optimization, 70%)\nPENDING: q-7f3a: JWT or session cookies?"
  
  await updateWorkingMemory(sessionId, 'coordinator', {
    task_stack: summary,
    context_anchors: formatPendingAnswers(thisSession)
  })
}
```

This feeds into the existing working memory system — no parallel recovery mechanism. The coordinator's system prompt already reads working memory sections, so the dispatch state is automatically available after compaction.

## Answer Routing

### By question_id (primary mechanism)

Every question gets a short ID (e.g. `q-7f3a`) stored in `metadata.question_id`. Answers are routed by this ID regardless of source.

**Dashboard path:**
- Click choice button or type answer → `POST /api/dispatches/answer` with `{ question_item_id, answer_text }`
- The existing `answer_question_atomic()` writes `metadata.answer`, marks done, checks parent
- **Enhancement:** Also write `metadata.answered_at` and `metadata.answered_via: 'dashboard'`
- Relay resolves the pending promise in the ask-user queue, coordinator resumes

**Telegram path:**
- Each question in Telegram is tagged: `"james asks (q-7f3a): Should the auth..."`
- Single pending question → route directly (no change from today)
- Multiple pending questions → Ellie disambiguates:
  - Checks if reply starts with agent name prefix: "james: use JWT"
  - Otherwise asks: "Is this for james (q-7f3a) or kate (q-8b2c)?"
  - If still ambiguous: "I have 2 questions waiting — easier to answer on the dashboard: [link]"
- Once resolved, same `POST /api/dispatches/answer` path, `answered_via: 'telegram'`

### Error handling

**Double-answer:** `answer_question_atomic()` checks status before writing. If already `done`, returns an error. Dashboard shows "Already answered" toast. Telegram: Ellie says "That question was already answered."

**Timeout:** The in-memory ask-user queue has a 5-minute timeout. When it fires:
- GTD item status updated to `timed_out` via `update_item_status_atomic()`
- Orchestration event logged
- Coordinator receives timeout error as tool result, can re-ask or proceed without answer

**Routing failure:** If Telegram can't resolve which question an answer belongs to, the answer is NOT written anywhere. Ellie asks for clarification or redirects to dashboard. No data loss, no misrouting.

## Dashboard UI

### Kanban integration (ellie-home gtd-kanban.vue)

Agent items appear on the existing 4-column kanban. The kanban currently fetches `GET /api/todos?limit=200` — this continues to work. The UI changes are in card rendering:

- **`item_type = 'agent_dispatch'`** cards: colored left border per agent (james=cyan, kate=purple, alan=red), agent avatar, progress indicator. Progress comes from most recent `orchestration_events` for that `dispatch_envelope_id`.
- **`item_type = 'agent_question'`** cards in Waiting column: question text, amber "What I need from you" box (from `metadata.what_i_need`), answer controls based on `metadata.answer_format` (choice buttons, text input, or approve/deny).
- **`item_type = 'agent_dispatch'` in Done**: cost/token summary from dispatch envelope, faded.
- Click any agent card → expand to show `orchestration_events` timeline for that `dispatch_envelope_id`.

Existing agent filter dropdown works — filter by `assigned_agent`.

### Agent Questions queue (new page: /agent-questions)

Dedicated focused view:

- **Data source:** `GET /api/dispatches/active` (already returns trees with questions) + `GET /api/dispatches/badge` for counts
- **Filter tabs:** Waiting (badge count), Answered today, All
- **Cards sorted oldest first** — longest-waiting agent first
- **Each card:** agent avatar + name, parent task context ("working on: ..."), question text, "What I need from you" box, answer controls
- **Choice questions:** tappable buttons per choice + free-text fallback
- **Yes/no decisions:** green/red styled buttons
- **Answered questions:** collapsed, showing answer + channel
- **Activity timeline:** expandable, from `orchestration_events` via `dispatch_envelope_id`
- **Answer action:** `POST /api/dispatches/answer` (existing endpoint)

### Sidebar navigation

- New "Agent Questions" entry in sidebar under Work section
- Amber pulsing badge from `GET /api/dispatches/badge` (existing endpoint, already returns `needs_attention` count)
- Badge visible from any page via Supabase Realtime subscription on `todos` table (existing `useRealtime.ts`)

### Real-time updates

All via existing Supabase Realtime on `todos` table:
- Kanban cards update live as agent items change status
- Badge count updates in real-time
- No new WebSocket infrastructure

## What This Keeps vs. Replaces

### Keeps (operational layer)
- **In-memory orchestration tracker** — sub-millisecond heartbeat/stale detection for process health. GTD queries can't match this latency. Tracker handles operational concerns (is the process alive?), GTD handles coordination concerns (what's the status?).
- **In-memory ask-user queue** — promise-based resolution for the coordinator loop. GTD is the persistence layer, but the in-memory queue is the signaling mechanism.
- **Dispatch envelopes** — cost/token tracking remains here.
- **orchestration_events table** — append-only audit trail, now also used for dashboard activity timelines.

### Replaces
- **`is_orchestration` boolean** → `item_type` enum (more expressive, no need to infer type from other fields)
- **Unstructured question text** → structured metadata with `what_i_need`, `decision_unlocked`, `answer_format`
- **Telegram-only answer path** → dashboard + Telegram with disambiguation
- **Context compaction blind spot** → working memory rebuild from GTD state

## Migration Strategy

### Schema migration (Supabase)

```sql
-- 1. Add item_type enum
CREATE TYPE todo_item_type AS ENUM ('task', 'agent_dispatch', 'agent_question', 'approval');
ALTER TABLE todos ADD COLUMN item_type todo_item_type NOT NULL DEFAULT 'task';

-- 2. Backfill from existing data
UPDATE todos SET item_type = 'agent_question'
  WHERE is_orchestration = true AND assigned_to = 'dave' AND urgency IS NOT NULL;
UPDATE todos SET item_type = 'agent_dispatch'
  WHERE is_orchestration = true AND item_type = 'task';

-- 3. Index for kanban queries
CREATE INDEX idx_todos_item_type ON todos (item_type) WHERE item_type != 'task';

-- 4. is_orchestration stays for now (backward compat), deprecated
COMMENT ON COLUMN todos.is_orchestration IS 'DEPRECATED: use item_type instead. Will be removed in future migration.';
```

### Code migration (relay)

1. Update `gtd-orchestration.ts` to set `item_type` on creation (alongside `is_orchestration` for backward compat)
2. Update `coordinator-tools.ts` with mandatory `what_i_need` / `decision_unlocked` fields
3. Add `rebuildDispatchStateFromGTD()` to coordinator-context compaction handler
4. Update Telegram question formatting to include short question IDs
5. Add disambiguation logic to relay message handler

### Dashboard migration (ellie-home)

1. Update `gtd-kanban.vue` card rendering to check `item_type`
2. Add new `/agent-questions` page consuming existing `/api/dispatches/*` endpoints
3. Add sidebar badge using existing `/api/dispatches/badge`
4. Add orchestration_events timeline component (new API endpoint needed: `GET /api/dispatches/:id/events` proxying to Forest)

## Scope & Non-Goals

**In scope:**
- `item_type` enum migration + backfill
- Structured question metadata in existing `metadata` column
- Mandatory `what_i_need` / `decision_unlocked` on `ask_user`
- Context compaction recovery via working memory update
- Telegram question ID tagging and disambiguation
- Kanban UI for agent cards and inline answers
- Agent Questions page with structured answer forms
- Sidebar badge with real-time count
- Activity timeline from orchestration_events

**Not in scope (future work):**
- Removing `is_orchestration` column (keep for backward compat this cycle)
- Agent-to-agent communication without coordinator (ELLIE-785 agentmail)
- Chrome extension side panel
- Full Orloj-style reconciliation loop
- Orloj-style message bus (NATS/JetStream)
- Tool approval UI beyond approve/deny buttons
- Drag-to-reorder on kanban
- Removing in-memory orchestration tracker (keeps operational role)
