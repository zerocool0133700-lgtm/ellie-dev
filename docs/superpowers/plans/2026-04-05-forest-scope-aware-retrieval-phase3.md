# Forest Scope-Aware Retrieval — Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Forest's structure visible to consumers — context builder retrieves knowledge by scope (not just keywords), Oak becomes the convergence index, and groves enable shared knowledge.

**Architecture:** Three layers: (1) Add scope_path to Elasticsearch so all search paths can filter by scope. (2) Wire agent scope resolution into the chat pipeline so `_gatherContextSources()` searches the right subtree. (3) Transform Oak (R/1) from a file listing into a domain-convergence index. (4) Add grove-based knowledge sharing so shared trees surface in context.

**Tech Stack:** TypeScript, postgres.js, ellie-forest library, Elasticsearch, Bun test runner

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `ellie-dev/src/elasticsearch.ts` | **Modify** | Add `scope_path` to indexing and search filtering |
| `ellie-dev/tests/elasticsearch-scope.test.ts` | **Create** | Tests for scope-aware ES search |
| `ellie-dev/src/context-sources.ts` | **Modify** | Add `getScopedForestContext()` — scope-resolved Forest retrieval |
| `ellie-dev/tests/scoped-context.test.ts` | **Create** | Tests for scope-aware context retrieval |
| `ellie-dev/src/ellie-chat-pipeline.ts` | **Modify** | Wire scope resolution into `_gatherContextSources()` |
| `ellie-dev/src/ellie-chat-handler.ts` | **Modify** | Pass activeAgent to scoped search in direct chat path |
| `ellie-dev/src/api/bridge-river.ts` | **Modify** | Transform `syncOakCatalog()` into Oak convergence index |
| `ellie-dev/tests/oak-convergence.test.ts` | **Create** | Tests for Oak index builder |
| `ellie-forest/src/groves.ts` | **Modify** | Add `getGroveSharedKnowledge()` for grove-scoped retrieval |
| `ellie-forest/tests/grove-knowledge.test.ts` | **Create** | Tests for grove knowledge sharing |
| `ellie-dev/scripts/backfill-es-scope.ts` | **Create** | One-time ES scope_path backfill script |

---

### Task 1: Add scope_path to Elasticsearch Indexing

Elasticsearch `ellie-memory` index currently stores `id`, `content`, `type`, `domain`, `created_at`, `metadata` — but NOT `scope_path`. Every call to `indexMemory()` already has scope_path available in the caller context. Add it to the indexed document so search can filter by scope.

**Files:**
- Modify: `ellie-dev/src/elasticsearch.ts:142-161`
- Create: `ellie-dev/tests/elasticsearch-scope.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// ellie-dev/tests/elasticsearch-scope.test.ts
import { describe, test, expect } from "bun:test";
import { classifyDomain } from "../src/elasticsearch";

describe("indexMemory scope_path support", () => {
  test("classifyDomain still works for domain classification", () => {
    expect(classifyDomain("relay server architecture")).toBe("architecture");
    expect(classifyDomain("Dave's morning routine")).toBe("personal");
    expect(classifyDomain("quarterly revenue targets")).toBe("business");
  });
});
```

- [ ] **Step 2: Run test to verify it passes (baseline)**

Run: `cd /home/ellie/ellie-dev && bun test tests/elasticsearch-scope.test.ts`
Expected: PASS — confirms `classifyDomain` is importable and working.

- [ ] **Step 3: Add scope_path to indexMemory signature**

In `ellie-dev/src/elasticsearch.ts`, modify the `indexMemory` function to accept and store `scope_path`:

```typescript
export async function indexMemory(doc: {
  id: string;
  content: string;
  type: string;
  domain?: string;
  created_at: string;
  conversation_id?: string;
  scope_path?: string;          // NEW: Forest scope path
  metadata?: Record<string, unknown>;
}): Promise<void> {
  if (!(await checkHealth())) return;

  try {
    await esRequest("PUT", `/ellie-memory/_doc/${doc.id}`, {
      ...doc,
      domain: doc.domain || classifyDomain(doc.content),
    });
  } catch (err) {
    logger.error("Failed to index memory", err);
  }
}
```

- [ ] **Step 4: Add scope_path filter to searchElastic**

In `ellie-dev/src/elasticsearch.ts`, add `scope_path` to the search options and filter chain:

```typescript
export async function searchElastic(
  query: string,
  options?: {
    domains?: string[];
    types?: string[];
    channel?: string;
    sourceAgent?: string;
    excludeConversationId?: string;
    scope_path?: string;        // NEW: filter by scope prefix
    limit?: number;
    recencyBoost?: boolean;
  }
): Promise<string>
```

In the filter-building section (after the existing filters), add the scope_path filter:

```typescript
if (options?.scope_path) {
  // Prefix match — scope_path "2/1" matches "2/1", "2/1/1", "2/1/2", etc.
  filters.push({ prefix: { scope_path: options.scope_path } });
}
```

