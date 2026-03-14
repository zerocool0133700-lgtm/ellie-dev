/**
 * Shared UMS connector test fixtures — ELLIE-708
 *
 * Reusable payloads for testing each connector's normalize() method.
 * Each fixture set includes a valid happy-path payload and various
 * error/edge-case payloads.
 */

// ── Telegram ──────────────────────────────────────────────────

export const telegramFixtures = {
  textMessage: {
    message: {
      message_id: 101,
      date: 1710400000,
      text: "Hello from Telegram",
      chat: { id: 12345, type: "private" },
      from: { id: 99, first_name: "Dave", username: "davey" },
    },
  },
  voiceMessage: {
    message: {
      message_id: 102,
      date: 1710400100,
      chat: { id: 12345, type: "group" },
      from: { id: 99, first_name: "Dave", username: "davey" },
      voice: { duration: 12, file_id: "voice_file_abc", mime_type: "audio/ogg" },
    },
  },
  photoMessage: {
    message: {
      message_id: 103,
      date: 1710400200,
      caption: "Check this out",
      chat: { id: 12345, type: "private" },
      from: { id: 99, first_name: "Dave", username: "davey" },
      photo: [{ file_id: "photo_1", width: 100, height: 100 }],
    },
  },
  documentMessage: {
    message: {
      message_id: 104,
      date: 1710400300,
      chat: { id: 12345, type: "private" },
      from: { id: 99, first_name: "Dave", username: "davey" },
      document: { file_id: "doc_1", file_name: "report.pdf", mime_type: "application/pdf" },
    },
  },
  replyMessage: {
    message: {
      message_id: 105,
      date: 1710400400,
      text: "Replying here",
      chat: { id: 12345, type: "private" },
      from: { id: 99, first_name: "Dave", username: "davey" },
      reply_to_message: { message_id: 101, text: "Hello from Telegram" },
    },
  },
  callbackQuery: {
    callback_query: { data: "action_1", from: { id: 99 } },
  },
  empty: {},
  noMessage: { update_id: 999 },
};

// ── Gmail ─────────────────────────────────────────────────────

export const gmailFixtures = {
  basicEmail: {
    id: "msg-001",
    subject: "Weekly Report",
    from: { emailAddress: { name: "Alice", address: "alice@example.com" } },
    toRecipients: [{ emailAddress: { name: "Dave", address: "dave@example.com" } }],
    ccRecipients: [{ emailAddress: { address: "team@example.com" } }],
    receivedDateTime: "2026-03-14T10:00:00Z",
    bodyPreview: "Here is the weekly summary...",
    body: { contentType: "text", content: "Full body content here" },
    isRead: false,
    hasAttachments: true,
    conversationId: "conv-001",
    webLink: "https://outlook.office.com/mail/id/msg-001",
  },
  minimalEmail: {
    id: "msg-002",
  },
  noSubject: {
    id: "msg-003",
    from: { emailAddress: { name: "Bob", address: "bob@example.com" } },
    bodyPreview: "Just a quick note",
  },
  noId: {
    subject: "Missing ID email",
  },
  empty: {},
};

// ── Google Chat ───────────────────────────────────────────────

export const googleChatFixtures = {
  legacyMessage: {
    type: "MESSAGE",
    message: {
      name: "spaces/AAA/messages/msg-001",
      text: "Hello from GChat",
      sender: { email: "dave@example.com", displayName: "Dave" },
      thread: { name: "spaces/AAA/threads/thread-001" },
      createTime: "2026-03-14T10:00:00Z",
    },
    space: { name: "spaces/AAA", type: "DM" },
  },
  newFormatMessage: {
    chat: {
      messagePayload: {
        message: {
          name: "spaces/BBB/messages/msg-002",
          text: "New format message",
          sender: { email: "alice@example.com", displayName: "Alice" },
          thread: { name: "spaces/BBB/threads/thread-002" },
          createTime: "2026-03-14T11:00:00Z",
        },
        space: { name: "spaces/BBB", type: "ROOM" },
      },
      user: { email: "alice@example.com", displayName: "Alice" },
      eventTime: "2026-03-14T11:00:00Z",
    },
  },
  legacyNonMessage: {
    type: "ADDED_TO_SPACE",
    space: { name: "spaces/CCC", type: "DM" },
  },
  newFormatNoText: {
    chat: {
      messagePayload: {
        message: { name: "spaces/DDD/messages/msg-003" },
        space: { name: "spaces/DDD", type: "ROOM" },
      },
    },
  },
  empty: {},
};

