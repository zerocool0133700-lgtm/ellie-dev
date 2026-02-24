/**
 * Shared Memory Endpoints — ELLIE-90 + ELLIE-92
 *
 * These endpoints handle cross-agent memory operations:
 * - POST /api/forest-memory/write — write a memory (with optional entailment-verified contradiction check)
 * - POST /api/forest-memory/read — retrieve scoped memories
 * - POST /api/forest-memory/context — get agent context (memories for a dispatch)
 * - POST /api/forest-memory/resolve — resolve a contradiction
 * - POST /api/forest-memory/ask-critic — dispatch critic creature to evaluate a contradiction
 * - POST /api/forest-memory/creature-write — write memory attributed to a creature
 *
 * Contradiction notifications route via the policy engine.
 */

import type { Bot } from "grammy";
import {
  writeMemory,
  readMemories,
  getMemory,
  getAgentContext,
  findContradictions,
  resolveContradiction,
  markAsContradiction,
  boostConfidence,
  tryAutoResolve,
  dispatchCreature,
  writeCreatureMemory,
  createArc, getArc, updateArc, addMemoryToArc, listArcs, getArcsForMemory,
  sql,
} from '../../../ellie-forest/src/index';
import { classifyEntailment } from "../entailment-classifier.ts";
import { notify, type NotifyContext } from "../notification-policy.ts";

const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID!;
const GCHAT_SPACE = process.env.GOOGLE_CHAT_SPACE_NAME;

function getNotifyCtx(bot: Bot): NotifyContext {
  return { bot, telegramUserId: TELEGRAM_USER_ID, gchatSpaceName: GCHAT_SPACE };
}

const escapeMarkdown = (text: string) => text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');

/**
 * POST /api/forest-memory/write
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
 *   "check_contradictions": true  // optional: run entailment-verified contradiction check
 * }
 */
