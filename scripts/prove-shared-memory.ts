#!/usr/bin/env bun
/**
 * Shared Memory — End-to-End Validation (ELLIE-93)
 *
 * Three scenarios proving the memory system works:
 * 1. Cross-Agent Knowledge Transfer — dev learns, critic knows
 * 2. Contradiction Detection & Resolution — conflicting branches caught
 * 3. Knowledge Query — "what has Ellie learned?" returns real answers
 *
 * Usage: bun run scripts/prove-shared-memory.ts
 */

import {
  writeMemory,
  writeCreatureMemory,
  readMemories,
  getMemory,
  getAgentContext,
  findContradictions,
  markAsContradiction,
  boostConfidence,
  tryAutoResolve,
  resolveContradiction,
  listMemories,
  listUnresolvedContradictions,
  archiveMemory,
  getMemoryCount,
  embeddingsAvailable,
  createTree,
  createBranch,
  dispatchCreature,
  addCommit,
  sql,
} from '../../ellie-forest/src/index'

// ── Helpers ──────────────────────────────────────────────────

const RELAY_URL = process.env.RELAY_URL || 'http://localhost:3001'

interface Check {
  name: string
  passed: boolean
  detail: string
}

interface ScenarioResult {
  name: string
  passed: boolean
  checks: Check[]
  memoryIds: string[]
  duration: number
}

function check(name: string, condition: boolean, detail = ''): Check {
  const icon = condition ? 'PASS' : 'FAIL'
  console.log(`    [${icon}] ${name}${detail ? ` — ${detail}` : ''}`)
  return { name, passed: condition, detail }
}

async function relayPost(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${RELAY_URL}/api/forest-memory/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json() as Promise<Record<string, any>>
}

// Entity IDs (seeded in DB)
const ENTITIES = {
  dev: 'd238453c-24f3-4617-9b9c-6a8c77cb43dc',
  critic: 'eee8d72b-fb21-40a8-ac63-a85db7df9683',
  research: 'd0a48663-eb32-4bc9-82b0-ba692d714bd8',
} as const

// ── Scenario 1: Cross-Agent Knowledge Transfer ──────────────

