# Forest Feedback Loops — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the feedback loops — creature findings auto-persist to the Forest, semantic edges are queried during context building, and tree relationships (vines) are tracked during dispatch.

**Architecture:** Three independent improvements that each make the Forest smarter: (1) After `completeCreature()`, auto-extract key findings from the creature's result and write them to `shared_memories` with full attribution. (2) Add a `getRelatedKnowledge()` context source that queries semantic edges to surface connected facts. (3) When a dispatch creates a creature on a tree, auto-link that tree to the work item's tree via vines.

**Tech Stack:** TypeScript, postgres.js, ellie-forest library, Bun test runner

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `ellie-dev/src/creature-findings.ts` | **Create** | Extract and persist creature findings to shared_memories |
| `ellie-dev/src/orchestration-dispatch.ts` | **Modify** | Call creature findings extraction on completion |
| `ellie-dev/src/context-sources.ts` | **Modify** | Add `getRelatedKnowledge()` using semantic edges |
| `ellie-dev/src/ellie-chat-pipeline.ts` | **Modify** | Wire related knowledge into context assembly |
| `ellie-dev/src/ellie-chat-handler.ts` | **Modify** | Wire related knowledge into direct chat path |
| `ellie-dev/tests/creature-findings.test.ts` | **Create** | Tests for finding extraction |

---

### Task 1: Creature Findings Auto-Persist

When a creature completes, extract meaningful findings from its result and write them to `shared_memories` with full attribution (source_creature_id, source_tree_id, source_entity_id).

**Files:**
- Create: `ellie-dev/src/creature-findings.ts`
- Create: `ellie-dev/tests/creature-findings.test.ts`
- Modify: `ellie-dev/src/orchestration-dispatch.ts:522-531`

- [ ] **Step 1: Write the failing test**

```typescript
// ellie-dev/tests/creature-findings.test.ts
import { describe, test, expect } from "bun:test"
import { extractFindings } from "../src/creature-findings"

describe("extractFindings", () => {
  test("extracts response_preview as a finding", () => {
    const findings = extractFindings({
      response_preview: "The relay uses port 3001 and connects to Forest via Unix socket. The dashboard runs on port 3000.",
      duration_ms: 5000,
      work_item_id: "ELLIE-500",
    })
    expect(findings.length).toBe(1)
    expect(findings[0].content).toContain("relay uses port 3001")
    expect(findings[0].type).toBe("finding")
  })

  test("skips short previews (under 50 chars)", () => {
    const findings = extractFindings({
      response_preview: "Done.",
      duration_ms: 1000,
    })
    expect(findings.length).toBe(0)
  })

  test("skips error-like previews", () => {
    const findings = extractFindings({
      response_preview: "Something went wrong. I encountered an error while processing the request and could not complete the task.",
      duration_ms: 1000,
    })
    expect(findings.length).toBe(0)
  })

  test("extracts from decisions array if present", () => {
    const findings = extractFindings({
      response_preview: "Implemented the feature",
      duration_ms: 3000,
      decisions: ["Used PostgreSQL advisory locks instead of Redis", "Chose TDD approach for reliability"],
    })
    expect(findings.length).toBe(3) // 1 preview + 2 decisions
    expect(findings[1].type).toBe("decision")
    expect(findings[1].content).toContain("advisory locks")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ellie/ellie-dev && bun test tests/creature-findings.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write the creature findings module**

```typescript
// ellie-dev/src/creature-findings.ts
/**
 * Creature Findings — auto-extract and persist knowledge from creature results.
 *
 * When a creature completes, its result contains response_preview, decisions,
 * and other structured data. This module extracts meaningful findings and
 * writes them to Forest shared_memories with full attribution.
 */

import { log } from "./logger.ts"

const logger = log.child("creature-findings")

/** Minimum preview length to be worth persisting */
const MIN_PREVIEW_LENGTH = 50

/** Patterns that indicate the response was an error, not a finding */
const ERROR_PATTERNS = [
  /something went wrong/i,
  /error while processing/i,
  /could not complete/i,
  /failed to/i,
  /timed out/i,
  /SIGTERM/i,
]

export interface Finding {
  content: string
  type: "finding" | "decision" | "fact"
  confidence: number
}

/**
 * Extract findings from a creature's completion result.
 * Pure function — no DB access, no side effects.
 */
