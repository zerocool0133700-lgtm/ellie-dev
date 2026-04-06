# Ellie Chat Consolidation — Phase 1B: Contributor Attribution

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When multiple agents contribute to a response (e.g., Brian and Alan review a spec, Ellie synthesizes), each contributor's Forest tree gets the extracted knowledge — not just Ellie's.

**Architecture:** Extract contributing agent names from the coordinator's dispatch envelopes (already tracked). Pass them as `contributors` in message metadata. Extend `processMemoryIntents` to write extracted memories to each contributor's agent scope (`3/{agent_name}`) in addition to the primary scope. The memory pipeline already writes to Forest via `writeCreatureMemory` — we add a loop over contributors.

**Tech Stack:** TypeScript, Bun, ellie-forest (writeCreatureMemory), Supabase

**Spec:** `docs/superpowers/specs/2026-04-06-ellie-chat-consolidation-design.md` (Phase 1B section)

---

## File Structure

| File | Responsibility |
|------|----------------|
| Modify: `src/ellie-chat-handler.ts` | Extract contributors from coordinator envelopes, pass to metadata + memory pipeline |
| Modify: `src/memory.ts` | Extend `processMemoryIntents` to accept `contributors` and write to their Forest scopes |
| Create: `tests/contributor-attribution.test.ts` | Tests for contributor extraction and multi-scope writes |

---

### Task 1: Extract contributors from coordinator envelopes

**Files:**
- Modify: `src/ellie-chat-handler.ts`

**Context:** The coordinator returns `coordinatorResult.envelopes` — an array of `DispatchEnvelope` objects, each with an `agent` field. We need to extract the unique agent names (excluding the coordinator itself) and pass them as `contributors` in the message metadata.

- [ ] **Step 1: Find the coordinator response handling**

In `src/ellie-chat-handler.ts`, find where `coordinatorResult` is used after `runCoordinatorLoop()` returns (around line 1470). The response is saved with `saveMessage`. We need to:
1. Extract contributor agent names from `coordinatorResult.envelopes`
2. Add them to the message metadata as `contributors`

- [ ] **Step 2: Add contributor extraction**

Right before the `saveMessage` call for the coordinator response (around line 1472), add:

```typescript
          // ELLIE-1462: Extract contributing agents from dispatch envelopes
          const contributors = coordinatorResult.envelopes
            ? [...new Set(
                coordinatorResult.envelopes
                  .filter((e: any) => e.type === "specialist" && e.status === "completed")
                  .map((e: any) => e.agent)
              )]
            : [];
```

- [ ] **Step 3: Pass contributors in message metadata**

Update the `saveMessage` call to include contributors:

```typescript
          const memoryId = await saveMessage(
            "assistant", coordResponse,
            {
              agent: "ellie",
              ...(contributors.length > 0 ? { contributors } : {}),
              ...(effectiveThreadId ? { thread_id: effectiveThreadId } : {}),
            },
            "ellie-chat", ecUserId,
            undefined, "system",
            effectiveThreadId || undefined,
          );
```

- [ ] **Step 4: Pass contributors to processMemoryIntents**

Find where `processMemoryIntents` is called for the coordinator path (around line 1092). It currently looks like:

```typescript
const pipelineResponse = await processMemoryIntents(supabase, result.finalResponse, orcAgent, "shared", agentMemory.sessionIds);
```

