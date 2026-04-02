# GTD-Native Agent Coordination — Enhanced

**Date:** 2026-04-02
**Status:** Draft (revised after two team reviews)
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
5. Add Telegram question disambiguation with reply-to and short IDs
6. Build kanban integration and Agent Questions page in ellie-home
7. Write progress events to the existing `orchestration_events` table (not a per-item activity log)

## Phasing

Per Alan's recommendation, ship in two phases to validate the structured-question approach before adding Telegram polish.

**Phase 1 — Structured Questions + Dashboard Answer UI:**
- `item_type` enum migration + backfill
- Mandatory question metadata (`what_i_need`, `decision_unlocked`) on `ask_user`
- Answer bridge: dashboard → Supabase → in-memory queue resolution
- Context compaction recovery via working memory
- Agent Questions page in ellie-home with inline answer UI
- Sidebar badge

**Phase 2 — Telegram Disambiguation + Kanban Polish:**
- Telegram question ID tagging and disambiguation algorithm
- Kanban agent card rendering with progress indicators
- Activity timeline from orchestration_events
- `GET /api/dispatches/:id/events` endpoint

## Data Model Changes

### New: `item_type` column (Postgres enum)

Add to `todos` table as a Postgres enum, replacing the boolean `is_orchestration`:

```sql
CREATE TYPE todo_item_type AS ENUM ('task', 'agent_dispatch', 'agent_question');
ALTER TABLE todos ADD COLUMN item_type todo_item_type NOT NULL DEFAULT 'task';

-- Backfill from existing data (3 cases)
UPDATE todos SET item_type = 'agent_question'
  WHERE is_orchestration = true AND assigned_to = 'dave' AND urgency IS NOT NULL;
UPDATE todos SET item_type = 'agent_question'
  WHERE is_orchestration = true AND assigned_to = 'dave' AND urgency IS NULL;
UPDATE todos SET item_type = 'agent_dispatch'
  WHERE is_orchestration = true AND item_type = 'task';

-- Index for kanban queries
CREATE INDEX idx_todos_item_type ON todos (item_type) WHERE item_type != 'task';

-- Deprecate is_orchestration
COMMENT ON COLUMN todos.is_orchestration IS 'DEPRECATED: use item_type instead. Remove after all code paths use item_type AND no queries reference is_orchestration (target: 2 weeks after deploy).';
```

Note: `approval` type removed from this spec. Tool approval workflows are a separate concern with different lifecycle requirements. If needed, `approval` can be added to the enum later without migration (Postgres enums support `ADD VALUE`).

**`is_orchestration` removal criteria:** Remove the column when (1) all relay code paths set `item_type` instead of `is_orchestration`, (2) all dashboard queries filter by `item_type` instead of `is_orchestration`, (3) no Supabase Realtime subscriptions reference the column, and (4) at least 2 weeks have passed since deploy with no issues. Target: 2 weeks post-deploy.

### Enhanced: `metadata` column conventions

No new column. Use the existing `metadata` JSONB column with structured conventions for question items:

```json
{
  "answer": "Use JWT",
  "answered_at": "2026-04-02T12:07:00Z",
  "answered_via": "dashboard",
  "question_id": "q-7f3a2b1c",
  "what_i_need": "Pick one. This decides the session store implementation and whether we need Redis.",
  "decision_unlocked": "Session store implementation approach",
  "answer_format": "choice",
  "choices": ["JWT", "Session cookies"]
}
```

The `answer` field already exists (written by `answer_question_atomic()`). The new fields (`question_id`, `what_i_need`, `decision_unlocked`, `answer_format`, `choices`) are additive — old question items without them continue to work.

### question_id specification

**Format:** `q-` prefix + 8 hex characters from `crypto.randomUUID()` (first 8 chars of a v4 UUID). Example: `q-7f3a2b1c`.

**Uniqueness scope:** Per coordinator session. A coordinator session rarely creates more than 10-20 questions. With 8 hex chars (~4 billion namespace), collision probability within a session is negligible. Across sessions, old question IDs become inert (their GTD items are in terminal status), so even a collision with a prior session's ID causes no routing conflict.

