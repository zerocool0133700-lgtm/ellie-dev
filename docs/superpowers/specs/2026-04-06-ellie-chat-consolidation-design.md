# Ellie Chat Consolidation — Design Spec

> **Date:** 2026-04-06
> **Status:** Draft
> **Context:** Ellie Chat was the first thing built and has accumulated competing concepts (channels vs threads), half-finished features, and broken plumbing. This spec consolidates the experience — fixing data isolation, message attribution, and UI coherence — following the same "step back and get it right" approach that worked for the prompt architecture.

## Problem

Ellie Chat has four interconnected issues:

1. **Channels and threads compete.** Channels were built first, didn't work well, the sidebar was removed. Threads were added for direct agent chat but don't fully work either. Two overlapping concepts, neither complete.

2. **Thread isolation is broken.** Messages from all threads dump into one conversation stream. Switching threads filters the view but doesn't isolate the data. Dispatch results land in the main flow regardless of origin. Loading a thread shows messages from other threads.

3. **Agent attribution is lost.** When Brian and Alan review a spec, Ellie presents the unified response. But the message only records `agent: "ellie"` — Brian and Alan's contributions are invisible to the memory pipeline. Their Forest trees never get the knowledge, and when Dave talks to them directly, they have no memory of participating.

4. **UI clutter.** The Mode Selector dropdown is now redundant (the layered prompt system auto-detects mode). Workshop messages have no visual identity. The header has accumulated controls without coherent organization.

## Design Principles

- **Dave is dyslexic.** Ellie Chat is his primary interface with the system. Every UI decision must reduce cognitive load, not add it.
- **Ellie is the voice.** In the default formation, Ellie presents — but contributors are visually acknowledged and their knowledge is preserved.
- **Threads are isolated workspaces.** Not filters on a shared stream. Separate conversations, separate message loading, separate context.
- **Formations define the interaction pattern.** Software dev = one-voice coordinator. Round table = multi-voice discussion. The structure supports both, even though only software dev ships now.

---

## Data Model

### Formations (replace channels)

A formation defines a mode of working. It is not a chat room — it's an operational context.

```typescript
interface Formation {
  id: string;
  name: string;                              // "Software Dev", "Round Table"
  type: "coordinator" | "roundtable";        // interaction pattern
  agent_roster: string[];                    // which agents participate
  active: boolean;
  created_at: string;
}
```

**v1:** Only "Software Dev" formation exists (type: `coordinator`, full agent roster). The Formation Selector UI supports switching, but there's only one option. This ensures the infrastructure is built correctly before adding complexity.

**Future:** "Round Table" formation (type: `roundtable`) with multi-voice interaction pattern. Each agent speaks as themselves. Different agent rosters per formation.

### Threads (isolated conversations within a formation)

Each thread is a fully isolated conversation with its own Supabase `conversation_id`.

```typescript
interface ChatThread {
  id: string;
  formation_id: string;                      // which formation this belongs to
  conversation_id: string;                   // Supabase conversations table FK
  type: "main" | "direct" | "group";
  name: string;                              // "Main", "James", "Brian & Alan"
  agents: string[];                          // agents in this thread
  routing_mode: "coordinated" | "direct";    // coordinator or direct-to-agent
  created_at: string;
  last_message_at: string;
}
```

