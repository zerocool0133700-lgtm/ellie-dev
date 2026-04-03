# Dispatch Observability & Bidirectional Awareness — Design Spec

**Goal:** Give Dave full visibility into agent dispatch activity through Ellie Chat — live cards, inquiry routing, post-completion drill-down, and proactive awareness — so he can glance and know what's happening, steer work mid-flight, and trust the system is working.

**Scope:** 21 tickets (ELLIE-1308 through ELLIE-1328), organized into 5 phases. Each phase builds on the previous. Plans and execution are per-phase.

**Existing infrastructure this builds on:**
- `OrchestrationEvent` in Forest DB (orchestration-ledger.ts) — event types: dispatched/heartbeat/progress/completed/failed/cancelled/timeout
- `DispatchEnvelope` (dispatch-envelope.ts) — parent-child trace tree with cost tracking
- `spawn_status`/`spawn_announcement` WebSocket events to Ellie Chat
- `AgentKanbanCard.vue` on the dispatches page
- Status messages in Ellie Chat stream (ELLIE-955)
- Stall detection in `orchestration-monitor.ts` (10 min threshold)
- GTD orchestration tree in Supabase (parent/child dispatch items)
- Working memory injection to specialists via `buildPrompt()`
- `GET /api/dispatches/active`, `POST /api/dispatches/cancel`, etc.

---

## Phase 1: Dispatch Event Layer (ELLIE-1308 through 1311)

### 1.1 Unified Dispatch Lifecycle Events (ELLIE-1308)

Extend the existing `OrchestrationEvent` schema in the Forest DB ledger. Add structured fields to the payload:

```typescript
// Extended payload fields for OrchestrationEvent
{
  agent: string;                    // "james", "kate", "ellie", etc.
  title: string;                    // human-readable task summary (max 200 chars)
  work_item_id: string | null;      // "ELLIE-500" or null
  progress_line: string | null;     // one-liner from agent, updated on progress events
  dispatch_type: "single" | "formation" | "round_table" | "delegation";
}
```

The existing schema stays:
- `id`, `run_id`, `event_type`, `agent_type`, `work_item_id`, `payload`, `created_at`
- Event types: `dispatched | heartbeat | progress | completed | failed | cancelled | timeout`
- `run_id` is the correlation key across all events for a dispatch

**WebSocket projection:** Every event written to the ledger is also broadcast to all Ellie Chat WebSocket clients as a unified `dispatch_event` message. This replaces the current `spawn_status` and `spawn_announcement` event pair.

```typescript
// WebSocket message sent to Ellie Chat clients
{
  type: "dispatch_event",
  run_id: string,
  event_type: OrchestrationEventType,
  agent: string,
  title: string,
  work_item_id: string | null,
  progress_line: string | null,
  dispatch_type: string,
  status: "dispatched" | "in_progress" | "done" | "failed" | "stalled" | "cancelled",
  timestamp: number,
  // Only on terminal events:
  duration_ms?: number,
  cost_usd?: number,
}
```

**Backward compatibility:** Keep emitting `spawn_status` and `spawn_announcement` alongside `dispatch_event` until the dashboard is fully migrated. Then remove them.

### 1.2 Dispatch Outcome Storage (ELLIE-1309)

New `dispatch_outcomes` table in Forest DB (local Postgres):

```sql
CREATE TABLE dispatch_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id TEXT NOT NULL UNIQUE,
  parent_run_id TEXT,              -- links formation participant to parent formation
  agent TEXT NOT NULL,
  work_item_id TEXT,
  dispatch_type TEXT NOT NULL DEFAULT 'single',
  status TEXT NOT NULL,
  summary TEXT,
  files_changed TEXT[],
  decisions TEXT[],
  commits TEXT[],
  forest_writes TEXT[],
  duration_ms INTEGER,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd NUMERIC(10,4),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_dispatch_outcomes_run_id ON dispatch_outcomes(run_id);
CREATE INDEX idx_dispatch_outcomes_work_item ON dispatch_outcomes(work_item_id);
CREATE INDEX idx_dispatch_outcomes_created ON dispatch_outcomes(created_at DESC);
```