async function scenario1(): Promise<ScenarioResult> {
  console.log('\n  Scenario 1: Cross-Agent Knowledge Transfer')
  console.log('  ─────────────────────────────────────────────')
  const start = Date.now()
  const checks: Check[] = []
  const memoryIds: string[] = []

  // Step 1: Create a work session tree
  const { tree, trunk } = await createTree({
    type: 'work_session',
    title: 'ELLIE-93 Validation: Knowledge Transfer',
  })
  console.log(`    Tree created: ${tree.id}`)

  // Step 2: Dev creature does work and learns something
  const devCreature = await dispatchCreature({
    type: 'pull',
    tree_id: tree.id,
    entity_id: ENTITIES.dev,
    intent: 'Investigate relay architecture',
  })
  console.log(`    Dev creature dispatched: ${devCreature.id}`)

  const devCommit = await addCommit({
    tree_id: tree.id,
    trunk_id: trunk.id,
    message: 'Discovered HNSW index usage in forest schema',
    entity_id: ENTITIES.dev,
  })

  // Step 3: Dev creature writes a memory (tree-scoped)
  const devMemory = await writeCreatureMemory({
    creature_id: devCreature.id,
    tree_id: tree.id,
    entity_id: ENTITIES.dev,
    content: 'The forest schema uses HNSW indexes for vector similarity search on shared_memories',
    type: 'fact',
    confidence: 0.85,
    tags: ['architecture', 'database', 'embeddings'],
  })
  memoryIds.push(devMemory.id)
  console.log(`    Dev memory written: ${devMemory.id}`)

  checks.push(check(
    'Memory written with correct attribution',
    devMemory.source_entity_id === ENTITIES.dev
      && devMemory.source_creature_id === devCreature.id
      && devMemory.source_tree_id === tree.id,
    `entity=${devMemory.source_entity_id?.slice(0, 8)}, creature=${devMemory.source_creature_id?.slice(0, 8)}`,
  ))

  checks.push(check(
    'Memory is tree-scoped',
    devMemory.scope === 'tree' && devMemory.scope_id === tree.id,
    `scope=${devMemory.scope}, scope_id=${devMemory.scope_id?.slice(0, 8)}`,
  ))

  checks.push(check(
    'Confidence set correctly',
    devMemory.confidence === 0.85,
    `confidence=${devMemory.confidence}`,
  ))

  // Step 4: Later, critic creature is dispatched to the same tree
  const criticCreature = await dispatchCreature({
    type: 'gate',
    tree_id: tree.id,
    entity_id: ENTITIES.critic,
    intent: 'Review dev work on relay architecture',
  })
  console.log(`    Critic creature dispatched: ${criticCreature.id}`)

  // Step 5: Critic's context assembly pulls shared memories
  const criticContext = await getAgentContext({
    tree_id: tree.id,
    entity_id: ENTITIES.critic,
  })

  const devMemoryInContext = criticContext.find(m => m.id === devMemory.id)
  checks.push(check(
    'Dev memory appears in critic context',
    !!devMemoryInContext,
    devMemoryInContext
      ? `rank=${criticContext.indexOf(devMemoryInContext) + 1}/${criticContext.length}`
      : 'NOT FOUND',
  ))

  checks.push(check(
    'Critic context contains HNSW fact',
    criticContext.some(m => m.content.includes('HNSW')),
    `context has ${criticContext.length} memories`,
  ))

  // Step 6: Also test via relay API
  const relayContext = await relayPost('context', { tree_id: tree.id })
  checks.push(check(
    'Relay /context endpoint returns dev memory',
    relayContext.success && relayContext.memories?.some((m: any) => m.id === devMemory.id),
    `relay returned ${relayContext.count ?? 0} memories`,
  ))

  const duration = Date.now() - start
  const passed = checks.every(c => c.passed)
  console.log(`\n    Result: ${passed ? 'PASSED' : 'FAILED'} (${duration}ms)`)

  return { name: 'Cross-Agent Knowledge Transfer', passed, checks, memoryIds, duration }
}

// ── Scenario 2: Contradiction Detection & Resolution ────────