**Thread types:**
- `main` — one per formation. The command center. Ellie's voice, workflow badges, dispatches, approvals. All agents contribute through Ellie.
- `direct` — 1:1 conversation with a specific agent. Messages route directly to that agent, not through the coordinator.
- `group` — conversation with multiple specific agents. Each speaks as themselves. (Future — needed for round table, spec'd but not built in Phase 1.)

**Key constraint:** Each thread has its own `conversation_id`. When loading a thread, only messages with that `conversation_id` are fetched. No filtering — true isolation at the query level.

### Multi-Contributor Attribution

Messages that synthesize input from multiple agents carry contributor metadata.

```typescript
// Existing message metadata, extended:
interface MessageMetadata {
  agent: string;                             // primary voice (usually "ellie")
  thread_id: string;                         // which thread
  contributors?: string[];                   // agents who contributed (e.g., ["brian", "alan"])
  work_item_id?: string;
  // ... existing fields
}
```

**Rules:**
- `agent` is always the presenting voice (Ellie in coordinator formation)
- `contributors` lists every agent who was dispatched and whose output was synthesized into this response
- If only one agent responded (no synthesis), `contributors` is omitted — `agent` is sufficient
- The coordinator already knows which agents were dispatched (orchestration ledger) — the change is propagating that list into the message metadata when calling `complete`

---

## Message Routing

### Outgoing (user sends)

| User is in | Message tagged with |
|------------|-------------------|
| Main thread | Main thread's `conversation_id` + `thread_id` |
| Direct thread (James) | James thread's `conversation_id` + `thread_id` |

The WebSocket `message` payload already includes `thread_id`. The change is ensuring it maps to a real `conversation_id` for storage, not just a filter hint.

### Dispatch Routing

When work is dispatched from a thread:

1. Dispatch record includes `source_thread_id` — which thread initiated the work
2. When the agent completes, the response is saved with the source thread's `conversation_id`
3. The main channel gets a compact indicator: "James completed review in thread [James]" — but not the full response
4. If the dispatch originated from the main channel, the response lands in the main channel (current behavior)

### Loading Messages

| View | Query |
|------|-------|
| Main thread | `SELECT * FROM messages WHERE conversation_id = {main_conversation_id} ORDER BY created_at` |
| Direct thread | `SELECT * FROM messages WHERE conversation_id = {thread_conversation_id} ORDER BY created_at` |

No cross-loading. No filtering. True isolation.

### Agent Context in Threads

When an agent responds in a direct thread, their prompt includes:
- That thread's conversation history (not the main channel's)
- The thread's context (which agents are present, what the thread is about)
- The agent's own Forest knowledge (already working via scoped retrieval)

This means James in a direct thread sees only what you've discussed with him there. He doesn't get the entire main channel dumped into his context.

---

## Memory Attribution Pipeline

### Today (broken)

```
User asks for review → Coordinator dispatches Brian + Alan →
Brian reviews, Alan reviews → Coordinator synthesizes →
Message saved: { agent: "ellie" } →
Memory extraction: plants in Ellie's tree only →
Brian and Alan have no memory of participating
```

### After fix

```
User asks for review → Coordinator dispatches Brian + Alan →
Brian reviews, Alan reviews → Coordinator synthesizes →
Message saved: { agent: "ellie", contributors: ["brian", "alan"] } →
Memory extraction:
  → Plants in Ellie's tree (she presented it)
  → Plants in Brian's tree (3/brian) — tagged as his contribution
  → Plants in Alan's tree (3/alan) — tagged as his contribution →
Brian and Alan remember participating when talked to later
```

### Implementation Points

**1. Coordinator `complete` tool:** When the coordinator calls `complete`, it includes the list of agents that were dispatched during this conversation turn. The handler reads this list and writes it as `contributors` in the message metadata.

**2. Memory extraction (`processMemoryIntents`):** When processing a message with `contributors`, for each extracted memory:
- Write to the primary agent's scope (Ellie's — already happens)
- For each contributor, write a copy to their agent scope (`3/{agent_name}`)
- The copy includes metadata: `{ contributed_via: "ellie", thread_id, work_item_id }`

**3. Forest scope for agent contributions:** Agent scopes already exist at `3/brian`, `3/alan`, etc. (created in earlier Forest cleanup). Contributor memories go there, tagged so they're distinguishable from the agent's own observations.

---

## UI Changes

### Header Bar

**Before:**
```
[Ellie Chat] [Avatar] [Mode Selector ▾] [Thread Selector ▾] [New Chat] [Avatar] [Read Mode] [TTS] [Dispatches] [●]
```

**After:**
```
[Formation ▾] Ellie Chat [Thread ▾] [New Thread] [Avatar] [Read Mode] [Dispatches] [●]
```

Changes:
- **Formation Selector** replaces Mode Selector on the left. Shows active formation name. Dropdown lists available formations (only "Software Dev" in v1).
- **Mode Selector (`EllieModeSelector`) removed.** The layered prompt system handles mode detection automatically based on message content and channel.
- **"New Chat" → "New Thread"** — creates a new thread within the current formation.
- **TTS provider toggle** stays (only visible when Read Mode is active).
- **Dispatch badge** stays.
- **Connection indicator** stays.

### Main Thread View (Command Center)

- Shows only messages from the main thread's `conversation_id`
- Ellie's voice — all responses show Ellie as primary
- Workflow badges: dispatch cards, approval requests, spawn status indicators
- Compact thread indicators when dispatch results land in other threads: "[James completed ELLIE-500 review → thread]"
- Workshop debrief messages render as collapsible structured cards with Workshop icon

