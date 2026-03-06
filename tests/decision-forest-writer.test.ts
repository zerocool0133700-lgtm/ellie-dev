/**
 * Decision Forest Writer Tests — ELLIE-585
 *
 * Validates:
 *  - buildForestDecision() produces correct Bridge API payloads
 *  - writeDecisionToForest() calls Bridge API correctly
 *  - writeDecisionToForest() handles errors gracefully (non-fatal)
 */

import { describe, it, expect, mock } from "bun:test";
import { buildForestDecision, writeDecisionToForest, type ForestDecision } from "../src/decision-forest-writer.ts";

// Mock relay-config to control RELAY_BASE_URL in tests
mock.module("../src/relay-config.ts", () => ({
  RELAY_BASE_URL: "http://test-relay:3001",
}));

// ── buildForestDecision (pure) ──────────────────────────────────────────────

describe("buildForestDecision", () => {
  it("builds a valid decision payload", () => {
    const result = buildForestDecision("ELLIE-100", "Using X because Y");
    expect(result.type).toBe("decision");
    expect(result.scope_path).toBe("2/1");
    expect(result.confidence).toBe(0.8);
    expect(result.content).toBe("ELLIE-100: Using X because Y");
    expect(result.metadata.work_item_id).toBe("ELLIE-100");
    expect(result.metadata.source).toBe("work-session");
  });

  it("includes agent when provided", () => {
    const result = buildForestDecision("ELLIE-200", "Chose approach A", "dev");
    expect(result.metadata.agent).toBe("dev");
  });

  it("leaves agent undefined when not provided", () => {
    const result = buildForestDecision("ELLIE-300", "Some decision");
    expect(result.metadata.agent).toBeUndefined();
  });

  it("concatenates work item ID and message in content", () => {
    const result = buildForestDecision("ELLIE-42", "Split into phases");
    expect(result.content).toContain("ELLIE-42");
    expect(result.content).toContain("Split into phases");
  });

  it("always uses scope_path 2/1 (ellie-dev)", () => {
    const result = buildForestDecision("ELLIE-1", "test");
    expect(result.scope_path).toBe("2/1");
  });
});

// ── writeDecisionToForest (effectful) ───────────────────────────────────────

describe("writeDecisionToForest", () => {
  it("calls Bridge API with correct URL and payload", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url as string;
      capturedInit = init;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    const result = await writeDecisionToForest("ELLIE-50", "Decision msg", "dev", mockFetch as typeof fetch);

    expect(result).toBe(true);
    expect(capturedUrl).toBe("http://test-relay:3001/api/bridge/write");
    expect(capturedInit?.method).toBe("POST");

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["x-bridge-key"]).toStartWith("bk_");

    const body = JSON.parse(capturedInit?.body as string) as ForestDecision;
    expect(body.type).toBe("decision");
    expect(body.metadata.work_item_id).toBe("ELLIE-50");
    expect(body.metadata.agent).toBe("dev");
  });

  it("returns false on non-200 response", async () => {
    const mockFetch = async () => new Response("error", { status: 500 });
    const result = await writeDecisionToForest("ELLIE-51", "msg", undefined, mockFetch as typeof fetch);
    expect(result).toBe(false);
  });

  it("returns false on network error", async () => {
    const mockFetch = async () => { throw new Error("ECONNREFUSED"); };
    const result = await writeDecisionToForest("ELLIE-52", "msg", undefined, mockFetch as typeof fetch);
    expect(result).toBe(false);
  });

  it("never throws — errors are caught internally", async () => {
    const mockFetch = async () => { throw new Error("boom"); };
    // Should not throw
    const result = await writeDecisionToForest("ELLIE-53", "msg", undefined, mockFetch as typeof fetch);
    expect(result).toBe(false);
  });

  it("passes agent through to the payload", async () => {
    let capturedBody: ForestDecision | null = null;

    const mockFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    await writeDecisionToForest("ELLIE-54", "decision", "research", mockFetch as typeof fetch);
    expect(capturedBody!.metadata.agent).toBe("research");
  });

  it("works without agent parameter", async () => {
    let capturedBody: ForestDecision | null = null;

    const mockFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    const result = await writeDecisionToForest("ELLIE-55", "no agent decision", undefined, mockFetch as typeof fetch);
    expect(result).toBe(true);
    expect(capturedBody!.metadata.agent).toBeUndefined();
  });
});
