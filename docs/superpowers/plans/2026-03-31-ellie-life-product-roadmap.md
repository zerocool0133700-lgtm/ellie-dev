# Ellie Life — Product Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Ellie Life — a consumer-facing personal AI companion app (mobile + desktop web) with a base tier and 3 add-on modules (Health, Family, Money).

**Architecture:** Responsive web app (PWA) with mobile-first design, served from `app.ellielife.com`. Chat-centric AI core backed by conversation memory and pattern recognition, with modular add-on system. Backend runs on a single local Postgres database with pgvector, Claude API for AI, and inline embedding generation — no cloud database dependency.

**Tech Stack:** Nuxt 3 + Quasar UI (frontend — see ADR-001), Local Postgres + pgvector (database + vector search), Supabase Auth library (auth only — no cloud hosting), Claude API (AI backbone), OpenAI API (embeddings), Bun (runtime), CSS custom properties for theming (light/dark/dyslexia modes).

**Source Materials:**
- `docs/ellie-life-mockups.html` — Mobile mockups (11 sections: onboarding, home, chat, organize, comms, memory, health, family, money, architecture, pricing)
- `docs/ellie-life-desktop-mockups.html` — Desktop mockups (same sections, adapted for widescreen with sidebar nav + multi-column layouts)

---

## 1. Product Vision & Scope Summary

### What Ellie Life Is
A consumer personal AI companion — "a thoughtful friend who remembers everything and helps you stay organized. No tech skills needed." It is a distinct product from Ellie Home (the admin/dashboard) and Ellie OS (the internal platform).

### Target User
Non-technical consumers managing busy lives. The mockup persona is "Sarah" — works from home, has kids, manages family schedules, shopping, health habits, and finances. The UX is deliberately warm, conversational, and non-intimidating.

### Product Structure

**Base Tier (Free / $4.99/mo):**
- Natural conversational chat with persistent memory
- Task capture from conversations (auto-organized into lists)
- Life organization (weekly tasks, shopping lists, someday list)
- Communication filter (AI-triaged inbox: needs-you vs auto-handled)
- Voice note transcription + action extraction
- Memory browser with full transparency/control
- Daily mood check-ins and proactive nudges
- Onboarding via conversational flow (not forms)

**Add-on: Health & Wellness ($2.99/mo):**
- Conversation-based habit tracking (walks, water, sleep, stretching)
- Weekly goal ring visualization
- Sleep/mood pattern correlation engine
- Streak tracking and gentle nudges
- Weekly wellness insight summaries

**Add-on: Family & Home ($2.99/mo):**
- Family member profiles with schedules/preferences
- Schedule conflict detection
- Smart meal planning (dietary needs, preferences)
- Shared shopping lists
- Cross-family coordination

**Add-on: Money & Budget ($2.99/mo):**
- Conversational budgeting (no spreadsheets)
- Spending category breakdown with visual bars
- Bill reminders and tracking
- Saving goal progress
- Monthly spending check-ins and cross-module savings insights

**Everything Bundle: $9.99/mo** (saves $3 vs a la carte)

### Key Differentiators (from mockup design notes)
1. **Proactive nudges** — Ellie notices patterns ("you mentioned the dentist 3 times this week") rather than just listing tasks
2. **Emotional intelligence** — mood tracking, empathetic responses, gentle accountability
3. **Conversational-first** — tasks, lists, habits all captured from natural chat, not forms
4. **Total memory transparency** — users see, edit, delete everything Ellie remembers
5. **Cross-module intelligence** — modules share context (mood affects health expectations, family tasks feed budgets, etc.)

---

## 2. Technical Architecture Requirements

### 2.1 Frontend

