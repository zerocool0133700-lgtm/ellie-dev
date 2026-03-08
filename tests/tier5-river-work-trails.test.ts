/**
 * ELLIE-654 — Setup Tier 5: River Vault Writes (work trails)
 *
 * Verifies River vault infrastructure and work trail system:
 * - Work trail validators (frontmatter, sections, paths)
 * - Pure content builders (start, update, complete, decision, insertIntoSection)
 * - River write API (create, append, update operations)
 * - River search/catalog endpoints
 * - Work trail template existence
 * - QMD indexing
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  validateWorkTrail,
  parseWorkTrailPath,
  buildWorkTrailPath,
  isValidIso8601,
  WORK_TRAIL_STATUSES,
  REQUIRED_SECTIONS,
} from "../src/work-trail.ts";
import {
  buildWorkTrailStartContent,
  buildWorkTrailUpdateAppend,
  buildWorkTrailCompleteAppend,
  buildWorkTrailDecisionAppend,
  insertIntoSection,
} from "../src/work-trail-writer.ts";
import { existsSync } from "fs";
import { unlink } from "fs/promises";

const BRIDGE_API = "http://localhost:3001/api/bridge";
const BRIDGE_KEY = "bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a";
const RIVER_ROOT = "/home/ellie/obsidian-vault/ellie-river";
const TS = Date.now();

// Track created River docs for cleanup
const createdPaths: string[] = [];

afterAll(async () => {
  for (const path of createdPaths) {
    const fullPath = `${RIVER_ROOT}/${path}`;
    await unlink(fullPath).catch(() => {});
  }
});

// ── Helper ──────────────────────────────────────────────────

async function riverFetch(
  path: string,
  method: string = "GET",
  body?: Record<string, unknown>,
) {
  const opts: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-bridge-key": BRIDGE_KEY,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch(`${BRIDGE_API}/river/${path}`, opts);
}

// ── Constants ───────────────────────────────────────────────

describe("Work Trail Constants", () => {
  test("WORK_TRAIL_STATUSES has correct values", () => {
    expect(WORK_TRAIL_STATUSES).toContain("in-progress");
    expect(WORK_TRAIL_STATUSES).toContain("done");
    expect(WORK_TRAIL_STATUSES).toContain("blocked");
    expect(WORK_TRAIL_STATUSES.length).toBe(3);
  });

  test("REQUIRED_SECTIONS has 4 required sections", () => {
    expect(REQUIRED_SECTIONS).toContain("## Context");
    expect(REQUIRED_SECTIONS).toContain("## What Was Done");
    expect(REQUIRED_SECTIONS).toContain("## Files Changed");
    expect(REQUIRED_SECTIONS).toContain("## Decisions");
    expect(REQUIRED_SECTIONS.length).toBe(4);
  });
});

// ── isValidIso8601 ──────────────────────────────────────────

describe("isValidIso8601", () => {
  test("accepts date-only YYYY-MM-DD", () => {
    expect(isValidIso8601("2026-03-08")).toBe(true);
  });

  test("accepts full datetime with T separator", () => {
    expect(isValidIso8601("2026-03-08T06:00:00Z")).toBe(true);
    expect(isValidIso8601("2026-03-08T06:00:00.000Z")).toBe(true);
  });

  test("accepts datetime with timezone offset", () => {
    expect(isValidIso8601("2026-03-08T00:00:00-06:00")).toBe(true);
  });

  test("rejects empty string", () => {
    expect(isValidIso8601("")).toBe(false);
  });

  test("rejects non-date strings", () => {
    expect(isValidIso8601("not-a-date")).toBe(false);
    expect(isValidIso8601("tomorrow")).toBe(false);
  });

  test("rejects date without T separator in datetime", () => {
    expect(isValidIso8601("2026-03-08 06:00:00")).toBe(false);
  });
});

// ── validateWorkTrail ───────────────────────────────────────

describe("validateWorkTrail", () => {
  const VALID_FM = {
    work_item_id: "ELLIE-654",
    status: "in-progress",
    started_at: "2026-03-08T06:00:00Z",
  };

  const VALID_BODY = [
    "## Context",
    "Some context here",
    "## What Was Done",
    "Did some stuff",
    "## Files Changed",
    "| File | Change |",
    "## Decisions",
    "Decided things",
  ].join("\n");

  test("valid work trail passes", () => {
    const result = validateWorkTrail(VALID_FM, VALID_BODY);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("missing work_item_id fails", () => {
    const { work_item_id, ...fm } = VALID_FM;
    const result = validateWorkTrail(fm, VALID_BODY);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "work_item_id")).toBe(true);
  });

  test("invalid work_item_id format fails", () => {
    const result = validateWorkTrail({ ...VALID_FM, work_item_id: "bad-format" }, VALID_BODY);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "work_item_id")).toBe(true);
  });

  test("missing status fails", () => {
    const { status, ...fm } = VALID_FM;
    const result = validateWorkTrail(fm, VALID_BODY);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "status")).toBe(true);
  });

  test("invalid status fails", () => {
    const result = validateWorkTrail({ ...VALID_FM, status: "invalid" }, VALID_BODY);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "status")).toBe(true);
  });

  test("all valid statuses pass", () => {
    for (const status of WORK_TRAIL_STATUSES) {
      const result = validateWorkTrail({ ...VALID_FM, status }, VALID_BODY);
      expect(result.valid).toBe(true);
    }
  });

  test("missing started_at fails", () => {
    const { started_at, ...fm } = VALID_FM;
    const result = validateWorkTrail(fm, VALID_BODY);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "started_at")).toBe(true);
  });

  test("invalid started_at fails", () => {
    const result = validateWorkTrail({ ...VALID_FM, started_at: "not-a-date" }, VALID_BODY);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "started_at")).toBe(true);
  });

  test("date-only started_at passes", () => {
    const result = validateWorkTrail({ ...VALID_FM, started_at: "2026-03-08" }, VALID_BODY);
    expect(result.valid).toBe(true);
  });

  test("invalid completed_at fails", () => {
    const result = validateWorkTrail(
      { ...VALID_FM, completed_at: "not-a-date" },
      VALID_BODY,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "completed_at")).toBe(true);
  });

  test("null completed_at passes", () => {
    const result = validateWorkTrail(
      { ...VALID_FM, completed_at: null },
      VALID_BODY,
    );
    expect(result.valid).toBe(true);
  });

  test("valid completed_at passes", () => {
    const result = validateWorkTrail(
      { ...VALID_FM, completed_at: "2026-03-08T12:00:00Z" },
      VALID_BODY,
    );
    expect(result.valid).toBe(true);
  });

  test("missing body section fails", () => {
    const result = validateWorkTrail(VALID_FM, "## Context\n## What Was Done\n## Decisions");
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes("## Files Changed"))).toBe(true);
  });

  test("reports all missing sections at once", () => {
    const result = validateWorkTrail(VALID_FM, "No sections here");
    expect(result.errors.filter(e => e.field === "body")).toHaveLength(4);
  });

  test("reports both frontmatter and body errors together", () => {
    const result = validateWorkTrail({}, "No sections");
    expect(result.valid).toBe(false);
    // Should have frontmatter errors + body errors
    expect(result.errors.length).toBeGreaterThan(4);
  });
});

// ── parseWorkTrailPath ──────────────────────────────────────

describe("parseWorkTrailPath", () => {
  test("parses valid path", () => {
    const result = parseWorkTrailPath("work-trails/ELLIE-654/ELLIE-654-2026-03-08.md");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.info.ticketId).toBe("ELLIE-654");
      expect(result.info.date).toBe("2026-03-08");
    }
  });

  test("rejects empty path", () => {
    const result = parseWorkTrailPath("");
    expect(result.ok).toBe(false);
  });

  test("rejects wrong format", () => {
    const result = parseWorkTrailPath("notes/my-doc.md");
    expect(result.ok).toBe(false);
  });

  test("rejects mismatched ticket IDs", () => {
    const result = parseWorkTrailPath("work-trails/ELLIE-654/ELLIE-655-2026-03-08.md");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("mismatch");
    }
  });

  test("rejects missing .md extension", () => {
    const result = parseWorkTrailPath("work-trails/ELLIE-654/ELLIE-654-2026-03-08");
    expect(result.ok).toBe(false);
  });

  test("rejects lowercase ticket ID", () => {
    const result = parseWorkTrailPath("work-trails/ellie-654/ellie-654-2026-03-08.md");
    expect(result.ok).toBe(false);
  });
});

// ── buildWorkTrailPath ──────────────────────────────────────

describe("buildWorkTrailPath", () => {
  test("builds correct path with explicit date", () => {
    const path = buildWorkTrailPath("ELLIE-654", "2026-03-08");
    expect(path).toBe("work-trails/ELLIE-654/ELLIE-654-2026-03-08.md");
  });

  test("builds path with today's date when no date given", () => {
    const path = buildWorkTrailPath("ELLIE-654");
    expect(path).toMatch(/^work-trails\/ELLIE-654\/ELLIE-654-\d{4}-\d{2}-\d{2}\.md$/);
  });

  test("generated path passes parseWorkTrailPath", () => {
    const path = buildWorkTrailPath("PROJ-123", "2026-01-15");
    const result = parseWorkTrailPath(path);
    expect(result.ok).toBe(true);
  });
});

// ── buildWorkTrailStartContent ──────────────────────────────

describe("buildWorkTrailStartContent", () => {
  test("generates valid frontmatter", () => {
    const content = buildWorkTrailStartContent(
      "ELLIE-654",
      "Test Tier 5",
      "test-agent",
      "2026-03-08T06:00:00Z",
    );

    expect(content).toContain("work_item_id: ELLIE-654");
    expect(content).toContain("agent: test-agent");
    expect(content).toContain("status: in-progress");
    expect(content).toContain("started_at: 2026-03-08T06:00:00Z");
    expect(content).toContain("completed_at: null");
  });

  test("includes all required sections", () => {
    const content = buildWorkTrailStartContent("ELLIE-654", "Title");

    expect(content).toContain("## Context");
    expect(content).toContain("## What Was Done");
    expect(content).toContain("## Files Changed");
    expect(content).toContain("## Decisions");
  });

  test("generated content passes validateWorkTrail", () => {
    const content = buildWorkTrailStartContent(
      "ELLIE-654",
      "Test Title",
      "agent",
      "2026-03-08T06:00:00Z",
    );

    // Extract frontmatter
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch).toBeTruthy();
    const fmLines = fmMatch![1].split("\n");
    const fm: Record<string, unknown> = {};
    for (const line of fmLines) {
      const [key, ...rest] = line.split(": ");
      const val = rest.join(": ");
      fm[key] = val === "null" ? null : val;
    }

    const body = content.slice(content.indexOf("---", 4) + 4);
    const result = validateWorkTrail(fm, body);
    expect(result.valid).toBe(true);
  });

  test("defaults agent to claude-code", () => {
    const content = buildWorkTrailStartContent("ELLIE-654", "Title");
    expect(content).toContain("agent: claude-code");
  });
});

// ── buildWorkTrailUpdateAppend ──────────────────────────────

describe("buildWorkTrailUpdateAppend", () => {
  test("generates update section with timestamp", () => {
    const result = buildWorkTrailUpdateAppend("Fixed the bug", "2026-03-08T12:00:00Z");
    expect(result).toContain("### Update — 2026-03-08T12:00:00Z");
    expect(result).toContain("Fixed the bug");
  });

  test("auto-generates timestamp when not provided", () => {
    const result = buildWorkTrailUpdateAppend("Progress update");
    expect(result).toContain("### Update —");
    expect(result).toContain("Progress update");
  });
});

// ── buildWorkTrailCompleteAppend ─────────────────────────────

describe("buildWorkTrailCompleteAppend", () => {
  test("generates completion section", () => {
    const result = buildWorkTrailCompleteAppend("All tests pass", "2026-03-08T18:00:00Z");
    expect(result).toContain("## Completion Summary");
    expect(result).toContain("**Completed at:** 2026-03-08T18:00:00Z");
    expect(result).toContain("All tests pass");
  });
});

// ── buildWorkTrailDecisionAppend ────────────────────────────

describe("buildWorkTrailDecisionAppend", () => {
  test("generates decision section with agent", () => {
    const result = buildWorkTrailDecisionAppend(
      "Use Postgres over Redis",
      "dev-agent",
      "2026-03-08T10:00:00Z",
    );
    expect(result).toContain("### Decision — 2026-03-08T10:00:00Z");
    expect(result).toContain("**dev-agent:**");
    expect(result).toContain("Use Postgres over Redis");
  });

  test("omits agent prefix when not provided", () => {
    const result = buildWorkTrailDecisionAppend("Some decision");
    expect(result).not.toContain("**");
    expect(result).toContain("Some decision");
  });
});

// ── insertIntoSection ───────────────────────────────────────

describe("insertIntoSection", () => {
  const DOC = [
    "# Title",
    "",
    "## Context",
    "",
    "<!-- placeholder -->",
    "",
    "## What Was Done",
    "",
    "- Step 1",
    "",
    "## Decisions",
    "",
    "---",
    "",
    "Footer",
  ].join("\n");

  test("inserts into a section", () => {
    const result = insertIntoSection(DOC, "## What Was Done", "- Step 2");
    expect(result).toBeTruthy();
    expect(result).toContain("- Step 1");
    expect(result).toContain("- Step 2");
  });

  test("returns null for non-existent section", () => {
    const result = insertIntoSection(DOC, "## Missing Section", "content");
    expect(result).toBeNull();
  });

  test("removes HTML comment placeholders", () => {
    const result = insertIntoSection(DOC, "## Context", "Real context");
    expect(result).toBeTruthy();
    expect(result).not.toContain("<!-- placeholder -->");
    expect(result).toContain("Real context");
  });
});

// ── Infrastructure: River Vault ─────────────────────────────

describe("Tier 5 Infrastructure — River Vault", () => {
  test("River vault directory exists", () => {
    expect(existsSync("/home/ellie/obsidian-vault")).toBe(true);
  });

  test("ellie-river collection directory exists", () => {
    expect(existsSync(RIVER_ROOT)).toBe(true);
  });

  test("work trail template exists", () => {
    expect(existsSync(`${RIVER_ROOT}/templates/work-trail.md`)).toBe(true);
  });

  test("work-trails directory exists", () => {
    expect(existsSync(`${RIVER_ROOT}/work-trails`)).toBe(true);
  });
});

// ── Integration: River Write API ────────────────────────────

describe("Tier 5 — River Write API", () => {
  const TEST_PATH = `test-654/test-${TS}.md`;

  test("creates a new River document", async () => {
    const content = [
      "---",
      `test_id: ${TS}`,
      "---",
      "",
      "# Test Document",
      "",
      "Created by ELLIE-654 test suite.",
    ].join("\n");

    const res = await riverFetch("write", "POST", {
      path: TEST_PATH,
      content,
      operation: "create",
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.path).toBe(TEST_PATH);
    expect(data.operation).toBe("create");
    createdPaths.push(TEST_PATH);
  });

  test("create returns 409 for existing file", async () => {
    const res = await riverFetch("write", "POST", {
      path: TEST_PATH,
      content: "Duplicate",
      operation: "create",
    });
    expect(res.status).toBe(409);
  });

  test("appends to existing document", async () => {
    const res = await riverFetch("write", "POST", {
      path: TEST_PATH,
      content: "\n## Appended Section\n\nAppended by test.",
      operation: "append",
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.operation).toBe("append");
  });

  test("updates an existing document", async () => {
    const res = await riverFetch("write", "POST", {
      path: TEST_PATH,
      content: "# Replaced Content\n\nFully replaced.",
      operation: "update",
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.operation).toBe("update");
  });

  test("update returns 404 for non-existent file", async () => {
    const res = await riverFetch("write", "POST", {
      path: `test-654/nonexistent-${TS}.md`,
      content: "Nope",
      operation: "update",
    });
    expect(res.status).toBe(404);
  });

  test("validates path: rejects empty path", async () => {
    const res = await riverFetch("write", "POST", {
      path: "",
      content: "Test",
      operation: "create",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("validates path: rejects directory traversal", async () => {
    const res = await riverFetch("write", "POST", {
      path: "../escape.md",
      content: "Test",
      operation: "create",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("validates path: requires .md extension", async () => {
    const res = await riverFetch("write", "POST", {
      path: "test-654/test.txt",
      content: "Test",
      operation: "create",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("validates content: rejects empty content", async () => {
    const res = await riverFetch("write", "POST", {
      path: `test-654/empty-${TS}.md`,
      content: "",
      operation: "create",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

// ── Integration: River Search ───────────────────────────────

describe("Tier 5 — River Search", () => {
  test("search returns memories array", async () => {
    const res = await riverFetch("search", "POST", {
      query: "architecture",
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(Array.isArray(data.memories)).toBe(true);
  });
});

// ── Integration: River Catalog ──────────────────────────────

describe("Tier 5 — River Catalog", () => {
  test("catalog returns docs array", async () => {
    const res = await riverFetch("catalog");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(Array.isArray(data.docs)).toBe(true);
    expect(data.docs.length).toBeGreaterThan(0);
  });

  test("catalog entries have docid and path", async () => {
    const res = await riverFetch("catalog");
    const data = await res.json();
    if (data.docs.length > 0) {
      const doc = data.docs[0];
      expect(doc.path).toBeTruthy();
      expect(doc.docid).toBeTruthy();
    }
  });
});

// ── Integration: River Doc Retrieval ────────────────────────

describe("Tier 5 — River Doc Retrieval", () => {
  test("retrieves an indexed document by docid", async () => {
    // First get a valid docid from the catalog
    const catRes = await riverFetch("catalog");
    const catData = await catRes.json();
    expect(catData.docs.length).toBeGreaterThan(0);

    const docid = catData.docs[0].docid;
    const res = await riverFetch(`doc?id=${encodeURIComponent(docid)}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.content).toBeTruthy();
  });

  test("returns 404 for non-existent document", async () => {
    const res = await riverFetch(
      `doc?id=${encodeURIComponent("qmd://ellie-river/nonexistent-654.md")}`,
    );
    expect(res.status).toBe(404);
  });
});

// ── Integration: Work Trail Lifecycle via API ───────────────

describe("Tier 5 — Work Trail Lifecycle via River Write", () => {
  const TRAIL_PATH = `work-trails/TEST-654/TEST-654-2026-03-08.md`;
  const TRAIL_CONTENT = buildWorkTrailStartContent(
    "TEST-654",
    "Test work trail lifecycle",
    "test-agent",
    "2026-03-08T06:00:00Z",
  );

  beforeAll(async () => {
    // Clean up any leftover from previous runs
    await unlink(`${RIVER_ROOT}/${TRAIL_PATH}`).catch(() => {});
    const { rmdir } = await import("fs/promises");
    await rmdir(`${RIVER_ROOT}/work-trails/TEST-654`).catch(() => {});
  });

  afterAll(async () => {
    await unlink(`${RIVER_ROOT}/${TRAIL_PATH}`).catch(() => {});
    const { rmdir } = await import("fs/promises");
    await rmdir(`${RIVER_ROOT}/work-trails/TEST-654`).catch(() => {});
  });

  test("step 1: create work trail via River write", async () => {
    const res = await riverFetch("write", "POST", {
      path: TRAIL_PATH,
      content: TRAIL_CONTENT,
      operation: "create",
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  test("step 2: append progress update", async () => {
    const update = buildWorkTrailUpdateAppend(
      "Completed infrastructure verification",
      "2026-03-08T07:00:00Z",
    );

    const res = await riverFetch("write", "POST", {
      path: TRAIL_PATH,
      content: update,
      operation: "append",
    });

    expect(res.status).toBe(200);
  });

  test("step 3: append decision", async () => {
    const decision = buildWorkTrailDecisionAppend(
      "Use pure validators to avoid test coupling",
      "test-agent",
      "2026-03-08T08:00:00Z",
    );

    const res = await riverFetch("write", "POST", {
      path: TRAIL_PATH,
      content: decision,
      operation: "append",
    });

    expect(res.status).toBe(200);
  });

  test("step 4: retrieve and verify content", async () => {
    // Read directly from disk — QMD reindex is async and may not complete in time
    const fs = await import("fs");
    const vaultPath = "/home/ellie/obsidian-vault/ellie-river";
    const filePath = `${vaultPath}/${TRAIL_PATH}`;
    const content = fs.readFileSync(filePath, "utf-8");

    expect(content).toContain("work_item_id: TEST-654");
    expect(content).toContain("## Context");
    expect(content).toContain("## What Was Done");
    expect(content).toContain("## Decisions");
    expect(content).toContain("Completed infrastructure verification");
    expect(content).toContain("Use pure validators");
  });
});
