---
title: Architecture Diagram vs. Codebase Audit
date: 2026-02-18
work_item: ELLIE-30
miro_board: https://miro.com/app/board/uXjVG_9WaJs=/
tags: [architecture, audit, ellie-dev, ellie-home]
---

# Architecture Audit: Miro Diagrams vs. Actual Code

This document audits the two Miro architecture diagrams against the actual implementation in both **ellie-dev** and **ellie-home** repositories.

**Miro Board:** https://miro.com/app/board/uXjVG_9WaJs=/
- Diagram 1: Ellie-Dev System Overview
- Diagram 2: Multi-Agent Routing System

---

## Diagram 1: Ellie-Dev System Overview

### Input Channels

| Component | Status | Location | Notes |
|-----------|--------|----------|-------|
| Telegram | Implemented | `src/relay.ts` (grammy) | Text, voice, photos, documents. Long-polling. Single authorized user. |
| Google Chat | Implemented | `src/google-chat.ts`, `src/relay.ts` `/google-chat` webhook | OAuth 2.0 + Service Account JWT. Optional — skips if not configured. |
| Twilio Voice | Implemented | `src/relay.ts` `/voice` + `/media-stream` WebSocket | Twilio Media Streams. mulaw 8kHz -> Whisper -> Claude -> ElevenLabs TTS streaming. Standalone `voice-call.ts` also exists but is not imported by relay. |
| Claude Code CLI | Implemented | `src/relay.ts` `callClaude()` | All AI invocations go through `spawn([CLAUDE_PATH, "-p", ...])`. Max subscription used (API key blanked). |

### Core Processing

| Component | Status | Location | Notes |
|-----------|--------|----------|-------|
| Relay Server | Implemented | `src/relay.ts` (~2015 lines) | HTTP on port 3000, WebSocket for voice, Telegram bot. Central hub for everything. |
| Auth Check | Implemented | `relay.ts` Telegram middleware, `google-chat.ts` `isAllowedSender()` | Per-channel, not centralized. No auth on Twilio webhook. |
| Agent Router | Implemented | `src/agent-router.ts` -> Supabase edge functions | `routeAndDispatch()` calls `route-message` then `agent-dispatch`. Falls back gracefully if Supabase unavailable. |
| Build Enriched Prompt | Implemented | `relay.ts` `buildPrompt()` | Assembles: agent system prompt, profile, context docket, semantic search, Elasticsearch, memory tags, Plane context. All fetched in parallel. |

### Context Enrichment

| Component | Status | Location | Notes |
|-----------|--------|----------|-------|
| User Profile | Implemented | `config/profile.md` loaded at startup | Static markdown file. Also uses `USER_NAME` and `USER_TIMEZONE` env vars. |
| Semantic Search | Implemented | `src/memory.ts` `getRelevantContext()` -> `search` edge function | OpenAI embeddings via Supabase edge function. Returns top 5 matches. |
| Elasticsearch | Implemented | `src/elasticsearch.ts` (311 lines) | Three indices: `ellie-messages`, `ellie-memory`, `ellie-conversations`. Fuzzy multi-match + recency decay. Optional — self-disables for 60s if unreachable. |
| Recent Messages | **Not Wired** | `src/memory.ts` `getRecentMessages()` exists | Function retrieves last 10 messages but is **not called** in the live prompt pipeline. Only semantic search, ES, and context docket are used. |

### AI Processing

| Component | Status | Location | Notes |
|-----------|--------|----------|-------|
| Claude AI | Implemented (two paths) | `relay.ts` `callClaude()` (CLI), `callClaudeVoice()` (API + fallback) | CLI is primary path using Max subscription. Voice uses Haiku via direct API for speed, falls back to CLI. Agent model override is coded but commented out (line 340-341) to stay on Max. |

### Response Processing

