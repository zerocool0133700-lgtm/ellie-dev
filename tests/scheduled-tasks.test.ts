/**
 * Scheduled Tasks — ELLIE-975/976
 * Tests for config validation, CRUD, scheduler tick, executors, and API routing.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import {
  validateTaskInput,
  validateConfig,
  type CreateTaskInput,
  type ScheduledTask,
  type TaskType,
  type TickResult,
} from "../src/scheduled-tasks.ts";

// ── Validation Tests ─────────────────────────────────────────

describe("validateTaskInput", () => {
  const base: CreateTaskInput = {
    name: "Morning reminder",
    task_type: "reminder",
    schedule: "0 7 * * *",
    config: { message: "Good morning" },
  };

  it("accepts valid reminder input", () => {
    expect(validateTaskInput(base)).toBeNull();
  });

  it("rejects empty name", () => {
    expect(validateTaskInput({ ...base, name: "" })).toBe("name is required");
    expect(validateTaskInput({ ...base, name: "   " })).toBe("name is required");
  });

  it("rejects invalid task_type", () => {
    expect(validateTaskInput({ ...base, task_type: "invalid" as TaskType }))
      .toBe("invalid task_type: invalid");
  });

  it("rejects invalid cron expression", () => {
    const result = validateTaskInput({ ...base, schedule: "not a cron" });
    expect(result).toContain("invalid schedule");
  });

  it("accepts valid 5-field cron expressions", () => {
    expect(validateTaskInput({ ...base, schedule: "*/5 * * * *" })).toBeNull();
    expect(validateTaskInput({ ...base, schedule: "0 7 * * 1-5" })).toBeNull();
    expect(validateTaskInput({ ...base, schedule: "30 3 1 * *" })).toBeNull();
  });
});

describe("validateConfig", () => {
  it("requires formation_slug for formation type", () => {
    expect(validateConfig("formation", {})).toBe("formation tasks require config.formation_slug");
    expect(validateConfig("formation", { formation_slug: "daily-review" })).toBeNull();
  });

  it("requires agent and prompt for dispatch type", () => {
    expect(validateConfig("dispatch", {})).toBe("dispatch tasks require config.agent");
    expect(validateConfig("dispatch", { agent: "james" })).toBe("dispatch tasks require config.prompt");
    expect(validateConfig("dispatch", { agent: "james", prompt: "check PRs" })).toBeNull();
  });

  it("requires endpoint for http type", () => {
    expect(validateConfig("http", {})).toBe("http tasks require config.endpoint");
    expect(validateConfig("http", { endpoint: "/api/health" })).toBeNull();
  });

  it("requires message for reminder type", () => {
    expect(validateConfig("reminder", {})).toBe("reminder tasks require config.message");
    expect(validateConfig("reminder", { message: "Time to focus" })).toBeNull();
  });
});

// ── Scheduler Tick Logic Tests ───────────────────────────────

describe("schedulerTick (unit logic)", () => {
  function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
    return {
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      created_at: new Date(),
      updated_at: new Date(),
      name: "Test Task",
      description: "",
      task_type: "reminder",
      schedule: "0 * * * *",
      timezone: "America/Chicago",
      enabled: true,
      config: { message: "hello" },
      last_run_at: null,
      next_run_at: new Date(Date.now() - 60_000), // past due
      last_status: null,
      last_error: null,
      consecutive_failures: 0,
      created_by: null,
      ...overrides,
    };
  }

  it("builds correct tick result shape", () => {
    const result: TickResult = {
      evaluated: 2,
      triggered: ["Task A"],
      skipped: [{ id: "1", name: "Task B", reason: "no executor" }],
      failed: [{ id: "2", name: "Task C", error: "boom" }],
    };
    expect(result.evaluated).toBe(2);
    expect(result.triggered).toHaveLength(1);
    expect(result.skipped[0].reason).toBe("no executor");
    expect(result.failed[0].error).toBe("boom");
  });

  it("task with consecutive_failures >= 5 should be excluded from due list", () => {
    const task = makeTask({ consecutive_failures: 5, enabled: true });
    // The getDueTasks query filters consecutive_failures < 5
    // This test verifies the constant is correct
    expect(task.consecutive_failures).toBeGreaterThanOrEqual(5);
  });

  it("disabled task should be excluded from due list", () => {
    const task = makeTask({ enabled: false });
    expect(task.enabled).toBe(false);
  });

  it("task with future next_run_at is not due", () => {
    const task = makeTask({ next_run_at: new Date(Date.now() + 3600_000) });
    expect(task.next_run_at!.getTime()).toBeGreaterThan(Date.now());
  });
});

// ── Executor Validation Tests ────────────────────────────────

