/**
 * ELLIE-717: Checkpoint Report Generator Tests
 *
 * Tests extraction of done/next/blockers from working memory,
 * report generation, and message formatting.
 */

import { describe, test, expect } from "bun:test";
import type { WorkingMemorySections } from "../src/working-memory.ts";
import {
  extractDone,
  extractNext,
  extractBlockers,
  generateCheckpointReport,
  formatCheckpointMessage,
  formatCheckpointCompact,
} from "../src/checkpoint-report.ts";

// ── extractDone ──────────────────────────────────────────────

describe("extractDone", () => {
  test("extracts [x] completed tasks from task_stack", () => {
    const sections: WorkingMemorySections = {
      task_stack: "- [x] Set up database schema\n- [x] Write migration\n- [ ] Run tests",
    };
    const done = extractDone(sections);
    expect(done).toContain("Set up database schema");
    expect(done).toContain("Write migration");
    expect(done).not.toContain("Run tests");
  });

  test("extracts checkmark completed tasks", () => {
    const sections: WorkingMemorySections = {
      task_stack: "✅ Implemented timer module\n🔄 Writing tests",
    };
    const done = extractDone(sections);
    expect(done).toContain("Implemented timer module");
    expect(done).not.toContain("Writing tests");
  });

  test("falls back to conversation_thread if no completed tasks", () => {
    const sections: WorkingMemorySections = {
      task_stack: "- [ ] Everything pending",
      conversation_thread: "Started working on the checkpoint system. Reviewed the schema.",
    };
    const done = extractDone(sections);
    expect(done).toContain("checkpoint system");
  });

  test("includes recent decisions", () => {
    const sections: WorkingMemorySections = {
      task_stack: "- [x] Design complete",
      decision_log: "- Chose callback pattern for timer\n- Using JSONB for checkpoint storage",
    };
    const done = extractDone(sections);
    expect(done).toContain("Decisions:");
    expect(done).toContain("callback pattern");
  });

  test("returns default when no data", () => {
    expect(extractDone({})).toBe("Work in progress");
  });

  test("handles empty sections", () => {
    expect(extractDone({ task_stack: "", conversation_thread: "" })).toBe("Work in progress");
  });

  test("truncates long conversation_thread", () => {
    const sections: WorkingMemorySections = {
      conversation_thread: "a".repeat(500),
    };
    const done = extractDone(sections);
    expect(done.length).toBeLessThanOrEqual(210); // 200 + "…"
  });
});

// ── extractNext ──────────────────────────────────────────────

describe("extractNext", () => {
  test("extracts pending tasks from task_stack", () => {
    const sections: WorkingMemorySections = {
      task_stack: "- [x] Done task\n- [ ] Write tests\n- [ ] Deploy",
    };
    const next = extractNext(sections);
    expect(next).toContain("Write tests");
    expect(next).toContain("Deploy");
  });

  test("extracts in-progress tasks", () => {
    const sections: WorkingMemorySections = {
      task_stack: "→ Running test suite\n- [ ] Fix failures",
    };
    const next = extractNext(sections);
    expect(next).toContain("Running test suite");
  });

  test("extracts emoji-marked in-progress", () => {
    const sections: WorkingMemorySections = {
      task_stack: "🔄 Building the feature\n- [x] Done thing",
    };
    const next = extractNext(sections);
    expect(next).toContain("Building the feature");
  });

  test("falls back to resumption_prompt", () => {
    const sections: WorkingMemorySections = {
      resumption_prompt: "Continue with integration tests for the timer module",
    };
    const next = extractNext(sections);
    expect(next).toContain("integration tests");
  });

  test("returns default when no data", () => {
    expect(extractNext({})).toBe("Continuing current work");
  });

  test("limits to 3 items", () => {
    const sections: WorkingMemorySections = {
      task_stack: "- [ ] Task 1\n- [ ] Task 2\n- [ ] Task 3\n- [ ] Task 4\n- [ ] Task 5",
    };
    const next = extractNext(sections);
    const items = next.split(";");
    expect(items.length).toBeLessThanOrEqual(3);
  });
});

// ── extractBlockers ──────────────────────────────────────────

describe("extractBlockers", () => {
  test("extracts blocker lines from investigation_state", () => {
    const sections: WorkingMemorySections = {
      investigation_state: "- Exploring the API\n- BLOCKED on missing credentials\n- Reading docs",
    };
    const blockers = extractBlockers(sections);
    expect(blockers).toContain("BLOCKED on missing credentials");
  });

  test("extracts error lines from investigation_state", () => {
    const sections: WorkingMemorySections = {
      investigation_state: "- Found error in the migration script\n- Testing workaround",
    };
    const blockers = extractBlockers(sections);
    expect(blockers).toContain("error in the migration");
  });

  test("extracts errors from context_anchors", () => {
    const sections: WorkingMemorySections = {
      context_anchors: "Error: ECONNREFUSED on port 5432\nFile: src/db.ts:12",
    };
    const blockers = extractBlockers(sections);
    expect(blockers).toContain("ECONNREFUSED");
  });

  test("combines investigation_state and context_anchors", () => {
    const sections: WorkingMemorySections = {
      investigation_state: "- Stuck on auth flow",
      context_anchors: "Error: Token expired at line 45",
    };
    const blockers = extractBlockers(sections);
    expect(blockers).toContain("Stuck on auth");
    expect(blockers).toContain("Token expired");
  });

  test("returns empty string when no blockers", () => {
    const sections: WorkingMemorySections = {
      investigation_state: "- Exploring the API\n- Reading docs",
    };
    expect(extractBlockers(sections)).toBe("");
  });

  test("returns empty for empty sections", () => {
    expect(extractBlockers({})).toBe("");
  });

  test("detects warning emoji", () => {
    const sections: WorkingMemorySections = {
      investigation_state: "⚠ Rate limit approaching",
    };
    expect(extractBlockers(sections)).toContain("Rate limit");
  });
});