| Component | Status | Location | Notes |
|-----------|--------|----------|-------|
| Parse Response | Implemented | `src/memory.ts` `processMemoryIntents()`, `src/approval.ts` `extractApprovalTags()` | Two parsing passes on every response. |
| Memory Intents | Implemented | `src/memory.ts` lines 21-92 | `[REMEMBER:]` -> fact, `[GOAL:]` -> goal with optional deadline, `[DONE:]` -> completes matching goal. All indexed to ES. |
| Approval Tags | Implemented | `src/approval.ts`, `relay.ts` `sendWithApprovals()` | `[CONFIRM:]` generates Telegram InlineKeyboard buttons. 15-min expiry. **Telegram-only** — not supported on Google Chat. |
| Send Response | Implemented | `relay.ts` `sendResponse()` (Telegram), webhook JSON (GChat), TTS stream (voice) | Telegram: chunked at 4000 chars, file attachment at 8000+. GChat: synchronous webhook response. Voice: ElevenLabs streaming. |
| Consolidation | Implemented | `src/consolidate-inline.ts` (349 lines), `relay.ts` idle timers | Two 10-min idle timers (Telegram + GChat). Groups messages into conversations (30-min gap threshold). Extracts summary + facts + action items via Claude CLI. |

### External Integrations

| Component | Status | Location | Notes |
|-----------|--------|----------|-------|
| Supabase DB | Implemented | `relay.ts` `saveMessage()`, schema in `db/schema.sql` | Tables: messages, memory, conversations, agents, agent_sessions, agent_messages, routing_rules, agent_handoffs, work_sessions, work_session_updates. Optional. |
| Plane PM | Implemented | `src/plane.ts` (286 lines) | REST client for `plane.ellie-labs.dev`. CRUD on issues, work session tracking. `ELLIE-XX` mentions auto-inject context into prompts. |
| ElevenLabs TTS | Implemented | `relay.ts` `streamTTSToTwilio()`, `textToSpeechMulaw()`, `textToSpeechOgg()` | Used for voice calls (mulaw streaming) and Telegram voice replies (OGG). Model: `eleven_turbo_v2_5`. |
| Approval Buttons | Implemented | `src/approval.ts`, `relay.ts` callback handlers | Telegram InlineKeyboard. Approve resumes Claude session. Deny tells Claude not to proceed. **Telegram-only.** |

---

## Diagram 2: Multi-Agent Routing System

| Component | Status | Location | Notes |
|-----------|--------|----------|-------|
| Check Active Sessions | Implemented | `supabase/functions/route-message/index.ts` lines 33-57 | First checks `agent_sessions` for active session matching user+channel. If found, returns immediately with `rule_name: "session_continuity"`. |
| `route-message` edge fn | Implemented | `supabase/functions/route-message/index.ts` (181 lines) | Evaluates routing rules by priority: keyword/regex matching, channel matching, session continuity. |
| `agent-dispatch` edge fn | Implemented | `supabase/functions/agent-dispatch/index.ts` (136 lines) | Creates/resumes agent session, returns agent config. |
| `agent-sync` edge fn | Implemented | `supabase/functions/agent-sync/index.ts` (188 lines) | Logs response, updates session, detects handoffs, creates new sessions on handoff. |
| 7 Specialized Agents | Implemented (DB rows) | `db/migrations/20260216133351_agent_framework.sql` | All 7 seeded: general, dev, research, content, finance, strategy, critic. Database records, not separate code files. |
| Agent Configuration | Implemented | `agents` table: system_prompt, model, tools_enabled, capabilities | Dispatch returns all four fields. Model override is commented out in relay. |
| Post-Response Sync | Implemented | `agent-sync` edge fn + `agent-router.ts` `syncResponse()` | Logging, session updates, handoff detection + re-routing. Fire-and-forget calls. |

### Agent Routing Rules (seeded)

| Agent | Rule | Priority |
|-------|------|----------|
| dev | Keywords: code, bug, deploy, git, etc. | 100 |
| research | Keywords: research, find out, look up, etc. | 90 |
| finance | Keywords: budget, cost, revenue, etc. | 90 |
| content | Keywords: write, draft, blog, etc. | 80 |
| strategy | Keywords: plan, strategy, roadmap, etc. | 80 |
| general | Fallback (always matches) | 0 |
| critic | Keywords: review, critique, feedback, evaluate, assess, audit, etc. | 9 |

---

## Discrepancies & Gaps

### Resolved (2026-02-18)

1. ~~**Recent Messages not wired**~~ — **FIXED.** `getRecentMessages()` now called in parallel with other context sources in all 3 handlers (Telegram text, voice, Google Chat). Added as `recentMessages` parameter to `buildPrompt()`, injected as `RECENT CONVERSATION:` section.

2. ~~**Critic agent unreachable**~~ — **FIXED.** Added routing rule `critic_keywords` at priority 9 with keywords: review, critique, feedback, evaluate, assess, audit, "check my", "what do you think", "pros and cons". Migration: `db/migrations/20260218_critic_routing.sql`.

