/**
 * GoogleWorkspaceMountainSource — ELLIE-659
 *
 * Harvests Gmail messages, Drive files, and Docs via MCP tools.
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
      user_google_email: job.filters?.email ?? "zerocool0133700@gmail.com",
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
      user_google_email: job.filters?.email ?? "zerocool0133700@gmail.com",
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
        user_google_email: "zerocool0133700@gmail.com",
      });
      return true;
    } catch {
      return false;
    }
  }
}
