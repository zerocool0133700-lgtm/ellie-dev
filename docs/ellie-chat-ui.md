# Ellie Chat UI

> Dashboard URL: `https://dashboard.ellie-labs.dev/ellie-chat`
> Source: `ellie-home/app/pages/ellie-chat.vue`
> Composable: `ellie-home/app/composables/useEllieChat.ts`

## Overview

Ellie Chat is the primary real-time conversation interface for interacting with Ellie OS agents. It connects to the relay via WebSocket and supports multi-agent conversations, voice input, image attachments, TTS playback, tool approval, emoji reactions, message tagging, and knowledge capture to the River vault.

---

## Layout

The page is split into two areas:

1. **Channel Sidebar** (left, collapsible) — lists conversation channels with unread counts and agent presence
2. **Main Chat Area** (right) — header controls, message thread, input area

---

## Header Controls

Located at the top of the chat area, left to right:

| Control | Description |
|---------|-------------|
| **Ellie Chat** title | Page heading |
| **Mode Selector** | `<EllieModeSelector />` component — switches active agent mode |
| **New Chat** | Button — starts a fresh conversation, clears message history |
| **Read Mode** | Toggle — auto-plays all assistant responses via TTS. Shows speaker icon + "Reading" when active |
| **TTS Provider** | Toggle (visible when Read Mode on) — switches between ElevenLabs and OpenAI TTS |
| **Phone Status** | Badge (visible during voice calls) — shows "On call" with pulsing animation |
| **Speaking Indicator** | Badge (visible when TTS playing) — "Speaking..." with pulsing animation |
| **Connection Status** | Green dot = Connected, Red pulsing dot = Disconnected |

---

## Channel Sidebar (ELLIE-843, ELLIE-874)

Slide-over on mobile, inline on desktop. Toggle via arrow button.

### Features

- **Channel list** with icons and names
- **Unread count badges** per channel
- **Agent presence indicators** — which agents are active in each channel
- **Create channel** button — opens channel creation flow
- **Channel switching** — click to switch active channel

### Component

`<EllieChannelSidebar>` with props: `channels`, `activeChannelId`, `unreadCounts`, `agentPresence`

---

## Message Thread

Scrollable area showing the conversation history. Messages are styled differently by role:

### User Messages (right-aligned)

- Blue bubble (`bg-blue-900/40`)
- Shows "Dave" as sender name
- Displays inline images if attached (click to view full)
- Whitespace-preserving text
- Message ID (top right, clickable to copy, first 8 chars)

### Assistant Messages (left-aligned)

- Gray bubble (`bg-gray-800`)
- **Agent avatar** — `<EllieAgentAvatar>` with agent-specific color
- **Agent name** — color-coded by agent (e.g., James, Kate, Brian)
- **Timestamp** — relative time format
- **Duration** — response time in seconds (e.g., "2.3s")
- **Markdown rendering** — full markdown support via custom `renderMarkdown()`
- **Expandable details** — long responses show "See Details" / "Hide Details" toggle
- **Quick actions** — yes/no or choice buttons auto-detected from question text

### System Messages (centered)

- Muted, no bubble, centered text
- **Spawn status messages** (ELLIE-955) — color-coded by status:
  - Running: cyan with pulsing dot
  - Completed: emerald
  - Failed/Timed out: red

---

## Message Action Buttons

Every assistant message has action buttons below the text:

| Button | Action |
|--------|--------|
| **Listen** | Play TTS audio of the message (ElevenLabs or OpenAI) |
| **Ticket** | Create a Plane ticket from the message content. Shows "Creating..." then checkmark + ticket ID |
| **Tag** | Open tag modal to bookmark the message with tags + scope |
| **River** | Open refine modal to capture the message as structured knowledge in the River vault |

User messages have Tag and River buttons only.

---

## Emoji Reactions (ELLIE-637)

- **Reaction display** — emoji pills below messages with count badges
- **Quick reaction picker** — click "+😊" to open picker with common reactions
- **Toggle** — click existing reaction to add/remove your reaction
- **Color-coded** — your reactions highlighted in blue

---

