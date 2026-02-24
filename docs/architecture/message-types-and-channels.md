# Message Types & Channels — Complete Inventory

All outbound message types Ellie produces, organized by channel, with intended purpose and delivery patterns.

---

## Channel Overview

| Channel | Transport | Primary Use |
|---------|-----------|-------------|
| **Telegram** | Bot API (Telegraf) | Core conversational AI, approvals, notifications |
| **Google Chat** | REST API (OAuth/SA) | Team collaboration, threaded work session tracking |
| **Ellie Chat** | WebSocket | Phone-mode quick queries, mobile-friendly sessions |
| **Voice/Twilio** | WebSocket (audio) | Real-time voice calls with streaming TTS |
| **Work Session API** | REST + notify() | Work item lifecycle events, cross-channel notifications |
| **Extension** | WebSocket broadcast | Dashboard/UI real-time event feed |

---

## 1. Telegram

**Source:** `src/relay.ts`

| Message Type | Method | Purpose |
|---|---|---|
| **Text Response** | `ctx.reply(text, {parse_mode: "Markdown"})` | Direct answers to user messages. Markdown-formatted. |
| **Chunked Response** | `ctx.reply(chunk)` in loop | Long responses (>4000 chars) split at paragraph breaks, then line breaks, then spaces. Each chunk sent as separate message. |
| **Voice Reply** | `ctx.replyWithVoice({source: oggBuffer})` | OGG/Opus audio response to voice input. Used when user sends a voice message and TTS is enabled. |
| **Document/File** | `ctx.replyWithDocument(source, opts)` | Share files, exports, logs, or work products. Includes caption for context. |
| **Typing Indicator** | `ctx.replyWithChatAction("typing")` | UX feedback while agent is processing. Signals "thinking" to the user. |
| **Approval Dialog** | `ctx.reply(text, {reply_markup: InlineKeyboard})` | Inline buttons for confirmations (Approve/Deny). Used by [CONFIRM:] protocol for destructive or external actions. |
| **Direct Notification** | `bot.api.sendMessage(userId, text, opts)` | Proactive messages outside user context — session starts, completions, scheduled alerts. Uses TELEGRAM_USER_ID directly. |

**Markdown Escaping:** Special chars escaped via `.replace(/[_*[\]()~>#+=|{}.!-]/g, '\\$&')` for MarkdownV2 compatibility.

**Splitting Logic:** Messages >4000 chars split at `\n\n` → `\n` → ` ` (space), each chunk sent separately.

---

## 2. Google Chat

**Source:** `src/google-chat.ts`

| Message Type | Method | Purpose |
|---|---|---|
| **Text Message** | `sendGoogleChatMessage(spaceName, text)` | Standard response to a message in a Chat space. Plain text or markdown. |
| **Threaded Reply** | `sendGoogleChatMessage(spaceName, text, threadName)` | Reply within an existing thread. Keeps related updates grouped (e.g., all work session updates in one thread). |
| **Chunked Message** | `sendGoogleChatMessage()` loop | Long messages (>4000 chars) split and sent as sequential messages in the same thread. |

**Auth:** OAuth 2.0 (preferred, uses refresh token) with Service Account JWT fallback. Token cached with 5-minute expiration buffer.

**Splitting Logic:** Same as Telegram — >4000 chars split at `\n\n` → `\n` → ` `.

**Thread Strategy:** Work session events (start, update, decision, complete) all thread under the same `threadName` so the full session history stays grouped.

---

## 3. Ellie Chat (WebSocket)

**Source:** `src/relay.ts` (lines ~4158–4489)

| Message Type | Payload | Purpose |
|---|---|---|
| **Response** | `{type: "response", text, agent, ts, duration_ms}` | Final agent answer delivered to the client. Includes which agent responded and how long it took. |
| **Typing Indicator** | `{type: "typing", ts}` | Shows agent is processing. Client renders a "thinking" animation. |
| **Multi-Step Work** | `{type: "response", text: "Working on..."}` then completion | Intermediate progress for complex tasks, followed by final response. |
| **Ping/Pong** | `"ping"` / `"pong"` | WebSocket keepalive on 30-second interval. Prevents connection timeout. |

**Phone Mode Optimizations:**
- 6-turn context window (not full history)
- Haiku model for speed
- Brevity prompt keeps responses short
- No multi-agent routing — direct response only

---

## 4. Voice / Twilio (WebSocket Audio)

**Source:** `src/relay.ts` (lines ~1950–2100)

