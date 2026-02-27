/**
 * Agent Queue API — ELLIE-200 + ELLIE-201
 *
 * Async communication queue between agents (Ellie ↔ James).
 * Queue = "act on this now"; Bridge = "remember this forever".
 *
 * v1 (ELLIE-200):
 *   POST /api/queue/create        — create a queue item
 *   GET  /api/queue/list           — list items (filtered by target, status)
 *   POST /api/queue/:id/status     — update item status
 *   DELETE /api/queue/:id          — delete a queue item
 *
 * v2 (ELLIE-201):
 *   GET  /api/queue/stats          — queue stats for dashboard
 *   getQueueContext(target)        — pending items formatted for agent context injection
 *   summarizeCompletedTobridge()   — write completed items to Bridge, then delete
 *   expireStaleItems()             — auto-archive items >7 days old
 */

import { sql, writeMemory } from '../../../ellie-forest/src/index'
import { log } from "../logger.ts";

const logger = log.child("agent-queue");

// ── Types ────────────────────────────────────────────────────

type QueuePriority = 'critical' | 'high' | 'medium' | 'low'
type QueueStatus = 'new' | 'acknowledged' | 'completed'

interface QueueItem {
  id: string
  created_at: Date
  source: string
  target: string
  priority: QueuePriority
  category: string
  title: string
  content: string
  work_item_id: string | null
  status: QueueStatus
  acknowledged_at: Date | null
  completed_at: Date | null
  related_refs: any[]
  metadata: Record<string, any>
}

// ── POST /api/queue/create ──────────────────────────────────

