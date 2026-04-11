# Ellie App — Unified Consumer Platform Design (LEOS)

**Date:** 2026-04-04
**Status:** Approved (Rev 3 — final, incorporating team review)
**Author:** Dave + Claude (brainstorm session)
**Reviewers:** Ellie (coordinator), Alan (strategy), Brian (critic)

---

## 1. Vision

Ellie OS has three consumer-facing modules: **Life**, **Learn**, and **Work**. Together they form the **LEOS** (Ellie OS) consumer suite. These are not separate products — they are isolation of concerns based on what a person is doing and where they are in their life.

A single person may use all three. They have one Ellie, one identity, one conversation. Ellie knows what context they're in and adapts. The modules group concerns so they don't bleed into each other, but Ellie bridges them when it makes sense — knowing about a school event when planning the evening, or surfacing work deadlines when scheduling family time.

**Chat is the center of the universe.** Everything else — task lists, budgets, wellness dashboards, gradebooks — are structured views that support the conversation, not the other way around.

### Why This Matters — The Craftsman's Intent

Dave is a software architect with 35 years of experience. He is building LEOS as a master craftsman building products he can stand behind. AI-assisted development is his force multiplier — it removes the constraints that previously limited what a single architect could build. The technology choices in this document are not driven by developer comfort or familiarity. They are driven by one question: **what produces the best product for users?**

Every stack decision, every architectural choice, every tradeoff in this document is evaluated through that lens. When the team's existing expertise conflicts with what delivers the best product, the product wins. The craftsman's tools should serve the craft, not the other way around.

### Who Is This For?

The LEOS early adopter is someone managing multiple life domains who is tired of context-switching between disconnected apps — a different app for tasks, another for budgeting, another for health, another for their kid's school. They don't need more apps. They need one companion who knows the full picture.

The pain LEOS solves is not "I need a better task manager" or "I need a better budget app." It's: **no single app knows enough about my life to actually help me.** My budget app doesn't know I have a school event this week. My task app doesn't know I slept badly. My wellness tracker doesn't know about my work deadline. LEOS does — because it's one Ellie across all of it.

The cross-module awareness story — Jamie has a science project due Thursday, so Ellie suggests a lighter evening in your Life context — is not a feature detail. It's the core value proposition. It's the reason LEOS exists instead of three separate apps.

---

## 2. Two Worlds: Dave's Workshop and the Consumer Platform

This is a fundamental architectural boundary that shapes everything.

### Dave's Workshop (ellie-home + ellie-dev)

The multi-agent architecture stays. The 8 agents — Ellie, Alan, Brian, James, Kate, Amy, Marcus, Jason — are Dave's team. They review specs, catch issues, provide strategic input, write code, and critique decisions. This was proven during the creation of this very document: Ellie, Alan, and Brian reviewed the first draft and identified critical gaps.

The workshop is where ideas are proven at full power before being adapted for consumers. The 5-layer memory system, the multi-agent orchestration, the formation protocols, the round tables — all of this stays exactly where it is, powering the toolbench that creates and refines the consumer experience.

**Workshop stack:** Vue/Nuxt, Forest + Supabase + Elasticsearch, multi-agent routing, full orchestration. Untouched by this design.

### LEOS Consumer Platform (Life + Learn + Work)

The consumer platform has a **single Ellie**. One companion, one voice, module-aware but not multi-agent. Consumers don't need 8 specialists — they need one Ellie who understands what context they're in and responds appropriately.

The single Ellie is module-aware through the thread router and plugin context system. When a conversation enters a Life thread, Ellie loads Life context. When it enters a Learn thread, Ellie loads Learn context. This is context switching within one AI personality, not agent routing between multiple personalities.

**These two worlds coexist.** The agents build the product. The product serves consumers with a single Ellie. They are not in conflict — they serve different purposes at different layers.

| | Dave's Workshop | LEOS Consumer Platform |
|---|---|---|
| **AI model** | Multi-agent (8 specialists) | Single Ellie (module-aware) |
| **Memory** | 5-layer deep, heavily engineered | Slim layer, grows toward middle as modules demand |
| **Chat** | Channels + threads, full orchestration | Channels + threads, simplified |
| **Data** | Forest + Supabase + Elasticsearch | Single Postgres + pgvector |
| **Stack** | Vue/Nuxt (stays as-is) | React/Next.js + React Native (new, purpose-built) |
| **Purpose** | Build and refine the consumer product | Serve end users |

