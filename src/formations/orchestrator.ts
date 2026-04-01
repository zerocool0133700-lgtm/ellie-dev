/**
 * Formation Orchestrator — ELLIE-675
 *
 * Integrates formations into the agent system. Handles:
 *   - Loading formation definitions from SKILL.md files
 *   - Building facilitator prompts with formation context
 *   - Dispatching to roster agents based on protocol type
 *   - Collecting and synthesizing agent outputs
 *   - Round limit enforcement and timeout handling
 *
 * All external dependencies (agent calls, DB, SKILL.md loading) are injectable.
 */

import { log } from "../logger.ts";
import { createFormationGrove } from "../forest-grove.ts";
import {
  parseFormation,
  validateFormation,
  type FormationSchema,
  type FormationFrontmatter,
  type AgentRole,
  type InteractionProtocol,
} from "../types/formation.ts";
import {
  startSession,
  postMessage,
  broadcast,
  advanceRound,
  completeSession,
  failSession,
  getSessionMessages,
  collectAndAggregateVotes,
  type ProtocolDeps,
  type InsertFormationSession,
} from "./protocol.ts";
import type { FormationMessage, FormationSession } from "../types/formation.ts";

const logger = log.child("formation-orchestrator");

// ── Injectable Dependencies ─────────────────────────────────────

/** Function that calls an agent and returns its response text. */
export type AgentCallFn = (
  agentName: string,
  prompt: string,
  opts?: { timeoutMs?: number; model?: string },
) => Promise<string>;

/** Function that loads a formation SKILL.md by slug name. */
export type FormationLoaderFn = (slug: string) => Promise<string | null>;

export interface OrchestratorDeps {
  protocolDeps: ProtocolDeps;
  callAgent: AgentCallFn;
  loadFormation: FormationLoaderFn;
}

// ── Configuration ───────────────────────────────────────────────

export interface OrchestratorConfig {
  /** Timeout per agent analysis call in ms. Default: 30000. */
  agentTimeoutMs: number;
  /** Timeout for facilitator synthesis call in ms. Default: 60000. */
  synthesisTimeoutMs: number;
  /** Max rounds for debate/consensus protocols. Default: 3. */
  maxRounds: number;
  /** Consensus threshold (0-1). Default: 0.5. */
  consensusThreshold: number;
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  agentTimeoutMs: 30_000,
  synthesisTimeoutMs: 60_000,
  maxRounds: 3,
  consensusThreshold: 0.5,
};

// ── Result Types ────────────────────────────────────────────────

export interface FormationInvocationResult {
  sessionId: string;
  formationName: string;
  /** The final synthesized output from the facilitator. */
  synthesis: string;
  /** Individual agent contributions. */
  agentOutputs: AgentOutput[];
  /** Total rounds executed. */
  roundsExecuted: number;
  /** Whether the formation completed successfully. */
  success: boolean;
  /** Error message if failed. */
  error?: string;
}

export interface AgentOutput {
  agent: string;
  role: string;
  content: string;
  roundNumber: number;
}

// ── Prompt Building ─────────────────────────────────────────────

/**
 * Build the prompt injected into an agent's context when participating in a formation.
 */
export function buildAgentFormationPrompt(
  agentRole: AgentRole,
  formation: FormationFrontmatter,
  userPrompt: string,
  previousMessages: FormationMessage[],
): string {
  const lines: string[] = [];

  lines.push(`<formation name="${formation.name}">`);
  lines.push(`<objective>${formation.description}</objective>`);
  lines.push(`<your-role agent="${agentRole.agent}" role="${agentRole.role}">`);
  lines.push(agentRole.responsibility);
  lines.push(`</your-role>`);

  // Include other agents for context
  const others = formation.agents.filter(a => a.agent !== agentRole.agent);
  if (others.length > 0) {
    lines.push(`<other-agents>`);
    for (const other of others) {
      lines.push(`  <agent name="${other.agent}" role="${other.role}">${other.responsibility}</agent>`);
    }
    lines.push(`</other-agents>`);
  }

  // Include previous messages for context
  if (previousMessages.length > 0) {
    lines.push(`<prior-discussion>`);
    for (const msg of previousMessages) {
      if (msg.message_type === "system") continue;
      lines.push(`  <message from="${msg.from_agent}" type="${msg.message_type}">${msg.content}</message>`);
    }
    lines.push(`</prior-discussion>`);
  }

  lines.push(`<user-prompt>${userPrompt}</user-prompt>`);
  lines.push(`</formation>`);

  return lines.join("\n");
}