### Direct Thread View

- Full message isolation — only this thread's messages
- Thread header shows agent avatar(s) and name(s)
- Responses come directly from the agent (not through Ellie's coordinator)
- Back navigation returns to main thread with its own message loading
- Thread remembers scroll position per session

### Multi-Contributor Messages

Messages with `contributors` in metadata:

```
┌──────────────────────────────────────────────┐
│ [Ellie 🟢] [Brian 🟠] [Alan 🟢]   2 min ago │
│                                               │
│ Ellie's synthesized response here...          │
│ Brian found two issues in the schema...       │
│ Alan recommends a phased approach...          │
└──────────────────────────────────────────────┘
```

- Ellie's avatar is primary (normal size)
- Contributor avatars are secondary (smaller, in a row after Ellie's)
- Same color coding as agent profiles (Brian=amber, Alan=green, etc.)
- Clicking a contributor avatar could navigate to their direct thread (future)

### Workshop Messages

Workshop debriefs render as a distinct card:

```
┌─ [⚙] Workshop ──────────────────────────────┐
│ Workshop Debrief: Layered Prompt Architecture │
│                                               │
│ Summary: Built 3-layer prompt architecture... │
│ Decisions: 9 | Docs: 7 | Forest writes: 156  │
│                                               │
│ [▾ Expand details]                            │
└──────────────────────────────────────────────┘
```

- Distinct icon (gear/tool, not an agent circle)
- Collapsible — summary line visible by default, full debrief on expand
- Styled differently from agent messages (subtle border, different background)

---

## Phasing

### Phase 1: Plumbing (Backend)

Fix the data layer so threads are truly isolated and attribution works.

1. **Thread conversation isolation** — each thread creates/uses its own `conversation_id`. Existing threads migrated to have dedicated conversation IDs. Historical messages in the old shared conversation stay where they are (they predate isolation and aren't worth re-sorting). New messages from this point forward go to the correct thread conversation.
2. **Dispatch source tracking** — dispatch records include `source_thread_id`. Responses route back to originating thread.
3. **Message loading by conversation** — thread switching loads messages by `conversation_id`, not by filtering a shared stream.
4. **Contributor metadata on coordinator responses** — coordinator `complete` propagates dispatched agent list into message metadata.
5. **Memory pipeline contributor attribution** — extraction writes to each contributor's Forest tree.
6. **Formation data model** — create formations table/config. Migrate existing channel data to formations. Software Dev as default.

### Phase 2: UI Consolidation (Frontend)

Make it look and feel right.

1. **Replace Mode Selector with Formation Selector** — new `FormationSelector.vue` component.
2. **Thread Selector scoped to formation** — only shows threads belonging to active formation.
3. **True thread isolation in UI** — switching threads reloads messages from that thread's conversation only.
4. **Contributor avatars** — multi-agent messages show contributor icons.
5. **Workshop message cards** — distinct rendering for Workshop debrief messages.
6. **Remove dead UI** — EllieModeSelector, any orphaned channel sidebar references.
7. **Thread creation flow** — "New Thread" creates a direct thread with selected agent(s) within current formation.

### Phase 3: Future (Spec'd, Not Built)

- Round table formation with multi-voice UI
- Group threads where multiple agents speak as themselves
- Formation-specific agent rosters
- Formation switching changes the entire chat context
- Cross-thread search within a formation

---

## What Doesn't Change

- **Ellie is still the primary voice** in the software dev formation
- **WebSocket connection pattern** — single persistent connection, same protocol
- **Message storage** — Supabase messages table, same schema (just using `conversation_id` correctly)
- **Agent profiles and colors** — existing system, already working
- **Read Mode, Avatar, Phone Mode** — these features are unaffected
- **Dispatch system** — coordinator, agents, orchestration ledger — all untouched, just better routing of results

## Success Criteria

1. **Thread isolation works** — switching between main and a direct thread loads completely different message sets. No bleed-through.
2. **Dispatch results route correctly** — work initiated from a James thread produces a response in that thread, not in main.
3. **Contributors are visible** — multi-agent responses show contributor avatars. Memory pipeline plants in each contributor's Forest tree.
4. **Formation selector replaces mode selector** — clean header, no redundant controls.
5. **Workshop debriefs render distinctly** — collapsible cards with Workshop identity.
6. **Dave can have a useful direct conversation with James** — James remembers the thread context, responses stay in the thread, and his Forest tree accumulates the knowledge.