## Typing Indicator (ELLIE-853)

When an agent is processing:

- Shows agent avatar + "{Agent Name} is thinking..." with pulsing animation
- Updates to show which specific agent is responding (not just "Ellie")

---

## Tool Approval Requests (ELLIE-213, ELLIE-252)

When an agent needs permission to use a tool:

- **Indigo card** with wrench icon
- Shows tool name (formatted) and input parameters
- **Allow** (emerald) and **Deny** (red) buttons
- **Remember** checkbox — auto-allow this tool in future
- **Expired requests** shown in amber with "Re-approval needed" label

---

## Confirm Actions

When an agent proposes a potentially dangerous action:

- **Amber card** with warning icon
- Description of the proposed action
- **Approve** (emerald) and **Deny** (red) buttons

---

## Tool Call Cards (ELLIE-985)

Collapsible section showing recent tool executions:

- Toggle to show/hide tool calls
- Count of tool calls + running indicator
- Per-call status: running (cyan spinner), completed (emerald checkmark), failed (red X)
- **Expandable details** — click to see input parameters, output preview, errors
- Duration in milliseconds

---

## Scroll to Bottom

Floating button appears when scrolled up:

- Shows down arrow + unread count badge
- Click to smooth-scroll to latest message

---

## Input Area

Bottom of the chat area:

### Text Input

- Auto-resizing textarea (1 row to max 8 lines)
- Enter to send, Shift+Enter for newline
- Disabled when disconnected or during phone call
- Drag-and-drop file support (ring highlight on drag over)
- Paste image support (Ctrl+V)

### Input Toolbar (right side buttons)

| Button | Description |
|--------|-------------|
| **Attach** (📎) | File picker for images (PNG, JPEG, GIF, WebP) |
| **Emoji** (😊) | Toggle emoji picker popup (vue3-emoji-picker) |
| **MD** | Toggle markdown preview of current input |
| **INP/MIC** | Mic mode toggle — "INP" routes voice to text input, "MIC" sends directly |
| **Mic** (🎤) | Hold to record voice, release to transcribe. Red = recording, amber = transcribing |
| **Phone** (📞) | Initiate/end voice call via Twilio. Green = start, red = end active call |
| **Send** (➤) | Send message button (blue when input has text) |

### Image Preview

When an image is attached (via file picker, paste, or drag):

- Shows image thumbnail (64x64)
- Filename
- Remove button (X)

### Markdown Preview

When MD toggle is active and text is entered:

- Shows rendered markdown preview below the input
- "Hide" button to dismiss

---

## Tag Modal (ELLIE-212)

Modal for bookmarking messages with tags:

### Fields

| Field | Description |
|-------|-------------|
| **Tag input** | Text input with autocomplete from existing tags |
| **Suggestions dropdown** | Shows matching tags with usage count |
| **Selected tags** | Amber pill chips with remove (X) button |
| **Scope selector** | Dropdown: Projects, ellie-dev, ellie-forest, ellie-home, ellie-os-app, World |

### Actions

- **Cancel** — close without saving
- **Save** — bookmark the message with selected tags and scope

---

## Refine to River Modal (ELLIE-772)

Modal for capturing message content as structured knowledge in the River vault:

### States

1. **Loading** — "Analyzing content..." while AI processes the message
2. **Error** — shows error message with Retry button
3. **Preview** — editable refinement ready for approval

### Editable Fields

| Field | Description |
|-------|-------------|
| **Content type** | Badge showing detected type + confidence percentage |
| **Title** | Editable text input — AI-suggested title |
| **River Path** | Editable path for vault storage (monospace) |
| **Type** | Dropdown: Workflow, Decision, Process, Policy, Integration, Reference |
| **Preview** | Editable textarea showing the refined markdown content |

### Actions

- **Cancel** — close without writing
- **Approve & Write** — save to River vault, shows "Written to River" confirmation

---

## Search Modal (ELLIE-633)

Triggered by `Cmd+K` keyboard shortcut:

### Features

- **Search input** with search icon
- **Mode toggle** — cycles through search modes (messages, memories, conversations)
- **Results list** — color-coded by type:
  - Message: blue border
  - Memory: purple border
  - Conversation: amber border
