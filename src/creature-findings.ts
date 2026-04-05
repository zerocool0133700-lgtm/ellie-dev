/**
 * Creature Findings — auto-extract and persist knowledge from creature results.
 *
 * When a creature completes, its result contains response_preview, decisions,
 * and other structured data. This module extracts meaningful findings and
 * writes them to Forest shared_memories with full attribution.
 */

import { log } from "./logger.ts"

const logger = log.child("creature-findings")

const MIN_PREVIEW_LENGTH = 50

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

export function extractFindings(result: Record<string, unknown>): Finding[] {
  const findings: Finding[] = []

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
