/**
 * Agent Org Chart Hierarchy Tests — ELLIE-725
 *
 * Tests for agent reporting lines and org chart:
 * - Migration SQL structure
 * - Type shapes
 * - Set reports_to and title
 * - Hierarchy queries (subtree, chain of command, direct reports)
 * - Tree building (pure)
 * - Circular reference detection (pure)
 * - Org tree for company
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

// ── Mock SQL Layer ──────────────────────────────────────────

type SqlRow = Record<string, unknown>;
type SqlResult = SqlRow[];

let sqlMockResults: SqlResult[] = [];
let sqlCallIndex = 0;
let sqlCalls: { strings: TemplateStringsArray; values: unknown[] }[] = [];

function resetSqlMock() {
  sqlMockResults = [];
  sqlCallIndex = 0;
  sqlCalls = [];
}

function pushSqlResult(rows: SqlResult) {
  sqlMockResults.push(rows);
}

const mockSql = Object.assign(
  function sql(strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlResult> {
    sqlCalls.push({ strings, values });
    const result = sqlMockResults[sqlCallIndex] ?? [];
    sqlCallIndex++;
    return Promise.resolve(result);
  },
  { json: (v: unknown) => v, array: (v: unknown) => v },
);

mock.module("../../ellie-forest/src/index", () => ({
  sql: mockSql,
}));

import type { AgentNode, OrgTreeNode, HierarchyRow } from "../src/agent-hierarchy.ts";

const {
  setReportsTo,
  setTitle,
  getSubtree,
  getChainOfCommand,
  getDirectReports,
  getRootAgents,
  getOrgTree,
  buildOrgTree,
  wouldCreateCycle,
  flattenOrgTree,
} = await import("../src/agent-hierarchy.ts");

// ── Setup ───────────────────────────────────────────────────

beforeEach(() => {
  resetSqlMock();
});

// ── Helper ──────────────────────────────────────────────────

function makeAgent(overrides: Partial<HierarchyRow> = {}): HierarchyRow {
  return {
    id: "a1",
    name: "dev",
    type: "dev",
    title: null,
    reports_to: null,
    status: "active",
    depth: 0,
    ...overrides,
  };
}

// ── Migration SQL ───────────────────────────────────────────

describe("migration SQL", () => {
  function readMigration(): string {
    return readFileSync(
      join(import.meta.dir, "../migrations/supabase/20260315_agent_hierarchy.sql"),
      "utf-8",
    );
  }

  test("adds reports_to column with self-referential FK", () => {
    const sql = readMigration();
    expect(sql).toContain("reports_to UUID REFERENCES agents(id)");
  });

  test("adds title column", () => {
    const sql = readMigration();
    expect(sql).toContain("title TEXT");
  });

  test("creates index on reports_to", () => {
    const sql = readMigration();
    expect(sql).toContain("idx_agents_reports_to");
  });

  test("creates cycle detection trigger function", () => {
    const sql = readMigration();
    expect(sql).toContain("check_agent_hierarchy_cycle");
    expect(sql).toContain("Circular reference detected");
    expect(sql).toContain("Agent cannot report to itself");
  });

  test("creates trigger on INSERT OR UPDATE OF reports_to", () => {
    const sql = readMigration();
    expect(sql).toContain("BEFORE INSERT OR UPDATE OF reports_to");
    expect(sql).toContain("FOR EACH ROW");
  });

  test("trigger walks up chain with max depth guard", () => {
    const sql = readMigration();
    expect(sql).toContain("max_depth");
    expect(sql).toContain("WHILE current_id IS NOT NULL");
  });

  test("uses IF NOT EXISTS for idempotent columns", () => {
    const sql = readMigration();
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS reports_to");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS title");
  });
});

// ── Type Shapes ─────────────────────────────────────────────

describe("type shapes", () => {
  test("AgentNode has hierarchy fields", () => {
    const node: AgentNode = {
      id: "a1", name: "strategy", type: "strategy",
      title: "CEO", reports_to: null, status: "active",
    };
    expect(node.title).toBe("CEO");
    expect(node.reports_to).toBeNull();
  });

  test("OrgTreeNode extends AgentNode with depth and children", () => {
    const node: OrgTreeNode = {
      id: "a1", name: "strategy", type: "strategy",
      title: "CEO", reports_to: null, status: "active",
      depth: 0, children: [],
    };
    expect(node.depth).toBe(0);
    expect(node.children).toHaveLength(0);
  });

  test("HierarchyRow extends AgentNode with depth", () => {
    const row: HierarchyRow = {
      id: "a1", name: "strategy", type: "strategy",
      title: "CEO", reports_to: null, status: "active",
      depth: 0,
    };
    expect(row.depth).toBe(0);
  });
});

// ── setReportsTo ────────────────────────────────────────────

describe("setReportsTo", () => {
  test("updates reports_to and returns agent", async () => {
    pushSqlResult([{
      id: "a2", name: "finance", type: "finance",
      title: "VP Finance", reports_to: "a1", status: "active",
    }]);

    const agent = await setReportsTo("a2", "a1");
    expect(agent.reports_to).toBe("a1");
  });

  test("allows setting reports_to to null (root agent)", async () => {
    pushSqlResult([{
      id: "a1", name: "strategy", type: "strategy",
      title: "CEO", reports_to: null, status: "active",
    }]);

    const agent = await setReportsTo("a1", null);
    expect(agent.reports_to).toBeNull();
  });

  test("throws when agent not found", async () => {
    pushSqlResult([]);
    await expect(setReportsTo("nonexistent", "a1")).rejects.toThrow("not found");
  });
});

// ── setTitle ────────────────────────────────────────────────

describe("setTitle", () => {
  test("updates title and returns agent", async () => {
    pushSqlResult([{
      id: "a1", name: "strategy", type: "strategy",
      title: "CEO", reports_to: null, status: "active",
    }]);

    const agent = await setTitle("a1", "CEO");
    expect(agent.title).toBe("CEO");
  });

  test("allows null title", async () => {
    pushSqlResult([{
      id: "a1", name: "strategy", type: "strategy",
      title: null, reports_to: null, status: "active",
    }]);

    const agent = await setTitle("a1", null);
    expect(agent.title).toBeNull();
  });

  test("throws when agent not found", async () => {
    pushSqlResult([]);
    await expect(setTitle("nonexistent", "CEO")).rejects.toThrow("not found");
  });
});

// ── getSubtree ──────────────────────────────────────────────

describe("getSubtree", () => {
  test("returns recursive subtree", async () => {
    pushSqlResult([
      makeAgent({ id: "a1", name: "strategy", title: "CEO", depth: 0 }),
      makeAgent({ id: "a2", name: "finance", title: "VP", reports_to: "a1", depth: 1 }),
      makeAgent({ id: "a3", name: "billing", title: "Specialist", reports_to: "a2", depth: 2 }),
    ]);

    const tree = await getSubtree("a1");
    expect(tree).toHaveLength(3);
    expect(tree[0].depth).toBe(0);
    expect(tree[2].depth).toBe(2);
  });

  test("uses recursive CTE", async () => {
    pushSqlResult([]);
    await getSubtree("a1");

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("WITH RECURSIVE");
    expect(sqlText).toContain("UNION ALL");
  });
});

// ── getChainOfCommand ───────────────────────────────────────

describe("getChainOfCommand", () => {
  test("returns chain from agent up to root", async () => {
    pushSqlResult([
      makeAgent({ id: "a3", name: "billing", title: "Specialist", reports_to: "a2", depth: 0 }),
      makeAgent({ id: "a2", name: "finance", title: "VP", reports_to: "a1", depth: 1 }),
      makeAgent({ id: "a1", name: "strategy", title: "CEO", reports_to: null, depth: 2 }),
    ]);

    const chain = await getChainOfCommand("a3");
    expect(chain).toHaveLength(3);
    expect(chain[0].name).toBe("billing");
    expect(chain[2].name).toBe("strategy");
  });

  test("uses recursive CTE walking up", async () => {
    pushSqlResult([]);
    await getChainOfCommand("a3");

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("WITH RECURSIVE");
    expect(sqlText).toContain("a.id = c.reports_to");
  });
});

// ── getDirectReports ────────────────────────────────────────

describe("getDirectReports", () => {
  test("returns agents that report to given agent", async () => {
    pushSqlResult([
      { id: "a2", name: "finance", type: "finance", title: "VP", reports_to: "a1", status: "active" },
      { id: "a3", name: "research", type: "research", title: "VP", reports_to: "a1", status: "active" },
    ]);

    const reports = await getDirectReports("a1");
    expect(reports).toHaveLength(2);
  });

  test("filters by reports_to in SQL", async () => {
    pushSqlResult([]);
    await getDirectReports("a1");

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("reports_to =");
  });
});

// ── getRootAgents ───────────────────────────────────────────

describe("getRootAgents", () => {
  test("returns agents with no reports_to", async () => {
    pushSqlResult([
      { id: "a1", name: "strategy", type: "strategy", title: "CEO", reports_to: null, status: "active" },
    ]);

    const roots = await getRootAgents();
    expect(roots).toHaveLength(1);
    expect(roots[0].reports_to).toBeNull();
  });

  test("filters by company_id when provided", async () => {
    pushSqlResult([]);
    await getRootAgents("comp-1");

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("company_id =");
    expect(sqlText).toContain("reports_to IS NULL");
  });

  test("no company filter when omitted", async () => {
    pushSqlResult([]);
    await getRootAgents();

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("reports_to IS NULL");
    expect(sqlText).not.toContain("company_id");
  });
});

// ── getOrgTree ──────────────────────────────────────────────

describe("getOrgTree", () => {
  test("returns full recursive org tree", async () => {
    pushSqlResult([
      makeAgent({ id: "a1", name: "strategy", title: "CEO", depth: 0 }),
      makeAgent({ id: "a2", name: "finance", title: "VP", reports_to: "a1", depth: 1 }),
      makeAgent({ id: "a3", name: "research", title: "VP", reports_to: "a1", depth: 1 }),
    ]);

    const tree = await getOrgTree();
    expect(tree).toHaveLength(3);
  });

  test("uses recursive CTE with company filter", async () => {
    pushSqlResult([]);
    await getOrgTree("comp-1");

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("WITH RECURSIVE");
    expect(sqlText).toContain("company_id =");
  });

  test("uses recursive CTE without company filter", async () => {
    pushSqlResult([]);
    await getOrgTree();

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("WITH RECURSIVE");
    expect(sqlText).not.toContain("company_id");
  });
});

// ── buildOrgTree (Pure) ─────────────────────────────────────

describe("buildOrgTree", () => {
  test("builds nested tree from flat rows", () => {
    const rows: HierarchyRow[] = [
      makeAgent({ id: "a1", name: "strategy", title: "CEO", depth: 0 }),
      makeAgent({ id: "a2", name: "finance", title: "VP", reports_to: "a1", depth: 1 }),
      makeAgent({ id: "a3", name: "research", title: "VP", reports_to: "a1", depth: 1 }),
      makeAgent({ id: "a4", name: "billing", title: "Specialist", reports_to: "a2", depth: 2 }),
    ];

    const tree = buildOrgTree(rows);
    expect(tree).toHaveLength(1); // One root
    expect(tree[0].name).toBe("strategy");
    expect(tree[0].children).toHaveLength(2);
    expect(tree[0].children[0].name).toBe("finance");
    expect(tree[0].children[0].children).toHaveLength(1);
    expect(tree[0].children[0].children[0].name).toBe("billing");
    expect(tree[0].children[1].name).toBe("research");
    expect(tree[0].children[1].children).toHaveLength(0);
  });

  test("handles multiple root agents", () => {
    const rows: HierarchyRow[] = [
      makeAgent({ id: "a1", name: "strategy", depth: 0 }),
      makeAgent({ id: "a2", name: "ops", depth: 0 }),
    ];

    const tree = buildOrgTree(rows);
    expect(tree).toHaveLength(2);
  });

  test("handles empty input", () => {
    const tree = buildOrgTree([]);
    expect(tree).toHaveLength(0);
  });

  test("handles single agent (CEO only)", () => {
    const tree = buildOrgTree([
      makeAgent({ id: "a1", name: "strategy", title: "CEO", depth: 0 }),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(0);
  });

  test("matches ticket example hierarchy", () => {
    const rows: HierarchyRow[] = [
      makeAgent({ id: "s1", name: "strategy", type: "strategy", title: "CEO", depth: 0 }),
      makeAgent({ id: "f1", name: "finance", type: "finance", title: "VP", reports_to: "s1", depth: 1 }),
      makeAgent({ id: "r1", name: "research", type: "research", title: "VP", reports_to: "s1", depth: 1 }),
      makeAgent({ id: "o1", name: "ops", type: "dev", title: "VP", reports_to: "s1", depth: 1 }),
      makeAgent({ id: "cs", name: "claims-sub", type: "finance", title: "Claims Submission Specialist", reports_to: "f1", depth: 2 }),
      makeAgent({ id: "pp", name: "payment-post", type: "finance", title: "Payment Posting Specialist", reports_to: "f1", depth: 2 }),
    ];

    const tree = buildOrgTree(rows);
    expect(tree).toHaveLength(1);
    expect(tree[0].title).toBe("CEO");
    expect(tree[0].children).toHaveLength(3); // Finance, Research, Ops

    const finance = tree[0].children.find(c => c.name === "finance")!;
    expect(finance.children).toHaveLength(2);
    expect(finance.children.map(c => c.name).sort()).toEqual(["claims-sub", "payment-post"]);
  });
});

// ── wouldCreateCycle (Pure) ─────────────────────────────────

describe("wouldCreateCycle", () => {
  const agents = [
    { id: "a1", reports_to: null },
    { id: "a2", reports_to: "a1" },
    { id: "a3", reports_to: "a2" },
  ];

  test("returns false for valid hierarchy change", () => {
    // Moving a3 to report to a1 (skipping a2) — no cycle
    expect(wouldCreateCycle("a3", "a1", agents)).toBe(false);
  });

  test("detects self-reference", () => {
    expect(wouldCreateCycle("a1", "a1", agents)).toBe(true);
  });

  test("detects direct cycle (parent reports to child)", () => {
    // a1 reporting to a2 when a2 already reports to a1
    expect(wouldCreateCycle("a1", "a2", agents)).toBe(true);
  });

  test("detects indirect cycle (grandparent reports to grandchild)", () => {
    // a1 reporting to a3: a1 -> a3, a3 -> a2, a2 -> a1 = cycle
    expect(wouldCreateCycle("a1", "a3", agents)).toBe(true);
  });

  test("allows root agent to report to unrelated agent", () => {
    const extended = [
      ...agents,
      { id: "a4", reports_to: null },
    ];
    // a4 reporting to a3 — no cycle
    expect(wouldCreateCycle("a4", "a3", extended)).toBe(false);
  });

  test("allows moving between branches", () => {
    const twoRoots = [
      { id: "a1", reports_to: null },
      { id: "a2", reports_to: "a1" },
      { id: "b1", reports_to: null },
      { id: "b2", reports_to: "b1" },
    ];
    // a2 moving to report to b1 — no cycle
    expect(wouldCreateCycle("a2", "b1", twoRoots)).toBe(false);
  });
});

// ── flattenOrgTree ──────────────────────────────────────────

describe("flattenOrgTree", () => {
  test("flattens nested tree to list", () => {
    const rows: HierarchyRow[] = [
      makeAgent({ id: "a1", name: "strategy", depth: 0 }),
      makeAgent({ id: "a2", name: "finance", reports_to: "a1", depth: 1 }),
      makeAgent({ id: "a3", name: "billing", reports_to: "a2", depth: 2 }),
    ];

    const tree = buildOrgTree(rows);
    const flat = flattenOrgTree(tree);

    expect(flat).toHaveLength(3);
    expect(flat[0].name).toBe("strategy");
    expect(flat[1].name).toBe("finance");
    expect(flat[2].name).toBe("billing");
  });

  test("handles empty tree", () => {
    expect(flattenOrgTree([])).toHaveLength(0);
  });

  test("round-trips: buildOrgTree -> flattenOrgTree preserves all nodes", () => {
    const rows: HierarchyRow[] = [
      makeAgent({ id: "a1", depth: 0 }),
      makeAgent({ id: "a2", reports_to: "a1", depth: 1 }),
      makeAgent({ id: "a3", reports_to: "a1", depth: 1 }),
      makeAgent({ id: "a4", reports_to: "a2", depth: 2 }),
    ];

    const tree = buildOrgTree(rows);
    const flat = flattenOrgTree(tree);

    expect(flat).toHaveLength(4);
    const ids = flat.map(r => r.id).sort();
    expect(ids).toEqual(["a1", "a2", "a3", "a4"]);
  });
});

// ── E2E: Org Chart Lifecycle ────────────────────────────────

describe("E2E: org chart lifecycle", () => {
  test("set titles → set reporting → query subtree → build tree", async () => {
    // Set CEO title
    pushSqlResult([{
      id: "a1", name: "strategy", type: "strategy",
      title: "CEO", reports_to: null, status: "active",
    }]);
    const ceo = await setTitle("a1", "CEO");
    expect(ceo.title).toBe("CEO");

    resetSqlMock();

    // Set VP to report to CEO
    pushSqlResult([{
      id: "a2", name: "finance", type: "finance",
      title: "VP Finance", reports_to: "a1", status: "active",
    }]);
    await setReportsTo("a2", "a1");

    resetSqlMock();

    // Query subtree from CEO
    pushSqlResult([
      makeAgent({ id: "a1", name: "strategy", title: "CEO", depth: 0 }),
      makeAgent({ id: "a2", name: "finance", title: "VP Finance", reports_to: "a1", depth: 1 }),
    ]);
    const subtree = await getSubtree("a1");
    expect(subtree).toHaveLength(2);

    // Build tree (pure)
    const tree = buildOrgTree(subtree);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].title).toBe("VP Finance");
  });

  test("cycle detection prevents bad hierarchy", () => {
    const agents = [
      { id: "ceo", reports_to: null },
      { id: "vp", reports_to: "ceo" },
      { id: "specialist", reports_to: "vp" },
    ];

    // Valid: specialist moves to report directly to CEO
    expect(wouldCreateCycle("specialist", "ceo", agents)).toBe(false);

    // Invalid: CEO reporting to specialist
    expect(wouldCreateCycle("ceo", "specialist", agents)).toBe(true);

    // Invalid: VP reporting to specialist (creates vp -> specialist -> vp cycle)
    expect(wouldCreateCycle("vp", "specialist", agents)).toBe(true);
  });
});

// ── SQL Safety ──────────────────────────────────────────────

describe("SQL safety", () => {
  test("setReportsTo uses parameterized queries", async () => {
    pushSqlResult([{
      id: "a1", name: "dev", type: "dev",
      title: null, reports_to: "a2", status: "active",
    }]);

    await setReportsTo("a1", "a2");

    const rawSql = sqlCalls[0].strings.join("");
    expect(rawSql).not.toContain("a1");
    expect(rawSql).not.toContain("a2");
  });

  test("getSubtree uses parameterized queries", async () => {
    pushSqlResult([]);
    await getSubtree("a1");

    expect(sqlCalls[0].values).toContain("a1");
  });
});