export async function createQueueItem(req: any, res: any) {
  try {
    const { source, target, priority, category, title, content, work_item_id, related_refs, metadata } = req.body

    if (!source || !target || !category || !title || !content) {
      return res.status(400).json({ error: 'Required: source, target, category, title, content' })
    }

    const validPriorities = ['critical', 'high', 'medium', 'low']
    const prio = validPriorities.includes(priority) ? priority : 'medium'

    const [item] = await sql<QueueItem[]>`
      INSERT INTO agent_queue (source, target, priority, category, title, content, work_item_id, related_refs, metadata)
      VALUES (${source}, ${target}, ${prio}, ${category}, ${title}, ${content}, ${work_item_id || null}, ${sql.json(related_refs || [])}, ${sql.json(metadata || {})})
      RETURNING *
    `

    console.log(`[agent-queue] Created: ${source} → ${target} [${prio}] ${category}: ${title}`)
    return res.json({ ok: true, item })
  } catch (error) {
    logger.error("Create failed", error)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

// ── GET /api/queue/list ─────────────────────────────────────

export async function listQueueItems(req: any, res: any) {
  try {
    const url = new URL(req.url, 'http://localhost')
    const target = url.searchParams.get('target')
    const status = url.searchParams.get('status')
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200)

    let items: QueueItem[]

    if (target && status) {
      items = await sql<QueueItem[]>`
        SELECT * FROM agent_queue WHERE target = ${target} AND status = ${status}
        ORDER BY
          CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
          created_at ASC
        LIMIT ${limit}
      `
    } else if (target) {
      items = await sql<QueueItem[]>`
        SELECT * FROM agent_queue WHERE target = ${target} AND status != 'completed'
        ORDER BY
          CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
          created_at ASC
        LIMIT ${limit}
      `
    } else if (status) {
      items = await sql<QueueItem[]>`
        SELECT * FROM agent_queue WHERE status = ${status}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `
    } else {
      items = await sql<QueueItem[]>`
        SELECT * FROM agent_queue WHERE status != 'completed'
        ORDER BY created_at DESC
        LIMIT ${limit}
      `
    }

    return res.json({ ok: true, count: items.length, items })
  } catch (error) {
    logger.error("List failed", error)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

// ── POST /api/queue/:id/status ──────────────────────────────

export async function updateQueueStatus(req: any, res: any, id: string) {
  try {
    const { status } = req.body

    if (!status || !['acknowledged', 'completed'].includes(status)) {
      return res.status(400).json({ error: 'status must be "acknowledged" or "completed"' })
    }

    const timestampCol = status === 'acknowledged' ? 'acknowledged_at' : 'completed_at'

    const [item] = await sql<QueueItem[]>`
      UPDATE agent_queue SET
        status = ${status},
        ${sql(timestampCol)} = NOW()
      WHERE id = ${id}
      RETURNING *
    `

    if (!item) {
      return res.status(404).json({ error: 'Queue item not found' })
    }

    console.log(`[agent-queue] ${id.slice(0, 8)} → ${status}`)

    // On completion, summarize to Bridge memory then delete (fire-and-forget)
    if (status === 'completed') {
      summarizeCompletedItem(item).catch(err =>
        logger.error("Bridge summarize failed", err)
      )
    }

    return res.json({ ok: true, item })
  } catch (error) {
    logger.error("Status update failed", error)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

// ── DELETE /api/queue/:id ───────────────────────────────────

export async function deleteQueueItem(req: any, res: any, id: string) {
  try {
    const [item] = await sql<{ id: string }[]>`
      DELETE FROM agent_queue WHERE id = ${id} RETURNING id
    `

    if (!item) {
      return res.status(404).json({ error: 'Queue item not found' })
    }

    console.log(`[agent-queue] Deleted: ${id.slice(0, 8)}`)
    return res.json({ ok: true })
  } catch (error) {
    logger.error("Delete failed", error)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

// ── v2: Bridge summarization (ELLIE-201) ──────────────────────

async function summarizeCompletedItem(item: QueueItem): Promise<void> {
  const summary = `[Queue ${item.category}] ${item.source} → ${item.target}: ${item.title}\n${item.content}`
  const scopePath = item.work_item_id ? '2/1' : '2'  // project scope if work item, else top-level projects

  await writeMemory({
    content: summary,
    type: 'finding',
    scope_path: scopePath,
    confidence: 0.7,
    tags: ['queue:completed', `queue:${item.category}`, `agent:${item.source}`, `agent:${item.target}`],
    metadata: {
      queue_item_id: item.id,
      queue_source: item.source,
      queue_target: item.target,
      queue_category: item.category,
      ...(item.work_item_id ? { work_item_id: item.work_item_id } : {}),
    },
    category: 'work',
  })

  // Delete the queue item now that it's preserved in Bridge
  await sql`DELETE FROM agent_queue WHERE id = ${item.id}`
  console.log(`[agent-queue] Summarized ${item.id.slice(0, 8)} to Bridge and deleted`)
}

// ── v2: Queue context for agent session start (ELLIE-201) ────

export async function getQueueContext(target: string): Promise<string> {
  const items = await sql<QueueItem[]>`
    SELECT * FROM agent_queue
    WHERE target = ${target} AND status IN ('new', 'acknowledged')
    ORDER BY
      CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
      created_at ASC
    LIMIT 20
  `

  if (items.length === 0) return ''

  const lines = items.map(item => {
    const age = Math.round((Date.now() - new Date(item.created_at).getTime()) / 3600000)
    const ageStr = age < 24 ? `${age}h ago` : `${Math.round(age / 24)}d ago`
    const ticket = item.work_item_id ? ` (${item.work_item_id})` : ''
    return `- [${item.priority.toUpperCase()}] ${item.title}${ticket} — from ${item.source}, ${ageStr}\n  ${item.content.slice(0, 200)}${item.content.length > 200 ? '...' : ''}`
  })

  return `PENDING QUEUE ITEMS (${items.length}):\n${lines.join('\n')}`
}

// ── v2: Mark items as acknowledged (ELLIE-201) ──────────────

export async function acknowledgeQueueItems(target: string): Promise<number> {
  const result = await sql`
    UPDATE agent_queue SET status = 'acknowledged', acknowledged_at = NOW()
    WHERE target = ${target} AND status = 'new'
  `
  const count = result.count
  if (count > 0) console.log(`[agent-queue] Acknowledged ${count} items for ${target}`)
  return count
}

// ── v2: Fetch + acknowledge readout items (ELLIE-199) ────────

export async function getAndAcknowledgeReadouts(): Promise<QueueItem[]> {
  // Only fetch undelivered readouts — 'new' status only.
  // Previously included 'acknowledged' which caused the same findings
  // to be re-delivered on every ellie-chat reconnect.
  const items = await sql<QueueItem[]>`
    SELECT * FROM agent_queue
    WHERE target = 'ellie' AND status = 'new'
      AND metadata->>'readout' = 'true'
    ORDER BY created_at ASC
    LIMIT 10
  `
  if (items.length > 0) {
    const ids = items.map(i => i.id)
    // Mark as completed — these are fire-once notifications, not persistent tasks
    await sql`
      UPDATE agent_queue SET status = 'completed', acknowledged_at = NOW()
      WHERE id = ANY(${ids})
    `
  }
  return items
}

// ── v2: Stale item expiry (ELLIE-201) ────────────────────────

export async function expireStaleItems(): Promise<number> {
  const result = await sql`
    DELETE FROM agent_queue
    WHERE status = 'new'
      AND created_at < NOW() - INTERVAL '7 days'
    RETURNING id
  `
  const count = result.length
  if (count > 0) console.log(`[agent-queue] Expired ${count} stale items (>7 days, never acknowledged)`)
  return count
}

// ── v2: Queue stats for dashboard (ELLIE-201) ────────────────

export async function getQueueStats(req: any, res: any) {
  try {
    const [byTarget, byPriority, byStatus, recent] = await Promise.all([
      sql`
        SELECT target, COUNT(*)::int as count
        FROM agent_queue WHERE status != 'completed'
        GROUP BY target ORDER BY count DESC
      `,
      sql`
        SELECT priority, COUNT(*)::int as count
        FROM agent_queue WHERE status != 'completed'
        GROUP BY priority
        ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END
      `,
      sql`
        SELECT status, COUNT(*)::int as count
        FROM agent_queue
        GROUP BY status
      `,
      sql<QueueItem[]>`
        SELECT * FROM agent_queue
        ORDER BY created_at DESC
        LIMIT 10
      `,
    ])

    return res.json({
      ok: true,
      by_target: byTarget,
      by_priority: byPriority,
      by_status: byStatus,
      recent,
    })
  } catch (error) {
    logger.error("Stats failed", error)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

// ── v2: Direct queue item creation (no HTTP, for Bridge integration) ──

export async function createQueueItemDirect(params: {
  source: string
  target: string
  priority?: QueuePriority
  category: string
  title: string
  content: string
  work_item_id?: string
  related_refs?: any[]
  metadata?: Record<string, any>
}): Promise<QueueItem> {
  const prio = params.priority || 'medium'
  const [item] = await sql<QueueItem[]>`
    INSERT INTO agent_queue (source, target, priority, category, title, content, work_item_id, related_refs, metadata)
    VALUES (${params.source}, ${params.target}, ${prio}, ${params.category}, ${params.title}, ${params.content},
            ${params.work_item_id || null}, ${sql.json(params.related_refs || [])}, ${sql.json(params.metadata || {})})
    RETURNING *
  `
  console.log(`[agent-queue] Created (direct): ${params.source} → ${params.target} [${prio}] ${params.category}: ${params.title}`)
  return item
}
