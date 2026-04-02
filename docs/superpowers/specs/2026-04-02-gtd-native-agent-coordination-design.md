# GTD-Native Agent Coordination

**Date:** 2026-04-02
**Status:** Draft
**Inspired by:** [Optio](https://github.com/jonwiggins/optio) dispatch trees + per-task answer boxes, [Orloj](https://github.com/OrlojHQ/orloj) reconciliation loops + typed message envelopes

## Problem

Multi-agent coordination through Telegram chat has three failure modes:

1. **Post-dispatch amnesia** — agents return results but the coordinator loses track after context compaction. GTD items exist (ELLIE-1152) but aren't used as the recovery source.
2. **Ask/resume brittleness** — answers don't always land cleanly, or the coordinator resumes with stale context.
3. **Question multiplexing collisions** — when multiple agents ask questions simultaneously, they arrive as a serial stream in Telegram. Dave's answer to agent A gets attributed to agent B. One question can overwrite another. Questions are sometimes poorly framed, making answers ambiguous when fed back into the loop.

Separately, there's no at-a-glance visibility into what agents are doing. The `/dispatches` page exists but is separate from the GTD system, creating fragmented tracking across in-memory orchestration tracker, dispatch envelopes, routing_decisions table, and GTD items.

## Solution

Make GTD the single source of truth for all agent coordination. Every dispatch, every question, every answer lives as a GTD item in the `todos` table. The kanban board becomes mission control. A dedicated Agent Questions queue provides focused answer UI. Telegram remains a valid input path but is no longer the only one.

## Data Model

### New fields on `todos` table

| Field | Type | Description |
|---|---|---|
| `dispatch_envelope_id` | `text` | Links to relay dispatch envelope (null for manual items) |
| `parent_todo_id` | `text` | Tree structure: coordinator parent → agent children → question grandchildren. New field — separate from existing `project_id` which links to `todo_projects`. Both can coexist: a dispatch tree item can optionally belong to a project too. |
| `item_type` | `text` | `'task'` (default), `'agent_dispatch'`, `'agent_question'`, `'approval'` |
| `agent_name` | `text` | Which agent (james/kate/alan). Replaces existing `assigned_agent` |
| `question_metadata` | `jsonb` | Structured question/answer data (see below). Null for non-question items |
| `activity_log` | `jsonb` | JSON array of `{timestamp, event, detail}` objects. Stored as `jsonb` (not Postgres array of jsonb) for simpler append operations. |

### question_metadata schema

```json
{
  "question_id": "string — UUID, used for answer routing",
  "what_i_need": "string — mandatory: what format/decision the agent needs",
  "decision_unlocked": "string — what happens once answered",
  "answer_format": "'text' | 'choice' | 'approve_deny'",
  "choices": ["string[] — if answer_format is 'choice'"],
  "answer": "string — filled when Dave responds",
  "answered_at": "string — ISO timestamp",
  "answered_via": "'dashboard' | 'telegram'"
}
```

### Item type → kanban column mapping

| Item type | Created by | Kanban column | Card appearance |
|---|---|---|---|
| `task` | Dave (manual) | inbox → open → waiting → done | Normal GTD card |
| `agent_dispatch` | Coordinator on dispatch | open (working) → done/cancelled | Agent avatar, colored left border, progress bar |
| `agent_question` | Agent via ask_user | waiting | Agent avatar, question text, "What I need" box, answer controls |
| `approval` | Agent needing tool approval | waiting | Agent avatar, approve/deny buttons |

### Tree structure

- Coordinator session creates a parent `agent_dispatch` item
- Each specialist dispatch creates a child `agent_dispatch` under the parent (via `parent_todo_id`)
- When an agent calls `ask_user`, a child `agent_question` is created under that agent's dispatch item
- When all children of the coordinator parent reach terminal status (done/cancelled), the parent auto-completes

### Activity log entries

Appended as events happen:

```json
[
  {"timestamp": "2026-04-02T12:03:00Z", "event": "dispatched", "detail": "Task sent to james"},
  {"timestamp": "2026-04-02T12:04:00Z", "event": "reading", "detail": "src/auth-middleware.ts"},
  {"timestamp": "2026-04-02T12:05:00Z", "event": "question_asked", "detail": "JWT or session cookies?"},
  {"timestamp": "2026-04-02T12:07:00Z", "event": "answered", "detail": "Use JWT", "via": "dashboard"},
  {"timestamp": "2026-04-02T12:09:00Z", "event": "completed", "detail": "PR opened: #142"}
]
```

## Coordinator → GTD Sync (Relay Side)

The relay already has Supabase access. It writes directly to the `todos` table at each coordination event.

### On coordinator dispatch

1. If no parent GTD item exists for this coordinator session → create one:
   - `item_type: 'agent_dispatch'`, `status: 'open'`, `content: "{user's original request}"`
   - `activity_log: [{event: 'started', detail: 'Coordinator session began'}]`

2. For each specialist dispatch → create a child:
   - `parent_todo_id` → the coordinator's GTD item ID
   - `item_type: 'agent_dispatch'`, `agent_name`, `status: 'open'`
   - `dispatch_envelope_id` → links to existing envelope for cost/token tracking
   - `content: "{task description sent to the agent}"`
   - Append to parent's `activity_log`: `{event: 'dispatched', detail: 'Sent to james: ...'}`

### On ask_user

1. Create a child `agent_question` under that agent's dispatch item:
   - `parent_todo_id` → the agent's GTD item ID
   - `status: 'waiting_for'`
   - `question_metadata` filled with `question_id` (UUID), `what_i_need`, `decision_unlocked`, `answer_format`, `choices`
   - `content: "{the question text}"`

2. **Mandatory metadata enforcement**: the coordinator's system prompt requires `what_i_need` and `decision_unlocked` fields on every `ask_user` call. If Claude omits them, the tool call fails with a validation error and Claude must retry.

3. The coordinator loop pauses as today, but records the `question_id` so the answer routes back by ID, not by conversation position.

### On agent complete or fail

1. Update the agent's GTD item: `status: 'done'` or `status: 'cancelled'`
2. Append to `activity_log`: `{event: 'completed', detail: '...'}` or `{event: 'failed', detail: '...'}`
3. When ALL children of the coordinator parent reach terminal status → auto-complete the parent via a database transaction. Guard: only auto-complete if the coordinator loop itself has also finished (check dispatch envelope status). If the coordinator is still running, leave the parent as `open` — the coordinator's `complete` tool call will finalize it.

### On tool call events (progress tracking)

The existing `AgentMonitorPanel` tracks Read, Edit, Bash, Grep, etc. Instead of only feeding that panel, the relay also writes condensed events to the GTD item's `activity_log`. Not every tool call — condensed milestones: "reading src/auth.ts", "editing 42 lines", "running tests".

## Answer Routing

### By question ID (primary mechanism)

Every question gets a UUID `question_id`. Answers are routed by this ID regardless of source:

**Dashboard path:**
- Click choice button or type answer → POST to relay with `question_id` and `answer`
- Relay writes `question_metadata.answer`, `answered_at`, `answered_via: 'dashboard'`
- GTD item status: `waiting_for` → `done`
- Relay resumes coordinator with the answer injected as the tool result for the exact `ask_user` call that created it

**Telegram path:**
- Each question in Telegram is tagged: `"james asks (q-7f3a): Should the auth..."`
- When Dave replies, Ellie checks: is there only one unanswered question? If yes, route there.
- If multiple questions pending: Ellie asks "Is this for james (q-7f3a) or kate (q-8b2c)?" — or Dave can prefix: "james: use JWT"
- If routing can't be resolved: Ellie says "I have 2 questions waiting — easier to answer on the dashboard" with a link
- Once resolved, same write path as dashboard but `answered_via: 'telegram'`

### Context compaction recovery

After any context compaction, the coordinator queries GTD to rebuild working memory:

1. Query all GTD items where `parent_todo_id` = this session's coordinator item AND `status != 'done'`
2. Rebuild active state from their data:
   ```
   ACTIVE DISPATCHES (from GTD):
   - james: "Implement auth middleware" — status: waiting (question q-7f3a pending)
   - kate: "Forest query optimization" — status: open (working, 70% progress)

   PENDING QUESTIONS:
   - q-7f3a (james): "JWT or session cookies?" — unanswered
   ```
3. Inject this summary at the top of the compacted context

GTD is the persistent ground truth that survives any context window compression. The coordinator can never lose track of what's happening.

## Dashboard UI

### Kanban integration (ellie-home gtd-kanban.vue)

Agent items appear naturally on the existing 4-column kanban alongside manual tasks:

- **Agent dispatch cards** have colored left borders per agent (james=cyan, kate=purple, alan=red), agent avatar, progress bar, condensed status line ("3 files touched, reading tests")
- **Agent question cards** appear in the Waiting column with the question text, amber "What I need from you" box, and answer controls (choice buttons for `answer_format: 'choice'`, text input for `answer_format: 'text'`, approve/deny for `answer_format: 'approve_deny'`)
- **Completed agent cards** in Done column show cost/token summary, faded
- Click any agent card to expand the activity feed

Filtering: the existing agent filter dropdown works — select "james" to see only james's items, or "all" for everything.

### Agent Questions queue (new page: /agent-questions)

A dedicated focused view for handling agent questions:

- **Filter tabs**: Waiting (count), Answered today (count), All
- **Cards sorted oldest first** — deal with the longest-waiting agent first
- **Each card shows**: agent avatar + name, parent task context ("working on: ..."), the question, "What I need from you" box, answer controls
- **Choice questions**: big tappable buttons for each choice, plus a free-text fallback ("or type a different answer")
- **Yes/no decisions**: green "Yes" and red "No" styled buttons
- **Answered questions**: collapsed, showing what you said and which channel
- **Activity feed**: expandable per card

### Sidebar navigation

- New "Agent Questions" entry in the sidebar under Work section
- Amber pulsing badge shows count of unanswered questions
- Badge visible from any page

### Real-time updates

All updates flow through Supabase Realtime, which is already wired up in `useRealtime.ts`:
- Kanban cards update live as agents progress
- Question badge count updates in real-time
- Activity feed entries appear as they happen on expanded cards
- No new WebSocket infrastructure needed

## What This Replaces

Once GTD-native coordination is stable:

- **In-memory orchestration tracker** (`orchestration-tracker.ts`) → replaced by GTD queries
- **Separate dispatch ledger** → dispatch envelopes remain for cost tracking, but GTD is the status source
- **routing_decisions table** (historical only) → activity_log on GTD items serves the same purpose
- **Fragmented visibility** across 4 systems → single GTD source of truth

The existing `/dispatches` page can be kept as a redirect to the Agent Questions queue, or deprecated.

## Scope & Non-Goals

**In scope:**
- GTD schema extensions (migration)
- Relay writes to GTD on dispatch/question/complete events
- Mandatory question metadata enforcement in coordinator prompt
- Answer routing by question_id from dashboard and Telegram
- Context compaction recovery from GTD
- Kanban UI for agent cards and inline answers
- Agent Questions page with structured answer forms
- Sidebar badge with real-time count
- Activity feed per GTD item

**Not in scope (future work):**
- Agent-to-agent communication without coordinator (ELLIE-785 agentmail)
- Chrome extension side panel
- Full Orloj-style reconciliation loop replacing the coordinator's think-act-observe loop
- Orloj-style message bus (NATS/JetStream) — Supabase Realtime is sufficient for now
- Tool approval UI beyond approve/deny buttons (detailed tool call inspection)
- Drag-to-reorder on kanban
