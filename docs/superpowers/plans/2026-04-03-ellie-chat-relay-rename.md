# Ellie Chat Relay Rename & Reframe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename "Claude Telegram Relay" to "Ellie Chat Relay" across all layers, flip the mental model to HTTP/WebSocket-primary, reframe CLAUDE.md as an operations guide, and establish Ellie Chat as the first-class experience.

**Architecture:** One-cut deployment. All renames, doc restructuring, and startup message changes happen together. The old systemd service is stopped and replaced with a new one. No code restructuring — file names, imports, and channel wiring stay as-is.

**Tech Stack:** Bun, TypeScript, systemd, markdown

**Spec:** `docs/superpowers/specs/2026-04-03-ellie-chat-relay-rename-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `package.json` | Modify | Package name rename |
| `src/relay.ts` | Modify | File header comment + 3 startup log messages |
| `README.md` | Rewrite | New identity, architecture diagram, project description |
| `CLAUDE.md` | Rewrite | Operations guide with channel priority, restructured sections |
| `~/.config/systemd/user/ellie-chat-relay.service` | Create | New systemd service file |
| `~/.config/systemd/user/claude-telegram-relay.service` | Delete | Old service file (after cutover) |

---

### Task 1: Rename package.json

**Files:**
- Modify: `package.json:2`

- [ ] **Step 1: Update the package name**

In `/home/ellie/ellie-dev/package.json`, change line 2:

```json
  "name": "ellie-chat-relay",
```

- [ ] **Step 2: Commit**

```bash
cd /home/ellie/ellie-dev
git add package.json
git commit -m "[RENAME] package: claude-telegram-relay → ellie-chat-relay"
```

---

### Task 2: Update relay.ts startup messages

**Files:**
- Modify: `src/relay.ts:1-5, 436, 481, 501-505`

- [ ] **Step 1: Update the file header comment**

Change lines 1-2 of `src/relay.ts` from:

```typescript
/**
 * Claude Code Telegram Relay — Entry Point
```

To:

```typescript
/**
 * Ellie Chat Relay — Entry Point
```

- [ ] **Step 2: Update the startup log message**

Change line 436 from:

```typescript
logger.info("Starting Claude Telegram Relay...", {
```

To:

```typescript
logger.info("Starting Ellie Chat Relay...", {
```

- [ ] **Step 3: Update the bot start completion messages**

Change lines 501-505 from:

```typescript
    logger.info("Telegram bot is running!");
    logger.info("All startup phases complete", {
      phases: _phaseTimings.length,
      totalMs,
    });
```

To:

```typescript
    logger.info("Telegram adapter connected");
    logger.info("Ellie Chat Relay ready", {
      phases: _phaseTimings.length,
      totalMs,
      channels: ["ellie-chat", gchatEnabled ? "google-chat" : null, "telegram"].filter(Boolean),
      port: HTTP_PORT,
    });
```

- [ ] **Step 4: Update the HTTP listen log to emphasize it's the primary server**

Change line 481 from:

```typescript
  logger.info("Server listening", { host: BIND_HOST, port: HTTP_PORT });
```

To:

```typescript
  logger.info("Ellie Chat Relay listening", { host: BIND_HOST, port: HTTP_PORT });
```

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/relay.ts
git commit -m "[RENAME] relay.ts: update header and startup messages to Ellie Chat Relay"
```

---

### Task 3: Rewrite README.md

**Files:**
- Modify: `README.md` (full rewrite)

- [ ] **Step 1: Rewrite the README**

Replace the entire contents of `/home/ellie/ellie-dev/README.md` with:

```markdown
# Ellie Chat Relay

Ellie's brain — an HTTP/WebSocket server that powers Ellie Chat and adapts to messaging channels.

```
Ellie Chat (WebSocket) ──▶ Ellie Chat Relay ──▶ Agents ──▶ Response
                                  │
                           ┌──────┼──────┐
                           ▼      ▼      ▼
                       Telegram  GChat  Discord
                       (adapter) (adapter) (adapter)
```

## What This Is

The Ellie Chat Relay is the core server for Ellie OS. It:

- **Runs the coordinator loop** — Max routes, Ellie delivers, specialists do the work
- **Manages 8 agents** — James (dev), Kate (research), Alan (strategy), Brian (critic), Jason (ops), Amy (content), Marcus (finance), Ellie (partner)
- **Connects to channels** — Ellie Chat (primary, WebSocket), Telegram, Google Chat, Discord, Slack
- **Persists knowledge** — Forest (local Postgres), Supabase (cloud), Elasticsearch (search), River (Obsidian vault)
- **Handles voice** — Groq Whisper transcription, ElevenLabs TTS
- **Runs skills** — 47 skill modules loaded from `skills/*/SKILL.md`

## Running

```bash
bun run start                    # Start the relay
bun run dev                      # Start with auto-reload
bun test                         # Run all tests
systemctl --user restart ellie-chat-relay   # Restart the service
journalctl --user -u ellie-chat-relay       # View logs
```

## Channel Priority

Ellie Chat is the primary experience. Every feature, every agent interaction, every tool — available in Ellie Chat without restriction.

New features target Ellie Chat first. Telegram gets a simplified version appropriate for the medium. Adapter channels get what makes sense for their medium.

## Documentation

- `CLAUDE.md` — Operations guide (agent instructions, protocols, architecture)
- `docs/architecture/` — Schema, forest maps, system design
- `skills/` — Agent skill definitions (`SKILL.md` files)

## License

MIT
```