// ── Google Tasks ──────────────────────────────────────────────

export const googleTasksFixtures = {
  basicTask: {
    id: "task-001",
    title: "Buy groceries",
    notes: "Milk, eggs, bread",
    due: "2026-03-15T00:00:00Z",
    status: "needsAction",
    updated: "2026-03-14T09:00:00Z",
  },
  completedTask: {
    id: "task-002",
    title: "Submit report",
    status: "completed",
    updated: "2026-03-14T08:00:00Z",
  },
  minimalTask: {
    id: "task-003",
    title: "Quick reminder",
  },
  noId: { title: "Missing ID" },
  noTitle: { id: "task-004" },
  empty: {},
};

// ── Calendar ──────────────────────────────────────────────────

export const calendarFixtures = {
  basicEvent: {
    external_id: "evt-001",
    provider: "google",
    calendar_id: "primary",
    calendar_name: "Work Calendar",
    title: "Team Standup",
    description: "Daily standup",
    location: "Room 5A",
    start_time: "2026-03-14T09:00:00Z",
    end_time: "2026-03-14T09:30:00Z",
    timezone: "America/Chicago",
    all_day: false,
    status: "confirmed",
    recurring: true,
    attendees: [
      { email: "dave@example.com", name: "Dave", status: "accepted" },
      { email: "alice@example.com", name: "Alice", status: "tentative" },
    ],
    organizer: "dave@example.com",
    meeting_url: "https://meet.google.com/abc-def",
  },
  cancelledEvent: {
    external_id: "evt-002",
    title: "Cancelled Meeting",
    status: "cancelled",
  },
  minimalEvent: {
    external_id: "evt-003",
  },
  noAttendees: {
    external_id: "evt-004",
    title: "Focus Time",
    start_time: "2026-03-14T14:00:00Z",
  },
  noId: { title: "Missing ID event" },
  empty: {},
};

// ── Voice ─────────────────────────────────────────────────────

export const voiceFixtures = {
  basicTranscription: {
    id: "voice-001",
    transcription: "Remember to call the dentist tomorrow",
    duration_seconds: 5.2,
    confidence: 0.95,
    language: "en",
    original_provider: "telegram",
    original_message_id: "tg-msg-102",
    audio_format: "ogg",
    timestamp: "2026-03-14T10:30:00Z",
    sender: { id: "99", name: "Dave", username: "davey" },
  },
  minimalTranscription: {
    id: "voice-002",
    transcription: "Hello",
    original_provider: "phone",
  },
  noSender: {
    id: "voice-003",
    transcription: "Automated message",
    original_provider: "phone",
  },
  noId: { transcription: "Missing ID", original_provider: "telegram" },
  noTranscription: { id: "voice-004", original_provider: "telegram" },
  empty: {},
};

// ── GitHub ─────────────────────────────────────────────────────

