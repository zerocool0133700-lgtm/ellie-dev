/**
 * ELLIE-511 — Tests for plane.ts
 *
 * Covers: resolveWorkItemId, updateIssueState, addIssueComment,
 * sessionCommentExists, getStateIdByGroup, getIssueStateGroup,
 * updateWorkItemOnSessionStart, updateWorkItemOnSessionComplete,
 * updateWorkItemOnFailure, fetchWorkItemDetails, isWorkItemDone,
 * listOpenIssues, createPlaneIssue, atomicStateAndComment (via high-level fns)
 *
 * Timeout recovery lock is already covered in timeout-ux.test.ts.
 */

// Set PLANE_API_KEY before importing plane.ts (reads at module level)
process.env.PLANE_API_KEY = "test-api-key";
process.env.PLANE_BASE_URL = "https://plane.test";
process.env.PLANE_WORKSPACE_SLUG = "test-ws";

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { breakers } from "../src/resilience.ts";
import {
  isPlaneConfigured,
  resolveWorkItemId,
  updateIssueState,
  addIssueComment,
  sessionCommentExists,
  getStateIdByGroup,
  getIssueStateGroup,
  updateWorkItemOnSessionStart,
  updateWorkItemOnSessionComplete,
  updateWorkItemOnFailure,
  fetchWorkItemDetails,
  isWorkItemDone,
  listOpenIssues,
  createPlaneIssue,
  _resetTimeoutRecoveryForTesting,
  setTimeoutRecoveryLock,
} from "../src/plane.ts";

// ── Mock infrastructure ──────────────────────────────────────

const originalFetch = globalThis.fetch;
const captured: Array<{ url: string; method: string; body: any }> = [];

function mockFetch(handler: (url: string, method: string, body: any) => any) {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    captured.push({ url, method, body });
    const result = handler(url, method, body);
    return {
      ok: true,
      status: 200,
      json: async () => result,
      text: async () => JSON.stringify(result),
    } as Response;
  }) as typeof fetch;
}

function mockFetchError(statusCode: number = 500, body: string = "Internal Server Error") {
  globalThis.fetch = (async () => {
    return {
      ok: false,
      status: statusCode,
      json: async () => ({}),
      text: async () => body,
    } as Response;
  }) as typeof fetch;
}

// Mock plane-queue enqueue functions to prevent DB calls
const enqueuedItems: Array<{ type: string; opts: any }> = [];

// We need to intercept the plane-queue imports. Since plane.ts imports
// from plane-queue at the top level, we'll mock the DB call via the
// module system. For now, we use dynamic import patching.
// Actually, we'll just mock getSql to avoid DB hits when atomicStateAndComment
// falls back to queueing.

// Standard mock data
const MOCK_PROJECT = { id: "proj-uuid-1", identifier: "ELLIE", name: "Ellie" };
const MOCK_ISSUE = {
  id: "issue-uuid-1",
  sequence_id: 42,
  name: "Test Issue",
  description_html: "<p>Issue <strong>description</strong> here</p>",
  priority: "high",
  state: "state-uuid-started",
  state_detail: { group: "started" },
};
const MOCK_STATES = [
  { id: "state-uuid-backlog", group: "backlog" },
  { id: "state-uuid-unstarted", group: "unstarted" },
  { id: "state-uuid-started", group: "started" },
  { id: "state-uuid-completed", group: "completed" },
];

function defaultHandler(url: string, method: string, body: any): any {
  // Route based on URL pattern
  if (url.includes("/projects/") && url.includes("/issues/") && url.includes("/comments/")) {
    if (method === "GET") return { results: [] };
    if (method === "POST") return { id: "comment-uuid-1" };
  }
  if (url.includes("/projects/") && url.includes("/states/")) {
    return { results: MOCK_STATES };
  }
  if (url.includes("/projects/") && url.includes("/issues/")) {
    if (method === "PATCH") return { ...MOCK_ISSUE, ...body };
    if (method === "POST") return { id: "new-issue-uuid", sequence_id: 99 };
    // GET with query param (sequence_id filter)
    if (url.includes("sequence_id=42")) return { results: [MOCK_ISSUE] };
    if (url.includes("sequence_id=")) return { results: [] };
    // GET single issue
    if (url.match(/\/issues\/[^/]+\/$/)) return MOCK_ISSUE;
    // GET all issues
    return { results: [MOCK_ISSUE] };
  }
  if (url.includes("/projects/")) {
    return { results: [MOCK_PROJECT] };
  }
  return {};
}

