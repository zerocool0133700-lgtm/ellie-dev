/**
 * Decision Consistency Checking — ELLIE-1070
 * Track decisions across conversations. Flag contradictions.
 * Inspired by Minutes `minutes consistency` command.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "./logger.ts";

const logger = log.child("decision-consistency");

const STALE_DECISION_DAYS = 90; // Decisions older than 90 days without reaffirmation

export interface TrackedDecision {
  id: string;
  text: string;
  topic: string;
  person_context: string | null;
  source_conversation_id: string | null;
  created_at: string;
}

export interface ConsistencyReport {
  totalDecisions: number;
  contradictions: Array<{
    decisionA: TrackedDecision;
    decisionB: TrackedDecision;
    topic: string;
    reason: string;
  }>;
  staleDecisions: TrackedDecision[];
  healthy: boolean;
}

// In-memory decision store (can be persisted to Supabase later)
const decisions: TrackedDecision[] = [];
let idCounter = 0;

/**
 * Record a new decision.
 */
export function recordDecision(opts: {
  text: string;
  topic: string;
  personContext?: string;
  sourceConversationId?: string;
}): TrackedDecision {
  const decision: TrackedDecision = {
    id: `dec_${++idCounter}`,
    text: opts.text,
    topic: opts.topic.toLowerCase(),
    person_context: opts.personContext ?? null,
    source_conversation_id: opts.sourceConversationId ?? null,
    created_at: new Date().toISOString(),
  };
  decisions.push(decision);
  return decision;
}

/**
 * Check for contradictions: same topic, different conclusions.
 */
export function checkContradictions(): ConsistencyReport["contradictions"] {
  const contradictions: ConsistencyReport["contradictions"] = [];
  const byTopic = new Map<string, TrackedDecision[]>();

  for (const d of decisions) {
    const existing = byTopic.get(d.topic) || [];
    existing.push(d);
    byTopic.set(d.topic, existing);
  }

  for (const [topic, topicDecisions] of byTopic) {
    if (topicDecisions.length < 2) continue;

    // Simple contradiction detection: different text for same topic
    for (let i = 0; i < topicDecisions.length - 1; i++) {
      for (let j = i + 1; j < topicDecisions.length; j++) {
        const a = topicDecisions[i];
        const b = topicDecisions[j];

        // Only flag as contradiction if texts are substantially DIFFERENT
        const similarity = textSimilarity(a.text, b.text);
        if (similarity < 0.5) {  // Less than 50% word overlap = likely contradiction
          contradictions.push({
            decisionA: a,
            decisionB: b,
            topic,
            reason: `Different conclusions on "${topic}" (similarity: ${Math.round(similarity * 100)}%)`,
          });
        }
      }
    }
  }

  return contradictions;
}

/**
 * Find stale decisions (>90 days, not reaffirmed).
 */
export function findStaleDecisions(): TrackedDecision[] {
  const threshold = Date.now() - STALE_DECISION_DAYS * 24 * 60 * 60_000;
  return decisions.filter(d => new Date(d.created_at).getTime() < threshold);
}

/**
 * Generate full consistency report.
 */
export function generateConsistencyReport(): ConsistencyReport {
  const contradictions = checkContradictions();
  const stale = findStaleDecisions();

  return {
    totalDecisions: decisions.length,
    contradictions,
    staleDecisions: stale,
    healthy: contradictions.length === 0 && stale.length === 0,
  };
}

/**
 * Get all decisions for a topic.
 */
export function getDecisionsByTopic(topic: string): TrackedDecision[] {
  return decisions.filter(d => d.topic === topic.toLowerCase());
}

/**
 * Calculate simple text similarity (Jaccard on word sets).
 * Returns 0-1 where 1 = identical word sets.
 */
export function textSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  if (wordsA.size === 0 && wordsB.size === 0) return 1;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }

  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? intersection / union : 0;
}

/** Reset for testing */
export function _resetForTesting(): void {
  decisions.length = 0;
  idCounter = 0;
}

export { STALE_DECISION_DAYS };
