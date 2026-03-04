/**
 * ELLIE-530 — Work Trail format validator tests
 *
 * Covers all pure functions in src/work-trail.ts:
 * - isValidIso8601: date/datetime parsing
 * - validateWorkTrail: frontmatter + section validation
 * - parseWorkTrailPath: path convention parsing
 * - buildWorkTrailPath: canonical path construction
 */

import { describe, test, expect } from "bun:test";
import {
  isValidIso8601,
  validateWorkTrail,
  parseWorkTrailPath,
  buildWorkTrailPath,
  WORK_TRAIL_STATUSES,
  REQUIRED_SECTIONS,
} from "../src/work-trail.ts";

// ── Shared fixtures ────────────────────────────────────────────────────────────

const VALID_FM = {
  work_item_id: "ELLIE-530",
  status: "in-progress" as const,
  started_at: "2026-03-04T12:00:00Z",
};

const VALID_BODY = [
  "## Context",
  "Some context.",
  "## What Was Done",
  "Did things.",
  "## Files Changed",
  "| File | Change |",
  "## Decisions",
  "Made choices.",
].join("\n");

// ── isValidIso8601 ─────────────────────────────────────────────────────────────

describe("isValidIso8601 — valid inputs", () => {
  test("full UTC datetime", () => {
    expect(isValidIso8601("2026-03-04T12:00:00Z")).toBe(true);
  });

  test("datetime with offset", () => {
    expect(isValidIso8601("2026-03-04T06:00:00-06:00")).toBe(true);
  });

  test("datetime with milliseconds", () => {
    expect(isValidIso8601("2026-03-04T12:00:00.000Z")).toBe(true);
  });

  test("date-only YYYY-MM-DD", () => {
    expect(isValidIso8601("2026-03-04")).toBe(true);
  });
});

describe("isValidIso8601 — invalid inputs", () => {
  test("empty string", () => {
    expect(isValidIso8601("")).toBe(false);
  });

  test("plain text", () => {
    expect(isValidIso8601("not a date")).toBe(false);
  });

  test("numeric only", () => {
    expect(isValidIso8601("20260304")).toBe(false);
  });

  test("datetime without T separator", () => {
    expect(isValidIso8601("2026-03-04 12:00:00")).toBe(false);
  });

  test("invalid month", () => {
    expect(isValidIso8601("2026-13-04")).toBe(false);
  });
});

// ── validateWorkTrail — valid ──────────────────────────────────────────────────

describe("validateWorkTrail — valid documents", () => {
  test("all required fields and sections → valid", () => {
    const result = validateWorkTrail(VALID_FM, VALID_BODY);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("all statuses are accepted", () => {
    for (const status of WORK_TRAIL_STATUSES) {
      const result = validateWorkTrail({ ...VALID_FM, status }, VALID_BODY);
      expect(result.valid).toBe(true);
    }
  });

  test("optional fields don't cause errors when absent", () => {
    const result = validateWorkTrail(VALID_FM, VALID_BODY);
    expect(result.valid).toBe(true);
  });

  test("optional completed_at as valid ISO timestamp → accepted", () => {
    const fm = { ...VALID_FM, completed_at: "2026-03-04T14:00:00Z" };
    const result = validateWorkTrail(fm, VALID_BODY);
    expect(result.valid).toBe(true);
  });

  test("completed_at: null → accepted", () => {
    const fm = { ...VALID_FM, completed_at: null };
    const result = validateWorkTrail(fm, VALID_BODY);
    expect(result.valid).toBe(true);
  });

  test("extra frontmatter fields don't cause errors", () => {
    const fm = { ...VALID_FM, agent: "claude-code", scope_path: "2/1", custom: "x" };
    const result = validateWorkTrail(fm, VALID_BODY);
    expect(result.valid).toBe(true);
  });

  test("single-letter project identifiers (P-99) are valid", () => {
    const result = validateWorkTrail({ ...VALID_FM, work_item_id: "P-99" }, VALID_BODY);
    expect(result.valid).toBe(true);
  });

  test("date-only started_at (YYYY-MM-DD) is valid", () => {
    const result = validateWorkTrail({ ...VALID_FM, started_at: "2026-03-04" }, VALID_BODY);
    expect(result.valid).toBe(true);
  });
});

// ── validateWorkTrail — frontmatter errors ────────────────────────────────────

describe("validateWorkTrail — work_item_id errors", () => {
  test("missing work_item_id → error", () => {
    const { work_item_id: _, ...fm } = VALID_FM;
    const result = validateWorkTrail(fm, VALID_BODY);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "work_item_id")).toBe(true);
  });

  test("work_item_id is a number → error", () => {
    const result = validateWorkTrail({ ...VALID_FM, work_item_id: 530 }, VALID_BODY);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "work_item_id")).toBe(true);
  });

  test("lowercase work_item_id (ellie-530) → invalid format error", () => {
    const result = validateWorkTrail({ ...VALID_FM, work_item_id: "ellie-530" }, VALID_BODY);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "work_item_id")).toBe(true);
  });

  test("work_item_id with no digits (ELLIE-) → invalid format", () => {
    const result = validateWorkTrail({ ...VALID_FM, work_item_id: "ELLIE-" }, VALID_BODY);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "work_item_id")).toBe(true);
  });
});

