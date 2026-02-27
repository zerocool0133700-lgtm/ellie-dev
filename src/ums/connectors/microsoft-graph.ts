/**
 * UMS Connector: Microsoft Graph API
 *
 * ELLIE-313: Single connector for the Microsoft ecosystem via Graph API.
 * One auth flow, one API surface — normalizes Outlook Mail, Outlook Calendar,
 * Microsoft Teams, Microsoft To Do, and OneDrive/SharePoint into UnifiedMessage format.
 *
 * Each service maps to a different channel prefix:
 *   - outlook-mail:*   → email messages
 *   - outlook-calendar:* → calendar events
 *   - teams:*          → chat messages and channel posts
 *   - ms-todo:*        → tasks and list changes
 *   - onedrive:*       → file changes and shares
 *
 * Cross-ref: src/outlook.ts for existing OutlookMessage shape
 * Cross-ref: src/calendar-sync.ts for O365CalendarEvent shape
 */

import type { UMSConnector } from "../connector.ts";
import type { UnifiedMessageInsert } from "../types.ts";

// ── Graph API payload shapes ──────────────────────────────────

/** Microsoft Graph email message (Outlook Mail). */
interface GraphMailMessage {
  id: string;
  subject?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: { emailAddress?: { name?: string; address?: string } }[];
  ccRecipients?: { emailAddress?: { name?: string; address?: string } }[];
  receivedDateTime?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  isRead?: boolean;
  hasAttachments?: boolean;
  conversationId?: string;
  webLink?: string;
  importance?: string;
  flag?: { flagStatus?: string };
}

/** Microsoft Graph calendar event (Outlook Calendar). */
interface GraphCalendarEvent {
  id: string;
  subject?: string;
  body?: { content?: string };
  location?: { displayName?: string };
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  isAllDay?: boolean;
  showAs?: string;
  recurrence?: Record<string, unknown>;
  attendees?: {
    emailAddress?: { name?: string; address?: string };
    status?: { response?: string };
  }[];
  organizer?: { emailAddress?: { name?: string; address?: string } };
  onlineMeetingUrl?: string;
  onlineMeeting?: { joinUrl?: string };
  webLink?: string;
  isCancelled?: boolean;
}

/** Microsoft Teams chat message. */
interface GraphTeamsMessage {
  id: string;
  messageType?: string;
  createdDateTime?: string;
  from?: {
    user?: { displayName?: string; id?: string };
    application?: { displayName?: string };
  };
  body?: { contentType?: string; content?: string };
  chatId?: string;
  channelIdentity?: { teamId?: string; channelId?: string };
  subject?: string;
  importance?: string;
  webUrl?: string;
}

/** Microsoft To Do task. */
interface GraphTodoTask {
  id: string;
  title?: string;
  body?: { content?: string; contentType?: string };
  status?: string; // notStarted, inProgress, completed, waitingOnOthers, deferred
  importance?: string; // low, normal, high
  dueDateTime?: { dateTime?: string; timeZone?: string };
  completedDateTime?: { dateTime?: string; timeZone?: string };
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  linkedResources?: { applicationName?: string; displayName?: string; webUrl?: string }[];
  todoTaskListId?: string;
}

/** OneDrive/SharePoint file change. */
interface GraphDriveItem {
  id: string;
  name?: string;
  webUrl?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  lastModifiedBy?: {
    user?: { displayName?: string; email?: string };
  };
  size?: number;
  file?: { mimeType?: string };
  folder?: { childCount?: number };
  parentReference?: { path?: string; driveId?: string };
  changeType?: string; // custom field added during ingestion
}

/** Discriminated wrapper for all Graph API payloads. */
interface GraphPayload {
  _graphService: "mail" | "calendar" | "teams" | "todo" | "onedrive";
  data: unknown;
}

// ── Connector ─────────────────────────────────────────────────

export const microsoftGraphConnector: UMSConnector = {
  provider: "microsoft-graph",

  normalize(rawPayload: unknown): UnifiedMessageInsert | null {
    const payload = rawPayload as GraphPayload;

    // Require the discriminator field
    if (!payload?._graphService) {
      // Try auto-detection for common shapes
      return autoDetect(rawPayload);
    }

    switch (payload._graphService) {
      case "mail":
        return normalizeMail(payload.data as GraphMailMessage);
      case "calendar":
        return normalizeCalendar(payload.data as GraphCalendarEvent);
      case "teams":
        return normalizeTeams(payload.data as GraphTeamsMessage);
      case "todo":
        return normalizeTodo(payload.data as GraphTodoTask);
      case "onedrive":
        return normalizeOneDrive(payload.data as GraphDriveItem);
      default:
        return null;
    }
  },
};

