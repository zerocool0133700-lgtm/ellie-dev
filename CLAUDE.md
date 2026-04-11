# Ellie Chat Relay — Operations Guide

> Claude Code reads this file automatically. It defines how agents work with this codebase.

## What This Is

The Ellie Chat Relay is Ellie's brain — an HTTP/WebSocket server that powers Ellie Chat and adapts to messaging channels (Telegram, Google Chat, Discord, Slack). The HTTP/WebSocket side is primary. The bot integrations are adapters.

## Channel Priority

Ellie Chat is the primary experience. Every feature, every agent interaction, every tool — available in Ellie Chat without restriction. This is where the full rich experience lives: dispatch container cards, the inquiry mechanism, real-time agent activity.

**When building something new:**
1. Design for Ellie Chat first
2. Ask: "What's the Telegram-appropriate version?" second
3. Adapter channels (Google Chat, Discord, Slack) get what makes sense for their medium

**No feature should be Telegram-only.** If it exists in Telegram, it exists in Ellie Chat. Telegram gets text summaries and inline buttons. Ellie Chat gets the full UI.

---

## First-Time Setup

For setting up a new relay instance from scratch, see [docs/setup-guide.md](docs/setup-guide.md).

> **Channel adapters reference** (env vars, handler files per channel) — search Forest for "Channel Adapters Reference" tag:claude-md-moved

---

## Work Session Dispatch Protocol

> **For the project owner (Dave).** If `.env` has `PLANE_API_KEY` set and Plane MCP is available, this protocol is active. Otherwise, skip this section — it does not apply to first-time setup users.

### IMPORTANT: When to Use This Protocol

**USE** this protocol when Dave explicitly asks to **work on**, **implement**, **fix**, **build**, or **code** something.

**DO NOT USE** this protocol for:
- Status checks ("check on ELLIE-5", "what's the status of 139")
- Information queries ("what is ELLIE-5 about?", "show me the ticket")
- Reviews ("look at ELLIE-5", "review the work on 139")

For status checks, just use `mcp__plane__get_issue_using_readable_identifier` to fetch and display the ticket — do NOT call `/api/work-session/start`, `/api/work-session/complete`, or update the Plane issue state.

## Session Startup

When Dave starts a Claude Code session and mentions a work item (e.g., "work on ELLIE-5") or asks to work on something:

1. **Fetch the work item** using Plane MCP:
   ```
   mcp__plane__get_issue_using_readable_identifier("ELLIE", "5")
   ```

2. **Display the work item** — title, description summary, priority, and acceptance criteria.

3. **Move the issue to In Progress** in Plane:
   ```
   mcp__plane__update_issue(project_id, issue_id, { state: "<started-state-id>" })
   ```

4. **Notify the relay** so Dave sees it on Telegram:
   ```bash
   POST http://localhost:3001/api/work-session/start
   {
     "work_item_id": "ELLIE-5",
     "title": "Implement Claude Code Work Session Dispatch Protocol",
     "project": "ellie-dev"
   }
   ```
   The relay auto-detects which agent is active from the routing system. Do NOT hardcode `"agent": "dev"` — the relay resolves this from the active agent session. Only pass `"agent"` if you need to override the auto-detection.
   The relay creates the session record and returns `session_id` in the response.

5. **Begin work** on the task.

If Dave doesn't mention a specific work item, ask:
> Are you working on a defined work item from Plane? I can fetch open items, or we can work without one.

## During Work

### Progress Updates
On **major milestones** (schema changes, feature complete, significant commits), POST to the relay:

```bash
POST http://localhost:3001/api/work-session/update
{
  "work_item_id": "ELLIE-5",
  "message": "Brief description of what was done"
}
```

The relay finds the active session for the work item automatically.

### Decision Logging
When choosing between approaches, log the decision:

```bash
POST http://localhost:3001/api/work-session/decision
{
  "work_item_id": "ELLIE-5",
  "message": "Decision: Using X approach because Y. Alternatives considered: A, B"
}
```

## Session Complete

When the work item is done (or the session ends):

1. **POST completion** to the relay:
   ```bash
   POST http://localhost:3001/api/work-session/complete
   {
     "work_item_id": "ELLIE-5",
     "summary": "What was accomplished"
   }
   ```
   The relay marks the session complete, updates Plane to Done, and posts a summary to Telegram.

2. **Update Plane issue** — move to Done (if completed) or leave In Progress (if blocked/paused). Add a completion comment with the summary.

3. **Commit with work item prefix:**
   ```
   [ELLIE-5] Brief description of change
   ```

4. **Push to remote** if Dave asks.

## Git Workflow

### Commit Messages
```
[ELLIE-{id}] Brief description of change
```

### Pre-commit
- Run type checks if available
- Ensure no `.env` or secrets are staged
- Reference the work item ID in the commit

> **UI Development Workflow** (ellie-home rebuild/refresh steps) — search Forest for "UI Development Workflow" tag:claude-md-moved

## Plane Reference

- **Workspace:** evelife
- **Project identifier:** ELLIE
- **Project UUID:** 7194ace4-b80e-4c83-8042-c925598accf2
- **Base URL:** https://plane.ellie-labs.dev

