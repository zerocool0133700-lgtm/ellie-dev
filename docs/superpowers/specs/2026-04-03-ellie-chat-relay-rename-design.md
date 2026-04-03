# Ellie Chat Relay — Rename & Reframe Design

**Goal:** Rename "Claude Telegram Relay" to "Ellie Chat Relay" across all layers, flip the mental model so Ellie Chat (HTTP/WebSocket) is primary and messaging channels are adapters, and establish Ellie Chat as the first-class experience going forward.

**Approach:** One-cut deployment. Rename everything, update startup messaging, reframe docs, restart under new service name. No code restructuring — this is an identity and framing change, not an architecture refactor.

**Scope boundary:** This spec does NOT restructure relay.ts, move files into adapter directories, or change how channels are wired. Telegram still long-polls, Google Chat still uses webhooks, Ellie Chat still uses WebSocket. The code paths are untouched. A future spec can extract Telegram into a proper `src/channels/telegram/` adapter if warranted.

---

## Section 1: Identity Rename

Every layer that references "Claude Telegram Relay" gets renamed to "Ellie Chat Relay".

### Package Identity

- `package.json`: `"name": "claude-telegram-relay"` becomes `"name": "ellie-chat-relay"`
- No version bump needed — this is the same software with a new name

### Service Identity

- Rename `/home/ellie/.config/systemd/user/claude-telegram-relay.service` to `ellie-chat-relay.service`
- Update `Description=` from "Claude Telegram Relay" to "Ellie Chat Relay"
- Run `systemctl --user daemon-reload` after rename
- Stop old service, enable and start new service

### Source Code

- `src/relay.ts` startup log: "Starting Claude Telegram Relay..." becomes "Starting Ellie Chat Relay..."
- `src/relay.ts` file header comment: update to "Ellie Chat Relay — Entry Point"
- Logger child name `log.child("relay")` stays as-is — it's an internal context label, not user-facing

### Documentation

- `CLAUDE.md` title: "Claude Telegram Relay — Setup Guide" becomes "Ellie Chat Relay — Operations Guide"
- `README.md` title: "Claude Telegram Relay" becomes "Ellie Chat Relay"
- `README.md` tagline: updated to reflect Ellie Chat as primary

### What Does NOT Change

- Git remote stays `ellie-dev` — that's the repo name, not the package name
- File names (`relay.ts`, `telegram-handlers.ts`, `ellie-chat-handler.ts`) stay as-is
- Internal logger context stays `"relay"`
- No import paths change

---

## Section 2: Mental Model Flip — HTTP/WebSocket Primary

The startup sequence and documentation reframe to position Ellie Chat as the primary channel.

### Startup Order

Current order in relay.ts:
1. Config, directories, databases
2. HTTP server starts (infrastructure)
3. WebSocket servers start (infrastructure)
4. Telegram bot starts last → logs "Telegram bot is running!"

New order — same phases, different messaging:
1. Config, directories, databases (unchanged)
2. HTTP/WebSocket server starts → logs "Ellie Chat Relay is running on port {PORT}"
3. Channel adapters connect: Telegram → logs "Telegram adapter connected", Google Chat → logs "Google Chat adapter connected", etc.

The actual startup code order may not need to change — the HTTP server already starts before Telegram. The change is in the log messaging: Telegram is no longer announced as the climactic "we're live!" moment. The HTTP server is.

### Startup Log Summary

The final startup summary log currently says:
```
"All startup phases complete" with metrics
```

Updated to:
```
"Ellie Chat Relay ready" with { channels: ["ellie-chat", "telegram", "google-chat", ...], port: HTTP_PORT }
```

### What Does NOT Change

- No code restructuring of relay.ts
- No moving telegram-handlers.ts into src/channels/telegram/
- Telegram still uses long-polling via grammy
- Google Chat still uses webhook handlers
- The actual startup DAG and dependency order is untouched

---

