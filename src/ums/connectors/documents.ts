/**
 * UMS Connector: Documents (Google Docs, Notion, etc.)
 *
 * ELLIE-312: Normalizes document activity events into UnifiedMessage format.
 */

import type { UMSConnector } from "../connector.ts";
import type { UnifiedMessageInsert } from "../types.ts";

interface DocumentEvent {
  id: string;
  doc_id: string;
  doc_title: string;
  change_type: "comment" | "edit" | "share" | "mention" | "suggestion";
  author?: { name?: string; email?: string };
  content?: string; // comment text, suggestion text, etc.
  section?: string;
  timestamp?: string;
  doc_url?: string;
  provider?: string; // "google-docs", "notion", etc.
}

export const documentsConnector: UMSConnector = {
  provider: "documents",

  normalize(rawPayload: unknown): UnifiedMessageInsert | null {
    const event = rawPayload as DocumentEvent;
    if (!event.id || !event.doc_id) return null;

    const lines: string[] = [];
    switch (event.change_type) {
      case "comment": lines.push(`Comment on "${event.doc_title}": ${event.content || ""}`); break;
      case "edit": lines.push(`Edit to "${event.doc_title}"${event.section ? ` (${event.section})` : ""}`); break;
      case "share": lines.push(`"${event.doc_title}" was shared with you`); break;
      case "mention": lines.push(`You were mentioned in "${event.doc_title}": ${event.content || ""}`); break;
      case "suggestion": lines.push(`Suggestion on "${event.doc_title}": ${event.content || ""}`); break;
      default: lines.push(`Document activity: ${event.doc_title}`);
    }

    return {
      provider: "documents",
      provider_id: event.id,
      channel: `doc:${event.doc_id}`,
      sender: event.author ? { name: event.author.name, email: event.author.email } : null,
      content: lines.join("\n"),
      content_type: "notification",
      raw: rawPayload as Record<string, unknown>,
      provider_timestamp: event.timestamp || null,
      metadata: {
        doc_id: event.doc_id,
        doc_title: event.doc_title,
        change_type: event.change_type,
        section: event.section,
        doc_url: event.doc_url,
        doc_provider: event.provider,
      },
    };
  },
};
