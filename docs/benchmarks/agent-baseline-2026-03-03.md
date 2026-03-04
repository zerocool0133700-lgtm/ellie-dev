# Agent System Baseline — March 3, 2026

**Purpose:** Benchmark snapshot of all agents, skills, and infrastructure as of March 3, 2026. This baseline will be used to measure improvements over the next 10 agent deployments.

**Benchmark Date:** March 3, 2026, 7:27 PM CST
**Performing Stage Start:** March 1, 2026 (formal KPI tracking begins from this date)
**Commits Since Performing Stage:** 50+ commits (Mar 1-3, 2026)

---

## Executive Summary

**Current State:**
- 8 active specialist agents + 1 orchestrator
- 11 archetype templates defined
- 29 skills loaded across all agents
- Relay uptime: Active (systemd service running)
- Multi-channel support: Telegram, Google Chat, Ellie Chat (dashboard), Slack, Discord (observation only)
- Forest integration: 94+ memories across 5 project scopes

**Known Gaps:**
- Agent routing: Functional but lacks self-contained orchestrator tree
- Creature system: 11 archetypes defined, missing composable architecture (DNA templates, Forest tree structure, prompt builder, profile UI)
- Context gathering: Uses `Promise.all()` — single context source failure kills entire request
- Health monitoring: No automated channel health checks (relies on systemd)
- Error boundaries: Limited isolation between channels

**Recent Wins (Last 72 Hours):**
- ELLIE-443: Slack integration shipped (Events API, slash commands, notifications)
- ELLIE-461/462/463/465: Relay stability + channel hardening (AbortController per WS, active restart, delivery queue, periodic task guards)
- ELLIE-457: River (R scope) integrated into Forest (38 docs, BM25 search)
- ELLIE-454: Forest capability trees (C scope for agent performance tracking)
- ELLIE-442: Discord observation layer (creature lifecycle events)

---

## Agent Roster

### Active Specialists (8)

| Agent | Type | Capabilities | Token Budget | Status |
|-------|------|-------------|--------------|--------|
| **general** | orchestrator | conversation, task-management, coordination | 24k | Active |
| **dev** | specialist | coding, debugging, git, deployment, code-review | 28k | Active |
| **ops** | specialist | infrastructure, monitoring, deployment, incident-triage, server-management, log-analysis | 24k | Active |
| **research** | specialist | web-search, analysis, summarization, data-gathering | TBD | Active |
| **strategy** | specialist | planning, decision-making, roadmapping, prioritization | TBD | Active |
| **content** | specialist | writing, editing, documentation, copywriting | TBD | Active |
| **finance** | specialist | budgeting, analysis, reporting, forecasting | TBD | Active |
| **critic** | specialist | review, feedback, quality-assurance, validation | TBD | Active |

### Archetype Templates Defined (11)

- general (squirrel, breadth-first forager)
- dev (ant, depth-first single-threaded)
- ops (bee, cross-pollination)
- research (squirrel, breadth-first)
- strategy (squirrel, breadth-first)
- content (TBD)
- finance (TBD)
- critic (TBD)
- chipmunk (TBD)
- deer (TBD)
- road-runner (fast triage/dispatch, skill-only mode)

---

## Skills System

**Total Skills:** 29 active skills across all agents

### Core Skills (Always-On)
- **briefing** — Pre-work Forest search before starting substantive work
- **forest** — Knowledge graph read/write operations
- **skill-detector** — Pattern detection for new skill suggestions
- **context-strategy** — Mode-aware context docket (conversation/strategy/workflow/deep-work/skill-only)
- **verify** — Ground truth checker before presenting assessments

### Integration Skills
- **plane** — Work item management (evelife workspace, ELLIE project)
- **github** — Repository operations, PR/issue management
- **google-workspace** — Gmail, Calendar, Tasks, Drive, Docs, Sheets
- **miro** — Visual planning, diagrams, docs, tables
- **outlook** — Email integration (secondary)
- **n8n** — Workflow automation
- **obsidian** — Note-taking integration

### Workflow Skills
- **gtd** — Getting Things Done task management
- **daily-briefing** — Morning summary generation
- **calendar-intel** — Smart calendar analysis
- **comms** — Communication management
- **alert** — Notification/alert handling
- **automation-workflows** — Automated workflow patterns