- [ ] **Step 2: Commit**

```bash
cd /home/ellie/ellie-dev
git add README.md
git commit -m "[RENAME] README: rewrite for Ellie Chat Relay identity"
```

---

### Task 4: Rewrite CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (restructure)
- Create: `docs/setup-guide.md` (tutorial content preserved)

This is the largest task. The CLAUDE.md gets restructured from a setup tutorial to an operations guide. The tutorial content is preserved in a separate file.

- [ ] **Step 1: Extract the setup tutorial to docs/setup-guide.md**

Create `/home/ellie/ellie-dev/docs/setup-guide.md` containing the content from lines 1-291 of the current CLAUDE.md (everything from the title through "## After Setup" including the verify command). Prepend it with:

```markdown
# Ellie Chat Relay — Setup Guide

> This guide is for first-time setup of a new relay instance. For day-to-day operations, see `CLAUDE.md`.

---
```

Then paste the setup phases content (Phase 1 through Phase 8, plus "After Setup"), updating all references from "Claude Telegram Relay" to "Ellie Chat Relay".

- [ ] **Step 2: Rewrite the CLAUDE.md header and opening**

Replace lines 1-16 of `CLAUDE.md` (the title, intro paragraph, and first `---`) with:

```markdown
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
```

- [ ] **Step 3: Remove the Phase 1-8 tutorial sections and "How This Works" section**

Delete the following sections from CLAUDE.md (lines 6-291 in the original):
- "## How This Works" (lines 6-16)
- "## Phase 1: Telegram Bot" through "## Phase 8: Google Chat" (lines 18-277)
- "## After Setup" (lines 280-291)

These are now in `docs/setup-guide.md`.

Replace them with a single reference:

```markdown
## First-Time Setup

For setting up a new relay instance from scratch, see [docs/setup-guide.md](docs/setup-guide.md).

---
```

- [ ] **Step 4: Remove "What Comes Next — The Full Version" section**

Delete the "## What Comes Next — The Full Version" section (line 981 to end of file). This is marketing copy that doesn't belong in an operations guide for a production system.

- [ ] **Step 5: Update the Work Session Dispatch Protocol header**

The section at line 294 currently reads:

```markdown
# Work Session Dispatch Protocol
```

Change to:

```markdown
## Work Session Dispatch Protocol
```

(Demote from H1 to H2 to fit the new single-document structure.)

- [ ] **Step 6: Update key commands section**

Find the "### Key Commands" section and update the service name references:

```bash
systemctl --user restart ellie-chat-relay   # Restart relay
journalctl --user -u ellie-chat-relay       # View logs
```

- [ ] **Step 7: Add a Channel Adapters reference section**

After the "## First-Time Setup" reference, add:

```markdown
## Channel Adapters

The relay connects to multiple messaging channels. Each is optional and configured via environment variables.

| Channel | Type | Config Required | Handler |
|---------|------|----------------|---------|
| **Ellie Chat** | WebSocket (primary) | Always on | `src/ellie-chat-handler.ts` |
| **Telegram** | Long-polling adapter | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_USER_ID` | `src/telegram-handlers.ts` |
| **Google Chat** | Webhook adapter | `GOOGLE_CHAT_SERVICE_ACCOUNT_KEY_PATH` | `src/google-chat.ts` |
| **Discord** | Bot adapter | `DISCORD_BOT_TOKEN` | `src/channels/discord/` |
| **Slack** | Bot adapter | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` | `src/channels/slack/` |

For detailed channel setup instructions, see [docs/setup-guide.md](docs/setup-guide.md).

---
```

- [ ] **Step 8: Verify CLAUDE.md structure**

