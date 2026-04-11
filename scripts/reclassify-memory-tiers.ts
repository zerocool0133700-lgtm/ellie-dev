/**
 * Catch-Up Reclassification Script — Task 6
 *
 * One-time script that brings all 3,700+ existing memories up to the new
 * content-tier system. Orchestrates the fast classifier (Task 2) and deep
 * classifier (Task 4) across five phases.
 *
 * Usage:
 *   bun run scripts/reclassify-memory-tiers.ts               # all phases
 *   bun run scripts/reclassify-memory-tiers.ts --phase=2     # single phase
 *   bun run scripts/reclassify-memory-tiers.ts --dry-run     # counts only
 *
 * Phases:
 *   1  Archive ELLIE-653 test clutter
 *   2  Fast-classify all active memories
 *   3  Deep-classify (LLM) ambiguous memories
 *   4  Sweep stale ephemeral memories
 *   5  Full weight refresh
 */

import "dotenv/config"
import forestSql from "../../ellie-forest/src/db.ts"
import { classifyContentTier } from "../../ellie-forest/src/memory-classifier.ts"
import { refreshWeights } from "../../ellie-forest/src/shared-memory.ts"
import { initDeepClassifier, processDeepClassificationBatch } from "../src/deep-classifier.ts"

// ── CLI args ──────────────────────────────────────────────────────────────────

const dryRun   = process.argv.includes("--dry-run")
const phaseArg = process.argv.find(a => a.startsWith("--phase="))
const onlyPhase: number | null = phaseArg ? parseInt(phaseArg.split("=")[1], 10) : null

