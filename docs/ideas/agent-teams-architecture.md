# Agent Teams Architecture — Design Concept

> Captured from conversation on Feb 18, 2026. Originated from the todo: "Work on agent concept and flesh it out more."

---

## Core Vision

Dave talks to **Ellie** — one voice, one identity. Behind the scenes, Ellie orchestrates **agent teams** assembled around domains. Multiple teams can be active simultaneously, and the system auto-routes messages to the right team(s) based on context.

```
Dave ←→ Ellie (orchestrator)
              │
              ├── analyzes context
              ├── selects best agent team(s)
              │
              ├── Software Dev Team
              │    ├── code generation
              │    ├── code review
              │    ├── project management
              │    └── research
              │
              ├── Family Organizer Team
              │    ├── calendar management
              │    ├── meal planning
              │    └── reminders
              │
              ├── Kid's Learning Team
              │    ├── tutoring
              │    ├── progress tracking
              │    └── encouragement
              │
              └── EVE Online Team
                   ├── PI optimization
                   ├── market analysis
                   └── strategy
```

## Key Terminology

- **Agent teams** (not "use cases") — the top-level organizational concept
- Teams are assembled around domains (Software Dev, Family Organizer, etc.)
- Individual agents become **composable skills** within teams
- Ellie is the **orchestrator** — she selects the best team(s) per message

## Orchestration Model

Ellie is the hub. Teams don't talk directly to each other — Ellie mediates all collaboration (Option C: Ellie-mediated collaboration).

**Why Option C over alternatives:**
- **Option A (hub-only):** All communication flows through Ellie. Simpler but Ellie becomes a bottleneck on complex multi-team tasks.
- **Option B (mesh):** Teams collaborate directly. Faster but harder to control — conflicting advice risk.
- **Option C (hybrid/mediated):** Teams can request context from each other through Ellie. She stays the single voice, mediates conflicts, and brokers information exchange.

```
Dave ←→ Ellie
           │
           ├── dispatches to Team A
           ├── dispatches to Team B
           ├── Team A says "I need calendar data"
           │   └── Ellie routes that to Family Organizer
           └── Ellie merges both responses
```

**What Ellie needs to be good at:**
- **Intent classification** — "what team(s) does this touch?"
- **Context isolation** — pulling the right data for the right team without noise
- **Response blending** — if two teams contributed, the answer still reads as one coherent Ellie response
- **Graceful ambiguity** — if she's not sure which team, she doesn't guess wrong, she responds naturally and adapts

## Multi-User & Multi-Channel

### The Real-World Scenario

Two users, different channels, hitting Ellie at the same time:

```
Request 1: Dave (Google Chat) → "Review this PR"
  → Ellie routes to Software Dev Team
  → Pulls Plane context, git diff, code review skills

Request 2: Georgia (Alexa) → "Is my dad in a meeting?"
  → Ellie routes to Family Organizer Team
  → Checks Dave's calendar, returns spoken answer
```

### Architectural Requirements

1. **Session isolation** — each request gets its own context. Dave's code review doesn't bleed into Georgia's calendar query. Separate processing pipelines running in parallel.

2. **Identity awareness** — Ellie knows *who* is asking. Dave is the owner. Georgia is a family member with limited access.

3. **Permission boundaries:**
   - **Dave:** full access to everything
   - **Georgia:** can query family-scoped data (calendar, shared lists, weather), cannot access work data, financial data, or admin functions
   - **Future users:** each gets their own permission profile

4. **Cross-team context sharing** — Georgia's question ("is dad in a meeting?") may need Software Dev Team's awareness. If Dave is in a deep work session on ELLIE-42, that's relevant. Ellie mediates: Family Organizer asks "is Dave busy?" → Ellie checks both calendar AND active work session → returns blended answer: "Dad's working on a coding project right now, but he's free at 3."

5. **Channel-appropriate responses** — Dave gets detailed text on Google Chat. Georgia gets a short spoken sentence on Alexa. Same orchestrator, different output formatting.

### Processing Model