The final CLAUDE.md should have this structure (H1 and H2 headings):

```
# Ellie Chat Relay — Operations Guide
## What This Is
## Channel Priority
## First-Time Setup
## Channel Adapters
## Work Session Dispatch Protocol
  ## Session Startup
  ## During Work
  ## Session Complete
  ## Git Workflow
## UI Development Workflow
## Plane Reference
## Relay API Reference
## Forest Bridge Protocol
## Skills System (ELLIE-217)
## Project Architecture
  (all existing subsections unchanged)
```

- [ ] **Step 9: Commit**

```bash
cd /home/ellie/ellie-dev
git add CLAUDE.md docs/setup-guide.md
git commit -m "[RENAME] CLAUDE.md: restructure as operations guide, extract setup tutorial"
```

---

### Task 5: Create new systemd service and cut over

**Files:**
- Create: `~/.config/systemd/user/ellie-chat-relay.service`
- Delete: `~/.config/systemd/user/claude-telegram-relay.service`

- [ ] **Step 1: Create the new service file**

Create `/home/ellie/.config/systemd/user/ellie-chat-relay.service`:

```ini
[Unit]
Description=Ellie Chat Relay
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/ellie/ellie-dev
ExecStart=/home/ellie/.bun/bin/bun run src/relay.ts
Restart=on-failure
RestartSec=5
Environment=PATH=/home/ellie/.bun/bin:/home/ellie/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=/home/ellie

# Memory protection — prevent OOM killer from targeting relay
OOMScoreAdjust=0
MemoryMax=8G
OOMPolicy=stop

# Security hardening (audit findings)
PrivateTmp=true
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/home/ellie/ellie-dev /home/ellie/ellie-forest /home/ellie/ellie-home /home/ellie/obsidian-vault /home/ellie/.claude /home/ellie/.config /tmp

[Install]
WantedBy=default.target
```

- [ ] **Step 2: Stop the old service**

```bash
systemctl --user stop claude-telegram-relay
```

- [ ] **Step 3: Reload systemd, enable and start new service**

```bash
systemctl --user daemon-reload
systemctl --user enable ellie-chat-relay
systemctl --user start ellie-chat-relay
```

- [ ] **Step 4: Verify the new service is running**

```bash
systemctl --user status ellie-chat-relay
```

Expected: Active (running)

```bash
curl -s http://localhost:3001/health | python3 -c "import sys,json; d=json.load(sys.stdin); print('Status:', d['status'])"
```

Expected: `Status: ok`

- [ ] **Step 5: Verify startup logs show new name**

```bash
journalctl --user -u ellie-chat-relay --since "1 min ago" | grep -i "ellie chat relay"
```

Expected: "Starting Ellie Chat Relay..." and "Ellie Chat Relay ready" in the logs.

- [ ] **Step 6: Disable and remove old service**

```bash
systemctl --user disable claude-telegram-relay
rm ~/.config/systemd/user/claude-telegram-relay.service
systemctl --user daemon-reload
```

- [ ] **Step 7: Verify Telegram still works**

Send a test message via Telegram. Expected: Ellie responds normally.

- [ ] **Step 8: Verify Ellie Chat still works**

Open the dashboard at dashboard.ellie-labs.dev and send a message. Expected: Ellie responds normally.

- [ ] **Step 9: Commit the plan doc**

```bash
cd /home/ellie/ellie-dev
git add docs/superpowers/plans/2026-04-03-ellie-chat-relay-rename.md
git commit -m "[RENAME] complete: Ellie Chat Relay rename and reframe"
```

---

### Task 6: Update global CLAUDE.md references

**Files:**
- Modify: `/home/ellie/.claude/CLAUDE.md`

- [ ] **Step 1: Update service name in global instructions**

In `/home/ellie/.claude/CLAUDE.md`, search for `claude-telegram-relay` and replace with `ellie-chat-relay`. This appears in:
- The ellie-dev stack description: `systemctl --user restart claude-telegram-relay`
- Any other references to the service name

- [ ] **Step 2: Commit**

The global CLAUDE.md is not in a git repo — this is a file edit only, no commit needed.

---

### Task 7: Update project memory

**Files:**
- Modify: `/home/ellie/.claude/projects/-home-ellie/memory/MEMORY.md`

- [ ] **Step 1: Update memory references**

In the project memory MEMORY.md, update:
- "Service: `systemctl --user restart claude-telegram-relay`" → "Service: `systemctl --user restart ellie-chat-relay`"
- Any other references to the old service name

- [ ] **Step 2: No commit needed**

Memory files are managed by the memory system, not git.