export const githubFixtures = {
  pullRequest: {
    action: "opened",
    sender: { login: "davey", avatar_url: "https://example.com/avatar.png" },
    repository: { full_name: "ellie-labs/ellie-dev", html_url: "https://github.com/ellie-labs/ellie-dev" },
    pull_request: { number: 42, title: "Add UMS connectors", body: "New connectors for all providers", html_url: "https://github.com/ellie-labs/ellie-dev/pull/42", state: "open" },
  },
  issue: {
    action: "opened",
    sender: { login: "alice" },
    repository: { full_name: "ellie-labs/ellie-dev" },
    issue: { number: 10, title: "Bug in calendar sync", body: "Events missing", html_url: "https://github.com/ellie-labs/ellie-dev/issues/10", state: "open" },
  },
  comment: {
    action: "created",
    sender: { login: "bob" },
    repository: { full_name: "ellie-labs/ellie-dev" },
    issue: { number: 10, title: "Bug in calendar sync" },
    comment: { id: 5001, body: "I can reproduce this on my end too. The issue seems to be in the sync loop.", html_url: "https://github.com/ellie-labs/ellie-dev/issues/10#comment-5001" },
  },
  ciCompleted: {
    action: "completed",
    sender: { login: "github-actions[bot]" },
    repository: { full_name: "ellie-labs/ellie-dev" },
    workflow_run: { id: 9999, name: "CI", conclusion: "success", html_url: "https://github.com/ellie-labs/ellie-dev/actions/runs/9999", head_branch: "main" },
  },
  ciFailed: {
    action: "completed",
    sender: { login: "github-actions[bot]" },
    repository: { full_name: "ellie-labs/ellie-dev" },
    workflow_run: { id: 10000, name: "CI", conclusion: "failure", html_url: "https://github.com/ellie-labs/ellie-dev/actions/runs/10000", head_branch: "feature/ums" },
  },
  push: {
    ref: "refs/heads/main",
    sender: { login: "davey" },
    repository: { full_name: "ellie-labs/ellie-dev" },
    commits: [
      { id: "abc12345def67890", message: "fix: calendar sync deletion\n\nHandles consecutive misses", author: { name: "Dave" } },
      { id: "def67890abc12345", message: "test: add sync state tests", author: { name: "Dave" } },
    ],
  },
  unknownEvent: {
    action: "something_weird",
    sender: { login: "bot" },
    repository: { full_name: "ellie-labs/ellie-dev" },
  },
  empty: {},
};

// ── IMAP ──────────────────────────────────────────────────────

export const imapFixtures = {
  basicEmail: {
    message_id: "<abc123@mail.yahoo.com>",
    subject: "Invoice attached",
    from: { name: "Billing Dept", address: "billing@acme.com" },
    to: [{ name: "Dave", address: "dave@example.com" }],
    cc: [{ address: "accounts@example.com" }],
    date: "2026-03-14T08:00:00Z",
    internal_date: "2026-03-14T08:00:05Z",
    text: "Please find the invoice attached.",
    flags: ["\\Seen", "\\Flagged"],
    mailbox: "INBOX",
    uid: 1234,
    has_attachments: true,
    attachments: [{ filename: "invoice.pdf", size: 45000, content_type: "application/pdf" }],
    provider_label: "yahoo",
    account: "dave@yahoo.com",
  },
  htmlOnlyEmail: {
    message_id: "<def456@proton.me>",
    subject: "Newsletter",
    from: { name: "News", address: "news@example.com" },
    html: "<div><p>Big news!</p><style>.hidden{display:none}</style></div>",
    provider_label: "protonmail",
    account: "dave@proton.me",
    mailbox: "INBOX",
  },
  previewOnlyEmail: {
    message_id: "<ghi789@fastmail.com>",
    preview: "Just a snippet",
    provider_label: "fastmail",
    mailbox: "INBOX",
  },
  threadedEmail: {
    message_id: "<thread-msg-3@mail.com>",
    subject: "Re: Project Update",
    from: [{ name: "Alice", address: "alice@example.com" }],
    text: "Sounds good, let's proceed.",
    in_reply_to: "<thread-msg-2@mail.com>",
    references: ["<thread-msg-1@mail.com>", "<thread-msg-2@mail.com>"],
    flags: ["\\Seen", "\\Answered"],
    mailbox: "INBOX",
    uid: 1237,
    provider_label: "imap",
  },
  draftEmail: {
    message_id: "<draft-001@mail.com>",
    subject: "Draft message",
    text: "Not sent yet",
    flags: ["\\Draft"],
    mailbox: "Drafts",
  },
  noMessageId: {
    subject: "Missing message_id",
    text: "Should be skipped",
  },
  empty: {},
};

