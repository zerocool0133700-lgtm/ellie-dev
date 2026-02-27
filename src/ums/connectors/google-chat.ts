/**
 * UMS Connector: Google Chat
 *
 * ELLIE-297: Normalizes GChat webhook events into UnifiedMessage format.
 * Supports both legacy and new Workspace Add-on formats.
 */

import type { UMSConnector } from "../connector.ts";
import type { UnifiedMessageInsert } from "../types.ts";

export const googleChatConnector: UMSConnector = {
  provider: "gchat",

  normalize(rawPayload: unknown): UnifiedMessageInsert | null {
    const event = rawPayload as Record<string, unknown>;

    // Detect format: new has "chat" key, legacy has "type" at top level
    const isNew = "chat" in event;
    const parsed = isNew ? parseNewFormat(event) : parseLegacyFormat(event);
    if (!parsed) return null;

    return {
      provider: "gchat",
      provider_id: parsed.messageName,
      channel: parsed.spaceName,
      sender: {
        name: parsed.senderName,
        email: parsed.senderEmail,
      },
      content: parsed.text,
      content_type: "text",
      raw: event,
      provider_timestamp: parsed.createTime,
      metadata: {
        thread_name: parsed.threadName,
        space_type: parsed.spaceType,
        is_direct: parsed.spaceType === "DM",
        message_name: parsed.messageName,
      },
    };
  },
};

interface ParsedGChat {
  text: string;
  spaceName: string;
  threadName: string | null;
  senderEmail: string;
  senderName: string;
  messageName: string;
  spaceType: string;
  createTime: string | null;
}

function parseLegacyFormat(event: Record<string, unknown>): ParsedGChat | null {
  if ((event.type as string) !== "MESSAGE") return null;
  const msg = event.message as Record<string, unknown> | undefined;
  const space = event.space as Record<string, unknown> | undefined;
  const sender = msg?.sender as Record<string, unknown> | undefined;
  if (!msg?.text || !space?.name) return null;

  return {
    text: msg.text as string,
    spaceName: space.name as string,
    threadName: (msg.thread as Record<string, unknown>)?.name as string || null,
    senderEmail: (sender?.email as string) || "",
    senderName: (sender?.displayName as string) || "",
    messageName: msg.name as string || `gchat-${Date.now()}`,
    spaceType: (space.type as string) || "ROOM",
    createTime: (msg.createTime as string) || null,
  };
}

function parseNewFormat(event: Record<string, unknown>): ParsedGChat | null {
  const chat = event.chat as Record<string, unknown> | undefined;
  const payload = chat?.messagePayload as Record<string, unknown> | undefined;
  const msg = payload?.message as Record<string, unknown> | undefined;
  const space = payload?.space as Record<string, unknown> | undefined;
  const user = chat?.user as Record<string, unknown> | undefined;
  const sender = msg?.sender as Record<string, unknown> | undefined;
  if (!msg?.text || !space?.name) return null;

  return {
    text: msg.text as string,
    spaceName: space.name as string,
    threadName: (msg.thread as Record<string, unknown>)?.name as string || null,
    senderEmail: (sender?.email as string) || (user?.email as string) || "",
    senderName: (sender?.displayName as string) || (user?.displayName as string) || "",
    messageName: msg.name as string || `gchat-${Date.now()}`,
    spaceType: (space.type as string) || "ROOM",
    createTime: (msg.createTime as string) || (chat?.eventTime as string) || null,
  };
}
