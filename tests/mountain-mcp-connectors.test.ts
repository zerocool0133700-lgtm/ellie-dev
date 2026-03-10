/**
 * Mountain MCP Connector Tests — ELLIE-659
 *
 * Tests MCPConnectorSource base class (rate limiting, retry, error handling)
 * and all three concrete connectors (Google Workspace, GitHub, Plane).
 * Uses mock MCP tool callers — no real API calls.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { MCPConnectorSource, type MCPToolCaller } from "../src/mountain/mcp-connector.ts";
import { GoogleWorkspaceMountainSource } from "../src/mountain/connectors/google-workspace.ts";
import { GitHubMountainSource } from "../src/mountain/connectors/github.ts";
import { PlaneMountainSource } from "../src/mountain/connectors/plane.ts";
import type { HarvestJob, HarvestItem, HarvestError } from "../src/mountain/types.ts";

// ── Helpers ──────────────────────────────────────────────────

function makeJob(overrides: Partial<HarvestJob> = {}): HarvestJob {
  return {
    id: "test-job-1",
    sourceId: "test",
    ...overrides,
  };
}

type ToolCall = { tool: string; args: Record<string, unknown> };

function mockCaller(
  responses: Record<string, unknown>,
): MCPToolCaller & { calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  const fn = async (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    if (tool in responses) return responses[tool];
    throw new Error(`Unknown tool: ${tool}`);
  };
  fn.calls = calls;
  return fn;
}

function failingCaller(
  errorMessage: string,
  failCount = Infinity,
): MCPToolCaller & { calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  let count = 0;
  const fn = async (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    count++;
    if (count <= failCount) throw new Error(errorMessage);
    return {};
  };
  fn.calls = calls;
  return fn;
}

// ── Concrete test subclass for base class tests ──────────────

class TestConnectorSource extends MCPConnectorSource {
  public fetchItemsFn: (job: HarvestJob) => Promise<{
    items: HarvestItem[];
    errors: HarvestError[];
    truncated: boolean;
  }>;

  constructor(
    callTool: MCPToolCaller,
    fetchItemsFn?: typeof TestConnectorSource.prototype.fetchItemsFn,
  ) {
    super(callTool, {
      id: "test-connector",
      name: "Test Connector",
      rateLimitMax: 100,
      rateLimitWindowMs: 1000,
      maxRetries: 2,
      baseRetryDelayMs: 10, // fast retries for tests
    });
    this.fetchItemsFn = fetchItemsFn ?? (async () => ({
      items: [],
      errors: [],
      truncated: false,
    }));
  }

  protected fetchItems(job: HarvestJob) {
    return this.fetchItemsFn(job);
  }

  // Expose protected methods for testing
  public testCallWithRetry<T>(tool: string, args: Record<string, unknown>) {
    return this.callWithRetry<T>(tool, args);
  }

  public testIsTransientError(err: Error) {
    return this.isTransientError(err);
  }
}

// ── MCPConnectorSource Base Class ────────────────────────────

describe("MCPConnectorSource", () => {
  describe("harvest", () => {
    test("returns items from fetchItems", async () => {
      const caller = mockCaller({});
      const items: HarvestItem[] = [
        { externalId: "1", content: "test", sourceTimestamp: new Date() },
      ];
      const source = new TestConnectorSource(caller, async () => ({
        items,
        errors: [],
        truncated: false,
      }));

      const result = await source.harvest(makeJob({ sourceId: "test-connector" }));
      expect(result.items).toHaveLength(1);
      expect(result.items[0].externalId).toBe("1");
      expect(result.errors).toHaveLength(0);
      expect(result.jobId).toBe("test-job-1");
    });

    test("catches fetchItems errors and returns error result", async () => {
      const caller = mockCaller({});
      const source = new TestConnectorSource(caller, async () => {
        throw new Error("Fetch exploded");
      });

      const result = await source.harvest(makeJob({ sourceId: "test-connector" }));
      expect(result.items).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toBe("Fetch exploded");
    });
  });

  describe("callWithRetry", () => {
    test("returns result on success", async () => {
      const caller = mockCaller({ "test-tool": { data: "ok" } });
      const source = new TestConnectorSource(caller);
      const result = await source.testCallWithRetry<{ data: string }>(
        "test-tool",
        {},
      );
      expect(result.data).toBe("ok");
      expect(caller.calls).toHaveLength(1);
    });

    test("retries on transient errors", async () => {
      const caller = failingCaller("rate limit exceeded", 1);
      const source = new TestConnectorSource(caller);
      // First call fails, second succeeds (failCount=1)
      // But our failingCaller returns {} after failCount, so it won't throw
      const result = await source.testCallWithRetry("test-tool", {});
      expect(caller.calls.length).toBe(2);
    });

    test("throws after exhausting retries", async () => {
      const caller = failingCaller("rate limit exceeded");
      const source = new TestConnectorSource(caller);
      await expect(
        source.testCallWithRetry("test-tool", {}),
      ).rejects.toThrow("rate limit exceeded");
      // Initial + maxRetries (2) = 3 attempts
      expect(caller.calls.length).toBe(3);
    });

    test("does not retry non-transient errors", async () => {
      const caller = failingCaller("permission denied");
      const source = new TestConnectorSource(caller);
      await expect(
        source.testCallWithRetry("test-tool", {}),
      ).rejects.toThrow("permission denied");
      expect(caller.calls.length).toBe(1);
    });
  });

  describe("isTransientError", () => {
    test("rate limit is transient", () => {
      const source = new TestConnectorSource(mockCaller({}));
      expect(source.testIsTransientError(new Error("rate limit exceeded"))).toBe(true);
    });

    test("timeout is transient", () => {
      const source = new TestConnectorSource(mockCaller({}));
      expect(source.testIsTransientError(new Error("request timeout"))).toBe(true);
    });

    test("429 is transient", () => {
      const source = new TestConnectorSource(mockCaller({}));
      expect(source.testIsTransientError(new Error("HTTP 429"))).toBe(true);
    });

    test("502/503 is transient", () => {
      const source = new TestConnectorSource(mockCaller({}));
      expect(source.testIsTransientError(new Error("502 Bad Gateway"))).toBe(true);
      expect(source.testIsTransientError(new Error("503 Service Unavailable"))).toBe(true);
    });

    test("permission denied is not transient", () => {
      const source = new TestConnectorSource(mockCaller({}));
      expect(source.testIsTransientError(new Error("permission denied"))).toBe(false);
    });
  });

  describe("implements MountainSource interface", () => {
    test("has required fields", () => {
      const source = new TestConnectorSource(mockCaller({}));
      expect(source.id).toBe("test-connector");
      expect(source.name).toBe("Test Connector");
      expect(source.status).toBe("idle");
    });
  });
});

// ── GoogleWorkspaceMountainSource ────────────────────────────

describe("GoogleWorkspaceMountainSource", () => {
  test("implements MountainSource interface", () => {
    const source = new GoogleWorkspaceMountainSource(mockCaller({}));
    expect(source.id).toBe("google-workspace");
    expect(source.name).toBe("Google Workspace");
    expect(source.status).toBe("idle");
  });

  test("harvests Gmail messages", async () => {
    const caller = mockCaller({
      "mcp__google-workspace__search_gmail_messages": {
        messages: [
          {
            id: "msg-1",
            snippet: "Hello world",
            subject: "Test email",
            from: "alice@example.com",
            date: "2026-03-01T10:00:00Z",
            threadId: "thread-1",
          },
          {
            id: "msg-2",
            snippet: "Follow up",
            subject: "Re: Test email",
            from: "bob@example.com",
            date: "2026-03-02T10:00:00Z",
            threadId: "thread-1",
          },
        ],
      },
    });

    const source = new GoogleWorkspaceMountainSource(caller);
    const result = await source.harvest(
      makeJob({
        sourceId: "google-workspace",
        filters: { recordTypes: ["gmail"] },
      }),
    );

    expect(result.items).toHaveLength(2);
    expect(result.items[0].externalId).toBe("gmail:msg-1");
    expect(result.items[0].content).toBe("Hello world");
    expect(result.items[0].metadata?.subject).toBe("Test email");
    expect(result.items[0].metadata?.type).toBe("gmail");
    expect(result.errors).toHaveLength(0);
  });

  test("harvests Drive files", async () => {
    const caller = mockCaller({
      "mcp__google-workspace__search_drive_files": {
        files: [
          {
            id: "file-1",
            name: "Project Plan.docx",
            mimeType: "application/vnd.google-apps.document",
            modifiedTime: "2026-03-05T12:00:00Z",
          },
        ],
      },
    });

    const source = new GoogleWorkspaceMountainSource(caller);
    const result = await source.harvest(
      makeJob({
        sourceId: "google-workspace",
        filters: { recordTypes: ["drive"] },
      }),
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].externalId).toBe("drive:file-1");
    expect(result.items[0].content).toBe("Project Plan.docx");
    expect(result.items[0].metadata?.type).toBe("drive");
  });

  test("handles Gmail API error gracefully", async () => {
    const caller = failingCaller("permission denied");
    const source = new GoogleWorkspaceMountainSource(caller);
    const result = await source.harvest(
      makeJob({
        sourceId: "google-workspace",
        filters: { recordTypes: ["gmail"] },
      }),
    );

    expect(result.items).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("Gmail fetch failed");
    expect(result.errors[0].retryable).toBe(true);
  });

  test("builds Gmail query with time window", async () => {
    const caller = mockCaller({
      "mcp__google-workspace__search_gmail_messages": { messages: [] },
    });
    const source = new GoogleWorkspaceMountainSource(caller);

    await source.harvest(
      makeJob({
        sourceId: "google-workspace",
        since: new Date("2026-01-01"),
        until: new Date("2026-02-01"),
        filters: { recordTypes: ["gmail"] },
      }),
    );

    expect(caller.calls[0].args.query).toContain("after:2026-01-01");
    expect(caller.calls[0].args.query).toContain("before:2026-02-01");
  });

  test("healthCheck calls Gmail API", async () => {
    const caller = mockCaller({
      "mcp__google-workspace__search_gmail_messages": { messages: [] },
    });
    const source = new GoogleWorkspaceMountainSource(caller);
    const healthy = await source.healthCheck();
    expect(healthy).toBe(true);
  });

  test("healthCheck returns false on error", async () => {
    const caller = failingCaller("connection refused");
    const source = new GoogleWorkspaceMountainSource(caller);
    const healthy = await source.healthCheck();
    expect(healthy).toBe(false);
  });
});

// ── GitHubMountainSource ─────────────────────────────────────

describe("GitHubMountainSource", () => {
  test("implements MountainSource interface", () => {
    const source = new GitHubMountainSource(mockCaller({}), {
      owner: "test-org",
      repo: "test-repo",
    });
    expect(source.id).toBe("github");
    expect(source.name).toBe("GitHub");
  });

  test("harvests issues", async () => {
    const caller = mockCaller({
      "mcp__github__list_issues": [
        {
          number: 42,
          title: "Fix bug",
          body: "Something is broken",
          state: "open",
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-02T10:00:00Z",
          user: { login: "dave" },
          labels: [{ name: "bug" }],
        },
      ],
    });

    const source = new GitHubMountainSource(caller, {
      owner: "test-org",
      repo: "test-repo",
    });
    const result = await source.harvest(
      makeJob({
        sourceId: "github",
        filters: { recordTypes: ["issues"] },
      }),
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].externalId).toBe(
      "github-issue:test-org/test-repo#42",
    );
    expect(result.items[0].content).toContain("Fix bug");
    expect(result.items[0].metadata?.state).toBe("open");
    expect(result.items[0].metadata?.author).toBe("dave");
    expect(result.items[0].metadata?.labels).toEqual(["bug"]);
    expect(result.items[0].metadata?.type).toBe("issue");
  });

  test("harvests pull requests", async () => {
    const caller = mockCaller({
      "mcp__github__list_pull_requests": [
        {
          number: 10,
          title: "Add feature",
          body: "New feature description",
          state: "closed",
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-03T10:00:00Z",
          user: { login: "alice" },
          merged_at: "2026-03-03T09:00:00Z",
        },
      ],
    });

    const source = new GitHubMountainSource(caller, {
      owner: "test-org",
      repo: "test-repo",
    });
    const result = await source.harvest(
      makeJob({
        sourceId: "github",
        filters: { recordTypes: ["pulls"] },
      }),
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].externalId).toBe(
      "github-pr:test-org/test-repo#10",
    );
    expect(result.items[0].metadata?.type).toBe("pull_request");
    expect(result.items[0].metadata?.mergedAt).toBe("2026-03-03T09:00:00Z");
  });

  test("harvests commits", async () => {
    const caller = mockCaller({
      "mcp__github__list_commits": [
        {
          sha: "abc1234567890",
          commit: {
            message: "Fix typo in README",
            author: { name: "Dave", date: "2026-03-05T14:00:00Z" },
          },
        },
      ],
    });

    const source = new GitHubMountainSource(caller, {
      owner: "test-org",
      repo: "test-repo",
    });
    const result = await source.harvest(
      makeJob({
        sourceId: "github",
        filters: { recordTypes: ["commits"] },
      }),
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].externalId).toBe(
      "github-commit:test-org/test-repo@abc1234",
    );
    expect(result.items[0].content).toBe("Fix typo in README");
    expect(result.items[0].metadata?.type).toBe("commit");
  });

  test("passes time window for commits", async () => {
    const caller = mockCaller({
      "mcp__github__list_commits": [],
    });
    const source = new GitHubMountainSource(caller, {
      owner: "o",
      repo: "r",
    });

    await source.harvest(
      makeJob({
        sourceId: "github",
        since: new Date("2026-01-01"),
        until: new Date("2026-02-01"),
        filters: { recordTypes: ["commits"] },
      }),
    );

    expect(caller.calls[0].args.since).toBe("2026-01-01T00:00:00.000Z");
    expect(caller.calls[0].args.until).toBe("2026-02-01T00:00:00.000Z");
  });

  test("handles partial failures across record types", async () => {
    let callCount = 0;
    const caller: MCPToolCaller & { calls: ToolCall[] } = Object.assign(
      async (tool: string, args: Record<string, unknown>) => {
        caller.calls.push({ tool, args });
        callCount++;
        if (tool === "mcp__github__list_issues") {
          return [
            {
              number: 1,
              title: "Good issue",
              state: "open",
              created_at: "2026-03-01T10:00:00Z",
              updated_at: "2026-03-01T10:00:00Z",
            },
          ];
        }
        if (tool === "mcp__github__list_pull_requests") {
          throw new Error("permission denied");
        }
        return [];
      },
      { calls: [] as ToolCall[] },
    );

    const source = new GitHubMountainSource(caller, {
      owner: "o",
      repo: "r",
    });
    const result = await source.harvest(
      makeJob({
        sourceId: "github",
        filters: { recordTypes: ["issues", "pulls"] },
      }),
    );

    expect(result.items).toHaveLength(1); // issues worked
    expect(result.errors).toHaveLength(1); // PRs failed
    expect(result.errors[0].message).toContain("PRs fetch failed");
  });

  test("healthCheck calls list_commits", async () => {
    const caller = mockCaller({
      "mcp__github__list_commits": [],
    });
    const source = new GitHubMountainSource(caller, {
      owner: "o",
      repo: "r",
    });
    expect(await source.healthCheck()).toBe(true);
    expect(caller.calls[0].tool).toBe("mcp__github__list_commits");
  });
});

// ── PlaneMountainSource ──────────────────────────────────────

describe("PlaneMountainSource", () => {
  test("implements MountainSource interface", () => {
    const source = new PlaneMountainSource(mockCaller({}), {
      projectId: "proj-1",
    });
    expect(source.id).toBe("plane");
    expect(source.name).toBe("Plane");
  });

  test("harvests issues", async () => {
    const caller = mockCaller({
      "mcp__plane__list_project_issues": [
        {
          id: "issue-uuid-1",
          sequence_id: 42,
          name: "Fix dashboard bug",
          state: "in-progress",
          priority: "high",
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-02T10:00:00Z",
          assignees: ["dave-uuid"],
          labels: ["bug"],
        },
        {
          id: "issue-uuid-2",
          sequence_id: 43,
          name: "Add new feature",
          state: "backlog",
          priority: "medium",
          created_at: "2026-03-02T10:00:00Z",
          updated_at: "2026-03-02T10:00:00Z",
        },
      ],
    });

    const source = new PlaneMountainSource(caller, { projectId: "proj-1" });
    const result = await source.harvest(
      makeJob({ sourceId: "plane" }),
    );

    expect(result.items).toHaveLength(2);
    expect(result.items[0].externalId).toBe("plane:issue-uuid-1");
    expect(result.items[0].content).toBe("ELLIE-42: Fix dashboard bug");
    expect(result.items[0].metadata?.sequenceId).toBe(42);
    expect(result.items[0].metadata?.state).toBe("in-progress");
    expect(result.items[0].metadata?.priority).toBe("high");
    expect(result.items[0].metadata?.type).toBe("issue");
  });

  test("respects limit", async () => {
    const issues = Array.from({ length: 10 }, (_, i) => ({
      id: `id-${i}`,
      sequence_id: i + 1,
      name: `Issue ${i}`,
      state: "backlog",
      priority: "none",
      created_at: "2026-03-01T10:00:00Z",
      updated_at: "2026-03-01T10:00:00Z",
    }));
    const caller = mockCaller({
      "mcp__plane__list_project_issues": issues,
    });

    const source = new PlaneMountainSource(caller, { projectId: "proj-1" });
    const result = await source.harvest(
      makeJob({ sourceId: "plane", limit: 3 }),
    );

    expect(result.items).toHaveLength(3);
  });

  test("passes projectId to MCP tool", async () => {
    const caller = mockCaller({
      "mcp__plane__list_project_issues": [],
    });
    const source = new PlaneMountainSource(caller, {
      projectId: "my-project-uuid",
    });
    await source.harvest(makeJob({ sourceId: "plane" }));

    expect(caller.calls[0].args.project_id).toBe("my-project-uuid");
  });

  test("handles API error gracefully", async () => {
    const caller = failingCaller("permission denied");
    const source = new PlaneMountainSource(caller, { projectId: "proj-1" });
    const result = await source.harvest(makeJob({ sourceId: "plane" }));

    expect(result.items).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("Plane issues fetch failed");
  });

  test("healthCheck calls list_project_issues", async () => {
    const caller = mockCaller({
      "mcp__plane__list_project_issues": [],
    });
    const source = new PlaneMountainSource(caller, { projectId: "proj-1" });
    expect(await source.healthCheck()).toBe(true);
    expect(caller.calls[0].tool).toBe("mcp__plane__list_project_issues");
  });
});
