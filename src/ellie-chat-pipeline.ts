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
  const [convoContext, contextDocket, relevantContext, elasticContext, _structuredBase, forestContext, agentMemory, queueContext, liveForest, factsContext] = await Promise.all([
    convoId && supabase ? getConversationMessages(supabase, convoId) : Promise.resolve({ text: "", messageCount: 0, conversationId: "" }),
    shouldFetch("context-docket") ? getContextDocket() : Promise.resolve(""),
    getRelevantContext(supabase, effectiveText, "ellie-chat", activeAgent, convoId),
    searchElastic(effectiveText, { limit: 5, recencyBoost: true, channel: "ellie-chat", sourceAgent: activeAgent, excludeConversationId: convoId }),
    shouldFetch("structured-context") ? getAgentStructuredContext(supabase, activeAgent) : Promise.resolve(""),
    getForestContext(effectiveText),
    getAgentMemoryContext(activeAgent, workItemId, getMaxMemoriesForModel(agentDispatch?.agent.model)),
    shouldFetch("queue") && agentDispatch?.is_new ? getQueueContext(activeAgent) : Promise.resolve(""),
    getLiveForestContext(effectiveText),
    getRelevantFacts(supabase, effectiveText),  // ELLIE-967: Tier 2 fact retrieval
  ]);
  // ELLIE-967: Merge Tier 2 conversation facts into structured context
  const structuredContext = factsContext ? [_structuredBase, factsContext].filter(Boolean).join("\n\n") : _structuredBase;
  return { convoContext, contextDocket, relevantContext, elasticContext, structuredContext, forestContext, agentMemory, queueContext, liveForest };
}
