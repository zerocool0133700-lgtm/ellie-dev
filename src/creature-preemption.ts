/**
 * ELLIE-499: Creature Preemption
 *
 * Detects orphaned creatures (agent process gone, creature still active)
 * and cleans up associated resources:
 *   1. Fails the creature with reason 'preempted'
 *   2. Emits creature.preempted event
 *   3. Marks work session tree incomplete (if all creatures terminal)
 *   4. Rolls back Plane ticket to Todo
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "./logger.ts";

const logger = log.child("preemption");

/** Grace period — don't preempt creatures younger than this (ms). */
const PREEMPTION_GRACE_MS = 2 * 60_000; // 2 minutes

export interface PreemptionResult {
  creature_id: string;
  tree_id: string;
  work_item_id: string | null;
  action: "preempted";
  reason: string;
}

export interface ReapedCreature {
  creature_id: string;
  tree_id: string;
  action: string;
}

/**
 * Detect and preempt orphaned creatures.
 *
 * An orphan is a creature in dispatched/working state whose agent no longer
 * has an active session in Supabase. If no matching session exists and the
 * creature has been active for > PREEMPTION_GRACE_MS, it's preempted.
 */
export async function reapPreemptedCreatures(
  supabase: SupabaseClient | null,
): Promise<PreemptionResult[]> {
  if (!supabase) return [];

  // Dynamic imports to avoid circular deps at module load
  const { getActiveCreatures, failCreature } = await import("../../ellie-forest/src/creatures");
  const { emitEvent } = await import("../../ellie-forest/src/events");
  const { getAgentForEntity } = await import("../../ellie-forest/src/agents");

  // 1. Get all active creatures from Forest
  const active = await getActiveCreatures();
  if (active.length === 0) return [];

  // 2. Get all active agent sessions from Supabase
  const { data: activeSessions } = await supabase
    .from("agent_sessions")
    .select("id, agent_id, state, work_item_id")
    .eq("state", "active");

  const sessionAgentIds = new Set((activeSessions || []).map((s: { agent_id: string }) => s.agent_id));

  // 3. Cross-reference: creatures whose agent has no active session
  const now = Date.now();
  const results: PreemptionResult[] = [];

  for (const creature of active) {
    // Skip creatures within grace period
    const creatureAge = now - new Date(creature.dispatched_at || creature.created_at).getTime();
    if (creatureAge < PREEMPTION_GRACE_MS) continue;

    // Look up the agent for this creature's entity
    const agent = await getAgentForEntity(creature.entity_id);
    if (!agent) continue; // Can't determine agent — skip

    // If agent has an active session, creature is not orphaned
    if (sessionAgentIds.has(agent.id)) continue;

    // Orphaned — preempt it
    const reason = `preempted: agent ${agent.name} session inactive (creature age: ${Math.round(creatureAge / 1000)}s)`;

    try {
      await failCreature(creature.id, reason);

      await emitEvent({
        kind: "creature.preempted",
        tree_id: creature.tree_id,
        entity_id: creature.entity_id,
        creature_id: creature.id,
        summary: `Creature preempted: ${reason}`,
        data: {
          agent_name: agent.name,
          creature_state: creature.state,
          creature_age_ms: creatureAge,
        },
      });

      results.push({
        creature_id: creature.id,
        tree_id: creature.tree_id,
        work_item_id: null, // filled by getWorkItemForTree below
        action: "preempted",
        reason,
      });

      logger.info("Creature preempted", {
        creature_id: creature.id,
        agent: agent.name,
        state: creature.state,
        age_s: Math.round(creatureAge / 1000),
      });
    } catch (err) {
      // Creature may have transitioned since we checked — non-fatal
      logger.warn("Failed to preempt creature", {
        creature_id: creature.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

/**
 * Post-reap cleanup: for every reaped creature, check if all creatures
 * in the tree are now terminal. If so, clean up the work session and
 * roll back the Plane ticket.
 *
 * Called after any reaping action (timeout, exhausted, preempted).
 */
export async function cleanupReapedCreatures(
  reaped: ReapedCreature[],
): Promise<{ sessionsCleanedUp: number; planeRolledBack: number }> {
  if (reaped.length === 0) return { sessionsCleanedUp: 0, planeRolledBack: 0 };

  const sql = (await import("../../ellie-forest/src/db")).default;

  let sessionsCleanedUp = 0;
  let planeRolledBack = 0;

  // Deduplicate by tree_id — multiple creatures may share a tree
  const treeIds = [...new Set(reaped.map((r) => r.tree_id))];

  for (const treeId of treeIds) {
    try {
      // Check if tree is a work_session and still active
      const [tree] = await sql<{ id: string; type: string; state: string; work_item_id: string | null }[]>`
        SELECT id, type, state, work_item_id FROM trees
        WHERE id = ${treeId}
      `;
      if (!tree || tree.type !== "work_session") continue;
      if (["dormant", "archived", "composted"].includes(tree.state)) continue;

      // Check if ALL creatures in this tree are now in terminal state
      const [remaining] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM creatures
        WHERE tree_id = ${treeId} AND state IN ('pending', 'dispatched', 'working')
      `;
      if (Number(remaining.count) > 0) continue;

      // All creatures terminal — mark work session as dormant
      await sql`
        UPDATE trees SET state = 'dormant', last_activity = NOW()
        WHERE id = ${treeId} AND state NOT IN ('dormant', 'archived', 'composted')
      `;
      await sql`
        INSERT INTO forest_events (kind, tree_id, summary)
        VALUES ('tree.state_changed', ${treeId}, 'Work session marked dormant — all creatures failed/preempted')
      `;
      sessionsCleanedUp++;

      logger.info("Work session cleaned up after creature failure", {
        tree_id: treeId,
        work_item_id: tree.work_item_id,
      });

      // Roll back Plane ticket to Todo
      if (tree.work_item_id) {
        try {
          const { updateWorkItemOnFailure } = await import("./plane.ts");
          const failedCreatures = reaped.filter((r) => r.tree_id === treeId);
          const reasons = failedCreatures.map((r) => r.action).join(", ");
          await updateWorkItemOnFailure(
            tree.work_item_id,
            `All creatures failed (${reasons}) — ticket rolled back to Todo`,
          );
          planeRolledBack++;

          logger.info("Plane ticket rolled back", {
            work_item_id: tree.work_item_id,
            reasons,
          });
        } catch (planeErr) {
          logger.warn("Plane rollback failed (non-fatal)", {
            work_item_id: tree.work_item_id,
            error: planeErr instanceof Error ? planeErr.message : String(planeErr),
          });
        }
      }
    } catch (err) {
      logger.warn("Cleanup failed for tree", {
        tree_id: treeId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { sessionsCleanedUp, planeRolledBack };
}