export async function writeMemoryEndpoint(req: any, res: any, bot: Bot) {
  try {
    const { content, check_contradictions, contradiction_threshold, ...opts } = req.body;

    if (!content) {
      return res.status(400).json({ error: 'Missing required field: content' });
    }

    if (opts.duration === 'working') {
      return res.status(400).json({ error: 'Working memory cannot be persisted — use short_term or long_term' });
    }

    // Default short_term to 14-day expiry if none provided
    if (opts.duration === 'short_term' && !opts.expires_at) {
      opts.expires_at = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    }

    // Always write the memory first
    const memory = await writeMemory({ content, ...opts });

    if (!check_contradictions) {
      return res.json({ success: true, memory_id: memory.id });
    }

    // Step 1: Find cosine-similar candidates in the same scope
    const candidates = await findContradictions(memory.id, contradiction_threshold ?? 0.85);

    if (candidates.length === 0) {
      return res.json({ success: true, memory_id: memory.id, contradictions_found: 0, entailments_found: 0 });
    }

    // Step 2: Classify each candidate with LLM entailment
    const contradictions: Array<typeof candidates[0] & { entailment: Awaited<ReturnType<typeof classifyEntailment>> }> = [];
    const entailments: Array<typeof candidates[0] & { entailment: Awaited<ReturnType<typeof classifyEntailment>> }> = [];

    for (const candidate of candidates) {
      const result = await classifyEntailment(content, candidate.contradicting_content);

      if (result.label === 'contradicts' && result.confidence >= 0.7) {
        contradictions.push({ ...candidate, entailment: result });
      } else if (result.label === 'entails' && result.confidence >= 0.7) {
        entailments.push({ ...candidate, entailment: result });
      }
      // "neutral" or low-confidence: skip (cosine false positive)
    }

    // Step 3: Handle entailments (confidence reinforcement)
    for (const ent of entailments) {
      await boostConfidence(ent.contradicting_memory_id, 0.1, memory.id);
    }

    // Step 4: Handle contradictions
    if (contradictions.length > 0) {
      const primary = contradictions[0];
      await markAsContradiction(memory.id, primary.contradicting_memory_id, {
        entailment_confidence: primary.entailment.confidence,
        entailment_reasoning: primary.entailment.reasoning,
      });

      // Step 5: Try auto-resolution
      const autoResult = await tryAutoResolve(memory.id, primary.contradicting_memory_id);

      if (!autoResult.resolved) {
        // Notify — not auto-resolved, needs human attention
        const telegramMsg = [
          `⚠️ **Memory Contradiction Detected**`,
          ``,
          `**New:** ${escapeMarkdown(content.slice(0, 120))}`,
          `**Contradicts:** ${escapeMarkdown(primary.contradicting_content.slice(0, 120))}`,
          `**Similarity:** ${(primary.similarity * 100).toFixed(0)}%`,
          `**Reasoning:** ${escapeMarkdown(primary.entailment.reasoning.slice(0, 80))}`,
        ].join('\n');

        const gchatMsg = [
          `⚠️ Memory Contradiction Detected`,
          ``,
          `New: ${content}`,
          `Contradicts: ${primary.contradicting_content}`,
          `Similarity: ${(primary.similarity * 100).toFixed(0)}%`,
          `Reasoning: ${primary.entailment.reasoning}`,
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
        entailments_found: entailments.length,
        auto_resolved: autoResult.resolved,
        auto_resolution: autoResult.resolved ? {
          resolution: autoResult.resolution,
          reason: autoResult.reason,
        } : undefined,
        contradictions: contradictions.map(c => ({
          memory_id: c.contradicting_memory_id,
          content: c.contradicting_content,
          similarity: c.similarity,
          reasoning: c.entailment.reasoning,
        })),
      });
    }

    // No contradictions, only entailments or neutrals
    return res.json({
      success: true,
      memory_id: memory.id,
      contradictions_found: 0,
      entailments_found: entailments.length,
    });

  } catch (error) {
    console.error('[memory:write] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/forest-memory/read
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
 * POST /api/forest-memory/context
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
 * POST /api/forest-memory/resolve
 *
 * Body:
 * {
 *   "memory_id": "uuid",
 *   "resolution": "keep_new" | "keep_old" | "keep_both" | "merge",
 *   "resolved_by": "entity-name",    // optional
 *   "merged_content": "combined..."  // required when resolution === "merge"
 * }
 */
export async function resolveContradictionEndpoint(req: any, res: any, _bot: Bot) {
  try {
    const { memory_id, resolution, resolved_by, merged_content } = req.body;

    if (!memory_id || !resolution) {
      return res.status(400).json({ error: 'Missing required fields: memory_id, resolution' });
    }

    if (!['keep_new', 'keep_old', 'keep_both', 'merge'].includes(resolution)) {
      return res.status(400).json({ error: 'Invalid resolution: must be keep_new, keep_old, keep_both, or merge' });
    }

    if (resolution === 'merge' && !merged_content) {
      return res.status(400).json({ error: 'merged_content required for merge resolution' });
    }

    await resolveContradiction(memory_id, resolution, resolved_by, merged_content);
    return res.json({ success: true, memory_id, resolution });

  } catch (error) {
    console.error('[memory:resolve] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/forest-memory/ask-critic
 *
 * Dispatches a critic creature to evaluate a memory contradiction.
 *
 * Body:
 * {
 *   "memory_id": "uuid",
 *   "tree_id": "uuid"
 * }
 */
export async function askCriticEndpoint(req: any, res: any, _bot: Bot) {
  try {
    const { memory_id, tree_id } = req.body;

    if (!memory_id || !tree_id) {
      return res.status(400).json({ error: 'Missing required fields: memory_id, tree_id' });
    }

    const memory = await getMemory(memory_id);
    if (!memory) {
      return res.status(404).json({ error: 'Memory not found' });
    }

    const supersededMemory = memory.supersedes_id
      ? await getMemory(memory.supersedes_id)
      : null;

    // Find the critic entity via agent FK
    const [criticEntity] = await sql<{ id: string }[]>`
      SELECT e.id FROM entities e
      JOIN agents a ON e.agent_id = a.id
      WHERE a.name = 'critic' AND e.active = TRUE
      LIMIT 1
    `;

    if (!criticEntity) {
      return res.status(503).json({ error: 'No critic entity available' });
    }

    const creature = await dispatchCreature({
      type: 'gate',
      tree_id,
      entity_id: criticEntity.id,
      intent: `Evaluate memory contradiction: "${memory.content.slice(0, 100)}" vs "${supersededMemory?.content?.slice(0, 100) ?? 'unknown'}"`,
      instructions: {
        action: 'resolve_contradiction',
        memory_id,
        new_content: memory.content,
        old_content: supersededMemory?.content,
        new_confidence: memory.confidence,
        old_confidence: supersededMemory?.confidence,
      },
    });

    return res.json({ success: true, creature_id: creature.id, status: 'dispatched' });

  } catch (error) {
    console.error('[memory:ask-critic] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/forest-memory/creature-write
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

/**
 * POST /api/forest-memory/arcs
 *
 * Body: { "action": "create"|"get"|"update"|"add_memory"|"list"|"for_memory", ...params }
 */
export async function arcsEndpoint(req: any, res: any, _bot: Bot) {
  try {
    const { action, ...params } = req.body;

    switch (action) {
      case 'create': {
        if (!params.name) return res.status(400).json({ error: 'Missing required field: name' });
        const arc = await createArc(params);
        return res.json({ success: true, arc });
      }
      case 'get': {
        if (!params.arc_id) return res.status(400).json({ error: 'Missing required field: arc_id' });
        const arc = await getArc(params.arc_id);
        if (!arc) return res.status(404).json({ error: 'Arc not found' });
        return res.json({ success: true, arc });
      }
      case 'update': {
        if (!params.arc_id) return res.status(400).json({ error: 'Missing required field: arc_id' });
        const { arc_id, ...opts } = params;
        const arc = await updateArc(arc_id, opts);
        return res.json({ success: true, arc });
      }
      case 'add_memory': {
        if (!params.arc_id || !params.memory_id) return res.status(400).json({ error: 'Missing required fields: arc_id, memory_id' });
        const arc = await addMemoryToArc(params.arc_id, params.memory_id);
        return res.json({ success: true, arc });
      }
      case 'list': {
        const arcs = await listArcs(params);
        return res.json({ success: true, count: arcs.length, arcs });
      }
      case 'for_memory': {
        if (!params.memory_id) return res.status(400).json({ error: 'Missing required field: memory_id' });
        const arcs = await getArcsForMemory(params.memory_id);
        return res.json({ success: true, count: arcs.length, arcs });
      }
      default:
        return res.status(400).json({ error: `Unknown arcs action: ${action}` });
    }
  } catch (error) {
    console.error('[memory:arcs] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