// ── generateCheckpointReport ─────────────────────────────────

describe("generateCheckpointReport", () => {
  test("generates complete report", () => {
    const sections: WorkingMemorySections = {
      task_stack: "- [x] Schema design\n- [ ] Timer logic\n- [ ] Tests",
      investigation_state: "- Exploring timer patterns",
      decision_log: "- Chose callback-based approach",
    };

    const report = generateCheckpointReport(sections, 25, 15, 60, 12);

    expect(report.percent).toBe(25);
    expect(report.elapsed_minutes).toBe(15);
    expect(report.estimated_total_minutes).toBe(60);
    expect(report.done).toContain("Schema design");
    expect(report.next).toContain("Timer logic");
    expect(report.blockers).toBe("");
    expect(report.turn_count).toBe(12);
  });

  test("generates report with blockers", () => {
    const sections: WorkingMemorySections = {
      task_stack: "- [x] Step 1",
      investigation_state: "- Blocked on API credentials",
    };

    const report = generateCheckpointReport(sections, 50, 30, 60);
    expect(report.blockers).toContain("Blocked on API");
  });

  test("generates report from empty sections", () => {
    const report = generateCheckpointReport({}, 75, 45, 60);
    expect(report.done).toBe("Work in progress");
    expect(report.next).toBe("Continuing current work");
    expect(report.blockers).toBe("");
  });

  test("turn_count is optional", () => {
    const report = generateCheckpointReport({}, 25, 10, 40);
    expect(report.turn_count).toBeUndefined();
  });
});

// ── formatCheckpointMessage ──────────────────────────────────

describe("formatCheckpointMessage", () => {
  const report = {
    percent: 50,
    elapsed_minutes: 30,
    estimated_total_minutes: 60,
    done: "Completed schema and timer",
    next: "Write tests",
    blockers: "",
  };

  test("formats with work item ID", () => {
    const msg = formatCheckpointMessage(report, "ELLIE-717");
    expect(msg).toContain("ELLIE-717");
    expect(msg).toContain("50%");
    expect(msg).toContain("30min elapsed");
    expect(msg).toContain("~30min remaining");
    expect(msg).toContain("Done: Completed schema");
    expect(msg).toContain("Next: Write tests");
  });

  test("formats without work item ID", () => {
    const msg = formatCheckpointMessage(report);
    expect(msg).toStartWith("50% checkpoint");
  });

  test("includes blockers when present", () => {
    const blockedReport = { ...report, blockers: "API credentials missing" };
    const msg = formatCheckpointMessage(blockedReport, "ELLIE-717");
    expect(msg).toContain("Blockers: API credentials missing");
  });

  test("omits blockers line when empty", () => {
    const msg = formatCheckpointMessage(report);
    expect(msg).not.toContain("Blockers:");
  });

  test("shows 0 remaining when elapsed > estimated", () => {
    const overReport = { ...report, elapsed_minutes: 90 };
    const msg = formatCheckpointMessage(overReport);
    expect(msg).toContain("~0min remaining");
  });
});

// ── formatCheckpointCompact ──────────────────────────────────

describe("formatCheckpointCompact", () => {
  const report = {
    percent: 25,
    elapsed_minutes: 15,
    estimated_total_minutes: 60,
    done: "Built the schema",
    next: "Timer logic",
    blockers: "",
  };

  test("formats compact with work item", () => {
    const compact = formatCheckpointCompact(report, "ELLIE-717");
    expect(compact).toContain("[ELLIE-717]");
    expect(compact).toContain("25%");
    expect(compact).toContain("15/60min");
    expect(compact).toContain("Built the schema");
  });

  test("formats compact without work item", () => {
    const compact = formatCheckpointCompact(report);
    expect(compact).not.toContain("[");
    expect(compact).toContain("25%");
  });

  test("includes BLOCKED prefix when blockers present", () => {
    const blockedReport = { ...report, blockers: "DB connection down" };
    const compact = formatCheckpointCompact(blockedReport, "ELLIE-717");
    expect(compact).toContain("BLOCKED:");
    expect(compact).toContain("DB connection down");
  });

  test("truncates long done text", () => {
    const longReport = { ...report, done: "a".repeat(200) };
    const compact = formatCheckpointCompact(longReport);
    expect(compact.length).toBeLessThan(250);
  });
});
