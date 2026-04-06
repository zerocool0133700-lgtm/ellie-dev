/**
 * Ellie Chat Pipeline Helpers — ELLIE-498
 *
 * Shared, independently-testable pipeline steps extracted from
 * _handleEllieChatMessage and runSpecialistAsync in ellie-chat-handler.ts.
 *
 * Exported with _ prefix for unit testability (same convention as
 * _withQueueTimeout in message-queue.ts, _settledValues in context-sources.ts).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { processMessageMode, getModeSectionPriorities } from "./context-mode.ts";
import { getCreatureProfile } from "./creature-profile.ts";
import { getConversationMessages } from "./conversations.ts";
import { getContextDocket } from "./relay-config.ts";
import { getRelevantContext, getRelevantFacts } from "./memory.ts";
import { searchElastic } from "./elasticsearch.ts";
import {
  getAgentStructuredContext,
  getAgentMemoryContext,
  getMaxMemoriesForModel,
  getLiveForestContext,
  getRelatedKnowledge,
  getScopedForestContext,   // NEW: Phase 3
  getGroveKnowledgeContext, // NEW: Phase 3 Task 7
  resolveAgentScope,        // NEW: Phase 3
} from "./context-sources.ts";
import { getForestContext } from "./elasticsearch/context.ts";
import { getQueueContext } from "./api/agent-queue.ts";

// ── resolveContextMode ────────────────────────────────────────

/**
 * Resolve context mode from channel profile (priority) or regex detection.
 * Channel profile always wins — skips processMessageMode entirely when set.
 * Exported with _ prefix for unit testing (ELLIE-498).
 */
export function _resolveContextMode(
  convoKey: string,
  effectiveText: string,
  channelProfile: import("./api/mode-profile.ts").ChannelContextProfile | null | undefined,
): { contextMode: import("./context-mode.ts").ContextMode; modeChanged: boolean } {
  if (channelProfile) {
    return { contextMode: channelProfile.contextMode, modeChanged: false };
  }
  const detection = processMessageMode(convoKey, effectiveText);
  return { contextMode: detection.mode, modeChanged: detection.changed };
}

// ── buildShouldFetch ──────────────────────────────────────────

/**
 * Build a shouldFetch predicate respecting creature + mode section priorities.
 * Returns false (suppress) for labels with priority >= 7.
 * Creature profile overrides mode priorities when present.
 * Exported with _ prefix for unit testing (ELLIE-498).
 */
export function _buildShouldFetch(
  contextMode: import("./context-mode.ts").ContextMode,
  activeAgent: string,
): (label: string) => boolean {
  const modePriorities = getModeSectionPriorities(contextMode);
  const creatureProfile = getCreatureProfile(activeAgent);
  return (label: string): boolean => {
    const creaturePrio = creatureProfile?.section_priorities?.[label];
    if (creaturePrio !== undefined) return creaturePrio < 7;
    return (modePriorities[label] ?? 0) < 7;
  };
}

// ── gatherContextSources ──────────────────────────────────────

/**
 * Fetch all 9 context sources in parallel.
 * Shared between the normal single-agent path and runSpecialistAsync.
 * Exported with _ prefix for unit testing (ELLIE-498).
 */
