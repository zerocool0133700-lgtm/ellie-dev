# ELLIE-804: Ellie Chat v2 — Multi-Agent Chat Client

## Epic Vision

Transform Ellie Chat from a simple AI chat interface into a **full-featured chat client** for multi-agent collaboration. Supports individual chats, group chats, project chats, meeting rooms, and @mentions. Fully open architecture — no security restrictions, anyone can access any group chat.

## Core Principles

1. **Multi-agent first** — Every agent (Ellie, James, Kate, Alan, Brian, Amy, Finance) is a first-class participant
2. **Channel-based organization** — Individual DMs, group chats, project spaces, meeting rooms
3. **Real-time collaboration** — @mentions, typing indicators, read receipts, presence
4. **Mobile-friendly** — Responsive design, works on phone/tablet/desktop
5. **Fully open** — No access controls on group chats (private chats are just 1:1)

---

## Phase 1: Channel Architecture (Foundation)

### ELLIE-805: Channel data model and API
- Schema: `channels` table (id, type, name, description, metadata)
- Channel types: `dm` (1:1), `group` (multi-user), `project` (project-scoped), `meeting` (temporary)
- API: create, list, get, update, archive channels
- Migration: channel membership (many-to-many users/agents)

### ELLIE-806: Channel switching UI
- Left sidebar: channel list with icons/avatars
- Channel types visually distinct (DM icon, group icon, project folder, meeting badge)
- Active channel highlighted
- Click to switch between channels
- Search/filter channels

### ELLIE-807: Channel-scoped message history
- Messages belong to a channel (foreign key)
- API: fetch messages by channel_id
- Pagination (load more history on scroll)
- Per-channel message persistence
- Update WebSocket to broadcast channel_id with messages

### ELLIE-808: Create/manage channels
- "New Chat" button → modal
- Create DM (select user/agent)
- Create group chat (name, select participants)
- Create project channel (link to Plane project)
- Create meeting room (name, optional expiry)
- Edit channel name/description
- Archive channel

---

## Phase 2: Agent Presence & Identity

### ELLIE-809: Agent roster and presence
- Schema: `agent_presence` table (agent_id, status, last_seen, channel_id)
- Statuses: `online`, `away`, `busy`, `offline`
- Heartbeat API: agents ping every 30s
- UI: show online agents in sidebar with green dot
- Display current activity ("James is working on ELLIE-839")

### ELLIE-810: Agent avatars and profiles
- Each agent has avatar (image or generated icon)
- Agent profile page (click avatar → modal)
- Shows: name, role, archetype, current status, recent activity
- Link to agent's work trails and completed tickets

### ELLIE-811: Multi-agent message attribution
- Messages display sender avatar + name
- Agent messages styled differently (color/icon per archetype)
- Dave's messages styled as user
- System messages (e.g., "Kate joined #project-alpha") in gray

---

## Phase 3: @Mentions & Notifications

### ELLIE-812: @mention parser and routing
- Detect `@username` or `@agent-name` in messages
- Parse and extract mentions before message is sent
- Store mentions in `message_mentions` table
- API: get mentions for a user/agent

### ELLIE-813: @mention notifications
- When mentioned, agent receives notification
- Notification types: in-app badge, relay push (Telegram/Google Chat), email
- Notification contains: who mentioned, in which channel, message preview
- Click notification → jump to message in channel

### ELLIE-814: @mention typeahead
- When user types `@`, show autocomplete dropdown
- Lists: all agents, all users in current channel
- Filter as user types
- Click to insert mention
- Highlight mentions in blue in message composer

### ELLIE-815: @here and @channel commands
- `@here` mentions all currently active users in channel
- `@channel` mentions all members (even if offline)
- Requires confirmation modal before sending (prevent spam)

---

## Phase 4: Real-Time Collaboration

### ELLIE-816: Typing indicators
- When user types, broadcast "typing" event to channel
- Show "Kate is typing..." below message list
- Hide after 3s of inactivity
- Max 3 typing indicators shown (collapse to "Several people are typing")

### ELLIE-817: Read receipts (optional per-channel)
- Track last_read_message_id per user per channel
- Display checkmarks on messages: sent → delivered → read
- In group chats, show "Read by 3 people" (click to expand)
- Privacy toggle: users can disable sending read receipts

### ELLIE-818: Message reactions (already partially done)
- Quick reactions: 👍 ❤️ 😂 🎉 🤔
- Click emoji → add reaction to message
- Display reactions below message with count
- Click reaction to toggle (add/remove)
- Show who reacted (hover tooltip)

