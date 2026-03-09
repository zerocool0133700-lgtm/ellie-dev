#!/usr/bin/env bun
/**
 * Backfill Forest DB (trees, commits, creatures) from Elasticsearch backup.
 *
 * Source: /home/ellie/ellie-backup/daily/20260306/elasticsearch/
 * Target: ellie-forest PostgreSQL database
 *
 * Safe to re-run — uses ON CONFLICT DO NOTHING on primary keys.
 * Entity UUIDs are remapped from old ES IDs to current Forest DB IDs.
 */

import { readFileSync } from 'fs'
import sql from '../../ellie-forest/src/db'
const BACKUP_DIR = '/home/ellie/ellie-backup/daily/20260306/elasticsearch'
const DRY_RUN = process.argv.includes('--dry-run')

console.log(`Backfill Forest from ES backup`)
console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`)

// ── Entity ID mapping (old ES → current Forest DB) ──────────────────────────

const ENTITY_MAP: Record<string, string> = {
  'd238453c-24f3-4617-9b9c-6a8c77cb43dc': '5dbf373f-61d5-4c47-96d9-4dcf688d6b03', // dev_agent
  'd0a48663-eb32-4bc9-82b0-ba692d714bd8': 'a9fd13f1-c4a5-41e5-9439-06f1aa8826fe', // research_agent
  '79aeef4e-5cf6-4fae-bd01-98ad3e64da58': '3f79925b-4e8e-4642-a544-3cbe88896b21', // strategy_agent
  '5a8b146a-4c22-48e8-9c8a-6aa1705132e3': 'a5f4dc8e-fc49-4c0b-a33f-909310783bf5', // general_agent
  'eee8d72b-fb21-40a8-ac63-a85db7df9683': '2480757e-66a5-48d0-8c89-e5237ff7df42', // critic_agent
  '2bceafa3-eb7c-4922-9344-e1f1b8033871': 'b4de030b-312f-4bff-afe9-9c36f833959e', // content_agent
}

function mapEntityId(oldId: string): string | null {
  return ENTITY_MAP[oldId] ?? null
}

// ── Parse NDJSON ─────────────────────────────────────────────────────────────

function parseNdjson<T>(filename: string): T[] {
  const path = `${BACKUP_DIR}/${filename}`
  const lines = readFileSync(path, 'utf-8').split('\n').filter(l => l.trim())
  const docs: T[] = []
  for (const line of lines) {
    // Skip ES metadata lines
    if (line.startsWith('{"index"')) continue
    try {
      docs.push(JSON.parse(line))
    } catch {}
  }
  return docs
}

// ── Phase 1: Trees ───────────────────────────────────────────────────────────

interface EsTree {
  tree_id: string
  type: string
  state: string
  title: string
  work_item_id?: string
  tags?: string[]
  config?: any
  created_at: string
  last_activity?: string
}

async function backfillTrees() {
  const trees = parseNdjson<EsTree>('ellie-forest-trees.ndjson')
  console.log(`\n[Trees] ${trees.length} in ES backup`)

  // Get existing tree IDs to skip
  const existing = await sql<{ id: string }[]>`SELECT id FROM trees`
  const existingIds = new Set(existing.map(r => r.id))

  let inserted = 0
  let skipped = 0
  const BATCH = 200

  for (let i = 0; i < trees.length; i += BATCH) {
    const batch = trees.slice(i, i + BATCH)
    const toInsert = batch.filter(t => !existingIds.has(t.tree_id))
    skipped += batch.length - toInsert.length

    if (toInsert.length === 0) continue
    if (DRY_RUN) {
      inserted += toInsert.length
      continue
    }

    for (const t of toInsert) {
      try {
        await sql`
          INSERT INTO trees (id, type, state, owner_id, title, work_item_id, tags, tree_config, created_at, last_activity)
          VALUES (
            ${t.tree_id}::uuid,
            ${t.type}::tree_type,
            ${t.state}::tree_state,
            'dave',
            ${t.title || null},
            ${t.work_item_id || null},
            ${sql.array(t.tags || [])},
            ${JSON.stringify(t.config || {})}::jsonb,
            ${t.created_at}::timestamptz,
            ${t.last_activity || t.created_at}::timestamptz
          )
          ON CONFLICT (id) DO NOTHING
        `
        inserted++
      } catch (err: any) {
        // Log but continue — may be enum value mismatch etc
        if (!err.message.includes('duplicate')) {
          console.error(`  [Tree] ${t.tree_id} (${t.title}): ${err.message.slice(0, 100)}`)
        }
      }
    }

    if ((i + BATCH) % 500 === 0 || i + BATCH >= trees.length) {
      console.log(`  Batch ${Math.ceil((i + BATCH) / BATCH)}: ${inserted} inserted, ${skipped} skipped`)
    }
  }

  console.log(`[Trees] Done: ${inserted} inserted, ${skipped} skipped`)
  return inserted
}

// ── Phase 2: Commits ─────────────────────────────────────────────────────────

interface EsCommit {
  commit_id: string
  tree_id: string
  branch_id?: string
  entity_id?: string
  message: string
  tree_title?: string
  tree_type?: string
  entity_name?: string
  created_at: string
}

async function backfillCommits() {
  const commits = parseNdjson<EsCommit>('ellie-forest-commits.ndjson')
  console.log(`\n[Commits] ${commits.length} in ES backup`)

  // Get valid tree IDs (only insert commits for trees that exist)
  const validTrees = await sql<{ id: string }[]>`SELECT id FROM trees`
  const validTreeIds = new Set(validTrees.map(r => r.id))

  let inserted = 0
  let skipped = 0
  let orphaned = 0

  for (let i = 0; i < commits.length; i++) {
    const c = commits[i]

    if (!validTreeIds.has(c.tree_id)) {
      orphaned++
      continue
    }

    if (DRY_RUN) {
      inserted++
      continue
    }

    try {
      const entityId = c.entity_id ? mapEntityId(c.entity_id) : null

      await sql`
        INSERT INTO commits (id, tree_id, entity_id, message, created_at)
        VALUES (
          ${c.commit_id}::uuid,
          ${c.tree_id}::uuid,
          ${entityId}::uuid,
          ${c.message},
          ${c.created_at}::timestamptz
        )
        ON CONFLICT (id) DO NOTHING
      `
      inserted++
    } catch (err: any) {
      if (!err.message.includes('duplicate')) {
        skipped++
      }
    }

    if ((i + 1) % 500 === 0) {
      console.log(`  Progress: ${i + 1}/${commits.length} (${inserted} inserted)`)
    }
  }

  console.log(`[Commits] Done: ${inserted} inserted, ${skipped} errors, ${orphaned} orphaned (no matching tree)`)
  return inserted
}

// ── Phase 3: Creatures ───────────────────────────────────────────────────────

interface EsCreature {
  creature_id: string
  type: string
  tree_id: string
  entity_id: string
  intent: string
  state: string
  instructions?: any
  result?: any
  completed_at?: string
  created_at: string
  timeout_seconds?: number
  retry_count?: number
}

async function backfillCreatures() {
  const creatures = parseNdjson<EsCreature>('ellie-forest-creatures.ndjson')
  console.log(`\n[Creatures] ${creatures.length} in ES backup`)

  // Get valid tree IDs
  const validTrees = await sql<{ id: string }[]>`SELECT id FROM trees`
  const validTreeIds = new Set(validTrees.map(r => r.id))

  let inserted = 0
  let skipped = 0
  let orphaned = 0
  let unmapped = 0

  for (let i = 0; i < creatures.length; i++) {
    const c = creatures[i]

    if (!validTreeIds.has(c.tree_id)) {
      orphaned++
      continue
    }

    const entityId = mapEntityId(c.entity_id)
    if (!entityId) {
      unmapped++
      continue
    }

    if (DRY_RUN) {
      inserted++
      continue
    }

    try {
      await sql`
        INSERT INTO creatures (id, type, tree_id, entity_id, intent, state, instructions, result, completed_at, created_at, timeout_seconds, retry_count)
        VALUES (
          ${c.creature_id}::uuid,
          ${c.type}::creature_type,
          ${c.tree_id}::uuid,
          ${entityId}::uuid,
          ${c.intent},
          ${c.state}::creature_state,
          ${JSON.stringify(c.instructions || {})}::jsonb,
          ${c.result ? JSON.stringify(c.result) : null}::jsonb,
          ${c.completed_at || null}::timestamptz,
          ${c.created_at}::timestamptz,
          ${c.timeout_seconds || 300},
          ${c.retry_count || 0}
        )
        ON CONFLICT (id) DO NOTHING
      `
      inserted++
    } catch (err: any) {
      if (!err.message.includes('duplicate')) {
        skipped++
      }
    }

    if ((i + 1) % 500 === 0) {
      console.log(`  Progress: ${i + 1}/${creatures.length} (${inserted} inserted)`)
    }
  }

  console.log(`[Creatures] Done: ${inserted} inserted, ${skipped} errors, ${orphaned} orphaned, ${unmapped} unmapped entity`)
  return inserted
}

// ── Run ──────────────────────────────────────────────────────────────────────

const treeCount = await backfillTrees()
const commitCount = await backfillCommits()
const creatureCount = await backfillCreatures()

console.log(`\n========================================`)
console.log(`Total: ${treeCount} trees, ${commitCount} commits, ${creatureCount} creatures`)

// Final counts
const [tc] = await sql`SELECT count(*) as c FROM trees`
const [cc] = await sql`SELECT count(*) as c FROM commits`
const [cr] = await sql`SELECT count(*) as c FROM creatures`
console.log(`Forest DB now: ${tc.c} trees, ${cc.c} commits, ${cr.c} creatures`)

await sql.end()