| Message Type | Payload | Purpose |
|---|---|---|
| **Audio Chunk** | `{event: "media", streamSid, media: {payload: base64}}` | TTS audio streamed to caller in ~400ms chunks. mulaw 8kHz format (ulaw_8000) via ElevenLabs. |
| **Clear Buffer** | `{event: "clear", streamSid}` | Clears pending audio in Twilio's buffer. Used when interrupting playback (e.g., user starts speaking). |
| **Mark/Completion** | `{event: "mark", streamSid, mark: {name}}` | Signals a playback marker to Twilio. Used to detect when audio finishes playing. |

**Voice Flow:** Twilio audio in → Whisper transcription → Claude agent → ElevenLabs TTS → mulaw chunks → Twilio out.

---

## 5. Work Session API

**Source:** `src/api/work-session.ts`

These endpoints manage the lifecycle of work items and broadcast notifications to Telegram + Google Chat via the unified `notify()` policy engine.

| Endpoint | Response | Notifications Sent | Purpose |
|---|---|---|---|
| `POST /start` | `{session_id, tree_id, branches, creatures}` | Telegram + Google Chat (new thread) | Announces work session beginning. Creates forest tree/branch. |
| `POST /update` | `{session_id}` | Google Chat (threaded) + forest update | Logs a milestone or progress note. Keeps thread updated. |
| `POST /decision` | `{session_id, decision_logged}` | Telegram + Google Chat | Records an architectural decision with reasoning and alternatives. |
| `POST /complete` | `{session_id, summary, duration_minutes}` | Telegram + Google Chat | Summarizes what was accomplished. Updates Plane to Done. |
| `POST /pause` | `{session_id, paused: true}` | Telegram + Google Chat | Pauses work with optional reason. |
| `POST /resume` | `{session_id, resumed: true}` | Telegram + Google Chat | Resumes paused session. Restores forest tree state. |

**Notification Policy:** All endpoints route through `notify(context, eventType, data)` which checks throttling rules (prevents duplicate notifications for same event on same work_item within cooldown).

---

## 6. Extension (Dashboard WebSocket)

**Source:** `src/relay.ts` (lines ~4084–4152, 4491–4500)

| Event Type | Payload | Purpose |
|---|---|---|
| `message_in` | `{text, agent, ts}` | User message received — allows dashboard to show live conversation. |
| `message_out` | `{text, agent, ts}` | Agent response sent — mirrors output to dashboard. |
| `route` | `{route, reasons}` | Agent routing decision — shows which agent was selected and why. |
| `pipeline_start` | `{step, params}` | Processing step begun — tracks orchestration pipeline progress. |
| `pipeline_complete` | `{step, result, duration_ms}` | Processing step finished — includes timing for performance visibility. |
| `queue_status` | `{pending, active}` | Queue depth change — shows system load. |
| `error` | `{error, context}` | Exception occurred — surfaces errors to dashboard for debugging. |

**Auth:** 5-second auth timeout — client must send `{auth: token}` within 5 seconds of connection or gets disconnected.

**Broadcast:** All events sent to every connected extension client via `broadcastExtension(type, data)`.

---

## Cross-Channel Patterns

### Delivery with Fallback (`src/delivery.ts`)

| Flow | Primary | Fallback | Behavior |
|---|---|---|---|
| Standard | Configured channel | Retry 3x (exponential backoff) | Normal delivery |
| Cross-channel | Telegram | Google Chat | If primary fails, try secondary |
| Cross-channel | Google Chat | Telegram | If primary fails, try secondary |

Fallback messages are prefixed with channel origin: `[From Google Chat] ...`

### Message Splitting (shared logic)

All text channels use the same splitting algorithm for messages exceeding their limit (4000 chars for Telegram and Google Chat):

1. Split at paragraph breaks (`\n\n`)
2. If still too long, split at line breaks (`\n`)
3. If still too long, split at spaces (` `)

### Notification Routing (`src/notification-policy.ts`)

Central `notify()` function routes all system notifications:

```
notify(context, eventType, data)
  ├─ Check throttling (by work_item_id)
  ├─ Route to Telegram (bot.api.sendMessage)
  └─ Route to Google Chat (if gchatSpaceName configured, threaded)
```

Event types: `session_start`, `session_update`, `session_decision`, `session_complete`, `dispatch_confirm`, `session_pause`, `session_resume`.

---

## Authentication Summary

| Channel | Method | Details |
|---|---|---|
| Telegram | Bot token | `TELEGRAM_BOT_TOKEN` env var, passed to Telegraf |
| Google Chat | OAuth 2.0 (primary) | refresh_token → access_token via Google OAuth endpoint |
| Google Chat | Service Account JWT (fallback) | private_key → JWT → access_token via token_uri |
| LA Comms | WebSocket session | Implicit auth via HTTP layer |
| Voice/Twilio | WebSocket session | Implicit auth via Twilio connection |
| Extension | Custom token | 5-second auth window, expects `{auth: token}` message |