// ── Auto-detection (when _graphService is missing) ────────────

function autoDetect(raw: unknown): UnifiedMessageInsert | null {
  const obj = raw as Record<string, unknown>;
  if (!obj || typeof obj !== "object") return null;

  // Mail: has subject + from + receivedDateTime
  if ("subject" in obj && "from" in obj && "receivedDateTime" in obj) {
    return normalizeMail(obj as unknown as GraphMailMessage);
  }
  // Calendar: has start + end (or isAllDay)
  if ("start" in obj && ("end" in obj || "isAllDay" in obj)) {
    return normalizeCalendar(obj as unknown as GraphCalendarEvent);
  }
  // Teams: has chatId or channelIdentity + messageType
  if ("chatId" in obj || "channelIdentity" in obj) {
    return normalizeTeams(obj as unknown as GraphTeamsMessage);
  }
  // Todo: has status + title (but not subject — disambiguate from mail)
  if ("title" in obj && "status" in obj && !("subject" in obj)) {
    return normalizeTodo(obj as unknown as GraphTodoTask);
  }
  // OneDrive: has file or folder + parentReference
  if ("parentReference" in obj && ("file" in obj || "folder" in obj)) {
    return normalizeOneDrive(obj as unknown as GraphDriveItem);
  }

  return null;
}

// ── Service normalizers ───────────────────────────────────────

function normalizeMail(msg: GraphMailMessage): UnifiedMessageInsert | null {
  if (!msg.id) return null;

  const from = msg.from?.emailAddress;
  const subject = msg.subject || "(no subject)";
  const preview = msg.bodyPreview || "";

  return {
    provider: "microsoft-graph",
    provider_id: `mail:${msg.id}`,
    channel: `outlook-mail:${msg.conversationId || msg.id}`,
    sender: from ? { name: from.name, email: from.address } : null,
    content: `${subject}\n\n${preview}`.trim(),
    content_type: "text",
    raw: msg as unknown as Record<string, unknown>,
    provider_timestamp: msg.receivedDateTime || null,
    metadata: {
      graph_service: "mail",
      subject,
      to: msg.toRecipients?.map(r => r.emailAddress?.address).filter(Boolean),
      cc: msg.ccRecipients?.map(r => r.emailAddress?.address).filter(Boolean),
      is_read: msg.isRead,
      has_attachments: msg.hasAttachments,
      conversation_id: msg.conversationId,
      web_link: msg.webLink,
      importance: msg.importance,
      flag_status: msg.flag?.flagStatus,
    },
  };
}

function normalizeCalendar(event: GraphCalendarEvent): UnifiedMessageInsert | null {
  if (!event.id) return null;
  if (event.isCancelled) return null;

  const attendeeNames = (event.attendees || [])
    .map(a => a.emailAddress?.name || a.emailAddress?.address)
    .filter(Boolean)
    .slice(0, 5);

  const startTime = event.start?.dateTime;
  const timeStr = startTime
    ? new Date(startTime).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
    : "TBD";

  const parts = [`Meeting: ${event.subject || "Untitled"}`];
  if (attendeeNames.length) parts.push(`with ${attendeeNames.join(", ")}`);
  parts.push(`at ${timeStr}`);
  if (event.location?.displayName) parts.push(`@ ${event.location.displayName}`);

  const meetingUrl = event.onlineMeeting?.joinUrl || event.onlineMeetingUrl;

  return {
    provider: "microsoft-graph",
    provider_id: `calendar:${event.id}`,
    channel: `outlook-calendar:primary`,
    sender: event.organizer?.emailAddress
      ? { name: event.organizer.emailAddress.name, email: event.organizer.emailAddress.address }
      : null,
    content: parts.join(" "),
    content_type: "event",
    raw: event as unknown as Record<string, unknown>,
    provider_timestamp: startTime || null,
    metadata: {
      graph_service: "calendar",
      title: event.subject,
      start_time: startTime,
      end_time: event.end?.dateTime,
      timezone: event.start?.timeZone,
      all_day: event.isAllDay,
      show_as: event.showAs,
      recurring: !!event.recurrence,
      location: event.location?.displayName,
      meeting_url: meetingUrl,
      attendees: event.attendees?.map(a => ({
        name: a.emailAddress?.name,
        email: a.emailAddress?.address,
        response: a.status?.response,
      })),
      attendee_count: event.attendees?.length || 0,
      web_link: event.webLink,
    },
  };
}

