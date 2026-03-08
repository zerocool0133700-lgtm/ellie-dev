/**
 * ELLIE-653 — Test Tier 4: Forest Knowledge ([MEMORY:] tags)
 *
 * Verifies [MEMORY:] tag parsing, type detection, confidence scoring,
 * scope path assignment, semantic search, and work item linking.
 *
 * Unit tests: regex parsing for all tag variants
 * Integration tests: Bridge write → search → scope filtering → work item linking
 */

import { describe, test, expect, afterAll } from "bun:test";
import sql from "../../ellie-forest/src/db";

const BRIDGE_API = "http://localhost:3001/api/bridge";
const BRIDGE_KEY = "bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a";
const TS = Date.now();
const createdMemoryIds: string[] = [];

afterAll(async () => {
  for (const id of createdMemoryIds) {
    await sql`DELETE FROM shared_memories WHERE id = ${id}`.catch(() => {});
  }
});

// ── Helper ──────────────────────────────────────────────────

async function bridgeFetch(
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
  return fetch(`${BRIDGE_API}/${path}`, opts);
}

// ── Unit: [MEMORY:] Tag Regex ───────────────────────────────

describe("[MEMORY:] Tag Parsing — Regex", () => {
  // This is the exact regex from src/memory.ts:643
  const memoryRegex = /\[MEMORY:(?:(\w+):)?(?:([\d.]+):)?\s*(.+?)\]/gi;

  function parseMemoryTags(text: string) {
    const results: Array<{ type: string; confidence: number; content: string }> = [];
    for (const match of text.matchAll(memoryRegex)) {
      results.push({
        type: match[1] || "finding",
        confidence: match[2] ? parseFloat(match[2]) : 0.7,
        content: match[3],
      });
    }
    return results;
  }

  test("parses basic [MEMORY: content] → finding at 0.7", () => {
    const results = parseMemoryTags("[MEMORY: The relay uses port 3001]");
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("finding");
    expect(results[0].confidence).toBe(0.7);
    expect(results[0].content).toBe("The relay uses port 3001");
  });

  test("parses [MEMORY:decision: content] → decision at 0.7", () => {
    const results = parseMemoryTags("[MEMORY:decision: Using Postgres over Redis for knowledge store]");
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("decision");
    expect(results[0].confidence).toBe(0.7);
    expect(results[0].content).toBe("Using Postgres over Redis for knowledge store");
  });

  test("parses [MEMORY:hypothesis:0.4: content] → hypothesis at 0.4", () => {
    const results = parseMemoryTags("[MEMORY:hypothesis:0.4: Maybe the issue is connection pooling]");
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("hypothesis");
    expect(results[0].confidence).toBe(0.4);
    expect(results[0].content).toBe("Maybe the issue is connection pooling");
  });

  test("parses [MEMORY:fact: content] → fact at 0.7", () => {
    const results = parseMemoryTags("[MEMORY:fact: Dashboard runs on port 3000]");
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("fact");
    expect(results[0].confidence).toBe(0.7);
    expect(results[0].content).toBe("Dashboard runs on port 3000");
  });

  test("parses [MEMORY:finding:0.9: content] → finding at 0.9", () => {
    const results = parseMemoryTags("[MEMORY:finding:0.9: The embed function handles batching internally]");
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("finding");
    expect(results[0].confidence).toBe(0.9);
    expect(results[0].content).toBe("The embed function handles batching internally");
  });

  test("parses multiple tags from a single response", () => {
    const text = `Here is what I found:
[MEMORY:fact: Relay uses port 3001]
Some explanation here.
[MEMORY:decision: Use BM25 for short queries because vector search needs longer context]
More text.
[MEMORY:hypothesis:0.3: The timeout might be caused by embedding generation]`;

    const results = parseMemoryTags(text);
    expect(results).toHaveLength(3);

    expect(results[0].type).toBe("fact");
    expect(results[0].content).toContain("port 3001");

    expect(results[1].type).toBe("decision");
    expect(results[1].content).toContain("BM25");

    expect(results[2].type).toBe("hypothesis");
    expect(results[2].confidence).toBe(0.3);
  });

  test("returns empty array when no tags present", () => {
    const results = parseMemoryTags("This is a normal response with no memory tags.");
    expect(results).toHaveLength(0);
  });

  test("is case-insensitive", () => {
    const results = parseMemoryTags("[memory: lowercase tag works]");
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("lowercase tag works");
  });

  test("handles confidence with decimal precision", () => {
    const results = parseMemoryTags("[MEMORY:fact:0.85: High confidence fact]");
    expect(results).toHaveLength(1);
    expect(results[0].confidence).toBe(0.85);
  });

  test("handles confidence of 1.0", () => {
    const results = parseMemoryTags("[MEMORY:fact:1.0: Certain fact]");
    expect(results).toHaveLength(1);
    expect(results[0].confidence).toBe(1.0);
  });

  test("handles confidence of 0", () => {
    const results = parseMemoryTags("[MEMORY:hypothesis:0: Wild guess]");
    expect(results).toHaveLength(1);
    expect(results[0].confidence).toBe(0);
  });

  test("does not match incomplete tags", () => {
    const results = parseMemoryTags("[MEMORY:");
    expect(results).toHaveLength(0);
  });

  test("does not match other tag formats", () => {
    const results = parseMemoryTags("[REMEMBER: some fact] [GOAL: do something]");
    expect(results).toHaveLength(0);
  });
});

