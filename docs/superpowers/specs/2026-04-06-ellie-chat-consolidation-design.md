# Ellie Chat Consolidation — Design Spec

> **Date:** 2026-04-06
> **Status:** Reviewed (Rev 2 — incorporates feedback from Ellie, Alan, Brian)
> **Context:** Ellie Chat was the first thing built and has accumulated competing concepts (channels vs threads), half-finished features, and broken plumbing. This spec consolidates the experience — fixing data isolation, message attribution, and UI coherence — following the same "step back and get it right" approach that worked for the prompt architecture.

## Problem

Ellie Chat has four interconnected issues:

1. **Channels and threads compete.** Channels were built first, didn't work well, the sidebar was removed. Threads were added for direct agent chat but don't fully work either. Two overlapping concepts, neither complete.

2. **Thread isolation is broken.** Messages from all threads dump into one conversation stream. Switching threads filters the view but doesn't isolate the data. Dispatch results land in the main flow regardless of origin. Loading a thread shows messages from other threads.

3. **Agent attribution is lost.** When Brian and Alan review a spec, Ellie presents the unified response. But the message only records `agent: "ellie"` — Brian and Alan's contributions are invisible to the memory pipeline. Their Forest trees never get the knowledge, and when Dave talks to them directly, they have no memory of participating.

4. **UI clutter.** The Mode Selector dropdown is now redundant (the layered prompt system auto-detects mode). Workshop messages have no visual identity. The header has accumulated controls without coherent organization.

## Design Principles

- **Dave is dyslexic.** Ellie Chat is his primary interface with the system. Every UI decision must reduce cognitive load, not add it.
- **Ellie is the voice.** In the default domain, Ellie presents — but contributors are visually acknowledged and their knowledge is preserved.
- **Threads are isolated workspaces.** Not filters on a shared stream. Separate conversations, separate message loading, separate context.
- **Domains define the interaction pattern.** Software dev = one-voice coordinator. Round table = multi-voice discussion. The structure supports both, even though only software dev ships now.

---

## Data Model

### Domains (replace channels)

> **Naming note:** The codebase already uses "formation" for multi-agent orchestration protocols (`fan-out`, `debate`, `pipeline` in `src/formations/protocol.ts`). To avoid confusion, the UI concept is called **"Domain"** — a domain is an operational context, a formation is an orchestration pattern. A domain *may invoke* formations internally, but they are different concepts.

A domain defines a mode of working. It is not a chat room — it's an operational context that determines the interaction pattern and which agents participate.