- **Keyboard navigation** — Up/Down arrows, Enter to open, Esc to close
- **Result details** — channel, timestamp, content preview (2-line clamp)

### Footer

Shows keyboard shortcut hints: `↑↓` navigate, `Enter` open, `Esc` close

---

## WebSocket Connection

The chat uses a persistent WebSocket connection to the relay:

### Events Received

| Event | Purpose |
|-------|---------|
| `message_in` | New user message echo |
| `message_out` | Agent response |
| `typing` | Agent typing indicator (with agent name) |
| `queue_status` | Queue position update |
| `tool_approval` | Tool permission request |
| `confirm_action` | Dangerous action confirmation |
| `tool_call` | Tool execution status (ELLIE-985) |
| `spawn_status` | Sub-agent spawn progress (ELLIE-955) |
| `reaction` | Emoji reaction update |
| `channel_update` | Channel list refresh |

### Connection Status

- Auto-reconnect on disconnect
- Visual indicator in header (green = connected, red pulsing = disconnected)
- Messages queued while disconnected

---

## Voice Features

### Voice Input (ELLIE-401)

- **Browser Speech API** — hold mic button to record
- **Two modes:**
  - **INP (Input)** — voice transcribed to text input for editing before send
  - **MIC (Direct)** — voice transcribed and sent immediately
- **States:** idle → listening (red pulse) → transcribing (amber pulse) → done

### Voice Calls (ELLIE-982)

- **Initiate call** via phone button
- **Phone active indicator** — pulsing emerald badge with status label
- **Disables text input** during active call
- **TTS auto-disabled** during calls (voice is the primary channel)

### Read Mode TTS (ELLIE-194)

- **Auto-play** all assistant responses via TTS
- **Provider toggle** — ElevenLabs (violet) or OpenAI (sky)
- **Speaking indicator** — amber pulsing badge
- **Manual listen** — play button on any assistant message

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Enter` | Send message |
| `Shift+Enter` | New line in input |
| `Cmd+K` / `Ctrl+K` | Open search modal |
| `Escape` | Close active modal |
| `↑` / `↓` | Navigate search results |

---

## Components Used

| Component | Purpose |
|-----------|---------|
| `<EllieChannelSidebar>` | Channel list with presence and unread counts |
| `<EllieModeSelector>` | Agent mode switching dropdown |
| `<EllieAgentAvatar>` | Agent-specific colored avatar (ELLIE-848) |
| `<EmojiPicker>` | vue3-emoji-picker for emoji selection |
| `<ClientOnly>` | SSR guard for browser-only components |

---

## Data Flow

```
User types message
    ↓
WebSocket sends to relay (ws://localhost:3001/ws/la-comms)
    ↓
Relay routes to agent (agent-router.ts)
    ↓
Agent dispatches via Claude CLI
    ↓
Response streams back via WebSocket
    ↓
Message rendered in chat thread
    ↓
Optional: TTS playback, tool approval, tag/river capture
```

---

## API Endpoints Consumed

| Endpoint | Method | Purpose |
|----------|--------|---------|
| WebSocket `/ws/la-comms` | WS | Real-time message stream |
| `/api/tts` | POST | Generate TTS audio from text |
| `/api/tts/provider` | GET/POST | Get/set TTS provider preference |
| `/api/chat/search` | GET | Search messages, memories, conversations |
| `/api/chat/tag` | POST | Bookmark message with tags |
| `/api/chat/refine` | POST | Analyze message for River capture |
| `/api/chat/refine/approve` | POST | Write refined content to River |
| `/api/chat/ticket` | POST | Create Plane ticket from message |
| `/api/chat/reaction` | POST | Add/remove emoji reaction |
| `/api/chat/channels` | GET | List available channels |
| `/api/chat/history` | GET | Load message history for channel |
| `/api/tool-approval` | POST | Respond to tool approval request |
| `/api/voice/call` | POST | Initiate Twilio voice call |
| `/api/voice/transcribe` | POST | Transcribe voice recording |
