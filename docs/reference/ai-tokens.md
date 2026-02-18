# AI Tokens & Credentials Reference

> Inventory of all AI-related API keys, tokens, and credentials across the ellie-dev and ellie-home codebases.
> **No actual secret values are stored in this document — only references.**

Last audited: 2026-02-17

---

## ellie-dev (Telegram Relay)

The relay is the central hub for all AI interactions. Most AI credentials live here.

### Anthropic (Claude API)

| Field | Value |
|-------|-------|
| **Env var** | `ANTHROPIC_API_KEY` |
| **Storage** | `.env` |
| **Used in** | `src/relay.ts`, `src/consolidate-inline.ts`, `src/summarize-backfill.ts` |
| **Purpose** | Direct API access for voice call responses, memory consolidation, backfill summarization |
| **Notes** | Cleared from env when spawning Claude CLI subprocess to prevent exposure. Models used: `claude-haiku-4-5-20251001` for consolidation. |

### OpenAI (Text Embeddings)

| Field | Value |
|-------|-------|
| **Env var** | `OPENAI_API_KEY` |
| **Storage** | Supabase Edge Function secrets (NOT in `.env`) |
| **Used in** | `supabase/functions/embed/index.ts`, `supabase/functions/search/index.ts` |
| **Purpose** | Generate vector embeddings for semantic search over conversations and memory |
| **Notes** | Model: `text-embedding-3-small`. Triggered automatically via database webhooks on INSERT to `messages` and `memory` tables. Managed in Supabase dashboard > Edge Functions > Secrets. |

### Groq (Voice Transcription)

| Field | Value |
|-------|-------|
| **Env vars** | `GROQ_API_KEY`, `VOICE_PROVIDER=groq` |
| **Storage** | `.env` |
| **Used in** | `src/transcribe.ts` |
| **Purpose** | Cloud-based Whisper speech-to-text for voice messages |
| **Notes** | Optional — alternative is local whisper.cpp (`VOICE_PROVIDER=local`). Model: `whisper-large-v3-turbo`. Free tier: 2,000 transcriptions/day. |

### ElevenLabs (Text-to-Speech)

| Field | Value |
|-------|-------|
| **Env vars** | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` |
| **Storage** | `.env` |
| **Used in** | `src/relay.ts`, `src/voice-call.ts` |
| **Purpose** | Voice synthesis for phone/voice calls — streams audio via Twilio WebSocket |
| **Notes** | Default voice ID: `EXAVITQu4vr4xnSDxMaL`. Format: ulaw_8000. |

### Twilio (Voice Infrastructure)

| Field | Value |
|-------|-------|
| **Env vars** | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `DAVE_PHONE_NUMBER` |
| **Storage** | `.env` |
| **Used in** | `src/voice-call.ts` |
| **Purpose** | Phone call infrastructure — initiate calls, WebSocket media streaming |

### Google Chat (OAuth / Service Account)

| Field | Value |
|-------|-------|
| **Env vars (OAuth)** | `GOOGLE_CHAT_OAUTH_CLIENT_ID`, `GOOGLE_CHAT_OAUTH_CLIENT_SECRET`, `GOOGLE_CHAT_OAUTH_REFRESH_TOKEN` |
| **Env vars (SA)** | `GOOGLE_CHAT_SERVICE_ACCOUNT_KEY_PATH`, `GOOGLE_CHAT_ALLOWED_EMAIL` |
| **Storage** | `.env` + JSON key files in `config/` |
| **Used in** | `src/google-chat.ts`, `src/relay.ts` |
| **Purpose** | Second messaging channel — receive/send Google Chat messages |
| **Notes** | Two auth methods available (OAuth preferred). Service account JSON files in `config/` directory. |

### Telegram Bot

| Field | Value |
|-------|-------|
| **Env vars** | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_USER_ID` |
| **Storage** | `.env` |
| **Used in** | `src/relay.ts` |
| **Purpose** | Primary messaging channel — receive messages, send responses, handle voice files |

### Supabase (Database)

| Field | Value |
|-------|-------|
| **Project name** | `ellie-home-db` |
| **Project ID** | `tzugbqcbuxbzjgnufell` |
| **Region** | us-west-2 |
| **Env vars** | `SUPABASE_URL`, `SUPABASE_ANON_KEY` |
| **Storage** | `.env` |
| **Used in** | `src/relay.ts`, all Edge Functions |
| **Purpose** | Persistent storage — conversations, memory, logs, work sessions, agents |
| **Notes** | `SUPABASE_SERVICE_ROLE_KEY` is auto-injected into Edge Functions by Supabase runtime — never in `.env`. Anon key is public-tier (RLS enforced). |

### Plane (Project Management)

