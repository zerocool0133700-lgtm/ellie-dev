# Ellie Avatar — Chat Speaking Avatar Design

## Overview

Add a lip-synced talking avatar of Ellie to the chat interface. Ellie appears in the header bar (top-left, 200px), always visible, with a pre-generated idle loop when quiet and real-time Simli-powered lip-sync video when speaking. The avatar enhances Read Mode — when both avatar and Read Mode are enabled, speech routes through Simli for synchronized video+audio. When avatar is disabled, Read Mode works exactly as it does today.

## Technology Stack

- **Lip-sync video**: Simli API — sends PCM audio, returns WebRTC video stream
- **TTS**: ElevenLabs (existing) — streams PCM audio to relay, which pipes to Simli
- **Idle state**: Pre-generated ~5s video loop from Simli, stored as local MP4 asset
- **Transport**: WebRTC (Simli → browser direct), relay orchestrates session setup

## Architecture

### Data Flow: Speaking

1. Browser triggers Read Mode or clicks "Listen" on a message
2. Browser calls `POST /api/avatar/speak` with text
3. Relay calls ElevenLabs streaming TTS, receives PCM audio chunks (16kHz, 16-bit)
4. Relay streams PCM chunks back to browser via HTTP response
5. Browser pipes PCM chunks to Simli via `simliClient.sendAudioData()`
6. Simli generates lip-synced video frames and pushes them to browser via WebRTC
7. Browser receives video+audio through the SimliClient's WebRTC connection

**Note:** The `simli-client` SDK is browser-only (requires HTMLVideoElement, WebRTC, AudioContext). The relay's role is keeping API keys secure and handling TTS — the browser handles the Simli WebRTC connection directly.

### Data Flow: Idle

- Browser plays a pre-generated MP4 loop (`/avatar/ellie-idle.mp4`)
- When speech starts: crossfade (~300ms) from idle loop to Simli WebRTC stream
- When speech ends: crossfade back to idle loop

### Session Lifecycle

The Simli WebRTC session stays open for the duration of the page visit. Created on mount, reused for all speech, torn down on unmount. This avoids per-speech session setup latency.

## Relay Changes (ellie-dev)

### New File: src/simli.ts

Simli API client handling:

- Session token generation (keeps API key server-side)
- ICE server retrieval
- Configuration check (is Simli set up?)

### New Endpoints (src/http-routes.ts)

**POST /api/avatar/session**
- Auth: JWT with tts scope
- Creates Simli session token and retrieves ICE servers
- Returns `{ session_token, ice_servers }` for browser to establish WebRTC via `simli-client` SDK

**POST /api/avatar/speak**
- Auth: JWT with tts scope
- Body: `{ "text": "...", "provider": "elevenlabs" }`
- Calls ElevenLabs streaming TTS for PCM16 audio (16kHz mono)
- Streams raw PCM bytes back to browser via HTTP response
- Browser pipes audio to Simli via `sendAudioData()`

**GET /api/avatar/status**
- No auth required
- Returns `{ configured: boolean }` — whether Simli API key and face ID are set

## Dashboard Changes (ellie-home)

### New Component: components/ellie/AvatarVideo.vue

- Two overlapping `<video>` elements: idle loop and WebRTC stream
- CSS crossfade transition between them (~300ms)
- Circular mask for header size (48px), rounded-rect for expanded (200px)
- Click handler toggles expand/collapse
- State-based border glow:
  - **Idle**: gray border (#374151), local video loop
  - **Listening**: cyan glow (#06B6D4), user is typing
  - **Speaking**: green pulse glow (#10B981), Simli WebRTC active
  - **Thinking**: amber glow (#F59E0B), waiting for LLM response
- Green online indicator dot (bottom-right)

### New Composable: composables/useAvatarSession.ts

- Manages SimliClient lifecycle (creates client with session token from relay)
- Calls `POST /api/avatar/session` on mount, cleanup on unmount
- Exposes reactive state: `idle | listening | speaking | thinking`
- `speak()` method: fetches PCM16 from `/api/avatar/speak`, pipes to SimliClient
- Falls back gracefully (returns false from `speak()` if unavailable — caller uses regular TTS)
- Cleanup on page navigation (Vue onUnmounted)

### Modified: pages/ellie-chat.vue

- AvatarVideo component added to header, top-left after nav
- Read Mode enhanced: when avatar is enabled, calls `/api/avatar/speak` instead of `/api/tts`
- When avatar is disabled, Read Mode uses existing `/api/tts` flow unchanged
- Manual "Listen" button on messages also routes through avatar when enabled

## UI Layout

### Header Placement

Ellie's avatar sits in the chat header bar, top-left, immediately to the right of the nav icon and page title. Compact 48px circle in the header with click-to-expand to 200px dropdown.

### Expand Behavior

- Click avatar to expand to 200px rounded view that drops down from header position
- Click again or click outside to collapse
- Option to auto-expand when Read Mode speaking starts (persisted setting)

## Error Handling & Graceful Degradation

Four-level fallback ladder:

1. **Full experience** — Simli video + ElevenLabs audio via WebRTC
2. **Simli down** — Idle loop video + ElevenLabs audio via /api/tts (current Read Mode)
3. **ElevenLabs down** — Idle loop video + OpenAI TTS audio (existing fallback in tts.ts)
4. **Both down** — Static avatar image, text-only chat (current experience)

### Specific Scenarios

- **Simli API unavailable**: Avatar shows idle loop permanently. Read Mode falls back to /api/tts audio-only. Subtle gray border indicates fallback mode.
- **WebRTC drops mid-speech**: Crossfade to idle loop. Audio falls back to direct MP3 playback for remainder. Composable attempts background reconnect.
- **ElevenLabs TTS fails**: Falls back to OpenAI TTS (existing tts.ts behavior). PCM format may differ slightly — Simli handles both.
- **Multiple rapid speech requests**: Queued. Current speech finishes before next starts. Relay tracks speaking flag per session.
- **User navigates away mid-speech**: Vue unmount triggers cleanup → DELETE session → no orphaned sessions.

## Settings & Persistence

| Setting | Storage | Default |
|---------|---------|---------|
| Avatar enabled | localStorage (`ellie-avatar-enabled`) | true |
| Auto-expand on speak | localStorage (`ellie-avatar-auto-expand`) | true |
| Simli API key | relay .env (`SIMLI_API_KEY`) | — |

Avatar and Read Mode are independent toggles. Avatar can be on without Read Mode (shows idle animation). Read Mode can be on without avatar (audio-only, current behavior).

## Static Assets

| Asset | Location | Purpose |
|-------|----------|---------|
| Ellie face image | `ellie-home/public/avatar/ellie-face.png` | Source image for Simli avatar creation |
| Idle loop video | `ellie-home/public/avatar/ellie-idle.mp4` | ~5s looping video, pre-generated from Simli |

Idle video only needs regeneration if Ellie's appearance changes.

## Future Considerations

This design is scoped to the chat avatar. A future phase will expand Ellie's presence into the full app experience (larger view, gestures, contextual appearances). The relay-orchestrated architecture supports this — the Simli session management and audio piping are reusable regardless of where the avatar appears in the UI.