### State IDs
- Backlog: `f3546cc1-69ed-4af9-8350-5e3b1b22a50e`
- Todo: `92d0bdb9-cc96-41e0-b26f-47e82ea6dab8`
- In Progress: `e551b5a8-8bad-43dc-868e-9b5fb48c3a9e`
- Done: `41fddf8d-d937-4964-9888-b27f416dcafa`
- Cancelled: `3273d02b-7026-4848-8853-2711d6ba3c9b`

## Relay API Reference

All endpoints at `http://localhost:3001`:

| Endpoint | Purpose |
|----------|---------|
| `POST /api/work-session/start` | Log session initiation, notify Telegram |
| `POST /api/work-session/update` | Progress/decision/milestone/blocker updates |
| `POST /api/work-session/decision` | Architectural decision with reasoning |
| `POST /api/work-session/complete` | Session completion, Plane state update |

---

## Forest Bridge Protocol

> Feed the forest. As you work, write discoveries, decisions, and findings to the knowledge tree so future sessions can build on them.

### Bridge Key

```
x-bridge-key: bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a
```

### Scope Paths

| Path | Name | Use for |
|------|------|---------|
| `2` | Projects | Cross-project knowledge |
| `2/1` | ellie-dev | Relay, agents, integrations |
| `2/2` | ellie-forest | Forest lib, DB, migrations |
| `2/3` | ellie-home | Dashboard, Nuxt, themes |
| `2/4` | ellie-os-app | Mobile/desktop app |

Sub-scopes exist under each project (e.g. `2/1/1` = agents, `2/1/2` = finance). Use `/api/bridge/scopes` to browse.

### Guidelines

- Write **after** completing a task or making a decision, not while still exploring
- Keep content concise but self-contained — future sessions won't have your context
- Include `work_item_id` when the knowledge relates to a specific ticket
- Don't duplicate what's already in CLAUDE.md — the bridge is for dynamic knowledge
- Types: `decision`, `finding`, `fact`, `hypothesis`
- Read/write examples are in the global `~/.claude/CLAUDE.md`

## Skills System (ELLIE-217)

Agent capabilities are defined as `SKILL.md` files in `skills/*/SKILL.md`. Each has YAML frontmatter (name, triggers, requirements) and markdown instructions injected into agent prompts.

- **Location:** `skills/` (bundled), `~/.ellie/skills/` (personal), `<workspace>/skills/` (project overrides)
- **Core modules:** `src/skills/` — loader, eligibility, snapshot, commands, watcher
- **Always-on skills:** `briefing` (Forest pre-work search), `forest` (knowledge library)
- **Env-gated skills:** `plane`, `github`, `google-workspace`, `miro`, `memory`
- **Hot-reload:** Edit any SKILL.md and the relay picks it up automatically
- **Slash commands:** User-invocable skills become `/command` (e.g., `/plane list issues`)

To add a new skill: create `skills/<name>/SKILL.md` with frontmatter + instructions.

## Project Architecture

> Detailed architecture docs have been moved to Forest for on-demand retrieval. Search with tag `claude-md-moved` to find them.

- **Working Memory API** — search Forest for "Working Memory Session-Scoped Context"
- **River Vault / Prompt Architecture** — search Forest for "River Vault Prompt Architecture"
- **Agent MCP Access Matrix** — search Forest for "Agent MCP Access Matrix"
- **Inter-Agent Communication Protocol** — search Forest for "Inter-Agent Communication Protocol"

---

- **Relay:** `src/relay.ts` — Telegram bot + HTTP server + voice calls + Google Chat webhook
- **Google Chat:** `src/google-chat.ts` — Service account auth, message sending, webhook parsing
- **Memory:** `src/memory.ts` — Supabase-backed conversation history + semantic search
- **Agents:** `src/agent-router.ts` — multi-agent routing via Supabase edge functions
- **Skills:** `src/skills/` — SKILL.md loader, eligibility filter, prompt injection, slash commands (ELLIE-217)
- **Work Sessions:** `src/api/work-session.ts` — session lifecycle management (notifies Telegram + Google Chat)
- **Plane:** `src/plane.ts` — work item state sync
- **Voice:** Local Whisper transcription + ElevenLabs TTS streaming
- **Database:** Supabase (cloud) + Forest/Postgres (local). Migrations in `migrations/{supabase,forest}/`, seeds in `seeds/{supabase,forest}/`
- **Service:** systemd user service `ellie-chat-relay`

### Testing

All tests live in `tests/` — this is the single canonical test directory. Never add test files to `src/`.

```bash
bun test                                          # Run all tests
bun test tests/memory.test.ts                     # Run a specific test
```

Before closing a hardening ticket, run `bun test` to verify no regressions.

### SQL Migrations & Seeds

Two databases: **Supabase** (cloud) and **Forest** (local Postgres). Migrations in `migrations/{supabase,forest}/`, seeds in `seeds/{supabase,forest}/`.

**Rules:** Schema changes go in `migrations/<db>/`, seed data in `seeds/<db>/`, one-time backfills stay in `migrations/`.

> **Detailed migration commands and runner docs** — search Forest for "SQL Migrations Seeds Detailed Reference" tag:claude-md-moved

### Key Commands
```bash
systemctl --user restart ellie-chat-relay        # Restart relay
journalctl --user -u ellie-chat-relay            # View logs
bun run start                                     # Run manually
bun run test:telegram                             # Test Telegram
bun run test:supabase                             # Test database
bun run migrate                                   # Apply pending SQL migrations
bun run migrate:status                            # Check migration status
bun run migrate:validate                          # Validate seeds + detect drift
```
