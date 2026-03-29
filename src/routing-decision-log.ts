import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "./logger.ts";

const logger = log.child("routing-decision-log");

export interface RoutingDecision {
  id: string;
  session_id: string | null;
  dispatch_envelope_id: string | null;
  timestamp: string;
  user_message: string;
  agents_considered: string[];
  agent_chosen: string;
  confidence: number;
  match_type: string;
  reasoning: string;
  skills_loaded: string[];
}

interface ClassificationInput {
  agent_name: string;
  rule_name: string;
  confidence: number;
  reasoning?: string;
  skill_name?: string;
  skill_description?: string;
}

interface BuildOpts {
  classification: ClassificationInput;
  sessionId?: string | null;
  dispatchEnvelopeId?: string | null;
  userMessage: string;
  agentsConsidered: string[];
  skillsLoaded: string[];
}

let idCounter = 0;

function generateId(): string {
  const ts = Date.now().toString(36);
  const seq = (idCounter++).toString(36).padStart(2, "0");
  const rand = Math.random().toString(36).slice(2, 6);
  return `rd_${ts}${seq}${rand}`;
}

function truncate(text: string, max: number = 200): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}

export function generateReasoning(classification: ClassificationInput): string {
  const { rule_name, agent_name, skill_name, reasoning } = classification;

  if (reasoning) return reasoning;

  switch (rule_name) {
    case "slash_command":
      return `Explicit /${agent_name} command — direct route`;
    case "skill_trigger":
      return `Trigger matched ${skill_name ?? "unknown"} skill on ${agent_name} agent`;
    case "smart_pattern":
      return `Pattern match routed to ${agent_name} agent`;
    case "session_continuity":
      return `Continuing active session with ${agent_name} agent`;
    case "llm_classification":
      return `LLM classified as ${agent_name} task`;
    default:
      return `Routed to ${agent_name} via ${rule_name}`;
  }
}

export function buildRoutingDecision(opts: BuildOpts): RoutingDecision {
  const { classification, sessionId, dispatchEnvelopeId, userMessage, agentsConsidered, skillsLoaded } = opts;

  return {
    id: generateId(),
    session_id: sessionId ?? null,
    dispatch_envelope_id: dispatchEnvelopeId ?? null,
    timestamp: new Date().toISOString(),
    user_message: truncate(userMessage),
    agents_considered: agentsConsidered,
    agent_chosen: classification.agent_name,
    confidence: classification.confidence,
    match_type: classification.rule_name,
    reasoning: generateReasoning(classification),
    skills_loaded: skillsLoaded,
  };
}

/**
 * Log a routing decision to Supabase. Fire-and-forget — failures don't block dispatch.
 */
export async function logRoutingDecision(
  supabase: SupabaseClient,
  decision: RoutingDecision
): Promise<void> {
  try {
    const { error } = await supabase.from("routing_decisions").insert(decision);
    if (error) {
      logger.warn("Failed to log routing decision", { error: error.message, decision_id: decision.id });
    }
  } catch (err) {
    logger.warn("Routing decision log error", { error: (err as Error).message, decision_id: decision.id });
  }
}