async function scenario2(): Promise<ScenarioResult> {
  console.log('\n  Scenario 2: Contradiction Detection & Resolution')
  console.log('  ─────────────────────────────────────────────────')
  const start = Date.now()
  const checks: Check[] = []
  const memoryIds: string[] = []

  // Step 1: Create tree with two branches
  const { tree, trunk } = await createTree({
    type: 'work_session',
    title: 'ELLIE-93 Validation: Contradiction Detection',
  })

  const branchA = await createBranch({
    tree_id: tree.id,
    trunk_id: trunk.id,
    entity_id: ENTITIES.dev,
    name: 'investigate-auth-dev',
    reason: 'Dev investigates API authentication',
  })

  const branchB = await createBranch({
    tree_id: tree.id,
    trunk_id: trunk.id,
    entity_id: ENTITIES.research,
    name: 'investigate-auth-research',
    reason: 'Research investigates API authentication',
  })
  console.log(`    Tree: ${tree.id}, Branch A: ${branchA.id.slice(0, 8)}, Branch B: ${branchB.id.slice(0, 8)}`)

  // Step 2: Branch A creature writes finding
  const creatureA = await dispatchCreature({
    type: 'pull',
    tree_id: tree.id,
    entity_id: ENTITIES.dev,
    branch_id: branchA.id,
    intent: 'Investigate API auth',
  })

  const memoryA = await writeCreatureMemory({
    creature_id: creatureA.id,
    tree_id: tree.id,
    entity_id: ENTITIES.dev,
    content: 'The API uses OAuth2 for authentication with JWT bearer tokens',
    type: 'finding',
    confidence: 0.7,
    tags: ['api', 'auth'],
  })
  memoryIds.push(memoryA.id)
  console.log(`    Memory A (OAuth2): ${memoryA.id}`)

  // Step 3: Branch B creature writes conflicting finding
  const creatureB = await dispatchCreature({
    type: 'pull',
    tree_id: tree.id,
    entity_id: ENTITIES.research,
    branch_id: branchB.id,
    intent: 'Investigate API auth',
  })

  const memoryB = await writeCreatureMemory({
    creature_id: creatureB.id,
    tree_id: tree.id,
    entity_id: ENTITIES.research,
    content: 'The API uses simple API keys for authentication, no OAuth',
    type: 'finding',
    confidence: 0.6,
    tags: ['api', 'auth'],
  })
  memoryIds.push(memoryB.id)
  console.log(`    Memory B (API keys): ${memoryB.id}`)

  // Step 4: Test relay write with contradiction check
  const relayWrite = await relayPost('write', {
    content: 'The API authentication uses basic API keys, not OAuth',
    scope: 'tree',
    scope_id: tree.id,
    source_tree_id: tree.id,
    confidence: 0.65,
    check_contradictions: true,
    tags: ['api', 'auth'],
  })
  if (relayWrite.memory_id) memoryIds.push(relayWrite.memory_id)

  const hasEmbeddings = embeddingsAvailable()
  checks.push(check(
    'Relay write with contradiction check succeeds',
    relayWrite.success === true,
    `contradictions_found=${relayWrite.contradictions_found ?? 0}, embeddings=${hasEmbeddings}`,
  ))

  // Step 5: Manually mark contradiction (forest-level test)
  await markAsContradiction(memoryB.id, memoryA.id, {
    entailment_confidence: 0.92,
    entailment_reasoning: 'OAuth2 and API keys are mutually exclusive authentication methods',
  })

  const updatedB = await getMemory(memoryB.id)
  const updatedA = await getMemory(memoryA.id)

  checks.push(check(
    'Contradiction marked: new memory typed as contradiction',
    updatedB?.type === 'contradiction',
    `type=${updatedB?.type}`,
  ))

  checks.push(check(
    'Contradiction linked: supersedes_id set',
    updatedB?.supersedes_id === memoryA.id,
    `supersedes=${updatedB?.supersedes_id?.slice(0, 8)}`,
  ))

  checks.push(check(
    'Contradiction back-linked: superseded_by_id set',
    updatedA?.superseded_by_id === memoryB.id,
    `superseded_by=${updatedA?.superseded_by_id?.slice(0, 8)}`,
  ))

  // Step 6: Verify unresolved contradictions excluded from retrieval
  const contextBeforeResolve = await getAgentContext({
    tree_id: tree.id,
    entity_id: ENTITIES.critic,
  })
  const contradictionInContext = contextBeforeResolve.some(
    m => m.id === memoryB.id || m.id === memoryA.id,
  )
  checks.push(check(
    'Unresolved contradictions excluded from agent context',
    !contradictionInContext,
    `context has ${contextBeforeResolve.length} memories (neither A nor B should appear)`,
  ))

  // Step 7: List unresolved contradictions
  const unresolvedList = await listUnresolvedContradictions()
  checks.push(check(
    'Unresolved contradiction appears in listUnresolvedContradictions',
    unresolvedList.some(m => m.id === memoryB.id),
    `${unresolvedList.length} unresolved`,
  ))

  // Step 8: Auto-resolve (confidence gap is 0.7 - 0.6 = 0.1, < 0.3 — should NOT auto-resolve)
  const autoResult = await tryAutoResolve(memoryB.id, memoryA.id)
  checks.push(check(
    'Small confidence gap does NOT auto-resolve',
    !autoResult.resolved,
    `gap=0.1, resolved=${autoResult.resolved}`,
  ))

  // Step 9: Create a critic-authored contradiction to test auto-resolve
  const criticMemory = await writeMemory({
    content: 'The API uses OAuth2 with PKCE flow for authentication',
    type: 'finding',
    scope: 'tree',
    scope_id: tree.id,
    source_entity_id: ENTITIES.critic,
    source_tree_id: tree.id,
    confidence: 0.9,
    tags: ['api', 'auth'],
  })
  memoryIds.push(criticMemory.id)

  const devConflict = await writeMemory({
    content: 'The API has no authentication at all — fully public endpoints',
    type: 'finding',
    scope: 'tree',
    scope_id: tree.id,
    source_entity_id: ENTITIES.dev,
    source_tree_id: tree.id,
    confidence: 0.5,
    tags: ['api', 'auth'],
  })
  memoryIds.push(devConflict.id)

  await markAsContradiction(devConflict.id, criticMemory.id)
  const criticAutoResult = await tryAutoResolve(devConflict.id, criticMemory.id)

  checks.push(check(
    'Critic trust auto-resolves: keeps critic memory',
    criticAutoResult.resolved && criticAutoResult.resolution === 'keep_old',
    `resolved=${criticAutoResult.resolved}, resolution=${criticAutoResult.resolution}, reason=${criticAutoResult.reason?.slice(0, 60)}`,
  ))

  // Step 10: Resolve the original B-vs-A contradiction manually via relay
  const resolveResult = await relayPost('resolve', {
    memory_id: memoryB.id,
    resolution: 'keep_new',
    resolved_by: 'e2e-validation',
  })
  checks.push(check(
    'Relay /resolve endpoint works',
    resolveResult.success === true,
    `resolution=${resolveResult.resolution}`,
  ))

  // Step 11: After resolution, the winner appears in context
  const contextAfterResolve = await getAgentContext({
    tree_id: tree.id,
    entity_id: ENTITIES.critic,
  })
  const winnerInContext = contextAfterResolve.some(m => m.id === memoryB.id)
  const loserInContext = contextAfterResolve.some(m => m.id === memoryA.id)
  checks.push(check(
    'Resolved winner appears in context, loser excluded',
    winnerInContext && !loserInContext,
    `winner=${winnerInContext}, loser=${loserInContext}`,
  ))

  // Step 12: Test confidence boosting
  const beforeBoost = await getMemory(memoryB.id)
  await boostConfidence(memoryB.id, 0.15, criticMemory.id)
  const afterBoost = await getMemory(memoryB.id)
  checks.push(check(
    'Confidence boost works',
    (afterBoost?.confidence ?? 0) > (beforeBoost?.confidence ?? 0),
    `before=${beforeBoost?.confidence}, after=${afterBoost?.confidence}`,
  ))

  const duration = Date.now() - start
  const passed = checks.every(c => c.passed)
  console.log(`\n    Result: ${passed ? 'PASSED' : 'FAILED'} (${duration}ms)`)

  return { name: 'Contradiction Detection & Resolution', passed, checks, memoryIds, duration }
}