**v1: Hardcoded, not database-driven.** Only "Software Dev" domain exists. The Domain Selector shows it as static text (not a dropdown with one option — that's cognitive noise). No `domains` table, no database abstraction. When a second domain is needed (Round Table), we extract the abstraction then. YAGNI.

```typescript
// v1: hardcoded domain config, not a database table
const DEFAULT_DOMAIN = {
  id: "software-dev",
  name: "Software Dev",
  type: "coordinator" as const,              // Ellie coordinates, one voice
  agent_roster: ["ellie", "james", "kate", "alan", "brian", "amy", "marcus", "jason"],
};

// Future domain example (not built in v1):
// { id: "round-table", name: "Round Table", type: "roundtable", agent_roster: [...] }
```

### Threads (isolated conversations within a domain)

Each thread uses `thread_id` as its primary isolation key. The existing `thread_id` column on the messages table is used directly — no separate `conversation_id` mapping needed.

> **Resolution (Brian's feedback):** The original spec proposed a 1:1 thread-to-conversation mapping which was redundant with the existing `thread_id` column. Instead: `thread_id` IS the isolation key. Messages are queried by `thread_id`. A thread persists permanently — it does not create new conversations per session. This preserves continuity (all history in a James thread is always available).

```typescript
interface ChatThread {
  id: string;                                // UUID — this is the thread_id on messages
  domain_id: string;                         // which domain this belongs to
  type: "main" | "direct";                   // main = command center, direct = 1:1 agent
  name: string;                              // "Main", "James", "Brian & Alan"
  agents: string[];                          // agents in this thread
  routing_mode: "coordinated" | "direct";    // coordinator or passthrough-to-agent
  created_at: string;
  last_message_at: string;
}
```

**Thread types:**
- `main` — one per domain. The command center. Ellie's voice, workflow badges, dispatches, approvals. All agents contribute through Ellie.
- `direct` — 1:1 conversation with a specific agent. Messages route through the coordinator with a forwarding instruction (see Direct Thread Routing below).

> **Removed from v1 (team feedback):** The `group` thread type was speculative. Round table interactions will need a `domain-session` type, not freeform group chat. Will be designed when the round table domain is built.

**Key constraint:** Each thread has its own `thread_id`. When loading a thread, only messages with that `thread_id` are fetched. No filtering — true isolation at the query level.

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
- `agent` is always the presenting voice (Ellie in coordinator domain)
- `contributors` lists every agent who was dispatched and whose output was synthesized into this response
- If only one agent responded (no synthesis), `contributors` is omitted — `agent` is sufficient
- The coordinator already knows which agents were dispatched (orchestration ledger) — the change is propagating that list into the message metadata when calling `complete`

---

## Message Routing

### Outgoing (user sends)

| User is in | Message tagged with |
|------------|-------------------|
| Main thread | Main thread's `thread_id` |
| Direct thread (James) | James thread's `thread_id` |

The WebSocket `message` payload already includes `thread_id`. The change is ensuring it's used as the actual isolation key for storage and retrieval.

### Direct Thread Routing

> **Resolution (all three flagged):** Direct threads do NOT bypass the coordinator. Instead, the coordinator receives the message with a forwarding instruction in its context: "Dave is in a direct thread with James — route this to James directly, do not coordinate across agents."
>
> This preserves:
> - Dispatch tracking (orchestration ledger still records the interaction)
> - Working memory updates (session state maintained)
> - The `complete` tool (response flows through the standard path)
> - The confirm protocol (agent can still request approval)
>
> What changes: the coordinator's prompt includes thread context telling it to pass through rather than coordinate. The agent receives the message as a direct dispatch with the thread's conversation history, not the main channel's.

### Dispatch Routing

When work is dispatched from a thread:

1. Dispatch record includes `source_thread_id` — which thread initiated the work
2. When the agent completes, the response is saved with the source thread's `thread_id`
3. The main channel gets a compact indicator: "James completed review in thread [James]" — but not the full response
4. If the dispatch originated from the main channel, the response lands in the main channel (current behavior)

**Implementation path (Brian's feedback):** The response write flows through `completeEnvelope()` → `writeOutcome()` → `dispatch_outcomes`. The `source_thread_id` must be carried through this chain. Specifically:
- Dispatch creation (`executeTrackedDispatch`) stores `source_thread_id` from the originating message
- `completeEnvelope` reads it from the dispatch record
- The final `saveMessage` call uses `source_thread_id` as the message's `thread_id`

### Loading Messages

| View | Query |
|------|-------|
| Main thread | `SELECT * FROM messages WHERE metadata->>'thread_id' = {main_thread_id} ORDER BY created_at` |
| Direct thread | `SELECT * FROM messages WHERE metadata->>'thread_id' = {thread_id} ORDER BY created_at` |

No cross-loading. No filtering. True isolation.

### Agent Context in Threads

When an agent responds in a direct thread, their prompt includes:
- That thread's message history (queried by `thread_id`)
- The thread's context (which agents are present, what the thread is about)
- The agent's own Forest knowledge (already working via scoped retrieval)

This means James in a direct thread sees only what you've discussed with him there. He doesn't get the entire main channel dumped into his context.

> **Cross-thread context gap (Alan's feedback):** If James does work in the main thread via the coordinator, and you then open a direct James thread and ask "tell me more" — James won't have that main-thread context. This is by design for v1. The workaround is explicit: "James, you reviewed ELLIE-500 earlier — tell me more about what you found." His Forest tree will have the attribution from that review (via contributor metadata). Full cross-thread context sharing is a Phase 3 concern.

---

## Memory Attribution Pipeline

> **Scoping note (Ellie + Brian):** This is a pipeline refactor, not just a metadata change. The current extraction is tag-driven (`[REMEMBER:]`, `[MEMORY:]`) via `processMemoryIntents`, and the Forest write path uses `forestSessionIds` with hardcoded scope resolution. Making attribution work requires changes to: `processMemoryIntents` (read contributors), `forestSessionIds` resolution (per-agent), creature_id handling (agents without active creatures), and scope_path override (contributor scope vs. primary scope). This is split into its own phase to manage risk.

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
- Must handle: resolving `forestSessionIds` per contributor agent, agents without an active `creature_id`, overriding the default `scope_path` for contributor writes

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
Software Dev  Ellie Chat  [Thread ▾] [New Thread] [Avatar] [Read Mode] [Dispatches] [●]
```

Changes:
- **Domain label** replaces Mode Selector on the left. Static text "Software Dev" (not a dropdown — only one domain in v1). Becomes a selector when a second domain is added.
- **Mode Selector (`EllieModeSelector`) removed.** The layered prompt system handles mode detection automatically based on message content and channel.
- **"New Chat" → "New Thread"** — creates a new thread within the current domain.
- **TTS provider toggle** stays (only visible when Read Mode is active).
- **Dispatch badge** stays.
- **Connection indicator** stays.

### Main Thread View (Command Center)

- Shows only messages with the main thread's `thread_id`
- Ellie's voice — all responses show Ellie as primary
- Workflow badges: dispatch cards, approval requests, spawn status indicators
- Compact thread indicators when dispatch results land in other threads: "[James completed ELLIE-500 review → thread]"
- Workshop debrief messages render as collapsible structured cards with Workshop icon

### Direct Thread View

- Full message isolation — only this thread's messages (queried by `thread_id`)
- Thread header shows agent avatar(s) and name(s)
- Responses route through coordinator with forwarding instruction — agent responds as themselves
- Back navigation returns to main thread with its own message loading
- Thread remembers scroll position per session
- Unread indicator on Thread Selector when new messages arrive in a thread you're not viewing

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

### Coherence Mechanisms (Alan's feedback)

Thread isolation must not create forgotten threads. Minimum viable attention signals:

- **Unread badge** on Thread Selector when a thread has new messages
- **Compact cross-thread indicators** in the main thread when dispatch results land elsewhere ("James completed review → [James thread]")
- **Thread last-activity sort** — most recently active threads appear first in the Thread Selector

Cross-thread search is deferred to Phase 3.

---

## Phasing

> **Revised phasing (team feedback):** Attribution is split out as its own phase (highest value, pipeline refactor). Thread isolation is separate (higher complexity, needs migration story). Domain abstraction is deferred.

### Phase 1A: Thread Isolation (Backend)

Fix thread data isolation so threads are truly separate conversations.

1. **Thread `thread_id` as isolation key** — each thread uses its own `thread_id`. New messages are tagged with the correct `thread_id` based on which thread the user is in.
2. **Message loading by `thread_id`** — thread switching loads messages by `thread_id`, not by filtering a shared stream.
3. **Dispatch source tracking** — dispatch records include `source_thread_id`. Responses route back to originating thread via the standard dispatch write path (`completeEnvelope` → `writeOutcome` → `saveMessage`).
4. **Direct thread routing** — coordinator receives messages from direct threads with forwarding context. Agent responds through the coordinator path but as themselves.
5. **Migration** — historical messages in the old shared conversation are assigned to the main thread's `thread_id`. They predate isolation and represent main-channel activity. No messages are lost — they all appear in the main thread.

### Phase 1B: Contributor Attribution (Backend)

Fix memory attribution so every contributing agent's Forest tree gets knowledge.

1. **Contributor metadata** — coordinator `complete` propagates dispatched agent list into message `contributors` metadata field.
2. **Memory pipeline extension** — `processMemoryIntents` reads `contributors` and writes extracted memories to each contributor's agent scope (`3/{agent_name}`).
3. **Forest session resolution** — handle `forestSessionIds` per-contributor, agents without active `creature_id`, scope_path override for contributor writes.

### Phase 2: UI Consolidation (Frontend)

Make it look and feel right.

1. **Domain label replaces Mode Selector** — static "Software Dev" text (becomes selector when second domain exists).
2. **Thread Selector scoped to domain** — only shows threads belonging to active domain.
3. **True thread isolation in UI** — switching threads reloads messages by that thread's `thread_id` only.
4. **Contributor avatars** — multi-agent messages show contributor icons.
5. **Workshop message cards** — distinct rendering for Workshop debrief messages.
6. **Coherence signals** — unread badges on threads, cross-thread indicators in main, last-activity sort.
7. **Remove dead UI** — EllieModeSelector, any orphaned channel sidebar references.
8. **Thread creation flow** — "New Thread" creates a direct thread with selected agent(s) within current domain.

### Phase 3: Future (Spec'd, Not Built)

- Round table domain with multi-voice UI and `domain-session` thread type
- Domain-specific agent rosters
- Domain switching changes the entire chat context
- Cross-thread search within a domain
- Cross-thread context sharing (agent sees main-thread work when in a direct thread)

---

## What Doesn't Change

- **Ellie is still the primary voice** in the software dev domain
- **WebSocket connection pattern** — single persistent connection, same protocol
- **Message storage** — Supabase messages table, same schema (using `thread_id` correctly for isolation)
- **Agent profiles and colors** — existing system, already working
- **Read Mode, Avatar, Phone Mode** — these features are unaffected
- **Dispatch system** — coordinator, agents, orchestration ledger — all untouched, just better routing of results
- **Orchestration formations** — fan-out, debate, pipeline protocols unchanged. "Domain" is a UI concept, "formation" remains an orchestration concept.

## Success Criteria

1. **Thread isolation works** — switching between main and a direct thread loads completely different message sets. No bleed-through.
2. **Dispatch results route correctly** — work initiated from a James thread produces a response in that thread, not in main.
3. **Contributors are visible** — multi-agent responses show contributor avatars. Memory pipeline plants in each contributor's Forest tree.
4. **Domain label replaces mode selector** — clean header, no redundant controls.
5. **Workshop debriefs render distinctly** — collapsible cards with Workshop identity.
6. **Dave can have a useful direct conversation with James** — James remembers the thread context, responses stay in the thread, and his Forest tree accumulates the knowledge.
7. **No orphaned messages** — historical messages appear in the main thread, not lost to migration.