beforeEach(() => {
  captured.length = 0;
  enqueuedItems.length = 0;
  breakers.plane.reset();
  _resetTimeoutRecoveryForTesting();
  mockFetch(defaultHandler);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── isPlaneConfigured ────────────────────────────────────────

describe("isPlaneConfigured", () => {
  test("returns true when PLANE_API_KEY is set", () => {
    expect(isPlaneConfigured()).toBe(true);
  });
});

// ── getStateIdByGroup ────────────────────────────────────────

describe("getStateIdByGroup", () => {
  test("resolves state UUID for a known group", async () => {
    const stateId = await getStateIdByGroup("proj-uuid-1", "started");
    expect(stateId).toBe("state-uuid-started");
  });

  test("returns null for unknown group", async () => {
    const stateId = await getStateIdByGroup("proj-uuid-1", "nonexistent");
    expect(stateId).toBeNull();
  });
});

// ── getIssueStateGroup ───────────────────────────────────────

describe("getIssueStateGroup", () => {
  test("returns the current state group of an issue", async () => {
    const group = await getIssueStateGroup("proj-uuid-1", "issue-uuid-1");
    expect(group).toBe("started");
  });

  test("returns null when API returns no data", async () => {
    mockFetch(() => null);
    // Circuit breaker returns null when it can't call
    // Actually planeRequest wraps with breaker, which may throw or return null
    // Let's just test that it handles null gracefully
    const group = await getIssueStateGroup("proj-uuid-1", "issue-uuid-1");
    expect(group).toBeNull();
  });
});

// ── resolveWorkItemId ────────────────────────────────────────

describe("resolveWorkItemId", () => {
  test("resolves ELLIE-42 to project and issue UUIDs", async () => {
    const result = await resolveWorkItemId("ELLIE-42");
    expect(result).not.toBeNull();
    expect(result!.projectId).toBe("proj-uuid-1");
    expect(result!.issueId).toBe("issue-uuid-1");
  });

  test("returns null for malformed work item ID", async () => {
    const result = await resolveWorkItemId("not-valid");
    expect(result).toBeNull();
  });

  test("returns null for lowercase identifier", async () => {
    const result = await resolveWorkItemId("ellie-42");
    expect(result).toBeNull();
  });

  test("returns null when project not found", async () => {
    mockFetch((url) => {
      if (url.includes("/projects/")) return { results: [] };
      return {};
    });
    const result = await resolveWorkItemId("NOTFOUND-1");
    expect(result).toBeNull();
  });

  test("returns null when issue not found", async () => {
    mockFetch((url) => {
      if (url.includes("/projects/") && url.includes("/issues/")) return { results: [] };
      if (url.includes("/projects/")) return { results: [MOCK_PROJECT] };
      return {};
    });
    const result = await resolveWorkItemId("ELLIE-999");
    expect(result).toBeNull();
  });
});

// ── updateIssueState ─────────────────────────────────────────

describe("updateIssueState", () => {
  test("sends PATCH request with state UUID", async () => {
    await updateIssueState("proj-uuid-1", "issue-uuid-1", "state-uuid-completed");
    const patch = captured.find(c => c.method === "PATCH");
    expect(patch).toBeDefined();
    expect(patch!.body.state).toBe("state-uuid-completed");
  });
});

// ── addIssueComment ──────────────────────────────────────────

describe("addIssueComment", () => {
  test("sends POST request with comment HTML", async () => {
    await addIssueComment("proj-uuid-1", "issue-uuid-1", "<p>Test comment</p>");
    const post = captured.find(c => c.method === "POST");
    expect(post).toBeDefined();
    expect(post!.body.comment_html).toBe("<p>Test comment</p>");
    expect(post!.url).toContain("/comments/");
  });
});

// ── sessionCommentExists ─────────────────────────────────────

describe("sessionCommentExists", () => {
  test("returns false when no comments contain session ID", async () => {
    mockFetch((url) => {
      if (url.includes("/comments/")) return { results: [{ comment_html: "<p>some other comment</p>" }] };
      return defaultHandler(url, "GET", undefined);
    });
    const exists = await sessionCommentExists("proj-uuid-1", "issue-uuid-1", "session-abc");
    expect(exists).toBe(false);
  });

  test("returns true when a comment contains the session ID", async () => {
    mockFetch((url) => {
      if (url.includes("/comments/")) return { results: [{ comment_html: "<p>Work session started — <code>session-abc</code></p>" }] };
      return defaultHandler(url, "GET", undefined);
    });
    const exists = await sessionCommentExists("proj-uuid-1", "issue-uuid-1", "session-abc");
    expect(exists).toBe(true);
  });

  test("returns false when comments API fails", async () => {
    mockFetch(() => { throw new Error("API down"); });
    // sessionCommentExists calls listIssueComments which catches errors
    const exists = await sessionCommentExists("proj-uuid-1", "issue-uuid-1", "session-abc");
    expect(exists).toBe(false);
  });
});

// ── updateWorkItemOnSessionStart ─────────────────────────────

describe("updateWorkItemOnSessionStart", () => {
  test("resolves work item and updates state to started", async () => {
    await updateWorkItemOnSessionStart("ELLIE-42", "session-123");
    // Should have made API calls: projects, issues (resolve), states, issue (get current state), issue (PATCH state), comments (check + POST)
    const patchCalls = captured.filter(c => c.method === "PATCH");
    expect(patchCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("skips when in timeout recovery", async () => {
    setTimeoutRecoveryLock(60_000);
    captured.length = 0;
    await updateWorkItemOnSessionStart("ELLIE-42", "session-123");
    // Should not have made any fetch calls
    expect(captured.length).toBe(0);
  });

  test("handles unresolvable work item gracefully (queues for retry)", async () => {
    mockFetch((url) => {
      if (url.includes("/projects/")) return { results: [] };
      return {};
    });
    // Should not throw
    await updateWorkItemOnSessionStart("NOTFOUND-1", "session-123");
  });
});

// ── updateWorkItemOnSessionComplete ──────────────────────────

describe("updateWorkItemOnSessionComplete", () => {
  test("sets state to completed for completed status", async () => {
    await updateWorkItemOnSessionComplete("ELLIE-42", "All done", "completed");
    const patchCalls = captured.filter(c => c.method === "PATCH");
    expect(patchCalls.length).toBeGreaterThanOrEqual(1);
    // At least one PATCH should set state to completed
    const statePatch = patchCalls.find(c => c.body?.state === "state-uuid-completed");
    expect(statePatch).toBeDefined();
  });

  test("keeps state as started for blocked status", async () => {
    await updateWorkItemOnSessionComplete("ELLIE-42", "Blocked on X", "blocked");
    const patchCalls = captured.filter(c => c.method === "PATCH");
    expect(patchCalls.length).toBeGreaterThanOrEqual(1);
    // Should set to started (not completed)
    const statePatch = patchCalls.find(c => c.body?.state === "state-uuid-started");
    expect(statePatch).toBeDefined();
  });

  test("keeps state as started for paused status", async () => {
    await updateWorkItemOnSessionComplete("ELLIE-42", "Pausing", "paused");
    const patchCalls = captured.filter(c => c.method === "PATCH");
    const statePatch = patchCalls.find(c => c.body?.state === "state-uuid-started");
    expect(statePatch).toBeDefined();
  });

  test("skips when in timeout recovery", async () => {
    setTimeoutRecoveryLock(60_000);
    captured.length = 0;
    await updateWorkItemOnSessionComplete("ELLIE-42", "Done", "completed");
    expect(captured.length).toBe(0);
  });
});

// ── updateWorkItemOnFailure ──────────────────────────────────

describe("updateWorkItemOnFailure", () => {
  test("moves ticket back to unstarted on failure", async () => {
    await updateWorkItemOnFailure("ELLIE-42", "Pipeline crashed");
    const patchCalls = captured.filter(c => c.method === "PATCH");
    expect(patchCalls.length).toBeGreaterThanOrEqual(1);
    // Should set to unstarted
    const statePatch = patchCalls.find(c => c.body?.state === "state-uuid-unstarted");
    expect(statePatch).toBeDefined();
  });

  test("includes truncated error message in comment", async () => {
    await updateWorkItemOnFailure("ELLIE-42", "Pipeline crashed");
    const postCalls = captured.filter(c => c.method === "POST" && c.url.includes("/comments/"));
    expect(postCalls.length).toBeGreaterThanOrEqual(1);
    expect(postCalls[0].body.comment_html).toContain("Pipeline crashed");
    expect(postCalls[0].body.comment_html).toContain("Pipeline failed");
  });

  test("truncates long error messages to 500 chars", async () => {
    const longError = "x".repeat(600);
    await updateWorkItemOnFailure("ELLIE-42", longError);
    const postCalls = captured.filter(c => c.method === "POST" && c.url.includes("/comments/"));
    expect(postCalls.length).toBeGreaterThanOrEqual(1);
    // The error should be sliced to 500 chars
    const comment = postCalls[0].body.comment_html;
    expect(comment.length).toBeLessThan(700); // comment_html has markup + 500 chars
  });

  test("skips when in timeout recovery", async () => {
    setTimeoutRecoveryLock(60_000);
    captured.length = 0;
    await updateWorkItemOnFailure("ELLIE-42", "err");
    expect(captured.length).toBe(0);
  });

  test("handles unresolvable work item gracefully", async () => {
    mockFetch((url) => {
      if (url.includes("/projects/")) return { results: [] };
      return {};
    });
    // Should not throw
    await updateWorkItemOnFailure("NOTFOUND-1", "err");
  });
});

// ── atomicStateAndComment (tested via high-level functions) ──

describe("atomicStateAndComment — rollback behavior", () => {
  test("rolls back state when comment fails", async () => {
    let commentCallCount = 0;
    mockFetch((url, method) => {
      if (url.includes("/comments/") && method === "POST") {
        commentCallCount++;
        // Simulate comment failure
        throw new Error("Comment API failed");
      }
      return defaultHandler(url, method, undefined);
    });

    // This should trigger atomicStateAndComment, which will:
    // 1. Apply state change (succeeds)
    // 2. Try comment (fails)
    // 3. Roll back state
    // 4. Queue for retry
    await updateWorkItemOnSessionStart("ELLIE-42", "session-rollback");

    // Should have attempted comment
    expect(commentCallCount).toBeGreaterThanOrEqual(1);

    // Should have PATCHed state at least twice (apply + rollback)
    const patchCalls = captured.filter(c => c.method === "PATCH");
    expect(patchCalls.length).toBeGreaterThanOrEqual(2);
  });

  test("skips comment when session comment already exists (idempotent)", async () => {
    let commentPostCount = 0;
    mockFetch((url, method) => {
      if (url.includes("/comments/") && method === "GET") {
        return { results: [{ comment_html: "<p>Work session started — <code>session-existing</code></p>" }] };
      }
      if (url.includes("/comments/") && method === "POST") {
        commentPostCount++;
        return { id: "comment-uuid" };
      }
      return defaultHandler(url, method, undefined);
    });

    await updateWorkItemOnSessionStart("ELLIE-42", "session-existing");

    // Comment POST should not have been called because idempotency check found it
    expect(commentPostCount).toBe(0);
  });
});

// ── fetchWorkItemDetails ─────────────────────────────────────

describe("fetchWorkItemDetails", () => {
  test("returns structured work item details", async () => {
    const details = await fetchWorkItemDetails("ELLIE-42");
    expect(details).not.toBeNull();
    expect(details!.id).toBe("issue-uuid-1");
    expect(details!.name).toBe("Test Issue");
    expect(details!.priority).toBe("high");
    expect(details!.sequenceId).toBe(42);
    expect(details!.projectIdentifier).toBe("ELLIE");
  });

  test("strips HTML from description", async () => {
    const details = await fetchWorkItemDetails("ELLIE-42");
    expect(details).not.toBeNull();
    // "<p>Issue <strong>description</strong> here</p>" should become "Issue description here"
    expect(details!.description).not.toContain("<p>");
    expect(details!.description).not.toContain("<strong>");
    expect(details!.description).toContain("Issue");
    expect(details!.description).toContain("description");
    expect(details!.description).toContain("here");
  });

  test("returns null for malformed work item ID", async () => {
    const details = await fetchWorkItemDetails("invalid");
    expect(details).toBeNull();
  });

  test("returns null when project not found", async () => {
    mockFetch((url) => {
      if (url.includes("/projects/")) return { results: [] };
      return {};
    });
    const details = await fetchWorkItemDetails("NOTFOUND-1");
    expect(details).toBeNull();
  });

  test("returns null when issue not found", async () => {
    mockFetch((url) => {
      if (url.includes("/issues/")) return { results: [] };
      if (url.includes("/projects/")) return { results: [MOCK_PROJECT] };
      return {};
    });
    const details = await fetchWorkItemDetails("ELLIE-999");
    expect(details).toBeNull();
  });

  test("handles API error gracefully", async () => {
    mockFetch(() => { throw new Error("API down"); });
    const details = await fetchWorkItemDetails("ELLIE-42");
    expect(details).toBeNull();
  });
});

// ── isWorkItemDone ───────────────────────────────────────────

describe("isWorkItemDone", () => {
  test("returns true for completed state", async () => {
    mockFetch((url) => {
      if (url.includes("/issues/") && url.includes("sequence_id=")) {
        return { results: [{ ...MOCK_ISSUE, state_detail: { group: "completed" } }] };
      }
      return defaultHandler(url, "GET", undefined);
    });
    const done = await isWorkItemDone("ELLIE-42");
    expect(done).toBe(true);
  });

  test("returns true for cancelled state", async () => {
    mockFetch((url) => {
      if (url.includes("/issues/") && url.includes("sequence_id=")) {
        return { results: [{ ...MOCK_ISSUE, state_detail: { group: "cancelled" } }] };
      }
      return defaultHandler(url, "GET", undefined);
    });
    const done = await isWorkItemDone("ELLIE-42");
    expect(done).toBe(true);
  });

  test("returns false for started state", async () => {
    const done = await isWorkItemDone("ELLIE-42");
    expect(done).toBe(false);
  });

  test("returns false for malformed ID", async () => {
    const done = await isWorkItemDone("bad");
    expect(done).toBe(false);
  });

  test("returns false on API error", async () => {
    mockFetch(() => { throw new Error("API down"); });
    const done = await isWorkItemDone("ELLIE-42");
    expect(done).toBe(false);
  });
});

// ── listOpenIssues ───────────────────────────────────────────

describe("listOpenIssues", () => {
  test("returns open issues filtered from results", async () => {
    mockFetch((url) => {
      if (url.includes("/issues/")) {
        return {
          results: [
            { sequence_id: 1, name: "Open issue", priority: "high", state_detail: { group: "started" } },
            { sequence_id: 2, name: "Done issue", priority: "low", state_detail: { group: "completed" } },
            { sequence_id: 3, name: "Backlog issue", priority: "medium", state_detail: { group: "backlog" } },
          ],
        };
      }
      return defaultHandler(url, "GET", undefined);
    });

    const issues = await listOpenIssues("ELLIE");
    expect(issues.length).toBe(2); // open + backlog, not completed
    expect(issues[0].sequenceId).toBe(1);
    expect(issues[1].sequenceId).toBe(3);
  });

  test("respects limit parameter", async () => {
    mockFetch((url) => {
      if (url.includes("/issues/")) {
        return {
          results: Array.from({ length: 30 }, (_, i) => ({
            sequence_id: i + 1,
            name: `Issue ${i + 1}`,
            priority: "none",
            state_detail: { group: "started" },
          })),
        };
      }
      return defaultHandler(url, "GET", undefined);
    });

    const issues = await listOpenIssues("ELLIE", 5);
    expect(issues.length).toBe(5);
  });

  test("returns empty array when project not found", async () => {
    mockFetch((url) => {
      if (url.includes("/projects/")) return { results: [] };
      return {};
    });
    const issues = await listOpenIssues("NOTFOUND");
    expect(issues).toEqual([]);
  });

  test("returns empty array on API error", async () => {
    mockFetch(() => { throw new Error("API down"); });
    const issues = await listOpenIssues("ELLIE");
    expect(issues).toEqual([]);
  });
});

// ── createPlaneIssue ─────────────────────────────────────────

describe("createPlaneIssue", () => {
  test("creates an issue and returns id, sequenceId, identifier", async () => {
    const result = await createPlaneIssue("ELLIE", "New test issue", "Description", "high");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("new-issue-uuid");
    expect(result!.sequenceId).toBe(99);
    expect(result!.identifier).toBe("ELLIE-99");
  });

  test("sends correct request body", async () => {
    await createPlaneIssue("ELLIE", "Issue name", "Some desc", "medium");
    const postCall = captured.find(c => c.method === "POST" && c.url.includes("/issues/") && !c.url.includes("/comments/"));
    expect(postCall).toBeDefined();
    expect(postCall!.body.name).toBe("Issue name");
    expect(postCall!.body.description_html).toBe("<p>Some desc</p>");
    expect(postCall!.body.priority).toBe("medium");
  });

  test("creates issue without optional description and priority", async () => {
    const result = await createPlaneIssue("ELLIE", "Minimal issue");
    expect(result).not.toBeNull();
    const postCall = captured.find(c => c.method === "POST" && c.url.includes("/issues/") && !c.url.includes("/comments/"));
    expect(postCall!.body.name).toBe("Minimal issue");
    expect(postCall!.body.description_html).toBeUndefined();
    expect(postCall!.body.priority).toBeUndefined();
  });

  test("returns null when project not found", async () => {
    mockFetch((url) => {
      if (url.includes("/projects/")) return { results: [] };
      return {};
    });
    const result = await createPlaneIssue("NOTFOUND", "Issue");
    expect(result).toBeNull();
  });

  test("returns null on API error", async () => {
    mockFetch(() => { throw new Error("API down"); });
    const result = await createPlaneIssue("ELLIE", "Issue");
    expect(result).toBeNull();
  });
});