function normalizeTeams(msg: GraphTeamsMessage): UnifiedMessageInsert | null {
  if (!msg.id) return null;
  if (msg.messageType === "systemEventMessage") return null;

  const senderName = msg.from?.user?.displayName || msg.from?.application?.displayName;
  const senderId = msg.from?.user?.id;

  // Strip HTML tags from body for plain text content
  const bodyHtml = msg.body?.content || "";
  const content = bodyHtml.replace(/<[^>]*>/g, "").trim();
  if (!content) return null;

  const isChannel = !!msg.channelIdentity;
  const channelId = isChannel
    ? `teams:${msg.channelIdentity!.teamId}:${msg.channelIdentity!.channelId}`
    : `teams:chat:${msg.chatId}`;

  return {
    provider: "microsoft-graph",
    provider_id: `teams:${msg.id}`,
    channel: channelId,
    sender: { name: senderName, id: senderId },
    content: msg.subject ? `${msg.subject}\n\n${content}` : content,
    content_type: "text",
    raw: msg as unknown as Record<string, unknown>,
    provider_timestamp: msg.createdDateTime || null,
    metadata: {
      graph_service: "teams",
      message_type: msg.messageType,
      is_channel: isChannel,
      chat_id: msg.chatId,
      team_id: msg.channelIdentity?.teamId,
      channel_id: msg.channelIdentity?.channelId,
      importance: msg.importance,
      web_url: msg.webUrl,
    },
  };
}

function normalizeTodo(task: GraphTodoTask): UnifiedMessageInsert | null {
  if (!task.id || !task.title) return null;

  const parts = [task.title];
  if (task.body?.content) {
    const bodyText = task.body.content.replace(/<[^>]*>/g, "").trim();
    if (bodyText) parts.push(bodyText);
  }

  return {
    provider: "microsoft-graph",
    provider_id: `todo:${task.id}`,
    channel: `ms-todo:${task.todoTaskListId || "default"}`,
    sender: null,
    content: parts.join("\n\n"),
    content_type: "task",
    raw: task as unknown as Record<string, unknown>,
    provider_timestamp: task.lastModifiedDateTime || task.createdDateTime || null,
    metadata: {
      graph_service: "todo",
      title: task.title,
      status: task.status,
      importance: task.importance,
      due_date: task.dueDateTime?.dateTime,
      completed_at: task.completedDateTime?.dateTime,
      list_id: task.todoTaskListId,
      linked_resources: task.linkedResources?.map(r => ({
        app: r.applicationName,
        name: r.displayName,
        url: r.webUrl,
      })),
    },
  };
}

function normalizeOneDrive(item: GraphDriveItem): UnifiedMessageInsert | null {
  if (!item.id || !item.name) return null;

  const isFolder = !!item.folder;
  const modifier = item.lastModifiedBy?.user;
  const changeType = item.changeType || "modified";

  const content = isFolder
    ? `Folder ${changeType}: "${item.name}" (${item.folder!.childCount} items)`
    : `File ${changeType}: "${item.name}"`;

  return {
    provider: "microsoft-graph",
    provider_id: `onedrive:${item.id}`,
    channel: `onedrive:${item.parentReference?.driveId || "default"}`,
    sender: modifier ? { name: modifier.displayName, email: modifier.email } : null,
    content,
    content_type: "notification",
    raw: item as unknown as Record<string, unknown>,
    provider_timestamp: item.lastModifiedDateTime || item.createdDateTime || null,
    metadata: {
      graph_service: "onedrive",
      file_name: item.name,
      web_url: item.webUrl,
      size: item.size,
      mime_type: item.file?.mimeType,
      is_folder: isFolder,
      parent_path: item.parentReference?.path,
      change_type: changeType,
    },
  };
}
