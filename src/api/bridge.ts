/**
 * Forest Bridge API — ELLIE-177
 *
 * REST endpoints for external collaborators to read/write forest knowledge.
 * Per-collaborator API keys with scoped access. No coupling to agent router.
 *
 * Endpoints:
 *   POST /api/bridge/read    — semantic search within allowed scopes
 *   POST /api/bridge/write   — write a leaf (decision, discovery, observation)
 *   GET  /api/bridge/list    — list memories by scope/type/tree
 *   GET  /api/bridge/scopes  — browse accessible scope hierarchy
 *   GET  /api/bridge/whoami  — return key metadata
 */

import { createHash } from 'crypto'
import {
  readMemories, writeMemory,
  getScope, getChildScopes, getBreadcrumb,
  isAncestor,
  sql,
} from '../../../ellie-forest/src/index'
import { createQueueItemDirect } from './agent-queue'
import type { ApiRequest, ApiResponse } from "./types.ts";
import { log } from "../logger.ts";

const logger = log.child("bridge");

// ── Types ────────────────────────────────────────────────────

interface BridgeKey {
  id: string
  name: string
  collaborator: string
  key_hash: string
  key_prefix: string
  allowed_scopes: string[]
  permissions: string[]
  active: boolean
  last_used_at: Date | null
  request_count: number
  expires_at: Date | null
  entity_id: string | null  // ELLIE-255: linked Forest entity for author attribution
}

// ── Auth ─────────────────────────────────────────────────────

async function authenticateBridgeKey(
  rawKey: string | undefined,
  res: ApiResponse,
  requiredPermission?: 'read' | 'write',
): Promise<BridgeKey | null> {
  if (!rawKey) {
    res.status(401).json({ error: 'Missing x-bridge-key header' })
    return null
  }

  const keyHash = createHash('sha256').update(rawKey).digest('hex')

  const [key] = await sql<BridgeKey[]>`
    SELECT * FROM bridge_keys
    WHERE key_hash = ${keyHash} AND active = TRUE
  `

  if (!key) {
    res.status(401).json({ error: 'Invalid or inactive bridge key' })
    return null
  }

  if (key.expires_at && new Date(key.expires_at) < new Date()) {
    res.status(401).json({ error: 'Bridge key has expired' })
    return null
  }

  if (requiredPermission && !key.permissions.includes(requiredPermission)) {
    res.status(403).json({ error: `Key does not have '${requiredPermission}' permission` })
    return null
  }

  // Update usage stats (fire-and-forget)
  sql`
    UPDATE bridge_keys
    SET last_used_at = NOW(), request_count = request_count + 1
    WHERE id = ${key.id}
  `.catch(() => {})

  return key
}

function isWithinAllowedScopes(targetPath: string, allowedScopes: string[]): boolean {
  return allowedScopes.some(allowed => isAncestor(allowed, targetPath))
}

// ── POST /api/bridge/read ────────────────────────────────────