Populated when a dispatch completes. The coordinator extracts file changes, decisions, and commits from the specialist's output. For formations/round tables, one outcome per agent participant plus one for the overall formation.

### 1.3 Stall Detection Emitter (ELLIE-1310)

Wire the existing `orchestration-monitor.ts` stall detection to emit events through the unified system.

When a stall is detected (no progress event for configurable threshold, default 10 minutes):
1. Emit a `stalled` event type to the ledger (new addition to `OrchestrationEventType`)
2. Broadcast `dispatch_event` with `status: "stalled"` via WebSocket
3. The UI renders a stall alert card (Phase 5)

The stall threshold is configurable per-foundation via `behavior.stall_threshold_ms` (default: 600000 — 10 minutes).

### 1.4 Progress Line Protocol (ELLIE-1311)

A `reportProgress(runId: string, line: string)` helper function that emits a `progress` event to the ledger with the line in the payload's `progress_line` field.

The coordinator calls this on behalf of specialists. When a specialist's streaming output includes recognizable progress markers (file operations, test results, deployment steps), the coordinator extracts a one-liner and calls `reportProgress()`.

Progress lines are short (max 100 chars), human-readable, and present-tense:
- "Reading schema files..."
- "Running 12 tests — 8 passed so far"
- "Committed: add v2 auth endpoint"

---

## Phase 2: Dispatch Cards in Ellie Chat (ELLIE-1312 through 1315)

### 2.1 Hybrid Card Display (ELLIE-1312, 1313)

**Inline indicator in chat stream:** When Max dispatches an agent, a compact status line appears in the message flow:
- Shows agent name, work item, and task title
- Status icon updates in place via WebSocket (blue → amber pulse → green check / red X)
- Progress line updates as the agent reports
- Tapping the indicator opens the side panel focused on that dispatch

**Collapsible side panel:** A right-side panel in the Ellie Chat view showing active dispatch cards:
- Agent name + avatar color
- Work item link (opens Plane)
- Status badge with styling
- Current progress line
- Timestamp + elapsed time
- Expand arrow for drill-down (Phase 4)

### 2.2 WebSocket Card Updates (ELLIE-1314)

The dashboard listens for `dispatch_event` (unified event from Phase 1).
- `dispatched` → create card + inline indicator
- `progress` → update progress line on existing card
- `completed` / `failed` / `timeout` → update status badge and styling
- `stalled` → switch to stalled styling

All updates are in-place — no page refresh, no new message inserted.

Cards are keyed by `run_id`. A reactive Map in the composable holds card state, updated by the WebSocket listener.

### 2.3 Status Badge Styling (ELLIE-1315)

| State | Color | Icon | Behavior |
|-------|-------|------|----------|
| dispatched | blue/neutral | arrow-right | Static |
| in-progress | amber | spinner/pulse | Animated pulse |
| done | green | check-circle | Static, fades after 30s unless pinned |
| failed | red | x-circle | Static, persists |
| stalled | amber/attention | clock-alert | Static, attention-grabbing |

All colors meet WCAG AA contrast against the Ellie Chat background. Icon fallbacks for color-blind accessibility.

### Component Structure

```
ellie-home/app/components/dispatch/
  DispatchInlineIndicator.vue    — compact chat-stream element
  DispatchSidePanel.vue          — collapsible right panel
  DispatchCard.vue               — individual card in panel
```

```
ellie-home/app/composables/
  useDispatchEvents.ts           — WebSocket listener, reactive card state map
```

---

## Phase 3: Inquiry Routing (ELLIE-1316 through 1319)

### 3.1 Message Classification (ELLIE-1316)

No new infrastructure — this is a coordinator prompt enhancement.

When active dispatches exist, their context is injected into Max's system prompt before each coordinator loop iteration:

```
## Active Dispatches
- James is working on ELLIE-500: "Implement v2 API endpoint" (12 min elapsed, last progress: "writing tests")
- Kate is researching ELLIE-501: "Competitive analysis of auth providers" (3 min elapsed)

When Dave's message relates to active work:
- Queue the context for that agent and re-dispatch immediately after completion
When it's new work:
- Dispatch normally
When it's general conversation:
- Dispatch to Ellie
```

