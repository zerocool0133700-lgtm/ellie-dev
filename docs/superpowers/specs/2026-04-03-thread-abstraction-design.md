# Thread Abstraction Layer — Design Spec

**Goal:** Add threading support to Ellie Chat so Dave can have multiple concurrent conversations with different agent compositions, each with isolated context and independent routing.

**Primary use case:** Parallel work streams — talk to Ellie in one thread while James works on ELLIE-500 in another, without mixing contexts. Agent composition and persistent topic spaces follow naturally.

**Scope:** Data model, routing changes, WebSocket protocol, working memory scoping, and frontend UI. Builds on existing channel, conversation, and coordinator infrastructure.

---

## Section 1: Thread Data Model

A thread is a named conversation container within Ellie Chat. It sits between the channel and conversation layers — a channel (ellie-chat) has multiple threads, each thread has its own conversations and message history.

### New Tables (Supabase)

**`chat_threads`:**

```sql
CREATE TABLE chat_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES chat_channels(id),
  name TEXT NOT NULL,
  routing_mode TEXT NOT NULL DEFAULT 'coordinated',  -- 'coordinated' | 'direct'
  direct_agent TEXT,                                  -- when routing_mode='direct', which agent
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_chat_threads_channel ON chat_threads(channel_id);
```

**`thread_participants`:**

```sql
CREATE TABLE thread_participants (
  thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (thread_id, agent)
);
```

**`thread_read_state`** — unread tracking:

```sql
CREATE TABLE thread_read_state (
  thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  last_read_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (thread_id, user_id)
);
```

### Existing Table Modifications

**`conversations`** — add `thread_id UUID` (nullable, FK to chat_threads). Existing conversations have null thread_id and are treated as belonging to the default "General" thread.

**`messages`** — add `thread_id UUID` (nullable). Existing messages have null and belong to General.

**`working_memory`** (Forest DB) — add `thread_id TEXT` (nullable). Working memory becomes scoped by `(session_id, agent, thread_id)`.

### Default Thread

On migration (or first load), a "General" thread is created for the ellie-chat channel:
- Name: "General"
- Routing mode: coordinated
- All agents as participants (ellie, james, kate, alan, brian, jason, amy, marcus)
- Existing null-thread_id data is treated as belonging to this thread

---

## Section 2: Routing — Coordinated vs Direct

Each thread has a `routing_mode` that determines how messages are processed.

### Coordinated Mode (default)

Message flows through `runCoordinatorLoop()` as today, with one key difference: Max's agent roster is filtered to only include agents from `thread_participants`.

- Max's prompt "Your Specialists" section shows only thread members
- Max can only `dispatch_agent` to agents in the thread
- If an agent isn't in the thread, Max explains and suggests creating a thread with that agent or switching threads
- All existing coordinator features work: dispatch events, inquiry routing, context queuing, proactive surfacing

### Direct Mode

Message bypasses the coordinator loop entirely:

- Goes straight to `callSpecialist(thread.direct_agent, message)` with the agent's soul loaded
- No Max, no routing, no dispatch cards, no coordinator overhead
- Response comes back from that agent directly
- Working memory still tracked for the agent in this thread
- Conversations still managed (idle expiry, summaries, etc.)

### Routing Decision in ellie-chat-handler

1. Extract `thread_id` from incoming WebSocket message
2. If missing, use the default "General" thread
3. Look up thread's `routing_mode` and `direct_agent` from `chat_threads`
4. If `coordinated` → existing coordinator loop path with roster filtered by thread participants
5. If `direct` → new code path: `callSpecialist(directAgent, message)` with soul injection, skip coordinator entirely

### Roster Filtering

The `getCoordinatorPrompt()` method builds the agent roster from the active foundation. When a `thread_id` is provided:
1. Query `thread_participants` for this thread
2. Filter the foundation's `agents` array to only include matching participants
3. Build the prompt with the filtered roster

This is done in `runCoordinatorLoop()` — pass the thread's participant list as a filter on `effectiveRoster`.

---

## Section 3: Thread UI

### Dropdown Selector

A compact dropdown in the Ellie Chat header (replaces no existing element — new addition):
- Shows current thread name + agent count: "General (8 agents)"
- Click to open dropdown listing all threads:
  - Thread name
  - Agent count
  - Last activity timestamp
  - Unread badge (amber dot/count) for threads with new messages
- "New thread" option at the bottom of the dropdown
- The default "General" thread is always first in the list

### New Thread Form

Inline form below the dropdown (not a modal):
- **Name** — text input, required
- **Agents** — multi-select checkboxes for each available agent (Ellie, James, Kate, Alan, Brian, Jason, Amy, Marcus). Ellie is checked by default.
- **Routing mode** — toggle: "Coordinated" (default) / "Direct conversation"
- When "Direct" selected, show single-select for which agent to talk to (from checked agents)
- **Create** button

