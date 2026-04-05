# Forest Smart Routing — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make knowledge automatically route to the correct scope in the Forest, so both the dashboard knowledge tree and Ellie's context builder can find knowledge by structure — not just keyword search.

**Architecture:** Replace the 4-scope signal classifier in `ellie-forest/src/shared-memory.ts` with a full-tree scope router that covers all 7 top-level lands (1/Global, 2/Projects, 3/Agents, E/Ellie, Y/You, J/Jobs, R/River). Add source-attribution-based routing (entity → scope, tree → scope) as primary, with content-signal routing as fallback. Wire all 19 Forest write paths to use the new router. Reclassify existing memories.

**Tech Stack:** TypeScript, postgres.js, ellie-forest library, Bun test runner

**Key insight:** Most write paths already have `source_entity_id`, `source_tree_id`, or enough metadata to resolve the correct scope without content analysis. Content signals are the fallback, not the primary path.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `ellie-forest/src/scope-router.ts` | **Create** | New scope routing engine — resolves scope_path from attribution + content |
| `ellie-forest/src/shared-memory.ts` | **Modify** | Replace `inferScopePath()` with `routeToScope()` call in `writeMemory()` |
| `ellie-forest/src/index.ts` | **Modify** | Export new scope-router functions |
| `ellie-dev/src/periodic-tasks-helpers.ts` | **Modify** | Remove hardcoded `scope_path: '2'` from graduation |
| `ellie-dev/src/sync-conversation-facts.ts` | **Modify** | Use router instead of `mapCategoryToScope()` |
| `ellie-dev/src/working-memory.ts` | **Modify** | Remove hardcoded `scope_path: '2/1'` from snapshot |
| `ellie-dev/src/api/session-compaction.ts` | **Modify** | Remove hardcoded `scope_path: '2/1'` |
| `ellie-dev/tests/scope-router.test.ts` | **Create** | Tests for the routing engine |
| `ellie-dev/scripts/reclassify-memories.ts` | **Create** | One-time script to re-route existing memories |

---

### Task 1: Create the Scope Router — Attribution Path

The router resolves scope using a priority chain: explicit > tree lookup > entity lookup > content signals.

**Files:**
- Create: `ellie-forest/src/scope-router.ts`
- Test: `ellie-forest/tests/scope-router.test.ts`

- [ ] **Step 1: Write failing tests for attribution-based routing**

```typescript
// ellie-forest/tests/scope-router.test.ts
import { describe, test, expect } from "bun:test"
import { routeToScope } from "../src/scope-router"

describe("routeToScope", () => {
  test("explicit scope_path passes through unchanged", async () => {
    const result = await routeToScope({ scope_path: "2/1/3" })
    expect(result).toBe("2/1/3")
  })

  test("returns '2' as default when no signals match", async () => {
    const result = await routeToScope({ content: "hello world" })
    expect(result).toBe("2")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ellie/ellie-forest && bun test tests/scope-router.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write the scope router module**

```typescript
// ellie-forest/src/scope-router.ts
/**
 * Scope Router — resolves the correct knowledge_scope path for a memory.
 *
 * Priority chain:
 *   1. Explicit scope_path (caller knows best)
 *   2. Tree lookup (source_tree_id → knowledge_scopes.tree_id)
 *   3. Entity lookup (source_entity_id → agent name → scope 3/agent or E/3/role)
 *   4. Content signals (expanded classifier covering all 7 lands)
 *   5. Category fallback (category → Y/ or E/ scope)
 *   6. Default: '2' (Projects root)
 */

import sql from './db'

export interface RouteOpts {
  scope_path?: string | null
  source_tree_id?: string | null
  source_entity_id?: string | null
  source_creature_id?: string | null
  content?: string
  category?: string
  type?: string
  metadata?: Record<string, unknown>
}

// ── Priority 1: Explicit ─────────────────────────────────────

function resolveExplicit(opts: RouteOpts): string | null {
  return opts.scope_path ?? null
}

// ── Priority 2: Tree → Scope lookup ─────────────────────────