/**
 * Build the facilitator's synthesis prompt — given all agent outputs, produce a final answer.
 */
export function buildSynthesisPrompt(
  formation: FormationFrontmatter,
  userPrompt: string,
  agentOutputs: AgentOutput[],
): string {
  const lines: string[] = [];

  lines.push(`<formation-synthesis name="${formation.name}">`);
  lines.push(`<objective>${formation.description}</objective>`);
  lines.push(`<original-prompt>${userPrompt}</original-prompt>`);
  lines.push(`<agent-contributions>`);

  for (const output of agentOutputs) {
    lines.push(`  <contribution agent="${output.agent}" role="${output.role}" round="${output.roundNumber}">`);
    lines.push(`    ${output.content}`);
    lines.push(`  </contribution>`);
  }

  lines.push(`</agent-contributions>`);
  lines.push(`<instructions>`);
  lines.push(`You are the facilitator for the "${formation.name}" formation.`);
  lines.push(`Synthesize the contributions from all agents into a single, coherent response.`);
  lines.push(`Highlight areas of agreement, note disagreements, and provide a clear recommendation.`);
  lines.push(`Do not simply concatenate — integrate and add value.`);
  lines.push(`</instructions>`);
  lines.push(`</formation-synthesis>`);

  return lines.join("\n");
}

// ── Core Orchestration ──────────────────────────────────────────

/**
 * Invoke a formation by slug name.
 *
 * Flow:
 *   1. Load and parse the formation SKILL.md
 *   2. Create a formation session
 *   3. Execute the protocol (fan-out, debate, pipeline, etc.)
 *   4. Have the facilitator synthesize the outputs
 *   5. Complete the session and return the result
 */
export async function invokeFormation(
  deps: OrchestratorDeps,
  slug: string,
  userPrompt: string,
  opts: {
    channel?: string;
    workItemId?: string;
    config?: Partial<OrchestratorConfig>;
  } = {},
): Promise<FormationInvocationResult> {
  const config = { ...DEFAULT_CONFIG, ...opts.config };

  // 1. Load formation
  const raw = await deps.loadFormation(slug);
  if (!raw) {
    return makeErrorResult(slug, `Formation "${slug}" not found`);
  }

  const schema = parseFormation(raw);
  if (!schema) {
    return makeErrorResult(slug, `Formation "${slug}" has invalid SKILL.md format`);
  }

  const validation = validateFormation(schema);
  if (!validation.valid) {
    const errorMsg = validation.errors.map(e => `${e.field}: ${e.message}`).join("; ");
    return makeErrorResult(slug, `Formation "${slug}" validation failed: ${errorMsg}`);
  }

  const fm = schema.frontmatter;

  // 2. Determine facilitator (coordinator or first agent)
  const facilitator = fm.protocol.coordinator ?? fm.agents[0]?.agent;
  if (!facilitator) {
    return makeErrorResult(slug, "No facilitator agent found");
  }

  // 3. Create session
  let session: FormationSession;
  try {
    session = await startSession(deps.protocolDeps, {
      formation_name: fm.name,
      initiator_agent: facilitator,
      participating_agents: fm.agents.map(a => a.agent),
      protocol: fm.protocol,
      channel: opts.channel ?? "internal",
      work_item_id: opts.workItemId,
      metadata: { user_prompt: userPrompt },
    });
  } catch (err) {
    return makeErrorResult(slug, `Failed to create session: ${err instanceof Error ? err.message : String(err)}`);
  }

  logger.info("Formation invoked", { slug, sessionId: session.id, facilitator, agents: fm.agents.map(a => a.agent) });

  // 3b. ELLIE-818: Auto-create grove for this formation
  try {
    const grove = await createFormationGrove(
      slug,
      session.id,
      fm.agents.map(a => a.agent),
    );
    if (grove) {
      logger.info("Formation grove created", { slug, groveId: grove.id, scopePath: grove.scope_path });
    }
  } catch (err) {
    // Non-fatal — grove creation failure shouldn't block formation execution
    logger.warn("Formation grove creation failed (non-fatal)", { slug, error: err instanceof Error ? err.message : String(err) });
  }

  // 4. Execute protocol
  try {
    const result = await executeProtocol(deps, session, schema, userPrompt, config);
    return result;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await failSession(deps.protocolDeps, session.id, errorMsg).catch((failErr) => {
      logger.error("Formation cleanup failed — session may be in limbo", {
        sessionId: session.id,
        formation: fm.name,
        originalError: errorMsg,
        cleanupError: failErr instanceof Error ? failErr.message : String(failErr),
      });
    });
    return {
      sessionId: session.id,
      formationName: fm.name,
      synthesis: "",
      agentOutputs: [],
      roundsExecuted: 0,
      success: false,
      error: errorMsg,
    };
  }
}

