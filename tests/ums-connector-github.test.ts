/**
 * UMS Connector Tests: GitHub — ELLIE-708
 */

import { describe, test, expect } from "bun:test";
import { githubConnector } from "../src/ums/connectors/github.ts";
import { githubFixtures as fx } from "./fixtures/ums-connector-payloads.ts";

describe("githubConnector", () => {
  test("provider is 'github'", () => {
    expect(githubConnector.provider).toBe("github");
  });

  // ── Event types ──────────────────────────────────────────

  test("normalizes a pull_request event", () => {
    const result = githubConnector.normalize(fx.pullRequest);
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("github");
    expect(result!.provider_id).toBe("github:pr:ellie-labs/ellie-dev#42:opened");
    expect(result!.channel).toBe("github:ellie-labs/ellie-dev");
    expect(result!.content).toBe("PR #42 opened: Add UMS connectors (ellie-labs/ellie-dev)");
    expect(result!.content_type).toBe("notification");
    expect(result!.sender).toEqual({ username: "davey" });
    expect(result!.metadata).toMatchObject({
      event_type: "pull_request",
      action: "opened",
      repo: "ellie-labs/ellie-dev",
      pr_number: 42,
      url: "https://github.com/ellie-labs/ellie-dev/pull/42",
    });
  });

  test("normalizes an issue event", () => {
    const result = githubConnector.normalize(fx.issue);
    expect(result).not.toBeNull();
    expect(result!.provider_id).toBe("github:issue:ellie-labs/ellie-dev#10:opened");
    expect(result!.content).toBe("Issue #10 opened: Bug in calendar sync (ellie-labs/ellie-dev)");
    expect(result!.metadata!.event_type).toBe("issue");
    expect(result!.metadata!.issue_number).toBe(10);
  });

  test("normalizes a comment event", () => {
    const result = githubConnector.normalize(fx.comment);
    expect(result).not.toBeNull();
    expect(result!.provider_id).toBe("github:comment:5001");
    expect(result!.content).toContain("Comment on ellie-labs/ellie-dev:");
    expect(result!.content).toContain("I can reproduce this");
    expect(result!.metadata!.event_type).toBe("comment");
    expect(result!.sender!.username).toBe("bob");
  });

  test("normalizes a CI success event", () => {
    const result = githubConnector.normalize(fx.ciCompleted);
    expect(result).not.toBeNull();
    expect(result!.provider_id).toBe("github:ci:9999:success");
    expect(result!.content).toBe("CI success: CI on main (ellie-labs/ellie-dev)");
    expect(result!.metadata!.event_type).toBe("ci");
    expect(result!.metadata!.ci_conclusion).toBe("success");
    expect(result!.metadata!.branch).toBe("main");
  });

  test("normalizes a CI failure event", () => {
    const result = githubConnector.normalize(fx.ciFailed);
    expect(result).not.toBeNull();
    expect(result!.content).toBe("CI failure: CI on feature/ums (ellie-labs/ellie-dev)");
    expect(result!.metadata!.ci_conclusion).toBe("failure");
  });

  test("normalizes a push event", () => {
    const result = githubConnector.normalize(fx.push);
    expect(result).not.toBeNull();
    expect(result!.provider_id).toBe("github:push:ellie-labs/ellie-dev:abc12345");
    expect(result!.content).toContain("Push to refs/heads/main: 2 commits");
    expect(result!.content).toContain("fix: calendar sync deletion");
    expect(result!.metadata!.event_type).toBe("push");
  });

  // ── Error / skip paths ──────────────────────────────────

  test("returns null for unknown event type", () => {
    expect(githubConnector.normalize(fx.unknownEvent)).toBeNull();
  });

  test("returns null for empty payload", () => {
    expect(githubConnector.normalize(fx.empty)).toBeNull();
  });

  test("preserves raw payload", () => {
    const result = githubConnector.normalize(fx.pullRequest);
    expect(result!.raw).toBe(fx.pullRequest);
  });
});
