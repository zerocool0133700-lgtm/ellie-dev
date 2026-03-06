/**
 * Finding Forest Writer Tests — ELLIE-586
 *
 * Validates:
 *  - buildForestFinding() produces correct Bridge API payloads
 *  - writeFindingToForest() calls Bridge API correctly
 *  - writeFindingToForest() handles errors gracefully (non-fatal)
 */

import { describe, it, expect, mock } from "bun:test";
import { buildForestFinding, writeFindingToForest, type ForestFindingPayload } from "../src/finding-forest-writer.ts";

// Mock relay-config to control RELAY_BASE_URL in tests
mock.module("../src/relay-config.ts", () => ({
  RELAY_BASE_URL: "http://test-relay:3001",
}));

// ── buildForestFinding (pure) ───────────────────────────────────────────────

describe("buildForestFinding", () => {
  it("builds a valid finding payload", () => {
    const result = buildForestFinding("ELLIE-100", "Root cause: missing null check in parser");
    expect(result.type).toBe("finding");
    expect(result.scope_path).toBe("2/1");
    expect(result.confidence).toBe(0.7);
    expect(result.content).toBe("ELLIE-100: Root cause: missing null check in parser");
    expect(result.metadata.work_item_id).toBe("ELLIE-100");
    expect(result.metadata.source).toBe("work-session");
  });

  it("includes agent when provided", () => {
    const result = buildForestFinding("ELLIE-200", "Bug found", "dev");
    expect(result.metadata.agent).toBe("dev");
  });

  it("leaves agent undefined when not provided", () => {
    const result = buildForestFinding("ELLIE-300", "Some finding");
    expect(result.metadata.agent).toBeUndefined();
  });

  it("uses default confidence of 0.7", () => {
    const result = buildForestFinding("ELLIE-400", "discovery");
    expect(result.confidence).toBe(0.7);
  });

  it("accepts custom confidence", () => {
    const result = buildForestFinding("ELLIE-500", "verified root cause", undefined, 0.95);
    expect(result.confidence).toBe(0.95);
  });

  it("concatenates work item ID and message in content", () => {
    const result = buildForestFinding("ELLIE-42", "Race condition in WS handler");
    expect(result.content).toContain("ELLIE-42");
    expect(result.content).toContain("Race condition in WS handler");
  });

  it("always uses scope_path 2/1 (ellie-dev)", () => {
    const result = buildForestFinding("ELLIE-1", "test");
    expect(result.scope_path).toBe("2/1");
  });
});

// ── writeFindingToForest (effectful) ────────────────────────────────────────

describe("writeFindingToForest", () => {
  it("calls Bridge API with correct URL and payload", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url as string;
      capturedInit = init;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    const result = await writeFindingToForest("ELLIE-50", "Bug: timeout in auth flow", "dev", 0.8, mockFetch as typeof fetch);

    expect(result).toBe(true);
    expect(capturedUrl).toBe("http://test-relay:3001/api/bridge/write");
    expect(capturedInit?.method).toBe("POST");

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["x-bridge-key"]).toStartWith("bk_");

    const body = JSON.parse(capturedInit?.body as string) as ForestFindingPayload;
    expect(body.type).toBe("finding");
    expect(body.confidence).toBe(0.8);
    expect(body.metadata.work_item_id).toBe("ELLIE-50");
    expect(body.metadata.agent).toBe("dev");
  });

  it("returns false on non-200 response", async () => {
    const mockFetch = async () => new Response("error", { status: 500 });
    const result = await writeFindingToForest("ELLIE-51", "msg", undefined, undefined, mockFetch as typeof fetch);
    expect(result).toBe(false);
  });

  it("returns false on network error", async () => {
    const mockFetch = async () => { throw new Error("ECONNREFUSED"); };
    const result = await writeFindingToForest("ELLIE-52", "msg", undefined, undefined, mockFetch as typeof fetch);
    expect(result).toBe(false);
  });

  it("never throws — errors are caught internally", async () => {
    const mockFetch = async () => { throw new Error("boom"); };
    const result = await writeFindingToForest("ELLIE-53", "msg", undefined, undefined, mockFetch as typeof fetch);
    expect(result).toBe(false);
  });

  it("uses default confidence when not specified", async () => {
    let capturedBody: ForestFindingPayload | null = null;

    const mockFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    await writeFindingToForest("ELLIE-54", "finding", "research", undefined, mockFetch as typeof fetch);
    expect(capturedBody!.confidence).toBe(0.7);
  });

  it("passes custom confidence through to payload", async () => {
    let capturedBody: ForestFindingPayload | null = null;

    const mockFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    await writeFindingToForest("ELLIE-55", "verified finding", undefined, 0.95, mockFetch as typeof fetch);
    expect(capturedBody!.confidence).toBe(0.95);
  });

  it("works without agent or confidence parameters", async () => {
    let capturedBody: ForestFindingPayload | null = null;

    const mockFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    const result = await writeFindingToForest("ELLIE-56", "bare finding", undefined, undefined, mockFetch as typeof fetch);
    expect(result).toBe(true);
    expect(capturedBody!.metadata.agent).toBeUndefined();
    expect(capturedBody!.confidence).toBe(0.7);
  });
});