```
┌─────────────────────────────────┐
│         Ellie Orchestrator       │
│                                  │
│  Request Queue / Event Loop      │
│  ┌──────────┐  ┌──────────┐    │
│  │ Dave's    │  │ Georgia's │    │
│  │ session   │  │ session   │    │
│  │           │  │           │    │
│  │ identity: │  │ identity: │    │
│  │ owner     │  │ family    │    │
│  │ channel:  │  │ channel:  │    │
│  │ gchat     │  │ alexa     │    │
│  │ team: Dev │  │ team:     │    │
│  │           │  │ Family    │    │
│  └──────────┘  └──────────┘    │
│       │              │          │
│       ▼              ▼          │
│  [parallel processing]          │
│  [independent responses]        │
└─────────────────────────────────┘
```

### Family Member Identity Options
- **Alexa voice profiles** — Alexa distinguishes "Georgia's voice" from "Dave's voice" with different user IDs
- **Channel-based** — Georgia's Alexa device is registered to her, Dave uses Google Chat / Telegram
- **PIN-based** — "Alexa, ask Ellie (pin 1234) to show my work items" for elevated access

Simplest starting point: each channel/device maps to an identity, identities have permission tiers (owner, family, guest).

## Implementation Roadmap

### Phase 1: Multi-Channel Foundation
*What we have + Alexa*

Build ELLIE-42 (Alexa Custom Skill). This gives two channels (Telegram/GChat + Alexa) and forces us to formalize the **channel abstraction** — every incoming message has a `channel`, `user_id`, and `response_format`. The relay already handles this loosely; make it explicit.

**Unlocks:** multiple channels, channel-appropriate responses

### Phase 2: Identity & Permissions Layer

Add a `users` table and `permissions` system. Dave = owner (full access). Georgia = family tier (calendar, shared lists, no work data). Each channel maps to an identity. The relay checks permissions before routing.

**Unlocks:** multi-user, Georgia on Alexa, permission boundaries

### Phase 3: Agent Teams as Config

Replace the current `agents` table with a **teams** schema: team name, description, skills roster, persona config, context sources, and active/inactive status. The existing `route-message` edge function evolves from "pick an agent" to "classify intent → select team(s)." Start config-driven (JSON/DB rows), not self-describing.

**Unlocks:** organized capabilities, clean routing, dashboard visibility (ELLIE-44)

### Phase 4: Parallel Session Processing

Refactor the relay to handle concurrent requests as **independent sessions** — each with its own identity, team selection, and context window. Right now messages are processed sequentially. This makes them parallel with session isolation.

**Unlocks:** Dave and Georgia hitting Ellie simultaneously

### Phase 5: Cross-Team Context Brokering

The Ellie orchestrator recognizes when one team needs data from another's domain and brokers the exchange. "Is dad busy?" checks both calendar AND active work sessions. This is the Option C collaboration model.

**Unlocks:** smart multi-domain answers, the "household AI" feel

### Recommended Starting Order

Start with **Phase 1 + 2 together** — Alexa channel + identity layer. They're natural pairs, and having Georgia actually talking to Ellie on Alexa gives a real test case for everything that follows. Phase 3 is the meatiest architectural work. Phases 4-5 are refinements.

## Related Work Items

- **ELLIE-42:** Build Alexa Custom Skill integration (Phase 1 prerequisite)
- **ELLIE-43:** Build Alexa+ Multi-Agent SDK integration (future voice channel)
- **ELLIE-44:** Add capabilities/skills page to dashboard (Phase 3 visibility)

## Current State vs. Target

**Current:** Single agent routing via `route-message` edge function. Keyword-based classification to individual agents. Sequential message processing. Single user (Dave).

**Target:** LLM-powered intent classification into agent teams. Parallel session processing with identity/permission isolation. Multi-user, multi-channel. Cross-team context brokering through Ellie orchestrator.

## Open Questions

- What fields define an agent team in the database? (name, description, skills roster, persona config, context sources, active/inactive — needs detailed schema design)
- How granular should permissions be? Role-based (owner/family/guest) vs. fine-grained per-resource?
- Should teams have their own system prompts, or should Ellie compose prompts dynamically based on active team(s)?
- How does the current agents table migrate to the teams schema?