export async function _gatherContextSources(
  supabase: SupabaseClient | null,
  convoId: string | undefined,
  effectiveText: string,
  activeAgent: string,
  agentDispatch: { is_new: boolean; agent: { model?: string | null } } | null,
  workItemId: string | undefined,
  shouldFetch: (label: string) => boolean,
) {
  const [convoContext, contextDocket, relevantContext, elasticContext, _structuredBase, forestContext, agentMemory, queueContext, liveForest, factsContext, relatedKnowledge, scopedForest, groveKnowledge] = await Promise.all([
    convoId && supabase ? getConversationMessages(supabase, convoId) : Promise.resolve({ text: "", messageCount: 0, conversationId: "" }),
    shouldFetch("context-docket") ? getContextDocket() : Promise.resolve(""),
    getRelevantContext(supabase, effectiveText, "ellie-chat", activeAgent, convoId),
    searchElastic(effectiveText, { limit: 5, recencyBoost: true, channel: "ellie-chat", sourceAgent: activeAgent, excludeConversationId: convoId, scope_path: resolveAgentScope(activeAgent) }),
    shouldFetch("structured-context") ? getAgentStructuredContext(supabase, activeAgent) : Promise.resolve(""),
    getForestContext(effectiveText),
    getAgentMemoryContext(activeAgent, workItemId, getMaxMemoriesForModel(agentDispatch?.agent.model)),
    shouldFetch("queue") && agentDispatch?.is_new ? getQueueContext(activeAgent) : Promise.resolve(""),
    getLiveForestContext(effectiveText),
    getRelevantFacts(supabase, effectiveText),  // ELLIE-967: Tier 2 fact retrieval
    getRelatedKnowledge(effectiveText, { limit: 5 }),  // ELLIE-1428 Phase 2: semantic edge context
    getScopedForestContext(effectiveText, activeAgent, { limit: 8, workItemId: workItemId }),  // ELLIE-1428 Phase 3: scoped Forest context
    getGroveKnowledgeContext(effectiveText, activeAgent, { limit: 5 }),  // ELLIE-1428 Phase 3
  ]);
  // ELLIE-967: Merge Tier 2 conversation facts into structured context
  const structuredContext = factsContext ? [_structuredBase, factsContext].filter(Boolean).join("\n\n") : _structuredBase;

  // ELLIE-1428 Phase 2: Merge semantic edge context
  const mergedStructuredContext = relatedKnowledge
    ? [structuredContext, relatedKnowledge].filter(Boolean).join("\n\n")
    : structuredContext;

  // ELLIE-1428 Phase 3: Merge scoped Forest knowledge
  const scopedForestContext = scopedForest
    ? [mergedStructuredContext, scopedForest].filter(Boolean).join("\n\n")
    : mergedStructuredContext;

  // ELLIE-1428 Phase 3: Merge grove shared knowledge
  const finalStructuredContext = groveKnowledge
    ? [scopedForestContext, groveKnowledge].filter(Boolean).join("\n\n")
    : scopedForestContext;

  // ELLIE-1401: Log context build breakdown for coordinator path
  const contextSections = [
    { label: "conversation-history", present: !!convoContext.text, chars: convoContext.text?.length || 0 },
    { label: "context-docket", present: !!contextDocket, chars: (contextDocket as string)?.length || 0 },
    { label: "relevant-context", present: !!relevantContext, chars: (relevantContext as string)?.length || 0 },
    { label: "elastic-context", present: !!elasticContext, chars: (elasticContext as string)?.length || 0 },
    { label: "structured-context", present: !!structuredContext, chars: (structuredContext as string)?.length || 0 },
    { label: "forest-context", present: !!forestContext, chars: (forestContext as string)?.length || 0 },
    { label: "agent-memory", present: !!agentMemory?.memoryContext, chars: agentMemory?.memoryContext?.length || 0 },
    { label: "queue-context", present: !!queueContext, chars: (queueContext as string)?.length || 0 },
    { label: "live-forest", present: !!liveForest?.awareness, chars: liveForest?.awareness?.length || 0 },
    { label: "related-knowledge", present: !!relatedKnowledge, chars: (relatedKnowledge as string)?.length || 0 },
    { label: "scoped-forest", present: !!scopedForest, chars: (scopedForest as string)?.length || 0 },
    { label: "grove-knowledge", present: !!groveKnowledge, chars: (groveKnowledge as string)?.length || 0 },
  ];
  const { log } = await import("./logger.ts");
  const pipelineLogger = log.child("context-build");
  pipelineLogger.info("Coordinator context build", {
    conversationId: convoId,
    agent: activeAgent,
    messageCount: convoContext.messageCount,
    included: contextSections.filter(s => s.present).map(s => s.label),
    skipped: contextSections.filter(s => !s.present).map(s => s.label),
    sectionSizes: Object.fromEntries(contextSections.map(s => [s.label, s.chars])),
    totalContextChars: contextSections.reduce((sum, s) => sum + s.chars, 0),
  });

  return { convoContext, contextDocket, relevantContext, elasticContext, structuredContext: finalStructuredContext, forestContext, agentMemory, queueContext, liveForest };
}

// ── Layered Prompt Pipeline (feature-flagged) ───────────────
// Replaces _gatherContextSources when LAYERED_PROMPT=true
// See: docs/superpowers/specs/2026-04-06-layered-prompt-architecture-design.md

import { buildLayeredContext } from "./prompt-layers/index";
import type { LayeredPromptResult } from "./prompt-layers/types";

/**
 * Layered alternative to _gatherContextSources().
 * Returns structured layers instead of a flat context bag.
 */
export async function gatherLayeredContext(
  message: string | null,
  channel: string | null,
  agent: string,
  supabase: any,
): Promise<LayeredPromptResult> {
  return buildLayeredContext(message, channel, agent, supabase);
}