### Thread Switching

- Clicking a thread in the dropdown loads that thread's message history
- Messages are filtered by `thread_id` — each thread has its own scroll position and history
- The dispatch side panel filters to show only dispatches from the current thread (via `thread_id` on dispatch events)
- Active dispatch context in Max's prompt is filtered to current thread's dispatches

### Unread Tracking

- `thread_read_state` table tracks last-read timestamp per thread per user
- When messages arrive in a non-active thread, the dropdown badge increments
- Switching to a thread updates `last_read_at`, clearing the badge

---

## Section 4: WebSocket Protocol Changes

### Outgoing (Dave → relay)

All messages include `thread_id`:

```json
{
  "type": "message",
  "text": "check the v2 API tests",
  "thread_id": "uuid-of-thread"
}
```

If `thread_id` is omitted, the relay uses the default "General" thread. Backward compatible.

### Incoming (relay → Dave)

All events include `thread_id` so the frontend knows which thread they belong to:

```json
{
  "type": "response",
  "text": "...",
  "agent": "ellie",
  "thread_id": "uuid-of-thread",
  "ts": 1234567890
}
```

This applies to: `response`, `typing`, `dispatch_event`, `routing_feedback`, `conflict_warning`, `stall_alert`, `tool_approval`, `confirm`.

The frontend filters incoming messages by active thread. Messages for non-active threads increment unread counter but don't render.

### Thread Management Events (new)

```json
{ "type": "thread_created", "thread": { "id": "...", "name": "...", "routing_mode": "...", "agents": ["ellie", "james"] } }
{ "type": "thread_updated", "thread": { "id": "...", "name": "...", ... } }
```

Broadcast to all connected Ellie Chat clients so the dropdown updates in real-time.

---

## Section 5: Working Memory & Conversation Scoping

### Working Memory — Thread-Scoped

The `working_memory` table (Forest DB) gets a `thread_id TEXT` column (nullable for backward compat).

Working memory operations include thread_id:
- `initWorkingMemory(session_id, agent, sections?, channel?, thread_id?)`
- `updateWorkingMemory(session_id, agent, sections)` — thread_id is on the existing record
- `readWorkingMemory(session_id, agent)` — filtered by thread_id when provided

This means James in thread A has completely separate working memory from James in thread B.

### Conversations — Thread-Scoped

The existing `get_or_create_conversation()` RPC gets `thread_id` as a parameter. Active conversation lookup filters by thread_id.

Each thread has its own conversation lifecycle:
- Idle expiry (30 min default)
- Rolling summaries (every 8 messages)
- Memory extraction on close
- River promotion on close

### Messages — Thread-Tagged

Every message saved includes `thread_id`. Message history retrieval for prompt building filters by thread_id. This is the primary context isolation mechanism — an agent in one thread never sees messages from another thread in its prompt.

### What Stays Global (Not Thread-Scoped)

- **Forest knowledge graph** — trees, branches, entities are shared knowledge
- **Dispatch outcomes** — visible everywhere, filterable by thread in the UI
- **Orchestration ledger** — global event log
- **Plane ticket lookups** — global
- **Foundation system** — one active foundation (thread filters the roster, doesn't change the foundation)

---

## Phase Decomposition

This is too large for a single implementation plan. Recommended phases:

### Phase 1: Data Layer + Routing
- Migration: `chat_threads`, `thread_participants`, `thread_read_state` tables
- Migration: Add `thread_id` to `conversations`, `messages`, `working_memory`
- Default "General" thread creation
- Thread CRUD API endpoints
- Ellie-chat-handler: read thread_id from WebSocket, route based on routing_mode
- Coordinator roster filtering by thread participants
- Direct mode bypass path

### Phase 2: Frontend
- Thread dropdown selector component
- New thread form (name + agent select + routing mode)
- Thread switching (load history, filter messages)
- Unread tracking + badges
- WebSocket thread_id on outgoing messages
- Filter incoming messages by active thread

### Phase 3: Context Isolation
- Working memory thread scoping (Forest DB migration + code changes)
- Conversation thread scoping (get_or_create_conversation with thread_id)
- Message filtering by thread_id in prompt building
- Dispatch side panel thread filtering
- Active dispatch context filtering by thread

---

## Out of Scope

- Per-thread foundation selection (future — add `foundation_id` to `chat_threads`)
- Per-thread coordinator override (future — different coordinator behavior per thread)
- Thread sharing between users (single-user system)
- Thread templates or presets
- Cross-thread agent communication
- Mobile/Capacitor thread UI
- Thread archiving (manual management only, per Dave's preference)