// ── Documents ─────────────────────────────────────────────────

export const documentsFixtures = {
  comment: {
    id: "doc-evt-001",
    doc_id: "doc-123",
    doc_title: "Q1 Planning",
    change_type: "comment" as const,
    author: { name: "Alice", email: "alice@example.com" },
    content: "We should revisit this section",
    section: "Budget",
    timestamp: "2026-03-14T10:00:00Z",
    doc_url: "https://docs.google.com/doc/123",
    provider: "google-docs",
  },
  edit: {
    id: "doc-evt-002",
    doc_id: "doc-123",
    doc_title: "Q1 Planning",
    change_type: "edit" as const,
    author: { name: "Bob" },
    section: "Timeline",
    timestamp: "2026-03-14T10:05:00Z",
  },
  share: {
    id: "doc-evt-003",
    doc_id: "doc-456",
    doc_title: "Team Handbook",
    change_type: "share" as const,
    timestamp: "2026-03-14T10:10:00Z",
  },
  mention: {
    id: "doc-evt-004",
    doc_id: "doc-789",
    doc_title: "Design Review",
    change_type: "mention" as const,
    content: "Dave, can you review this?",
    author: { name: "Carol", email: "carol@example.com" },
  },
  suggestion: {
    id: "doc-evt-005",
    doc_id: "doc-123",
    doc_title: "Q1 Planning",
    change_type: "suggestion" as const,
    content: "Replace 'quarterly' with 'monthly'",
    author: { name: "Eve" },
  },
  noId: { doc_id: "doc-999", doc_title: "Missing ID", change_type: "edit" as const },
  noDocId: { id: "doc-evt-099", doc_title: "Missing doc_id", change_type: "edit" as const },
  empty: {},
};

// ── Microsoft Graph ───────────────────────────────────────────