| Field | Value |
|-------|-------|
| **Env vars** | `PLANE_API_KEY`, `PLANE_BASE_URL`, `PLANE_WORKSPACE_SLUG` |
| **Storage** | `.env` |
| **Used in** | `src/plane.ts` |
| **Purpose** | Work item tracking — fetch issues, update state, add comments |
| **Notes** | Defaults: base URL `https://plane.ellie-labs.dev`, workspace `evelife`. |

### Elasticsearch (Optional)

| Field | Value |
|-------|-------|
| **Env var** | `ELASTICSEARCH_URL` |
| **Storage** | `.env` |
| **Used in** | `src/elasticsearch.ts` |
| **Purpose** | Full-text search augmenting Supabase vector search |
| **Notes** | Optional — bot degrades gracefully if unavailable. |

### Local Whisper (Offline Alternative)

| Field | Value |
|-------|-------|
| **Env vars** | `VOICE_PROVIDER=local`, `WHISPER_BINARY`, `WHISPER_MODEL_PATH` |
| **Storage** | `.env` |
| **Used in** | `src/transcribe.ts` |
| **Purpose** | Offline speech-to-text — no API key needed |
| **Notes** | Requires ffmpeg + whisper-cpp. Model file: `~/whisper-models/ggml-base.en.bin` (142MB). |

---

## ellie-home (Dashboard)

The dashboard does NOT directly call AI APIs. It proxies through the relay service.

### Supabase

| Field | Value |
|-------|-------|
| **Project** | `ellie-home-db` (ID: `tzugbqcbuxbzjgnufell`) — same as relay |
| **Env vars** | `SUPABASE_URL`, `SUPABASE_ANON_KEY` |
| **Storage** | `.env` |
| **Used in** | `server/utils/supabase.ts` |
| **Purpose** | Read conversations, memory, work sessions, logs for dashboard display |

### Plane API

| Field | Value |
|-------|-------|
| **Env vars** | `PLANE_API_KEY`, `PLANE_BASE_URL`, `PLANE_WORKSPACE_SLUG` |
| **Storage** | `.env` |
| **Used in** | `server/utils/plane.ts`, `server/api/plane/issues.ts`, `nuxt.config.ts` |
| **Purpose** | Fetch work items and states for dashboard display |

### Relay Service

| Field | Value |
|-------|-------|
| **Env var** | `RELAY_URL` |
| **Storage** | `.env` |
| **Used in** | `server/api/actions/trigger-agent.post.ts`, `server/api/system.ts`, `server/api/actions/close-conversation.post.ts` |
| **Purpose** | Trigger agents, health checks, conversation consolidation via the relay |
| **Notes** | Default: `http://localhost:3001`. No authentication on local connection. |

### PostgreSQL (Local)

| Field | Value |
|-------|-------|
| **Env var** | `DATABASE_URL` |
| **Storage** | `.env` |
| **Used in** | `server/db/index.ts`, `drizzle.config.ts` |
| **Purpose** | Dashboard-specific data (projects, goals, activity logs, bot health) |
| **Notes** | Uses Unix socket at `/var/run/postgresql`. User: `ellie`. |

---

## Security Summary

| Practice | Status |
|----------|--------|
| No hardcoded secrets in source | Yes |
| `.env` files in `.gitignore` | Yes |
| OpenAI key isolated in Supabase secrets | Yes |
| Supabase service role key never in `.env` | Yes |
| Anthropic key cleared when spawning CLI | Yes |
| RLS enabled on all Supabase tables | Yes |
| Cloudflare tunnel guards non-webhook endpoints (ellie-home) | Yes |
| Google SA key files in `config/` (not committed) | Yes |

---

## Quick Reference: All Env Vars

### ellie-dev `.env`

```
ANTHROPIC_API_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_USER_ID=
SUPABASE_URL=
SUPABASE_ANON_KEY=
GROQ_API_KEY=
VOICE_PROVIDER=groq
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
DAVE_PHONE_NUMBER=
GOOGLE_CHAT_OAUTH_CLIENT_ID=
GOOGLE_CHAT_OAUTH_CLIENT_SECRET=
GOOGLE_CHAT_OAUTH_REFRESH_TOKEN=
GOOGLE_CHAT_SERVICE_ACCOUNT_KEY_PATH=
GOOGLE_CHAT_ALLOWED_EMAIL=
PLANE_API_KEY=
PLANE_BASE_URL=
PLANE_WORKSPACE_SLUG=
ELASTICSEARCH_URL=
```

### ellie-home `.env`

```
DATABASE_URL=
SUPABASE_URL=
SUPABASE_ANON_KEY=
PLANE_API_KEY=
PLANE_BASE_URL=
PLANE_WORKSPACE_SLUG=
RELAY_URL=
```

### Supabase Edge Function Secrets (dashboard-managed)

```
OPENAI_API_KEY=
```
