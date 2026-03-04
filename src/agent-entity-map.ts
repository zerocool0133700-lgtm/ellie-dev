/**
 * Canonical mapping from agent short names to forest entity names.
 *
 * Single source of truth — imported by context-sources, work-session,
 * ellie-chat-handler, and telegram-handlers. Add new agents here.
 *
 * @see ELLIE-493
 */
export const AGENT_ENTITY_MAP: Record<string, string> = {
  dev: 'dev_agent',
  research: 'research_agent',
  critic: 'critic_agent',
  content: 'content_agent',
  finance: 'finance_agent',
  strategy: 'strategy_agent',
  general: 'general_agent',
  router: 'agent_router',
  ops: 'ops_agent',
};

/** Resolve an agent name to its forest entity name, falling back to the name itself. */
export function resolveEntityName(agentName: string): string {
  return AGENT_ENTITY_MAP[agentName] ?? agentName;
}