---

## 3. Architecture: Chat-Shell + Module Plugins

### The Shell

The shell (`ellie-app`) is the foundation that exists before any module is activated. It owns:

| Concern | Description |
|---------|-------------|
| **Identity** | One account, one login, user profile and preferences |
| **Chat** | Conversation engine with channels and threads |
| **Memory** | Slim memory layer (see Section 5 for honest scoping) |
| **AI Client** | Claude integration, prompt building, streaming responses |
| **Thread Router** | Context detection — recognizes what module a conversation belongs to (see Section 7) |
| **Module Registry** | Plugin discovery, activation, lifecycle management |
| **Notifications/Inbox** | Unified across all modules |
| **Settings** | User preferences, module activation, theme, accessibility |
| **Voice/TTS** | Audio-first is a platform concern — Groq Whisper + ElevenLabs |
| **Real-Time Transport** | WebSocket layer for chat streaming, presence, notifications (see Section 8) |
| **Proactive Ellie** | Ellie initiates — morning briefings, gentle nudges, pattern-based check-ins (see below) |

### Proactive Ellie — Companion, Not Just Tool

A companion doesn't wait to be spoken to. Proactive Ellie is a shell-level capability where Ellie initiates contact based on context:

- **Morning briefing:** "Good morning — you have 3 tasks today, Jamie's math test is Thursday, and your electric bill is due."
- **Gentle nudges:** "You mentioned wanting to walk more this week — want to plan a route?"
- **Pattern-based check-ins:** "You've been quiet today. Everything okay?"
- **Cross-module connections:** "Jamie's school sent a reminder about the science fair. Want me to block time for supplies shopping?"

Proactive messages are delivered through the existing chat — they appear as Ellie-initiated messages in the appropriate channel or thread. Plugins register proactive triggers (e.g., Life registers "upcoming bill" and "missed habit"), and the shell schedules and delivers them. The user controls frequency and opt-out in settings.

The detailed UX design for proactive interactions (timing, tone, frequency, notification behavior) is a separate product design document. This section establishes that proactive Ellie is a **shell capability**, not a plugin afterthought.

The shell does NOT own domain-specific data: no wellness metrics, no gradebooks, no project boards. If it's about talking to Ellie, remembering things, or knowing who you are — it's shell. If it's about a specific domain of your life — it's a plugin.

---

## 4. Plugin Contract

Each module (Life, Learn, Work) is a plugin that registers capabilities with the shell.

### Plugin Manifest

```typescript
// plugins/life/manifest.ts
import type { PluginManifest } from '@ellie-app/shared'

export default {
  id: 'life',
  name: 'Ellie Life',
  version: '0.1.0',
  description: 'Personal wellness, family, and finances',
  icon: '🌱',

  threadTypes: [
    {
      id: 'wellness',
      label: 'Health & Wellness',
      icon: '💚',
      triggers: ['health', 'exercise', 'sleep', 'mood', 'habit', 'workout'],
    },
    {
      id: 'family',
      label: 'Family & Home',
      icon: '👨‍👩‍👧‍👦',
      triggers: ['family', 'kids', 'dinner', 'grocery', 'chores', 'meal'],
    },
    {
      id: 'money',
      label: 'Money & Budget',
      icon: '💰',
      triggers: ['budget', 'spending', 'bills', 'savings', 'money', 'payment'],
    },
    {
      id: 'daily-tasks',
      label: 'Tasks & Lists',
      icon: '📋',
      triggers: ['todo', 'task', 'reminder', 'list', 'errand'],
    },
  ],

  views: [
    { id: 'wellness-dashboard', page: 'wellness' },
    { id: 'budget-overview', page: 'money' },
    { id: 'family-calendar', page: 'family' },
    { id: 'task-list', page: 'tasks' },
  ],

  apiPrefix: '/api/life',
  contextProvider: './context.ts',
} satisfies PluginManifest
```

### What a Plugin Provides

