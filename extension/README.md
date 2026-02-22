# Ellie Relay Feed

Chrome extension that shows a live event feed from the Ellie relay in a browser side panel.

## Setup

1. Open `chrome://extensions` and enable **Developer mode**
2. Click **Load unpacked** and select this `extension/` directory
3. Click the extension icon, then go to **Options** to configure:
   - **Server URL** — the relay address (e.g. `https://ellie.ellie-labs.dev`)
   - **API Key** — the extension API key from the relay's `.env`
4. Click the extension icon again to open the side panel

## How it works

The side panel connects to the relay via WebSocket at `{serverUrl}/extension`. On open, it sends an `auth` message with the API key. Once authenticated (`auth_ok`), it receives real-time events and renders them in a scrolling feed.

The WebSocket lives in the side panel itself (not the service worker) to avoid MV3 service worker suspension killing the connection.

### Event types

| Event | Description |
|---|---|
| `message_in` | Incoming user message (with channel badge and preview) |
| `message_out` | Outgoing reply (agent name + preview) |
| `route` | Classifier routing decision (agent, mode, confidence %) |
| `queue_status` | Message queue state (busy/idle, queue length, current item) |
| `pipeline_start` | Processing pipeline started (mode, step count) |
| `pipeline_complete` | Pipeline finished (duration, cost in USD) |
| `error` | Error event (source + message) |

### Features

- Auto-reconnect with exponential backoff (1s to 30s)
- Responds to relay ping/pong keepalives
- DOM capped at 500 event nodes to limit memory
- Reconnects automatically when settings change
- Clear feed and manual reconnect buttons
- Channel badges (telegram, google-chat, etc.)

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest (sidePanel + storage permissions) |
| `background.js` | Service worker — opens side panel on icon click |
| `sidepanel.html/js/css` | Main feed UI + WebSocket connection |
| `options.html/js` | Settings page (server URL + API key) |
| `icons/` | Extension icons (16/32/48/128px) |
