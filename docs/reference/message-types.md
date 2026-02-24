# Ellie Message Types Reference

All outbound messages produced by the relay, grouped by channel.

---

## Telegram

| # | Type | Mechanism | Purpose |
|---|------|-----------|---------|
| 1 | **Queue position** | `ctx.reply()` | "I'm working on something — I'll get to this next. (Queue position: N)" |
| 2 | **Typing indicator** | `ctx.replyWithChatAction("typing")` | Show processing status, sent every 4s during Claude execution |
| 3 | **Slash command responses** | `ctx.reply()` / `sendResponse()` | Direct responses to `/search`, `/forest-metrics`, `/help` — bypass Claude |
| 4 | **Authorization rejection** | `ctx.reply()` | "This bot is private." for unauthorized users |
| 5 | **Voice not configured** | `ctx.reply()` | "Voice transcription is not set up yet..." |
| 6 | **Voice transcription failed** | `ctx.reply()` | "Could not transcribe voice message." |
| 7 | **Multi-step execution start** | `ctx.reply()` | "Pipeline: research_agent -> strategy_agent (3 steps)" |
| 8 | **Agent handoff** | `ctx.reply()` | "Handing off to another agent..." |
| 9 | **Voice pipeline fallback** | `ctx.reply()` | "Multi-step execution failed -- processing as single request." |
| 10 | **Voice processing error** | `ctx.reply()` | "Could not process voice message. Check logs for details." |
| 11 | **Image processing error** | `ctx.reply()` | "Could not process image." |
| 12 | **Document processing error** | `ctx.reply()` | "Could not process document." |
| 13 | **Approval request** | `ctx.reply()` + inline keyboard | Message with [Approve] [Deny] buttons for sensitive actions |
| 14 | **Approval confirmed** | `ctx.editMessageText()` | "Approved: {action}" — edits original message |
| 15 | **Denial confirmed** | `ctx.editMessageText()` | "Denied: {action}" — edits original message |
| 16 | **Standard response** | `sendResponse()` | Claude's response, chunked at 4000 chars |
| 17 | **Long response + file** | `ctx.reply()` + `ctx.replyWithDocument()` | Truncated preview + full output as file attachment (>8000 chars) |
| 18 | **Dispatch confirmation** | `notify()` | "dev agent" — routed via notification policy |
| 19 | **Timeout error** | `notify()` | "Task timed out after Ns" — critical priority |
| 20 | **SIGTERM error** | `notify()` | "Process interrupted (SIGTERM)" — critical priority |
| 21 | **Unexpected exit error** | `notify()` | "Claude exited with code N" — critical priority |
| 22 | **Delivery nudge** | `bot.api.sendMessage()` | "Hey Dave -- I sent you a response a few minutes ago. Did it come through?" |
| 23 | **Idle consolidation** | Internal | Silent — consolidates memory after 10 min silence |

---

## Google Chat

| # | Type | Mechanism | Purpose |
|---|------|-----------|---------|
| 1 | **Dispatch confirmation** | `notify()` | Agent routing notification via policy engine |
| 2 | **Timeout error** | `notify()` | Critical alert with partial output |
| 3 | **SIGTERM error** | `notify()` | Critical alert with exit context |
| 4 | **Unexpected exit error** | `notify()` | Critical alert with exit code |
| 5 | **Async Claude response** | `sendGoogleChatMessage()` | Standard response delivered asynchronously |
| 6 | **Approval card** | `sendGoogleChatMessage()` (card) | Card with approve/deny buttons |
| 7 | **Approval result card** | `sendGoogleChatMessage()` (card update) | Updated card: "Action Approved" / "Action Denied" / "Action Expired" |
| 8 | **Approval follow-up** | `sendGoogleChatMessage()` | Claude's response after approval processing |
| 9 | **Approval error** | `sendGoogleChatMessage()` | "Sorry, I ran into an error processing that approval." |
| 10 | **Delivery nudge** | `sendGoogleChatMessage()` | Same as Telegram nudge, sent to Google Chat space |
| 11 | **Idle consolidation** | Internal | Silent — consolidates memory after 10 min silence |

---

## Ellie Chat (Dashboard WebSocket)

| # | Type | Payload `type` | Purpose |
|---|------|----------------|---------|
| 1 | **Auth confirmation** | `auth_ok` | Confirm client authenticated |
| 2 | **Keepalive ping** | `ping` | Keep WebSocket alive |
| 3 | **Typing indicator** | `typing` | Show processing status |
| 4 | **Standard response** | `response` | Claude's response text |
| 5 | **Pipeline start notice** | `response` | "Working on it... (Pipeline: agents, steps)" |
| 6 | **Pipeline result** | `response` | Orchestrator's combined response |
| 7 | **Pipeline error** | `response` | "Error: {message}" |

---

## Extension/Dashboard (WebSocket Broadcasts)

Metadata events broadcast to all connected extension clients via `broadcastExtension()`.

