/**
 * ELLIE-62 — Classifier execution mode detection tests
 *
 * Covers: fan-out mode for multi-intent messages, critic-loop for writing tasks,
 * pipeline for sequential tasks, single as default, invalid mode fallback,
 * cross-domain override preserving execution mode.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mock Conversations (imported by classifier) ───────────────
mock.module("../src/conversations.ts", () => ({
  getConversationContext: mock(() => Promise.resolve(null)),
}));

import { initClassifier, classifyIntent } from "../src/intent-classifier.ts";

// ── Supabase Mock for Classifier ──────────────────────────────

function createClassifierSupabase() {
  const agents = [
    { name: "general", type: "generalist", capabilities: ["general"] },
    { name: "dev", type: "specialist", capabilities: ["coding"] },
    { name: "content", type: "specialist", capabilities: ["writing"] },
    { name: "research", type: "specialist", capabilities: ["research"] },
    { name: "critic", type: "specialist", capabilities: ["review"] },
  ];

  const skills = [
    { name: "writing", description: "Write content", agents: { name: "content" }, triggers: ["write"], priority: 1 },
    { name: "critical_review", description: "Review content", agents: { name: "critic" }, triggers: ["review"], priority: 1 },
    { name: "web_research", description: "Research topics", agents: { name: "research" }, triggers: ["research"], priority: 1 },
    { name: "calendar_management", description: "Manage calendar", agents: { name: "general" }, triggers: ["calendar"], priority: 1 },
    { name: "email_management", description: "Manage email", agents: { name: "general" }, triggers: ["email"], priority: 1 },
    { name: "code_changes", description: "Write code", agents: { name: "dev" }, triggers: ["code"], priority: 1 },
  ];

  function createChain(resolvedData: any) {
    const promise = Promise.resolve({ data: resolvedData, error: null });
    const chain: any = {};
    for (const m of ["select", "eq", "order", "limit", "insert", "update", "neq", "in"]) {
      chain[m] = (..._args: any[]) => chain;
    }
    chain.single = () =>
      Promise.resolve({ data: null, error: { code: "PGRST116" } }); // No active session
    chain.then = (resolve: Function, reject?: Function) =>
      promise.then(resolve, reject);
    chain.catch = (reject: Function) => promise.catch(reject);
    return chain;
  }

  return {
    from: mock((table: string) => {
      if (table === "agents") return createChain(agents);
      if (table === "skills") return createChain(skills);
      if (table === "agent_sessions") {
        const chain: any = {};
        for (const m of ["select", "eq", "order", "limit"]) {
          chain[m] = (..._args: any[]) => chain;
        }
        chain.single = () =>
          Promise.resolve({ data: null, error: { code: "PGRST116" } });
        return chain;
      }
      return createChain(null);
    }),
    functions: { invoke: mock(() => Promise.resolve({ data: null, error: null })) },
  } as any;
}

// ── Tests ─────────────────────────────────────────────────────

describe("Classifier Execution Mode Detection", () => {
  // ── Slash Commands ──────────────────────────────────────────

  describe("Slash commands always return single mode", () => {
    beforeEach(() => {
      initClassifier({ messages: { create: mock() } } as any, createClassifierSupabase());
    });

    test("/dev returns single mode", async () => {
      const result = await classifyIntent("/dev fix the bug", "telegram", "user1");
      expect(result.execution_mode).toBe("single");
      expect(result.agent_name).toBe("dev");
      expect(result.confidence).toBe(1.0);
    });

    test("/content returns single mode", async () => {
      const result = await classifyIntent("/content write a blog post", "telegram", "user1");
      expect(result.execution_mode).toBe("single");
      expect(result.agent_name).toBe("content");
    });

    test("/research returns single mode", async () => {
      const result = await classifyIntent("/research quantum computing", "telegram", "user1");
      expect(result.execution_mode).toBe("single");
      expect(result.agent_name).toBe("research");
    });

    test("/critic returns single mode", async () => {
      const result = await classifyIntent("/critic review my essay", "telegram", "user1");
      expect(result.execution_mode).toBe("single");
      expect(result.agent_name).toBe("critic");
    });
  });

  // ── Fan-Out Detection ───────────────────────────────────────

  describe("Fan-out mode for multi-intent messages", () => {
    test("classifier returns fan-out with skills array for parallel tasks", async () => {
      const anthropic = {
        messages: {
          create: mock(() =>
            Promise.resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    agent: "general",
                    skill: "calendar_management",
                    confidence: 0.92,
                    reasoning: "Multiple independent tasks",
                    execution_mode: "fan-out",
                    skills: [
                      { agent: "general", skill: "calendar_management", instruction: "Check calendar events" },
                      { agent: "general", skill: "email_management", instruction: "Check unread emails" },
                    ],
                  }),
                },
              ],
              usage: { input_tokens: 100, output_tokens: 80 },
            }),
          ),
        },
      } as any;

      initClassifier(anthropic, createClassifierSupabase());

      const result = await classifyIntent(
        "What's on my calendar and any unread emails?",
        "telegram",
        "user1",
      );

      expect(result.execution_mode).toBe("fan-out");
      expect(result.skills).toBeDefined();
      expect(result.skills!.length).toBe(2);
      expect(result.skills![0].skill).toBe("calendar_management");
      expect(result.skills![1].skill).toBe("email_management");
    });
  });

  // ── Critic-Loop Detection ───────────────────────────────────

  describe("Critic-loop mode for writing/proposal tasks", () => {
    test("classifier returns critic-loop with producer and critic skills", async () => {
      const anthropic = {
        messages: {
          create: mock(() =>
            Promise.resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    agent: "content",
                    skill: "writing",
                    confidence: 0.88,
                    reasoning: "Writing task requiring quality refinement",
                    execution_mode: "critic-loop",
                    skills: [
                      { agent: "content", skill: "writing", instruction: "Write the email" },
                      { agent: "critic", skill: "critical_review", instruction: "Review for tone" },
                    ],
                  }),
                },
              ],
              usage: { input_tokens: 100, output_tokens: 80 },
            }),
          ),
        },
      } as any;

      initClassifier(anthropic, createClassifierSupabase());

      const result = await classifyIntent(
        "Write an email to the team about the release and make it really good",
        "telegram",
        "user1",
      );

      expect(result.execution_mode).toBe("critic-loop");
      expect(result.skills).toBeDefined();
      expect(result.skills!.length).toBe(2);
    });
  });

  // ── Pipeline Detection ──────────────────────────────────────

  describe("Pipeline mode for sequential tasks", () => {
    test("classifier returns pipeline with ordered skills", async () => {
      const anthropic = {
        messages: {
          create: mock(() =>
            Promise.resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    agent: "research",
                    skill: "web_research",
                    confidence: 0.90,
                    reasoning: "Sequential research then summary",
                    execution_mode: "pipeline",
                    skills: [
                      { agent: "research", skill: "web_research", instruction: "Research quantum computing" },
                      { agent: "content", skill: "writing", instruction: "Summarize the findings" },
                    ],
                  }),
                },
              ],
              usage: { input_tokens: 100, output_tokens: 80 },
            }),
          ),
        },
      } as any;

      initClassifier(anthropic, createClassifierSupabase());

      const result = await classifyIntent(
        "Research quantum computing then summarize it",
        "telegram",
        "user1",
      );

      expect(result.execution_mode).toBe("pipeline");
      expect(result.skills!.length).toBe(2);
      expect(result.skills![0].skill).toBe("web_research");
      expect(result.skills![1].skill).toBe("writing");
    });
  });

  // ── Single Mode Default ─────────────────────────────────────

  describe("Single mode as default", () => {
    test("simple message returns single mode", async () => {
      const anthropic = {
        messages: {
          create: mock(() =>
            Promise.resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    agent: "general",
                    skill: "none",
                    confidence: 0.85,
                    reasoning: "Simple greeting",
                    execution_mode: "single",
                    skills: null,
                  }),
                },
              ],
              usage: { input_tokens: 100, output_tokens: 50 },
            }),
          ),
        },
      } as any;

      initClassifier(anthropic, createClassifierSupabase());

      const result = await classifyIntent("Hello, how are you?", "telegram", "user1");

      expect(result.execution_mode).toBe("single");
      expect(result.skills).toBeUndefined();
    });
  });

  // ── Invalid Mode Fallback ───────────────────────────────────

  describe("Mode validation", () => {
    test("invalid execution_mode falls back to single", async () => {
      const anthropic = {
        messages: {
          create: mock(() =>
            Promise.resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    agent: "general",
                    skill: "none",
                    confidence: 0.80,
                    reasoning: "Simple question",
                    execution_mode: "invalid_mode_xyz",
                  }),
                },
              ],
              usage: { input_tokens: 100, output_tokens: 50 },
            }),
          ),
        },
      } as any;

      initClassifier(anthropic, createClassifierSupabase());

      const result = await classifyIntent("Hello", "telegram", "user1");

      expect(result.execution_mode).toBe("single");
    });

    test("skills array parsed and truncated for multi-step modes", async () => {
      const anthropic = {
        messages: {
          create: mock(() =>
            Promise.resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    agent: "general",
                    skill: "calendar_management",
                    confidence: 0.90,
                    reasoning: "Parallel tasks",
                    execution_mode: "fan-out",
                    skills: [
                      { agent: "general", skill: "calendar_management", instruction: "A".repeat(3000) },
                      { agent: "general", skill: "email_management", instruction: "Check email" },
                    ],
                  }),
                },
              ],
              usage: { input_tokens: 100, output_tokens: 80 },
            }),
          ),
        },
      } as any;

      initClassifier(anthropic, createClassifierSupabase());

      const result = await classifyIntent("Calendar and email", "telegram", "user1");

      expect(result.skills).toBeDefined();
      // Instructions truncated to 2000 chars
      expect(result.skills![0].instruction.length).toBeLessThanOrEqual(2000);
    });

    test("pipeline_steps field accepted as alias for skills", async () => {
      const anthropic = {
        messages: {
          create: mock(() =>
            Promise.resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    agent: "research",
                    skill: "web_research",
                    confidence: 0.90,
                    reasoning: "Sequential tasks",
                    execution_mode: "pipeline",
                    pipeline_steps: [
                      { agent: "research", skill: "web_research", instruction: "Research" },
                      { agent: "content", skill: "writing", instruction: "Summarize" },
                    ],
                  }),
                },
              ],
              usage: { input_tokens: 100, output_tokens: 80 },
            }),
          ),
        },
      } as any;

      initClassifier(anthropic, createClassifierSupabase());

      const result = await classifyIntent("Research then summarize", "telegram", "user1");

      expect(result.execution_mode).toBe("pipeline");
      expect(result.skills).toBeDefined();
      expect(result.skills!.length).toBe(2);
    });
  });

  // ── Cross-Domain Override ───────────────────────────────────

  describe("Cross-domain override preserves execution mode", () => {
    test("LLM overrides session continuity with new execution mode", async () => {
      // Supabase with active session for "general"
      const agents = [
        { name: "general", type: "generalist", capabilities: ["general"] },
        { name: "content", type: "specialist", capabilities: ["writing"] },
        { name: "critic", type: "specialist", capabilities: ["review"] },
      ];
      const skills = [
        { name: "writing", description: "Write content", agents: { name: "content" }, triggers: ["write"], priority: 1 },
        { name: "critical_review", description: "Review content", agents: { name: "critic" }, triggers: ["review"], priority: 1 },
      ];

      function createChain(resolvedData: any) {
        const promise = Promise.resolve({ data: resolvedData, error: null });
        const chain: any = {};
        for (const m of ["select", "eq", "order", "limit", "insert", "update"]) {
          chain[m] = (..._args: any[]) => chain;
        }
        chain.single = () => promise;
        chain.then = (resolve: Function, reject?: Function) => promise.then(resolve, reject);
        chain.catch = (reject: Function) => promise.catch(reject);
        return chain;
      }

      const supabase = {
        from: mock((table: string) => {
          if (table === "agents") return createChain(agents);
          if (table === "skills") return createChain(skills);
          if (table === "agent_sessions") {
            // Active session with "general"
            return createChain({
              id: "session-1",
              agent_id: "agent-1",
              agents: { name: "general" },
            });
          }
          return createChain(null);
        }),
        functions: { invoke: mock() },
      } as any;

      const anthropic = {
        messages: {
          create: mock(() =>
            Promise.resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    agent: "content",
                    skill: "writing",
                    confidence: 0.92, // Above 0.85 threshold
                    reasoning: "Writing task, different domain",
                    execution_mode: "critic-loop",
                    skills: [
                      { agent: "content", skill: "writing", instruction: "Write email" },
                      { agent: "critic", skill: "critical_review", instruction: "Review" },
                    ],
                  }),
                },
              ],
              usage: { input_tokens: 100, output_tokens: 80 },
            }),
          ),
        },
      } as any;

      initClassifier(anthropic, supabase);

      const result = await classifyIntent(
        "Write a professional email to the team",
        "telegram",
        "user1",
      );

      // LLM should override session continuity
      expect(result.agent_name).toBe("content");
      expect(result.execution_mode).toBe("critic-loop");
      expect(result.skills).toBeDefined();
    });
  });
});
