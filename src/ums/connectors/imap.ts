/**
 * UMS Connector: Generic IMAP/POP3 Email
 *
 * ELLIE-314: Catch-all email connector using standard IMAP message shape.
 * Covers Yahoo, ProtonMail (via Bridge), FastMail, iCloud, corporate Exchange,
 * self-hosted mail, and any other standard email server.
 *
 * This is a pure normalization connector — it transforms pre-fetched email
 * data into UnifiedMessage format. The actual IMAP/POP3 fetching happens
 * in the ingestion layer (poller or webhook handler).
 *
 * Cross-ref: connectors/gmail.ts for the Gmail/Outlook email connector
 * Cross-ref: connectors/microsoft-graph.ts for Graph API mail
 */

import type { UMSConnector } from "../connector.ts";
import type { UnifiedMessageInsert } from "../types.ts";

// ── IMAP message shape ────────────────────────────────────────

/**
 * Normalized IMAP email message.
 * This shape is what the ingestion layer should produce after fetching
 * and parsing a raw IMAP message (via imapflow, mailparser, etc.).
 */
interface ImapEmail {
  /** Unique message ID (Message-ID header or UID). */
  message_id: string;

  /** Email subject line. */
  subject?: string;

  /** Sender address. */
  from?: ImapAddress | ImapAddress[];

  /** To recipients. */
  to?: ImapAddress | ImapAddress[];

  /** CC recipients. */
  cc?: ImapAddress | ImapAddress[];

  /** BCC recipients (rarely available via IMAP). */
  bcc?: ImapAddress | ImapAddress[];

  /** Reply-To header. */
  reply_to?: ImapAddress | ImapAddress[];

  /** Date the message was sent. */
  date?: string;

  /** Internal date (when server received it). */
  internal_date?: string;

  /** Plain text body. */
  text?: string;

  /** HTML body (fallback if no text). */
  html?: string;

  /** Short preview/snippet. */
  preview?: string;

  /** IMAP flags (e.g., \Seen, \Flagged, \Answered, \Draft). */
  flags?: string[];

  /** Mailbox/folder name (e.g., "INBOX", "Sent", "Archive"). */
  mailbox?: string;

  /** IMAP UID within the mailbox. */
  uid?: number;

  /** In-Reply-To header (for threading). */
  in_reply_to?: string;

  /** References header (for threading). */
  references?: string[];

  /** Whether the message has attachments. */
  has_attachments?: boolean;

  /** Attachment metadata (names + sizes, not content). */
  attachments?: { filename?: string; size?: number; content_type?: string }[];

  /** Email provider label (e.g., "yahoo", "protonmail", "fastmail", "icloud"). */
  provider_label?: string;

  /** IMAP account identifier (email address or account label). */
  account?: string;
}

interface ImapAddress {
  name?: string;
  address?: string;
}

// ── Connector ─────────────────────────────────────────────────

export const imapConnector: UMSConnector = {
  provider: "imap",

  normalize(rawPayload: unknown): UnifiedMessageInsert | null {
    const email = rawPayload as ImapEmail;
    if (!email.message_id) return null;

    const from = normalizeAddress(email.from);
    const subject = email.subject || "(no subject)";

    // Prefer plain text, fall back to stripped HTML, then preview
    const body = email.text
      || (email.html ? stripHtml(email.html) : null)
      || email.preview
      || "";

    const content = `${subject}\n\n${body}`.trim();

    // Build thread ID from References/In-Reply-To for threading
    const threadId = email.references?.[0] || email.in_reply_to || email.message_id;

    const providerLabel = email.provider_label || "imap";

    return {
      provider: "imap",
      provider_id: email.message_id,
      channel: `${providerLabel}:${email.account || email.mailbox || "inbox"}`,
      sender: from ? { name: from.name, email: from.address } : null,
      content: content.slice(0, 5000), // Cap content length
      content_type: "text",
      raw: rawPayload as Record<string, unknown>,
      provider_timestamp: email.date || email.internal_date || null,
      metadata: {
        subject,
        to: flattenAddresses(email.to),
        cc: flattenAddresses(email.cc),
        bcc: flattenAddresses(email.bcc),
        reply_to: flattenAddresses(email.reply_to),
        mailbox: email.mailbox,
        uid: email.uid,
        flags: email.flags,
        is_read: email.flags?.includes("\\Seen") ?? false,
        is_flagged: email.flags?.includes("\\Flagged") ?? false,
        is_answered: email.flags?.includes("\\Answered") ?? false,
        is_draft: email.flags?.includes("\\Draft") ?? false,
        has_attachments: email.has_attachments ?? (email.attachments && email.attachments.length > 0),
        attachments: email.attachments?.map(a => ({
          filename: a.filename,
          size: a.size,
          content_type: a.content_type,
        })),
        in_reply_to: email.in_reply_to,
        thread_id: threadId,
        provider_label: providerLabel,
        account: email.account,
      },
    };
  },
};

// ── Helpers ───────────────────────────────────────────────────

/** Normalize an address field (can be single or array). */
function normalizeAddress(addr: ImapAddress | ImapAddress[] | undefined): ImapAddress | null {
  if (!addr) return null;
  if (Array.isArray(addr)) return addr[0] || null;
  return addr;
}

/** Flatten address field to array of email strings. */
function flattenAddresses(addr: ImapAddress | ImapAddress[] | undefined): string[] {
  if (!addr) return [];
  const list = Array.isArray(addr) ? addr : [addr];
  return list.map(a => a.address).filter(Boolean) as string[];
}

/** Basic HTML tag stripping. */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
