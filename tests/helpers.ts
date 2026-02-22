/**
 * Shared test utilities for orchestrator + classifier tests.
 */
import { mock } from "bun:test";
import type { DispatchResult, AgentConfig } from "../src/agent-router.ts";
import type { OrchestratorOptions, PipelineStep } from "../src/orchestrator.ts";

// ── Mock Dispatch Result ──────────────────────────────────────

export function createMockDispatchResult(overrides?: Partial<DispatchResult>): DispatchResult {
  return {
    session_id: "test-session-id",
    agent: {
      name: "general",
      type: "generalist",
      system_prompt: "You are a helpful assistant.",
      model: null,
      tools_enabled: [],
      capabilities: ["general"],
    },
    is_new: true,
    ...overrides,
  };
}

// ── Mock Supabase ─────────────────────────────────────────────

export function createMockSupabase(tableOverrides?: Record<string, any>) {
  const tableData: Record<string, any> = {
    execution_plans: { id: "test-plan-id" },
    skills: [
      { name: "writing", complexity: "light" },
      { name: "editing", complexity: "light" },
      { name: "critical_review", complexity: "light" },
      { name: "web_research", complexity: "heavy" },
      { name: "calendar_management", complexity: "heavy" },
      { name: "email_management", complexity: "heavy" },
    ],
    models: [
      { model_id: "claude-haiku-4-5-20251001", cost_input_mtok: 0.80, cost_output_mtok: 4.0 },
      { model_id: "claude-sonnet-4-5-20250929", cost_input_mtok: 3.0, cost_output_mtok: 15.0 },
      { model_id: "claude-opus-4-6", cost_input_mtok: 15.0, cost_output_mtok: 75.0 },
    ],
    ...tableOverrides,
  };

  function createChain(table: string) {
    const resolvedData = tableData[table] ?? null;
    const promise = Promise.resolve({ data: resolvedData, error: null });
    const chain: any = {};
    for (const method of ["insert", "update", "select", "eq", "order", "limit", "neq", "in"]) {
      chain[method] = (..._args: any[]) => chain;
    }
    chain.single = () => promise;
    chain.then = (resolve: Function, reject?: Function) => promise.then(resolve, reject);
    chain.catch = (reject: Function) => promise.catch(reject);
    return chain;
  }

  return {
    from: mock((table: string) => createChain(table)),
    functions: {
      invoke: mock(() => Promise.resolve({ data: null, error: null })),
    },
  } as any;
}

// ── Mock Anthropic ────────────────────────────────────────────

export function createMockAnthropic(responseText: string = "Mock response") {
  return {
    messages: {
      create: mock(() =>
        Promise.resolve({
          content: [{ type: "text", text: responseText }],
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
      ),
    },
  } as any;
}

// ── Mock OrchestratorOptions ──────────────────────────────────

export function createMockOptions(overrides?: Partial<OrchestratorOptions>): OrchestratorOptions {
  const supabase = createMockSupabase();
  const anthropicClient = createMockAnthropic();

  return {
    supabase,
    channel: "telegram",
    userId: "test-user-id",
    onHeartbeat: mock(() => {}),
    conversationId: "test-conversation-id",
    anthropicClient,
    buildPromptFn: mock((..._args: any[]) => "Built prompt"),
    callClaudeFn: mock((..._args: any[]) => Promise.resolve("Claude CLI response")),
    ...overrides,
  };
}

// ── Pipeline Step Factory ─────────────────────────────────────

export function createStep(overrides?: Partial<PipelineStep>): PipelineStep {
  return {
    agent_name: "general",
    skill_name: "writing",
    instruction: "Do something",
    ...overrides,
  };
}