describe("validateWorkTrail — status errors", () => {
  test("missing status → error", () => {
    const { status: _, ...fm } = VALID_FM;
    const result = validateWorkTrail(fm, VALID_BODY);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "status")).toBe(true);
  });

  test("unknown status → error", () => {
    const result = validateWorkTrail({ ...VALID_FM, status: "completed" }, VALID_BODY);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "status")).toBe(true);
  });
});

describe("validateWorkTrail — started_at errors", () => {
  test("missing started_at → error", () => {
    const { started_at: _, ...fm } = VALID_FM;
    const result = validateWorkTrail(fm, VALID_BODY);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "started_at")).toBe(true);
  });

  test("started_at not ISO 8601 → error", () => {
    const result = validateWorkTrail({ ...VALID_FM, started_at: "March 4, 2026" }, VALID_BODY);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "started_at")).toBe(true);
  });
});

describe("validateWorkTrail — completed_at errors", () => {
  test("completed_at present but not ISO → error", () => {
    const result = validateWorkTrail({ ...VALID_FM, completed_at: "sometime later" }, VALID_BODY);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "completed_at")).toBe(true);
  });
});

// ── validateWorkTrail — section errors ────────────────────────────────────────

describe("validateWorkTrail — missing sections", () => {
  for (const section of REQUIRED_SECTIONS) {
    test(`missing ${section} → error`, () => {
      const bodyWithout = VALID_BODY.replace(section, "## Other");
      const result = validateWorkTrail(VALID_FM, bodyWithout);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === "body" && e.message.includes(section))).toBe(true);
    });
  }

  test("all sections missing → 4 body errors", () => {
    const result = validateWorkTrail(VALID_FM, "No sections here.");
    const bodyErrors = result.errors.filter(e => e.field === "body");
    expect(bodyErrors).toHaveLength(REQUIRED_SECTIONS.length);
  });

  test("empty body → all section errors", () => {
    const result = validateWorkTrail(VALID_FM, "");
    expect(result.errors.filter(e => e.field === "body")).toHaveLength(REQUIRED_SECTIONS.length);
  });
});

// ── validateWorkTrail — multiple errors ───────────────────────────────────────

describe("validateWorkTrail — multiple simultaneous errors", () => {
  test("missing work_item_id and status → 2 errors", () => {
    const fm = { started_at: "2026-03-04T12:00:00Z" };
    const result = validateWorkTrail(fm, VALID_BODY);
    expect(result.errors.filter(e => ["work_item_id", "status"].includes(e.field))).toHaveLength(2);
  });

  test("empty frontmatter + empty body → all errors", () => {
    const result = validateWorkTrail({}, "");
    expect(result.valid).toBe(false);
    // 3 required FM fields + 4 required sections = at least 7 errors
    expect(result.errors.length).toBeGreaterThanOrEqual(7);
  });
});

// ── parseWorkTrailPath ────────────────────────────────────────────────────────

