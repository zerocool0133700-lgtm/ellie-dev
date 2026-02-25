# Claude Telegram Relay — Setup Guide

> Claude Code reads this file automatically. Walk the user through setup one phase at a time.
> Ask for what you need, configure everything yourself, and confirm each step works before moving on.

## How This Works

This project turns Telegram into a personal AI assistant powered by Claude.

The user cloned this repo (or gave you the link). Your job: guide them through setup conversationally. Ask questions, save their answers to `.env`, test each step, move on.

Do not dump all phases at once. Start with Phase 1. When it works, move to Phase 2. Let the user control the pace.

If this is a fresh clone, run `bun run setup` first to install dependencies and create `.env`.

---

## Phase 1: Telegram Bot (~3 min)

**You need from the user:**
- A Telegram bot token from @BotFather
- Their personal Telegram user ID

**What to tell them:**
1. Open Telegram, search for @BotFather, send `/newbot`
2. Pick a display name and a username ending in "bot"
3. Copy the token BotFather gives them
4. Get their user ID by messaging @userinfobot on Telegram

**What you do:**
1. Run `bun run setup` if `.env` does not exist yet
2. Save `TELEGRAM_BOT_TOKEN` and `TELEGRAM_USER_ID` in `.env`
3. Run `bun run test:telegram` to verify — it sends a test message to the user

**Done when:** Test message arrives on Telegram.

---

## Phase 2: Database & Memory — Supabase (~12 min)

Your bot's memory lives in Supabase: conversation history, facts, goals, and semantic search.

### Step 1: Create Supabase Project

**You need from the user:**
- Supabase Project URL
- Supabase anon public key

**What to tell them:**
1. Go to supabase.com, create a free account
2. Create a new project (any name, any region close to them)
3. Wait ~2 minutes for it to provision
4. Go to Project Settings > API
5. Copy: Project URL and anon public key

**What you do:**
1. Save `SUPABASE_URL` and `SUPABASE_ANON_KEY` to `.env`

### Step 2: Connect Supabase MCP

This lets Claude Code manage the database directly — run queries, deploy functions, apply migrations.

**What to tell them:**
1. Go to supabase.com/dashboard/account/tokens
2. Create an access token, copy it

**What you do:**
```
claude mcp add supabase -- npx -y @supabase/mcp-server-supabase@latest --access-token ACCESS_TOKEN
```

### Step 3: Create Tables

Use the Supabase MCP to run the schema:
1. Read `db/schema.sql`
2. Execute it via `execute_sql` (or tell the user to paste it in the SQL Editor)
3. Run `bun run test:supabase` to verify tables exist

### Step 4: Set Up Semantic Search

This gives your bot real memory — it finds relevant past conversations automatically.

**You need from the user:**
- An OpenAI API key (for generating text embeddings)

**What to tell them:**
1. Go to platform.openai.com, create an account
2. Go to API keys, create a new key, copy it
3. The key will be stored in Supabase, not on your computer. It stays with your database.

**What you do:**
1. Deploy the embed Edge Function via Supabase MCP (`deploy_edge_function` with `supabase/functions/embed/index.ts`)
2. Deploy the search Edge Function (`supabase/functions/search/index.ts`)
3. Tell the user to store their OpenAI key in Supabase:
   - Go to Supabase dashboard > Project Settings > Edge Functions
   - Under Secrets, add: `OPENAI_API_KEY` = their key
4. Set up database webhooks so embeddings are generated automatically:
   - Go to Supabase dashboard > Database > Webhooks > Create webhook
   - Name: `embed_messages`, Table: `messages`, Events: INSERT
   - Type: Supabase Edge Function, Function: `embed`
   - Create a second webhook: `embed_memory`, Table: `memory`, Events: INSERT
   - Same Edge Function: `embed`

### Step 5: Verify

Run `bun run test:supabase` to confirm:
- Tables exist (messages, memory, logs)
- Edge Functions respond
- Embedding generation works

**Done when:** `bun run test:supabase` passes and a test insert into `messages` gets an embedding.

---

## Phase 3: Personalize (~3 min)

**Ask the user:**
- Their first name
- Their timezone (e.g., America/New_York, Europe/Berlin)
- What they do for work (one sentence)
- Any time constraints (e.g., "I pick up my kid at 3pm on weekdays")
- How they like to be communicated with (brief/detailed, casual/formal)

**What you do:**
1. Save `USER_NAME` and `USER_TIMEZONE` to `.env`
2. Copy `config/profile.example.md` to `config/profile.md`
3. Fill in `config/profile.md` with their answers — the bot loads this on every message

**Done when:** `config/profile.md` exists with their details.

---

## Phase 4: Test (~2 min)

**What you do:**
1. Run `bun run start`
2. Tell the user to open Telegram and send a test message to their bot
3. Wait for confirmation it responded
4. Press Ctrl+C to stop