- [ ] **Step 5: Run tests**

Run: `cd /home/ellie/ellie-dev && bun test tests/elasticsearch-scope.test.ts`
Expected: PASS

- [ ] **Step 6: Update all indexMemory callers to pass scope_path**

There are 4 callers of `indexMemory()` that already have scope_path available:

1. `ellie-dev/src/periodic-tasks-helpers.ts:96-105` (graduation) — `writeMemory()` returns `{ memory, contradictions }`. Pass `memory.scope_path`:
```typescript
await indexMemory({
  id: forestMemory.memory.id,
  content: fact.content,
  type: 'fact',
  domain: classifyDomain(fact.content),
  created_at: fact.created_at,
  scope_path: forestMemory.memory.scope_path,  // NEW
  metadata: { source: 'shared_memories' },
});
```
Note: The graduation code currently uses `forestMemory.id` — check if it already destructures `.memory` or uses the raw return. Adjust accordingly.

2. `ellie-dev/src/sync-conversation-facts.ts:112-120` (conversation facts sync) — `writeMemory()` returns `{ memory, contradictions }`. The existing code uses `memory.id` (already destructured). Pass `memory.scope_path`:
```typescript
await indexMemory({
  id: memory.id,
  content: fact.content,
  type: mapFactType(fact.type),
  domain: classifyDomain(fact.content),
  created_at: fact.created_at || new Date().toISOString(),
  scope_path: memory.scope_path,  // NEW: from writeMemory result
  metadata: { source: 'shared_memories' },
});
```

3. `ellie-dev/src/creature-findings.ts` (creature findings persist) — pass `scope_path` from writeMemory result.

4. Any other `indexMemory()` callers — search for all callers and add `scope_path` where available.

- [ ] **Step 7: Run all tests to verify no regressions**

Run: `cd /home/ellie/ellie-dev && bun test`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/elasticsearch.ts src/periodic-tasks-helpers.ts src/sync-conversation-facts.ts src/creature-findings.ts tests/elasticsearch-scope.test.ts
git commit -m "[ELLIE-1428] feat: add scope_path to ES indexing and search filtering

Phase 3 Task 1: Elasticsearch now stores scope_path on memory documents
and searchElastic() accepts scope_path for prefix-filtered search."
```

---

### Task 2: Backfill Existing ES Documents with scope_path

Existing `ellie-memory` ES documents have no `scope_path` field. Write a one-time script that reads all `shared_memories` from Forest and updates their ES documents.

**Files:**
- Create: `ellie-dev/scripts/backfill-es-scope.ts`

- [ ] **Step 1: Write the backfill script**

```typescript
// ellie-dev/scripts/backfill-es-scope.ts
/**
 * One-time backfill: Add scope_path to all ellie-memory ES documents.
 * Reads scope_path from Forest shared_memories and updates ES.
 *
 * Usage: bun run scripts/backfill-es-scope.ts [--dry-run]
 */

import forestSql from "../../ellie-forest/src/db.ts";
import { indexMemory, classifyDomain } from "../src/elasticsearch.ts";

const dryRun = process.argv.includes("--dry-run");

