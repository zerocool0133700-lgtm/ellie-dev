/**
 * PlaneMountainSource — ELLIE-659
 *
 * Harvests Plane work items and comments via MCP tools.
 * Maps Plane issue data to HarvestItems.
 */

import { MCPConnectorSource, type MCPToolCaller } from "../mcp-connector.ts";
import type { HarvestJob, HarvestItem, HarvestError } from "../types.ts";

export class PlaneMountainSource extends MCPConnectorSource {
  private projectId: string;

  constructor(callTool: MCPToolCaller, opts: { projectId: string }) {
    super(callTool, {
      id: "plane",
      name: "Plane",
      rateLimitMax: 20,
      rateLimitWindowMs: 60_000,
      maxRetries: 2,
      baseRetryDelayMs: 500,
    });
    this.projectId = opts.projectId;
  }

  protected async fetchItems(job: HarvestJob): Promise<{
    items: HarvestItem[];
    errors: HarvestError[];
    truncated: boolean;
  }> {
    const items: HarvestItem[] = [];
    const errors: HarvestError[] = [];
    const recordTypes = (job.filters?.recordTypes as string[]) ?? [
      "issues",
    ];
    const limit = job.limit ?? 50;

    if (recordTypes.includes("issues")) {
      try {
        const issueItems = await this.fetchIssues(job, limit);
        items.push(...issueItems);
      } catch (err) {
        errors.push({
          message: `Plane issues fetch failed: ${err instanceof Error ? err.message : String(err)}`,
          retryable: true,
        });
      }
    }

    return { items, errors, truncated: items.length >= limit };
  }

  private async fetchIssues(
    job: HarvestJob,
    limit: number,
  ): Promise<HarvestItem[]> {
    const results = await this.callWithRetry<
      Array<{
        id: string;
        sequence_id: number;
        name: string;
        description_html?: string;
        state: string;
        priority: string;
        created_at: string;
        updated_at: string;
        assignees?: string[];
        labels?: string[];
      }>
    >("mcp__plane__list_project_issues", {
      project_id: this.projectId,
    });

    const issues = (results ?? []).slice(0, limit);

    return issues.map((issue) => ({
      externalId: `plane:${issue.id}`,
      content: `ELLIE-${issue.sequence_id}: ${issue.name}`,
      sourceTimestamp: new Date(issue.created_at),
      metadata: {
        sequenceId: issue.sequence_id,
        state: issue.state,
        priority: issue.priority,
        assignees: issue.assignees,
        labels: issue.labels,
        updatedAt: issue.updated_at,
        type: "issue",
      },
    }));
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.callWithRetry("mcp__plane__list_project_issues", {
        project_id: this.projectId,
      });
      return true;
    } catch {
      return false;
    }
  }
}