**Troubleshooting if it fails:**
- Wrong bot token → re-check with BotFather
- Wrong user ID → re-check with @userinfobot
- Claude CLI not found → `npm install -g @anthropic-ai/claude-code`
- Bun not installed → `curl -fsSL https://bun.sh/install | bash`

**Done when:** User confirms their bot responded on Telegram.

---

## Phase 5: Always On (~5 min)

Make the bot run in the background, start on boot, restart on crash.

**macOS:**
```
bun run setup:launchd -- --service relay
```
This auto-generates a plist with correct paths and loads it into launchd.

**Linux/Windows:**
```
bun run setup:services -- --service relay
```
Uses PM2 for process management.

**Verify:** `launchctl list | grep com.claude` (macOS) or `npx pm2 status` (Linux/Windows)

**Done when:** Bot runs in the background and survives a terminal close.

---

## Phase 6: Proactive AI (Optional, ~5 min)

Two features that turn a chatbot into an assistant.

### Smart Check-ins
`examples/smart-checkin.ts` — runs on a schedule, gathers context, asks Claude if it should reach out. If yes, sends a brief message. If no, stays silent.

### Morning Briefing
`examples/morning-briefing.ts` — sends a daily summary. Pattern file with placeholder data fetchers.

**macOS — schedule both:**
```
bun run setup:launchd -- --service all
```

**Linux/Windows — schedule both:**
```
bun run setup:services -- --service all
```

**Done when:** User has scheduled services running, or explicitly skips this phase.

---

## Phase 7: Voice Transcription (Optional, ~5 min)

Lets the bot understand voice messages sent on Telegram.

**Ask the user which option they prefer:**

### Option A: Groq (Recommended — free cloud API)
- State-of-the-art Whisper model, sub-second speed
- Free: 2,000 transcriptions per day, no credit card
- Requires internet connection

**What to tell them:**
1. Go to console.groq.com and create a free account
2. Go to API Keys, create a new key, copy it

**What you do:**
1. Save `VOICE_PROVIDER=groq` and `GROQ_API_KEY` to `.env`
2. Run `bun run test:voice` to verify

### Option B: Local Whisper (offline, private)
- Runs entirely on their computer, no account needed
- Requires ffmpeg and whisper-cpp installed
- First run downloads a 142MB model file

**What you do:**
1. Check ffmpeg: `ffmpeg -version` (install: `brew install ffmpeg` or `apt install ffmpeg`)
2. Check whisper-cpp: `whisper-cpp --help` (install: `brew install whisper-cpp` or build from source)
3. Download model: `curl -L -o ~/whisper-models/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin`
4. Save `VOICE_PROVIDER=local`, `WHISPER_BINARY`, `WHISPER_MODEL_PATH` to `.env`
5. Run `bun run test:voice` to verify

**Done when:** `bun run test:voice` passes.

---

## Phase 8: Google Chat (Optional, ~10 min)

Adds Google Chat as a second messaging channel alongside Telegram. The bot receives messages via webhook and responds in the same space/thread.

### Step 1: Create a Google Chat App

**What to tell the user:**
1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project (or select an existing one)
3. Enable the **Google Chat API** (APIs & Services > Library > search "Google Chat API")
4. Go to **Google Chat API > Configuration**:
   - App name: "Ellie" (or whatever they want)
   - Avatar URL: optional
   - Description: "Personal AI assistant"
   - Functionality: check "Receive 1:1 messages"
   - Connection settings: select **App URL**, set to `{PUBLIC_URL}/google-chat` (e.g., `https://ellie.ellie-labs.dev/google-chat`)
   - Visibility: "Specific people and groups" — add themselves
5. Save the configuration

### Step 2: Create a Service Account

**What to tell the user:**
1. In Google Cloud Console, go to **IAM & Admin > Service Accounts**
2. Click **Create Service Account**
   - Name: "ellie-chat-bot" (or any name)
   - Skip optional permissions
3. Click the new service account, go to **Keys** tab
4. Add Key > Create new key > JSON
5. Save the JSON file somewhere safe (e.g., `~/ellie-gchat-sa.json`)

**What you do:**
1. Save `GOOGLE_CHAT_SERVICE_ACCOUNT_KEY_PATH=/path/to/sa-key.json` to `.env`
2. Save `GOOGLE_CHAT_ALLOWED_EMAIL=user@gmail.com` to `.env`
3. Optionally set `GOOGLE_CHAT_SPACE_NAME=spaces/XXXXXXXXX` for work session notifications
   - The space name can be found after messaging the bot — check relay logs for `[gchat]` entries

### Step 3: Verify

1. Restart the relay: `systemctl --user restart claude-telegram-relay`
2. Check logs: `journalctl --user -u claude-telegram-relay -f`
3. Look for: `[gchat] Service account loaded: ...`
4. Open Google Chat, find the bot, send a test message
5. Confirm the bot responds

**Done when:** Google Chat messages get responses and relay logs show `[gchat]` activity.

---

## After Setup

Run the full health check:
```
bun run setup:verify
```

