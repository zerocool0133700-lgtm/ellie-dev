/**
 * Shared Memory Endpoints
 *
 * These endpoints handle cross-agent memory operations:
 * - POST /api/memory/write — write a memory (with optional contradiction check)
 * - POST /api/memory/read — retrieve scoped memories
 * - POST /api/memory/context — get agent context (memories for a dispatch)
 * - POST /api/memory/resolve — resolve a contradiction
 *
 * Contradiction notifications route via the policy engine.
 */

import type { Bot } from "grammy";
import {
  writeMemory,
  writeMemoryWithContradictionCheck,
  readMemories,
  getAgentContext,
  resolveContradiction,
  listUnresolvedContradictions,
  writeCreatureMemory,
} from '../../../ellie-forest/src/index';
import { notify, type NotifyContext } from "../notification-policy.ts";

const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID!;
const GCHAT_SPACE = process.env.GOOGLE_CHAT_SPACE_NAME;

function getNotifyCtx(bot: Bot): NotifyContext {
  return { bot, telegramUserId: TELEGRAM_USER_ID, gchatSpaceName: GCHAT_SPACE };
}

const escapeMarkdown = (text: string) => text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');

/**
 * POST /api/memory/write
 *
 * Body:
 * {
 *   "content": "The relay uses Bun 1.3.9",
 *   "type": "fact",          // optional: fact, finding, decision, preference, hypothesis
 *   "scope": "tree",         // optional: global, tree, branch
 *   "scope_id": "uuid",      // optional
 *   "source_tree_id": "uuid",
 *   "source_entity_id": "uuid",
 *   "confidence": 0.8,       // optional
 *   "tags": ["technology"],   // optional
 *   "check_contradictions": true  // optional: run contradiction check
 * }
 */
export async function writeMemoryEndpoint(req: any, res: any, bot: Bot) {
  try {
    const { content, check_contradictions, ...opts } = req.body;

    if (!content) {
      return res.status(400).json({ error: 'Missing required field: content' });
    }

    if (check_contradictions) {
      const { memory, contradictions } = await writeMemoryWithContradictionCheck(
        { content, ...opts },
        opts.contradiction_threshold,
      );

      // Notify on contradictions
      if (contradictions.length > 0) {
        const telegramMsg = [
          `⚠️ **Memory Contradiction Detected**`,
          ``,
          `**New:** ${escapeMarkdown(content.slice(0, 120))}`,
          `**Contradicts:** ${escapeMarkdown(contradictions[0].contradicting_content.slice(0, 120))}`,
          `**Similarity:** ${(contradictions[0].similarity * 100).toFixed(0)}%`,
        ].join('\n');

        const gchatMsg = [
          `⚠️ Memory Contradiction Detected`,
          ``,
          `New: ${content}`,
          `Contradicts: ${contradictions[0].contradicting_content}`,
          `Similarity: ${(contradictions[0].similarity * 100).toFixed(0)}%`,
          `Memory ID: ${memory.id}`,
          `Scope: ${memory.scope}`,
        ].join('\n');

        await notify(getNotifyCtx(bot), {
          event: "memory_contradiction",
          workItemId: memory.id,
          telegramMessage: telegramMsg,
          gchatMessage: gchatMsg,
        });
      }

      return res.json({
        success: true,
        memory_id: memory.id,
        contradictions_found: contradictions.length,
        contradictions: contradictions.map(c => ({
          memory_id: c.contradicting_memory_id,
          content: c.contradicting_content,
          similarity: c.similarity,
        })),
      });
    }

    const memory = await writeMemory({ content, ...opts });
    return res.json({ success: true, memory_id: memory.id });

  } catch (error) {
    console.error('[memory:write] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/memory/read
 *
 * Body:
 * {
 *   "query": "what port does the relay use",
 *   "scope": "tree",
 *   "scope_id": "uuid",
 *   "include_global": true,
 *   "match_count": 10
 * }
 */
export async function readMemoryEndpoint(req: any, res: any, _bot: Bot) {
  try {
    const { query, ...opts } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Missing required field: query' });
    }

    const results = await readMemories({ query, ...opts });
    return res.json({ success: true, count: results.length, memories: results });

  } catch (error) {
    console.error('[memory:read] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/memory/context
 *
 * Returns scoped memories for an agent dispatch (branch + tree + global).
 *
 * Body:
 * {
 *   "tree_id": "uuid",
 *   "branch_id": "uuid",     // optional
 *   "entity_id": "uuid",     // optional
 *   "max_memories": 20,      // optional
 *   "min_confidence": 0.3    // optional
 * }
 */
export async function agentContextEndpoint(req: any, res: any, _bot: Bot) {
  try {
    const { tree_id, ...opts } = req.body;

    if (!tree_id) {
      return res.status(400).json({ error: 'Missing required field: tree_id' });
    }

    const memories = await getAgentContext({ tree_id, ...opts });
    return res.json({ success: true, count: memories.length, memories });

  } catch (error) {
    console.error('[memory:context] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/memory/resolve
 *
 * Body:
 * {
 *   "memory_id": "uuid",
 *   "resolution": "keep_new" | "keep_old" | "keep_both",
 *   "resolved_by": "entity-name"  // optional
 * }
 */
export async function resolveContradictionEndpoint(req: any, res: any, _bot: Bot) {
  try {
    const { memory_id, resolution, resolved_by } = req.body;

    if (!memory_id || !resolution) {
      return res.status(400).json({ error: 'Missing required fields: memory_id, resolution' });
    }

    if (!['keep_new', 'keep_old', 'keep_both'].includes(resolution)) {
      return res.status(400).json({ error: 'Invalid resolution: must be keep_new, keep_old, or keep_both' });
    }

    await resolveContradiction(memory_id, resolution, resolved_by);
    return res.json({ success: true, memory_id, resolution });

  } catch (error) {
    console.error('[memory:resolve] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/memory/creature-write
 *
 * Convenience for agents to write memories attributed to their creature.
 *
 * Body:
 * {
 *   "creature_id": "uuid",
 *   "tree_id": "uuid",
 *   "branch_id": "uuid",     // optional
 *   "entity_id": "uuid",     // optional
 *   "content": "Found that X causes Y",
 *   "type": "finding",       // optional
 *   "confidence": 0.8,       // optional
 *   "tags": ["debugging"]    // optional
 * }
 */
export async function creatureWriteMemoryEndpoint(req: any, res: any, _bot: Bot) {
  try {
    const { creature_id, tree_id, content, ...opts } = req.body;

    if (!creature_id || !tree_id || !content) {
      return res.status(400).json({ error: 'Missing required fields: creature_id, tree_id, content' });
    }

    const memory = await writeCreatureMemory({ creature_id, tree_id, content, ...opts });
    return res.json({ success: true, memory_id: memory.id, scope: memory.scope });

  } catch (error) {
    console.error('[memory:creature-write] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