| Requirement | Detail |
|-------------|--------|
| Framework | Nuxt 3 (SSR/SSG) — consistent with ellie-home |
| Styling | TailwindCSS with custom design tokens extracted from mockup CSS variables |
| Design system | Warm palette (`--primary: #E8735A`, `--warm-bg: #FFF8F0`, etc.), 16px radius cards, SF Pro / system font stack |
| Responsive | Mobile-first (320px phone frame) with desktop adaptation (sidebar nav, multi-column grids) |
| PWA | Installable on mobile home screens, offline-capable for cached content |
| Routing | `/` (home), `/chat`, `/tasks`, `/inbox`, `/memory`, `/wellness`, `/family`, `/money`, `/settings` |
| Mobile nav | Bottom tab bar: Home, Chat, Tasks, Inbox, You |
| Desktop nav | Left sidebar (240px): brand, main nav, add-ons section, user footer |
| Chat UI | Real-time message streaming, typing indicators, voice note recording/playback |
| Desktop chat extras | Collapsible context panel (260px right panel showing related memories, tasks created, quick actions) |
| Onboarding | 4-step conversational flow (Welcome > Getting to Know You > Permissions > Ready) |

### 2.2 Backend / API

| Requirement | Detail |
|-------------|--------|
| Runtime | Bun |
| API | REST endpoints at new consumer API (separate from relay's internal API) |
| Auth | Supabase Auth library (email/password, social login) — used as a local library, not Supabase cloud |
| Database | Single local Postgres with pgvector extension — all tables in one database, no cloud dependency |
| AI | Claude API for chat responses, personality, nudge generation |
| Embeddings | OpenAI API called inline at insert time (no edge functions or external embedding service) |
| Search | Postgres full-text search + pgvector cosine similarity — no Elasticsearch or external search service |
| Memory | Semantic search over conversation history + extracted facts/preferences/people |
| Real-time | Server-Sent Events (SSE) for chat message streaming |
| Voice | Groq Whisper API for voice note transcription (proven in relay) |
| Notifications | Push notifications (web push API) for nudges/reminders |
| River docs | Loaded from disk at startup (no QMD CLI dependency) |

### 2.3 Architecture Simplification

James's consolidation proposal reduces Ellie Life's infrastructure from the Ellie OS pattern (5 tiers, multiple databases and cloud services) down to a clean 3-tier stack with a single database.

**Before (Ellie OS pattern):**
- Supabase cloud Postgres (messages, memory, agents)
- Local Forest Postgres (knowledge trees, scopes)
- Supabase Edge Functions (embedding generation, semantic search)
- QMD CLI for River doc fetching
- Elasticsearch for full-text search

**After (Ellie Life):**
- **Tier 1: Nuxt 3 frontend** — PWA served from `app.ellielife.com`
- **Tier 2: Bun API server** — REST endpoints, inline embedding generation, River docs loaded from disk
- **Tier 3: Single local Postgres** — pgvector for embeddings, full-text search via `tsvector`, all tables in one schema

**Benefits:**
- **Reduced cost** — no Supabase cloud subscription; local Postgres is free
- **Lower complexity** — one database to manage, no edge function deployment, no QMD dependency
- **Smaller footprint** — fewer moving parts means fewer failure modes and easier debugging
- **Faster development** — inline embedding calls are simpler to reason about than async webhook pipelines
- **Single embedding pipeline** — OpenAI API called directly from the API server at insert time, embeddings stored in pgvector columns

**External dependencies reduced to:**
- OpenAI API (embedding generation)
- Telegram API (messaging channel)
- Optional: Google Chat API, Groq Whisper API (voice), Stripe (billing)

### 2.4 Database Schema (New Tables)

```
-- Consumer auth & profiles
life_users (id, email, name, timezone, created_at, subscription_tier, preferences)
life_onboarding (user_id, step, completed_at, responses)

-- Conversations & Memory
life_conversations (id, user_id, started_at, topic_hint)
life_messages (id, conversation_id, role, content, embedding, created_at, metadata)
life_memories (id, user_id, category, content, embedding, source_message_id, created_at, updated_at)
  -- categories: about_you, people, preferences, emotional, schedule, health, financial

-- Tasks & Organization
life_tasks (id, user_id, title, due_date, category, status, source_message_id, list_id)
life_lists (id, user_id, name, type, created_at)
  -- types: shopping, tasks, someday, gift_ideas

-- Communication Filter
life_inbox_items (id, user_id, source, sender, preview, ellie_summary, priority, status, created_at)
  -- status: needs_attention, handled, archived

-- Add-on: Health
life_habits (id, user_id, name, icon, target_frequency, created_at)
life_habit_logs (id, habit_id, date, completed, notes)
life_mood_logs (id, user_id, date, mood, context)
life_wellness_insights (id, user_id, week_start, content, data)

-- Add-on: Family
life_family_members (id, user_id, name, relationship, avatar_color, preferences, schedule_notes)
life_meals (id, user_id, date, meal_type, name, details, dietary_tags)

-- Add-on: Money
life_budget_categories (id, user_id, name, color, monthly_limit)
life_transactions (id, user_id, category_id, amount, description, date, source)
life_saving_goals (id, user_id, name, target_amount, current_amount, deadline)
life_bills (id, user_id, name, amount, due_day, autopay, last_paid)

-- Subscriptions
life_subscriptions (id, user_id, plan, addons[], started_at, stripe_subscription_id)
```

### 2.5 AI / Personality Engine

| Component | Detail |
|-----------|--------|
| System prompt | Warm, conversational personality — "like a thoughtful friend." References past conversations naturally. Never preachy. |
| Memory injection | Relevant memories from semantic search injected into chat context |
| Task extraction | Claude parses chat for actionable items, auto-creates tasks with categories and dates |
| Nudge generation | Scheduled job that reviews recent patterns, generates proactive suggestions |
| Mood-awareness | Morning check-in response feeds into daily behavior — affects nudge tone, task load suggestions |
| Cross-module reasoning | When multiple add-ons active, AI connects dots across domains (health + family + money) |
| Voice processing | Transcribe > parse > act (extract tasks, items, reminders from voice notes) |

### 2.6 Integration Points with Existing Ellie OS

| Reusable | Adaptation Needed |
|----------|-------------------|
| Voice transcription (Groq Whisper) | Direct reuse |
| Claude API integration patterns | New personality prompt, different context management |
| Memory semantic search patterns | New memory schema, consumer-focused categories |
| Embedding generation logic | Inline calls instead of edge functions, same OpenAI API |
| River doc content | Loaded from disk at startup instead of QMD fetch |

| New / Cannot Reuse | Reason |
|---------------------|--------|
| Auth system | Consumer auth (email/social), not relay's agent auth |
| Frontend | Entirely new app, different design system |
| Task/list management | Consumer-oriented, not GTD/Plane-based |
| Communication filter | New concept — notification triage |
| Subscription/billing | Stripe integration for consumer plans |

---

## 3. Implementation Phases & Milestones

### Phase 0: Foundation (2 weeks)
> Goal: Project scaffold, design system, auth, local Postgres database with pgvector

- [ ] **0.1** Initialize Nuxt 3 project (`ellie-life/`) with TypeScript, TailwindCSS
- [ ] **0.2** Extract design tokens from mockup CSS variables into Tailwind config (colors, radii, shadows, typography)
- [ ] **0.3** Build shared component library: Card, Button, Avatar, Badge, TabBar (mobile), Sidebar (desktop), StatusBar
- [ ] **0.4** Implement responsive layout shell: mobile bottom-tab + desktop sidebar navigation
- [ ] **0.5** Set up local Postgres with pgvector extension, configure Supabase Auth library (email + Google social login), RLS policies
- [ ] **0.6** Create database migration: all base-tier tables (users, conversations, messages, memories, tasks, lists, inbox) with `tsvector` columns for full-text search and `vector` columns for embeddings
- [ ] **0.7** Create database migration: add-on tables (habits, mood, family, meals, budget, transactions, goals, bills)
- [ ] **0.8** Build inline embedding pipeline: OpenAI API call at insert time, store vectors in pgvector columns
- [ ] **0.9** Stub API routes for all major endpoints, load River docs from disk

**Milestone: App shell loads, user can sign up/login, local Postgres seeded with schema, embedding pipeline verified, empty pages render with nav**

### Phase 1: Onboarding & Chat Core (3 weeks)
> Goal: Conversational onboarding flow + working chat with memory

- [ ] **1.1** Build 4-step onboarding UI (Welcome > Getting to Know You > Permissions > Ready)
- [ ] **1.2** Implement conversational onboarding — chat-style Q&A, not forms (per mockup design note)
- [ ] **1.3** Extract profile data from onboarding chat (name, routine, communication preferences) and save to `life_users`
- [ ] **1.4** Build chat UI: message list, input bar, send button, typing indicator, auto-scroll
- [ ] **1.5** Implement Claude API integration: system prompt with Ellie personality, message history context
- [ ] **1.6** Build memory extraction pipeline: after each conversation, Claude extracts facts/preferences/people into `life_memories`
- [ ] **1.7** Implement semantic memory injection: before each response, search relevant memories and inject into Claude context
- [ ] **1.8** Build memory browser UI (mobile + desktop): category filters, edit/delete controls
- [ ] **1.9** Voice note recording (Web Audio API) + Groq transcription + action parsing
- [ ] **1.10** Desktop chat context panel: related memories, tasks created, quick actions sidebar

**Milestone: User can onboard conversationally, chat with Ellie who remembers past conversations, browse/edit memories, send voice notes**

### Phase 2: Life Organization (2 weeks)
> Goal: Tasks, lists, and the "organize" view populated from conversations

- [ ] **2.1** Build task extraction from chat: Claude identifies actionable items, dates, categories
- [ ] **2.2** Tasks view UI: weekly grouped tasks, category filter pills, checkbox completion
- [ ] **2.3** Shopping list UI: store-grouped lists, auto-populated from chat mentions
- [ ] **2.4** Someday list: items Ellie holds for when user has time
- [ ] **2.5** Reminder system: scheduled notifications for tasks with due dates/times
- [ ] **2.6** Desktop organize view: split-panel (tasks left, lists right)

**Milestone: Saying "I need dog food" in chat creates a shopping list item; tasks auto-organize by day**

### Phase 3: Home Dashboard & Nudges (2 weeks)
> Goal: Home screen with contextual cards, mood check-in, proactive nudges

- [ ] **3.1** Home dashboard UI: greeting, mood prompt, Today's Focus card, Coming Up card, Quick Actions grid
- [ ] **3.2** Mood check-in: 4-option selector, save to `life_mood_logs`, feed into daily context
- [ ] **3.3** Nudge engine: scheduled job reviews recent patterns, generates proactive suggestions
- [ ] **3.4** Nudge UI: pattern-based cards ("you mentioned X 3 times"), schedule heads-ups, gentle reminders
- [ ] **3.5** Desktop home: 3-column grid (focus + schedule + nudges), calendar week strip, inbox preview row
- [ ] **3.6** Time-of-day awareness: morning view vs evening view, appropriate greetings

**Milestone: Home screen shows personalized daily view with AI-generated nudges based on conversation patterns**

### Phase 4: Communication Filter (2 weeks)
> Goal: AI-triaged inbox that separates signal from noise

- [ ] **4.1** Email integration: OAuth connection to Gmail/Outlook, read-only access
- [ ] **4.2** Notification integration: API connections to Slack, SMS (read-only)
- [ ] **4.3** AI triage engine: Claude classifies incoming messages (needs-attention / handled / archived)
- [ ] **4.4** Ellie summary generation: one-line contextual summary per message ("She needs a signature by Wednesday")
- [ ] **4.5** Filtered inbox UI: "Needs You" tab with summaries, "Handled" tab with auto-categorized items
- [ ] **4.6** Auto-task creation: when triage detects actionable items, create tasks automatically
- [ ] **4.7** Desktop inbox: side-by-side needs-attention + handled columns
- [ ] **4.8** "Ellie saved you ~X minutes" tracking metric

**Milestone: Emails/notifications flow into unified inbox, AI separates important from noise, auto-creates tasks**

### Phase 5: Health & Wellness Add-on (2 weeks)
> Goal: Habit tracking, wellness visualization, sleep/mood correlation

- [ ] **5.1** Add-on gating: subscription check, locked UI states, upgrade prompts
- [ ] **5.2** Wellness dashboard: goal ring (SVG), stat cards (walks, sleep, water), habit tracker with streaks
- [ ] **5.3** Conversation-based habit logging: "I walked this morning" updates habit tracker
- [ ] **5.4** Mood-sleep-habit correlation engine: analyze patterns, generate insights
- [ ] **5.5** Weekly insight summary: auto-generated Sunday evening wellness report
- [ ] **5.6** Health-aware chat: Ellie references streaks, adjusts expectations based on sleep, celebrates progress
- [ ] **5.7** Desktop wellness: 3-column layout (ring+stats, habits, insights)

**Milestone: User can track habits conversationally, see wellness patterns, get data-driven insights**

### Phase 6: Family & Home Add-on (2 weeks)
> Goal: Family profiles, schedule coordination, meal planning

- [ ] **6.1** Family member profiles: name, relationship, avatar, schedule notes, preferences
- [ ] **6.2** Schedule conflict detection: flag overlapping family events
- [ ] **6.3** Meal planning UI: weekly meal cards with dietary tags and details
- [ ] **6.4** Conversational meal planning: "What should we have for dinner?" considers preferences and dietary needs
- [ ] **6.5** Shared shopping list integration: family members' needs feed into lists
- [ ] **6.6** Desktop family: split view (family members + schedule left, meal plan right)

**Milestone: Family schedules coordinated, meal plans generated, shopping lists auto-populated**

### Phase 7: Money & Budget Add-on (2 weeks)
> Goal: Conversational budgeting, spending awareness, saving goals

- [ ] **7.1** Budget setup via conversation: "I spend about $X on groceries" creates categories
- [ ] **7.2** Spending dashboard: total display, category breakdown with color-coded bars
- [ ] **7.3** Bill tracking: due dates, amounts, autopay status, reminders
- [ ] **7.4** Saving goals: target amount, progress visualization, milestone nudges
- [ ] **7.5** Monthly check-in: auto-generated spending summary conversation
- [ ] **7.6** Cross-module insights: "Your meal planning saved $73 this month"
- [ ] **7.7** Desktop money: multi-card grid with detailed category breakdowns

**Milestone: User has spending awareness without spreadsheets, bill reminders, progress toward savings**

### Phase 8: Cross-Module Intelligence & Polish (2 weeks)
> Goal: The "magic" — modules inform each other, everything feels connected

- [ ] **8.1** Mood-aware system: morning check-in affects health expectations, nudge tone, task suggestions
- [ ] **8.2** Family + Money: child needs → budget entries → shopping trips
- [ ] **8.3** Health + Family: solo-parenting pattern detection → lighter schedule suggestions
- [ ] **8.4** Everything + Core: comprehensive daily briefing that weaves all modules together
- [ ] **8.5** Push notification system: timely nudges, reminders, check-ins
- [ ] **8.6** Performance optimization: message streaming, lazy loading, offline caching
- [ ] **8.7** Accessibility pass: screen reader support, keyboard navigation, color contrast
- [ ] **8.8** Mobile PWA: service worker, install prompt, offline fallback

**Milestone: All modules share context seamlessly; app feels like a unified companion, not separate tools**

### Phase 9: Billing & Launch Prep (2 weeks)
> Goal: Stripe integration, free tier limits, launch-ready polish

- [ ] **9.1** Stripe integration: subscription management, plan selection, upgrade/downgrade flows
- [ ] **9.2** Free tier limits: 30-day memory, 3 tasks/day, basic comm filter
- [ ] **9.3** Upgrade prompts: contextual "unlock with Health add-on" when user hits limits
- [ ] **9.4** Bundle pricing: $9.99 everything vs a la carte
- [ ] **9.5** Landing page / marketing site
- [ ] **9.6** Privacy policy, terms of service (critical given memory/email access)
- [ ] **9.7** Production deployment: domain setup, CDN, monitoring, error tracking
- [ ] **9.8** Beta testing program setup

**Milestone: App is billable, legally compliant, deployed to production, ready for beta users**

---

## 4. Critical Path Items

These are the sequential dependencies that determine timeline:

```
Foundation (Phase 0)
  └─> Chat Core (Phase 1) ← LONGEST POLE — AI personality + memory pipeline
       ├─> Life Organization (Phase 2)
       │    └─> Home Dashboard (Phase 3)
       ├─> Communication Filter (Phase 4) ← HIGHEST RISK — email/notification integrations
       └─> Add-on modules (Phases 5-7, can run in parallel)
            └─> Cross-Module Intelligence (Phase 8)
                 └─> Billing & Launch (Phase 9)
```

**Critical path:** 0 → 1 → 2 → 3 → 8 → 9 = ~13 weeks minimum

**Parallel work possible:**
- Phases 5, 6, 7 (add-on modules) can be built in parallel after Phase 1
- Phase 4 (comms filter) can run in parallel with Phase 2-3
- Frontend and backend work within each phase can be parallelized

**Bottlenecks:**
1. **AI personality tuning** (Phase 1) — getting Ellie's tone right is subjective and iterative
2. **Memory extraction quality** (Phase 1) — Claude must reliably extract facts from casual conversation
3. **Email OAuth** (Phase 4) — Google/Microsoft approval processes are slow and bureaucratic
4. **Cross-module reasoning** (Phase 8) — prompt engineering for multi-domain context is complex

---

## 5. Open Questions & Decisions Needed

### Product Decisions

| # | Question | Options | Recommendation | Impact |
|---|----------|---------|----------------|--------|
| 1 | **Separate repo or monorepo?** | New repo `ellie-life` vs directory in `ellie-home` vs new workspace in monorepo | New repo — distinct product, different deployment, different team eventually | Phase 0 blocker |
| 2 | **Database isolation model?** | Separate local Postgres instance vs shared instance with schema namespacing | Separate instance — consumer data isolation, independent RLS, clean boundary from Ellie OS data | Phase 0 blocker |
| 3 | **Free tier: real free or trial?** | Genuinely free forever (limited) vs 14-day trial | Free forever with limits (per mockup: 30-day memory, 3 tasks/day) — better conversion funnel | Phase 9 |
| 4 | **Voice: Groq or local?** | Groq API (cloud) vs local Whisper | Groq — simpler for consumer users, already proven in relay | Phase 1 |
| 5 | **Email integration scope?** | Read-only email access vs full API (send drafts)? | Read-only initially — reduces permission scope and security risk | Phase 4 |
| 6 | **Mobile: PWA or native app?** | PWA (web) vs React Native / Expo | PWA for MVP — faster to build, single codebase. Native later if traction proves it | Phase 0 |
| 7 | **How to handle "Ellie says" summaries?** | Real-time Claude summarization vs pre-computed? | Pre-computed during triage (batch process) — cheaper, faster UX | Phase 4 |
| 8 | **User data isolation model?** | Per-user encryption? Shared DB with RLS? | RLS for MVP, per-user encryption keys as premium feature later | Phase 0 |

### Technical Decisions

| # | Question | Impact |
|---|----------|--------|
| 9 | **Which Claude model for chat?** Claude Sonnet (cheaper, faster) vs Opus (better personality) | Cost model — at $4.99/mo base, per-user AI cost matters a lot |
| 10 | **Real-time chat: SSE or WebSocket?** | SSE is simpler and sufficient for 1:1 chat; WebSocket if we add collaboration later |
| 11 | **Notification delivery: web push, email, SMS, or all?** | Nudges are core UX — push is essential, email/SMS add complexity |
| 12 | **Memory storage: how much context per conversation?** | Balancing AI quality vs token cost — sliding window vs full history with summarization? |
| 13 | **How does the comm filter actually access notifications?** | Gmail API is well-documented; Slack requires workspace admin; SMS is hardest. Scope this carefully. |

### Business Decisions

| # | Question | Impact |
|---|----------|--------|
| 14 | **Target launch timeline?** | Phases above estimate ~19 weeks (solo) — is this an H1 or H2 target? |
| 15 | **Beta strategy?** | Closed beta (invite-only) vs open beta? How many users? |
| 16 | **Is this Dave-only or will you hire for it?** | Solo dev vs team changes the phase timeline dramatically |
| 17 | **Domain: `app.ellielife.com` confirmed?** | Mockup uses this — need to register/configure |
| 18 | **Privacy/compliance: GDPR, CCPA, HIPAA?** | Health data + emotional data + email access = significant compliance burden |

---

## 6. Recommended Next Actions

### Immediate (this week)

1. **Decide repo/infrastructure split** (Question #1, #2) — this unblocks Phase 0
2. **Register `ellielife.com`** if not already done
3. **Create a Plane epic** for Ellie Life with sub-tasks mapped to the phases above
4. **Prototype the AI personality** — write system prompt for Ellie Life, test in Claude console with sample conversations. This is the soul of the product and takes iteration.

### Short-term (next 2 weeks)

5. **Scaffold the project** (Phase 0) — Nuxt 3 + local Postgres/pgvector + design tokens
6. **Build the chat core** (Phase 1.4-1.7) — this is the minimum viable product interaction
7. **Run the mockup HTML files as design reference** — keep them open in a browser tab during development. They're fully interactive prototypes.

### Before committing to full build

8. **Cost model the AI** — estimate per-user monthly Claude API cost at expected usage levels. If a $4.99/mo user generates $3/mo in API calls, margins are thin.
9. **Validate the comm filter** (Phase 4) with real email OAuth — this is the highest-risk integration. Build a proof-of-concept before committing to the full timeline.
10. **User research** — the mockup persona (Sarah, WFH mom) is specific. Validate this resonates with your target market before building all 3 add-ons.

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| AI cost per user exceeds revenue | High | Critical | Model selection (Sonnet vs Opus), response caching, conversation summarization, hard limits on free tier |
| Email OAuth approval delays | High | Blocks Phase 4 | Start OAuth application in Phase 0, even before building the feature |
| Memory extraction unreliable | Medium | High | Structured extraction prompts, human-in-the-loop review, user correction UI |
| Cross-module complexity explodes | Medium | High | Ship modules independently first, add cross-module features incrementally |
| Competitor launches similar product | Medium | Medium | Speed to market + personality differentiation + Ellie OS integration advantage |
| Privacy/compliance issues | Medium | Critical | Legal review before beta, minimize data retention, encryption at rest |
| Single developer bandwidth | High | High | Prioritize base tier MVP, defer add-ons to post-launch |

---

## Appendix: Design Token Reference

Extracted from mockup CSS for the Tailwind config:

```javascript
// tailwind.config.ts — Ellie Life theme
{
  colors: {
    warm: { bg: '#FFF8F0' },
    primary: { DEFAULT: '#E8735A', light: '#FFEEE9', dark: '#C45A44' },
    text: { DEFAULT: '#2D2926', muted: '#8A8380', light: '#B5AFAB' },
    accent: {
      green: { DEFAULT: '#7BC67E', light: '#EDF7EE' },
      blue: { DEFAULT: '#6BA3D6', light: '#EBF3FB' },
      purple: { DEFAULT: '#9B8FD0', light: '#F0EDF8' },
      gold: { DEFAULT: '#E8B84D', light: '#FDF5E3' },
    },
    border: '#F0EBE6',
    card: '#FFFFFF',
  },
  borderRadius: {
    DEFAULT: '16px',
    sm: '10px',
    xs: '6px',
  },
  boxShadow: {
    card: '0 2px 12px rgba(45,41,38,0.06)',
    hover: '0 4px 20px rgba(45,41,38,0.1)',
  },
  // Desktop sidebar: 240px
  // Phone frame: 320px x 640px
  // Desktop frame: max-width 1100px, min-height 600px
}
```