The active dispatch list is built from the orchestration tracker's active runs, enriched with progress lines from the ledger's most recent progress event per run_id.

### 3.2 Context Injection into Active Dispatch (ELLIE-1317)

**Queue-and-redispatch model.** You cannot push context to a running CLI process. Instead:

1. Max stores Dave's message in a `dispatch_context_queue` — an in-memory Map keyed by `run_id`, value is an array of `{ message: string, timestamp: number }`
2. Max tells Dave (via Ellie): "James is mid-work — I'll make sure he picks this up as soon as he finishes."
3. When the dispatch completes, Max checks the queue for that `run_id`
4. If context is waiting, Max **immediately re-dispatches** the same agent with: the completed results + Dave's queued message(s) as additional context
5. Queue clears after re-dispatch

The queue lives in coordinator memory (module-level Map). If the relay restarts, the queue is lost — acceptable since active dispatches also restart.

### 3.3 Routing Feedback in UI (ELLIE-1318)

When Max routes a message about running work, a subtle indicator appears below Dave's message in the chat:
- "Queued for James (working on ELLIE-500)" — for about_running_work
- "Dispatching to Kate" — for new_work
- No indicator for general conversation

Implemented as a system-role message with a `routing_feedback` flag, styled as a small muted-text annotation.

### 3.4 Proactive Surfacing (ELLIE-1319)

Ellie can initiate messages based on dispatch state:
- **Stall alerts:** "James has been quiet on ELLIE-500 for 15 minutes — want me to check in?" (triggered by Phase 1.3 stall events)
- **Conflict warnings:** "Kate's research may affect what James is building — flagging." (triggered by Phase 5 conflict detection)
- **Completion prompts:** "James finished the API — want me to dispatch Brian for review?" (triggered by Phase 5 next-step suggestions)

These render as special message types — visually distinct from Ellie's normal responses. Subtle left border or icon to indicate system-initiated rather than response-to-Dave.

---

## Phase 4: Post-Completion Drill-Down (ELLIE-1320 through 1323)

### 4.1 Drill-Down Panel (ELLIE-1320)

Tapping the expand arrow on a completed card in the side panel opens a drill-down view:

- **Summary** — the specialist's own summary of what was accomplished
- **Files changed** — list of file paths with add/modify/delete indicators
- **Decisions made** — key choices with reasoning
- **Git commits** — SHAs with one-line messages (linked to git history)
- **Forest writes** — knowledge written to the Forest during dispatch
- **Duration + cost** — elapsed time, token counts, USD cost
- **Work item link** — Plane ticket status badge, link opens Plane

Data sourced from `dispatch_outcomes` table via the outcome API (fetched on expand, not eagerly).

### 4.2 Dispatch Outcome API (ELLIE-1321)

`GET /api/dispatches/:run_id/outcome`

Returns the full outcome record from `dispatch_outcomes`:

```typescript
{
  run_id: string;
  agent: string;
  work_item_id: string | null;
  dispatch_type: string;
  status: string;
  summary: string | null;
  files_changed: string[];
  decisions: string[];
  commits: string[];
  forest_writes: string[];
  duration_ms: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  created_at: string;
  // For formations/round tables:
  participants?: Array<{
    agent: string;
    summary: string;
    duration_ms: number;
    cost_usd: number;
  }>;
}
```

### 4.3 Formation/Round Table Drill-Down (ELLIE-1322)

For multi-agent dispatches, the drill-down shows nested structure:
- Formation name and pattern (pipeline/fan-out/debate/round-table)
- Each agent's contribution as a collapsible sub-section
- Synthesis/final output highlighted at the top
- Individual agent durations and costs

Uses the `participants` array from the outcome API. Each participant's outcome is stored as a separate row in `dispatch_outcomes` linked by a `parent_run_id` field (added to the table).

### 4.4 Work Item Cross-Reference (ELLIE-1323)

The drill-down header includes the Plane ticket status:
- Fetched via existing Plane API integration
- Shows current state badge (In Progress, Done, etc.)
- If the dispatch moved the ticket to Done, a green "Completed" indicator shows
- Link opens the Plane issue in a new tab

### Component Structure