## Section 3: Ellie Chat First-Class Declaration

A policy section added to the docs. No code changes.

### CLAUDE.md — New "Channel Priority" Section

Added near the top of CLAUDE.md, after the project description:

```markdown
## Channel Priority

Ellie Chat is the primary experience. Every feature, every agent interaction, every tool —
available in Ellie Chat without restriction. This is where the full rich experience lives:
dispatch container cards, the inquiry mechanism, real-time agent activity, the works.

**When building something new:**
1. Design for Ellie Chat first
2. Ask: "What's the Telegram-appropriate version?" second
3. Adapter channels (Google Chat, Discord, Slack) get what makes sense for their medium

**No feature should be Telegram-only.** If it exists in Telegram, it exists in Ellie Chat.
Telegram gets text summaries and inline buttons. Ellie Chat gets the full UI.
```

### README.md — Architecture Diagram

Current diagram:
```
You ──▶ Telegram ──▶ Relay ──▶ Claude Code CLI ──▶ Response
                            │
                      Supabase (memory)
```

Replaced with:
```
Ellie Chat (WebSocket) ──▶ Ellie Chat Relay ──▶ Agents ──▶ Response
                                  │
                           ┌──────┼──────┐
                           ▼      ▼      ▼
                       Telegram  GChat  Discord
                       (adapter) (adapter) (adapter)
```

---

## Section 4: CLAUDE.md Reframe

The CLAUDE.md file gets restructured from a setup tutorial to an operations guide.

### Current Structure

1. Title: "Claude Telegram Relay — Setup Guide"
2. "How This Works" (brief)
3. Phase 1-8: Step-by-step setup tutorial (Telegram bot, Supabase, personalize, test, always-on, proactive, voice, Google Chat)
4. "After Setup" section
5. Operational sections (Work Session Dispatch, Forest Bridge, Skills, Inter-Agent Communication, etc.)
6. "What Comes Next — The Full Version" (marketing/upsell)

### New Structure

1. Title: "Ellie Chat Relay — Operations Guide"
2. "What This Is" — Ellie's brain, an HTTP/WebSocket server powering Ellie Chat with adapters for Telegram, Google Chat, Discord, Slack
3. "Channel Priority" — The first-class declaration from Section 3
4. Operational sections (existing, unchanged):
   - Work Session Dispatch Protocol
   - Forest Bridge Protocol
   - Skills System
   - Inter-Agent Communication Protocol
   - Working Memory
   - River Vault
   - Agent MCP Access Matrix
   - SQL Migrations & Seeds
   - Testing
   - Key Commands
5. "Channel Adapters" section — setup instructions for Telegram, Google Chat, Voice, etc. (content from the old Phase 1-8, reformatted as reference rather than tutorial)
6. "UI Development Workflow" (existing, unchanged)
7. Remove "What Comes Next — The Full Version" marketing section entirely — this is a production system, not a product pitch

### Key Commands Update

The key commands section updates the service name:
```bash
systemctl --user restart ellie-chat-relay    # Restart relay
journalctl --user -u ellie-chat-relay        # View logs
```

---

## Deployment Steps

Single-cut deployment:

1. Make all code/doc changes
2. `systemctl --user stop claude-telegram-relay`
3. Copy service file to new name, remove old
4. `systemctl --user daemon-reload`
5. `systemctl --user enable ellie-chat-relay`
6. `systemctl --user start ellie-chat-relay`
7. Verify health: `curl http://localhost:3001/health`
8. Verify Telegram responds
9. Verify Ellie Chat responds
10. `systemctl --user disable claude-telegram-relay` (cleanup old enablement)

---

## Out of Scope

- Restructuring relay.ts or extracting Telegram into a channel adapter directory
- Moving files or changing import paths
- Changing how channels are wired (long-polling, webhooks, WebSocket)
- Adding new features to Ellie Chat
- Changing the git remote or repo name
- Renaming the `ellie-dev` directory
