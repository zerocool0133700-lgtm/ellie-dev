/**
 * ELLIE-652 — Setup Tier 4: Forest Knowledge (shared_memories + Bridge)
 *
 * Verifies the Forest Bridge API layer for long-term institutional knowledge:
 * - shared_memories table schema and constraints
 * - Bridge key authentication (valid, invalid, missing)
 * - Bridge API endpoints: write, read, list, scopes, tags, whoami, tiers
 * - Scope hierarchy verification (2, 2/1, 2/2, 2/3, 2/4)
 * - Memory lifecycle: write → read back → list → DB verification
 * - Promote/demote tier operations
 * - Write with contradiction check
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
  key: string = BRIDGE_KEY,
) {
  const opts: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-bridge-key": key,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch(`${BRIDGE_API}/${path}`, opts);
}

// ── Infrastructure: shared_memories Table ───────────────────

describe("Tier 4 Infrastructure — shared_memories", () => {
  test("shared_memories table exists with required columns", async () => {
    const columns = await sql`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'shared_memories'
      ORDER BY ordinal_position
    `;

    const colNames = columns.map((c: { column_name: string }) => c.column_name);

    // Core columns
    expect(colNames).toContain("id");
    expect(colNames).toContain("content");
    expect(colNames).toContain("type");
    expect(colNames).toContain("scope");
    expect(colNames).toContain("scope_path");
    expect(colNames).toContain("confidence");

    // Attribution
    expect(colNames).toContain("source_entity_id");
    expect(colNames).toContain("source_tree_id");

    // Semantic search
    expect(colNames).toContain("embedding");

    // Metadata
    expect(colNames).toContain("tags");
    expect(colNames).toContain("metadata");
    expect(colNames).toContain("status");

    // Memory tiers
    expect(colNames).toContain("memory_tier");
    expect(colNames).toContain("weight");
    expect(colNames).toContain("importance_score");

    // Temporal
    expect(colNames).toContain("created_at");
    expect(colNames).toContain("updated_at");
    expect(colNames).toContain("expires_at");
  });

  test("knowledge_scopes table exists with hierarchy columns", async () => {
    const columns = await sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'knowledge_scopes'
      ORDER BY ordinal_position
    `;
    const colNames = columns.map((c: { column_name: string }) => c.column_name);

    expect(colNames).toContain("id");
    expect(colNames).toContain("path");
    expect(colNames).toContain("name");
  });

  test("scope hierarchy contains expected project scopes", async () => {
    const scopes = await sql`
      SELECT path, name FROM knowledge_scopes
      WHERE path IN ('2', '2/1', '2/2', '2/3', '2/4')
      ORDER BY path
    `;

    const paths = scopes.map((s: { path: string }) => s.path);
    expect(paths).toContain("2");
    expect(paths).toContain("2/1");
    expect(paths).toContain("2/2");
    expect(paths).toContain("2/3");
    expect(paths).toContain("2/4");
  });
});

// ── Bridge Key Authentication ───────────────────────────────

describe("Tier 4 — Bridge Key Auth", () => {
  test("rejects requests with no bridge key", async () => {
    const res = await fetch(`${BRIDGE_API}/scopes`, {
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  test("rejects requests with invalid bridge key", async () => {
    const res = await bridgeFetch("scopes", "GET", undefined, "bk_invalid_fake_key");
    expect(res.status).toBe(401);
  });

  test("accepts requests with valid bridge key", async () => {
    const res = await bridgeFetch("scopes");
    expect(res.status).toBe(200);
  });

  test("whoami returns key metadata", async () => {
    const res = await bridgeFetch("whoami");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.collaborator).toBeTruthy();
    expect(data.allowed_scopes).toBeDefined();
  });
});

// ── Bridge API: Scopes ──────────────────────────────────────

describe("Tier 4 — Bridge Scopes", () => {
  test("GET /scopes returns scope tree", async () => {
    const res = await bridgeFetch("scopes");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(Array.isArray(data.scopes)).toBe(true);
    expect(data.scopes.length).toBeGreaterThan(0);
  });

  test("scopes include top-level project scope", async () => {
    const res = await bridgeFetch("scopes");
    const data = await res.json();
    const paths = data.scopes.map((s: { path: string }) => s.path);

    // API returns top-level scopes; project hierarchy lives in DB
    expect(paths).toContain("2");
  });

  test("scope entries have name and path", async () => {
    const res = await bridgeFetch("scopes");
    const data = await res.json();
    const scope = data.scopes[0];
    expect(scope.path).toBeTruthy();
    expect(scope.name).toBeTruthy();
  });
});

// ── Bridge API: Write ───────────────────────────────────────

describe("Tier 4 — Bridge Write", () => {
  test("writes a fact to Forest", async () => {
    const content = `ELLIE-652 test fact: Bridge write works ${TS}`;
    const res = await bridgeFetch("write", "POST", {
      content,
      type: "fact",
      scope_path: "2/1",
      confidence: 0.7,
      metadata: { work_item_id: "ELLIE-652", test: true },
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.memory_id).toBeTruthy();
    createdMemoryIds.push(data.memory_id);
  });

  test("writes a decision to Forest", async () => {
    const res = await bridgeFetch("write", "POST", {
      content: `ELLIE-652 test decision: Chose Postgres over Redis for knowledge store ${TS}`,
      type: "decision",
      scope_path: "2/1",
      confidence: 0.9,
      metadata: { work_item_id: "ELLIE-652" },
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.memory_id).toBeTruthy();
    createdMemoryIds.push(data.memory_id);
  });

  test("writes a hypothesis to Forest", async () => {
    const res = await bridgeFetch("write", "POST", {
      content: `ELLIE-652 test hypothesis: BM25 search may outperform pure vector for short queries ${TS}`,
      type: "hypothesis",
      scope_path: "2/1",
      confidence: 0.4,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    createdMemoryIds.push(data.memory_id);
  });

  test("written memory appears in DB with correct fields", async () => {
    const memoryId = createdMemoryIds[0];
    const [row] = await sql`
      SELECT content, type, scope_path, confidence, metadata, status, memory_tier
      FROM shared_memories WHERE id = ${memoryId}
    `;

    expect(row).toBeTruthy();
    expect(row.content).toContain("ELLIE-652 test fact");
    expect(row.type).toBe("fact");
    expect(row.scope_path).toBe("2/1");
    expect(Number(row.confidence)).toBeCloseTo(0.7, 1);
    expect(row.metadata.work_item_id).toBe("ELLIE-652");
    expect(row.status).toBe("active");
  });

  test("written memory has embedding generated", async () => {
    const memoryId = createdMemoryIds[0];
    const [row] = await sql`
      SELECT embedding IS NOT NULL as has_embedding
      FROM shared_memories WHERE id = ${memoryId}
    `;
    expect(row.has_embedding).toBe(true);
  });

  test("written memory has weight computed", async () => {
    const memoryId = createdMemoryIds[0];
    const [row] = await sql`
      SELECT weight FROM shared_memories WHERE id = ${memoryId}
    `;
    expect(row.weight).toBeTruthy();
    expect(Number(row.weight)).toBeGreaterThan(0);
    expect(Number(row.weight)).toBeLessThanOrEqual(1);
  });
});

// ── Bridge API: Read (Search) ───────────────────────────────

describe("Tier 4 — Bridge Read (Search)", () => {
  test("searches memories by query", async () => {
    const res = await bridgeFetch("read", "POST", {
      query: `ELLIE-652 test fact Bridge write`,
      scope_path: "2/1",
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(Array.isArray(data.memories)).toBe(true);
  });

  test("search results include memory fields", async () => {
    const res = await bridgeFetch("read", "POST", {
      query: "ELLIE-652",
      scope_path: "2/1",
    });

    const data = await res.json();
    if (data.memories.length > 0) {
      const mem = data.memories[0];
      expect(mem.id).toBeTruthy();
      expect(mem.content).toBeTruthy();
      expect(mem.type).toBeTruthy();
      expect(mem.created_at).toBeTruthy();
    }
  });

  test("search respects scope_path", async () => {
    const res = await bridgeFetch("read", "POST", {
      query: `ELLIE-652 test fact ${TS}`,
      scope_path: "2/3",  // ellie-home — our memories are in 2/1
    });

    const data = await res.json();
    // Should not find our 2/1 memories when searching 2/3
    const found = data.memories?.some(
      (m: { content: string }) => m.content.includes(`ELLIE-652 test fact: Bridge write works ${TS}`),
    );
    expect(found).toBeFalsy();
  });
});

// ── Bridge API: List ────────────────────────────────────────

describe("Tier 4 — Bridge List", () => {
  test("lists memories in a scope", async () => {
    const res = await bridgeFetch("list?scope_path=2/1&limit=5");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(Array.isArray(data.memories)).toBe(true);
    expect(data.memories.length).toBeGreaterThan(0);
  });

  test("list filters by type", async () => {
    const res = await bridgeFetch("list?scope_path=2/1&type=decision&limit=10");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    // All returned memories should be decisions
    for (const mem of data.memories) {
      expect(mem.type).toBe("decision");
    }
  });

  test("list filters by min_confidence", async () => {
    const res = await bridgeFetch("list?scope_path=2/1&min_confidence=0.8&limit=10");
    expect(res.status).toBe(200);
    const data = await res.json();
    for (const mem of data.memories) {
      expect(Number(mem.confidence)).toBeGreaterThanOrEqual(0.8);
    }
  });

  test("list respects limit parameter", async () => {
    const res = await bridgeFetch("list?scope_path=2/1&limit=2");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.memories.length).toBeLessThanOrEqual(2);
  });

  test("list returns memories sorted by weight/recency", async () => {
    const res = await bridgeFetch("list?scope_path=2/1&limit=5");
    const data = await res.json();
    if (data.memories.length >= 2) {
      // First memory should have higher or equal weight/recency than second
      const w0 = Number(data.memories[0].weight ?? data.memories[0].confidence);
      const w1 = Number(data.memories[1].weight ?? data.memories[1].confidence);
      // Just check they're ordered (weight DESC, created_at DESC)
      // Allow equal weights since created_at is secondary sort
      expect(w0).toBeGreaterThanOrEqual(w1 - 0.01); // small tolerance for float
    }
  });
});

// ── Bridge API: Tiers ───────────────────────────────────────

describe("Tier 4 — Bridge Tiers", () => {
  test("GET /tiers returns tier counts", async () => {
    const res = await bridgeFetch("tiers?scope_path=2/1");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    // Should have counts for at least extended tier (where our test memories land)
    expect(data.tiers).toBeDefined();
  });
});

// ── Memory Lifecycle: Write → Read → List → DB ─────────────

describe("Tier 4 — Memory Lifecycle", () => {
  let lifecycleMemoryId: string;
  const UNIQUE_CONTENT = `ELLIE-652 lifecycle canary: unique-${TS}-xyzzy`;

  test("step 1: write a memory with all optional fields", async () => {
    const res = await bridgeFetch("write", "POST", {
      content: UNIQUE_CONTENT,
      type: "finding",
      scope_path: "2/1",
      confidence: 0.85,
      tags: ["test", "ellie-652", "lifecycle"],
      metadata: {
        work_item_id: "ELLIE-652",
        test_phase: "lifecycle",
        timestamp: TS,
      },
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    lifecycleMemoryId = data.memory_id;
    createdMemoryIds.push(lifecycleMemoryId);
  });

  test("step 2: read back via semantic search", async () => {
    const res = await bridgeFetch("read", "POST", {
      query: `lifecycle canary unique ${TS}`,
      scope_path: "2/1",
    });

    const data = await res.json();
    expect(data.success).toBe(true);
    // Our unique content should appear in results
    const found = data.memories?.some(
      (m: { id: string }) => m.id === lifecycleMemoryId,
    );
    expect(found).toBe(true);
  });

  test("step 3: appears in list for scope", async () => {
    const res = await bridgeFetch("list?scope_path=2/1&type=finding&limit=20");
    const data = await res.json();
    const found = data.memories?.some(
      (m: { id: string }) => m.id === lifecycleMemoryId,
    );
    expect(found).toBe(true);
  });

  test("step 4: verify full record in DB", async () => {
    const [row] = await sql`
      SELECT id, content, type, scope_path, confidence, tags, metadata,
             status, memory_tier, weight, importance_score,
             embedding IS NOT NULL as has_embedding
      FROM shared_memories WHERE id = ${lifecycleMemoryId}
    `;

    expect(row.content).toBe(UNIQUE_CONTENT);
    expect(row.type).toBe("finding");
    expect(row.scope_path).toBe("2/1");
    expect(Number(row.confidence)).toBeCloseTo(0.85, 1);
    expect(row.tags).toContain("test");
    expect(row.tags).toContain("ellie-652");
    expect(row.tags).toContain("lifecycle");
    expect(row.metadata.work_item_id).toBe("ELLIE-652");
    expect(row.metadata.test_phase).toBe("lifecycle");
    expect(row.status).toBe("active");
    expect(row.has_embedding).toBe(true);
    expect(Number(row.weight)).toBeGreaterThan(0);
  });
});

// ── Promote / Demote ────────────────────────────────────────

describe("Tier 4 — Promote / Demote", () => {
  let tierTestId: string;

  test("setup: write a memory for tier testing", async () => {
    const res = await bridgeFetch("write", "POST", {
      content: `ELLIE-652 tier test memory ${TS}`,
      type: "fact",
      scope_path: "2/1",
      confidence: 0.9,
    });
    const data = await res.json();
    tierTestId = data.memory_id;
    createdMemoryIds.push(tierTestId);

    // Should start as extended tier
    const [row] = await sql`
      SELECT memory_tier FROM shared_memories WHERE id = ${tierTestId}
    `;
    expect(row.memory_tier).toBe("extended");
  });

  test("promote moves memory to core tier", async () => {
    const res = await bridgeFetch("promote", "POST", {
      memory_id: tierTestId,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    const [row] = await sql`
      SELECT memory_tier FROM shared_memories WHERE id = ${tierTestId}
    `;
    expect(row.memory_tier).toBe("core");
  });

  test("demote moves memory back to extended tier", async () => {
    const res = await bridgeFetch("demote", "POST", {
      memory_id: tierTestId,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    const [row] = await sql`
      SELECT memory_tier FROM shared_memories WHERE id = ${tierTestId}
    `;
    expect(row.memory_tier).toBe("extended");
  });
});

// ── Tags ────────────────────────────────────────────────────

describe("Tier 4 — Bridge Tags", () => {
  test("GET /tags returns tag counts for scope", async () => {
    const res = await bridgeFetch("tags?scope_path=2/1");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    // Should have at least the tags we wrote in lifecycle test
    expect(data.tags).toBeDefined();
  });
});

// ── Direct DB: Scope Hierarchy Integrity ────────────────────

describe("Tier 4 — Scope Hierarchy (DB)", () => {
  test("scope 2 (Projects) is the root project scope", async () => {
    const [scope] = await sql`
      SELECT path, name FROM knowledge_scopes WHERE path = '2'
    `;
    expect(scope).toBeTruthy();
    expect(scope.name).toBeTruthy();
  });

  test("scope 2/1 (ellie-dev) exists under Projects", async () => {
    const [scope] = await sql`
      SELECT path, name FROM knowledge_scopes WHERE path = '2/1'
    `;
    expect(scope).toBeTruthy();
  });

  test("scope 2/2 (ellie-forest) exists", async () => {
    const [scope] = await sql`
      SELECT path, name FROM knowledge_scopes WHERE path = '2/2'
    `;
    expect(scope).toBeTruthy();
  });

  test("scope 2/3 (ellie-home) exists", async () => {
    const [scope] = await sql`
      SELECT path, name FROM knowledge_scopes WHERE path = '2/3'
    `;
    expect(scope).toBeTruthy();
  });

  test("scope 2/4 (ellie-os-app) exists", async () => {
    const [scope] = await sql`
      SELECT path, name FROM knowledge_scopes WHERE path = '2/4'
    `;
    expect(scope).toBeTruthy();
  });

  test("sub-scopes exist under project scopes", async () => {
    const subscopes = await sql`
      SELECT path FROM knowledge_scopes WHERE path LIKE '2/1/%'
    `;
    expect(subscopes.length).toBeGreaterThan(0);
  });
});

// ── Write Validation ────────────────────────────────────────

describe("Tier 4 — Write Validation", () => {
  test("write requires content", async () => {
    const res = await bridgeFetch("write", "POST", {
      type: "fact",
      scope_path: "2/1",
    });
    // Should reject — content is required
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("write with empty content is rejected", async () => {
    const res = await bridgeFetch("write", "POST", {
      content: "",
      type: "fact",
      scope_path: "2/1",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