### Analysis Skills
- **analytics** — Data analysis and reporting
- **architecture-review** — Code/system architecture review
- **audit** — System/data auditing
- **ellie-reports** — Report generation
- **youtube-watcher** — Video content tracking
- **weather** — Weather data integration
- **relationship-tracker** — Contact/relationship management

### Utility Skills
- **memory** — Conversation memory read/write
- **forest-import** — Bulk import to Forest
- **skill-guard** — Skill safety/validation
- **nano-banana-pro** — (TBD — uploaded skill, purpose unknown)

---

## Infrastructure Status

### Relay Service
- **Status:** Active (systemd user service: `claude-telegram-relay`)
- **Uptime:** Currently running
- **Architecture:** Single-process monolithic relay + multi-channel support
- **Restart Command:** `systemctl --user restart claude-telegram-relay`
- **Logs:** `journalctl --user -u claude-telegram-relay`

### Channels
1. **Telegram** — Primary channel, bot-based, active
2. **Google Chat** — Service account auth, webhook-based, active
3. **Ellie Chat** — WebSocket-based dashboard, active
4. **Slack** — Events API + slash commands, notification support (ELLIE-443)
5. **Discord** — Observation layer only (creature lifecycle events, job tracking)

### Database
- **Supabase** — Postgres + edge functions
- **Tables:** messages, memory, logs, work_sessions, agents, agent_sessions, agent_messages, skills
- **Edge Functions:** route-message, agent-dispatch, agent-sync, embed, search
- **Views:** creature_capability_summary, creature_performance_canopy

### Knowledge Graph
- **Forest Bridge:** Active at http://localhost:3001/api/bridge
- **Scopes:** 5 project scopes (2=Projects, 2/1=ellie-dev, 2/2=ellie-forest, 2/3=ellie-home, 2/4=ellie-os-app)
- **Memory Count:** ~94+ memories across all scopes
- **River Integration (R scope):** 38 markdown documents indexed, BM25 search available

---

## Agent Routing & Orchestration

### Routing Mechanism
- **Primary:** LLM-based intent classifier (ELLIE-50) via `classifyIntent()`
- **Fallback:** Supabase edge function `route-message`
- **Modes:** conversation, strategy, workflow, deep-work, skill-only

### Execution Modes
- **single** — One agent handles the entire request
- **parallel** — Multiple agents work concurrently
- **sequential** — Chained agent pipeline
- **skill-only** — Minimal context, skill-driven execution (road-runner creature)

### Dispatch Flow
1. User message → Intent classification → Route to agent
2. Agent dispatch → Session lookup/creation (work_item_id isolation)
3. Context gathering → Prompt building → Claude API call
4. Response delivery → Session sync → Memory write

### Known Issues
- **Orchestrator lacks tree structure** — Currently scattered markdown + hardcoded routing logic. Needs: identity (soul, archetype), registry (creatures, roles, skills), routing rules, coordination patterns, active state tracking.
- **State desync** — Tickets can get stuck "In Progress" in Plane despite no active runs
- **Context overload** — Single `Promise.all()` for context gathering; any source timeout kills entire request
- **No health monitoring** — Channels don't auto-recover from failures

---

## Performance Baseline (March 1, 2026)

**Performing Stage Benchmark:**
- **Date:** March 1, 2026 (reset point — historical failure rates discarded)
- **Output:** 33 tickets + 20 commits in single day
- **Key Decision:** All future KPI tracking starts from this benchmark, not historical averages

**Tracked Metrics (Going Forward):**
- Dispatch success rate
- Pipeline completion rate
- Backlog delta (tickets in vs. tickets out)
- Stale ticket count
- Incident-to-work ratio

**Current Gaps in Measurement:**
- No automated success rate tracking
- No completion rate dashboard
- No real-time KPI monitoring
- Creature performance tracking infrastructure exists (C scope) but not yet wired to all jobs

---

## Recent Stability Improvements

### ELLIE-465: Relay Stability Fixes
- Periodic task re-entrancy guard (running flag + 10-min recovery)
- Crash log safety: sync `stderr.write()` before async logger
- BRIDGE_KEY moved to env var (no more hardcoded secrets)
- Supabase health check uses REST root endpoint
- Per-source timeouts: Forest + Google APIs = 6s, others = 3s
- 13 unit tests added for queue primitives

