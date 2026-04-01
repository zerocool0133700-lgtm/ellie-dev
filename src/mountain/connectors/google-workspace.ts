/**
 * GoogleWorkspaceMountainSource — ELLIE-659, ELLIE-671
 *
 * Harvests Gmail messages, Drive files, Calendar events, and Contacts via MCP tools.
 * Maps Google Workspace MCP tool results to HarvestItems.
 */

import { MCPConnectorSource, type MCPToolCaller } from "../mcp-connector.ts";
import type { HarvestJob, HarvestItem, HarvestError } from "../types.ts";

export class GoogleWorkspaceMountainSource extends MCPConnectorSource {
  constructor(callTool: MCPToolCaller) {
    super(callTool, {
      id: "google-workspace",
      name: "Google Workspace",
      rateLimitMax: 20,
      rateLimitWindowMs: 60_000,
      maxRetries: 3,
      baseRetryDelayMs: 1000,
    });
  }

  protected async fetchItems(job: HarvestJob): Promise<{
    items: HarvestItem[];
    errors: HarvestError[];
    truncated: boolean;
  }> {
    const items: HarvestItem[] = [];
    const errors: HarvestError[] = [];
    const recordTypes = (job.filters?.recordTypes as string[]) ?? [
      "gmail",
      "drive",
      "calendar",
      "contacts",
    ];
    const limit = job.limit ?? 50;

    // Gmail messages
    if (recordTypes.includes("gmail")) {
      try {
        const gmailItems = await this.fetchGmail(job, limit);
        items.push(...gmailItems);
      } catch (err) {
        errors.push({
          message: `Gmail fetch failed: ${err instanceof Error ? err.message : String(err)}`,
          retryable: true,
        });
      }
    }

    // Drive files
    if (recordTypes.includes("drive")) {
      try {
        const driveItems = await this.fetchDrive(job, limit);
        items.push(...driveItems);
      } catch (err) {
        errors.push({
          message: `Drive fetch failed: ${err instanceof Error ? err.message : String(err)}`,
          retryable: true,
        });
      }
    }

    // Calendar events
    if (recordTypes.includes("calendar")) {
      try {
        const calendarItems = await this.fetchCalendar(job, limit);
        items.push(...calendarItems);
      } catch (err) {
        errors.push({
          message: `Calendar fetch failed: ${err instanceof Error ? err.message : String(err)}`,
          retryable: true,
        });
      }
    }

    // Contacts
    if (recordTypes.includes("contacts")) {
      try {
        const contactItems = await this.fetchContacts(job, limit);
        items.push(...contactItems);
      } catch (err) {
        errors.push({
          message: `Contacts fetch failed: ${err instanceof Error ? err.message : String(err)}`,
          retryable: true,
        });
      }
    }

    return { items, errors, truncated: items.length >= limit };
  }

  private async fetchGmail(
    job: HarvestJob,
    limit: number,
  ): Promise<HarvestItem[]> {
    const query = this.buildGmailQuery(job);
    const results = await this.callWithRetry<{
      messages?: Array<{
        id: string;
        snippet?: string;
        subject?: string;
        from?: string;
        date?: string;
        threadId?: string;
      }>;
    }>("mcp__google-workspace__search_gmail_messages", {
      query,
      max_results: limit,
      user_google_email: job.filters?.email ?? "dave@ellie-labs.dev",
    });

    return (results.messages ?? []).map((msg) => ({
      externalId: `gmail:${msg.id}`,
      content: msg.snippet ?? "",
      sourceTimestamp: msg.date ? new Date(msg.date) : new Date(),
      metadata: {
        subject: msg.subject,
        from: msg.from,
        threadId: msg.threadId,
        type: "gmail",
      },
    }));
  }

  private async fetchDrive(
    job: HarvestJob,
    limit: number,
  ): Promise<HarvestItem[]> {
    const query = job.filters?.driveQuery as string | undefined;
    const results = await this.callWithRetry<{
      files?: Array<{
        id: string;
        name: string;
        mimeType?: string;
        modifiedTime?: string;
        createdTime?: string;
      }>;
    }>("mcp__google-workspace__search_drive_files", {
      query: query ?? "",
      max_results: limit,
      user_google_email: job.filters?.email ?? "dave@ellie-labs.dev",
    });

    return (results.files ?? []).map((file) => ({
      externalId: `drive:${file.id}`,
      content: file.name,
      sourceTimestamp: file.modifiedTime
        ? new Date(file.modifiedTime)
        : new Date(),
      metadata: {
        name: file.name,
        mimeType: file.mimeType,
        type: "drive",
      },
    }));
  }