export async function bridgeReadEndpoint(req: ApiRequest, res: ApiResponse) {
  const key = await authenticateBridgeKey(req.bridgeKey, res, 'read')
  if (!key) return

  try {
    const { query, scope_path, tree_id, match_count, match_threshold, category, cognitive_type, author } = req.body

    if (!query) {
      return res.status(400).json({ error: 'Missing required field: query' })
    }

    if (scope_path && !isWithinAllowedScopes(scope_path, key.allowed_scopes)) {
      return res.status(403).json({ error: `Scope path '${scope_path}' is outside your allowed scopes` })
    }

    const effectiveScopePath = scope_path || key.allowed_scopes[0]

    let results = await readMemories({
      query,
      scope_path: effectiveScopePath,
      tree_id,
      match_count: match_count ?? 10,
      match_threshold: match_threshold ?? 0.7,
      category,
      cognitive_type,
      include_global: false,
    })

    // ELLIE-255: Filter by author (bridge_collaborator in metadata)
    if (author) {
      results = results.filter(m =>
        (m.metadata as Record<string, unknown>)?.bridge_collaborator === author
      )
    }

    console.log(`[bridge:read] ${key.key_prefix} (${key.collaborator}) queried "${query.slice(0, 60)}"${author ? ` [author:${author}]` : ''} → ${results.length} results`)

    return res.json({ success: true, count: results.length, memories: results })
  } catch (error) {
    logger.error("Read failed", error)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

// ── Write callback (ELLIE-199 — lets relay.ts send notifications) ──

type BridgeWriteCallback = (info: {
  collaborator: string
  content: string
  memoryId: string
  type: string
  workItemId?: string
  category?: string
}) => void

let onBridgeWriteCallback: BridgeWriteCallback | null = null

export function onBridgeWrite(cb: BridgeWriteCallback): void {
  onBridgeWriteCallback = cb
}

// ── POST /api/bridge/write ───────────────────────────────────

export async function bridgeWriteEndpoint(req: ApiRequest, res: ApiResponse) {
  const key = await authenticateBridgeKey(req.bridgeKey, res, 'write')
  if (!key) return

  try {
    const { content, type, scope_path, confidence, tags, metadata, work_item_id, category, queue_target, queue_priority } = req.body

    if (!content) {
      return res.status(400).json({ error: 'Missing required field: content' })
    }
    if (!scope_path) {
      return res.status(400).json({ error: 'Missing required field: scope_path' })
    }

    if (!isWithinAllowedScopes(scope_path, key.allowed_scopes)) {
      return res.status(403).json({ error: `Scope path '${scope_path}' is outside your allowed scopes` })
    }

    const allowedTypes = ['fact', 'decision', 'finding', 'hypothesis', 'preference']
    const memType = type ?? 'finding'
    if (!allowedTypes.includes(memType)) {
      return res.status(400).json({ error: `Invalid type '${memType}'. Allowed: ${allowedTypes.join(', ')}` })
    }

    const memory = await writeMemory({
      content,
      type: memType,
      scope_path,
      confidence: confidence ?? 0.5,
      tags: [...(tags ?? []), `bridge:${key.collaborator}`],
      metadata: {
        ...(metadata ?? {}),
        bridge_key_id: key.id,
        bridge_collaborator: key.collaborator,
        ...(work_item_id ? { work_item_id } : {}),
      },
      category,
      // ELLIE-255: Auto-attribute to linked entity
      ...(key.entity_id ? { source_entity_id: key.entity_id } : {}),
    })

    console.log(`[bridge:write] ${key.key_prefix} (${key.collaborator}) wrote memory ${memory.id} at ${scope_path}`)

    // Auto-create queue item if queue_target specified (ELLIE-201)
    let queueItem = null
    if (queue_target) {
      try {
        queueItem = await createQueueItemDirect({
          source: key.collaborator,
          target: queue_target,
          priority: queue_priority || 'medium',
          category: category || memType,
          title: content.slice(0, 120),
          content,
          work_item_id,
          related_refs: [{ type: 'bridge', id: memory.id }],
          metadata: { bridge_memory_id: memory.id },
        })
      } catch (err) {
        logger.error("Queue auto-create failed", err)
      }
    }

    // Auto-queue readout for external collaborator writes (ELLIE-199)
    // If no explicit queue_target was set, auto-create a readout item for "ellie"
    if (!queue_target && key.collaborator !== 'ellie') {
      try {
        await createQueueItemDirect({
          source: key.collaborator,
          target: 'ellie',
          priority: 'medium',
          category: category || memType,
          title: content.slice(0, 120),
          content,
          work_item_id,
          related_refs: [{ type: 'bridge', id: memory.id }],
          metadata: { bridge_memory_id: memory.id, readout: true },
        })
      } catch (err) {
        logger.error("Readout queue auto-create failed", err)
      }
    }

    // Notify relay (for Telegram notifications, etc.)
    if (onBridgeWriteCallback && key.collaborator !== 'ellie') {
      try {
        onBridgeWriteCallback({
          collaborator: key.collaborator,
          content,
          memoryId: memory.id,
          type: memType,
          workItemId: work_item_id,
          category,
        })
      } catch { /* non-fatal */ }
    }

    return res.json({
      success: true,
      memory_id: memory.id,
      scope_path,
      content: memory.content,
      ...(queueItem ? { queue_item_id: queueItem.id } : {}),
    })
  } catch (error) {
    logger.error("Write failed", error)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

// ── GET /api/bridge/list ─────────────────────────────────────

export async function bridgeListEndpoint(req: ApiRequest, res: ApiResponse) {
  const key = await authenticateBridgeKey(req.bridgeKey, res, 'read')
  if (!key) return

  try {
    const { scope_path, type, limit, min_confidence, tree_id, author } = req.query

    if (scope_path && !isWithinAllowedScopes(scope_path, key.allowed_scopes)) {
      return res.status(403).json({ error: `Scope path '${scope_path}' is outside your allowed scopes` })
    }

    const effectivePaths = scope_path ? [scope_path] : key.allowed_scopes

    const results = await sql`
      SELECT id, content, type, scope, scope_id, scope_path,
             confidence, source_entity_id, source_tree_id,
             tags, metadata, cognitive_type, weight, category,
             created_at
      FROM shared_memories
      WHERE status = 'active'
        AND NOT (type = 'contradiction' AND contradiction_resolved = FALSE)
        AND (expires_at IS NULL OR expires_at > NOW())
        AND scope_path IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM unnest(${sql.array(effectivePaths)}::text[]) AS ap
          WHERE scope_path = ap OR scope_path LIKE ap || '/%'
        )
        ${type ? sql`AND type = ${type}` : sql``}
        ${tree_id ? sql`AND source_tree_id = ${tree_id}` : sql``}
        ${min_confidence ? sql`AND confidence >= ${Number(min_confidence)}` : sql``}
        ${author ? sql`AND metadata->>'bridge_collaborator' = ${author}` : sql``}
      ORDER BY COALESCE(weight, confidence) DESC, created_at DESC
      LIMIT ${Number(limit) || 50}
    `

    return res.json({ success: true, count: results.length, memories: results })
  } catch (error) {
    logger.error("List failed", error)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

// ── GET /api/bridge/scopes ───────────────────────────────────

export async function bridgeScopesEndpoint(req: ApiRequest, res: ApiResponse) {
  const key = await authenticateBridgeKey(req.bridgeKey, res, 'read')
  if (!key) return

  try {
    const requestedPath = req.query.path

    if (requestedPath) {
      if (!isWithinAllowedScopes(requestedPath, key.allowed_scopes)) {
        return res.status(403).json({ error: `Scope path '${requestedPath}' is outside your allowed scopes` })
      }
      const scope = await getScope(requestedPath)
      const children = await getChildScopes(requestedPath)
      const breadcrumb = await getBreadcrumb(requestedPath)
      return res.json({ success: true, scope, children, breadcrumb })
    }

    // No path: return allowed root scopes + their children
    const scopes = []
    for (const scopePath of key.allowed_scopes) {
      const scope = await getScope(scopePath)
      if (scope) {
        const children = await getChildScopes(scopePath)
        scopes.push({ ...scope, children })
      }
    }
    return res.json({ success: true, scopes })
  } catch (error) {
    logger.error("Scopes failed", error)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

// ── GET /api/bridge/whoami ───────────────────────────────────

// ── GET /api/bridge/tags ─────────────────────────────────────

export async function bridgeTagsEndpoint(req: ApiRequest, res: ApiResponse) {
  const key = await authenticateBridgeKey(req.bridgeKey, res, 'read')
  if (!key) return

  try {
    const { scope_path } = req.query
    if (scope_path && !isWithinAllowedScopes(scope_path, key.allowed_scopes)) {
      return res.status(403).json({ error: `Scope path '${scope_path}' is outside your allowed scopes` })
    }

    const effectivePaths = scope_path ? [scope_path] : key.allowed_scopes

    const results = await sql`
      SELECT tag, COUNT(*)::int AS count
      FROM shared_memories, unnest(tags) AS tag
      WHERE status = 'active'
        AND (expires_at IS NULL OR expires_at > NOW())
        AND scope_path IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM unnest(${sql.array(effectivePaths)}::text[]) AS ap
          WHERE scope_path = ap OR scope_path LIKE ap || '/%'
        )
      GROUP BY tag
      ORDER BY count DESC, tag ASC
    `

    return res.json({ success: true, tags: results })
  } catch (error) {
    logger.error("Tags failed", error)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

// ── GET /api/bridge/whoami ───────────────────────────────────

export async function bridgeWhoamiEndpoint(req: ApiRequest, res: ApiResponse) {
  const key = await authenticateBridgeKey(req.bridgeKey, res)
  if (!key) return

  return res.json({
    success: true,
    collaborator: key.collaborator,
    name: key.name,
    allowed_scopes: key.allowed_scopes,
    permissions: key.permissions,
    entity_id: key.entity_id,
  })
}