export const microsoftGraphFixtures = {
  mail: {
    _graphService: "mail" as const,
    data: {
      id: "graph-mail-001",
      subject: "Budget Review",
      from: { emailAddress: { name: "CFO", address: "cfo@contoso.com" } },
      toRecipients: [{ emailAddress: { address: "dave@contoso.com" } }],
      receivedDateTime: "2026-03-14T09:00:00Z",
      bodyPreview: "Please review the attached budget",
      isRead: false,
      hasAttachments: true,
      conversationId: "graph-conv-001",
      importance: "high",
      flag: { flagStatus: "flagged" },
    },
  },
  calendar: {
    _graphService: "calendar" as const,
    data: {
      id: "graph-cal-001",
      subject: "Board Meeting",
      location: { displayName: "Main Conference Room" },
      start: { dateTime: "2026-03-14T14:00:00", timeZone: "America/Chicago" },
      end: { dateTime: "2026-03-14T15:00:00", timeZone: "America/Chicago" },
      isAllDay: false,
      showAs: "busy",
      recurrence: null,
      attendees: [
        { emailAddress: { name: "Dave", address: "dave@contoso.com" }, status: { response: "accepted" } },
        { emailAddress: { name: "CFO", address: "cfo@contoso.com" }, status: { response: "tentativelyAccepted" } },
      ],
      organizer: { emailAddress: { name: "CEO", address: "ceo@contoso.com" } },
      onlineMeeting: { joinUrl: "https://teams.microsoft.com/meet/abc" },
      webLink: "https://outlook.office.com/cal/graph-cal-001",
    },
  },
  cancelledCalendar: {
    _graphService: "calendar" as const,
    data: { id: "graph-cal-002", subject: "Cancelled Sync", isCancelled: true },
  },
  teams: {
    _graphService: "teams" as const,
    data: {
      id: "teams-msg-001",
      messageType: "message",
      createdDateTime: "2026-03-14T10:00:00Z",
      from: { user: { displayName: "Alice", id: "user-alice" } },
      body: { contentType: "html", content: "<p>Hey team, quick update</p>" },
      chatId: "chat-001",
      importance: "normal",
      webUrl: "https://teams.microsoft.com/chat/001",
    },
  },
  teamsChannel: {
    _graphService: "teams" as const,
    data: {
      id: "teams-msg-002",
      messageType: "message",
      createdDateTime: "2026-03-14T10:05:00Z",
      from: { user: { displayName: "Bob", id: "user-bob" } },
      body: { content: "Channel post here" },
      channelIdentity: { teamId: "team-001", channelId: "channel-general" },
      subject: "Announcement",
    },
  },
  teamsSystem: {
    _graphService: "teams" as const,
    data: { id: "teams-msg-003", messageType: "systemEventMessage", body: { content: "Alice joined" } },
  },
  todo: {
    _graphService: "todo" as const,
    data: {
      id: "todo-001",
      title: "Review PR",
      body: { content: "<p>Check the UMS connector tests</p>", contentType: "html" },
      status: "inProgress",
      importance: "high",
      dueDateTime: { dateTime: "2026-03-15T17:00:00", timeZone: "America/Chicago" },
      createdDateTime: "2026-03-14T08:00:00Z",
      lastModifiedDateTime: "2026-03-14T12:00:00Z",
      todoTaskListId: "list-work",
      linkedResources: [{ applicationName: "GitHub", displayName: "PR #42", webUrl: "https://github.com/ellie-labs/ellie-dev/pull/42" }],
    },
  },
  onedrive: {
    _graphService: "onedrive" as const,
    data: {
      id: "drive-001",
      name: "Q1-Budget.xlsx",
      webUrl: "https://contoso-my.sharepoint.com/Q1-Budget.xlsx",
      lastModifiedDateTime: "2026-03-14T11:00:00Z",
      lastModifiedBy: { user: { displayName: "CFO", email: "cfo@contoso.com" } },
      size: 125000,
      file: { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      parentReference: { path: "/drive/root:/Finance", driveId: "drive-main" },
      changeType: "modified",
    },
  },
  onedriveFolder: {
    _graphService: "onedrive" as const,
    data: {
      id: "drive-002",
      name: "New Project",
      webUrl: "https://contoso-my.sharepoint.com/New-Project",
      lastModifiedDateTime: "2026-03-14T11:05:00Z",
      folder: { childCount: 3 },
      parentReference: { path: "/drive/root:", driveId: "drive-main" },
      changeType: "created",
    },
  },
  // Auto-detection payloads (no _graphService wrapper)
  autoDetectMail: {
    id: "auto-mail-001",
    subject: "Auto-detected mail",
    from: { emailAddress: { name: "Test", address: "test@example.com" } },
    receivedDateTime: "2026-03-14T12:00:00Z",
    bodyPreview: "This should be auto-detected as mail",
  },
  autoDetectCalendar: {
    id: "auto-cal-001",
    subject: "Auto-detected event",
    start: { dateTime: "2026-03-14T15:00:00" },
    end: { dateTime: "2026-03-14T16:00:00" },
  },
  autoDetectTeams: {
    id: "auto-teams-001",
    chatId: "chat-auto",
    messageType: "message",
    body: { content: "Auto-detected teams message" },
    from: { user: { displayName: "Auto" } },
  },
  autoDetectTodo: {
    id: "auto-todo-001",
    title: "Auto-detected task",
    status: "notStarted",
  },
  autoDetectOneDrive: {
    id: "auto-drive-001",
    name: "auto-file.txt",
    parentReference: { driveId: "drive-x" },
    file: { mimeType: "text/plain" },
  },
  unknownPayload: { foo: "bar" },
  empty: {},
};