export function extractFindings(result: Record<string, unknown>): Finding[] {
  const findings: Finding[] = []

  // 1. Response preview → finding
  const preview = result.response_preview as string | undefined
  if (preview && preview.length >= MIN_PREVIEW_LENGTH) {
    const isError = ERROR_PATTERNS.some(p => p.test(preview))
    if (!isError) {
      findings.push({
        content: preview,
        type: "finding",
        confidence: 0.7,
      })
    }
  }

  // 2. Decisions array → decision type
  const decisions = result.decisions as string[] | undefined
  if (Array.isArray(decisions)) {
    for (const d of decisions) {
      if (d && d.length >= 20) {
        findings.push({
          content: d,
          type: "decision",
          confidence: 0.8,
        })
      }
    }
  }

  return findings
}

/**
 * Persist extracted findings to Forest shared_memories.
 * Non-fatal — logs errors but never throws.
 */
export async function persistCreatureFindings(opts: {
  creatureId: string
  treeId?: string
  entityId?: string
  result: Record<string, unknown>
  agentName?: string
  workItemId?: string
}): Promise<number> {
  const findings = extractFindings(opts.result)
  if (findings.length === 0) return 0

  try {
    const { writeMemory } = await import("../../ellie-forest/src/index.ts")

    let persisted = 0
    for (const finding of findings) {
      try {
        await writeMemory({
          content: finding.content,
          type: finding.type,
          confidence: finding.confidence,
          source_tree_id: opts.treeId ?? undefined,
          source_entity_id: opts.entityId ?? undefined,
          source_creature_id: opts.creatureId,
          source_agent_species: opts.agentName ?? undefined,
          tags: ["creature_finding", ...(opts.workItemId ? [`work:${opts.workItemId}`] : [])],
          metadata: {
            source: "creature_completion",
            creature_id: opts.creatureId,
            ...(opts.workItemId ? { work_item_id: opts.workItemId } : {}),
          },
        })
        persisted++
      } catch (err) {
        logger.warn("Failed to persist individual finding", {
          creature_id: opts.creatureId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    if (persisted > 0) {
      logger.info("Persisted creature findings", {
        creature_id: opts.creatureId,
        findings: persisted,
        agent: opts.agentName,
        work_item_id: opts.workItemId,
      })
    }

    // Index to ES
    try {
      const { indexMemory, classifyDomain } = await import("./elasticsearch.ts")
      for (const finding of findings) {
        await indexMemory({
          id: opts.creatureId + "-" + findings.indexOf(finding),
          content: finding.content,
          type: finding.type,
          domain: classifyDomain(finding.content),
          created_at: new Date().toISOString(),
          metadata: { source: "creature_finding", creature_id: opts.creatureId },
        })
      }
    } catch { /* ES indexing is non-fatal */ }

    return persisted
  } catch (err) {
    logger.warn("persistCreatureFindings failed (non-fatal)", {
      creature_id: opts.creatureId,
      error: err instanceof Error ? err.message : String(err),
    })
    return 0
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/ellie/ellie-dev && bun test tests/creature-findings.test.ts`
Expected: PASS

- [ ] **Step 5: Wire into orchestration-dispatch.ts**

In `ellie-dev/src/orchestration-dispatch.ts`, find the creature completion block (~line 522-531). After the existing `completeCreature()` call, add:

```typescript
      // ELLIE-1428 Phase 2: Auto-persist creature findings to Forest
      persistCreatureFindings({
        creatureId: sessionIds.creature_id,
        treeId: sessionIds.tree_id,
        entityId: sessionIds.entity_id,
        result: {
          response_preview: responsePreview,
          duration_ms: durationMs,
          work_item_id: workItemId,
        },
        agentName: agentType,
        workItemId,
      }).catch(err =>
        logger.warn("persistCreatureFindings failed (non-fatal)", { err: err instanceof Error ? err.message : String(err) })
      );
```

Add the import at the top of the file:

```typescript
import { persistCreatureFindings } from "./creature-findings.ts";
```

- [ ] **Step 6: Run tests**

Run: `cd /home/ellie/ellie-dev && bun test tests/creature-findings.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/creature-findings.ts tests/creature-findings.test.ts src/orchestration-dispatch.ts
git commit -m "[ELLIE] feat: auto-persist creature findings to Forest on completion"
```

---

### Task 2: Semantic Edge Context Source

Add a context source that queries semantic edges to surface knowledge connected to the current conversation topic. This uses the existing `getRelatedMemories()` function from ellie-forest that computes edges on write but has never been queried on read.

**Files:**
- Modify: `ellie-dev/src/context-sources.ts` — add `getRelatedKnowledge()`
- Modify: `ellie-dev/src/ellie-chat-pipeline.ts` — wire into `_gatherContextSources()`
- Modify: `ellie-dev/src/ellie-chat-handler.ts` — wire into direct chat path

- [ ] **Step 1: Add getRelatedKnowledge() to context-sources.ts**

Find the end of the file (before the last export or after the last function). Add:

```typescript
// ── ELLIE-1428 Phase 2: Semantic Edge Context ─────────────────

/**
 * Query semantic edges to find knowledge connected to the most relevant
 * memories for the current message. Two-hop: first find relevant memories
 * via ES, then find their semantic neighbors via edges.
 *
 * Returns formatted text for prompt injection, or empty string.
 */
export async function getRelatedKnowledge(
  query: string,
  opts?: { limit?: number }
): Promise<string> {
  if (!query || query.length < 15) return "";

  try {
    const { default: forestSql } = await import("../../ellie-forest/src/db.ts");
    const { readMemories, getRelatedMemories } = await import("../../ellie-forest/src/index.ts");

    // Step 1: Find the top 3 relevant memories via Forest semantic search
    const seeds = await readMemories({
      query,
      match_count: 3,
      match_threshold: 0.6,
    });

    if (seeds.length === 0) return "";

    // Step 2: For each seed, get its semantic neighbors
    const limit = opts?.limit ?? 5;
    const seen = new Set(seeds.map(s => s.id));
    const related: Array<{ content: string; type: string; similarity: number; scope_path: string }> = [];

    for (const seed of seeds) {
      const neighbors = await getRelatedMemories(forestSql, seed.id, {
        limit: 3,
        minSimilarity: 0.7,
      });
      for (const n of neighbors) {
        if (!seen.has(n.id) && related.length < limit) {
          seen.add(n.id);
          related.push(n);
        }
      }
    }

    if (related.length === 0) return "";

    const lines = related.map(r =>
      `- [${r.type}, ${r.scope_path || "?"}] ${r.content.slice(0, 200)}`
    );

    return `CONNECTED KNOWLEDGE (via semantic edges):\n${lines.join("\n")}`;
  } catch (err) {
    const { log } = await import("./logger.ts");
    log.child("context-sources").warn("getRelatedKnowledge failed (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return "";
  }
}
```

- [ ] **Step 2: Wire into _gatherContextSources() in ellie-chat-pipeline.ts**

Find the `Promise.all([` block in `_gatherContextSources()` (~line 83). Add `getRelatedKnowledge` to the imports and to the parallel fetch array.

Add import at top of file:

```typescript
import { getRelatedKnowledge } from "./context-sources.ts";
```

In the `Promise.all` array, after the `getRelevantFacts` line, add:

```typescript
    getRelatedKnowledge(effectiveText, { limit: 5 }),  // ELLIE-1428 Phase 2: semantic edge context
```

Update the destructuring to capture it:

```typescript
  const [convoContext, contextDocket, relevantContext, elasticContext, _structuredBase, forestContext, agentMemory, queueContext, liveForest, factsContext, relatedKnowledge] = await Promise.all([
```

After the `structuredContext` merge line, merge related knowledge:

```typescript
  // ELLIE-1428 Phase 2: Merge semantic edge context
  const finalStructuredContext = relatedKnowledge
    ? [structuredContext, relatedKnowledge].filter(Boolean).join("\n\n")
    : structuredContext;
```

Change the return to use `finalStructuredContext`:

```typescript
  return { convoContext, contextDocket, relevantContext, elasticContext, structuredContext: finalStructuredContext, forestContext, agentMemory, queueContext, liveForest };
```

Add to the `contextSections` logging array:

```typescript
    { label: "related-knowledge", present: !!relatedKnowledge, chars: (relatedKnowledge as string)?.length || 0 },
```

- [ ] **Step 3: Wire into direct chat path**

In `ellie-dev/src/ellie-chat-handler.ts`, find the direct chat `searchElastic` call (the block we added earlier for ELLIE-1428). After the ES context block, add:

```typescript
        // ELLIE-1428 Phase 2: Semantic edge context for direct chat
        let directRelatedCtx: string | undefined;
        try {
          const { getRelatedKnowledge } = await import("./context-sources.ts");
          const related = await getRelatedKnowledge(text, { limit: 3 });
          if (related) directRelatedCtx = related;
        } catch { /* non-fatal */ }
```

Then in the `buildDirectPrompt()` call, combine forestContext:

```typescript
          forestContext: [directForestCtx, directRelatedCtx].filter(Boolean).join("\n\n") || undefined,
```

- [ ] **Step 4: Verify relay starts**

Run: `cd /home/ellie/ellie-dev && bun -e "await import('./src/ellie-chat-pipeline.ts'); console.log('OK')" 2>&1 | head -3`
Expected: "OK" (no import errors)

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/context-sources.ts src/ellie-chat-pipeline.ts src/ellie-chat-handler.ts
git commit -m "[ELLIE] feat: semantic edge context — query related knowledge during context build"
```

---

### Task 3: Vine Auto-Linking on Dispatch

When a creature is dispatched on a tree, auto-link that tree to any related trees (e.g., the work item tree that spawned it). This activates the dormant `tree_links` (vines) system.

**Files:**
- Modify: `ellie-dev/src/orchestration-dispatch.ts` — add vine linking after creature dispatch

- [ ] **Step 1: Add vine linking after creature creation**

In `ellie-dev/src/orchestration-dispatch.ts`, find where the creature is created/dispatched. This is in the `executeTrackedDispatch` function where `sessionIds` are resolved (the block that creates the creature and tree).

After the creature is dispatched but before the main agent call, add:

```typescript
    // ELLIE-1428 Phase 2: Auto-link trees via vines when dispatching
    // If this dispatch has a tree and the work item has a different parent tree, link them
    if (sessionIds?.tree_id && workItemId) {
      try {
        const { createLink } = await import("../../ellie-forest/src/vines.ts");
        // Find other trees with the same work_item_id (sibling dispatches)
        const { default: forestSql } = await import("../../ellie-forest/src/db.ts");
        const siblings = await forestSql<{ id: string }[]>`
          SELECT id FROM trees
          WHERE work_item_id = ${workItemId}
            AND id != ${sessionIds.tree_id}
            AND state NOT IN ('archived', 'composted')
          LIMIT 3
        `;
        for (const sibling of siblings) {
          await createLink({
            source_tree_id: sessionIds.tree_id,
            target_tree_id: sibling.id,
            link_type: 'related',
            confidence: 0.8,
            note: `Sibling dispatches for ${workItemId}`,
            metadata: { auto_linked: true, work_item_id: workItemId },
          }).catch(() => {}); // Non-fatal, upsert handles duplicates
        }
        if (siblings.length > 0) {
          logger.info("Auto-linked trees via vines", {
            tree_id: sessionIds.tree_id,
            siblings: siblings.length,
            work_item_id: workItemId,
          });
        }
      } catch { /* vine linking is non-fatal */ }
    }
```

- [ ] **Step 2: Verify no import errors**

Run: `cd /home/ellie/ellie-dev && bun -e "await import('./src/orchestration-dispatch.ts'); console.log('OK')" 2>&1 | head -3`
Expected: "OK"

- [ ] **Step 3: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/orchestration-dispatch.ts
git commit -m "[ELLIE] feat: auto-link sibling dispatch trees via vines"
```

---

### Task 4: Push, Restart, and Verify

- [ ] **Step 1: Push both repos**

```bash
cd /home/ellie/ellie-forest && git push origin main
cd /home/ellie/ellie-dev && git push origin ellie/memory-system-fixes-1423-1427
```

- [ ] **Step 2: Restart relay**

```bash
systemctl --user restart ellie-chat-relay
sleep 3
systemctl --user is-active ellie-chat-relay
```

- [ ] **Step 3: Verify creature findings work**

Trigger a dispatch (or wait for one to complete naturally), then check:

```bash
psql -U ellie -d ellie-forest -c "
  SELECT content, type, scope_path, metadata->>'source' as source
  FROM shared_memories
  WHERE metadata->>'source' = 'creature_completion'
  ORDER BY created_at DESC LIMIT 5
"
```

Expected: Findings appear with `source = 'creature_completion'` and proper scope_path from the router.

- [ ] **Step 4: Verify semantic edges are being used**

Check relay logs for the new context source:

```bash
journalctl --user -u ellie-chat-relay --since "5 min ago" --no-pager | grep "related-knowledge"
```

- [ ] **Step 5: Write completion to Forest**

```bash
curl -s -X POST http://localhost:3001/api/bridge/write \
  -H "Content-Type: application/json" \
  -H "x-bridge-key: bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a" \
  -d '{"content": "Phase 2 Feedback Loops complete. Three improvements: (1) Creature findings auto-persist to shared_memories on completion with full attribution. (2) Semantic edges queried during context build — connected knowledge surfaces for every conversation. (3) Sibling dispatch trees auto-linked via vines. The Forest now learns from its own activity.", "type": "decision", "scope_path": "2/1", "confidence": 0.95, "metadata": {"work_item_id": "ELLIE-1428"}}'
```

---

## Phase 3 Preview (Next Plan)

After Phase 2 ships, Phase 3 will address:
- **Scope-aware context builder** — resolve conversation topic → scope → pull from that subtree
- **Oak convergence** — R/1 becomes the master index that all domains flow through
- **Grove-based knowledge sharing** — shared trees visible across groves
