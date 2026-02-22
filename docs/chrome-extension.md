# Ellie Feed — Chrome Extension

Live message feed from the Ellie relay, displayed in a Chrome side panel.

## Architecture

```
Browser Side Panel  <--WSS-->  Cloudflare Tunnel  -->  Relay (:3001/extension)
```

- **Manifest V3** with `sidePanel` + `storage` permissions
- WebSocket connection lives in the **side panel** (not the service worker — MV3 suspends service workers after ~30s, killing any WebSocket)
- Auth via shared secret sent as the first message after connecting

## Files

```
extension/
  manifest.json       — MV3 manifest (sidePanel, storage permissions)
  background.js       — Minimal service worker (opens side panel on icon click)
  sidepanel.html      — Side panel markup
  sidepanel.js        — WebSocket connection + event rendering
  sidepanel.css       — Dark theme styles
  options.html        — Settings page (server URL + API key)
  options.js          — Saves settings to chrome.storage.local
  icons/              — Placeholder PNG icons (16/32/48/128)
```

## Server-Side (relay.ts)

### WebSocket Endpoint

- Path: `/extension` (alongside `/media-stream` for voice)
- Both use `noServer: true` with a unified `httpServer.on("upgrade")` router — required because Bun's `ws` library rejects non-matching paths with 400 when two WSS instances share one server
- Auth: client sends `{ type: "auth", key: "<EXTENSION_API_KEY>" }` within 5 seconds or gets closed (code 4001 timeout, 4003 invalid key)
- Server pings every 30s to keep connections alive through Cloudflare/nginx

### Environment Variable

```
EXTENSION_API_KEY=e52d158ac80df35e5c2837d0929c82543c7f7ccf18560422f4af97565b108b25
```

### broadcastExtension()

Fire-and-forget function — no-op when no clients are connected. Defined at the bottom of relay.ts but hoisted to all call sites.

## Event Types

| Type | Channel | Fields | When |
|------|---------|--------|------|
| `message_in` | all | `channel`, `preview` | User sends a message |
| `route` | all | `channel`, `agent`, `mode`, `confidence` | Agent router classifies the message |
| `message_out` | all | `channel`, `agent`, `preview` | Assistant response saved |
| `queue_status` | — | `busy`, `queueLength`, `current` | Queue goes busy or returns to idle |
| `pipeline_start` | telegram, gchat | `channel`, `mode`, `steps` | Multi-step orchestration begins |
| `pipeline_complete` | telegram, gchat | `channel`, `mode`, `steps`, `duration_ms`, `cost_usd` | Multi-step orchestration finishes |
| `error` | — | `source`, `message` | Claude timeout or SIGTERM (exit 143) |

All events include a `ts` (Unix ms timestamp) field added by `broadcastExtension()`.

### Hook Locations in relay.ts

**Telegram text** (bot.on message:text): `message_in` → `route` → `pipeline_start`/`pipeline_complete` (multi-step) → `message_out`

**Telegram voice** (bot.on message:voice): `message_in` → `route` → `message_out`

**Google Chat** (/google-chat POST): `message_in` → `route` → `message_out` (sync path), `message_out` (async/timeout path), `pipeline_complete` (multi-step)

**Voice calls** (processVoiceAudio): `message_in` → `message_out`

**Alexa** (/alexa POST): `message_in` → `route` → `message_out` (sync + async)

**Queue** (processQueue): `queue_status` on each item start + idle

**Errors** (callClaude): `error` on timeout + SIGTERM

## Infrastructure

### Cloudflare Tunnel (`/etc/cloudflared/config.yml`)

The `/extension` path must be routed to `http://localhost:3001` (relay), not the dashboard catch-all on port 3000 (which has basic auth and would return 401).

### Nginx (`/etc/nginx/sites-enabled/ellie-home`)

`/extension` location block with WebSocket upgrade headers + `proxy_read_timeout 86400` (24h).

## Installation

1. Go to `chrome://extensions` → Enable Developer mode → "Load unpacked"
2. Select the `extension/` directory
3. Click the extension icon → opens side panel
4. Right-click extension icon → Options → enter:
   - **Server URL**: `https://ellie.ellie-labs.dev`
   - **API Key**: the `EXTENSION_API_KEY` value from `.env`
5. Close and reopen the side panel — should show "Connected"

## Debugging

- Open DevTools for the side panel: right-click inside the panel → "Inspect"
- Console logs prefixed with `[ellie]` show connection status and received events
- Server-side logs: `journalctl --user -u claude-telegram-relay | grep extension`
- Broadcasts log: `[extension] Broadcasting <type> to N client(s)`

## Known Limitations

- MV3 service workers get suspended — WebSocket must live in the side panel, not background.js
- Events are not buffered when the panel is closed (no persistent connection)
- Cloudflare Tunnel uses QUIC; WebSocket keepalive (30s ping) prevents idle timeout