### ELLIE-461: Channel Hardening
- AbortController per WebSocket connection (WeakMap)
- `callClaude()` accepts abortSignal, kills subprocess on abort
- Top-level error boundary in `handleEllieChatMessage`
- No more zombie Claude processes after WS disconnect

### ELLIE-462: Active Restart
- Telegram bot auto-restarts after 2 consecutive down checks (~10min)
- `_telegramConsecutiveDown` counter tracks failures
- `_botRestarting` guard prevents concurrent restarts

### ELLIE-463: Delivery Queue
- In-memory ring buffer per userId (max 20 msgs, 15-min TTL)
- `deliverResponse()` pushes failures to buffer
- `drainMemoryBuffer()` on every reconnect (complements ELLIE-399 DB-backed catch-up)

---

## Known Gaps & Technical Debt

### High Priority
1. **Context Gathering Resilience**
   - Current: `Promise.all()` — single timeout kills entire request
   - Needed: `Promise.allSettled()` with per-source timeouts and fallbacks
   - Impact: Chat reliability under network/API degradation

2. **Orchestrator Tree Structure**
   - Current: Scattered markdown files, hardcoded routing logic
   - Needed: Forest-backed tree with identity, registry, routing rules
   - Impact: Self-aware orchestrator, better introspection, easier evolution

3. **Health Monitoring**
   - Current: No automated channel health checks (systemd only)
   - Needed: ChannelHealthMonitor (5-min checks, exponential backoff, rate limits)
   - Impact: Auto-recovery from transient failures

4. **Creature System Architecture**
   - Current: 11 archetypes defined, behavioral verification passed
   - Missing: DNA templates, role definitions, Forest tree structure, prompt builder, profile UI
   - Impact: 6 agent wirings blocked, composability limited

### Medium Priority
5. **Error Boundaries**
   - Current: Limited isolation between channels
   - Needed: Channel plugin system (extract Telegram, Google Chat, Ellie Chat to plugins)
   - Impact: Cascade failure prevention

6. **State Desync (Plane ↔ Orchestration)**
   - Current: Tickets stuck "In Progress" despite no active runs
   - Needed: Work item lifecycle monitoring, orphaned session detection
   - Impact: Accurate work tracking

7. **Forest Documentation Gaps**
   - Current: Hot fixes and research tickets sometimes skip Forest writes
   - Needed: Dev agents recognize documentation discipline for all ticket types
   - Impact: Knowledge continuity across sessions

### Low Priority
8. **Config Hot-Reload**
   - Current: Requires full relay restart for .env changes
   - Needed: Watch .env and reload without restart
   - Impact: Quality-of-life improvement (low impact for single-user)

9. **Subsystem Loggers**
   - Current: Flat logger, hard to filter
   - Needed: Structured subsystem loggers ([telegram], [gchat], [forest], etc.)
   - Impact: Better debugging and monitoring

---

## Comparison to OpenClaw (Claude Code Gateway)

**Analysis Date:** March 3, 2026
**Document:** `/home/ellie/ellie-dev/docs/architecture/openclaw-relay-comparison.md`

**What OpenClaw Does Better:**
- Channel isolation (plugin architecture prevents cascade failures)
- Error boundaries (failures contained and auto-recovered)
- Health monitoring (5-min checks, exponential backoff, rate limits)
- Startup safety (readiness gates prevent race conditions)
- Structured logging (subsystem loggers)

**What Ellie Relay Does Differently (Not Worse):**
- AI context gathering (OpenClaw is router, not agent)
- Forest Bridge integration (knowledge graph as a service)
- Orchestrator pattern (multi-agent coordination with creatures, jobs, sessions)
- Domain-specific intelligence (skills system, UMS consumers)

**Recommended Phased Approach:**
- **Phase 1 (Immediate):** `Promise.allSettled`, readiness gate, periodic task error boundaries
- **Phase 2 (Structural):** Channel plugins, ChannelHealthMonitor, consolidate queue
- **Phase 3 (Advanced):** AbortController per channel, subsystem loggers, hot-reload

---

## Skills in Conversation Context

### Current Skills Available to General Agent
- plane, memory, forest, github, briefing, google-workspace
- verify, skill-detector, context-strategy