/**
 * Execute the formation protocol based on its pattern type.
 */
async function executeProtocol(
  deps: OrchestratorDeps,
  session: FormationSession,
  schema: FormationSchema,
  userPrompt: string,
  config: OrchestratorConfig,
): Promise<FormationInvocationResult> {
  const fm = schema.frontmatter;
  const pattern = fm.protocol.pattern;

  switch (pattern) {
    case "coordinator":
    case "free-form":
    case "round-robin":
      return executeFanOutProtocol(deps, session, fm, userPrompt, config);

    case "debate":
      return executeDebateProtocol(deps, session, fm, userPrompt, config);

    case "pipeline":
      return executePipelineProtocol(deps, session, fm, userPrompt, config);

    default:
      return executeFanOutProtocol(deps, session, fm, userPrompt, config);
  }
}

/**
 * Fan-out protocol: broadcast prompt to all agents, collect responses, synthesize.
 * Used for coordinator, free-form, and round-robin patterns.
 */
async function executeFanOutProtocol(
  deps: OrchestratorDeps,
  session: FormationSession,
  fm: FormationFrontmatter,
  userPrompt: string,
  config: OrchestratorConfig,
): Promise<FormationInvocationResult> {
  const facilitator = fm.protocol.coordinator ?? fm.agents[0]?.agent ?? "general";
  const rosterAgents = fm.agents.filter(a => a.agent !== facilitator);
  const agentOutputs: AgentOutput[] = [];

  // Dispatch to all roster agents in parallel
  const agentPromises = rosterAgents.map(async (agentRole) => {
    const prompt = buildAgentFormationPrompt(agentRole, fm, userPrompt, []);
    try {
      const response = await deps.callAgent(agentRole.agent, prompt, {
        timeoutMs: config.agentTimeoutMs,
        model: agentRole.model,
      });

      await postMessage(deps.protocolDeps, session.id, agentRole.agent, response, {
        messageType: "response",
      });

      return {
        agent: agentRole.agent,
        role: agentRole.role,
        content: response,
        roundNumber: 0,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.warn(`Agent ${agentRole.agent} failed`, { error: errorMsg });

      await postMessage(deps.protocolDeps, session.id, agentRole.agent, `[Error: ${errorMsg}]`, {
        messageType: "response",
        metadata: { error: true },
      });

      return {
        agent: agentRole.agent,
        role: agentRole.role,
        content: `[Agent error: ${errorMsg}]`,
        roundNumber: 0,
      };
    }
  });

  const results = await Promise.all(agentPromises);
  agentOutputs.push(...results);

  // Advance round
  await advanceRound(deps.protocolDeps, session.id);

  // Check if all agents failed
  const allAgentsFailed = agentOutputs.length > 0 && agentOutputs.every(o => o.content.startsWith("[Agent error:"));

  // Facilitator synthesizes
  const synthesis = await synthesize(deps, session, fm, userPrompt, agentOutputs, config);

  // Complete session
  await completeSession(deps.protocolDeps, session.id, { summary: synthesis.slice(0, 500) });

  return {
    sessionId: session.id,
    formationName: fm.name,
    synthesis,
    agentOutputs,
    roundsExecuted: 1,
    success: !allAgentsFailed,
  };
}

/**
 * Debate protocol: agents alternate for multiple rounds, then synthesize.
 */
async function executeDebateProtocol(
  deps: OrchestratorDeps,
  session: FormationSession,
  fm: FormationFrontmatter,
  userPrompt: string,
  config: OrchestratorConfig,
): Promise<FormationInvocationResult> {
  const maxRounds = Math.min(config.maxRounds, fm.protocol.maxTurns > 0 ? fm.protocol.maxTurns : config.maxRounds);
  const agentOutputs: AgentOutput[] = [];
  const facilitator = fm.protocol.coordinator ?? fm.agents[0]?.agent ?? "general";

  for (let round = 0; round < maxRounds; round++) {
    const previousMessages = await getSessionMessages(deps.protocolDeps, session.id);

    // Each agent responds in turn
    for (const agentRole of fm.agents) {
      if (agentRole.agent === facilitator && fm.agents.length > 1) continue; // facilitator synthesizes at end

      const prompt = buildAgentFormationPrompt(agentRole, fm, userPrompt, previousMessages);

      try {
        const response = await deps.callAgent(agentRole.agent, prompt, {
          timeoutMs: config.agentTimeoutMs,
          model: agentRole.model,
        });

        await postMessage(deps.protocolDeps, session.id, agentRole.agent, response, {
          messageType: round === 0 ? "proposal" : "response",
        });

        agentOutputs.push({
          agent: agentRole.agent,
          role: agentRole.role,
          content: response,
          roundNumber: round,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.warn(`Agent ${agentRole.agent} failed in debate round ${round}`, { error: errorMsg });

        agentOutputs.push({
          agent: agentRole.agent,
          role: agentRole.role,
          content: `[Agent error: ${errorMsg}]`,
          roundNumber: round,
        });
      }
    }

    await advanceRound(deps.protocolDeps, session.id);
  }

  // Check if all agents failed
  const allAgentsFailed = agentOutputs.length > 0 && agentOutputs.every(o => o.content.startsWith("[Agent error:"));

  // Facilitator synthesizes
  const synthesis = await synthesize(deps, session, fm, userPrompt, agentOutputs, config);

  await completeSession(deps.protocolDeps, session.id, { summary: synthesis.slice(0, 500) });

  return {
    sessionId: session.id,
    formationName: fm.name,
    synthesis,
    agentOutputs,
    roundsExecuted: maxRounds,
    success: !allAgentsFailed,
  };
}

/**
 * Pipeline protocol: agents execute sequentially, each building on the previous.
 */
async function executePipelineProtocol(
  deps: OrchestratorDeps,
  session: FormationSession,
  fm: FormationFrontmatter,
  userPrompt: string,
  config: OrchestratorConfig,
): Promise<FormationInvocationResult> {
  const turnOrder = fm.protocol.turnOrder ?? fm.agents.map(a => a.agent);
  const agentOutputs: AgentOutput[] = [];
  const agentMap = new Map(fm.agents.map(a => [a.agent, a]));

  for (let i = 0; i < turnOrder.length; i++) {
    const agentName = turnOrder[i];
    const agentRole = agentMap.get(agentName);
    if (!agentRole) continue;

    const previousMessages = await getSessionMessages(deps.protocolDeps, session.id);
    const prompt = buildAgentFormationPrompt(agentRole, fm, userPrompt, previousMessages);

    try {
      const response = await deps.callAgent(agentRole.agent, prompt, {
        timeoutMs: config.agentTimeoutMs,
        model: agentRole.model,
      });

      await postMessage(deps.protocolDeps, session.id, agentRole.agent, response, {
        messageType: i === 0 ? "proposal" : "response",
      });

      agentOutputs.push({
        agent: agentRole.agent,
        role: agentRole.role,
        content: response,
        roundNumber: i,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.warn(`Pipeline agent ${agentRole.agent} failed`, { error: errorMsg });

      agentOutputs.push({
        agent: agentRole.agent,
        role: agentRole.role,
        content: `[Agent error: ${errorMsg}]`,
        roundNumber: i,
      });
    }

    if (i < turnOrder.length - 1) {
      await advanceRound(deps.protocolDeps, session.id);
    }
  }

  // Check if all agents failed
  const allAgentsFailed = agentOutputs.length > 0 && agentOutputs.every(o => o.content.startsWith("[Agent error:"));

  // Final agent's output can be the synthesis, or facilitator synthesizes
  const facilitator = fm.protocol.coordinator;
  let synthesis: string;

  if (facilitator && !turnOrder.includes(facilitator)) {
    // Facilitator is separate from the pipeline — synthesize
    synthesis = await synthesize(deps, session, fm, userPrompt, agentOutputs, config);
  } else {
    // Last agent's output is the final result
    const lastOutput = agentOutputs[agentOutputs.length - 1];
    synthesis = lastOutput?.content ?? "";
  }

  await completeSession(deps.protocolDeps, session.id, { summary: synthesis.slice(0, 500) });

  return {
    sessionId: session.id,
    formationName: fm.name,
    synthesis,
    agentOutputs,
    roundsExecuted: turnOrder.length,
    success: !allAgentsFailed,
  };
}

// ── Synthesis ───────────────────────────────────────────────────

/**
 * Have the facilitator synthesize all agent outputs into a final response.
 */
async function synthesize(
  deps: OrchestratorDeps,
  session: FormationSession,
  fm: FormationFrontmatter,
  userPrompt: string,
  agentOutputs: AgentOutput[],
  config: OrchestratorConfig,
): string | Promise<string> {
  const facilitator = fm.protocol.coordinator ?? fm.agents[0]?.agent ?? "general";
  const prompt = buildSynthesisPrompt(fm, userPrompt, agentOutputs);

  try {
    const synthesis = await deps.callAgent(facilitator, prompt, {
      timeoutMs: config.synthesisTimeoutMs,
    });

    await postMessage(deps.protocolDeps, session.id, facilitator, synthesis, {
      messageType: "decision",
      metadata: { synthesis: true },
    });

    return synthesis;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("Synthesis failed", { facilitator, error: errorMsg });

    // Fallback: concatenate agent outputs
    const fallback = agentOutputs
      .map(o => `**${o.agent}** (${o.role}):\n${o.content}`)
      .join("\n\n---\n\n");

    await postMessage(deps.protocolDeps, session.id, "system", `Synthesis failed: ${errorMsg}. Showing raw outputs.`, {
      messageType: "system",
    });

    return fallback;
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function makeErrorResult(slug: string, error: string): FormationInvocationResult {
  return {
    sessionId: "",
    formationName: slug,
    synthesis: "",
    agentOutputs: [],
    roundsExecuted: 0,
    success: false,
    error,
  };
}

// ── Testing Helpers ─────────────────────────────────────────────

/**
 * Create a mock agent call function that returns canned responses.
 * Each agent gets a deterministic response based on their name.
 */
export function _makeMockAgentCallFn(
  responses?: Record<string, string>,
): AgentCallFn {
  return async (agentName: string, prompt: string) => {
    if (responses && responses[agentName]) {
      return responses[agentName];
    }
    return `[${agentName}] Analysis of the prompt: This is a well-structured question that requires careful consideration.`;
  };
}

/**
 * Create a mock agent call function that fails for specific agents.
 */
export function _makeMockAgentCallFnWithErrors(
  errorAgents: string[],
  responses?: Record<string, string>,
): AgentCallFn {
  return async (agentName: string) => {
    if (errorAgents.includes(agentName)) {
      throw new Error(`Agent ${agentName} timed out`);
    }
    if (responses && responses[agentName]) {
      return responses[agentName];
    }
    return `[${agentName}] Default response.`;
  };
}

/**
 * Create a mock formation loader that returns SKILL.md content by slug.
 */
export function _makeMockFormationLoader(
  formations?: Record<string, string>,
): FormationLoaderFn {
  return async (slug: string) => {
    if (formations && formations[slug]) {
      return formations[slug];
    }
    return null;
  };
}

/**
 * Build a complete mock formation SKILL.md string for testing.
 */
export function _makeMockFormationSkillMd(opts: {
  name?: string;
  description?: string;
  agents?: AgentRole[];
  protocol?: InteractionProtocol;
} = {}): string {
  const name = opts.name ?? "test-formation";
  const description = opts.description ?? "A test formation";
  const agents = opts.agents ?? [
    { agent: "dev", role: "lead", responsibility: "Write code" },
    { agent: "critic", role: "reviewer", responsibility: "Review code" },
  ];
  const protocol = opts.protocol ?? {
    pattern: "coordinator" as const,
    maxTurns: 10,
    coordinator: "dev",
    requiresApproval: false,
  };

  return `---
name: ${name}
description: ${description}
agents: ${JSON.stringify(agents)}
protocol: ${JSON.stringify(protocol)}
---

## Objective

${description}

## Agent Roles

${agents.map(a => `- **${a.agent}** (${a.role}): ${a.responsibility}`).join("\n")}

## Interaction Flow

1. Agents analyze the prompt
2. Each agent contributes their perspective
3. Facilitator synthesizes the outputs
`;
}
