#!/usr/bin/env bun
/**
 * Create the Ellie Teams Chat epic and all child tickets
 */

const PLANE_API_KEY = process.env.PLANE_API_KEY!;
const PLANE_BASE_URL = (process.env.PLANE_BASE_URL || "https://plane.ellie-labs.dev").replace(/\/api\/v1\/?$/, "");
const PLANE_WORKSPACE = process.env.PLANE_WORKSPACE || "evelife";
const PLANE_PROJECT_ID = process.env.PLANE_PROJECT_ID!;

const TODO_STATE_ID = "92d0bdb9-cc96-41e0-b26f-47e82ea6dab8"; // From CLAUDE.md

async function planeRequest(path: string, options?: RequestInit) {
  const res = await fetch(`${PLANE_BASE_URL}/api/v1/workspaces/${PLANE_WORKSPACE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": PLANE_API_KEY,
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Plane API ${res.status}: ${body}`);
  }
  return res.json();
}

async function createIssue(data: {
  name: string;
  description_html?: string;
  state: string;
  priority?: string;
  parent?: string | null;
}) {
  return planeRequest(`/projects/${PLANE_PROJECT_ID}/issues/`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

const epicDescription = `
<h2>Epic Vision</h2>
<p>Transform Ellie Chat from a simple AI chat interface into a <strong>full-featured chat client</strong> for multi-agent collaboration. Supports individual chats, group chats, project chats, meeting rooms, and @mentions. Fully open architecture — no security restrictions, anyone can access any group chat.</p>

<h2>Core Principles</h2>
<ol>
<li><strong>Multi-agent first</strong> — Every agent (Ellie, James, Kate, Alan, Brian, Amy, Finance) is a first-class participant</li>
<li><strong>Channel-based organization</strong> — Individual DMs, group chats, project spaces, meeting rooms</li>
<li><strong>Real-time collaboration</strong> — @mentions, typing indicators, read receipts, presence</li>
<li><strong>Mobile-friendly</strong> — Responsive design, works on phone/tablet/desktop</li>
<li><strong>Fully open</strong> — No access controls on group chats (private chats are just 1:1)</li>
</ol>

<p>See full breakdown: <code>/home/ellie/ellie-dev/docs/ELLIE-804-breakdown.md</code></p>

<h2>Timeline Estimate</h2>
<ul>
<li><strong>Phase 1-2</strong> (Foundation + Identity): 2-3 weeks</li>
<li><strong>Phase 3-4</strong> (@Mentions + Real-Time): 1-2 weeks</li>
<li><strong>Phase 5-6</strong> (Media + Search): 2 weeks</li>
<li><strong>Phase 7-8</strong> (Meetings + Projects): 1-2 weeks</li>
<li><strong>Phase 9-10</strong> (Rich Composer + Mobile): 2 weeks</li>
<li><strong>Phase 11</strong> (Voice/Video): 3-4 weeks (optional, future)</li>
<li><strong>Phase 12</strong> (Admin): 1 week (optional, low priority)</li>
</ul>

<p><strong>Total: ~10-14 weeks</strong> for core features (Phase 1-10)</p>
`;

const phases = [
  {
    name: "Phase 1: Channel Architecture (Foundation)",
    tickets: [
      { name: "Channel data model and API", description: "Schema: channels table (id, type, name, description, metadata). Channel types: dm (1:1), group (multi-user), project (project-scoped), meeting (temporary). API: create, list, get, update, archive channels. Migration: channel membership (many-to-many users/agents)." },
      { name: "Channel switching UI", description: "Left sidebar: channel list with icons/avatars. Channel types visually distinct (DM icon, group icon, project folder, meeting badge). Active channel highlighted. Click to switch between channels. Search/filter channels." },
      { name: "Channel-scoped message history", description: "Messages belong to a channel (foreign key). API: fetch messages by channel_id. Pagination (load more history on scroll). Per-channel message persistence. Update WebSocket to broadcast channel_id with messages." },
      { name: "Create/manage channels", description: "New Chat button → modal. Create DM (select user/agent). Create group chat (name, select participants). Create project channel (link to Plane project). Create meeting room (name, optional expiry). Edit channel name/description. Archive channel." },
    ],
  },
  {
    name: "Phase 2: Agent Presence & Identity",
    tickets: [
      { name: "Agent roster and presence", description: "Schema: agent_presence table (agent_id, status, last_seen, channel_id). Statuses: online, away, busy, offline. Heartbeat API: agents ping every 30s. UI: show online agents in sidebar with green dot. Display current activity (James is working on ELLIE-839)." },
      { name: "Agent avatars and profiles", description: "Each agent has avatar (image or generated icon). Agent profile page (click avatar → modal). Shows: name, role, archetype, current status, recent activity. Link to agent's work trails and completed tickets." },
      { name: "Multi-agent message attribution", description: "Messages display sender avatar + name. Agent messages styled differently (color/icon per archetype). Dave's messages styled as user. System messages (e.g., Kate joined #project-alpha) in gray." },
    ],
  },
  {
    name: "Phase 3: @Mentions & Notifications",
    tickets: [
      { name: "@mention parser and routing", description: "Detect @username or @agent-name in messages. Parse and extract mentions before message is sent. Store mentions in message_mentions table. API: get mentions for a user/agent." },
      { name: "@mention notifications", description: "When mentioned, agent receives notification. Notification types: in-app badge, relay push (Telegram/Google Chat), email. Notification contains: who mentioned, in which channel, message preview. Click notification → jump to message in channel." },
      { name: "@mention typeahead", description: "When user types @, show autocomplete dropdown. Lists: all agents, all users in current channel. Filter as user types. Click to insert mention. Highlight mentions in blue in message composer." },
      { name: "@here and @channel commands", description: "@here mentions all currently active users in channel. @channel mentions all members (even if offline). Requires confirmation modal before sending (prevent spam)." },
    ],
  },
  {
    name: "Phase 4: Real-Time Collaboration",
    tickets: [
      { name: "Typing indicators", description: "When user types, broadcast typing event to channel. Show Kate is typing... below message list. Hide after 3s of inactivity. Max 3 typing indicators shown (collapse to Several people are typing)." },
      { name: "Read receipts (optional per-channel)", description: "Track last_read_message_id per user per channel. Display checkmarks on messages: sent → delivered → read. In group chats, show Read by 3 people (click to expand). Privacy toggle: users can disable sending read receipts." },
      { name: "Message reactions", description: "Quick reactions: 👍 ❤️ 😂 🎉 🤔. Click emoji → add reaction to message. Display reactions below message with count. Click reaction to toggle (add/remove). Show who reacted (hover tooltip)." },
      { name: "Thread replies (optional)", description: "Click Reply in thread on a message. Opens thread sidebar. Thread shows parent message + all replies. Thread replies also appear in main channel (indented). Indicator: 5 replies on parent message." },
    ],
  },
  {
    name: "Phase 5: Media & File Sharing",
    tickets: [
      { name: "File upload and attachment", description: "Drag & drop files into message composer. Click attachment icon → file picker. Upload to uploads/ directory or S3. Generate preview for images. Store attachment metadata in message_attachments table." },
      { name: "Image preview and lightbox", description: "Images render inline in messages (max 400px width). Click image → open lightbox (full screen). Lightbox navigation: prev/next image in channel. Download button." },
      { name: "File download and preview", description: "PDFs: inline preview (first page thumbnail). Code files: syntax-highlighted preview. Other files: download link with icon. Max file size: 25MB (configurable)." },
      { name: "Voice message recording", description: "Hold mic button to record voice message. Audio saved as .ogg or .m4a. Playback inline in chat (waveform UI). Transcription via Whisper (optional)." },
    ],
  },
  {
    name: "Phase 6: Search & Discovery",
    tickets: [
      { name: "Global search (expand ELLIE-633)", description: "Cmd+K → search modal. Search across: channels, messages, people, files. Filters: by channel, by date range, by sender, by file type. Results grouped by type. Click result → jump to message or open channel." },
      { name: "Channel search", description: "Search within current channel only. Highlight matches in message list. X of Y results navigation (prev/next)." },
      { name: "Search indexing (Elasticsearch)", description: "Index all messages to Elasticsearch on insert. Index channel metadata. Index file content (PDFs, docs) for full-text search. Nightly reindex job." },
    ],
  },
  {
    name: "Phase 7: Meeting Rooms (Synchronous Collaboration)",
    tickets: [
      { name: "Meeting room creation", description: "Create temporary channel with expiry (default 24h). Optional: link to calendar event. Invite agents/users via @mention or direct invite. Meeting rooms appear in sidebar under Meetings section." },
      { name: "Meeting room features", description: "Pinned agenda message (editable by participants). Action items list (checkboxes, assignable). Meeting notes (collaborative rich-text editor). Timer display (meeting duration, countdown to end)." },
      { name: "Post-meeting summary", description: "When meeting ends (expiry or manual close), generate summary. Summary includes: participants, duration, action items, key decisions. Post summary to meeting room. Option to export summary to work trail or River vault." },
    ],
  },
  {
    name: "Phase 8: Project Channels (Plane Integration)",
    tickets: [
      { name: "Project channel linking", description: "Link channel to Plane project (e.g., #project-ellie → ELLIE project). Display project metadata in channel header (status, progress, due date). Show recent tickets in sidebar widget." },
      { name: "Ticket mentions and previews", description: "Detect ELLIE-XXX in messages. Render ticket preview card (title, status, assignee, priority). Click ticket → open in Plane or show inline detail view." },
      { name: "Project activity feed", description: "Post Plane events to project channel: Ticket created → James created ELLIE-900: Fix bug. Ticket completed → ELLIE-899 completed by Kate. Status change → ELLIE-898 moved to In Progress. Optional: mute certain event types." },
    ],
  },
  {
    name: "Phase 9: Rich Message Composer",
    tickets: [
      { name: "Markdown support", description: "Render markdown in messages: **bold**, *italic*, `code`, ```blocks```. Live preview while typing (optional toggle). Syntax highlighting in code blocks." },
      { name: "Rich text toolbar", description: "Formatting buttons: bold, italic, strikethrough, code, link. Insert: emoji, @mention, ticket link, file. Draft.js or TipTap editor." },
      { name: "Message editing and deletion", description: "Edit sent message (click ... → Edit). Shows (edited) indicator. Delete message (soft delete, shows Message deleted). Only sender can edit/delete (or admin)." },
      { name: "Message pinning", description: "Pin important messages to top of channel. Max 3 pinned messages. Click pinned message → scroll to original." },
    ],
  },
  {
    name: "Phase 10: Mobile Optimization",
    tickets: [
      { name: "Responsive layout", description: "Mobile breakpoint: < 768px. Collapsible sidebar (hamburger menu). Full-screen channel view on mobile. Bottom navigation bar (channels, search, profile)." },
      { name: "Touch gestures", description: "Swipe message left → quick reply. Swipe message right → quick reactions. Pull down to refresh history. Tap & hold message → context menu (copy, edit, delete, pin)." },
      { name: "Push notifications (PWA)", description: "Service worker for push notifications. Opt-in notification permissions. Badge count on app icon (unread messages)." },
    ],
  },
  {
    name: "Phase 11: Voice & Video (Future)",
    tickets: [
      { name: "Voice calls (1:1 and group)", description: "WebRTC integration. Call button in DM or group chat. Ringing UI, accept/decline. Mute/unmute, speaker/mic controls." },
      { name: "Video calls", description: "WebRTC video. Camera toggle. Screen sharing." },
      { name: "Call recordings and transcripts", description: "Record calls (with consent). Save to channel history. Transcribe via Whisper. Post transcript + action items after call." },
    ],
  },
  {
    name: "Phase 12: Admin & Moderation (Low Priority)",
    tickets: [
      { name: "Channel settings and permissions", description: "Channel admins can: Rename channel, Change channel description, Archive channel, Remove participants (group chats only). System message when settings change." },
      { name: "Message moderation", description: "Flag message (report spam/abuse). Admin review queue. Delete flagged messages. Mute users (temporary or permanent)." },
    ],
  },
];

async function main() {
  console.log("🚀 Creating Ellie Teams Chat epic and child tickets...\n");

  // Create epic
  console.log("📝 Creating epic...");
  const epic = await createIssue({
    name: "Ellie Teams Chat — Multi-Agent Collaboration Platform",
    description_html: epicDescription,
    state: TODO_STATE_ID,
    priority: "high",
    parent: null,
  });
  console.log(`✅ Epic created: ELLIE-${epic.sequence_id}`);

  // Create child tickets for each phase
  for (const phase of phases) {
    console.log(`\n📦 ${phase.name}`);
    for (const ticket of phase.tickets) {
      const child = await createIssue({
        name: ticket.name,
        description_html: `<p>${ticket.description}</p>`,
        state: TODO_STATE_ID,
        priority: "medium",
        parent: epic.id,
      });
      console.log(`  ✅ ELLIE-${child.sequence_id}: ${ticket.name}`);
    }
  }

  console.log(`\n🎉 Done! Created epic ELLIE-${epic.sequence_id} with ${phases.reduce((sum, p) => sum + p.tickets.length, 0)} child tickets.`);
}

main().catch(console.error);
