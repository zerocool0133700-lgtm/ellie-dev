# Forest Architecture Audit — The Ecosystem vs The Code

> **Date:** April 5, 2026
> **Purpose:** Map every Forest terrain feature to its schema, code, and runtime reality. Identify gaps between Dave's architectural vision and what the code actually does.
> **Next step:** Design the integration layer fix based on this audit.

---

## The Vision

The Forest is an ecosystem, not a database. Each terrain feature has a purpose:

| Terrain | Purpose | Metaphor |
|---------|---------|----------|
| **Trees** | Living entities — people, agents, projects. Knowledge is born and lives here. | A tree grows, has branches (workstreams), trunks (main threads), and creatures living in it. |
| **Creatures** | Active processes that move through the Forest. They carry knowledge between trees, do work, report back. | Archetypes (ant, owl, squirrel, bee) define behavior. |
| **Groves** | Security rings. A person's tree sits in their grove. Shared trees sit on the edge of two groves, roots in both. | Access control without duplication. |
| **Vines** | Branch-to-branch shortcuts. Lateral connections that bypass the trunk hierarchy. | Cross-references, semantic links. |
| **Roots** | Foundation knowledge. Pre-loaded truths, domain baselines. Doesn't change often. | Everything grows from roots. |
| **River** | Flows from Mountain to Oak. Moves knowledge from active use to permanent archive. | Obsidian vault, QMD documents, long-term storage. |
| **Mountain** | Ingestion engine (future). External knowledge: textbooks, guides, domain models. Fixed once ingested. | Reference material, not living knowledge. |
| **Oak (Knowledge Tree)** | The central entity at the base of the River where ALL domains converge. | R/1 — the single index of all knowledge. |
| **Knowledge Scopes** | Hierarchical land system. 118 scopes across 7 top-level lands. | Navigational structure for the Forest. |
| **Memory Arcs** | Evolution tracking. How knowledge changes over time. | Growth patterns, direction (growing/declining/stable). |
| **Semantic Edges** | The knowledge graph. Computed similarity between memories. | Hidden connections between facts. |

---

## The Reality

### Status Summary

