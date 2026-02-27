/**
 * UMS Connector: Gmail
 *
 * ELLIE-298: Normalizes Gmail/Outlook email messages into UnifiedMessage format.
 * Works with Microsoft Graph message shape (used by outlook.ts).
 */

import type { UMSConnector } from "../connector.ts";
import type { UnifiedMessageInsert } from "../types.ts";

interface EmailMessage {
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
}

export const gmailConnector: UMSConnector = {
  provider: "gmail",

  normalize(rawPayload: unknown): UnifiedMessageInsert | null {
    const email = rawPayload as EmailMessage;
    if (!email.id) return null;

    const from = email.from?.emailAddress;
    const subject = email.subject || "(no subject)";
    const preview = email.bodyPreview || "";
    const content = `${subject}\n\n${preview}`.trim();

    return {
      provider: "gmail",
      provider_id: email.id,
      channel: email.conversationId || `email:${email.id}`,
      sender: {
        name: from?.name,
        email: from?.address,
      },
      content,
      content_type: "text",
      raw: rawPayload as Record<string, unknown>,
      provider_timestamp: email.receivedDateTime || null,
      metadata: {
        subject,
        to: email.toRecipients?.map(r => r.emailAddress?.address).filter(Boolean),
        cc: email.ccRecipients?.map(r => r.emailAddress?.address).filter(Boolean),
        is_read: email.isRead,
        has_attachments: email.hasAttachments,
        conversation_id: email.conversationId,
        web_link: email.webLink,
      },
    };
  },
};