```
ellie-home/app/components/dispatch/
  DispatchDrillDown.vue          — expandable detail view
  FormationBreakdown.vue         — nested agent contributions
```

---

## Phase 5: Bidirectional Awareness (ELLIE-1324 through 1328)

### 5.1 Stall Alert Cards (ELLIE-1324)

When stall detection fires (Phase 1.3), a special attention card renders in chat and side panel:
- Amber/attention styling with clock-alert icon
- "James hasn't updated on ELLIE-500 in 15 minutes"
- Three action buttons:
  - **Check in** — dispatches a lightweight status probe to the agent
  - **Cancel** — kills the dispatch via `POST /api/orchestration/:runId/cancel`
  - **Wait** — dismisses the alert, resets the stall timer for another interval

### 5.2 Conflict Detection (ELLIE-1325)

When a new dispatch starts, compare its likely file paths against files being touched by active dispatches:
- Source: `dispatch_outcomes.files_changed` for historical data on the same work item, plus `progress` events that report file paths from active dispatches
- Detection: set intersection of file paths between the new dispatch and each active dispatch
- If overlap found: warning card in chat — "Kate's research may touch files James is editing (src/api/auth.ts, src/middleware.ts)"
- Not blocking — informational only. Dave can cancel, reprioritize, or ignore

Detection runs at dispatch start and on each `progress` event that includes file path data.

### 5.3 Next-Step Suggestions (ELLIE-1326)

When a card transitions to done, Max analyzes the completed work + ticket context and Ellie suggests what's natural next:
- "James finished the API — want me to dispatch Brian for a code review?"
- "Tests passed on ELLIE-500 — ready to PR?"
- "Kate's research is done — should Alan look at the strategic implications?"

Rendered as a message from Ellie with quick-action buttons. Tapping a button triggers the suggested dispatch immediately.

Suggestion logic lives in Max's coordinator prompt — after receiving a completed specialist result, before calling `complete`, Max considers whether to suggest a follow-up and includes it in the response.

### 5.4 Cancel/Reprioritize Controls (ELLIE-1327)

Inline actions on any active card in the side panel:
- **Cancel** — kills the dispatch, marks as cancelled in the ledger. Wires through `POST /api/orchestration/:runId/cancel`
- **Reprioritize** — "Pause that, work on the bug first." Cancel current dispatch + immediate new dispatch with the prioritized task. Two-step: cancel → dispatch.

Pause/resume is not supported in the initial implementation — CLI processes can't be paused. Cancel + re-dispatch with working memory achieves the same result.

### 5.5 Morning Dashboard View (ELLIE-1328)

When Ellie Chat loads, the side panel shows a snapshot of recent dispatch activity:
- **Green done cards** — completed work from overnight or recent sessions
- **Amber in-progress** — currently running dispatches
- **Red/attention** — failures, stalls, or pending questions needing Dave's input
- **Summary line** at top: "3 completed, 1 in progress, 1 needs attention"

This is the default state of the side panel on page load. Data sourced from:
- Active runs from the orchestration tracker
- Recent outcomes from `dispatch_outcomes` (last 24 hours)
- Pending questions from the GTD tree

The "glance and know" experience — open the page, see the state of the world.

---

## Phase Dependencies

```
Phase 1 (data layer) → no dependencies, builds on existing infrastructure
Phase 2 (UI cards) → depends on Phase 1 (unified events)
Phase 3 (inquiry routing) → depends on Phase 1 (active dispatch context)
Phase 4 (drill-down) → depends on Phase 1 (outcome storage) + Phase 2 (card UI)
Phase 5 (bidirectional) → depends on Phase 1 (stall events) + Phase 2 (card actions) + Phase 3 (proactive surfacing)
```

Phases 2 and 3 can be built in parallel after Phase 1 completes. Phase 4 and 5 require both 2 and 3.

---

## Out of Scope

- Restructuring relay.ts or extracting dispatch infrastructure into separate modules
- Mobile/Capacitor adaptations of the card UI
- AI-powered conflict resolution (just detection and flagging)
- Pause/resume of running CLI processes (cancel + re-dispatch instead)
- Historical analytics or dashboards beyond the morning snapshot
- Multi-user dispatch visibility (single-user system)
