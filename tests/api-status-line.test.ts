import { describe, it, expect } from "bun:test";
import { getStatusLine, type StatusLinePayload } from "../src/api/status-line.ts";

describe("ELLIE-1025: Status line API", () => {
  // Mock dependencies
  const mockForestSql = Object.assign(
    (strings: TemplateStringsArray, ...values: any[]) => {
      const query = strings.join("?");
      if (query.includes("creatures") && query.includes("GROUP BY")) return Promise.resolve([{ state: "idle", count: 3 }]);
      if (query.includes("dispatched_at")) return Promise.resolve([]);
      if (query.includes("trees")) return Promise.resolve([{ count: 42 }]);
      if (query.includes("forest_events")) return Promise.resolve([{ count: 7 }]);
      return Promise.resolve([]);
    },
    { begin: () => {} }
  );

  const mockSupabase = {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () => ({
              single: () => Promise.resolve({ data: null }),
            }),
          }),
        }),
      }),
    }),
  };

  it("returns valid payload structure", async () => {
    const result = await getStatusLine({ forestSql: mockForestSql, supabase: mockSupabase });

    expect(result).toHaveProperty("creature");
    expect(result).toHaveProperty("ticket");
    expect(result).toHaveProperty("forestHealth");
    expect(result).toHaveProperty("system");
    expect(result).toHaveProperty("timestamp");
  });

  it("has correct creature counts", async () => {
    const result = await getStatusLine({ forestSql: mockForestSql, supabase: mockSupabase });
    expect(result.creature.pending).toBe(3);
  });

  it("handles null active session gracefully", async () => {
    const result = await getStatusLine({ forestSql: mockForestSql, supabase: mockSupabase });
    expect(result.ticket.activeWorkItemId).toBeNull();
    expect(result.ticket.title).toBeNull();
    expect(result.ticket.agentName).toBeNull();
  });

  it("returns forest tree count", async () => {
    const result = await getStatusLine({ forestSql: mockForestSql, supabase: mockSupabase });
    expect(result.forestHealth.treeCount).toBe(42);
  });

  it("returns uptime", async () => {
    const result = await getStatusLine({ forestSql: mockForestSql, supabase: mockSupabase });
    expect(result.system.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("returns ISO timestamp", async () => {
    const result = await getStatusLine({ forestSql: mockForestSql, supabase: mockSupabase });
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });
});
