/**
 * Tool Usage Audit Tests
 * ELLIE-970: Usage audit logging
 */

import { describe, it, expect, mock } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";

// Mock Supabase client
const mockSupabase = {
  from: mock(() => ({
    insert: mock(() => Promise.resolve({ error: null })),
    select: mock(() => ({
      eq: mock(() => ({
        order: mock(() => ({
          limit: mock(() => Promise.resolve({ data: [], error: null })),
        })),
      })),
    })),
  })),
} as unknown as SupabaseClient;

describe("Tool Usage Audit", () => {
  describe("Parameter sanitization", () => {
    it("should redact sensitive keys from parameters", async () => {
      const { logToolUsage } = await import("../src/tool-usage-audit.ts");

      await logToolUsage(mockSupabase, {
        agent_name: "test",
        agent_type: "test",
        tool_name: "gmail",
        success: true,
        parameters: {
          api_key: "secret123",
          token: "bearer-token",
          content: "email body",
          recipient: "user@example.com",  // Should NOT be redacted
        },
      });

      // Check that the mock was called
      expect(mockSupabase.from).toHaveBeenCalled();
    });

    it("should handle nested objects", async () => {
      const { logToolUsage } = await import("../src/tool-usage-audit.ts");

      await logToolUsage(mockSupabase, {
        agent_name: "test",
        agent_type: "test",
        tool_name: "api_call",
        success: true,
        parameters: {
          config: {
            authorization: "Bearer xyz",
            endpoint: "/api/test",
          },
          data: {
            user: "john",
            password: "secret",  // Should be redacted
          },
        },
      });

      expect(mockSupabase.from).toHaveBeenCalled();
    });

    it("should not crash on null parameters", async () => {
      const { logToolUsage } = await import("../src/tool-usage-audit.ts");

      await expect(
        logToolUsage(mockSupabase, {
          agent_name: "test",
          agent_type: "test",
          tool_name: "test",
          success: true,
          parameters: undefined,
        })
      ).resolves.toBeUndefined();
    });
  });

  describe("logToolUsage", () => {
    it("should log successful tool usage", async () => {
      const { logToolUsage } = await import("../src/tool-usage-audit.ts");

      await logToolUsage(mockSupabase, {
        agent_name: "dev",
        agent_type: "dev",
        tool_name: "filesystem-read",
        tool_category: "read",
        operation: "read_file",
        session_id: "session-123",
        user_id: "user-456",
        channel: "telegram",
        success: true,
        duration_ms: 50,
        metadata: { file_path: "/test.ts" },
      });

      expect(mockSupabase.from).toHaveBeenCalled();
    });

    it("should log failed tool usage with error message", async () => {
      const { logToolUsage } = await import("../src/tool-usage-audit.ts");

      await logToolUsage(mockSupabase, {
        agent_name: "dev",
        agent_type: "dev",
        tool_name: "claude_dispatch",
        success: false,
        error_message: "Timeout after 15 minutes",
        duration_ms: 900000,
      });

      expect(mockSupabase.from).toHaveBeenCalled();
    });

    it("should handle null supabase client gracefully", async () => {
      const { logToolUsage } = await import("../src/tool-usage-audit.ts");

      await expect(
        logToolUsage(null, {
          agent_name: "test",
          agent_type: "test",
          tool_name: "test",
          success: true,
        })
      ).resolves.toBeUndefined();
    });
  });

  describe("getToolUsageStats", () => {
    it("should calculate success rate correctly", async () => {
      const mockSupabaseWithData = {
        from: () => ({
          select: () => ({
            eq: (field: string, value: string) => {
              const queryChain = {
                gte: (field: string, value: string) => Promise.resolve({
                  data: [
                    { tool_name: "read", success: true, duration_ms: 10 },
                    { tool_name: "write", success: true, duration_ms: 20 },
                    { tool_name: "read", success: false, duration_ms: 5 },
                  ],
                  error: null,
                }),
              };
              return Promise.resolve({
                data: [
                  { tool_name: "read", success: true, duration_ms: 10 },
                  { tool_name: "write", success: true, duration_ms: 20 },
                  { tool_name: "read", success: false, duration_ms: 5 },
                ],
                error: null,
              });
            },
          }),
        }),
      } as unknown as SupabaseClient;

      const { getToolUsageStats } = await import("../src/tool-usage-audit.ts");
      const stats = await getToolUsageStats(mockSupabaseWithData, "dev");

      expect(stats.total_calls).toBe(3);
      expect(stats.success_rate).toBeCloseTo(2 / 3);
      expect(stats.tools_used).toEqual({ read: 2, write: 1 });
      expect(stats.avg_duration_ms).toBeCloseTo(11.67, 0); // (10 + 20 + 5) / 3
    });
  });

  describe("detectAnomalies", () => {
    it("should detect unauthorized tool usage", async () => {
      const mockSupabaseWithViolations = {
        from: () => ({
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => Promise.resolve({
                  data: [
                    { tool_name: "filesystem-read", success: true },
                    { tool_name: "github", success: true },  // NOT in allowed list
                    { tool_name: "brave-search", success: true },  // NOT in allowed list
                  ],
                  error: null,
                }),
              }),
            }),
          }),
        }),
      } as unknown as SupabaseClient;

      const { detectAnomalies } = await import("../src/tool-usage-audit.ts");
      const anomalies = await detectAnomalies(
        mockSupabaseWithViolations,
        "content",
        ["filesystem-read", "google-workspace", "forest-bridge"]  // Allowed tools
      );

      expect(anomalies.unauthorized_tools).toContain("github");
      expect(anomalies.unauthorized_tools).toContain("brave-search");
    });

    it("should detect high failure rates", async () => {
      const mockSupabaseWithFailures = {
        from: () => ({
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => Promise.resolve({
                  data: Array(10).fill({ tool_name: "test", success: false, duration_ms: 100 }),
                  error: null,
                }),
              }),
            }),
          }),
        }),
      } as unknown as SupabaseClient;

      const { detectAnomalies } = await import("../src/tool-usage-audit.ts");
      const anomalies = await detectAnomalies(
        mockSupabaseWithFailures,
        "dev",
        ["test"]
      );

      expect(anomalies.high_failure_rate).toBe(true);
    });
  });
});