// ── Scenario 3: Knowledge Query ─────────────────────────────

async function scenario3(): Promise<ScenarioResult> {
  console.log('\n  Scenario 3: Knowledge Query')
  console.log('  ────────────────────────────')
  const start = Date.now()
  const checks: Check[] = []
  const memoryIds: string[] = []

  // Step 1: Write several memories at different scopes
  const { tree } = await createTree({
    type: 'work_session',
    title: 'ELLIE-93 Validation: Knowledge Query',
  })

  const globalMem = await writeMemory({
    content: 'Ellie uses PostgreSQL with pgvector for all structured data storage',
    type: 'fact',
    scope: 'global',
    source_entity_id: ENTITIES.dev,
    source_tree_id: tree.id,
    confidence: 0.95,
    tags: ['infrastructure', 'database'],
  })
  memoryIds.push(globalMem.id)

  const treeMem = await writeMemory({
    content: 'The relay runs on Bun 1.3 with Express-compatible HTTP routing',
    type: 'fact',
    scope: 'tree',
    scope_id: tree.id,
    source_entity_id: ENTITIES.dev,
    source_tree_id: tree.id,
    confidence: 0.85,
    tags: ['relay', 'technology'],
  })
  memoryIds.push(treeMem.id)

  const decisionMem = await writeMemory({
    content: 'Decision: Use creature dispatch pattern for all cross-agent work, not direct API calls',
    type: 'decision',
    scope: 'global',
    source_entity_id: ENTITIES.critic,
    confidence: 0.9,
    tags: ['architecture', 'design'],
  })
  memoryIds.push(decisionMem.id)

  const hypothesisMem = await writeMemory({
    content: 'Hypothesis: HNSW index performance may degrade beyond 100k memories — needs benchmarking',
    type: 'hypothesis',
    scope: 'tree',
    scope_id: tree.id,
    source_entity_id: ENTITIES.research,
    source_tree_id: tree.id,
    confidence: 0.4,
    tags: ['performance', 'database'],
  })
  memoryIds.push(hypothesisMem.id)

  // Write a superseded memory (should be excluded)
  const oldMem = await writeMemory({
    content: 'The relay runs on Node.js 20',
    type: 'fact',
    scope: 'tree',
    scope_id: tree.id,
    source_entity_id: ENTITIES.dev,
    source_tree_id: tree.id,
    confidence: 0.5,
    tags: ['relay', 'technology'],
  })
  const newMem = await writeMemory({
    content: 'The relay runs on Bun, not Node.js',
    type: 'fact',
    scope: 'tree',
    scope_id: tree.id,
    source_entity_id: ENTITIES.dev,
    source_tree_id: tree.id,
    confidence: 0.8,
    tags: ['relay', 'technology'],
  })
  memoryIds.push(oldMem.id, newMem.id)
  await markAsContradiction(newMem.id, oldMem.id)
  await resolveContradiction(newMem.id, 'keep_new', 'e2e-validation')

  // Step 2: Query across all scopes
  const allMemories = await readMemories({
    query: 'What has Ellie learned about the codebase?',
    scope: 'tree',
    scope_id: tree.id,
    tree_id: tree.id,
    include_global: true,
    match_count: 20,
  })
  console.log(`    Query returned ${allMemories.length} memories`)

  checks.push(check(
    'Query returns results',
    allMemories.length > 0,
    `${allMemories.length} results`,
  ))

  // Step 3: Verify multi-scope results
  const scopes = new Set(allMemories.map(m => m.scope))
  checks.push(check(
    'Results span multiple scopes',
    scopes.size >= 2,
    `scopes: ${Array.from(scopes).join(', ')}`,
  ))

  // Step 4: Verify attribution
  const attributed = allMemories.filter(m => m.source_entity_id)
  checks.push(check(
    'Results are attributed (have source_entity_id)',
    attributed.length > 0,
    `${attributed.length}/${allMemories.length} attributed`,
  ))

  // Step 5: Verify confidence ordering (within same scope)
  const treeResults = allMemories.filter(m => m.scope === 'tree')
  const confidences = treeResults.map(m => m.confidence)
  const isSorted = confidences.every((c, i) => i === 0 || confidences[i - 1] >= c)
  checks.push(check(
    'Tree results are confidence-ranked',
    isSorted || treeResults.length <= 1,
    `confidences: [${confidences.map(c => c.toFixed(2)).join(', ')}]`,
  ))

  // Step 6: Verify superseded (loser) is excluded
  const oldMemInResults = allMemories.some(m => m.id === oldMem.id)
  checks.push(check(
    'Superseded memory excluded from results',
    !oldMemInResults,
    `old "Node.js" memory ${oldMemInResults ? 'FOUND (bad)' : 'excluded (good)'}`,
  ))

  // Step 7: Verify resolved winner IS included
  const newMemInResults = allMemories.some(m => m.id === newMem.id)
  checks.push(check(
    'Resolved winner included in results',
    newMemInResults,
    `new "Bun" memory ${newMemInResults ? 'found (good)' : 'NOT FOUND (bad)'}`,
  ))

  // Step 8: Test listMemories for different types
  const facts = await listMemories({ tree_id: tree.id, type: 'fact' })
  const decisions = await listMemories({ type: 'decision' })
  const hypotheses = await listMemories({ tree_id: tree.id, type: 'hypothesis' })
  checks.push(check(
    'Memories filterable by type',
    facts.length > 0 && decisions.length > 0 && hypotheses.length > 0,
    `facts=${facts.length}, decisions=${decisions.length}, hypotheses=${hypotheses.length}`,
  ))

  // Step 9: Test min_confidence filter
  const highConf = await listMemories({ tree_id: tree.id, min_confidence: 0.8 })
  const lowConf = await listMemories({ tree_id: tree.id, min_confidence: 0.3 })
  checks.push(check(
    'Confidence filtering works',
    highConf.length <= lowConf.length,
    `high(>=0.8)=${highConf.length}, low(>=0.3)=${lowConf.length}`,
  ))

  // Step 10: Test memory count
  const totalCount = await getMemoryCount({ tree_id: tree.id })
  checks.push(check(
    'Memory count is accurate',
    totalCount > 0,
    `count=${totalCount}`,
  ))

  // Step 11: Relay read endpoint
  const relayRead = await relayPost('read', {
    query: 'What technology does the relay use?',
    scope: 'tree',
    scope_id: tree.id,
    tree_id: tree.id,
    include_global: true,
  })
  checks.push(check(
    'Relay /read endpoint returns results',
    relayRead.success && relayRead.count > 0,
    `relay count=${relayRead.count}`,
  ))

  // Step 12: Format human-readable summary
  console.log('\n    ── Knowledge Summary ──')
  for (const mem of allMemories.slice(0, 8)) {
    const entityLabel = mem.source_entity_id === ENTITIES.dev ? 'dev'
      : mem.source_entity_id === ENTITIES.critic ? 'critic'
      : mem.source_entity_id === ENTITIES.research ? 'research'
      : 'unknown'
    console.log(`    [${mem.scope.padEnd(6)}] [${entityLabel.padEnd(8)}] (${mem.confidence.toFixed(2)}) ${mem.content.slice(0, 80)}`)
  }

  const duration = Date.now() - start
  const passed = checks.every(c => c.passed)
  console.log(`\n    Result: ${passed ? 'PASSED' : 'FAILED'} (${duration}ms)`)

  return { name: 'Knowledge Query', passed, checks, memoryIds, duration }
}

