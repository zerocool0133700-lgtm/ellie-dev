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