### Current Skills Available to Dev Agent
- github, plane, memory, forest, verify

### Current Skills Available to Ops Agent
- plane, github, memory, forest, alert

---

## Measurement Plan

**Over the next 10 agent deployments, track:**

1. **Dispatch Success Rate**
   - Baseline: Unknown (no tracking yet)
   - Target: 95%+ successful dispatches
   - Measurement: `jobs.status = 'completed' / total jobs`

2. **Context Gathering Reliability**
   - Baseline: Fragile (single source failure = total failure)
   - Target: Graceful degradation (0 total failures due to context sources)
   - Measurement: Count of "context gather failed" errors

3. **Channel Uptime**
   - Baseline: Manual restart required on failure
   - Target: Auto-recovery within 10 minutes
   - Measurement: Downtime incidents per week

4. **Agent Response Time**
   - Baseline: Unknown (no tracking)
   - Target: <30s for simple queries, <5min for complex work
   - Measurement: P50, P95, P99 response time

5. **Memory Write Consistency**
   - Baseline: Gaps in hot-fix documentation
   - Target: 100% of tickets get Forest documentation
   - Measurement: Manual audit of completed tickets

6. **Error Recovery**
   - Baseline: No auto-recovery, systemd restarts only
   - Target: 90%+ of transient failures auto-recovered
   - Measurement: Manual restarts per week

7. **Stale Ticket Rate**
   - Baseline: Unknown
   - Target: <5% of open tickets older than 7 days
   - Measurement: Weekly Plane query

8. **Orchestrator Introspection**
   - Baseline: No self-awareness (scattered config files)
   - Target: Orchestrator can query its own registry and routing rules
   - Measurement: Binary (implemented or not)

---

## Validation Checklist

Use this checklist to validate improvements after the next 10 agent deployments:

### Infrastructure
- [ ] Context gathering uses `Promise.allSettled()` (no single-source failures)
- [ ] ChannelHealthMonitor runs every 5 minutes with auto-restart
- [ ] Startup readiness gate prevents race conditions
- [ ] All periodic tasks have error boundaries + exponential backoff
- [ ] Channel plugins extracted (Telegram, Google Chat, Ellie Chat)

### Agent System
- [ ] Orchestrator has Forest tree structure (identity, registry, routing)
- [ ] Creature system has DNA templates + prompt builder
- [ ] All 6 blocked agent wirings completed
- [ ] Dispatch success rate tracked automatically
- [ ] Performance metrics written to C scope after every job

### Knowledge Management
- [ ] 100% of completed tickets have Forest documentation
- [ ] No hot-fix gaps in knowledge tree
- [ ] Memory write consistency validated weekly

### Observability
- [ ] Subsystem loggers implemented ([telegram], [gchat], [forest], [health])
- [ ] Health endpoint exposes readiness + dependency status
- [ ] Real-time KPI dashboard for dispatch success, uptime, response time

---

## Next Actions

1. **Record this benchmark to Forest** — Write this baseline as a decision to C/1 (Agent Performance)
2. **Set up tracking** — Create weekly audit script for the 8 measurement metrics
3. **Pick first improvement** — Choose one gap to address in next sprint
4. **Re-benchmark after 10 agents** — Compare metrics against this baseline

---

## Appendix: System Inventory

### Files Analyzed
- `src/relay.ts` — Main relay loop
- `src/agent-router.ts` — Routing and dispatch
- `src/agent-profile-builder.ts` — Prompt construction
- `src/skills/` — 29 skill definitions
- `config/archetypes/` — 11 archetype templates
- `docs/architecture/openclaw-relay-comparison.md` — Infrastructure analysis

### API Endpoints Verified
- `GET /api/agents` — Active agent registry (8 agents)
- `GET /health` — Relay health (parse error, needs fix)
- `POST /api/bridge/read` — Forest search
- `POST /api/work-session/*` — Work item lifecycle

### Environment Verified
- Relay service: Active
- Supabase: Connected
- Forest Bridge: Responding
- Telegram: Active
- Google Chat: Active
- Ellie Chat: Active

---

**Benchmark Owner:** Dave
**Next Review:** After 10 agent deployments (target: ~2 weeks)
**Document Version:** 1.0
**Last Updated:** March 3, 2026, 7:30 PM CST