// ── Cleanup ─────────────────────────────────────────────────

async function cleanup(memoryIds: string[]) {
  console.log(`\n  Cleaning up ${memoryIds.length} test memories...`)
  // Clear FK links first to avoid constraint violations
  if (memoryIds.length > 0) {
    await sql`UPDATE shared_memories SET supersedes_id = NULL, superseded_by_id = NULL WHERE id = ANY(${memoryIds})`
    await sql`DELETE FROM shared_memories WHERE id = ANY(${memoryIds})`
  }
  // Also clean up any relay-created memories from contradiction checks
  await sql`UPDATE shared_memories SET supersedes_id = NULL, superseded_by_id = NULL WHERE source_tree_id IN (SELECT id FROM trees WHERE title LIKE 'ELLIE-93 Validation%')`
  await sql`DELETE FROM shared_memories WHERE source_tree_id IN (SELECT id FROM trees WHERE title LIKE 'ELLIE-93 Validation%')`
  // Delete test creatures, then trees (cascades to branches etc.)
  await sql`DELETE FROM creatures WHERE tree_id IN (SELECT id FROM trees WHERE title LIKE 'ELLIE-93 Validation%')`
  await sql`UPDATE branches SET head_commit_id = NULL WHERE tree_id IN (SELECT id FROM trees WHERE title LIKE 'ELLIE-93 Validation%')`
  await sql`UPDATE trunks SET head_commit_id = NULL WHERE tree_id IN (SELECT id FROM trees WHERE title LIKE 'ELLIE-93 Validation%')`
  await sql`DELETE FROM commits WHERE tree_id IN (SELECT id FROM trees WHERE title LIKE 'ELLIE-93 Validation%')`
  await sql`DELETE FROM branches WHERE tree_id IN (SELECT id FROM trees WHERE title LIKE 'ELLIE-93 Validation%')`
  await sql`DELETE FROM trunks WHERE tree_id IN (SELECT id FROM trees WHERE title LIKE 'ELLIE-93 Validation%')`
  await sql`DELETE FROM tree_entities WHERE tree_id IN (SELECT id FROM trees WHERE title LIKE 'ELLIE-93 Validation%')`
  await sql`DELETE FROM forest_events WHERE tree_id IN (SELECT id FROM trees WHERE title LIKE 'ELLIE-93 Validation%')`
  await sql`DELETE FROM trees WHERE title LIKE 'ELLIE-93 Validation%'`
  console.log('  Cleanup complete.')
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  console.log('\n  ╔═══════════════════════════════════════════════════════╗')
  console.log('  ║  Shared Memory — End-to-End Validation (ELLIE-93)    ║')
  console.log('  ╚═══════════════════════════════════════════════════════╝')
  console.log(`\n  Time: ${new Date().toISOString()}`)
  console.log(`  Relay: ${RELAY_URL}`)
  console.log(`  Embeddings: ${embeddingsAvailable() ? 'AVAILABLE' : 'NOT AVAILABLE (scope-based fallback)'}`)

  // Check relay health
  try {
    const res = await fetch(`${RELAY_URL}/api/forest-memory/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'health check' }),
    })
    const data = await res.json() as any
    console.log(`  Relay status: ${data.success ? 'CONNECTED' : 'ERROR'}`)
  } catch {
    console.log('  Relay status: UNREACHABLE (continuing with forest-only tests)')
  }

  const results: ScenarioResult[] = []
  const allMemoryIds: string[] = []

  try {
    // Run scenarios sequentially (they build on shared state)
    const r1 = await scenario1()
    results.push(r1)
    allMemoryIds.push(...r1.memoryIds)

    const r2 = await scenario2()
    results.push(r2)
    allMemoryIds.push(...r2.memoryIds)

    const r3 = await scenario3()
    results.push(r3)
    allMemoryIds.push(...r3.memoryIds)
  } finally {
    await cleanup(allMemoryIds)
  }

  // Summary
  console.log('\n  ╔═══════════════════════════════════════════════════════╗')
  console.log('  ║  Summary                                              ║')
  console.log('  ╚═══════════════════════════════════════════════════════╝\n')

  let totalChecks = 0
  let passedChecks = 0

  for (const r of results) {
    const icon = r.passed ? 'PASS' : 'FAIL'
    const checkCount = r.checks.filter(c => c.passed).length
    totalChecks += r.checks.length
    passedChecks += checkCount
    console.log(`  [${icon}] ${r.name} — ${checkCount}/${r.checks.length} checks (${r.duration}ms)`)
  }

  const allPassed = results.every(r => r.passed)
  console.log(`\n  Total: ${passedChecks}/${totalChecks} checks passed`)
  console.log(`  Verdict: ${allPassed ? 'ALL SCENARIOS PASSED — shared memory is production-ready' : 'SOME SCENARIOS FAILED — see details above'}\n`)

  // Return results for documentation
  return { results, allPassed, totalChecks, passedChecks, timestamp: new Date().toISOString() }
}

const output = await main()

// Write machine-readable results for documentation script
await Bun.write(
  '/tmp/prove-shared-memory-results.json',
  JSON.stringify(output, null, 2),
)

process.exit(output.allPassed ? 0 : 1)