### ELLIE-819: Thread replies (optional)
- Click "Reply in thread" on a message
- Opens thread sidebar
- Thread shows parent message + all replies
- Thread replies also appear in main channel (indented)
- Indicator: "5 replies" on parent message

---

## Phase 5: Media & File Sharing

### ELLIE-820: File upload and attachment
- Drag & drop files into message composer
- Click attachment icon → file picker
- Upload to `uploads/` directory or S3
- Generate preview for images
- Store attachment metadata in `message_attachments` table

### ELLIE-821: Image preview and lightbox
- Images render inline in messages (max 400px width)
- Click image → open lightbox (full screen)
- Lightbox navigation: prev/next image in channel
- Download button

### ELLIE-822: File download and preview
- PDFs: inline preview (first page thumbnail)
- Code files: syntax-highlighted preview
- Other files: download link with icon
- Max file size: 25MB (configurable)

### ELLIE-823: Voice message recording
- Hold mic button to record voice message
- Audio saved as .ogg or .m4a
- Playback inline in chat (waveform UI)
- Transcription via Whisper (optional)

---

## Phase 6: Search & Discovery

### ELLIE-824: Global search (expand ELLIE-633)
- Cmd+K → search modal
- Search across: channels, messages, people, files
- Filters: by channel, by date range, by sender, by file type
- Results grouped by type
- Click result → jump to message or open channel

### ELLIE-825: Channel search
- Search within current channel only
- Highlight matches in message list
- "X of Y results" navigation (prev/next)

### ELLIE-826: Search indexing (Elasticsearch)
- Index all messages to Elasticsearch on insert
- Index channel metadata
- Index file content (PDFs, docs) for full-text search
- Nightly reindex job

---

## Phase 7: Meeting Rooms (Synchronous Collaboration)

### ELLIE-827: Meeting room creation
- Create temporary channel with expiry (default 24h)
- Optional: link to calendar event
- Invite agents/users via @mention or direct invite
- Meeting rooms appear in sidebar under "Meetings" section

### ELLIE-828: Meeting room features
- Pinned agenda message (editable by participants)
- Action items list (checkboxes, assignable)
- Meeting notes (collaborative rich-text editor)
- Timer display (meeting duration, countdown to end)

### ELLIE-829: Post-meeting summary
- When meeting ends (expiry or manual close), generate summary
- Summary includes: participants, duration, action items, key decisions
- Post summary to meeting room
- Option to export summary to work trail or River vault

---

## Phase 8: Project Channels (Plane Integration)