3. ~~**Approval buttons are Telegram-only**~~ — **FIXED.** Google Chat responses with `[CONFIRM:]` tags now render as Cards v2 with Approve/Deny buttons. Card click events (`CARD_CLICKED`) are handled in the webhook to resume Claude with the user's decision.

4. ~~**Agent model override commented out**~~ — **FIXED.** Now controlled by `AGENT_MODEL_OVERRIDE` env var (default: `false`). When set to `true`, per-agent model settings are passed to the CLI `--model` flag. This routes to API credits, so it's opt-in.

5. ~~**No auth on Twilio webhook**~~ — **FIXED.** Added `validateTwilioSignature()` function that validates `X-Twilio-Signature` header using HMAC-SHA1 with `TWILIO_AUTH_TOKEN`. Applied to the `/voice` POST endpoint. Skips validation gracefully if auth token is not configured.

### Remaining

6. **Context Docket not in diagram** — The relay fetches from `localhost:3000/api/context` (5-minute cache) as an additional context source. This is production functionality not represented in either diagram.

7. **Auth is per-channel, not centralized** — The diagram shows a single "Auth Check" node. In practice, each channel implements its own auth independently.

---

## ellie-home Architecture (No Miro Diagram)

The dashboard has no dedicated Miro diagram. Here is the current architecture for reference:

### Stack
- **Framework:** Nuxt 4 (Vue 3) with Tailwind CSS v4
- **Local DB:** PostgreSQL via Drizzle ORM (Unix socket)
- **Remote DB:** Supabase (conversations, messages, memory, agents, work sessions)
- **Realtime:** SSE via EventEmitter -> `/api/events`
- **Hosting:** Port 3000, Cloudflare tunnel, no authentication

### Data Flow
```
Browser  --SSE-->  /api/events  --listen-->  eventBus (EventEmitter)
                                                 ^
                                     POST actions emit here

Browser  --fetch-->  Nuxt API routes
                         |-- Drizzle --> local PostgreSQL
                         |   (projects, goals, activity_log, bot_health, token_health)
                         |-- Supabase --> remote Supabase
                         |   (conversations, messages, memory, agents, work_sessions)
                         |-- HTTP proxy --> relay (localhost:3001)
                         |   (queue-status, health, consolidate, extract-ideas, work-session)
                         |-- execSync --> systemctl (health checks, restarts)
                         |-- execSync --> claude CLI (calendar, email via MCP tools)
                         |-- execSync --> gh CLI (GitHub commits)
                         |-- HTTP --> Plane API (kanban board)
```

### Pages
| Page | Route | Description |
|------|-------|-------------|
| Status | `/` | Dashboard grid: health, queue, tokens, sessions, agents, projects, goals, calendar, email, outreach, system |
| Conversations | `/conversations` | Conversation browser + detail panel, memory explorer, embedding coverage |
| Work | `/work` | Plane kanban board, work session timeline, commit activity |
| Analytics | `/analytics` | Message volume, agent usage, channel breakdown charts |
| Actions | `/actions` | Quick actions, service manager, memory manager, activity log |

### API Routes (38 total)

**Local DB (Drizzle):** health, system, token-health, activity (GET/POST), projects, goals

**Supabase:** agents (list/activity), conversations (list/detail/search), memory (CRUD), work-sessions (list/active/updates), stats (volume/usage/breakdown/embeddings), context docket

**Relay Proxy:** queue-status, check-tokens, close-conversation, extract-ideas, trigger-agent, restart-relay, health-check

**External CLI:** calendar (Claude + MCP), email (Claude + MCP), github/commits (gh CLI)

**Webhooks:** github (push/PR/workflow/issues -> activity_log)

### Local DB Tables
| Table | Purpose |
|-------|---------|
| `projects` | Dashboard project list |
| `goals` | Dashboard goals |
| `activity_log` | Audit trail for all dashboard actions |
| `bot_health` | Health check snapshots |
| `token_health` | API token health results |

---

## Remaining Recommendations

### Medium Priority
1. **Create ellie-home Miro diagram** — The dashboard is complex enough to warrant its own architecture diagram
2. **Update Miro diagrams** — Add context docket, clarify per-channel auth, document `AGENT_MODEL_OVERRIDE` flag

### Low Priority
3. **Add Cloudflare Access** — Dashboard currently has no auth beyond the tunnel