  private async fetchCalendar(
    job: HarvestJob,
    limit: number,
  ): Promise<HarvestItem[]> {
    const email = (job.filters?.email as string) ?? "dave@ellie-labs.dev";
    const calendarId = (job.filters?.calendarId as string) ?? "primary";
    const timeMin = job.since?.toISOString() ?? new Date(Date.now() - 7 * 86400_000).toISOString();
    const timeMax = job.until?.toISOString() ?? new Date().toISOString();

    const results = await this.callWithRetry<{
      events?: Array<{
        id: string;
        summary?: string;
        description?: string;
        start?: { dateTime?: string; date?: string };
        end?: { dateTime?: string; date?: string };
        location?: string;
        attendees?: Array<{ email?: string; displayName?: string }>;
        status?: string;
        organizer?: { email?: string; displayName?: string };
      }>;
    }>("mcp__google-workspace__get_events", {
      user_google_email: email,
      calendar_id: calendarId,
      time_min: timeMin,
      time_max: timeMax,
      max_results: limit,
      detailed: true,
    });

    return (results.events ?? []).map((event) => {
      const startStr = event.start?.dateTime ?? event.start?.date;
      return {
        externalId: `calendar:${event.id}`,
        content: [event.summary, event.description].filter(Boolean).join(" — "),
        sourceTimestamp: startStr ? new Date(startStr) : new Date(),
        metadata: {
          summary: event.summary,
          description: event.description,
          start: event.start,
          end: event.end,
          location: event.location,
          attendees: event.attendees,
          organizer: event.organizer,
          status: event.status,
          type: "calendar",
        },
      };
    });
  }

  private async fetchContacts(
    job: HarvestJob,
    limit: number,
  ): Promise<HarvestItem[]> {
    const email = (job.filters?.email as string) ?? "dave@ellie-labs.dev";
    const allContacts: HarvestItem[] = [];
    let pageToken: string | undefined;

    do {
      const pageSize = Math.min(limit - allContacts.length, 100);
      const args: Record<string, unknown> = {
        user_google_email: email,
        page_size: pageSize,
      };
      if (pageToken) args.page_token = pageToken;

      const results = await this.callWithRetry<{
        contacts?: Array<{
          resourceName?: string;
          displayName?: string;
          emails?: string[];
          phones?: string[];
          organization?: string;
          title?: string;
          updatedAt?: string;
        }>;
        nextPageToken?: string;
      }>("mcp__google-workspace__list_contacts", args);

      for (const contact of results.contacts ?? []) {
        const rid = contact.resourceName ?? `unknown-${allContacts.length}`;
        allContacts.push({
          externalId: `contacts:${rid}`,
          content: contact.displayName ?? "",
          sourceTimestamp: contact.updatedAt ? new Date(contact.updatedAt) : new Date(),
          metadata: {
            resourceName: contact.resourceName,
            displayName: contact.displayName,
            emails: contact.emails,
            phones: contact.phones,
            organization: contact.organization,
            title: contact.title,
            type: "contacts",
          },
        });
      }

      pageToken = results.nextPageToken;
    } while (pageToken && allContacts.length < limit);

    return allContacts;
  }

  private buildGmailQuery(job: HarvestJob): string {
    const parts: string[] = [];
    if (job.since) {
      parts.push(`after:${job.since.toISOString().split("T")[0]}`);
    }
    if (job.until) {
      parts.push(`before:${job.until.toISOString().split("T")[0]}`);
    }
    if (job.filters?.gmailQuery) {
      parts.push(String(job.filters.gmailQuery));
    }
    return parts.join(" ") || "newer_than:7d";
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.callWithRetry("mcp__google-workspace__search_gmail_messages", {
        query: "newer_than:1d",
        max_results: 1,
        user_google_email: "dave@ellie-labs.dev",
      });
      return true;
    } catch {
      return false;
    }
  }
}
