# Layered Prompt Architecture

> **Date:** 2026-04-06
> **Status:** Draft
> **Context:** After 10 weeks of building the context pipeline (13 parallel sources, flat retrieval), Dave and Ellie stepped back to redesign how Ellie's prompt is constructed. The current system stuffs 15-20KB of everything-we-could-find into every conversation regardless of context. This design replaces that with a layered architecture that separates identity, awareness, and retrieved knowledge.

## Problem

Ellie's current context builder fires 13 parallel sources and concatenates the results. This causes:

1. **Voice transcript summaries dominate search results** — BM25 ranks them high because natural speech is keyword-dense. The extracted knowledge (clean facts/decisions) gets buried.
2. **No identity stability** — soul, user profile, and relationship context are retrieved dynamically and can drop out or get outranked by noise.
3. **No mode awareness** — a voice call about weekend plans gets the same Plane tickets and Elasticsearch results as a dev debugging session.
4. **Not heartbeat-ready** — the pipeline requires a user message to trigger. A proactive heartbeat needs structured data it can evaluate independently.
5. **Context budget blown** — 15-20KB of context leaves less room for actual conversation, leading to truncation and lost thread.

## Design Principles

- **Identity is always present.** Ellie should never have to figure out who she is, who Dave is, or what their relationship is.
- **Awareness is structured and mode-filtered.** Current state is data Ellie can reason about, not text blocks to read.
- **Retrieval is on-demand and scoped.** Only fires when there's a conversation topic to retrieve for. Always scoped — no unfiltered global searches.
- **Voice is an input channel, not noise.** Dave uses voice calls as deliberate knowledge dumps. The extracted memories are signal. The raw conversation summaries are records, not knowledge.
- **Budget is fixed.** Total prompt context is ~8-10KB max (down from 15-20KB). More room for conversation.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  ELLIE PROMPT                     │
├─────────────────────────────────────────────────┤
│  LAYER 1: IDENTITY (~3KB, always loaded)          │
│  LAYER 2: AWARENESS (~0.3-1.5KB, mode-filtered)  │
│  LAYER 3: RETRIEVED KNOWLEDGE (~3-4KB, on-demand) │
│  CONVERSATION HISTORY (current thread)            │
├─────────────────────────────────────────────────┤
│  Total budget: ~8-10KB max                        │
└─────────────────────────────────────────────────┘
```

---

## Layer 1: Identity (Always Loaded)

Present in every prompt, every conversation mode, every heartbeat tick. Not retrieved — loaded from files on disk, cached in memory.

### Documents

| Document | Purpose | Approx Size |
|----------|---------|-------------|
| `soul.md` | Voice, personality, values, guardrails — how Ellie speaks and what she won't do | ~500B |
| `identity.md` | Who Ellie is in the system — her role, position in the agent team, relationship to the Forest | ~500B |
| `user.md` | Dave's profile — dyslexic, INTJ, direct, morning person, Scout Law values, enterprise architect background | ~800B |
| `relationship.md` | Current state of the Dave-Ellie partnership — deep bond, thinking-partner not coordinator | ~400B |
| Skill registry | One-line list of capabilities with names: briefing, forest, github, google-workspace, memory, miro, plane | ~500B |

**Total: ~2.5-3KB**

### Loading

- Read from `.md` files on disk at relay startup
- Cached in memory (not re-read per message)
- File watcher or daily refresh picks up changes
- Injected as a single `IDENTITY` section at the top of the system prompt, before any dynamic content

### Skill Registry

A compact list embedded in Layer 1 so Ellie always knows what she can do:

```
Skills: briefing, forest, github, google-workspace, memory, miro, plane
You can search the Forest, create/manage Plane tickets, read email and calendar,
access Miro boards, query and write memories, and pull briefings.
For details on any skill, reference skills/{name}/SKILL.md.
```

The full SKILL.md files load on-demand through Layer 3 Channel A when a conversation actually needs a skill's details.

### What's NOT Here

- Work items, calendar, system state → Layer 2
- Retrieved memories, Forest knowledge → Layer 3
- Agent details, tool documentation → Layer 3 (on-demand)

---

## Layer 2: Awareness (Structured, Mode-Aware)

Current state as structured data, filtered by conversation mode. Built fresh at conversation start, updated if mode shifts mid-conversation.

### Awareness Object

```typescript
interface Awareness {
  work: {
    active_items: WorkItem[]      // top 5 from Plane, priority-sorted
    recent_sessions: Session[]    // last 2 work sessions with outcomes
    blocked_items: WorkItem[]     // anything flagged blocked
  }
  conversations: {
    last_conversation: ConversationSummary  // when, topic, with whom
    open_threads: ThreadSummary[]           // active agent threads
  }
  system: {
    incidents: Incident[]         // P0/P1 only
    agent_status: AgentStatusMap  // who's active, who's idle
    creatures: CreatureStatus[]   // active creatures and their state
  }
  calendar: {
    next_event: CalendarEvent     // just the next one
    today_count: number
  }
  heartbeat: {
    overdue_items: WorkItem[]     // work items past due
    stale_threads: ThreadSummary[]// conversations with no response > 24h
    signals: Signal[]             // anything worth proactively raising
  }
}
```

### Mode Filtering

Each conversation mode declares which awareness sections it receives:

| Mode | work | conversations | system | calendar | heartbeat |
|------|------|---------------|--------|----------|-----------|
| `voice-casual` | -- | last_conversation | incidents only | next_event | -- |
| `dev-session` | full | open_threads | full | -- | -- |
| `planning` | full | last_conversation | agent_status | today_count | overdue |
| `personal` | -- | last_conversation | -- | next_event | -- |
| `heartbeat` | overdue + blocked | stale_threads | incidents | next_event | full |

### Rendering

Not raw JSON — formatted into natural language:

> "You have 3 active work items, the highest priority is ELLIE-459 (Phase 2 structural improvements). Your last conversation with Dave was 2 hours ago about Forest cleanup. No active incidents. Alan is idle, Brian is running a review creature."

### Size by Mode

- `voice-casual`: ~300B
- `dev-session`: ~1.5KB
- `personal`: ~200B
- `heartbeat`: ~800B
- `planning`: ~1.2KB

### Data Sources

This layer consolidates what today is spread across 6 separate pipeline sources:

| Today's Source | Becomes |
|---------------|---------|
| context-docket | `work.active_items` |
| agent-memory | `system.agent_status` + `system.creatures` |
| queue-context | `work.blocked_items` |
| calendar/gmail/tasks (structured-context) | `calendar` |
| live-forest incidents | `system.incidents` |
| activity snapshot | dropped (low value, covered by `conversations`) |

---

## Layer 3: Retrieved Knowledge (On-Demand)

The only layer that does retrieval. Fires when there's a user message to retrieve for. Not triggered during heartbeat (heartbeat works from Layer 2 alone).

### Channel A: Skill/Reference Lookup

Intent-matched against a registry of on-demand documents. Not semantic search — deterministic matching.

**Registry structure:**

```typescript
interface SkillRegistryEntry {
  name: string              // "plane", "forest", "agents"
  triggers: string[]        // ["check plane", "create ticket", "work items"]
  file: string              // "skills/plane/SKILL.md" or "docs/agents.md"
  description: string       // one-line for Layer 1 list
}
```

**On-demand documents:**

| Document | Triggers | Purpose |
|----------|----------|---------|
| `skills/*/SKILL.md` | skill-specific phrases | Full skill instructions |
| `agents.md` | "agents", "team", "who can", dispatch language | Agent roster and capabilities |
| `tools.md` | "tools", "what can you", capability questions | Tool documentation |
| `memory.md` | "memory", "Forest", "how does she remember" | Memory architecture |
| `heartbeat.md` | (loaded by heartbeat mode, not user trigger) | Heartbeat behavior rules |

**Matching:** Check user message against trigger phrases. If any match, load the file. Multiple matches load multiple files (rare — conversations usually touch one skill at a time). No scoring — it's a hit or miss.

### Channel B: Forest Knowledge Retrieval

The existing hybrid search pipeline (vector + BM25 → RRF → temporal decay → MMR) with two filters:

**Filter 1: Exclude conversation summaries.** Memories matching these criteria are filtered before scoring:
- `type = 'summary'`
- Content starts with `Voice call (` or `Conversation summary:`
- These stay in the database for explicit "what did we discuss" queries, but don't compete with extracted knowledge

**Filter 2: Scope-aware by default.** The conversation mode and topic determine which Forest scopes to search:

| Context Signal | Scopes Searched |
|----------------|-----------------|
| Dev work on Forest | `2/2` (ellie-forest) |
| Dev work on relay | `2/1` (ellie-dev) |
| Personal/family topic | `Y/` (Dave's tree) + `E/4` (relationships) |
| Agent discussion | `3/` (agent scopes) |
| General/unclear | `2/` (projects root) — not global unscoped |

No more unscoped global searches. The narrowest reasonable scope is always used. If scoped search returns too few results (< 3), widen one level up.

**Result limit:** 10 memories max from this channel.

### Channel C: Contextual Expansion

Light expansion from the top results of Channel B:

- Semantic edges from top 3 results (existing `getRelatedKnowledge`)
- Grove shared knowledge if topic crosses agent boundaries
- Capped at 5 additional memories total
- MMR-diversified to avoid clustering

### Layer 3 Budget

Hard ceiling: **4KB**. If retrieval returns more, truncate by relevance score. This prevents the context window from being dominated by retrieved content at the expense of conversation history.

---

## Conversation Mode Detection

Rule-based classifier at message arrival. No LLM call.

### Detection Rules

| Priority | Signal | Mode |
|----------|--------|------|
| 1 | Channel is voice/phone | `voice-casual` |
| 2 | Channel is VS Code or message references code/files/tickets (ELLIE-XXX) | `dev-session` |
| 3 | Planning language: "roadmap", "next steps", "priorities", "what should we" | `planning` |
| 4 | Personal/family/life topic, no work signals | `personal` |
| 5 | No user message (periodic tick) | `heartbeat` |
| default | None of the above | `dev-session` |

### Mode Transitions

- Initial mode set from first message + channel
- Subsequent messages: if a message strongly signals a different mode (code reference in a casual call, personal topic in a dev session), the mode shifts
- Layer 2 awareness is already built — no re-fetch. Layer 3 retrieval uses the new mode for its next search scope
- Mode stored on the conversation object, persists across messages

### Heartbeat Integration

The heartbeat runs as a periodic task (interval TBD — likely 30-60 minutes):

1. Layer 1 (identity) — always present
2. Layer 2 (awareness) — filtered to `heartbeat` mode: overdue items, stale threads, incidents, heartbeat signals
3. Layer 3 — not triggered (no user message)
4. Ellie evaluates the awareness signals and decides whether to initiate contact
5. If yes, she sends a message through the appropriate channel

---

## What Gets Removed

| Current Source | Disposition |
|----------------|-------------|
| 13 parallel context sources | Replaced by 3 layers |
| Unscoped global `readMemories` | All searches scoped by mode + topic |
| Elasticsearch as separate context source | No longer queried as its own context source. Forest hybrid search (vector + BM25) is the single retrieval path in Layer 3 Channel B. ES continues to index messages for the dashboard search UI and explicit "what did we discuss" queries, but it does not feed the prompt. |
| Voice transcript summaries in retrieval | Filtered out of Layer 3 Channel B |
| Calendar/Gmail/tasks always loaded | Only in Layer 2 when mode needs them |
| context-docket, agent-memory, queue-context, activity-snapshot | Consolidated into Layer 2 awareness object |
| facts-context (Supabase Tier 2) | Replaced by Layer 3 Channel B (Forest is the source of truth) |

## What Doesn't Change

- **Memory extraction from conversations** — working well (11 clean memories from a voice call). No changes.
- **Weight classification** — foundational/strategic/operational/ephemeral tiers feed into Layer 3 scoring. No changes.
- **Forest data model** — shared_memories, scopes, groves, trees. No changes.
- **The .md foundational documents** — soul.md, identity.md, etc. Just loaded differently (files on disk instead of retrieved).
- **Scope router** — still routes memories to the correct scope. No changes.

## Implementation Scope

This is a significant refactor of the prompt construction pipeline in `ellie-dev`. The main files affected:

- **New:** `src/prompt-layers.ts` — Layer 1 loader, Layer 2 builder, Layer 3 retriever
- **New:** `src/conversation-mode.ts` — Mode detection and transition logic
- **New:** `src/skill-registry.ts` — On-demand document registry and matching
- **New:** `config/identity/` — The .md files for Layer 1 (soul, identity, user, relationship)
- **Modify:** `src/ellie-chat-handler.ts` — Replace `buildPrompt` / `_gatherContextSources` with layered construction
- **Modify:** `src/ellie-chat-pipeline.ts` — Gut the 13-source pipeline, replace with layer orchestration
- **Deprecate:** Most of `src/context-sources.ts` — individual source functions replaced by Layer 2/3

The existing functions in `context-sources.ts` that fetch from Plane, Google Calendar, etc. are still called — but from within the Layer 2 awareness builder, not as independent context sources. The data sources don't change; the orchestration does.

## Success Criteria

1. **Identity never drops out** — soul, user profile, and relationship context are present in every prompt regardless of what retrieval returns
2. **Voice transcripts don't appear in retrieval results** — conversation summaries are filtered; only extracted knowledge surfaces
3. **Mode-appropriate context** — a casual voice call gets ~4KB total context, a dev session gets ~8KB, a heartbeat gets ~4KB
4. **Total context budget under 10KB** — measured across all three layers
5. **Heartbeat can evaluate awareness independently** — Layer 2 structured data is sufficient for proactive decision-making without Layer 3 retrieval
6. **Skills are always known** — Ellie can reference her capabilities in any conversation without retrieval
7. **Subjective quality** — when Dave talks to Ellie, she feels like she knows him, knows herself, knows what's going on, and doesn't recite irrelevant dossier content