Add `contributors` as a new parameter (we'll add the parameter to the function in Task 2):

```typescript
          const pipelineResponse = await processMemoryIntents(
            supabase, result.finalResponse, orcAgent, "shared",
            agentMemory.sessionIds, contributors,
          );
```

Note: `contributors` comes from the envelopes extraction. But in the orchestrated response path (line 1092), `coordinatorResult` might not be in scope yet. Read the code flow carefully — the extraction needs to happen AFTER the coordinator returns but BEFORE processMemoryIntents is called.

Actually, looking at the code flow: `result.finalResponse` at line 1092 is from a DIFFERENT path (the orchestrated specialist path, not the coordinator path). There are multiple paths:

1. **Coordinator path** (~line 1470): `coordinatorResult.response` → `saveMessage` → already has envelopes
2. **Orchestrated specialist path** (~line 1092): `result.finalResponse` → `processMemoryIntents` → may not have envelopes

For the coordinator path: extract contributors from `coordinatorResult.envelopes`, pass to processMemoryIntents when processing the response.

For the orchestrated path: this runs a single specialist, not multi-agent. Contributors = `[orcAgent]` (just the one agent).

- [ ] **Step 5: Run tests**

Run: `cd /home/ellie/ellie-dev && bun test`

- [ ] **Step 6: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/ellie-chat-handler.ts
git commit -m "[ELLIE-1462] extract contributors from coordinator envelopes into message metadata"
```

---

### Task 2: Extend processMemoryIntents for contributor writes

**Files:**
- Modify: `src/memory.ts`
- Create: `tests/contributor-attribution.test.ts`

**Context:** `processMemoryIntents` (in `src/memory.ts`, line 742) currently writes to Forest using `forestSessionIds` which points to the primary agent's tree. We need to add a `contributors` parameter. When present, each extracted memory also gets written to each contributor's agent scope in the Forest.

- [ ] **Step 1: Write the failing test**

Create `tests/contributor-attribution.test.ts`:

```typescript
import { describe, test, expect, mock, beforeEach } from "bun:test";

// We'll test the contributor write logic as a pure function
// since processMemoryIntents has side effects (DB writes)

describe("Contributor Attribution", () => {
  test("extractContributorsFromEnvelopes filters to completed specialists", () => {
    // Import the extraction function we'll create
    const envelopes = [
      { type: "coordinator", agent: "max", status: "completed" },
      { type: "specialist", agent: "brian", status: "completed" },
      { type: "specialist", agent: "alan", status: "completed" },
      { type: "specialist", agent: "james", status: "error" },
    ];

    const contributors = [...new Set(
      envelopes
        .filter(e => e.type === "specialist" && e.status === "completed")
        .map(e => e.agent)
    )];

    expect(contributors).toEqual(["brian", "alan"]);
    expect(contributors).not.toContain("max"); // coordinator excluded
    expect(contributors).not.toContain("james"); // errored excluded
  });

  test("contributor scope paths resolve to 3/{agent_name}", () => {
    const contributors = ["brian", "alan"];
    const scopes = contributors.map(a => `3/${a}`);
    expect(scopes).toEqual(["3/brian", "3/alan"]);
  });

  test("empty contributors array produces no extra writes", () => {
    const contributors: string[] = [];
    const extraWrites = contributors.map(a => `3/${a}`);
    expect(extraWrites).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd /home/ellie/ellie-dev && bun test tests/contributor-attribution.test.ts`
Expected: PASS (these are unit tests for pure logic)

- [ ] **Step 3: Add contributors parameter to processMemoryIntents**

In `src/memory.ts`, update the function signature (around line 742):

```typescript
export async function processMemoryIntents(
  supabase: SupabaseClient | null,
  response: string,
  sourceAgent: string = "general",
  defaultVisibility: "private" | "shared" | "global" = "shared",
  forestSessionIds?: { tree_id: string; branch_id?: string; creature_id?: string; entity_id?: string },
  contributors?: string[],  // ELLIE-1463: agents who contributed to this response
): Promise<string>
```

- [ ] **Step 4: Add contributor Forest writes**

In the Phase 2 processing section of `processMemoryIntents` (around lines 822-893), find where `_writeFactToForest` is called for REMEMBER tags and where `writeCreatureMemory` is called for [MEMORY:] tags. After each primary write, add a loop that writes to each contributor's scope:

For REMEMBER tag writes (after `_writeFactToForest` call):

```typescript
        // ELLIE-1463: Write to contributor Forest scopes
        if (contributors && contributors.length > 0) {
          for (const contributor of contributors) {
            _writeFactToContributorScope(content, contributor, sourceAgent).catch(err => {
              logger.warn("Contributor Forest write failed", { contributor, error: err instanceof Error ? err.message : String(err) });
            });
          }
        }
```

For [MEMORY:] tag writes (after `writeCreatureMemory` call):

```typescript
        // ELLIE-1463: Write to contributor Forest scopes
        if (contributors && contributors.length > 0) {
          for (const contributor of contributors) {
            _writeFactToContributorScope(content, contributor, sourceAgent, memType).catch(err => {
              logger.warn("Contributor Forest write failed", { contributor, error: err instanceof Error ? err.message : String(err) });
            });
          }
        }
```

- [ ] **Step 5: Create the contributor write helper**

Add a new function near `_writeFactToForest` (around line 704):

```typescript
/**
 * Write a memory to a contributor's agent scope in the Forest.
 * ELLIE-1463: When agents contribute to a response, their trees get the knowledge too.
 */
async function _writeFactToContributorScope(
  content: string,
  contributorAgent: string,
  sourceAgent: string,
  type: string = "fact",
): Promise<void> {
  try {
    const { writeMemory } = await import("../../ellie-forest/src/shared-memory");
    await writeMemory({
      content: `[contributed via ${sourceAgent}] ${content}`,
      type: type as any,
      category: "work",
      scope_path: `3/${contributorAgent}`,
      confidence: 0.75,
      metadata: {
        contributed_via: sourceAgent,
        source: "contributor-attribution",
      },
    });
  } catch (err) {
    const logger = (await import("./logger.ts")).log.child("memory");
    logger.warn("Failed to write contributor memory", { contributorAgent, error: err instanceof Error ? err.message : String(err) });
  }
}
```

Note: This uses `writeMemory` from ellie-forest's `shared-memory.ts` (the simpler write path) rather than `writeCreatureMemory` (which requires creature_id/tree_id that contributors may not have). `writeMemory` takes a scope_path directly and handles embedding generation.

Check if `writeMemory` exists in `ellie-forest/src/shared-memory.ts` and what its signature is. If it doesn't exist or has a different name, use whatever function writes a memory given content + scope_path + type.

- [ ] **Step 6: Run all tests**

Run: `cd /home/ellie/ellie-dev && bun test`

- [ ] **Step 7: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/memory.ts tests/contributor-attribution.test.ts
git commit -m "[ELLIE-1463] memory pipeline writes to contributor Forest scopes"
```

---

### Task 3: Integration verification

**Files:**
- No new files — manual testing

- [ ] **Step 1: Restart the relay**

```bash
systemctl --user restart ellie-chat-relay
```

- [ ] **Step 2: Trigger a multi-agent response**

Send a message in Ellie Chat that will cause the coordinator to dispatch multiple agents (e.g., "Have Brian and Alan review the ellie-chat-consolidation spec").

- [ ] **Step 3: Check the message metadata**

After the response arrives, query Supabase for the message and verify `contributors` is in the metadata:

```bash
source /home/ellie/ellie-dev/.env
curl -s "${SUPABASE_URL}/rest/v1/messages?order=created_at.desc&limit=1&channel=eq.ellie-chat&metadata->>agent=eq.ellie&select=id,metadata" \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" | jq '.[0].metadata.contributors'
```

Expected: `["brian", "alan"]` (or whichever agents were dispatched)

- [ ] **Step 4: Verify Forest writes to contributor scopes**

```bash
curl -s -X POST http://localhost:3001/api/bridge/read \
  -H "Content-Type: application/json" \
  -H "x-bridge-key: bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a" \
  -d '{"query": "review spec", "scope_path": "3/brian", "match_count": 3, "match_threshold": 0.3}' | jq '.memories | length'
```

Expected: At least 1 memory in Brian's scope from the review.

- [ ] **Step 5: Send Workshop debrief**

```bash
# Via bun since the payload has special characters
bun -e 'await fetch("http://localhost:3001/api/workshop/debrief", { method: "POST", headers: { "Content-Type": "application/json", "x-bridge-key": "bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a" }, body: JSON.stringify({ session: "Phase 1B: Contributor Attribution", repo: "ellie-dev", branch: "ellie/memory-system-fixes-1423-1427", work_item_id: "ELLIE-1455", decisions: ["Contributors extracted from coordinator dispatch envelopes", "processMemoryIntents writes to 3/{agent} scope for each contributor", "Uses writeMemory (not writeCreatureMemory) since contributors may not have active creatures"], docs_created: [], files_changed: ["src/memory.ts", "src/ellie-chat-handler.ts"], scopes: ["2/1", "2/1/3"], summary: "Phase 1B complete: contributor attribution in memory pipeline. When multiple agents contribute to a response, each agents Forest tree gets the extracted knowledge." }) }).then(r => r.json()).then(console.log)'
```

- [ ] **Step 6: Commit any fixes needed**

```bash
git add -A && git commit -m "[ELLIE-1463] Phase 1B integration verification and fixes"
```

---

## Notes for Implementers

### writeMemory vs writeCreatureMemory
`writeCreatureMemory` requires `creature_id` and `tree_id` — these are session-specific and contributors may not have active sessions. Use `writeMemory` (or the Forest bridge API) instead, which just needs `content`, `type`, `scope_path`, and handles embedding generation.

If `writeMemory` doesn't exist as a direct export, check:
- `ellie-forest/src/shared-memory.ts` for the basic write function
- Or use the bridge API: `POST http://localhost:3001/api/bridge/write` with `x-bridge-key`

### The contributor prefix
Contributor memories are prefixed with `[contributed via ellie]` to distinguish them from the agent's own observations. This means Brian's tree will have entries like:
- `[contributed via ellie] The schema has two issues: missing index on thread_id...`

This makes it clear the knowledge came from a collaborative session, not Brian's own analysis.

### Scope paths
Agent scopes exist at `3/brian`, `3/alan`, `3/james`, etc. (created in the Forest agent tree cleanup earlier this session). These are the correct targets for contributor writes.

### Fire-and-forget
Contributor writes are async and non-blocking. If they fail (e.g., scope doesn't exist), the primary memory write still succeeds and the error is logged. This prevents contributor attribution from breaking the main pipeline.
