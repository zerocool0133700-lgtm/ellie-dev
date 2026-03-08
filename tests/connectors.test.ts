/**
 * ELLIE-643 — Mountain: Data source connector framework
 *
 * Tests the connector interface, registry, rate limiting, retry logic,
 * lifecycle hooks, logging, and the echo test connector.
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  registerConnector, getConnector, listConnectors,
  unregisterConnector, clearConnectors,
  runConnector, clearRateLimitState,
  getConnectorLogs, getConnectorLog, getRecentConnectorLogs,
  createEchoConnector,
} from "../../ellie-forest/src/index";
import type {
  Connector, RawRecord, NormalizedRecord, RunStats,
} from "../../ellie-forest/src/index";
import sql from "../../ellie-forest/src/db";

// Track log IDs for cleanup
const createdLogIds: string[] = [];

beforeEach(() => {
  clearConnectors();
  clearRateLimitState();
});

afterAll(async () => {
  clearConnectors();
  clearRateLimitState();
  // Clean up connector_logs created during tests
  if (createdLogIds.length > 0) {
    await sql`DELETE FROM connector_logs WHERE id = ANY(${createdLogIds})`;
  }
});

// ── Registry ──────────────────────────────────────────────────

describe("connector registry", () => {
  test("registerConnector adds to registry", () => {
    const echo = createEchoConnector();
    registerConnector(echo);
    expect(getConnector("echo")).toBe(echo);
  });

  test("registerConnector throws on duplicate name", () => {
    registerConnector(createEchoConnector());
    expect(() => registerConnector(createEchoConnector())).toThrow("already registered");
  });

  test("listConnectors returns all names", () => {
    registerConnector(createEchoConnector({ name: "a" }));
    registerConnector(createEchoConnector({ name: "b" }));
    registerConnector(createEchoConnector({ name: "c" }));
    expect(listConnectors()).toEqual(["a", "b", "c"]);
  });

  test("unregisterConnector removes by name", () => {
    registerConnector(createEchoConnector());
    expect(unregisterConnector("echo")).toBe(true);
    expect(getConnector("echo")).toBeUndefined();
  });

  test("unregisterConnector returns false for unknown", () => {
    expect(unregisterConnector("nonexistent")).toBe(false);
  });

  test("clearConnectors empties registry", () => {
    registerConnector(createEchoConnector({ name: "x" }));
    registerConnector(createEchoConnector({ name: "y" }));
    clearConnectors();
    expect(listConnectors()).toEqual([]);
  });

  test("getConnector returns undefined for unknown", () => {
    expect(getConnector("missing")).toBeUndefined();
  });
});

// ── Echo Connector ────────────────────────────────────────────

describe("echo connector", () => {
  test("creates with default records", () => {
    const echo = createEchoConnector();
    expect(echo.name).toBe("echo");
    expect(echo.description).toBe("Built-in echo connector for testing");
  });

  test("fetch returns configured records", async () => {
    const records: RawRecord[] = [
      { sourceId: "test-1", data: { msg: "hi" }, fetchedAt: new Date() },
    ];
    const echo = createEchoConnector({ records });
    const result = await echo.fetch({});
    expect(result).toHaveLength(1);
    expect(result[0].sourceId).toBe("test-1");
  });

  test("normalize converts raw to standard shape", async () => {
    const echo = createEchoConnector();
    const raw = await echo.fetch({});
    const normalized = await echo.normalize(raw);
    expect(normalized).toHaveLength(2);
    expect(normalized[0].content).toBe("Hello from echo");
    expect(normalized[0].type).toBe("fact");
    expect(normalized[0].sourceId).toBe("echo-1");
  });

  test("validate passes valid records", async () => {
    const echo = createEchoConnector();
    const raw = await echo.fetch({});
    const normalized = await echo.normalize(raw);
    const results = await echo.validate(normalized);
    expect(results.every(r => r.valid)).toBe(true);
  });

  test("validate marks specified records as invalid", async () => {
    const echo = createEchoConnector({ invalidRecords: [1] });
    const raw = await echo.fetch({});
    const normalized = await echo.normalize(raw);
    const results = await echo.validate(normalized);
    expect(results[0].valid).toBe(true);
    expect(results[1].valid).toBe(false);
    expect(results[1].errors).toContain("Marked invalid by test config");
  });

  test("fetch throws when failOnFetch is set", async () => {
    const echo = createEchoConnector({ failOnFetch: true });
    expect(echo.fetch({})).rejects.toThrow("simulated fetch failure");
  });

  test("custom name is used", () => {
    const echo = createEchoConnector({ name: "my-echo" });
    expect(echo.name).toBe("my-echo");
  });
});

// ── Runner: Full Pipeline ─────────────────────────────────────

describe("runConnector", () => {
  test("runs echo connector through full pipeline", async () => {
    const echo = createEchoConnector({ name: "test-643-echo-full" });
    registerConnector(echo);
    const stats = await runConnector("test-643-echo-full");
    createdLogIds.push(stats.logId);

    expect(stats.itemsFetched).toBe(2);
    expect(stats.itemsNormalized).toBe(2);
    expect(stats.itemsValidated).toBe(2);
    expect(stats.errors).toEqual([]);
    expect(stats.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("accepts connector instance directly", async () => {
    const echo = createEchoConnector({ name: "test-643-direct" });
    const stats = await runConnector(echo);
    createdLogIds.push(stats.logId);
    expect(stats.itemsFetched).toBe(2);
  });

  test("returns error stats on fetch failure (retries exhausted)", async () => {
    const echo = createEchoConnector({
      name: "test-643-fail",
      failOnFetch: true,
    });
    const stats = await runConnector(echo);
    createdLogIds.push(stats.logId);

    expect(stats.itemsFetched).toBe(0);
    expect(stats.errors.length).toBeGreaterThan(0);
    expect(stats.errors[0]).toContain("simulated fetch failure");
  });

  test("tracks validation errors in stats", async () => {
    const echo = createEchoConnector({
      name: "test-643-validate",
      invalidRecords: [0],
    });
    const stats = await runConnector(echo);
    createdLogIds.push(stats.logId);

    expect(stats.itemsFetched).toBe(2);
    expect(stats.itemsNormalized).toBe(2);
    expect(stats.itemsValidated).toBe(1); // only second record valid
    expect(stats.errors).toHaveLength(1);
    expect(stats.errors[0]).toContain("echo-1");
  });

  test("throws for unknown connector name", () => {
    expect(runConnector("nonexistent")).rejects.toThrow("not found in registry");
  });

  test("validates required credentials", async () => {
    const connector: Connector = {
      name: "test-643-auth",
      authRequirements: [
        { key: "api_key", description: "API key", required: true },
      ],
      async fetch() { return [] },
      async normalize(raw) { return [] },
      async validate(records) { return [] },
    };
    const stats = await runConnector(connector, {});
    createdLogIds.push(stats.logId);
    expect(stats.errors[0]).toContain("Missing required credential: api_key");
  });

  test("passes credentials to fetch when provided", async () => {
    let receivedCreds: Record<string, string> = {};
    const connector: Connector = {
      name: "test-643-creds",
      authRequirements: [
        { key: "token", description: "Auth token", required: true },
      ],
      async fetch(creds) { receivedCreds = creds; return [] },
      async normalize() { return [] },
      async validate() { return [] },
    };
    const stats = await runConnector(connector, { token: "secret123" });
    createdLogIds.push(stats.logId);
    expect(receivedCreds.token).toBe("secret123");
  });
});

// ── Lifecycle Hooks ───────────────────────────────────────────

describe("lifecycle hooks", () => {
  test("onFetch called with record count", async () => {
    let fetchCount = 0;
    const echo = createEchoConnector({ name: "test-643-hook-fetch" });
    const stats = await runConnector(echo, {}, {
      onFetch: (_name, count) => { fetchCount = count },
    });
    createdLogIds.push(stats.logId);
    expect(fetchCount).toBe(2);
  });

  test("onComplete called with stats", async () => {
    let completedStats: RunStats | null = null;
    const echo = createEchoConnector({ name: "test-643-hook-complete" });
    const stats = await runConnector(echo, {}, {
      onComplete: (_name, s) => { completedStats = s },
    });
    createdLogIds.push(stats.logId);
    expect(completedStats).not.toBeNull();
    expect(completedStats!.itemsFetched).toBe(2);
  });

  test("onError called on fetch failure", async () => {
    let errorCount = 0;
    const echo = createEchoConnector({
      name: "test-643-hook-error",
      failOnFetch: true,
    });
    const stats = await runConnector(echo, {}, {
      onError: (_name, _err) => { errorCount++ },
    });
    createdLogIds.push(stats.logId);
    // Called for each retry attempt
    expect(errorCount).toBeGreaterThan(0);
    // Final stats should reflect the failure
    expect(stats.errors.length).toBeGreaterThan(0);
  });

  test("onRateLimit called when rate limited", async () => {
    let rateLimited = false;
    const connector: Connector = {
      name: "test-643-hook-rl",
      rateLimit: { maxRequestsPerMinute: 1 },
      async fetch() { return [] },
      async normalize() { return [] },
      async validate() { return [] },
    };
    // First call uses the rate limit slot
    registerConnector(connector);
    const stats1 = await runConnector("test-643-hook-rl");
    createdLogIds.push(stats1.logId);
    // Second call should be rate limited
    const stats2 = await runConnector("test-643-hook-rl", {}, {
      onRateLimit: () => { rateLimited = true },
    });
    createdLogIds.push(stats2.logId);
    expect(rateLimited).toBe(true);
  });
});

// ── Rate Limiting ─────────────────────────────────────────────

describe("rate limiting", () => {
  test("allows requests within limit", async () => {
    const connector: Connector = {
      name: "test-643-rl-allow",
      rateLimit: { maxRequestsPerMinute: 5 },
      async fetch() { return [] },
      async normalize() { return [] },
      async validate() { return [] },
    };
    registerConnector(connector);
    const stats = await runConnector("test-643-rl-allow");
    createdLogIds.push(stats.logId);
    expect(stats.errors).toEqual([]);
  });

  test("blocks requests exceeding per-minute limit", async () => {
    const connector: Connector = {
      name: "test-643-rl-block",
      rateLimit: { maxRequestsPerMinute: 1 },
      async fetch() { return [] },
      async normalize() { return [] },
      async validate() { return [] },
    };
    registerConnector(connector);
    const stats1 = await runConnector("test-643-rl-block");
    createdLogIds.push(stats1.logId);
    const stats2 = await runConnector("test-643-rl-block");
    createdLogIds.push(stats2.logId);
    expect(stats2.errors[0]).toContain("Rate limited");
  });

  test("clearRateLimitState resets limits", async () => {
    const connector: Connector = {
      name: "test-643-rl-clear",
      rateLimit: { maxRequestsPerMinute: 1 },
      async fetch() { return [] },
      async normalize() { return [] },
      async validate() { return [] },
    };
    registerConnector(connector);
    const stats1 = await runConnector("test-643-rl-clear");
    createdLogIds.push(stats1.logId);

    clearRateLimitState("test-643-rl-clear");

    const stats2 = await runConnector("test-643-rl-clear");
    createdLogIds.push(stats2.logId);
    expect(stats2.errors).toEqual([]);
  });
});

// ── Logging ───────────────────────────────────────────────────

describe("connector logging", () => {
  test("creates log entry on successful run", async () => {
    const echo = createEchoConnector({ name: "test-643-log-ok" });
    const stats = await runConnector(echo);
    createdLogIds.push(stats.logId);

    const log = await getConnectorLog(stats.logId);
    expect(log).not.toBeNull();
    expect(log!.connector_name).toBe("test-643-log-ok");
    expect(log!.status).toBe("completed");
    expect(log!.items_fetched).toBe(2);
    expect(log!.items_normalized).toBe(2);
    expect(log!.items_validated).toBe(2);
    expect(log!.duration_ms).toBeGreaterThanOrEqual(0);
    expect(log!.completed_at).toBeInstanceOf(Date);
  });

  test("creates log entry on failure", async () => {
    const echo = createEchoConnector({ name: "test-643-log-fail", failOnFetch: true });
    const stats = await runConnector(echo);
    createdLogIds.push(stats.logId);

    const log = await getConnectorLog(stats.logId);
    expect(log!.status).toBe("failed");
    expect(log!.errors.length).toBeGreaterThan(0);
  });

  test("creates log entry on rate limit", async () => {
    const connector: Connector = {
      name: "test-643-log-rl",
      rateLimit: { maxRequestsPerMinute: 1 },
      async fetch() { return [] },
      async normalize() { return [] },
      async validate() { return [] },
    };
    registerConnector(connector);
    const stats1 = await runConnector("test-643-log-rl");
    createdLogIds.push(stats1.logId);
    const stats2 = await runConnector("test-643-log-rl");
    createdLogIds.push(stats2.logId);

    const log = await getConnectorLog(stats2.logId);
    expect(log!.status).toBe("rate_limited");
  });

  test("getConnectorLogs returns logs for specific connector", async () => {
    const echo = createEchoConnector({ name: "test-643-log-list" });
    const s1 = await runConnector(echo);
    createdLogIds.push(s1.logId);
    clearRateLimitState();
    const s2 = await runConnector(echo);
    createdLogIds.push(s2.logId);

    const logs = await getConnectorLogs("test-643-log-list");
    const relevantLogs = logs.filter(l =>
      l.id === s1.logId || l.id === s2.logId
    );
    expect(relevantLogs).toHaveLength(2);
  });

  test("getRecentConnectorLogs returns across all connectors", async () => {
    const e1 = createEchoConnector({ name: "test-643-recent-a" });
    const e2 = createEchoConnector({ name: "test-643-recent-b" });
    const s1 = await runConnector(e1);
    createdLogIds.push(s1.logId);
    const s2 = await runConnector(e2);
    createdLogIds.push(s2.logId);

    const logs = await getRecentConnectorLogs(50);
    const names = logs.map(l => l.connector_name);
    expect(names).toContain("test-643-recent-a");
    expect(names).toContain("test-643-recent-b");
  });

  test("getConnectorLog returns null for unknown ID", async () => {
    const log = await getConnectorLog("00000000-0000-0000-0000-000000000000");
    expect(log).toBeNull();
  });
});

// ── Custom Connector ──────────────────────────────────────────

describe("custom connector implementation", () => {
  test("custom connector passes full pipeline", async () => {
    const customConnector: Connector = {
      name: "test-643-custom",
      description: "Custom test connector",
      authRequirements: [
        { key: "api_key", description: "Test API key", required: false },
      ],
      schedule: { type: "polling", intervalMs: 60_000 },

      async fetch() {
        return [
          { sourceId: "c-1", data: { title: "Article 1", body: "Content here" }, fetchedAt: new Date() },
          { sourceId: "c-2", data: { title: "Article 2", body: "More content" }, fetchedAt: new Date() },
          { sourceId: "c-3", data: { title: "", body: "" }, fetchedAt: new Date() },
        ];
      },

      async normalize(raw) {
        return raw.map(r => ({
          content: `${r.data.title}: ${r.data.body}`,
          type: "finding",
          metadata: { source: "custom" },
          sourceId: r.sourceId,
        }));
      },

      async validate(records) {
        return records.map(r => ({
          valid: r.content.length > 2,
          record: r,
          errors: r.content.length <= 2 ? ["Content too short"] : undefined,
        }));
      },
    };

    const stats = await runConnector(customConnector);
    createdLogIds.push(stats.logId);

    expect(stats.itemsFetched).toBe(3);
    expect(stats.itemsNormalized).toBe(3);
    expect(stats.itemsValidated).toBe(2); // third record has empty title+body = ": " (2 chars, not > 2)
    expect(stats.errors).toHaveLength(1);
    expect(stats.errors[0]).toContain("c-3");
    expect(stats.errors[0]).toContain("Content too short");
  });
});