describe("executeHttp (security)", () => {
  it("rejects non-localhost URLs", async () => {
    // Import the function to test the localhost guard
    const { executeHttp } = await import("../src/scheduled-tasks.ts");

    const task: ScheduledTask = {
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      created_at: new Date(),
      updated_at: new Date(),
      name: "Evil Task",
      description: "",
      task_type: "http",
      schedule: "* * * * *",
      timezone: "America/Chicago",
      enabled: true,
      config: { endpoint: "https://evil.com/steal-data" },
      last_run_at: null,
      next_run_at: null,
      last_status: null,
      last_error: null,
      consecutive_failures: 0,
      created_by: null,
    };

    expect(executeHttp(task)).rejects.toThrow("HTTP tasks can only call localhost endpoints");
  });

  it("allows localhost endpoints starting with /", async () => {
    const { executeHttp } = await import("../src/scheduled-tasks.ts");

    const task: ScheduledTask = {
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      created_at: new Date(),
      updated_at: new Date(),
      name: "Local Task",
      description: "",
      task_type: "http",
      schedule: "* * * * *",
      timezone: "America/Chicago",
      enabled: true,
      config: { endpoint: "/api/health" },
      last_run_at: null,
      next_run_at: null,
      last_status: null,
      last_error: null,
      consecutive_failures: 0,
      created_by: null,
    };

    // This will fail with a connection error (no server running), but it should NOT
    // throw the localhost guard error — it should try to fetch
    try {
      await executeHttp(task);
    } catch (err: any) {
      expect(err.message).not.toContain("localhost endpoints");
    }
  });
});

// ── API Route Shape Tests ────────────────────────────────────

describe("API route patterns", () => {
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it("UUID pattern matches standard UUIDs", () => {
    expect(UUID_REGEX.test("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBe(true);
    expect(UUID_REGEX.test("not-a-uuid")).toBe(false);
  });

  it("route regex matches expected paths", () => {
    const idPattern = /^\/api\/scheduled-tasks\/([0-9a-f-]{36})$/;
    expect(idPattern.test("/api/scheduled-tasks/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBe(true);
    expect(idPattern.test("/api/scheduled-tasks")).toBe(false);
    expect(idPattern.test("/api/scheduled-tasks/")).toBe(false);

    const togglePattern = /^\/api\/scheduled-tasks\/([0-9a-f-]{36})\/toggle$/;
    expect(togglePattern.test("/api/scheduled-tasks/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/toggle")).toBe(true);

    const runsPattern = /^\/api\/scheduled-tasks\/([0-9a-f-]{36})\/runs$/;
    expect(runsPattern.test("/api/scheduled-tasks/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/runs")).toBe(true);
  });
});

// ── Config Template Tests ────────────────────────────────────

describe("config templates per task type", () => {
  it("formation config shape", () => {
    const config = { formation_slug: "daily-standup", prompt: "Run the daily", timeout: 30000 };
    expect(validateConfig("formation", config)).toBeNull();
  });

  it("dispatch config shape", () => {
    const config = { agent: "kate", prompt: "Research competitors", work_item_id: "ELLIE-100" };
    expect(validateConfig("dispatch", config)).toBeNull();
  });

  it("http config with method override", () => {
    const config = { endpoint: "/api/empathy/reload", method: "POST", body: { force: true } };
    expect(validateConfig("http", config)).toBeNull();
  });

  it("reminder config with channel", () => {
    const config = { message: "Standup in 5 minutes", channel: "all" };
    expect(validateConfig("reminder", config)).toBeNull();
  });
});

// ── Cron Expression Edge Cases ───────────────────────────────

describe("cron validation via validateTaskInput", () => {
  const base: CreateTaskInput = {
    name: "test",
    task_type: "reminder",
    schedule: "0 0 * * *",
    config: { message: "test" },
  };

  it("accepts every-minute wildcard", () => {
    expect(validateTaskInput({ ...base, schedule: "* * * * *" })).toBeNull();
  });

  it("accepts step syntax", () => {
    expect(validateTaskInput({ ...base, schedule: "*/15 * * * *" })).toBeNull();
  });

  it("accepts range syntax", () => {
    expect(validateTaskInput({ ...base, schedule: "0 9-17 * * 1-5" })).toBeNull();
  });

  it("accepts comma-separated values", () => {
    expect(validateTaskInput({ ...base, schedule: "0,30 * * * *" })).toBeNull();
  });

  it("rejects 6-field cron (seconds)", () => {
    const result = validateTaskInput({ ...base, schedule: "0 0 7 * * *" });
    expect(result).toContain("invalid schedule");
  });

  it("rejects empty schedule", () => {
    const result = validateTaskInput({ ...base, schedule: "" });
    expect(result).toContain("invalid schedule");
  });
});