| # | Payload `type` | Fields | Purpose |
|---|----------------|--------|---------|
| 1 | `auth_ok` | `ts` | Confirm client authenticated |
| 2 | `ping` | `ts` | Connection keepalive |
| 3 | `queue_status` | `busy`, `queueLength`, `current` | Queue state changes |
| 4 | `message_in` | `channel`, `preview` | Incoming message on any channel |
| 5 | `message_out` | `channel`, `agent`, `preview` | Outgoing response on any channel |
| 6 | `route` | `channel`, `agent`, `mode`, `confidence` | Agent routing decision |
| 7 | `pipeline_start` | `channel`, `mode`, `steps` | Multi-step execution starting |
| 8 | `pipeline_complete` | `channel`, `mode`, `steps`, `duration_ms`, `cost_usd` | Multi-step completed with metrics |
| 9 | `error` | `source`, `message` | Critical error (timeout, SIGTERM, exit) |

---

## Alexa

| # | Type | Mechanism | Purpose |
|---|------|-----------|---------|
| 1 | **Launch welcome** | `buildAlexaResponse()` | "Hi! I'm Ellie. You can ask me anything..." |
| 2 | **Add todo confirmation** | `buildAlexaResponse()` | "Got it. I added {task} to your todo list." |
| 3 | **List todos** | `buildAlexaResponse()` | "You have N open todos. 1. ..." or "Your todo list is clear." |
| 4 | **Daily briefing** | `buildAlexaResponse()` | Time, next action, goals, pending items |
| 5 | **Help** | `buildAlexaResponse()` | Usage instructions |
| 6 | **Stop/Cancel** | `buildAlexaResponse()` | "Goodbye!" |
| 7 | **Unrecognized intent** | `buildAlexaResponse()` | "I'm not sure how to help with that." |
| 8 | **Claude response** | `buildAlexaResponse()` | Speech response from Claude (up to 6000 chars) |
| 9 | **Timeout fallback to Telegram** | `bot.api.sendMessage()` | "[From Alexa] {response}" — sent to Telegram if Alexa times out |
| 10 | **Error responses** | `buildAlexaResponse()` | "Sorry, I couldn't {action} right now." |

---

## Voice (Twilio Media Stream)

| # | Type | Mechanism | Purpose |
|---|------|-----------|---------|
| 1 | **Call initiation TwiML** | HTTP XML response | `<Stream>` directive to open media stream |
| 2 | **Audio stream chunks** | `ws.send()` | `{ event: "media", media: { payload: base64_mulaw } }` |
| 3 | **Audio clear** | `ws.send()` | `{ event: "clear" }` — clear buffer before new response |
| 4 | **Playback mark** | `ws.send()` | `{ event: "mark", mark: { name: "response_done" } }` — end of playback signal |

---

## Notification Policy (Multi-Channel)

The `notify()` engine routes events to Telegram and/or Google Chat per policy rules.

| Event | Telegram | Google Chat | Throttle | Priority |
|-------|----------|-------------|----------|----------|
| `session_start` | yes | yes | none | HIGH |
| `session_update` | no | yes | 60s | NORMAL |
| `session_decision` | yes | yes | none | HIGH |
| `session_complete` | yes | yes | none | HIGH |
| `session_pause` | yes | yes | none | NORMAL |
| `session_resume` | yes | yes | none | NORMAL |
| `dispatch_confirm` | yes | yes | none | NORMAL |
| `error` | yes | yes | none | CRITICAL |
| `rollup` | yes | yes | none | LOW |
| `weekly_review` | yes | yes | none | LOW |

---

## Work Session Lifecycle Messages

Sent via `notify()` from `/api/work-session/*` endpoints.

| # | Event | Emoji | Content |
|---|-------|-------|---------|
| 1 | `session_start` | rocket | Work item ID, title, agent, session ID |
| 2 | `session_update` | memo | Work item ID, title, agent, progress message |
| 3 | `session_decision` | lightning | Work item ID, title, decision text |
| 4 | `session_complete` | check | Work item ID, title, agent, duration, summary |
| 5 | `session_pause` | pause | Work item ID, title, reason |
| 6 | `session_resume` | play | Work item ID, title |

---

## Key Patterns

- **Notification policy**: Critical errors go to both channels instantly; progress updates throttled per event type
- **Extension broadcasts**: Dashboard receives ALL messages + metadata (routing, pipeline, queue status)
- **Voice**: Twilio media stream via WebSocket; TTS audio streamed as base64 mulaw chunks
- **Approvals**: Telegram uses inline keyboard buttons; Google Chat uses card interactions
- **Error handling**: Timeout/SIGTERM/exit errors are critical priority — immediate alert on both channels
- **Idle management**: 10-minute silence triggers memory consolidation on Telegram, Google Chat, and Ellie Chat
- **Delivery verification**: Nudge checker sends reminder if user doesn't acknowledge response
- **Long responses**: >4000 chars chunked; >8000 chars attached as file (Telegram only)