describe("parseWorkTrailPath — valid paths", () => {
  test("canonical path parses correctly", () => {
    const result = parseWorkTrailPath("work-trails/ELLIE-530/ELLIE-530-2026-03-04.md");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.info.ticketId).toBe("ELLIE-530");
      expect(result.info.date).toBe("2026-03-04");
    }
  });

  test("single-letter project (P-99)", () => {
    const result = parseWorkTrailPath("work-trails/P-99/P-99-2026-01-15.md");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.info.ticketId).toBe("P-99");
      expect(result.info.date).toBe("2026-01-15");
    }
  });

  test("EVE-style identifier", () => {
    const result = parseWorkTrailPath("work-trails/EVE-3/EVE-3-2026-06-01.md");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.info.ticketId).toBe("EVE-3");
    }
  });

  test("multi-digit ticket number", () => {
    const result = parseWorkTrailPath("work-trails/ELLIE-1234/ELLIE-1234-2026-12-31.md");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.info.ticketId).toBe("ELLIE-1234");
      expect(result.info.date).toBe("2026-12-31");
    }
  });
});

describe("parseWorkTrailPath — invalid paths", () => {
  test("empty string → error", () => {
    const result = parseWorkTrailPath("");
    expect(result.ok).toBe(false);
  });

  test("wrong top-level directory", () => {
    const result = parseWorkTrailPath("notes/ELLIE-530/ELLIE-530-2026-03-04.md");
    expect(result.ok).toBe(false);
  });

  test("missing date in filename", () => {
    const result = parseWorkTrailPath("work-trails/ELLIE-530/ELLIE-530.md");
    expect(result.ok).toBe(false);
  });

  test("lowercase ticket in path", () => {
    const result = parseWorkTrailPath("work-trails/ellie-530/ellie-530-2026-03-04.md");
    expect(result.ok).toBe(false);
  });

  test("ticket ID mismatch between directory and filename", () => {
    const result = parseWorkTrailPath("work-trails/ELLIE-530/ELLIE-531-2026-03-04.md");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("mismatch");
    }
  });

  test("not a .md extension", () => {
    const result = parseWorkTrailPath("work-trails/ELLIE-530/ELLIE-530-2026-03-04.txt");
    expect(result.ok).toBe(false);
  });

  test("path traversal attempt", () => {
    const result = parseWorkTrailPath("work-trails/../ELLIE-530/ELLIE-530-2026-03-04.md");
    expect(result.ok).toBe(false);
  });
});

// ── buildWorkTrailPath ────────────────────────────────────────────────────────

describe("buildWorkTrailPath", () => {
  test("builds canonical path from ticketId and date", () => {
    expect(buildWorkTrailPath("ELLIE-530", "2026-03-04")).toBe(
      "work-trails/ELLIE-530/ELLIE-530-2026-03-04.md",
    );
  });

  test("result is parseable by parseWorkTrailPath", () => {
    const path = buildWorkTrailPath("ELLIE-512", "2026-02-28");
    const parsed = parseWorkTrailPath(path);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.info.ticketId).toBe("ELLIE-512");
      expect(parsed.info.date).toBe("2026-02-28");
    }
  });

  test("default date is today (YYYY-MM-DD format)", () => {
    const path = buildWorkTrailPath("ELLIE-530");
    expect(path).toMatch(/^work-trails\/ELLIE-530\/ELLIE-530-\d{4}-\d{2}-\d{2}\.md$/);
  });

  test("single-letter project", () => {
    expect(buildWorkTrailPath("P-1", "2026-01-01")).toBe("work-trails/P-1/P-1-2026-01-01.md");
  });
});

// ── Constants ─────────────────────────────────────────────────────────────────

describe("WORK_TRAIL_STATUSES constant", () => {
  test("contains in-progress, done, blocked", () => {
    expect(WORK_TRAIL_STATUSES).toContain("in-progress");
    expect(WORK_TRAIL_STATUSES).toContain("done");
    expect(WORK_TRAIL_STATUSES).toContain("blocked");
    expect(WORK_TRAIL_STATUSES).toHaveLength(3);
  });
});

describe("REQUIRED_SECTIONS constant", () => {
  test("contains all 4 required sections", () => {
    expect(REQUIRED_SECTIONS).toContain("## Context");
    expect(REQUIRED_SECTIONS).toContain("## What Was Done");
    expect(REQUIRED_SECTIONS).toContain("## Files Changed");
    expect(REQUIRED_SECTIONS).toContain("## Decisions");
    expect(REQUIRED_SECTIONS).toHaveLength(4);
  });
});