### ELLIE-830: Project channel linking
- Link channel to Plane project (e.g., #project-ellie → ELLIE project)
- Display project metadata in channel header (status, progress, due date)
- Show recent tickets in sidebar widget

### ELLIE-831: Ticket mentions and previews
- Detect `ELLIE-XXX` in messages
- Render ticket preview card (title, status, assignee, priority)
- Click ticket → open in Plane or show inline detail view

### ELLIE-832: Project activity feed
- Post Plane events to project channel:
  - Ticket created → "James created ELLIE-900: Fix bug"
  - Ticket completed → "ELLIE-899 completed by Kate"
  - Status change → "ELLIE-898 moved to In Progress"
- Optional: mute certain event types

---

## Phase 9: Rich Message Composer

### ELLIE-833: Markdown support
- Render markdown in messages: **bold**, *italic*, `code`, ```blocks```
- Live preview while typing (optional toggle)
- Syntax highlighting in code blocks

### ELLIE-834: Rich text toolbar
- Formatting buttons: bold, italic, strikethrough, code, link
- Insert: emoji, @mention, ticket link, file
- Draft.js or TipTap editor

### ELLIE-835: Message editing and deletion
- Edit sent message (click "..." → Edit)
- Shows "(edited)" indicator
- Delete message (soft delete, shows "Message deleted")
- Only sender can edit/delete (or admin)

### ELLIE-836: Message pinning
- Pin important messages to top of channel
- Max 3 pinned messages
- Click pinned message → scroll to original

---

## Phase 10: Mobile Optimization

### ELLIE-837: Responsive layout
- Mobile breakpoint: < 768px
- Collapsible sidebar (hamburger menu)
- Full-screen channel view on mobile
- Bottom navigation bar (channels, search, profile)

### ELLIE-838: Touch gestures
- Swipe message left → quick reply
- Swipe message right → quick reactions
- Pull down to refresh history
- Tap & hold message → context menu (copy, edit, delete, pin)

### ELLIE-839: Push notifications (PWA)
- Service worker for push notifications
- Opt-in notification permissions
- Badge count on app icon (unread messages)

---

## Phase 11: Voice & Video (Future)

### ELLIE-840: Voice calls (1:1 and group)
- WebRTC integration
- Call button in DM or group chat
- Ringing UI, accept/decline
- Mute/unmute, speaker/mic controls

### ELLIE-841: Video calls
- WebRTC video
- Camera toggle
- Screen sharing

### ELLIE-842: Call recordings and transcripts
- Record calls (with consent)
- Save to channel history
- Transcribe via Whisper
- Post transcript + action items after call

---

## Phase 12: Admin & Moderation (Low Priority)

### ELLIE-843: Channel settings and permissions
- Channel admins can:
  - Rename channel
  - Change channel description
  - Archive channel
  - Remove participants (group chats only)
- System message when settings change

### ELLIE-844: Message moderation
- Flag message (report spam/abuse)
- Admin review queue
- Delete flagged messages
- Mute users (temporary or permanent)

---

## Technical Architecture Notes

### Database Schema Changes
- New tables: `channels`, `channel_members`, `message_mentions`, `agent_presence`, `message_attachments`, `pinned_messages`, `meeting_rooms`
- Modify `messages` table: add `channel_id` (foreign key), `parent_message_id` (for threads), `edited_at`
- Migration strategy: keep existing `conversations` table for backward compat, gradually migrate to channels

### WebSocket Protocol
- Current: message broadcast to all clients
- New: broadcast to channel subscribers only
- Events: `message`, `typing`, `presence`, `reaction`, `mention`, `channel_update`
- Client subscribes to specific channels: `{type: "subscribe", channel_id: "123"}`

### Frontend State Management
- Current: single conversation history array
- New: map of channel_id → messages array
- Active channel state (currently selected channel)
- Unread count per channel
- Use Zustand or Pinia for state

### Agent Dispatch Integration
- Agents can post to specific channels via API
- `POST /api/chat/channels/:id/messages` (body: {content, agent_id})
- Agent can subscribe to channels (receive @mentions and `@agent-name` messages)
- Relay dispatches to appropriate agent based on @mention or routing rules

---

## Migration Strategy

1. **Phase 1-3** can run in parallel with existing Ellie Chat (separate UI route `/chat/v2`)
2. Once stable, migrate existing conversations to channels (DM channel per conversation)
3. Deprecate old `/chat` route, redirect to `/chat/v2`
4. Clean up legacy code after 2-week grace period

---

## Success Metrics

- All 7 agents can participate in group chats
- @mentions route to correct agent within 2s
- Message delivery < 500ms (WebSocket latency)
- Search returns results in < 1s
- Mobile UI usable on phone (no horizontal scroll, touch targets > 44px)
- 10+ concurrent channels without performance degradation

---

## Related Tickets (Existing)

These existing tickets should be incorporated or superseded:
- **ELLIE-633**: Search (expand into ELLIE-824/825)
- **ELLIE-637**: Emoji reactions (expand into ELLIE-818)
- **ELLIE-638**: Emoji picker (incorporate into ELLIE-818)

---

## Open Questions

1. Should we support end-to-end encryption for DMs?
2. Should agents be able to create channels, or only humans?
3. Do we want channel archiving or hard deletion?
4. Should meeting rooms auto-delete after expiry, or just archive?
5. File storage: local filesystem, Supabase Storage, or S3?
6. Voice/video: build in-house (WebRTC) or integrate Jitsi/Daily.co?

---

## Timeline Estimate

- **Phase 1-2** (Foundation + Identity): 2-3 weeks
- **Phase 3-4** (@Mentions + Real-Time): 1-2 weeks
- **Phase 5-6** (Media + Search): 2 weeks
- **Phase 7-8** (Meetings + Projects): 1-2 weeks
- **Phase 9-10** (Rich Composer + Mobile): 2 weeks
- **Phase 11** (Voice/Video): 3-4 weeks (optional, future)
- **Phase 12** (Admin): 1 week (optional, low priority)

**Total: ~10-14 weeks** for core features (Phase 1-10)

---

## Next Steps

1. Review this breakdown with Dave
2. Create Epic ticket in Plane (ELLIE-804)
3. Create child tickets for each phase
4. Prioritize Phase 1-3 as MVP (foundation, identity, mentions)
5. Begin implementation with ELLIE-805 (Channel data model)