**Display format:** The full `q-7f3a2b1c` is stored in metadata. In Telegram messages, display the first 4 hex chars for readability: `"james asks (q-7f3a): ..."`. The relay matches against the full ID using prefix matching if Dave types a short form.

**Generation:**

```typescript
function generateQuestionId(): string {
  return `q-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`
}
```

### Existing fields used as-is

| Field | Already exists | Used for |
|---|---|---|
| `parent_id` | Yes | Tree structure (3 levels) |
| `dispatch_envelope_id` | Yes | Links to relay envelope AND maps to `run_id` in orchestration_events (see Cross-DB Query section) |
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
| `agent_dispatch` | Coordinator on dispatch | open → done/cancelled | Agent avatar, colored left border, last activity text |
| `agent_question` | Agent via ask_user | waiting_for | Agent avatar, question text, "What I need" box, answer controls |

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
  item_type: 'agent_question',
  metadata: {
    question_id: generateQuestionId(), // e.g. "q-7f3a2b1c"
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

**Throttling strategy:** Progress events are high-frequency (50+ tool calls per dispatch). To prevent noise:
- **Deduplicate by phase:** Only write a new event when the `phase` changes (reading → editing → testing). Same-phase events within a 10-second window are coalesced — the latest `detail` overwrites the pending write.
- **Batch writes:** Buffer events in memory, flush every 5 seconds or on phase change, whichever comes first.
- **Cap per dispatch:** Maximum 100 progress events per `run_id`. After cap, only phase transitions and terminal events (completed/failed) are written.

**Identity mapping:** `dispatch_envelope_id` on the Supabase todo IS the `run_id` used in orchestration_events. The relay sets both values from the same source (`DispatchEnvelope.id`). See Cross-DB Query section for how the dashboard joins them.

### Context compaction recovery via working memory

**Integration point:** The `CoordinatorContext.compact()` method is a sync operation on the in-memory messages array. Recovery happens in the async `onCompactionComplete` callback that already exists for post-compaction side effects (logging, metrics). This callback is the exact callsite:

```typescript
// In coordinator-context.ts, existing compact() flow:
compact(pressureLevel: PressureLevel): void {
  // ... existing sync compaction logic ...
  this.onCompactionComplete(pressureLevel)
}

// Enhanced callback:
private async onCompactionComplete(pressureLevel: PressureLevel): Promise<void> {
  // ... existing logging/metrics ...
  
  // NEW: Rebuild dispatch state from GTD
  if (this.coordinatorParentId) {
    try {
      await rebuildDispatchStateFromGTD(
        this.sessionId,
        this.coordinatorParentId,
        this.deps.supabase
      )
    } catch (err) {
      // Non-fatal: log warning, coordinator continues with whatever
      // working memory already contains. Better to have stale state
      // than to crash the coordinator loop.
      this.deps.logger.warn('GTD recovery failed after compaction', { err })
    }
  }
}
```

**The rebuild function:**

```typescript
async function rebuildDispatchStateFromGTD(
  sessionId: string, 
  coordinatorParentId: string,
  supabase: SupabaseClient
): Promise<void> {
  const trees = await getActiveOrchestrationTrees(supabase)
  const thisSession = trees.find(t => t.id === coordinatorParentId)
  if (!thisSession) return

  const summary = formatDispatchSummary(thisSession)
  
  await updateWorkingMemory(sessionId, 'coordinator', {
    task_stack: summary,
    context_anchors: formatPendingAnswers(thisSession)
  })
}
```

**Error recovery:** If the GTD query or working memory update fails, the coordinator continues with whatever working memory state survived compaction. This is a best-effort enhancement, not a hard dependency. The `try/catch` ensures no coordinator crash.

## Answer Routing

### Answer bridge: Dashboard → Supabase → In-Memory Queue

This is the critical path that connects a dashboard click to the coordinator loop resuming. The mechanism:

1. Dave clicks answer button on dashboard
2. Dashboard calls `POST /api/dispatches/answer` with `{ question_item_id, answer_text }`
3. The relay endpoint handler:
   a. Calls `answer_question_atomic(question_item_id, answer_text)` → writes to Supabase, marks done
   b. Reads `metadata.question_id` from the updated row
   c. Calls `answerQuestion(questionId, answer_text)` on the in-memory ask-user queue → resolves the pending promise
   d. The coordinator loop's `await askUserQueue.enqueueQuestion(...)` resolves with the answer
   e. Coordinator feeds the answer as the tool result for the `ask_user` call and continues

```typescript
// In the /api/dispatches/answer route handler:
const result = await answerQuestionAtomic(supabase, questionItemId, answerText)
if (result.error) {
  return res.status(409).json({ error: 'Already answered' })
}

// Bridge to in-memory queue
const questionId = result.data.metadata?.question_id
if (questionId) {
  const resolved = askUserQueue.answerQuestion(questionId, answerText)
  if (!resolved) {
    // Question timed out or coordinator restarted — answer is persisted
    // in Supabase but won't resume the loop. This is expected for
    // stale questions. Log but don't error.
    logger.info('Answer persisted but no pending promise', { questionId })
  }
}
```

**Telegram path uses the same bridge:** When Ellie resolves a Telegram answer to a specific question, she calls the same `POST /api/dispatches/answer` endpoint. The only difference is `answered_via: 'telegram'` in the metadata.

### Telegram disambiguation algorithm (Phase 2)

**Primary mechanism: Telegram reply-to-message.** When a question is posted to Telegram, the relay stores the Telegram `message_id`. If Dave uses Telegram's native reply feature on that specific message, routing is unambiguous — the relay matches by `message_id`.

**Fallback mechanisms** (in priority order, when Dave sends a plain message instead of a reply):

1. **Single pending question:** Route directly. No disambiguation needed.
2. **Agent name prefix:** If message starts with an agent name (case-insensitive): `"james: use JWT"` → route to james's pending question.
3. **Choice matching:** If the answer text exactly matches one of the `metadata.choices` for a pending question, route there. Example: question A has choices ["JWT", "Session cookies"], question B has choices ["yes", "no"]. Dave types "JWT" → routes to question A.
4. **Explicit question ID:** If message contains a question ID pattern (`q-XXXX`): `"q-7f3a use JWT"` → route by ID.
5. **Ambiguous — ask for clarification:** Ellie responds with a numbered list of pending questions and asks Dave to reply with a number or use the dashboard.

```typescript
function disambiguateAnswer(
  answerText: string, 
  pendingQuestions: PendingQuestion[]
): PendingQuestion | 'ambiguous' {
  if (pendingQuestions.length === 1) return pendingQuestions[0]
  
  // Agent name prefix
  const agentMatch = pendingQuestions.find(q => 
    answerText.toLowerCase().startsWith(q.agentName.toLowerCase() + ':')
  )
  if (agentMatch) return agentMatch
  
  // Choice matching
  const choiceMatch = pendingQuestions.find(q =>
    q.choices?.some(c => c.toLowerCase() === answerText.trim().toLowerCase())
  )
  if (choiceMatch) return choiceMatch
  
  // Question ID
  const idMatch = answerText.match(/q-([0-9a-f]{4,8})/i)
  if (idMatch) {
    const match = pendingQuestions.find(q => 
      q.questionId.startsWith(`q-${idMatch[1]}`)
    )
    if (match) return match
  }
  
  return 'ambiguous'
}
```

### Error handling

**Double-answer:** `answer_question_atomic()` checks status before writing. If already `done`, returns an error. Dashboard shows "Already answered" toast. Telegram: Ellie says "That question was already answered."

**Timeout:** The in-memory ask-user queue has a 5-minute timeout. When it fires:
- GTD item status updated to `timed_out` via `update_item_status_atomic()`
- Orchestration event logged with `event_type: 'timeout'`
- Coordinator receives timeout error as tool result, can re-ask or proceed without answer
- **Timeout cascade:** The timed-out question's parent dispatch item is NOT automatically failed. The coordinator decides what to do — it may re-ask, skip the question, or abort the dispatch. The parent's `check_parent_completion_atomic()` treats `timed_out` as a terminal state for completion checking purposes but does not cascade failure upward.

**Routing failure:** If Telegram can't resolve which question an answer belongs to, the answer is NOT written anywhere. Ellie asks for clarification or redirects to dashboard. No data loss, no misrouting.

**Coordinator restart:** If the relay process restarts while questions are pending, the in-memory ask-user queue is lost. The GTD items remain in `waiting_for` status. On next coordinator loop start, `rebuildDispatchStateFromGTD()` detects unanswered questions and the coordinator can re-ask or time them out. The dashboard continues to show pending questions and accept answers — answers are persisted to Supabase even if no in-memory promise exists to resolve.

## Cross-Database Query Strategy

Progress events live in Forest (local Postgres), dispatch items live in Supabase (cloud Postgres). The dashboard needs to join them for activity timelines.

**Identity mapping:** `dispatch_envelope_id` on the Supabase todo is set to the same value as `run_id` in Forest's orchestration_events. Both are generated by `DispatchEnvelope.id` in the relay. This is a string identity relationship, not a foreign key — the two databases are independent.

**New endpoint (Phase 2):**

```
GET /api/dispatches/:id/events
```

The relay handles this endpoint by:
1. Looking up the todo by `id` in Supabase to get `dispatch_envelope_id`
2. Querying Forest's `orchestration_events` table by `run_id = dispatch_envelope_id`
3. Returning the merged result

**Lazy loading:** The dashboard does NOT fetch events on page load. Activity timelines are loaded on demand when a user expands an agent card. Events are paginated (50 per page, newest first).

**Graceful degradation:** If Forest is unreachable, the endpoint returns `{ events: [], forest_unavailable: true }`. The dashboard shows "Activity timeline unavailable" instead of an error. The dispatch card still works — status, question, and answer data all come from Supabase.

## Dashboard UI

### Kanban integration (ellie-home gtd-kanban.vue) — Phase 1 + 2

Agent items appear on the existing 4-column kanban. The kanban currently fetches `GET /api/todos?limit=200` — this continues to work. The UI changes are in card rendering:

- **`item_type = 'agent_dispatch'`** cards: colored left border per agent (james=cyan, kate=purple, alan=red), agent avatar, "last activity" text from most recent status. Phase 2 adds expandable timeline from `GET /api/dispatches/:id/events`.
- **`item_type = 'agent_question'`** cards in Waiting column: question text, amber "What I need from you" box (from `metadata.what_i_need`), answer controls based on `metadata.answer_format` (choice buttons, text input, or approve/deny).
- **`item_type = 'agent_dispatch'` in Done**: cost/token summary from dispatch envelope, faded.

Existing agent filter dropdown works — filter by `assigned_agent`.

### Agent Questions queue (new page: /agent-questions) — Phase 1

Dedicated focused view:

- **Data source:** `GET /api/dispatches/active` (already returns trees with questions) + `GET /api/dispatches/badge` for counts
- **Filter tabs:** Waiting (badge count), Answered today, All
- **Cards sorted oldest first** — longest-waiting agent first
- **Each card:** agent avatar + name, parent task context ("working on: ..."), question text, "What I need from you" box, answer controls
- **Choice questions:** tappable buttons per choice + free-text fallback
- **Yes/no decisions:** green/red styled buttons
- **Answered questions:** collapsed, showing answer + channel
- **Answer action:** `POST /api/dispatches/answer` (existing endpoint)

### Sidebar navigation — Phase 1

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
- **In-memory ask-user queue** — promise-based resolution for the coordinator loop. GTD is the persistence layer, the in-memory queue is the signaling mechanism. The answer bridge connects them.
- **Dispatch envelopes** — cost/token tracking remains here.
- **orchestration_events table** — append-only audit trail, now also used for dashboard activity timelines (Phase 2).

### Replaces
- **`is_orchestration` boolean** → `item_type` enum (more expressive, no need to infer type from other fields)
- **Unstructured question text** → structured metadata with `what_i_need`, `decision_unlocked`, `answer_format`
- **Telegram-only answer path** → dashboard + Telegram with disambiguation
- **Context compaction blind spot** → working memory rebuild from GTD state

## Migration Strategy

### Schema migration (Supabase)

```sql
-- 1. Add item_type enum (without 'approval' — to be added if needed later)
CREATE TYPE todo_item_type AS ENUM ('task', 'agent_dispatch', 'agent_question');
ALTER TABLE todos ADD COLUMN item_type todo_item_type NOT NULL DEFAULT 'task';

-- 2. Backfill from existing data (handles all edge cases)
-- Questions assigned to dave with urgency set
UPDATE todos SET item_type = 'agent_question'
  WHERE is_orchestration = true AND assigned_to = 'dave' AND urgency IS NOT NULL;
-- Questions assigned to dave without urgency (edge case from backfill review)
UPDATE todos SET item_type = 'agent_question'
  WHERE is_orchestration = true AND assigned_to = 'dave' AND urgency IS NULL AND item_type = 'task';
-- Everything else that's orchestration = dispatch
UPDATE todos SET item_type = 'agent_dispatch'
  WHERE is_orchestration = true AND item_type = 'task';

-- 3. Partial index for kanban queries (only indexes non-task items)
CREATE INDEX idx_todos_item_type ON todos (item_type) WHERE item_type != 'task';

-- 4. Deprecate is_orchestration with concrete removal criteria
COMMENT ON COLUMN todos.is_orchestration IS 
  'DEPRECATED: use item_type. Remove when: (1) all relay code uses item_type, '
  '(2) all dashboard queries use item_type, (3) no Realtime subscriptions reference it, '
  '(4) 2+ weeks post-deploy with no issues.';
```

### Code migration (relay) — Phase 1

1. Update `gtd-orchestration.ts`: set `item_type` on creation (alongside `is_orchestration = true` for backward compat during transition)
2. Update `coordinator-tools.ts`: add mandatory `what_i_need` / `decision_unlocked` to `ask_user` schema
3. Update `createQuestionItem()`: generate and store `question_id` in metadata
4. Update `/api/dispatches/answer` handler: add answer bridge to in-memory queue (step 3c in Answer Bridge section)
5. Add `rebuildDispatchStateFromGTD()` in `onCompactionComplete` callback of `CoordinatorContext`
6. Add progress event throttling (phase dedup + 5s batch + 100 cap)

### Code migration (relay) — Phase 2

7. Update Telegram question formatting: include short question ID, store `message_id`
8. Add `disambiguateAnswer()` function to relay message handler
9. Add `GET /api/dispatches/:id/events` endpoint (proxy to Forest)

### Dashboard migration (ellie-home) — Phase 1

1. Add new `/agent-questions` page consuming existing `/api/dispatches/*` endpoints
2. Add sidebar badge using existing `/api/dispatches/badge`
3. Update `gtd-kanban.vue` card rendering to check `item_type` for basic agent card styling

### Dashboard migration (ellie-home) — Phase 2

4. Add activity timeline component with lazy-loaded `GET /api/dispatches/:id/events`
5. Full kanban agent card polish (expandable timeline, progress text)

## Scope & Non-Goals

**Phase 1 scope:**
- `item_type` enum migration + backfill
- Structured question metadata in existing `metadata` column
- Mandatory `what_i_need` / `decision_unlocked` on `ask_user`
- Answer bridge: dashboard → Supabase → in-memory queue
- Context compaction recovery via working memory update
- Agent Questions page with structured answer forms
- Sidebar badge with real-time count

**Phase 2 scope:**
- Telegram question ID tagging and reply-to-message routing
- Telegram disambiguation algorithm
- `GET /api/dispatches/:id/events` endpoint
- Kanban agent card rendering with expandable activity timeline
- Progress event throttling

**Not in scope (future work):**
- Removing `is_orchestration` column (transition period, then remove per criteria above)
- Agent-to-agent communication without coordinator (ELLIE-785 agentmail)
- Chrome extension side panel
- Full Orloj-style reconciliation loop
- Orloj-style message bus (NATS/JetStream)
- Tool approval workflows (may add `approval` enum value later)
- Drag-to-reorder on kanban
- Removing in-memory orchestration tracker (keeps operational role)