async function backfill() {
  // Fetch all active memories with scope_path
  const memories = await forestSql`
    SELECT id, content, type, scope_path, created_at
    FROM shared_memories
    WHERE status = 'active'
      AND scope_path IS NOT NULL
    ORDER BY created_at DESC
  `;

  console.log(`Found ${memories.length} memories with scope_path to backfill`);

  if (dryRun) {
    // Show distribution
    const dist = new Map<string, number>();
    for (const m of memories) {
      const prefix = m.scope_path.split("/").slice(0, 2).join("/");
      dist.set(prefix, (dist.get(prefix) || 0) + 1);
    }
    console.log("Scope distribution:");
    for (const [scope, count] of [...dist.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${scope}: ${count}`);
    }
    return;
  }

  let updated = 0;
  let failed = 0;

  for (const mem of memories) {
    try {
      await indexMemory({
        id: mem.id,
        content: mem.content,
        type: mem.type,
        domain: classifyDomain(mem.content),
        created_at: mem.created_at,
        scope_path: mem.scope_path,
        metadata: { source: "shared_memories" },
      });
      updated++;
      if (updated % 100 === 0) {
        console.log(`  ... ${updated}/${memories.length} updated`);
      }
    } catch (err) {
      failed++;
      console.error(`  Failed: ${mem.id}`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`Backfill complete: ${updated} updated, ${failed} failed`);
  process.exit(0);
}

backfill().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Run dry-run to verify**

Run: `cd /home/ellie/ellie-dev && bun run scripts/backfill-es-scope.ts --dry-run`
Expected: Shows count and scope distribution, no writes.

- [ ] **Step 3: Run the actual backfill**

Run: `cd /home/ellie/ellie-dev && bun run scripts/backfill-es-scope.ts`
Expected: Updates all ES documents with scope_path.

- [ ] **Step 4: Commit**

```bash
git add scripts/backfill-es-scope.ts
git commit -m "[ELLIE-1428] chore: backfill ES documents with scope_path

Phase 3 Task 2: One-time script to populate scope_path in ellie-memory
ES index from Forest shared_memories."
```

---

### Task 3: Scope-Aware Forest Context Source

Create `getScopedForestContext()` — a new context source that resolves the active agent's scope and queries Forest `readMemoriesByPath()` directly, instead of relying on keyword-only ES search.

**Files:**
- Modify: `ellie-dev/src/context-sources.ts`
- Create: `ellie-dev/tests/scoped-context.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// ellie-dev/tests/scoped-context.test.ts
import { describe, test, expect } from "bun:test";
import { resolveAgentScope } from "../src/context-sources";

describe("resolveAgentScope", () => {
  test("resolves dev agent to 2/1", () => {
    expect(resolveAgentScope("dev")).toBe("2/1");
  });

  test("resolves general agent to 2", () => {
    expect(resolveAgentScope("general")).toBe("2");
  });

  test("resolves unknown agent to 2", () => {
    expect(resolveAgentScope("unknown-agent")).toBe("2");
  });

  test("resolves research agent to 2", () => {
    expect(resolveAgentScope("research")).toBe("2");
  });

  test("resolves critic agent to 2/1", () => {
    expect(resolveAgentScope("critic")).toBe("2/1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ellie/ellie-dev && bun test tests/scoped-context.test.ts`
Expected: FAIL — `resolveAgentScope` is not exported.

- [ ] **Step 3: Implement resolveAgentScope and getScopedForestContext**

Add to `ellie-dev/src/context-sources.ts`:

```typescript
/**
 * Resolve an agent's primary search scope.
 * Uses the same mapping as ellie-forest/src/scoped-search.ts AGENT_SCOPE_MAP.
 * Kept here to avoid circular import from the pipeline.
 */
const AGENT_PRIMARY_SCOPE: Record<string, string> = {
  dev:      "2/1",
  research: "2",
  content:  "2",
  critic:   "2/1",
  strategy: "2",
  ops:      "2/1",
  finance:  "2",
  general:  "2",
  ellie:    "2",
};

export function resolveAgentScope(agent: string): string {
  return AGENT_PRIMARY_SCOPE[agent.toLowerCase()] || "2";
}

/**
 * ELLIE-1428 Phase 3: Scope-aware Forest context retrieval.
 * Resolves agent → scope, then queries Forest readMemoriesByPath()
 * for knowledge within that subtree. Returns formatted context block.
 */
export async function getScopedForestContext(
  query: string,
  agent: string,
  opts?: { limit?: number; workItemId?: string }
): Promise<string> {
  if (!query || query.length < 10) return "";

  try {
    const { readMemoriesForAgent } = await import("../../ellie-forest/src/index.ts");
    const scope = resolveAgentScope(agent);

    const results = await readMemoriesForAgent({
      query,
      agent,
      scope_path: scope,
      match_count: opts?.limit ?? 8,
      match_threshold: 0.5,
    });

    if (!results || results.length === 0) return "";

    const lines = results.map((r: any) => {
      const scopeTag = r.scope_path || "?";
      const typeTag = r.type || "memory";
      const confidence = r.confidence ? ` (${Math.round(r.confidence * 100)}%)` : "";
      return `- [${typeTag}, ${scopeTag}${confidence}] ${r.content.slice(0, 250)}`;
    });

    return `SCOPED FOREST KNOWLEDGE (${scope}):\n${lines.join("\n")}`;
  } catch (err) {
    const { log } = await import("./logger.ts");
    log.child("context-sources").warn("getScopedForestContext failed (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return "";
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd /home/ellie/ellie-dev && bun test tests/scoped-context.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/context-sources.ts tests/scoped-context.test.ts
git commit -m "[ELLIE-1428] feat: add scope-aware Forest context retrieval

Phase 3 Task 3: getScopedForestContext() resolves agent → scope and
queries Forest readMemoriesByPath() for knowledge in that subtree."
```

---

### Task 4: Wire Scoped Context Into Chat Pipeline

Modify `_gatherContextSources()` in `ellie-chat-pipeline.ts` to call `getScopedForestContext()` alongside the existing sources. Also pass `scope_path` to `searchElastic()` so ES results are scope-filtered.

**Files:**
- Modify: `ellie-dev/src/ellie-chat-pipeline.ts:17-24` (imports)
- Modify: `ellie-dev/src/ellie-chat-pipeline.ts:84-96` (Promise.all)
- Modify: `ellie-dev/src/ellie-chat-pipeline.ts:97-103` (merge)
- Modify: `ellie-dev/src/ellie-chat-handler.ts` (direct chat path)

- [ ] **Step 1: Add import to pipeline**

In `ellie-dev/src/ellie-chat-pipeline.ts`, add the import:

```typescript
import {
  getAgentStructuredContext,
  getAgentMemoryContext,
  getMaxMemoriesForModel,
  getLiveForestContext,
  getRelatedKnowledge,
  getScopedForestContext,   // NEW: Phase 3
  resolveAgentScope,        // NEW: Phase 3
} from "./context-sources.ts";
```

- [ ] **Step 2: Add scoped sources to Promise.all**

In the `_gatherContextSources()` function, add `getScopedForestContext` as a 12th parallel source and pass scope to `searchElastic()`:

Replace the existing `searchElastic` call (line 88) with:

```typescript
searchElastic(effectiveText, {
  limit: 5,
  recencyBoost: true,
  channel: "ellie-chat",
  sourceAgent: activeAgent,
  excludeConversationId: convoId,
  scope_path: resolveAgentScope(activeAgent),  // NEW: scope-filtered ES
}),
```

Add a 12th entry at the end of the Promise.all array:

```typescript
getScopedForestContext(effectiveText, activeAgent, { limit: 8, workItemId: workItemId }),  // ELLIE-1428 Phase 3
```

Update the destructuring to include `scopedForest`:

```typescript
const [convoContext, contextDocket, relevantContext, elasticContext, _structuredBase, forestContext, agentMemory, queueContext, liveForest, factsContext, relatedKnowledge, scopedForest] = await Promise.all([
```

- [ ] **Step 3: Merge scoped Forest context into final output**

After the existing merge block (lines 97-103), merge scoped Forest context:

```typescript
// ELLIE-1428 Phase 3: Merge scoped Forest knowledge
const withScopedForest = scopedForest
  ? [finalStructuredContext, scopedForest].filter(Boolean).join("\n\n")
  : finalStructuredContext;
```

Update the return/usage to use `withScopedForest` instead of `finalStructuredContext`.

- [ ] **Step 4: Add scoped logging to context build breakdown**

Add a new entry to the `contextSections` array:

```typescript
{ label: "scoped-forest", present: !!scopedForest, chars: (scopedForest as string)?.length || 0 },
```

- [ ] **Step 5: Wire into direct chat handler**

In `ellie-dev/src/ellie-chat-handler.ts`, find where `searchElastic()` is called in the direct chat path (outside the pipeline). Add `scope_path` to that call:

```typescript
const esResults = await searchElastic(effectiveText, {
  limit: 5,
  recencyBoost: true,
  scope_path: resolveAgentScope(activeAgent),  // NEW
});
```

Also add a `getScopedForestContext()` call alongside the existing Forest context in the direct chat path.

- [ ] **Step 6: Run all tests**

Run: `cd /home/ellie/ellie-dev && bun test`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/ellie-chat-pipeline.ts src/ellie-chat-handler.ts
git commit -m "[ELLIE-1428] feat: wire scope-aware retrieval into chat pipeline

Phase 3 Task 4: _gatherContextSources() now resolves agent scope,
passes it to searchElastic() for filtered results, and fetches scoped
Forest knowledge as a 12th parallel context source."
```

---

### Task 5: Oak Convergence Index

Transform Oak (R/1) from a QMD file listing into a real knowledge convergence point. The Oak should index the top knowledge from every domain — a summary of what Ellie knows, organized by scope.

**Files:**
- Modify: `ellie-dev/src/api/bridge-river.ts:283-322`
- Create: `ellie-dev/tests/oak-convergence.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// ellie-dev/tests/oak-convergence.test.ts
import { describe, test, expect } from "bun:test";
import { buildOakSummary } from "../src/api/bridge-river";

describe("buildOakSummary", () => {
  test("formats scope summaries into Oak index content", () => {
    const scopeData = [
      { scope_path: "2/1", name: "ellie-dev", count: 120, topFacts: ["Relay runs on port 3001", "Uses Bun runtime"] },
      { scope_path: "2/2", name: "ellie-forest", count: 45, topFacts: ["PostgreSQL-backed library", "Tree lifecycle with state machine"] },
      { scope_path: "E/1", name: "Voice & Personality", count: 30, topFacts: ["Warm, supportive tone", "Audio-first design"] },
    ];

    const result = buildOakSummary(scopeData);

    expect(result).toContain("Oak Knowledge Index");
    expect(result).toContain("ellie-dev");
    expect(result).toContain("120 memories");
    expect(result).toContain("Relay runs on port 3001");
    expect(result).toContain("Voice & Personality");
  });

  test("handles empty scope data", () => {
    const result = buildOakSummary([]);
    expect(result).toContain("Oak Knowledge Index");
    expect(result).toContain("0 domains");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ellie/ellie-dev && bun test tests/oak-convergence.test.ts`
Expected: FAIL — `buildOakSummary` is not exported.

- [ ] **Step 3: Implement buildOakSummary**

Add to `ellie-dev/src/api/bridge-river.ts`:

```typescript
interface OakScopeEntry {
  scope_path: string;
  name: string;
  count: number;
  topFacts: string[];
}

/**
 * Build the Oak convergence index content.
 * Summarizes what Ellie knows, organized by domain scope.
 */
export function buildOakSummary(scopeData: OakScopeEntry[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const totalMemories = scopeData.reduce((sum, s) => sum + s.count, 0);

  const lines = [
    `Oak Knowledge Index — ${scopeData.length} domains, ${totalMemories} total memories (${date})`,
    "",
  ];

  for (const scope of scopeData) {
    lines.push(`## ${scope.name} (${scope.scope_path}) — ${scope.count} memories`);
    for (const fact of scope.topFacts.slice(0, 5)) {
      lines.push(`  - ${fact}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ellie/ellie-dev && bun test tests/oak-convergence.test.ts`
Expected: PASS

- [ ] **Step 5: Implement syncOakConvergence**

Replace the existing `syncOakCatalog()` in `ellie-dev/src/api/bridge-river.ts` with an enhanced version that builds the convergence index alongside the file catalog:

```typescript
/**
 * ELLIE-1428 Phase 3: Oak Convergence — R/1 becomes the master knowledge index.
 * Queries top memories from each active scope, builds a structured summary,
 * and writes it to R/1 alongside the QMD catalog.
 */
export async function syncOakCatalog(): Promise<void> {
  const forestSql = (await import("../../../ellie-forest/src/db.ts")).default;

  // Step 1: QMD catalog (existing behavior)
  const { stdout, ok } = await qmdRun(["ls", RIVER_COLLECTION]);
  const qmdEntries: string[] = [];
  if (ok) {
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && trimmed.includes("qmd://")) qmdEntries.push(trimmed);
    }
  }

  // Step 2: Scope convergence — top memories per active scope
  const scopeStats = await forestSql`
    SELECT
      ks.scope_path,
      ks.name,
      COUNT(sm.id)::int as memory_count
    FROM knowledge_scopes ks
    LEFT JOIN shared_memories sm
      ON sm.scope_path = ks.scope_path
      AND sm.status = 'active'
    WHERE ks.scope_path NOT LIKE '3/%'  -- exclude agent-private scopes
    GROUP BY ks.scope_path, ks.name
    HAVING COUNT(sm.id) > 0
    ORDER BY COUNT(sm.id) DESC
    LIMIT 30
  `;

  const scopeData: OakScopeEntry[] = [];
  for (const stat of scopeStats) {
    // Fetch top 5 highest-weight memories for this scope
    const topMemories = await forestSql`
      SELECT content
      FROM shared_memories
      WHERE scope_path = ${stat.scope_path}
        AND status = 'active'
      ORDER BY weight DESC NULLS LAST, importance_score DESC NULLS LAST, created_at DESC
      LIMIT 5
    `;

    scopeData.push({
      scope_path: stat.scope_path,
      name: stat.name,
      count: stat.memory_count,
      topFacts: topMemories.map((m: any) => m.content.slice(0, 150)),
    });
  }

  // Step 3: Build combined Oak content
  const convergenceIndex = buildOakSummary(scopeData);
  const qmdSection = qmdEntries.length > 0
    ? `\n## River Documents (${qmdEntries.length})\n${qmdEntries.join("\n")}`
    : "";

  const content = convergenceIndex + qmdSection;

  // Step 4: Write to R/1
  const { writeMemory } = await import("../../../ellie-forest/src/index.ts");
  await writeMemory({
    content,
    type: "fact",
    scope: "tree",
    scope_path: "R/1",
    confidence: 1.0,
    tags: ["oak-index", "convergence", "manifest"],
    metadata: {
      domain_count: scopeData.length,
      total_memories: scopeData.reduce((s, d) => s + d.count, 0),
      qmd_count: qmdEntries.length,
      synced_at: new Date().toISOString(),
      source: "oak-convergence",
    },
    duration: "long_term",
    category: "work",
  });

  // ES indexing happens automatically via writeMemory's internal wiring

  logger.info("Oak convergence sync complete", {
    domains: scopeData.length,
    qmdDocs: qmdEntries.length,
  });
}
```

- [ ] **Step 6: Run all tests**

Run: `cd /home/ellie/ellie-dev && bun test`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/api/bridge-river.ts tests/oak-convergence.test.ts
git commit -m "[ELLIE-1428] feat: Oak convergence — R/1 becomes master knowledge index

Phase 3 Task 5: syncOakCatalog() now builds a domain convergence index
alongside the QMD catalog. R/1 summarizes what Ellie knows across all
scopes, not just River documents."
```

---

### Task 6: Grove-Based Knowledge Sharing

Add `getGroveSharedKnowledge()` to `ellie-forest/src/groves.ts` — given a person or agent, find the groves they belong to, find other trees in those groves, and return knowledge from those shared trees. This enables cross-person knowledge sharing without global access.

**Files:**
- Modify: `ellie-forest/src/groves.ts`
- Modify: `ellie-forest/src/index.ts` (export)
- Create: `ellie-forest/tests/grove-knowledge.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// ellie-forest/tests/grove-knowledge.test.ts
import { describe, test, expect } from "bun:test";
import { buildGroveKnowledgeQuery } from "../src/groves";

describe("buildGroveKnowledgeQuery", () => {
  test("builds scope paths from grove tree IDs", () => {
    const groveTreeIds = ["tree-1", "tree-2", "tree-3"];
    const result = buildGroveKnowledgeQuery(groveTreeIds);
    expect(result.treeIds).toEqual(["tree-1", "tree-2", "tree-3"]);
    expect(result.treeIds.length).toBe(3);
  });

  test("returns empty for no trees", () => {
    const result = buildGroveKnowledgeQuery([]);
    expect(result.treeIds).toEqual([]);
  });

  test("deduplicates tree IDs", () => {
    const result = buildGroveKnowledgeQuery(["tree-1", "tree-1", "tree-2"]);
    expect(result.treeIds).toEqual(["tree-1", "tree-2"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ellie/ellie-forest && bun test tests/grove-knowledge.test.ts`
Expected: FAIL — `buildGroveKnowledgeQuery` not exported.

- [ ] **Step 3: Implement buildGroveKnowledgeQuery**

Add to `ellie-forest/src/groves.ts`:

```typescript
/**
 * Build a query descriptor for grove-shared knowledge.
 * Given tree IDs from grove membership, returns deduplicated list
 * for scoped memory retrieval.
 */
export function buildGroveKnowledgeQuery(treeIds: string[]): { treeIds: string[] } {
  return { treeIds: [...new Set(treeIds)] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ellie/ellie-forest && bun test tests/grove-knowledge.test.ts`
Expected: PASS

- [ ] **Step 5: Implement getGroveSharedKnowledge**

Add to `ellie-forest/src/groves.ts`:

```typescript
/**
 * ELLIE-1428 Phase 3: Get knowledge shared through groves.
 *
 * Given a person ID (or agent entity ID), find their groves,
 * find other members' trees, and return memories from those trees.
 * This enables controlled cross-person knowledge sharing.
 */
export async function getGroveSharedKnowledge(opts: {
  personId?: string;
  entityId?: string;
  query: string;
  limit?: number;
}): Promise<Array<{ id: string; content: string; type: string; scope_path: string; source_tree_id: string | null }>> {
  const limit = opts.limit ?? 10;

  // Step 1: Find person's groves
  let personId = opts.personId;
  if (!personId && opts.entityId) {
    // Resolve entity → person via entities table
    const [entity] = await sql`
      SELECT person_id FROM entities WHERE id = ${opts.entityId} AND person_id IS NOT NULL
    `;
    if (entity) personId = entity.person_id;
  }

  if (!personId) return [];

  // Step 2: Find all grove members' trees (excluding the querying person)
  const sharedTrees = await sql`
    SELECT DISTINCT t.id as tree_id, t.scope_path
    FROM group_memberships gm1
    JOIN group_memberships gm2 ON gm1.group_id = gm2.group_id AND gm2.person_id != ${personId}
    JOIN people p ON p.id = gm2.person_id
    LEFT JOIN trees t ON t.entity_id = p.entity_id AND t.state != 'archived'
    WHERE gm1.person_id = ${personId}
      AND t.id IS NOT NULL
  `;

  if (sharedTrees.length === 0) return [];

  const treeIds = sharedTrees.map((t: any) => t.tree_id);

  // Step 3: Query memories from shared trees
  const { generateEmbedding } = await import("./shared-memory.ts");
  const embedding = await generateEmbedding(opts.query);

  if (embedding) {
    return sql`
      SELECT id, content, type, scope_path, source_tree_id
      FROM shared_memories
      WHERE status = 'active'
        AND source_tree_id = ANY(${treeIds})
        AND (expires_at IS NULL OR expires_at > NOW())
        AND 1 - (embedding <=> ${JSON.stringify(embedding)}::vector) >= 0.5
      ORDER BY 1 - (embedding <=> ${JSON.stringify(embedding)}::vector) DESC
      LIMIT ${limit}
    `;
  }

  // Fallback: recent memories from shared trees
  return sql`
    SELECT id, content, type, scope_path, source_tree_id
    FROM shared_memories
    WHERE status = 'active'
      AND source_tree_id = ANY(${treeIds})
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY weight DESC NULLS LAST, created_at DESC
    LIMIT ${limit}
  `;
}
```

- [ ] **Step 6: Export from index.ts**

Add to `ellie-forest/src/index.ts`:

```typescript
export { getGroveSharedKnowledge, buildGroveKnowledgeQuery } from "./groves.ts";
```

- [ ] **Step 7: Run tests**

Run: `cd /home/ellie/ellie-forest && bun test`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/groves.ts src/index.ts tests/grove-knowledge.test.ts
git commit -m "[ELLIE-1428] feat: grove-based knowledge sharing

Phase 3 Task 6: getGroveSharedKnowledge() finds memories shared through
grove membership. Given a person/entity, resolves their groves, finds
co-members' trees, and returns relevant memories from those trees."
```

---

### Task 7: Wire Grove Knowledge Into Context Builder

Add grove-shared knowledge as a context source in the chat pipeline, so agents can see knowledge from their grove co-members.

**Files:**
- Modify: `ellie-dev/src/context-sources.ts`
- Modify: `ellie-dev/src/ellie-chat-pipeline.ts`

- [ ] **Step 1: Add getGroveKnowledgeContext to context-sources.ts**

```typescript
/**
 * ELLIE-1428 Phase 3: Fetch knowledge shared through groves.
 * Resolves agent → entity → person → groves → shared tree memories.
 */
export async function getGroveKnowledgeContext(
  query: string,
  agent: string,
  opts?: { limit?: number }
): Promise<string> {
  if (!query || query.length < 10) return "";

  try {
    const forestSql = (await import("../../ellie-forest/src/db.ts")).default;
    const { getGroveSharedKnowledge } = await import("../../ellie-forest/src/index.ts");

    // Resolve agent name → entity ID
    const [entity] = await forestSql`
      SELECT id FROM entities WHERE name = ${agent} AND type = 'agent' LIMIT 1
    `;
    if (!entity) return "";

    const results = await getGroveSharedKnowledge({
      entityId: entity.id,
      query,
      limit: opts?.limit ?? 5,
    });

    if (!results || results.length === 0) return "";

    const lines = results.map((r: any) =>
      `- [${r.type}, shared] ${r.content.slice(0, 200)}`
    );

    return `GROVE SHARED KNOWLEDGE:\n${lines.join("\n")}`;
  } catch (err) {
    const { log } = await import("./logger.ts");
    log.child("context-sources").warn("getGroveKnowledgeContext failed (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return "";
  }
}
```

- [ ] **Step 2: Wire into pipeline Promise.all**

In `ellie-dev/src/ellie-chat-pipeline.ts`, add `getGroveKnowledgeContext` as a 13th parallel source:

```typescript
import {
  // ... existing imports ...
  getScopedForestContext,
  resolveAgentScope,
  getGroveKnowledgeContext,   // NEW: Phase 3 grove sharing
} from "./context-sources.ts";
```

Add to the Promise.all:

```typescript
getGroveKnowledgeContext(effectiveText, activeAgent, { limit: 5 }),  // ELLIE-1428 Phase 3
```

Update destructuring:

```typescript
const [..., scopedForest, groveKnowledge] = await Promise.all([...]);
```

Merge grove knowledge:

```typescript
// ELLIE-1428 Phase 3: Merge grove shared knowledge
const withGroveKnowledge = groveKnowledge
  ? [withScopedForest, groveKnowledge].filter(Boolean).join("\n\n")
  : withScopedForest;
```

Add to context build logging:

```typescript
{ label: "grove-knowledge", present: !!groveKnowledge, chars: (groveKnowledge as string)?.length || 0 },
```

- [ ] **Step 3: Run all tests**

Run: `cd /home/ellie/ellie-dev && bun test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/context-sources.ts src/ellie-chat-pipeline.ts
git commit -m "[ELLIE-1428] feat: wire grove knowledge into chat pipeline

Phase 3 Task 7: Grove-shared knowledge now surfaces as a 13th context
source. Agents see relevant knowledge from their grove co-members' trees."
```

---

### Task 8: Coordinator Scope Resolution

The coordinator's bridge read is hardcoded to `scope_path: "2"` — searching the entire Projects tree regardless of topic. Wire topic-based scope resolution so the coordinator searches the relevant subtree.

**Files:**
- Modify: `ellie-dev/src/coordinator-context.ts` or the coordinator's bridge read call site

- [ ] **Step 1: Find the coordinator's bridge read call**

Search for where the coordinator calls `/api/bridge/read` with hardcoded scope `"2"`. This is in the CLAUDE.md pre-work briefing or in the coordinator dispatch logic.

Run: `grep -rn 'scope_path.*"2"' src/coordinator*.ts src/dispatch*.ts`

- [ ] **Step 2: Add topic-based scope resolution**

Import `resolveAgentScope` and use it to determine the scope from the dispatched agent or work item context:

```typescript
import { resolveAgentScope } from "./context-sources.ts";

// When building coordinator context for a dispatch
const scopePath = agentName ? resolveAgentScope(agentName) : "2";
```

Or if the scope resolution should be content-based, use the scope router:

```typescript
import { routeToScope } from "../../ellie-forest/src/index.ts";

const scopePath = await routeToScope({ content: query }) || "2";
```

- [ ] **Step 3: Test by dispatching and checking context logs**

Run: `journalctl --user -u ellie-chat-relay --since "5 min ago" | grep "context-build"`

Verify that coordinator context now shows scope-specific results instead of all-Projects.

- [ ] **Step 4: Commit**

```bash
git add src/coordinator-context.ts
git commit -m "[ELLIE-1428] feat: coordinator scope resolution for bridge reads

Phase 3 Task 8: Coordinator bridge reads now resolve scope from the
dispatched agent or topic, instead of hardcoding to scope '2'."
```

---

### Task 9: Integration Test — End-to-End Scope-Aware Retrieval

Verify the complete pipeline: a memory written at scope `2/1` should appear in dev agent's context but not in a health-related conversation. Verify Oak convergence includes the memory. Verify grove sharing works.

**Files:**
- No new files — manual integration testing

- [ ] **Step 1: Write a test memory to scope 2/1**

```bash
curl -s -X POST http://localhost:3001/api/bridge/write \
  -H "Content-Type: application/json" \
  -H "x-bridge-key: bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a" \
  -d '{
    "content": "PHASE3_TEST: The relay now supports scope-aware context retrieval as of April 2026.",
    "type": "fact",
    "scope_path": "2/1",
    "confidence": 0.9
  }'
```

Expected: 200 OK with memory ID.

- [ ] **Step 2: Verify ES indexing includes scope_path**

```bash
curl -s "http://localhost:9200/ellie-memory/_search" \
  -H "Content-Type: application/json" \
  -d '{"query": {"match": {"content": "PHASE3_TEST"}}, "size": 1}' | jq '.hits.hits[0]._source.scope_path'
```

Expected: `"2/1"`

- [ ] **Step 3: Verify scoped search finds it for dev agent**

```bash
curl -s -X POST http://localhost:3001/api/bridge/read \
  -H "Content-Type: application/json" \
  -H "x-bridge-key: bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a" \
  -d '{"query": "scope-aware context retrieval", "scope_path": "2/1"}'
```

Expected: Returns the test memory.

- [ ] **Step 4: Verify it does NOT appear in Y/ scope search**

```bash
curl -s -X POST http://localhost:3001/api/bridge/read \
  -H "Content-Type: application/json" \
  -H "x-bridge-key: bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a" \
  -d '{"query": "scope-aware context retrieval", "scope_path": "Y/6"}'
```

Expected: Does NOT return the test memory (different scope subtree).

- [ ] **Step 5: Trigger Oak sync and verify convergence**

```bash
curl -s -X POST http://localhost:3001/api/admin/trigger-task \
  -H "Content-Type: application/json" \
  -d '{"task": "oak-catalog-sync"}'
```

Then check R/1 has domain summaries:

```bash
curl -s -X POST http://localhost:3001/api/bridge/read \
  -H "Content-Type: application/json" \
  -H "x-bridge-key: bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a" \
  -d '{"query": "Oak Knowledge Index", "scope_path": "R/1"}'
```

Expected: Returns an Oak index entry with domain summaries.

- [ ] **Step 6: Restart relay and verify context pipeline logs**

```bash
systemctl --user restart ellie-chat-relay
# Send a test message, then check logs
journalctl --user -u ellie-chat-relay --since "2 min ago" | grep "context-build"
```

Expected: Logs show `scoped-forest: present=true` and `grove-knowledge: present=true/false` in the context build breakdown.

- [ ] **Step 7: Clean up test memory**

Delete the `PHASE3_TEST` memory from Forest.

- [ ] **Step 8: Final commit — integration verified**

```bash
git commit --allow-empty -m "[ELLIE-1428] chore: Phase 3 integration verified

Scope-aware retrieval, Oak convergence, and grove sharing all working.
Context pipeline now uses 13 sources including scoped Forest search."
```

---

## Summary of What Phase 3 Delivers

| Gap (from audit) | Fix | How |
|---|---|---|
| **Gap 8: Consumer paths don't leverage Forest structure** | Scoped Forest context in pipeline | `getScopedForestContext()` queries by agent scope, not just keywords |
| **Gap 8: searchElastic has no scope awareness** | Scope-filtered ES search | `scope_path` field added to ES index, `searchElastic()` accepts prefix filter |
| **Gap 6: Oak isn't the convergence point** | Oak convergence index | `syncOakCatalog()` now builds domain summaries from all scopes |
| **Gap 5: Groves don't share knowledge** | Grove knowledge sharing | `getGroveSharedKnowledge()` + pipeline wiring |
| **Coordinator hardcoded to scope "2"** | Topic-based scope resolution | Coordinator resolves scope from agent/topic |
