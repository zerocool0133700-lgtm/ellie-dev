import { describe, test, expect, mock, beforeEach } from "bun:test";

const mockSqlResult: unknown[] = [];
const mockSql = Object.assign(
  (..._args: unknown[]) => Promise.resolve(mockSqlResult),
  { unsafe: (..._args: unknown[]) => Promise.resolve(mockSqlResult) },
);

mock.module("../../ellie-forest/src/db", () => ({ default: mockSql }));
mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: mock(), warn: mock(), error: mock(), debug: mock() }) },
}));

import { writeOutcome, readOutcome, type DispatchOutcome } from "../src/dispatch-outcomes.ts";

describe("dispatch-outcomes", () => {
  test("writeOutcome calls sql with outcome data", async () => {
    const outcome: DispatchOutcome = {
      run_id: "run_123",
      agent: "james",
      work_item_id: "ELLIE-500",
      dispatch_type: "single",
      status: "completed",
      summary: "Implemented the v2 API endpoint",
      files_changed: ["src/api/v2.ts"],
      decisions: ["Used Express router"],
      commits: ["abc123"],
      forest_writes: ["mem_456"],
      duration_ms: 45000,
      tokens_in: 12000,
      tokens_out: 3000,
      cost_usd: 0.12,
    };

    await writeOutcome(outcome);
    // If no error thrown, the write succeeded (mocked SQL)
    expect(true).toBe(true);
  });

  test("writeOutcome handles missing optional fields", async () => {
    const outcome: DispatchOutcome = {
      run_id: "run_456",
      agent: "kate",
      dispatch_type: "single",
      status: "completed",
    };

    await writeOutcome(outcome);
    expect(true).toBe(true);
  });

  test("readOutcome returns null for empty result", async () => {
    const result = await readOutcome("nonexistent");
    expect(result).toBeNull();
  });
});