| Capability | Description |
|-----------|-------------|
| **Thread Types** | Conversation categories with trigger keywords for context detection |
| **Structured Views** | Visual components (dashboards, lists, cards) surfaced within or alongside chat |
| **API Routes** | Server endpoints under a namespaced prefix (`/api/life/*`, `/api/learn/*`, etc.) |
| **Database Tables** | Plugin-owned tables with prefix (`life_*`, `learn_*`, `work_*`) |
| **AI Context** | Context builder that tells the AI what it needs to know in this module's threads |
| **Migrations** | Schema migrations owned by the plugin |
| **Context Queries** | Registered queries the shell can invoke for cross-module awareness |

### Plugin Lifecycle

| Event | Description |
|-------|-------------|
| **Discovery** | Shell scans `plugins/*/manifest.ts` at startup |
| **Registration** | Plugin's thread types, views, routes, and context queries are registered with the shell |
| **Activation** | User enables the module — plugin's thread types become available, migrations run if needed |
| **Deactivation** | User disables — plugin's thread types stop matching, data stays in DB but is dormant |
| **Error Isolation** | A plugin failure (API error, context builder crash) does not take down the shell or other plugins |

### Plugin Boundaries

- Module tables reference shell tables only through `user_id` and `thread_id`
- Modules never read another module's tables directly
- Cross-module awareness flows through registered context queries and the AI, not database joins
- Each plugin declares a version — the shell validates compatibility at registration
- The shell runs all migrations at startup, discovering plugin migrations from the registry

### UI Layout Ownership

The shell owns the overall layout: navigation, chat panel, notification area. Plugins render their structured views within designated content areas provided by the shell. A plugin cannot modify the shell's chrome — it can only populate its assigned content slots.

---

## 5. Memory Architecture — Honest Scoping