function shouldRun(phase: number): boolean {
  return onlyPhase === null || onlyPhase === phase
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

// ── Phase 1: Archive ELLIE-653 test clutter ───────────────────────────────────

async function phase1(): Promise<void> {
  log("Phase 1: Archiving ELLIE-653 test artifacts…")

  if (dryRun) {
    const [{ count }] = await forestSql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM shared_memories
      WHERE status = 'active' AND content LIKE '%ELLIE-653%'
    `
    log(`  (DRY RUN) Would archive ${count} memories containing 'ELLIE-653'`)
    return
  }

  const result = await forestSql`
    UPDATE shared_memories
    SET status = 'archived', updated_at = now()
    WHERE status = 'active' AND content LIKE '%ELLIE-653%'
  `

  log(`  Archived ${result.count} ELLIE-653 test memories`)
}

// ── Phase 2: Fast-classify all active memories ────────────────────────────────

async function phase2(): Promise<void> {
  log("Phase 2: Fast-classifying all active memories…")

  const memories = await forestSql<{
    id: string
    content: string
    confidence: number | null
    emotional_intensity: number | null
  }[]>`
    SELECT id, content, confidence, emotional_intensity
    FROM shared_memories
    WHERE status = 'active'
    ORDER BY created_at ASC
  `

  log(`  Found ${memories.length} active memories to classify`)
  if (dryRun) log("  (DRY RUN) — no updates will be written")

  const tierCounts: Record<string, number> = {
    foundational: 0,
    strategic:    0,
    operational:  0,
    ephemeral:    0,
  }
  let needsDeepCount = 0
  let processed = 0

  for (const mem of memories) {
    const result = classifyContentTier(mem.content)

    // Override protection: if the memory already has a confident classification
    // and doesn't need deep review, honour the higher confidence score.
    const existingConfidence = mem.confidence ?? 0
    const isConfidentExisting = existingConfidence > 0.7 && !result.needs_deep
    const finalConfidence = isConfidentExisting
      ? Math.max(existingConfidence, result.confidence)
      : result.confidence

    tierCounts[result.tier] = (tierCounts[result.tier] ?? 0) + 1
    if (result.needs_deep) needsDeepCount++

    if (!dryRun) {
      await forestSql`
        UPDATE shared_memories
        SET
          content_tier               = ${result.tier},
          confidence                 = ${finalConfidence},
          emotional_intensity        = ${result.emotional_intensity},
          needs_deep_classification  = ${result.needs_deep},
          updated_at                 = now()
        WHERE id = ${mem.id}
      `
    }

    processed++
    if (processed % 200 === 0) {
      log(`  Progress: ${processed}/${memories.length} — needs_deep so far: ${needsDeepCount}`)
    }
  }

  log("  Tier distribution after fast classification:")
  for (const [tier, count] of Object.entries(tierCounts)) {
    log(`    ${tier.padEnd(12)}: ${count}`)
  }
  log(`  Needs deep classification: ${needsDeepCount}`)
}

// ── Phase 3: Deep-classify ambiguous memories (LLM) ───────────────────────────

async function phase3(): Promise<void> {
  log("Phase 3: Deep-classifying ambiguous memories via LLM…")

  if (dryRun) {
    const [{ count }] = await forestSql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM shared_memories
      WHERE status = 'active' AND needs_deep_classification = true
    `
    log(`  (DRY RUN) ${count} memories flagged for deep classification — skipping LLM calls`)
    return
  }

  const Anthropic = (await import("@anthropic-ai/sdk")).default
  const anthropic = new Anthropic()
  initDeepClassifier(anthropic)

  let totalProcessed = 0
  let batchNum = 0

  while (true) {
    batchNum++
    const processed = await processDeepClassificationBatch({ limit: 50 })
    totalProcessed += processed
    log(`  Batch ${batchNum}: processed ${processed} memories (total: ${totalProcessed})`)
    if (processed === 0) break
  }

  log(`  Deep classification complete — ${totalProcessed} memories reclassified`)
}

// ── Phase 4: Sweep stale ephemeral memories ───────────────────────────────────

async function phase4(): Promise<void> {
  log("Phase 4: Sweeping stale ephemeral memories…")

  if (dryRun) {
    const [{ count }] = await forestSql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM shared_memories
      WHERE status = 'active'
        AND content_tier = 'ephemeral'
        AND last_accessed_at IS NULL
        AND created_at < '2026-03-01'
    `
    log(`  (DRY RUN) Would archive ${count} stale ephemeral memories`)
    return
  }

  const result = await forestSql`
    UPDATE shared_memories
    SET status = 'archived', updated_at = now()
    WHERE status = 'active'
      AND content_tier = 'ephemeral'
      AND last_accessed_at IS NULL
      AND created_at < '2026-03-01'
  `

  log(`  Archived ${result.count} stale ephemeral memories`)
}

// ── Phase 5: Full weight refresh ──────────────────────────────────────────────

async function phase5(): Promise<void> {
  log("Phase 5: Refreshing weights for all active memories…")

  if (dryRun) {
    const [{ count }] = await forestSql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM shared_memories WHERE status = 'active'
    `
    log(`  (DRY RUN) Would refresh weights for ~${count} memories`)
    return
  }

  // Count active memories first to cap the loop
  // (refreshWeights sets updated_at = NOW() which cycles records endlessly)
  const [{ count }] = await forestSql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM shared_memories WHERE status = 'active'
  `
  const maxBatches = Math.ceil(count / 500) + 1
  let totalRefreshed = 0

  for (let batch = 1; batch <= maxBatches; batch++) {
    const refreshed = await refreshWeights({ limit: 500 })
    totalRefreshed += refreshed
    log(`  Batch ${batch}/${maxBatches}: refreshed ${refreshed} weights (total: ${totalRefreshed})`)
    if (refreshed < 500) break
  }

  log(`  Weight refresh complete — ${totalRefreshed} memories updated`)
}

// ── Final distribution report ─────────────────────────────────────────────────

async function showDistribution(): Promise<void> {
  log("Final distribution:")

  const rows = await forestSql<{
    content_tier: string
    count: string
    avg_conf: string
    avg_weight: string
    avg_ei: string
  }[]>`
    SELECT
      content_tier,
      count(*)::text                                      AS count,
      round(avg(confidence)::numeric, 2)::text           AS avg_conf,
      round(avg(weight)::numeric, 3)::text               AS avg_weight,
      round(avg(emotional_intensity)::numeric, 2)::text  AS avg_ei
    FROM shared_memories
    WHERE status = 'active'
    GROUP BY content_tier
    ORDER BY avg_weight DESC
  `

  const header = "  tier            count   avg_conf  avg_weight  avg_ei"
  log(header)
  log("  " + "-".repeat(header.length - 2))

  for (const r of rows) {
    const tier    = (r.content_tier ?? "null").padEnd(14)
    const count   = (r.count       ?? "—").padStart(7)
    const conf    = (r.avg_conf    ?? "—").padStart(9)
    const weight  = (r.avg_weight  ?? "—").padStart(11)
    const ei      = (r.avg_ei      ?? "—").padStart(7)
    log(`  ${tier} ${count}  ${conf}  ${weight}  ${ei}`)
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log("=== Reclassify Memory Tiers ===")
  if (dryRun)   log("Mode: DRY RUN")
  if (onlyPhase) log(`Mode: Single phase ${onlyPhase}`)

  try {
    if (shouldRun(1)) await phase1()
    if (shouldRun(2)) await phase2()
    if (shouldRun(3)) await phase3()
    if (shouldRun(4)) await phase4()
    if (shouldRun(5)) await phase5()

    await showDistribution()
    log("=== Done ===")
  } finally {
    await forestSql.end()
  }
}

main().catch(err => {
  console.error("Fatal:", err)
  process.exit(1)
})