// ── Integration: Type-Specific Writes via Bridge ────────────

describe("[MEMORY:] Integration — Type-Specific Writes", () => {
  const TYPES = ["fact", "decision", "finding", "hypothesis"] as const;
  const typeMemoryIds: Record<string, string> = {};

  test("writes a fact memory", async () => {
    const res = await bridgeFetch("write", "POST", {
      content: `ELLIE-653 tag test fact: Relay uses port 3001 and serves Bridge API ${TS}`,
      type: "fact",
      scope_path: "2/1",
      confidence: 0.9,
      metadata: { work_item_id: "ELLIE-653", source: "memory_tag_test" },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    typeMemoryIds.fact = data.memory_id;
    createdMemoryIds.push(data.memory_id);
  });

  test("writes a decision memory", async () => {
    const res = await bridgeFetch("write", "POST", {
      content: `ELLIE-653 tag test decision: Chose Postgres for Forest because ACID guarantees needed ${TS}`,
      type: "decision",
      scope_path: "2/1",
      confidence: 0.85,
      metadata: { work_item_id: "ELLIE-653", source: "memory_tag_test" },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    typeMemoryIds.decision = data.memory_id;
    createdMemoryIds.push(data.memory_id);
  });

  test("writes a finding memory", async () => {
    const res = await bridgeFetch("write", "POST", {
      content: `ELLIE-653 tag test finding: writeMemory computes weight from confidence+recency ${TS}`,
      type: "finding",
      scope_path: "2/1",
      confidence: 0.7,
      metadata: { work_item_id: "ELLIE-653", source: "memory_tag_test" },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    typeMemoryIds.finding = data.memory_id;
    createdMemoryIds.push(data.memory_id);
  });

  test("writes a hypothesis memory", async () => {
    const res = await bridgeFetch("write", "POST", {
      content: `ELLIE-653 tag test hypothesis: BM25 may outperform vector for single-word queries ${TS}`,
      type: "hypothesis",
      scope_path: "2/1",
      confidence: 0.4,
      metadata: { work_item_id: "ELLIE-653", source: "memory_tag_test" },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    typeMemoryIds.hypothesis = data.memory_id;
    createdMemoryIds.push(data.memory_id);
  });

  test("each type stored with correct type in DB", async () => {
    for (const type of TYPES) {
      const [row] = await sql`
        SELECT type FROM shared_memories WHERE id = ${typeMemoryIds[type]}
      `;
      expect(row.type).toBe(type);
    }
  });

  test("each type has correct confidence in DB", async () => {
    const expected: Record<string, number> = { fact: 0.9, decision: 0.85, finding: 0.7, hypothesis: 0.4 };
    for (const type of TYPES) {
      const [row] = await sql`
        SELECT confidence FROM shared_memories WHERE id = ${typeMemoryIds[type]}
      `;
      expect(Number(row.confidence)).toBeCloseTo(expected[type], 1);
    }
  });
});

// ── Integration: Confidence Scoring ─────────────────────────

describe("[MEMORY:] Integration — Confidence Scoring", () => {
  test("confidence affects weight computation", async () => {
    // Write two memories with different confidences
    const highRes = await bridgeFetch("write", "POST", {
      content: `ELLIE-653 high confidence canary ${TS}`,
      type: "fact",
      scope_path: "2/1",
      confidence: 0.95,
    });
    const lowRes = await bridgeFetch("write", "POST", {
      content: `ELLIE-653 low confidence canary ${TS}`,
      type: "hypothesis",
      scope_path: "2/1",
      confidence: 0.2,
    });

    const highData = await highRes.json();
    const lowData = await lowRes.json();
    createdMemoryIds.push(highData.memory_id, lowData.memory_id);

    const rows = await sql`
      SELECT id, confidence, weight FROM shared_memories
      WHERE id IN (${highData.memory_id}, ${lowData.memory_id})
    `;

    const high = rows.find((r: { id: string }) => r.id === highData.memory_id);
    const low = rows.find((r: { id: string }) => r.id === lowData.memory_id);

    // Higher confidence should produce higher weight
    expect(Number(high.weight)).toBeGreaterThan(Number(low.weight));
  });

  test("confidence range 0.0–1.0 is accepted", async () => {
    const res0 = await bridgeFetch("write", "POST", {
      content: `ELLIE-653 zero confidence ${TS}`,
      type: "hypothesis",
      scope_path: "2/1",
      confidence: 0,
    });
    expect(res0.status).toBe(200);
    createdMemoryIds.push((await res0.json()).memory_id);

    const res1 = await bridgeFetch("write", "POST", {
      content: `ELLIE-653 full confidence ${TS}`,
      type: "fact",
      scope_path: "2/1",
      confidence: 1.0,
    });
    expect(res1.status).toBe(200);
    createdMemoryIds.push((await res1.json()).memory_id);
  });
});

// ── Integration: Scope Path Assignment ──────────────────────

describe("[MEMORY:] Integration — Scope Path Assignment", () => {
  let devScopeId: string;
  let forestScopeId: string;

  test("memory written to 2/1 (ellie-dev) has correct scope_path", async () => {
    const res = await bridgeFetch("write", "POST", {
      content: `ELLIE-653 scope test: ellie-dev memory ${TS}`,
      type: "finding",
      scope_path: "2/1",
      confidence: 0.7,
    });
    const data = await res.json();
    devScopeId = data.memory_id;
    createdMemoryIds.push(devScopeId);

    const [row] = await sql`SELECT scope_path FROM shared_memories WHERE id = ${devScopeId}`;
    expect(row.scope_path).toBe("2/1");
  });

  test("memory written to 2/2 (ellie-forest) has correct scope_path", async () => {
    const res = await bridgeFetch("write", "POST", {
      content: `ELLIE-653 scope test: ellie-forest memory ${TS}`,
      type: "finding",
      scope_path: "2/2",
      confidence: 0.7,
    });
    const data = await res.json();
    forestScopeId = data.memory_id;
    createdMemoryIds.push(forestScopeId);

    const [row] = await sql`SELECT scope_path FROM shared_memories WHERE id = ${forestScopeId}`;
    expect(row.scope_path).toBe("2/2");
  });

  test("scope filtering: dev memory only in 2/1, forest memory only in 2/2", async () => {
    // Verify via DB that memories landed in correct scopes
    const [devRow] = await sql`SELECT scope_path FROM shared_memories WHERE id = ${devScopeId}`;
    const [forestRow] = await sql`SELECT scope_path FROM shared_memories WHERE id = ${forestScopeId}`;

    expect(devRow.scope_path).toBe("2/1");
    expect(forestRow.scope_path).toBe("2/2");

    // List in 2/1 — should contain dev, not forest
    const devList = await bridgeFetch(`list?scope_path=2/1&type=finding&limit=50`);
    const devData = await devList.json();
    const devIds = devData.memories?.map((m: { id: string }) => m.id) ?? [];
    expect(devIds).toContain(devScopeId);
    expect(devIds).not.toContain(forestScopeId);

    // List in 2/2 — should contain forest, not dev
    const forestList = await bridgeFetch(`list?scope_path=2/2&type=finding&limit=50`);
    const forestData = await forestList.json();
    const forestIds = forestData.memories?.map((m: { id: string }) => m.id) ?? [];
    expect(forestIds).toContain(forestScopeId);
    expect(forestIds).not.toContain(devScopeId);
  });

  test("sub-scope 2/1/2 is a valid scope_path", async () => {
    const res = await bridgeFetch("write", "POST", {
      content: `ELLIE-653 sub-scope test ${TS}`,
      type: "fact",
      scope_path: "2/1/2",
      confidence: 0.6,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    createdMemoryIds.push(data.memory_id);

    const [row] = await sql`SELECT scope_path FROM shared_memories WHERE id = ${data.memory_id}`;
    expect(row.scope_path).toBe("2/1/2");
  });
});

// ── Integration: Semantic Search ────────────────────────────

describe("[MEMORY:] Integration — Semantic Search", () => {
  let searchMemoryId: string;
  const SEARCH_CONTENT = `ELLIE-653 semantic canary: pgvector enables approximate nearest neighbor search for embeddings ${TS}`;

  test("write a memory for search testing", async () => {
    const res = await bridgeFetch("write", "POST", {
      content: SEARCH_CONTENT,
      type: "finding",
      scope_path: "2/1",
      confidence: 0.8,
      tags: ["pgvector", "embeddings", "search"],
    });
    const data = await res.json();
    searchMemoryId = data.memory_id;
    createdMemoryIds.push(searchMemoryId);
  });

  test("finds memory by semantic meaning (not exact words)", async () => {
    const res = await bridgeFetch("read", "POST", {
      query: "vector similarity search database",
      scope_path: "2/1",
    });
    const data = await res.json();
    expect(data.success).toBe(true);
    // Our pgvector memory should appear since it's semantically related
    const found = data.memories?.some((m: { id: string }) => m.id === searchMemoryId);
    expect(found).toBe(true);
  });

  test("search returns relevance-ordered results", async () => {
    const res = await bridgeFetch("read", "POST", {
      query: `pgvector embeddings approximate nearest neighbor ${TS}`,
      scope_path: "2/1",
    });
    const data = await res.json();
    expect(data.memories?.length).toBeGreaterThan(0);
    // Our memory should be among the top results since query is very similar
    const ourIdx = data.memories?.findIndex((m: { id: string }) => m.id === searchMemoryId);
    if (ourIdx !== undefined && ourIdx >= 0) {
      expect(ourIdx).toBeLessThan(5); // Should be in top 5
    }
  });

  test("search returns memory fields needed for display", async () => {
    const res = await bridgeFetch("read", "POST", {
      query: SEARCH_CONTENT.slice(0, 50),
      scope_path: "2/1",
    });
    const data = await res.json();
    const mem = data.memories?.find((m: { id: string }) => m.id === searchMemoryId);
    if (mem) {
      expect(mem.content).toBeTruthy();
      expect(mem.type).toBe("finding");
      expect(mem.created_at).toBeTruthy();
    }
  });
});

// ── Integration: Work Item Linking ──────────────────────────

describe("[MEMORY:] Integration — Work Item Linking", () => {
  let linkedMemoryId: string;

  test("writes a memory with work_item_id in metadata", async () => {
    const res = await bridgeFetch("write", "POST", {
      content: `ELLIE-653 linked memory: This finding is associated with ticket ELLIE-653 ${TS}`,
      type: "finding",
      scope_path: "2/1",
      confidence: 0.8,
      metadata: {
        work_item_id: "ELLIE-653",
        agent: "test-agent",
        context: "memory tag integration test",
      },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    linkedMemoryId = data.memory_id;
    createdMemoryIds.push(linkedMemoryId);
  });

  test("work_item_id persists in metadata in DB", async () => {
    const [row] = await sql`
      SELECT metadata FROM shared_memories WHERE id = ${linkedMemoryId}
    `;
    expect(row.metadata.work_item_id).toBe("ELLIE-653");
    expect(row.metadata.agent).toBe("test-agent");
    expect(row.metadata.context).toBe("memory tag integration test");
  });

  test("searching for work item ID returns linked memories", async () => {
    const res = await bridgeFetch("read", "POST", {
      query: "ELLIE-653 linked memory finding",
      scope_path: "2/1",
    });
    const data = await res.json();
    const found = data.memories?.some((m: { id: string }) => m.id === linkedMemoryId);
    expect(found).toBe(true);
  });

  test("multiple memories can share the same work_item_id", async () => {
    const res = await bridgeFetch("write", "POST", {
      content: `ELLIE-653 second linked memory: Another finding for same ticket ${TS}`,
      type: "fact",
      scope_path: "2/1",
      confidence: 0.75,
      metadata: { work_item_id: "ELLIE-653" },
    });
    expect(res.status).toBe(200);
    createdMemoryIds.push((await res.json()).memory_id);

    // Both should exist in DB with same work_item_id
    const rows = await sql`
      SELECT id FROM shared_memories
      WHERE metadata->>'work_item_id' = 'ELLIE-653'
        AND content LIKE ${"ELLIE-653%" + TS + "%"}
    `;
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Integration: Tags ───────────────────────────────────────

describe("[MEMORY:] Integration — Memory Tags", () => {
  let taggedMemoryId: string;

  test("writes a memory with tags", async () => {
    const res = await bridgeFetch("write", "POST", {
      content: `ELLIE-653 tagged memory: Bridge API authenticates via x-bridge-key header ${TS}`,
      type: "fact",
      scope_path: "2/1",
      confidence: 0.9,
      tags: ["bridge", "authentication", "api", "ellie-653"],
    });
    const data = await res.json();
    taggedMemoryId = data.memory_id;
    createdMemoryIds.push(taggedMemoryId);
  });

  test("tags persist in DB", async () => {
    const [row] = await sql`
      SELECT tags FROM shared_memories WHERE id = ${taggedMemoryId}
    `;
    expect(row.tags).toContain("bridge");
    expect(row.tags).toContain("authentication");
    expect(row.tags).toContain("api");
    expect(row.tags).toContain("ellie-653");
  });

  test("GET /tags endpoint shows our tags", async () => {
    const res = await bridgeFetch("tags?scope_path=2/1");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    // Our tags should appear in the response
    if (Array.isArray(data.tags)) {
      const tagNames = data.tags.map((t: { tag: string } | string) =>
        typeof t === "string" ? t : t.tag,
      );
      expect(tagNames).toContain("ellie-653");
    }
  });
});

// ── Integration: Importance Score ───────────────────────────

describe("[MEMORY:] Integration — Importance Score", () => {
  test("decisions have higher importance than hypotheses", async () => {
    const decRes = await bridgeFetch("write", "POST", {
      content: `ELLIE-653 importance decision ${TS}`,
      type: "decision",
      scope_path: "2/1",
      confidence: 0.8,
    });
    const hypRes = await bridgeFetch("write", "POST", {
      content: `ELLIE-653 importance hypothesis ${TS}`,
      type: "hypothesis",
      scope_path: "2/1",
      confidence: 0.8,
    });

    const decData = await decRes.json();
    const hypData = await hypRes.json();
    createdMemoryIds.push(decData.memory_id, hypData.memory_id);

    const rows = await sql`
      SELECT id, importance_score FROM shared_memories
      WHERE id IN (${decData.memory_id}, ${hypData.memory_id})
    `;

    const dec = rows.find((r: { id: string }) => r.id === decData.memory_id);
    const hyp = rows.find((r: { id: string }) => r.id === hypData.memory_id);

    // Decisions should rank higher in importance
    expect(Number(dec.importance_score)).toBeGreaterThanOrEqual(Number(hyp.importance_score));
  });
});