| Feature | Schema | TypeScript API | Runtime Wiring | Verdict |
|---------|--------|---------------|----------------|---------|
| **Trees** | Full | Complete | Heavy use (work sessions, incidents) | **WORKING** |
| **Creatures** | Full | Complete | Heavy use (agent dispatch) | **WORKING — but findings don't auto-persist** |
| **Shared Memories** | Full (70 cols) | Complete | Heavy use (Bridge API, search) | **WORKING — but scope assignment is broken** |
| **Groves** | Full | Complete | Access control only (scope 3/*) | **PARTIAL — no shared knowledge pattern** |
| **Vines** | Full (tree_links) | Complete | **Zero calls in ellie-dev** | **DEAD CODE** |
| **Knowledge Scopes** | 118 rows | Complete | Read-only, inference-based | **INFERENTIAL — not managed** |
| **Memory Arcs** | Full | Complete | Session spawn only | **UNDERUTILIZED** |
| **Semantic Edges** | Full | Complete | Write-side only (auto-computed) | **NEVER QUERIED** |
| **Roots (Hollow)** | Full | Complete | Credential storage | **WORKING** |
| **River** | External (Obsidian) | Complete | Read-only via QMD | **WORKING** |
| **Mountain** | Not built | N/A | N/A | **FUTURE** |
| **Oak (R/1)** | Exists as scope | Catalog sync | Daily catalog refresh | **EXISTS — not the convergence point it should be** |

---

## Detailed Gaps

### Gap 1: Knowledge doesn't find its Tree

**What should happen:** A fact about Dave lands in Dave's tree. A finding about ellie-dev lands in the ellie-dev tree. Knowledge is attributed to the entity and tree that spawned it.

**What actually happens:** 30 different write paths call `writeMemory()`. Most pass `scope_path: "2"` (Projects root) or no scope at all. `inferScopePath()` only knows 4 keywords (relay → 2/1, forest → 2/2, dashboard → 2/3, mobile → 2/4). The other 114 scopes are invisible to the classifier.

**Result:** 2,952 of 3,638 memories (81%) sit at scope `2`. The tree structure is bypassed.

**Source fields that COULD help but are underused:**
- `source_tree_id` — populated by work sessions and bridge writes, but graduation/sync paths don't set it
- `source_entity_id` — populated when an agent writes, but not used for scope resolution
- `scope` + `scope_id` — designed for tree/branch scoping, rarely used (most writes use `scope_path` instead)

### Gap 2: Creatures don't close the loop

**What should happen:** A creature is dispatched, does work, and its findings automatically flow back into the tree as knowledge.

**What actually happens:** Creature lifecycle works (dispatch → working → completed/failed). But `completeCreature(id, result)` only stores the result in the creature record. No automatic write to `shared_memories`. The caller must explicitly call `writeCreatureMemory()` — and most don't.

**Result:** Creature findings are trapped in `creatures.result` (JSONB). They don't become searchable knowledge.

### Gap 3: Vines are dead code

**What should happen:** Trees connect to each other via typed relationships (depends_on, spawned_from, contradicts, refines). These enable lateral traversal — "show me everything related to this tree's problem."

**What actually happens:** `vines.ts` has a complete API (createLink, getRelatedContext, getDependencies). Zero functions are imported or called by ellie-dev.

**Result:** Trees are isolated islands. No relationship graph.

### Gap 4: Semantic edges are write-only

**What should happen:** Every memory has computed similarity edges to related memories. When retrieving knowledge, these edges help surface connected facts.

**What actually happens:** `computeEdgesForMemory()` runs asynchronously after every `writeMemory()` call. Edges are created. But no read path queries them. `getRelatedMemories()` exists but is never called by the context builder.

**Result:** A knowledge graph exists in the database but is never traversed.

### Gap 5: Groves don't share knowledge

**What should happen:** A tree sits on the edge of two groves. Both grove members can see knowledge from that tree. This enables controlled knowledge sharing between people.

**What actually happens:** Grove membership is checked for access control on scope 3/* reads. But there's no concept of "shared tree" or "knowledge visible to multiple groves through a shared tree."

**Result:** Knowledge is per-person or global. No middle ground.

### Gap 6: The Oak isn't the convergence point

**What should happen:** R/1 (Oak Catalog) is the knowledge tree at the base of the River where ALL domains converge. It should be the master index.

**What actually happens:** R/1 holds a daily-refreshed catalog of River (Obsidian) documents. It doesn't index Forest memories, creature findings, or any other knowledge source. It's a file listing, not a convergence point.

**Result:** There is no single place where "everything Ellie knows" is indexed.

### Gap 7: Scope inference is too primitive

**What should happen:** `inferScopePath()` should be able to route knowledge to any of the 118 scopes based on content analysis.

**What actually happens:** `SCOPE_SIGNALS` only contains patterns for 4 scopes (2/1 through 2/4). The other 114 scopes (E/*, Y/*, J/*, 1/*, 3/*, R/*) have no signals. The function requires 2+ keyword matches and a clear winner, so ambiguous content gets `null` (defaults to caller's choice, usually `2`).

**Result:** The beautiful scope tree is structurally correct but functionally empty except where manually populated.

### Gap 8: Consumer paths don't leverage the Forest structure

**What should happen:** When Ellie builds context for a conversation about "Dave's health," she should pull from Y/6 (Health & Wellbeing), E/4/1/3 (Ellie's knowledge of Dave's health), and semantically related edges.

**What actually happens:** `searchElastic()` does keyword matching across `ellie-messages`, `ellie-memory`, `ellie-conversations`. No scope awareness. No edge traversal. No tree context. The Forest's structure is invisible to the context builder.

**The bridge read** (used by the coordinator) does filter by scope_path, but it's hardcoded to `"2"` — searching the entire Projects tree, not the relevant subtree.

---

## The 30 Ingest Paths

| # | Trigger | Function | Target | Scope Assignment | ES Index |
|---|---------|----------|--------|-----------------|----------|
| 1 | Bridge API write | `writeMemory()` | Forest | Caller-specified | Yes |
| 2 | Memory API write | `writeMemory()` | Forest | Caller or inferred | Yes |
| 3 | Working memory snapshot | `snapshotWorkingMemoryToForest()` | Forest | `2/1` hardcoded | Yes |
| 4 | Session compaction | `writeMemory()` | Forest | `2/1` hardcoded | Yes |
| 5 | Compaction rollback | `writeMemory()` | Forest | `2/1` hardcoded | Yes |
| 6 | Data quality conflicts | `writeMemory()` | Forest | `2/1` hardcoded | Yes |
| 7 | Gateway intake (webhooks) | `writeMemory()` | Forest | `2/1` or `2` | Yes |
| 8 | Agent queue | `writeMemory()` | Forest | `2/1` or `2` | Yes |
| 9 | Job intelligence | `writeMemory()` | Forest | `J/4/4` (patterns) | Yes |
| 10 | Jobs ledger touchpoints | `writeMemory()` | Forest | Entity scope | Yes |
| 11 | Memory graduation | `writeMemory()` | Forest | `2` hardcoded | Yes |
| 12 | Correction detector | `writeMemory()` | Forest | Result scope | Yes |
| 13 | Voice pipeline | `writeMemory()` | Forest | `global` | Yes |
| 14 | Conv. facts sync | `writeMemory()` | Forest | Category-mapped | Yes |
| 15 | Memory harvest (dashboard) | `writeMemory()` | Forest | Candidate scope | Yes |
| 16 | Prompt builder signals | `writeMemory()` | Forest | `global` | Yes |
| 17 | UMS fact sync | `writeMemory()` | Forest | `2/1` hardcoded | Yes |
| 18 | River bridge links | `writeMemory()` | Forest | `tree` scope | Yes |
| 19 | WM promote endpoint | `writeMemory()` | Forest | Caller-specified | Yes |
| 20 | [REMEMBER:] tags → Supabase | `insertMemoryWithDedup()` | Supabase | N/A | On graduation |
| 21 | [GOAL:] tags → Supabase | `insertMemoryWithDedup()` | Supabase | N/A | On graduation |
| 22 | Consolidate inline | `insertMemoryWithDedup()` | Supabase | N/A | On graduation |
| 23 | Pending queue flush | `insertMemoryWithDedup()` | Supabase | N/A | On graduation |
| 24 | Response tag processor | `storeFact()` → insert | Supabase CF | N/A | On sync |
| 25 | Creature memory (intent) | `writeCreatureMemory()` | Forest CM | Creature tree | Yes |
| 26 | Creature memory (API) | `writeCreatureMemory()` | Forest CM | Creature tree | Yes |
| 27 | [MEMORY:] tags | `writeCreatureMemory()` | Forest CM | `2/1/2` hardcoded | Yes |
| 28 | Message indexing | `indexMessage()` | ES only | N/A | Immediate |
| 29 | Conversation indexing | `indexConversation()` | ES only | N/A | Immediate |
| 30 | Memory indexing | `indexMemory()` | ES only | N/A | Immediate |

**Key finding:** Of the 19 Forest write paths, **11 hardcode scope to `2`, `2/1`, or `global`**. Only 4 use caller-specified scopes. Only 1 uses content inference. Zero use tree-based scope resolution at write time.

---

## The 20+ Consumer Paths

| # | Consumer | Function | Source | Scope Filter | Search Type |
|---|----------|----------|--------|-------------|-------------|
| 1 | Chat pipeline | `searchElastic()` | ES (3 indices) | channel, agent | Keyword + recency |
| 2 | Chat pipeline | `getForestContext()` | ES (forest indices) | Forest-term gate | Keyword |
| 3 | Chat pipeline | `getRelevantContext()` | Supabase Edge Fn | channel, 14-day | Semantic |
| 4 | Chat pipeline | `getRelevantFacts()` | Supabase Edge Fn | type filter | Semantic |
| 5 | Chat pipeline | `getAgentMemoryContext()` | Forest (multi-table) | tree, entity | Mixed |
| 6 | Chat pipeline | `getAgentStructuredContext()` | Forest + Supabase | Agent profile | Mixed |
| 7 | Chat pipeline | `getLiveForestContext()` | Forest (creatures, incidents) | State filter | SQL |
| 8 | Direct chat | `searchElastic()` | ES (3 indices) | channel | Keyword + recency |
| 9 | Coordinator | Bridge read (`/api/bridge/read`) | Forest | `scope_path: "2"` | Semantic |
| 10 | Dashboard browse | `browse()` | Forest | scope_path prefix | SQL |
| 11 | Dashboard search | `search()` | Forest | scope_path | Semantic |
| 12 | Dashboard related | `getRelatedMemories()` | Forest | Same scope | Semantic |
| 13 | Dashboard scope tree | `getFullHierarchy()` | Forest scopes | N/A | SQL |
| 14 | Dashboard stats | `getScopeStats()` | Forest | scope_path prefix | SQL |
| 15 | Dashboard timeline | `getTimeline()` | Forest | scope_path, days | SQL |
| 16 | Bridge read API | `readMemories()` | Forest | scope_path, allowed | Semantic |
| 17 | Bridge list API | SQL query | Forest | scope_path | SQL |
| 18 | Memory facts list | `listFacts()` | Forest | type=fact | SQL |
| 19 | Agent context | `getAgentContext()` | Forest | tree_id | Tree-scoped |
| 20 | Telegram | Same as chat pipeline | Same | Same | Same |

**Key finding:** Of the 20 consumer paths, **zero use the tree hierarchy for scoped retrieval**. The dashboard browses by scope_path prefix. The context builder searches by keyword. The bridge reads by flat scope. Nobody walks the tree.

---

## What's Actually Broken (Ranked by Impact)

### Critical — Blocks the product

1. **Knowledge doesn't route to the right scope** — 81% of memories at scope `2`. The dashboard tree is mostly empty below the top level. Consumers can't find knowledge by structure.

2. **Context builder ignores Forest structure** — Pure keyword search. Doesn't know about scopes, trees, or edges. A question about "Dave's health" searches the same way as "relay architecture."

3. **Creature findings don't persist** — Agent work results are trapped in creature.result JSONB. Never become searchable knowledge. The Forest doesn't learn from its creatures.

### High — Degrades trust

4. **Semantic edges never queried** — Knowledge graph exists but is invisible. Related facts aren't surfaced together.

5. **Vines are dead** — Tree relationships not tracked. Can't answer "what's connected to this?"

6. **Oak isn't the convergence point** — No master index. Knowledge is scattered across scopes with no unified view.

### Medium — Limits capability

7. **Groves don't share knowledge** — No multi-person knowledge sharing through shared trees.

8. **Memory arcs underutilized** — Evolution tracking exists but doesn't inform retrieval.

9. **Scope inference too primitive** — 4 of 118 scopes have classifiers.

---

## What's Working Well

- **Tree lifecycle** — State machine, work sessions, incidents all solid
- **Creature dispatch** — Full lifecycle tracking, preemption, hierarchy
- **Contradiction detection** — End-to-end with LLM entailment
- **River integration** — Obsidian vault searchable via QMD
- **Hollow (secrets)** — Encrypted credential management
- **Hybrid search** — pgvector + BM25 + RRF in readMemories()
- **ES indexing** — Fire-and-forget, resilient
- **Bridge API** — Clean interface with key-based access control

---

## Next Step

This audit becomes the input for designing the **Forest Integration Layer** — the code that sits between knowledge entering the system and knowledge finding its place in the ecosystem. The design should address:

1. **Smart routing** — Knowledge enters and finds its tree, scope, and connections automatically
2. **Creature feedback loop** — Findings auto-persist as searchable knowledge
3. **Scope-aware retrieval** — Context builder walks the tree, not just keyword search
4. **Edge traversal** — Related knowledge surfaces through the graph
5. **Oak convergence** — A unified index that everything flows through