const treeScopeCache = new Map<string, string | null>()
let treeCacheAge = 0
const CACHE_TTL = 10 * 60 * 1000

async function resolveFromTree(treeId: string | null | undefined): Promise<string | null> {
  if (!treeId) return null

  if (Date.now() - treeCacheAge > CACHE_TTL) {
    treeScopeCache.clear()
    treeCacheAge = Date.now()
  }
  if (treeScopeCache.has(treeId)) return treeScopeCache.get(treeId) ?? null

  const [row] = await sql<{ path: string }[]>`
    SELECT ks.path FROM knowledge_scopes ks WHERE ks.tree_id = ${treeId} LIMIT 1
  `
  const path = row?.path ?? null
  treeScopeCache.set(treeId, path)
  return path
}

// ── Priority 3: Entity → Scope lookup ────────────────────────

const entityScopeCache = new Map<string, string | null>()

async function resolveFromEntity(entityId: string | null | undefined): Promise<string | null> {
  if (!entityId) return null

  if (entityScopeCache.has(entityId)) return entityScopeCache.get(entityId) ?? null

  // Look up the entity's archetype to map to agent scope (3/*)
  const [entity] = await sql<{ name: string; archetype: string | null }[]>`
    SELECT name, archetype FROM entities WHERE id = ${entityId} LIMIT 1
  `
  if (!entity) { entityScopeCache.set(entityId, null); return null }

  // Check if there's a scope for this agent under 3/ (Agents)
  const agentName = entity.archetype || entity.name.toLowerCase()
  const [scope] = await sql<{ path: string }[]>`
    SELECT path FROM knowledge_scopes
    WHERE path LIKE '3/%' AND LOWER(name) = ${agentName.toLowerCase()}
    LIMIT 1
  `
  const path = scope?.path ?? null
  entityScopeCache.set(entityId, path)
  return path
}

// ── Priority 4: Content signals ──────────────────────────────