The team correctly flagged that "slim layer" is a trap if it means "simple." The current memory system in ellie-dev is ~900 lines with dedup, conflict resolution, and circuit breakers. "Slim" doesn't mean we skip hard problems — it means we scope what's needed for the consumer platform specifically. To be clear: "slim" refers to the **depth of the memory model** (fewer layers of abstraction than ellie-dev's 5-layer system), not to the number of shell responsibilities or the rigor of implementation. The shell has 10+ concerns because it's a platform foundation. Memory being slim is about one of those concerns starting simple and growing.

### What the consumer memory layer needs from day one:

| Capability | Description |
|-----------|-------------|
| **Store** | Save memories with category, embedding, and user association |
| **Search** | Semantic search via pgvector + keyword fallback via tsvector |
| **Dedup** | Prevent storing the same fact twice — embedding similarity check before insert |
| **Per-user isolation** | Memories are always scoped to a user — RLS enforced |
| **Module tagging** | Memories carry a module source (life, learn, work, or shell) |
| **Context injection** | Retrieve relevant memories for AI prompt building per thread type |

### What can wait (grows toward the middle):

| Capability | When |
|-----------|------|
| **Conflict resolution** | When multi-device or shared channels create write conflicts |
| **Circuit breakers** | When memory volume creates performance concerns at scale |
| **5-layer hierarchy** | When the flat model proves insufficient for complex cross-module recall |
| **Memory consolidation** | When long-term users accumulate enough memories to need pruning/merging |

### Starting point:

The memory implementation in **ellie-life** is the starting point — not ellie-dev. ellie-life already has a working slim memory layer with pgvector embeddings and per-user scoping. This gets extracted into the shell and enhanced with dedup and module tagging.

---

## 6. Chat-Thread Model

### Starting Point

The chat implementation in **ellie-life** is the starting point for the consumer platform's chat — not ellie-dev. ellie-life has a working conversational interface with streaming responses, message persistence, and basic conversation management. This gets extracted into the shell and enhanced with the channel/thread model.

The ellie-home channel/thread system (added 2026-04-03) is the **design inspiration** — it proves out the interaction pattern. But the consumer implementation is built from ellie-life's simpler codebase, not ported from ellie-home's full orchestration layer.

### One Conversation, Organized Through Threads

To be explicit: "one conversation with Ellie" and "organized channels and threads" are not competing models. The user has one Ellie — one relationship, one companion. Channels and threads are how that conversation stays organized, the same way you might talk to a friend about multiple topics without them becoming multiple friends. The user never leaves Ellie to enter a module. They're always with Ellie — threads are organizational, not navigational.

### Channels

Top-level groupings. A user might have:

- A **General** channel — everyday Ellie conversation, no specific module
- Module-scoped channels if the user wants dedicated spaces
- **Shared channels** (future) — family members, each with their own Ellie, participating together

### Threads

Where context lives. Every thread has:

- A **type** — registered by a plugin, or `general` from the shell
- A **module** association — which plugin owns this thread, or `null` for shell-level
- A **context snapshot** — what the AI needs to know when responding

### Context Switching

1. User chats in general. Says "I need to check how Jamie's doing in math"
2. Thread router recognizes Learn module's `student-work` thread type (see Section 7)
3. Ellie responds: "Want me to open a thread for Jamie's schoolwork?" (or auto-creates if confidence is high)
4. Thread opens with Learn context loaded — Jamie's grades, recent assignments, teacher notes
5. User finishes, returns to general. "What's for dinner?" triggers Life/family context

### Cross-Module Awareness

The shell sees all threads. Ellie can bridge modules: "By the way, Jamie has a science project due Thursday — you might want to plan a lighter evening." Modules are isolated in their data, but Ellie connects them through conversation using registered context queries.

### Manual Triggers

Users can always explicitly create a thread in any active module — via slash commands, quick-action buttons, or direct request.

### Thread Lifecycle

- Threads can be short-lived (a quick question) or persistent (ongoing budget tracking)
- Persistent threads accumulate context — Ellie remembers prior discussions
- Threads can be archived; memory remains in the system

### Designed for Multi-User

The channel/thread architecture is designed to support future Ellie-to-Ellie communication:

- Each user has their own Ellie — their own memory, their own context, fully private
- Shared channels allow multiple users' Ellies to participate together
- Privacy boundary: each Ellie only shares what its user has authorized
- Per-user data isolation via `user_id` on every row + row-level security at the database level

**Design for multi-user now, build single-user first.** The schema and RLS policies exist from day one. Channel sharing and member tables exist but the UI starts private-only.

---

## 7. Thread Router — Confidence Model

The thread router is the highest-risk UX decision in the platform. If it works, Ellie feels magical. If it doesn't, users lose trust in the entire "single Ellie" experience.

### How It Works

The thread router is a **standalone testable component** that evaluates each user message against registered thread types from active plugins.

```
User message → Thread Router → { module, threadType, confidence, suggestion }
```

### Confidence Levels

| Level | Score | Behavior |
|-------|-------|----------|
| **High** | > 0.85 | Auto-create thread within an already-activated module (with brief notification: "Opened a wellness thread for this") |
| **Medium** | 0.5 - 0.85 | Suggest: "This sounds like it's about your budget — want me to open a Money thread?" |
| **Low** | < 0.5 | Stay in current thread, no suggestion |

### Detection Strategy

1. **Keyword matching** against plugin trigger lists (fast, low confidence)
2. **Semantic similarity** against thread type descriptions using embeddings (slower, higher confidence)
3. **Conversation context** — recent messages weighted more heavily; "I was just talking about Jamie's grades" boosts Learn confidence even without trigger keywords
4. **User history** — if the user frequently creates wellness threads in the morning, time-of-day context boosts wellness confidence

### Fallback and Correction

- If the router gets it wrong, the user can always say "That's not what I meant" or close the suggested thread
- **Correction feedback loop**: wrong suggestions are logged and used to tune confidence thresholds over time
- **Disambiguation UX**: when two modules score similarly (e.g., "I need to plan for next week" could be Life or Work), Ellie asks: "Is this for your personal schedule or work?"
- **Default to general**: when in doubt, stay in the current thread. False negatives (missing a context switch) are less damaging than false positives (wrong context switches)

### Modules Are Opt-In — Routing Is Within Opted-In Modules

To clarify: "modules are opt-in" and "auto-creating threads" are not in conflict. The thread router only matches against thread types from modules the user has **already activated**. If a user hasn't activated Learn, no amount of talking about school will trigger a Learn thread. Activation is the user's explicit choice. Routing within activated modules is Ellie being helpful.

### Testability

The thread router is extracted as a pure function with no side effects. It takes a message, active plugins, conversation history, and user profile — and returns a routing decision. This allows:

- Unit testing with synthetic messages
- Evaluation against labeled datasets
- A/B testing of routing strategies
- Independent iteration without touching the shell or plugins

---

## 8. Real-Time Transport

A chat-first application requires real-time communication. This is not optional.

### WebSocket Architecture

| Concern | Design |
|---------|--------|
| **Protocol** | WebSocket via the shared Bun server |
| **Authentication** | JWT token passed on connection handshake |
| **Reconnection** | Automatic reconnect with exponential backoff; messages queued client-side during disconnect |
| **Events** | `message:new`, `message:update`, `thread:created`, `thread:context-switch`, `typing`, `presence`, `notification` |
| **State sync** | On reconnect, client requests missed events since last received timestamp |

### What Goes Over WebSocket vs REST

| WebSocket (real-time) | REST (on-demand) |
|----------------------|------------------|
| New messages (streaming) | Message history (paginated) |
| Typing indicators | Channel/thread CRUD |
| Thread creation notifications | Module activation/settings |
| Presence (online/offline) | Memory search |
| AI response streaming | File uploads |
| Notifications | Auth |

### Mobile Considerations

- Push notifications via Expo's notification service when the app is backgrounded
- WebSocket maintained while app is foregrounded
- Offline queue: messages composed offline are queued and sent on reconnect
- Background sync: periodic sync of new messages when app returns to foreground

---

## 9. Data Architecture

### Single Postgres Instance

**Shell tables** (shared foundation):

| Table | Purpose |
|-------|---------|
| `users` | Identity, auth, preferences, active modules |
| `channels` | Owned by user, supports future sharing |
| `channel_members` | Future: shared channel membership |
| `threads` | Belongs to channel, carries module type and context |
| `messages` | Belongs to thread, always tied to user |
| `memories` | Per-user semantic memory with embeddings (pgvector) |
| `module_registry` | Which modules a user has activated |
| `notifications` | Unified inbox across modules |
| `sessions` | Auth sessions |

**Module tables** (plugin-owned, prefixed):

- `life_*` — wellness_logs, transactions, family_members, habits, meals, etc.
- `learn_*` — enrollments, assignments, grades, school_profiles, etc.
- `work_*` — projects, time_entries, work_contexts, etc.

### Privacy Model

Privacy is enforced at multiple layers — not just policy, but structural decisions that make data leakage difficult by default:

- Every row with user data has a `user_id` column — no exceptions
- Row-level security at the database level as the enforcement mechanism
- Modules are structurally isolated — no cross-module table access, cross-module awareness flows only through Ellie's AI context
- Shared channels (future) use a `channel_members` table — Ellie only queries data the user has access to
- Module data is always private to the user
- No shortcuts that assume single-user — multi-user schema from day one

### Migration Ownership

- Shell migrations: `migrations/`
- Plugin migrations: `plugins/{module}/migrations/`
- Shell discovers and runs all migrations at startup

---

## 10. Tech Stack

### The React Decision — Honest Framing

Moving from Vue/Nuxt to React/Next.js for the consumer platform is a **ground-up rewrite**. No Vue code transfers. The Capacitor mobile app is also replaced entirely by React Native. This is not a migration — it is building a new platform from scratch, informed by everything learned from ellie-life.

**Why this is the right call:**

Dave is building LEOS as a master craftsman who leverages AI as his primary development tool. The stack decision is not about developer comfort — it's about what produces the best product:

- **AI tooling is deepest for React** — Claude and all coding AIs have the most training data on React by a significant margin. When AI writes the code, the framework it writes best in matters enormously.
- **React everywhere** — same mental model, hooks, components, and state patterns transfer between desktop (Next.js) and mobile (React Native). Shared TypeScript types, API clients, and business logic.
- **Largest ecosystems** — shadcn/ui, Radix for web; React Native Paper, RN Elements for mobile. Every UI pattern needed already exists.
- **NativeWind** — Tailwind syntax in React Native means styling knowledge transfers across platforms.
- **Native mobile experience** — React Native + Expo produces genuinely native apps. A Capacitor web wrapper cannot deliver the "class A" mobile experience LEOS requires.
- **Future hiring pool** — if LEOS grows, React developers are 5x more available than Vue developers.

**What stays Vue/Nuxt:** Dave's Workshop (ellie-home, ellie-dev). These are personal tools in production. No reason to rewrite them. The workshop and the consumer platform are cleanly separated by purpose.

### Two Purpose-Built Frontends, One Shared Backend

#### Desktop — Next.js + React + Tailwind

| Layer | Technology |
|-------|-----------|
| **Framework** | Next.js (App Router) |
| **UI** | React + Tailwind CSS |
| **Components** | shadcn/ui, Radix primitives |
| **Strengths** | Multi-panel layouts, side-by-side views, keyboard workflows, rich structured views |

#### Mobile — React Native + Expo + NativeWind

| Layer | Technology |
|-------|-----------|
| **Framework** | React Native + Expo SDK |
| **Styling** | NativeWind (Tailwind for RN) |
| **Navigation** | React Navigation (stack + tab + bottom sheet) |
| **Strengths** | Native feel, voice-first, push notifications, haptics, offline capable |

#### Shared Backend

| Layer | Technology |
|-------|-----------|
| **API** | Standalone Bun server (shared by both apps, independent of Next.js) |
| **Real-time** | WebSocket via Bun server |
| **Database** | Postgres + pgvector |
| **AI** | Claude API (@anthropic-ai/sdk) |
| **Embeddings** | OpenAI |
| **Voice** | Groq Whisper (STT) + ElevenLabs (TTS) |
| **Search** | Postgres full-text via tsvector |
| **Auth** | bcryptjs + JWT sessions |

#### Server Architecture — One Server Story

The Bun server is the single backend. It handles REST API routes, WebSocket connections, plugin route mounting, and AI streaming. Next.js handles only the desktop frontend rendering — it does not serve API routes. Both the desktop and mobile apps are API clients to the Bun server.

```
Desktop (Next.js) ──→ Bun Server ←── Mobile (Expo)
                         │
                    Postgres + pgvector
                         │
                    Claude / OpenAI / Voice APIs
```

---

## 11. Repository Structure

```
ellie-app/
├── packages/
│   └── shared/              ← TypeScript types, API client, chat protocol, plugin types
│
├── apps/
│   ├── desktop/             ← Next.js app
│   │   ├── app/             ← App Router pages + layouts
│   │   ├── components/      ← React web components
│   │   │   ├── chat/        ← channel list, thread view, message bubbles
│   │   │   └── shell/       ← nav, module switcher, notifications
│   │   └── lib/             ← hooks, utilities
│   │
│   └── mobile/              ← Expo app
│       ├── app/             ← Expo Router screens
│       ├── components/      ← React Native components
│       │   ├── chat/        ← native message list, input, thread nav
│       │   └── shell/       ← bottom nav, module switcher
│       └── lib/             ← hooks, utilities
│
├── server/                  ← Shared Bun API server
│   ├── api/
│   │   ├── auth/            ← login, register, session
│   │   ├── chat/            ← messages, channels, threads
│   │   ├── memory/          ← store, search, recall
│   │   ├── modules/         ← activate, deactivate, list
│   │   └── tts/             ← voice synthesis
│   ├── ws/                  ← WebSocket handlers
│   └── utils/
│       ├── ai.ts            ← Claude client, prompt builder
│       ├── auth.ts
│       ├── db.ts
│       ├── plugin-loader.ts ← discovers & registers plugins
│       └── thread-router.ts ← context detection & thread creation
│
├── plugins/
│   ├── life/
│   │   ├── manifest.ts      ← thread types, triggers, views
│   │   ├── context.ts       ← AI context builder
│   │   ├── server/          ← API routes (shared by both apps)
│   │   ├── desktop/         ← React web components (wellness.tsx, money.tsx, etc.)
│   │   ├── mobile/          ← React Native screens
│   │   └── migrations/      ← life_* tables
│   │
│   ├── learn/
│   │   ├── manifest.ts
│   │   ├── context.ts
│   │   ├── server/
│   │   ├── desktop/
│   │   ├── mobile/
│   │   └── migrations/
│   │
│   └── work/                ← future
│       └── ...
│
├── migrations/              ← shell schema
│   ├── 001_users.sql
│   ├── 002_channels_threads.sql
│   ├── 003_messages_memory.sql
│   ├── 004_module_registry.sql
│   └── 005_rls_policies.sql
│
├── package.json             ← monorepo root (workspace config)
└── turbo.json               ← monorepo task runner
```

---

## 12. Sequencing — v0.1 Scope (Desktop-First)

The team unanimously recommended: **validate the plugin model on desktop before splitting focus to mobile.** This is correct.

### v0.1: Desktop Shell + Chat + Life Plugin

| Component | Scope |
|-----------|-------|
| **Bun server** | Auth, chat API (channels + threads + messages), memory API, plugin loader, WebSocket |
| **Desktop app** | Next.js with chat UI, channel/thread navigation, module switcher |
| **Life plugin** | Manifest, context builder, API routes for tasks and basic wellness, desktop views |
| **Thread router** | Basic keyword matching + confidence scoring, suggestion UX |
| **Database** | Shell schema + Life plugin tables, RLS policies |

### What v0.1 does NOT include:

- Mobile app (comes after plugin model is validated on desktop)
- Learn or Work plugins (Life proves the plugin contract first)
- Offline/sync (desktop doesn't need it urgently)
- Ellie-to-Ellie communication (designed for, not built)
- Billing/subscriptions

### v0.1 success criteria:

- A user can log in, chat with Ellie, and have Ellie recognize Life-context conversations
- Threads are created and carry module context
- Life structured views (task list, basic wellness) render alongside chat
- Plugin loader successfully discovers, registers, and mounts the Life plugin
- Memory stores and retrieves per-user, module-tagged memories

---

## 13. Migration Path — Honest Rewrite

### What This Really Is

This is a new platform built from scratch in React/Next.js, informed by everything learned from building ellie-life in Vue/Nuxt. The code from ellie-life does not port — the **knowledge** ports. Database schemas, API designs, UX patterns, and hard-won lessons about what works all carry forward. The code is rewritten.

### Starting Points

| Concern | Starting from | Not from |
|---------|--------------|----------|
| **Chat** | ellie-life's conversational interface | ellie-dev's multi-agent orchestration |
| **Memory** | ellie-life's slim pgvector layer | ellie-dev's 5-layer memory system |
| **Auth** | ellie-life's bcryptjs + JWT | ellie-dev's Supabase auth |
| **Database** | ellie-life's local Postgres pattern | ellie-dev's Forest + Supabase split |
| **Channel/thread model** | Inspired by ellie-home (design) | Built fresh (implementation) |
| **Thread router** | New (no equivalent exists) | — |

### Sequence

| Step | Action |
|------|--------|
| **1** | Create `ellie-app` monorepo, set up Turborepo, scaffold packages/shared |
| **2** | Build Bun server: auth, chat API (channels + threads), memory, plugin loader, WebSocket |
| **3** | Build desktop shell in Next.js: chat UI, channel/thread nav, module switcher |
| **4** | Build Life plugin: manifest, server routes, desktop views, migrations |
| **5** | Validate: does the plugin contract work? Does the thread router work? Does the UX feel right? |
| **6** | Build mobile shell in Expo: native chat, bottom nav, voice input |
| **7** | Port Life plugin's mobile screens |
| **8** | Build Learn plugin (directly as plugin, using existing design work) |
| **9** | Design and build Work plugin |

### What Happens to Existing Repos

| Repo | Fate |
|------|------|
| `ellie-life` | Knowledge and patterns inform the new platform. Repo archived after v0.1 proves out. |
| `ellie-learn` | Built directly as `plugins/learn/`. Existing design work (4 persona journeys, data architecture) carries forward. Current repo superseded. |
| `ellie-os-app` | Superseded by the Expo mobile app. Capacitor approach replaced by React Native. |
| `ellie-home` | Untouched — Dave's Workshop |
| `ellie-dev` | Untouched — multi-agent relay/brain |
| `ellie-forest` | Untouched — personal knowledge layer |
| `ellie-gateway` | Untouched — webhook ingestion |
| `ellie-mb` | Stays independent — could become a plugin later if relevant |

---

## 14. Modules Overview

### Ellie Life (Personal)

**Concern areas:** Wellness, family, money, daily tasks
**Status:** Knowledge and patterns from ellie-life (~60% built) inform the plugin. Rewritten in React.
**Thread types:** wellness, family, money, daily-tasks
**Structured views:** wellness dashboard, budget breakdown, family calendar, task list

### Ellie Learn (Education)

**Concern areas:** Student work, teacher tools, parent visibility, school admin
**Status:** Design complete (4 persona journeys, data architecture). Built as plugin from day one.
**Thread types:** student-work, parent-update, lesson-plan, class-discussion
**Structured views:** gradebook, progress tracker, assignment view, school calendar
**Note:** Per-school data isolation from the existing Learn design carries forward within the plugin.
**Multi-user dependency:** Learn is the first module that will likely require multi-user capabilities. Parents need access to student data, teachers need class-wide views. The shared channel and `channel_members` schema exists from day one to support this, but the multi-user UX and authorization model should be designed alongside Learn — not deferred until after. This is a sequencing dependency: when Learn enters active development, multi-user moves from "designed for" to "built."

### Ellie Work (Professional)

**Concern areas:** Projects, time tracking, meetings, work communication
**Status:** Not yet designed. Built as plugin when ready.
**Thread types:** TBD during Work design phase
**Structured views:** TBD during Work design phase

---

## 15. Design Principles

1. **Chat is the center** — every feature is accessible through conversation. Structured views support the chat, not the other way around.
2. **Audio-first** — no piece of knowledge should require reading to access. Voice input, TTS output, audio cues are platform-level concerns.
3. **Privacy by design** — per-user data isolation from day one. RLS at the database level. Designed for multi-user, built single-user first.
4. **Modules are opt-in** — activate what's relevant to your life. Inactive modules are dormant, not absent.
5. **Ellie bridges contexts** — modules isolate concerns, but Ellie connects them when it helps the user.
6. **The slim layer grows** — start from ellie-life's proven simple approach. Enhance as real usage demands it. Don't over-engineer day one.
7. **Two apps, one Ellie** — desktop and mobile are purpose-built for their platforms but share identity, memory, chat, and the plugin system.
8. **Craftsman's standard** — every choice serves the product, not the developer's comfort. The best tool for the job, not the most familiar one.
9. **Workshop and product are separate** — Dave's multi-agent infrastructure builds LEOS. LEOS serves consumers with a single Ellie. These are different layers that coexist, not compete.

---

## 16. Failure and Degradation

What happens when things go wrong matters as much as when they go right — especially for a companion the user is learning to trust.

| Failure | User Experience |
|---------|----------------|
| **AI slow or unavailable** | Ellie shows a typing indicator with "Thinking..." for up to 10s. After timeout: "I'm having trouble connecting right now. I'll keep trying — your message is saved." All messages are persisted locally regardless of AI availability. |
| **Plugin crash** | The plugin's structured views show an error state. Chat continues — Ellie acknowledges: "I'm having trouble loading your wellness data, but we can keep talking." Other plugins are unaffected. |
| **WebSocket disconnect** | Messages composed during disconnect are queued client-side. On reconnect, missed messages sync automatically. User sees a subtle "reconnecting..." indicator, not a full error screen. |
| **Thread router wrong** | User says "that's not what I meant" or closes the thread. Ellie apologizes briefly and stays in the previous context. Correction is logged to improve future routing. |
| **Database unavailable** | Ellie remains conversational using in-memory context. Persistence resumes when the database recovers. The user never sees a database error. |

The principle: **Ellie never fully breaks.** She may be limited, she may acknowledge something isn't working, but the conversation always continues. A companion who crashes is worse than one who says "I can't do that right now."

---

## 17. Future Work (Identified, Not In Scope)

The following are important design concerns surfaced during review. They are documented here as future work, not as gaps in this spec. Each warrants its own design document:

- **First five minutes** — new user onboarding experience design
- **Audio-first UX design** — morning briefings, hands-free mode, car mode, kitchen mode
- **Ellie personality guide** — how tone adapts across modules while staying one person
- **Multi-user authorization model** — designed alongside Learn plugin
- **Shared channel UX** — family/group interaction patterns
- **Cross-module awareness controls** — user-facing consent and visibility settings
- **Billing and subscription model** — module-level pricing, free tier scope