Summarize what was set up and what is running. Remind the user:
- Test by sending a message on Telegram
- Their bot runs in the background (if Phase 5 was done)
- Come back to this project folder and type `claude` anytime to make changes

---

# Work Session Dispatch Protocol

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

### When to Write

Write to the bridge on **significant learnings** — not every small step, but things future sessions would benefit from knowing:

- **Decisions** (`type: "decision"`) — architectural choices with reasoning ("Chose X over Y because Z")
- **Findings** (`type: "finding"`) — discoveries about the codebase, gotchas, patterns ("postgres.js sql.array() is for ANY(), not INSERTs")
- **Facts** (`type: "fact"`) — stable truths about the system ("Relay listens on port 3001, dashboard on 3000")
- **Hypotheses** (`type: "hypothesis"`) — educated guesses that need validation

### How to Write

```bash
curl -s -X POST http://localhost:3001/api/bridge/write \
  -H "x-bridge-key: bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Description of what was learned",
    "type": "decision",
    "scope_path": "2/1",
    "work_item_id": "ELLIE-177"
  }'
```

### Scope Paths

Pick the most specific scope that fits:

| Path | Name | Use for |
|------|------|---------|
| `2` | Projects | Cross-project knowledge |
| `2/1` | ellie-dev | Relay, agents, integrations |
| `2/2` | ellie-forest | Forest lib, DB, migrations |
| `2/3` | ellie-home | Dashboard, Nuxt, themes |
| `2/4` | ellie-os-app | Mobile/desktop app |

Sub-scopes exist under each project (e.g. `2/1/1` = agents, `2/1/2` = finance). Use `/api/bridge/scopes` to browse.

### How to Read (pull context before working)

```bash
# Semantic search
curl -s -X POST http://localhost:3001/api/bridge/read \
  -H "x-bridge-key: bk_d81869ef..." \
  -H "Content-Type: application/json" \
  -d '{"query": "how does the agent router work", "scope_path": "2/1"}'

# List recent memories in a scope
curl -s "http://localhost:3001/api/bridge/list?scope_path=2/1&limit=10" \
  -H "x-bridge-key: bk_d81869ef..."
```

### Guidelines

- Write **after** completing a task or making a decision, not while still exploring
- Keep content concise but self-contained — future sessions won't have your context
- Include `work_item_id` when the knowledge relates to a specific ticket
- Don't duplicate what's already in CLAUDE.md — the bridge is for dynamic knowledge

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

- **Relay:** `src/relay.ts` — Telegram bot + HTTP server + voice calls + Google Chat webhook
- **Google Chat:** `src/google-chat.ts` — Service account auth, message sending, webhook parsing
- **Memory:** `src/memory.ts` — Supabase-backed conversation history + semantic search
- **Agents:** `src/agent-router.ts` — multi-agent routing via Supabase edge functions
- **Skills:** `src/skills/` — SKILL.md loader, eligibility filter, prompt injection, slash commands (ELLIE-217)
- **Work Sessions:** `src/api/work-session.ts` — session lifecycle management (notifies Telegram + Google Chat)
- **Plane:** `src/plane.ts` — work item state sync
- **Voice:** Local Whisper transcription + ElevenLabs TTS streaming
- **Database:** Supabase (messages, memory, logs, work_sessions, agents)
- **Service:** systemd user service `claude-telegram-relay`

### Key Commands
```bash
systemctl --user restart claude-telegram-relay   # Restart relay
journalctl --user -u claude-telegram-relay       # View logs
bun run start                                     # Run manually
bun run test:telegram                             # Test Telegram
bun run test:supabase                             # Test database
```

---

## What Comes Next — The Full Version

This free relay covers the essentials. The full version unlocks:

- **6 Specialized AI Agents** — Research, Content, Finance, Strategy, Critic + General orchestrator. Route messages through Telegram forum topics. Run board meetings where all six weigh in.
- **VPS Deployment** — Your bot on a cloud server that never sleeps. Hybrid mode: free local processing when awake, paid API only when sleeping. $2-5/month.
- **Real Integrations** — Gmail, Google Calendar, Notion tasks connected via MCP. Smart check-ins pull real data, not patterns.
- **Human-in-the-Loop** — Claude takes actions (send email, update calendar) but asks first via inline Telegram buttons.
- **Voice & Phone Calls** — Bot speaks back via ElevenLabs. Calls you when something is urgent.
- **Fallback AI Models** — Auto-switch to OpenRouter or Ollama when Claude is down. Three layers of intelligence.
- **Production Infrastructure** — Auto-deploy from GitHub, watchdog monitoring, uninstall scripts, full health checks.

**Get the full course with video walkthroughs:**
- YouTube: youtube.com/@GodaGo (subscribe for tutorials)
- Community: skool.com/autonomee (full course, direct support, help personalizing for your business)

We also help you personalize the full version for your specific business and workflow. Or package it as a product you sell to your own clients.

The free version gives you a real, working AI assistant.
The full version gives you a personal AI infrastructure.

Build yours at the AI Productivity Hub.