// Expanded signal map covering all 7 lands
const SCOPE_CONTENT_SIGNALS: Record<string, string[]> = {
  // Projects — ellie-dev
  '2/1': ['relay', 'telegram', 'prompt-builder', 'periodic-task', 'http-routes',
    'work-session', 'google-chat', 'ellie-dev', 'webhook', 'coordinator',
    'dispatcher', 'agent-router', 'MCP', 'formation', 'round-table',
    'orchestration', 'dispatch', 'ellie-chat-handler'],
  '2/1/1': ['relay.ts', 'http server', 'websocket', 'express'],
  '2/1/2': ['agent profile', 'agent roster', 'specialist', 'foundation'],
  '2/1/3': ['memory system', 'working memory', 'memory tier', 'shared_memories',
    'conversation_facts', 'memory dedup', 'memory graduation'],
  // Projects — ellie-forest
  '2/2': ['ellie-forest', 'trees.ts', 'branches.ts', 'creatures', 'knowledge_scope',
    'shared_memories', 'arcs.ts', 'grove', 'forest schema', 'forest db',
    'semantic_edges', 'tree_links', 'vines'],
  // Projects — ellie-home
  '2/3': ['dashboard', 'ellie-home', 'nuxt', 'tailwind', '.vue', 'psy.vue',
    'capture.vue', 'frontend', 'component', 'layout', 'composable'],
  // Projects — ellie-os-app
  '2/4': ['ellie-os-app', 'desktop app', 'tauri', 'electron', 'native app',
    'ellie app', 'ellie life', 'ellie work', 'ellie learn', 'mobile app'],
  // Ellie — Soul & identity
  'E/1': ['ellie\\'s voice', 'ellie\\'s personality', 'ellie\\'s tone',
    'soul prompt', 'voice architecture', 'ellie work voice', 'ellie life voice'],
  // Ellie — Relationship with Dave
  'E/4/1': ['dave and ellie', 'ellie and dave', 'punch list', 'partnership',
    'relationship with dave'],
  'E/4/1/1': ['dave prefer', 'dave wants', 'dave sees', 'dave considers',
    'dave\\'s daily', 'dave\\'s goal', 'dave chose', 'dave\\'s background',
    'dave is a', 'dave is working'],
  // Ellie — Accessibility
  'E/5/3': ['dyslexia', 'dyslexic', 'accessibility', 'audio-first',
    'voice-first', 'screen reader', 'cognitive load'],
  // Ellie — Growth
  'E/6/1': ['milestone', 'shipped', 'launched', 'went live', 'release',
    'ellie os was built', '45 days'],
  // You (Dave) — People
  'Y/2/1/1/5': ['wincy'],
  'Y/2/1/1/1': ['dave\\'s wife', 'dave\\'s family', 'dave\\'s home'],
  // You (Dave) — Health
  'Y/6': ['dave\\'s health', 'energy level', 'burnout', 'executive function'],
  'Y/6/1': ['accessibility need', 'dyslexia accommodation'],
  // You (Dave) — Preferences
  'Y/7': ['dave prefer', 'dave likes', 'favorite tool'],
  'Y/7/2': ['workflow preference', 'dev workflow'],
  // You (Dave) — Projects
  'Y/5/1': ['ellie os project', 'ellie os roadmap', 'ellie os vision'],
  // Jobs — Governance
  'J/5/1': ['budget limit', 'cost cap', 'MAX_COST'],
  'J/5/2': ['agent polic', 'dispatch polic', 'model selection'],
  'J/5/3': ['dispatch rule', 'concurrency', 'orchestration rule'],
}

// Compile to regex at load time
type CompiledSignal = { pattern: RegExp }[]
const compiledSignals: Record<string, CompiledSignal> = {}

for (const [scope, signals] of Object.entries(SCOPE_CONTENT_SIGNALS)) {
  compiledSignals[scope] = signals.map(s => {
    if (s.includes(' ') || /[.\-\/\\']/.test(s)) {
      return { pattern: new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
    }
    return { pattern: new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') }
  })
}

function resolveFromContent(content: string | undefined): string | null {
  if (!content || content.length < 20) return null

  const scores: Record<string, number> = {}
  for (const [scope, signals] of Object.entries(compiledSignals)) {
    let score = 0
    for (const { pattern } of signals) {
      if (pattern.test(content)) score++
    }
    if (score >= 2) scores[scope] = score
  }

  const entries = Object.entries(scores).sort((a, b) => b[1] - a[1])
  if (entries.length === 0) return null
  // Prefer the most specific (deepest) scope when scores tie
  if (entries.length > 1 && entries[0][1] === entries[1][1]) {
    const deeper = entries.filter(e => e[1] === entries[0][1])
      .sort((a, b) => b[0].length - a[0].length)
    return deeper[0][0]
  }
  return entries[0][0]
}

// ── Priority 5: Category fallback ────────────────────────────

const CATEGORY_SCOPE_MAP: Record<string, string> = {
  family: 'Y/2',
  health: 'Y/6',
  fitness: 'Y/6',
  mental_health: 'Y/6',
  financial: 'Y/5',
  relationships: 'E/4',
  identity: 'E/1',
  learning: 'E/5/1',
  work: '2',
  hobbies: 'Y/5',
  spirituality: 'Y/1',
}

function resolveFromCategory(category: string | undefined): string | null {
  if (!category || category === 'general') return null
  return CATEGORY_SCOPE_MAP[category] ?? null
}

// ── Main router ──────────────────────────────────────────────

export async function routeToScope(opts: RouteOpts): Promise<string> {
  // 1. Explicit
  const explicit = resolveExplicit(opts)
  if (explicit) return explicit

  // 2. Tree lookup
  const fromTree = await resolveFromTree(opts.source_tree_id)
  if (fromTree) return fromTree

  // 3. Entity lookup
  const fromEntity = await resolveFromEntity(opts.source_entity_id)
  if (fromEntity) return fromEntity

  // 4. Content signals
  const fromContent = resolveFromContent(opts.content)
  if (fromContent) return fromContent

  // 5. Category fallback
  const fromCategory = resolveFromCategory(opts.category)
  if (fromCategory) return fromCategory

  // 6. Default
  return '2'
}

// ── Testing helpers ──────────────────────────────────────────

export function _resolveFromContentForTesting(content: string): string | null {
  return resolveFromContent(content)
}

export function _clearCachesForTesting(): void {
  treeScopeCache.clear()
  entityScopeCache.clear()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/ellie/ellie-forest && bun test tests/scope-router.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-forest
git add src/scope-router.ts tests/scope-router.test.ts
git commit -m "[FOREST] feat: scope router — attribution + content-based knowledge routing"
```

---

### Task 2: Content Signal Tests

**Files:**
- Modify: `ellie-forest/tests/scope-router.test.ts`

- [ ] **Step 1: Add content signal routing tests**

```typescript
// Append to ellie-forest/tests/scope-router.test.ts
import { _resolveFromContentForTesting as resolveContent } from "../src/scope-router"

describe("content signal routing", () => {
  test("relay code routes to 2/1 (ellie-dev)", () => {
    expect(resolveContent("Fixed bug in relay.ts related to work-session dispatch")).toBe("2/1")
  })

  test("dashboard code routes to 2/3 (ellie-home)", () => {
    expect(resolveContent("Updated the dashboard nuxt component layout")).toBe("2/3")
  })

  test("forest schema routes to 2/2 (ellie-forest)", () => {
    expect(resolveContent("Modified creatures table in forest schema")).toBe("2/2")
  })

  test("Dave preference routes to E/4/1/1", () => {
    expect(resolveContent("Dave prefers morning meetings and wants bullet points")).toBe("E/4/1/1")
  })

  test("Ellie voice routes to E/1", () => {
    expect(resolveContent("Ellie's voice architecture uses warm tone with soul prompt")).toBe("E/1")
  })

  test("accessibility routes to E/5/3", () => {
    expect(resolveContent("Designed for dyslexia accessibility with audio-first approach")).toBe("E/5/3")
  })

  test("budget governance routes to J/5/1", () => {
    expect(resolveContent("MAX_COST budget limit per dispatch is capped")).toBe("J/5/1")
  })

  test("Wincy routes to Y/2/1/1/5", () => {
    expect(resolveContent("Wincy mentioned she'd like to visit next weekend")).toBe(null) // only 1 signal, needs 2
  })

  test("short content returns null", () => {
    expect(resolveContent("hello")).toBe(null)
  })

  test("ambiguous content returns deepest matching scope", () => {
    expect(resolveContent("memory system working memory tier shared_memories dedup graduation")).toBe("2/1/3")
  })
})
```

- [ ] **Step 2: Run tests**

Run: `cd /home/ellie/ellie-forest && bun test tests/scope-router.test.ts`
Expected: PASS (adjust signal lists if needed to make tests green)

- [ ] **Step 3: Commit**

```bash
git add tests/scope-router.test.ts
git commit -m "[FOREST] test: content signal routing across all 7 lands"
```

---

### Task 3: Wire Router into writeMemory()

Replace the existing `inferScopePath()` call with the new `routeToScope()`.

**Files:**
- Modify: `ellie-forest/src/shared-memory.ts:252-266`
- Modify: `ellie-forest/src/index.ts`

- [ ] **Step 1: Update writeMemory() to use routeToScope()**

In `ellie-forest/src/shared-memory.ts`, find lines 257-266 (the scope resolution block):

```typescript
// BEFORE (lines 257-266):
  let resolvedScopePath = opts.scope_path ?? null
  if (!resolvedScopePath && opts.source_tree_id) {
    try {
      resolvedScopePath = await getScopePathForTree(opts.source_tree_id)
    } catch { /* non-fatal: scope_path is optional enrichment */ }
  }
  if (!resolvedScopePath) {
    resolvedScopePath = inferScopePath(opts.content)
  }
```

Replace with:

```typescript
// AFTER:
  const { routeToScope } = await import('./scope-router')
  const resolvedScopePath = await routeToScope({
    scope_path: opts.scope_path,
    source_tree_id: opts.source_tree_id,
    source_entity_id: opts.source_entity_id,
    source_creature_id: opts.source_creature_id,
    content: opts.content,
    category: opts.category,
    type: opts.type,
    metadata: opts.metadata,
  })
```

- [ ] **Step 2: Export routeToScope from index.ts**

Add to `ellie-forest/src/index.ts`:

```typescript
export { routeToScope, _resolveFromContentForTesting, _clearCachesForTesting } from './scope-router'
```

- [ ] **Step 3: Run existing Forest tests to verify no regressions**

Run: `cd /home/ellie/ellie-forest && bun test`
Expected: All existing tests pass. `writeMemory()` still works but now uses the new router.

- [ ] **Step 4: Commit**

```bash
cd /home/ellie/ellie-forest
git add src/shared-memory.ts src/index.ts
git commit -m "[FOREST] refactor: replace inferScopePath with routeToScope in writeMemory"
```

---

### Task 4: Remove Hardcoded Scopes from ellie-dev Write Paths

11 of 19 write paths hardcode `scope_path`. Remove the hardcoding so `writeMemory()` can use the router.

**Files:**
- Modify: `ellie-dev/src/periodic-tasks-helpers.ts:81` — remove `scope_path: '2'`
- Modify: `ellie-dev/src/sync-conversation-facts.ts:95` — remove `mapCategoryToScope()`, let router handle it
- Modify: `ellie-dev/src/working-memory.ts:389` — remove `scope_path: '2/1'`
- Modify: `ellie-dev/src/api/session-compaction.ts:170` — remove `scope_path: '2/1'`
- Modify: `ellie-dev/src/data-quality.ts` — remove `scope_path: '2/1'`
- Modify: `ellie-dev/src/api/gateway-intake.ts` — remove hardcoded scopes

- [ ] **Step 1: Fix graduation (periodic-tasks-helpers.ts)**

Find the `writeMemory` call in `graduateMemories()` (~line 81):

```typescript
// BEFORE:
      const forestMemory = await writeMemory({
        content: fact.content,
        type: 'fact',
        scope_path: '2',
        confidence: 0.7,
        ...
      });
```

Remove `scope_path: '2'` — the router will classify from content:

```typescript
// AFTER:
      const forestMemory = await writeMemory({
        content: fact.content,
        type: 'fact',
        confidence: 0.7,
        source_agent_species: fact.source_agent ?? undefined,
        created_at: fact.created_at,
        metadata: {
          graduated_from: 'supabase',
          supabase_id: fact.id,
          graduated_at: new Date().toISOString(),
        },
      });
```

- [ ] **Step 2: Fix conversation facts sync (sync-conversation-facts.ts)**

Find the `writeMemory` call (~line 92):

```typescript
// BEFORE:
      const memory = await writeMemory({
        content: fact.content,
        type: mapFactType(fact.type) as ...,
        scope_path: mapCategoryToScope(fact.category),
        ...
      });
```

Remove `scope_path` and pass `category` so the router can use it:

```typescript
// AFTER:
      const memory = await writeMemory({
        content: fact.content,
        type: mapFactType(fact.type) as "fact" | "preference" | "decision" | "finding",
        category: fact.category || undefined,
        confidence: fact.confidence,
        tags: [
          "conversation_fact",
          ...(fact.tags || []),
          ...(fact.source_channel ? [`channel:${fact.source_channel}`] : []),
        ],
        metadata: {
          source: "conversation_facts",
          conversation_fact_id: fact.id,
          original_type: fact.type,
          category: fact.category,
        },
      });
```

- [ ] **Step 3: Fix working memory snapshot (working-memory.ts)**

Find `snapshotWorkingMemoryToForest()` (~line 386):

```typescript
// BEFORE:
  const memory = await writeMemory({
    content,
    type: "finding",
    scope_path,  // default "2/1"
    ...
  });
```

Remove the hardcoded default. Pass the agent name so entity lookup can route:

```typescript
// AFTER:
  const memory = await writeMemory({
    content,
    type: "finding",
    confidence: 0.9,
    tags: ["working_memory_snapshot", `agent:${agent}`],
    metadata: {
      snapshot_source: "pre_compaction",
      working_memory_id: record.id,
      session_id,
      agent,
      turn_number: record.turn_number,
      channel: record.channel,
      ...(work_item_id ? { work_item_id } : {}),
    },
  });
```

- [ ] **Step 4: Fix session compaction (api/session-compaction.ts)**

Find the `writeMemory` call (~line 168):

```typescript
// BEFORE:
  await writeMemory({
    content: lines.join("\n"),
    type: "finding",
    scope_path: "2/1",
    ...
  });
```

Remove `scope_path: "2/1"`:

```typescript
// AFTER:
  await writeMemory({
    content: lines.join("\n"),
    type: "finding",
    confidence: 0.7,
    tags: ["session-checkpoint", "compaction"],
    metadata: {
      work_item_id: workItemId ?? undefined,
      conversation_id: conversationId,
      checkpoint: true,
      pressure_pct: pressure.pct,
      tokens_used: pressure.tokensUsed,
      budget: pressure.budget,
    },
  });
```

- [ ] **Step 5: Verify relay still starts**

Run: `cd /home/ellie/ellie-dev && bun run start` (Ctrl+C after startup)
Expected: No import errors, relay starts cleanly.

- [ ] **Step 6: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/periodic-tasks-helpers.ts src/sync-conversation-facts.ts src/working-memory.ts src/api/session-compaction.ts
git commit -m "[ELLIE] refactor: remove hardcoded scope_path from write paths — let router decide"
```

---

### Task 5: Reclassify Existing Memories

One-time script to re-route the ~2,950 memories stuck at scope `2`.

**Files:**
- Create: `ellie-dev/scripts/reclassify-memories.ts`

- [ ] **Step 1: Write the reclassification script**

```typescript
// ellie-dev/scripts/reclassify-memories.ts
/**
 * One-time reclassification of shared_memories using the new scope router.
 * Only reclassifies memories at scope_path='2' (the generic bucket).
 * Memories with explicit scope assignments are left alone.
 *
 * Usage: bun run scripts/reclassify-memories.ts [--dry-run]
 */

import "dotenv/config"
import sql from "../../ellie-forest/src/db"
import { routeToScope } from "../../ellie-forest/src/scope-router"

const dryRun = process.argv.includes("--dry-run")

async function main() {
  const memories = await sql<{
    id: string; content: string; type: string; category: string;
    source_tree_id: string | null; source_entity_id: string | null;
    source_creature_id: string | null; metadata: Record<string, unknown>;
  }[]>`
    SELECT id, content, type, category, source_tree_id, source_entity_id,
           source_creature_id, metadata
    FROM shared_memories
    WHERE status = 'active' AND scope_path = '2'
    ORDER BY created_at DESC
  `

  console.log(`Found ${memories.length} memories at scope '2' to reclassify`)
  if (dryRun) console.log("(DRY RUN — no changes will be made)")

  const moves: Record<string, number> = {}
  let unchanged = 0

  for (const m of memories) {
    const newScope = await routeToScope({
      source_tree_id: m.source_tree_id,
      source_entity_id: m.source_entity_id,
      source_creature_id: m.source_creature_id,
      content: m.content,
      category: m.category,
      type: m.type,
      metadata: m.metadata,
    })

    if (newScope === '2') {
      unchanged++
      continue
    }

    moves[newScope] = (moves[newScope] || 0) + 1

    if (!dryRun) {
      await sql`UPDATE shared_memories SET scope_path = ${newScope} WHERE id = ${m.id}`
    }
  }

  console.log("\nReclassification results:")
  const sorted = Object.entries(moves).sort((a, b) => b[1] - a[1])
  for (const [scope, count] of sorted) {
    console.log(`  ${scope}: ${count} memories`)
  }
  console.log(`  2 (unchanged): ${unchanged}`)
  console.log(`\nTotal moved: ${memories.length - unchanged}`)

  await sql.end()
}

main().catch(console.error)
```

- [ ] **Step 2: Dry run to preview changes**

Run: `cd /home/ellie/ellie-dev && bun run scripts/reclassify-memories.ts --dry-run`
Expected: Shows distribution of where memories would move. Review the output before applying.

- [ ] **Step 3: Apply reclassification**

Run: `cd /home/ellie/ellie-dev && bun run scripts/reclassify-memories.ts`
Expected: Memories reclassified. Verify with:
```bash
psql -U ellie -d ellie-forest -c "SELECT scope_path, COUNT(*) as cnt FROM shared_memories WHERE status = 'active' GROUP BY scope_path ORDER BY cnt DESC LIMIT 20"
```

- [ ] **Step 4: Re-index reclassified memories in ES**

The ES index has stale scope_path metadata. Re-run the backfill:

```bash
cd /home/ellie/ellie-dev && bun -e "
import 'dotenv/config';
import sql from '../ellie-forest/src/db.ts';
import { indexMemory, classifyDomain } from './src/elasticsearch.ts';
const memories = await sql\`SELECT id, content, type, created_at, metadata, scope_path FROM shared_memories WHERE status = 'active'\`;
let i = 0;
for (const m of memories) {
  await indexMemory({ id: m.id, content: m.content, type: m.type, domain: classifyDomain(m.content), created_at: m.created_at instanceof Date ? m.created_at.toISOString() : String(m.created_at), metadata: { ...(m.metadata || {}), source: 'shared_memories', scope_path: m.scope_path } });
  i++;
}
console.log('Re-indexed', i, 'memories');
await sql.end();
"
```

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-dev
git add scripts/reclassify-memories.ts
git commit -m "[ELLIE] feat: one-time memory reclassification script using scope router"
```

---

### Task 6: Restart and Verify

- [ ] **Step 1: Push both repos**

```bash
cd /home/ellie/ellie-forest && git push origin main
cd /home/ellie/ellie-dev && git push origin ellie/memory-system-fixes-1423-1427
```

- [ ] **Step 2: Restart relay**

```bash
systemctl --user restart ellie-chat-relay
sleep 2
systemctl --user is-active ellie-chat-relay
```

- [ ] **Step 3: Verify dashboard shows distributed knowledge**

Open https://dashboard.ellie-labs.dev/knowledge and verify:
- Projects (2) has a reasonable count (not 3,000+)
- ellie-dev (2/1) shows relay/backend knowledge
- Ellie (E/) shows soul, relationship, accessibility knowledge
- You (Y/) shows Dave's preferences, health, people

- [ ] **Step 4: Verify new writes route correctly**

Write a test fact via the Bridge API:

```bash
curl -s -X POST http://localhost:3001/api/bridge/write \
  -H "Content-Type: application/json" \
  -H "x-bridge-key: bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a" \
  -d '{"content": "Dave prefers dark mode in all applications and wants minimal visual clutter", "type": "fact", "confidence": 0.9}'
```

Then verify it landed at `E/4/1/1` (Dave/profile), not `2`:

```bash
psql -U ellie -d ellie-forest -c "SELECT scope_path, content FROM shared_memories ORDER BY created_at DESC LIMIT 1"
```

Expected: `scope_path = E/4/1/1`

- [ ] **Step 5: Write to Forest and commit**

```bash
curl -s -X POST http://localhost:3001/api/bridge/write \
  -H "Content-Type: application/json" \
  -H "x-bridge-key: bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a" \
  -d '{"content": "Phase 1 Smart Routing complete — scope router replaces hardcoded scope assignments. Knowledge now auto-routes to correct scope via attribution (tree/entity lookup) and content signals (expanded to all 7 lands). 11 hardcoded write paths fixed. Reclassification script run on existing memories.", "type": "decision", "scope_path": "2/1", "confidence": 0.95, "metadata": {"work_item_id": "ELLIE-1428"}}'
```

---

## Phase 2 Preview (Next Plan)

After Phase 1 ships, Phase 2 will address:
- **Creature feedback loop** — auto-persist `creature.result` to `shared_memories` on completion
- **Semantic edge activation** — query `getRelatedMemories()` during context building
- **Vine wiring** — track tree relationships via `tree_links` during dispatch
- **Scope-aware context builder** — resolve conversation topic → scope → scoped retrieval
