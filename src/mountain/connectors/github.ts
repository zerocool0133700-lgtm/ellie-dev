/**
 * GitHubMountainSource — ELLIE-659
 *
 * Harvests GitHub issues, PRs, and commits via MCP tools.
 * Maps GitHub MCP tool results to HarvestItems.
 */

import { MCPConnectorSource, type MCPToolCaller } from "../mcp-connector.ts";
import type { HarvestJob, HarvestItem, HarvestError } from "../types.ts";

export class GitHubMountainSource extends MCPConnectorSource {
  private owner: string;
  private repo: string;

  constructor(
    callTool: MCPToolCaller,
    opts: { owner: string; repo: string },
  ) {
    super(callTool, {
      id: "github",
      name: "GitHub",
      rateLimitMax: 30,
      rateLimitWindowMs: 60_000,
      maxRetries: 3,
      baseRetryDelayMs: 1000,
    });
    this.owner = opts.owner;
    this.repo = opts.repo;
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
      "pulls",
      "commits",
    ];
    const limit = job.limit ?? 50;

    if (recordTypes.includes("issues")) {
      try {
        const issueItems = await this.fetchIssues(job, limit);
        items.push(...issueItems);
      } catch (err) {
        errors.push({
          message: `Issues fetch failed: ${err instanceof Error ? err.message : String(err)}`,
          retryable: true,
        });
      }
    }

    if (recordTypes.includes("pulls")) {
      try {
        const prItems = await this.fetchPullRequests(job, limit);
        items.push(...prItems);
      } catch (err) {
        errors.push({
          message: `PRs fetch failed: ${err instanceof Error ? err.message : String(err)}`,
          retryable: true,
        });
      }
    }

    if (recordTypes.includes("commits")) {
      try {
        const commitItems = await this.fetchCommits(job, limit);
        items.push(...commitItems);
      } catch (err) {
        errors.push({
          message: `Commits fetch failed: ${err instanceof Error ? err.message : String(err)}`,
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
    const state = (job.filters?.state as string) ?? "all";
    const results = await this.callWithRetry<
      Array<{
        number: number;
        title: string;
        body?: string;
        state: string;
        created_at: string;
        updated_at: string;
        user?: { login: string };
        labels?: Array<{ name: string }>;
      }>
    >("mcp__github__list_issues", {
      owner: this.owner,
      repo: this.repo,
      state,
      per_page: limit,
    });

    return (results ?? []).map((issue) => ({
      externalId: `github-issue:${this.owner}/${this.repo}#${issue.number}`,
      content: `${issue.title}\n\n${issue.body ?? ""}`.trim(),
      sourceTimestamp: new Date(issue.created_at),
      metadata: {
        number: issue.number,
        state: issue.state,
        author: issue.user?.login,
        labels: issue.labels?.map((l) => l.name),
        updatedAt: issue.updated_at,
        type: "issue",
      },
    }));
  }

  private async fetchPullRequests(
    job: HarvestJob,
    limit: number,
  ): Promise<HarvestItem[]> {
    const state = (job.filters?.state as string) ?? "all";
    const results = await this.callWithRetry<
      Array<{
        number: number;
        title: string;
        body?: string;
        state: string;
        created_at: string;
        updated_at: string;
        user?: { login: string };
        merged_at?: string;
      }>
    >("mcp__github__list_pull_requests", {
      owner: this.owner,
      repo: this.repo,
      state,
      per_page: limit,
    });

    return (results ?? []).map((pr) => ({
      externalId: `github-pr:${this.owner}/${this.repo}#${pr.number}`,
      content: `${pr.title}\n\n${pr.body ?? ""}`.trim(),
      sourceTimestamp: new Date(pr.created_at),
      metadata: {
        number: pr.number,
        state: pr.state,
        author: pr.user?.login,
        mergedAt: pr.merged_at,
        updatedAt: pr.updated_at,
        type: "pull_request",
      },
    }));
  }

  private async fetchCommits(
    job: HarvestJob,
    limit: number,
  ): Promise<HarvestItem[]> {
    const args: Record<string, unknown> = {
      owner: this.owner,
      repo: this.repo,
      per_page: limit,
    };
    if (job.since) args.since = job.since.toISOString();
    if (job.until) args.until = job.until.toISOString();

    const results = await this.callWithRetry<
      Array<{
        sha: string;
        commit: {
          message: string;
          author?: { name: string; date: string };
        };
      }>
    >("mcp__github__list_commits", args);

    return (results ?? []).map((c) => ({
      externalId: `github-commit:${this.owner}/${this.repo}@${c.sha.slice(0, 7)}`,
      content: c.commit.message,
      sourceTimestamp: c.commit.author?.date
        ? new Date(c.commit.author.date)
        : new Date(),
      metadata: {
        sha: c.sha,
        author: c.commit.author?.name,
        type: "commit",
      },
    }));
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.callWithRetry("mcp__github__list_commits", {
        owner: this.owner,
        repo: this.repo,
        per_page: 1,
      });
      return true;
    } catch {
      return false;
    }
  }
}
