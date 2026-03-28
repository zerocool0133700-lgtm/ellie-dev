# Coordinator Loop — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Ellie's stateless router with a Messages API coordinator loop that can decompose multi-part requests, dispatch specialists in parallel, stay alive during subagent work, and synthesize results into coherent responses.

**Architecture:** The coordinator is a new module (`src/coordinator.ts`) that maintains a conversation with Claude via the Anthropic Messages API. It has custom tools (`dispatch_agent`, `ask_user`, `update_user`, `read_context`, `invoke_recipe`, `complete`) whose handlers call into existing relay infrastructure. Specialists continue running as CLI subprocesses via the existing `callClaude()` function. A feature flag (`COORDINATOR_MODE`) gates the cutover.

**Tech Stack:** Bun + TypeScript, `@anthropic-ai/sdk` (already installed v0.74.0), existing relay infrastructure (telegram-handlers, claude-cli, working-memory, orchestration-ledger, Forest bridge)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/dispatch-envelope.ts` | Create | Unified dispatch wrapper — one shape for both API and CLI calls |
| `src/coordinator-tools.ts` | Create | Tool definitions (JSON schemas) and handlers for the 6 coordinator tools |
| `src/coordinator-context.ts` | Create | Manages coordinator conversation history, token tracking, automatic compaction |
| `src/coordinator.ts` | Create | The coordinator loop — think/act/observe/think cycle using Messages API |
| `src/telegram-handlers.ts` | Modify | Add feature-flagged branch routing to coordinator |
| `src/google-chat.ts` | Modify | Add feature-flagged branch routing to coordinator |
| `src/orchestration-ledger.ts` | Modify | Accept DispatchEnvelope alongside existing events |
| `tests/dispatch-envelope.test.ts` | Create | Tests for envelope creation and cost computation |
| `tests/coordinator-tools.test.ts` | Create | Tests for tool handler logic |
| `tests/coordinator-context.test.ts` | Create | Tests for context management and compaction |
| `tests/coordinator.test.ts` | Create | Tests for the coordinator loop |

---

### Task 1: Dispatch Envelope

**Files:**
- Create: `src/dispatch-envelope.ts`
- Test: `tests/dispatch-envelope.test.ts`

- [ ] **Step 1: Write the failing test for envelope creation**

```typescript
// tests/dispatch-envelope.test.ts
import { describe, test, expect } from "bun:test";
import {
  createEnvelope,
  completeEnvelope,
  failEnvelope,
  computeCost,
  type DispatchEnvelope,
} from "../src/dispatch-envelope";

describe("DispatchEnvelope", () => {
  test("createEnvelope produces a valid envelope with defaults", () => {
    const env = createEnvelope({
      type: "coordinator",
      agent: "ellie",
      foundation: "software-dev",
    });

    expect(env.id).toMatch(/^dsp_/);
    expect(env.type).toBe("coordinator");
    expect(env.agent).toBe("ellie");
    expect(env.foundation).toBe("software-dev");
    expect(env.parent_id).toBeNull();
    expect(env.status).toBe("running");
    expect(env.started_at).toBeTruthy();
    expect(env.completed_at).toBeNull();
    expect(env.tokens_in).toBe(0);
    expect(env.tokens_out).toBe(0);
    expect(env.cost_usd).toBe(0);
    expect(env.error).toBeNull();
    expect(env.work_item_id).toBeNull();
  });

  test("createEnvelope accepts optional fields", () => {
    const env = createEnvelope({
      type: "specialist",
      agent: "james",
      foundation: "software-dev",
      parent_id: "dsp_abc123",
      model: "claude-sonnet-4-6",
      work_item_id: "ELLIE-500",
    });

    expect(env.parent_id).toBe("dsp_abc123");
    expect(env.model).toBe("claude-sonnet-4-6");
    expect(env.work_item_id).toBe("ELLIE-500");
  });

  test("completeEnvelope sets status and timestamps", () => {
    const env = createEnvelope({ type: "specialist", agent: "james", foundation: "software-dev" });
    const completed = completeEnvelope(env, { tokens_in: 1000, tokens_out: 500, model: "claude-sonnet-4-6" });

    expect(completed.status).toBe("completed");
    expect(completed.completed_at).toBeTruthy();
    expect(completed.tokens_in).toBe(1000);
    expect(completed.tokens_out).toBe(500);
    expect(completed.cost_usd).toBeGreaterThan(0);
  });

  test("failEnvelope sets error and status", () => {
    const env = createEnvelope({ type: "specialist", agent: "james", foundation: "software-dev" });
    const failed = failEnvelope(env, "timeout after 900s");

    expect(failed.status).toBe("error");
    expect(failed.error).toBe("timeout after 900s");
    expect(failed.completed_at).toBeTruthy();
  });

  test("computeCost uses sonnet pricing correctly", () => {
    // Sonnet: $3/M input, $15/M output
    const cost = computeCost("claude-sonnet-4-6", 1_000_000, 1_000_000);
    expect(cost).toBe(18.0); // $3 + $15
  });

  test("computeCost falls back to sonnet for unknown models", () => {
    const cost = computeCost("unknown-model", 1_000_000, 0);
    expect(cost).toBe(3.0); // Sonnet input price
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ellie/ellie-dev && bun test tests/dispatch-envelope.test.ts`
Expected: FAIL — module `../src/dispatch-envelope` not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/dispatch-envelope.ts
/**
 * Dispatch Envelope — Unified tracking for coordinator + specialist dispatches.
 * Every dispatch (Messages API or CLI subprocess) gets one envelope.
 * Parent-child relationships enable full trace trees.
 */

import { log } from "./logger.ts";

const logger = log.child("dispatch-envelope");

// Model pricing (per million tokens, USD) — reuse from creature-cost-tracker
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-6":   { input: 15.0, output: 75.0 },
  "claude-sonnet-4-6": { input: 3.0,  output: 15.0 },
  "claude-haiku-4-5":  { input: 0.8,  output: 4.0  },
  "opus":   { input: 15.0, output: 75.0 },
  "sonnet": { input: 3.0,  output: 15.0 },
  "haiku":  { input: 0.8,  output: 4.0  },
};

export interface DispatchEnvelope {
  id: string;
  type: "coordinator" | "specialist";
  agent: string;
  foundation: string;
  parent_id: string | null;
  started_at: string;
  completed_at: string | null;
  status: "running" | "completed" | "error" | "timeout";
  tokens_in: number;
  tokens_out: number;
  model: string;
  cost_usd: number;
  error: string | null;
  work_item_id: string | null;
}

interface CreateOpts {
  type: "coordinator" | "specialist";
  agent: string;
  foundation: string;
  parent_id?: string;
  model?: string;
  work_item_id?: string;
}

interface CompleteOpts {
  tokens_in: number;
  tokens_out: number;
  model?: string;
}

let counter = 0;

function generateId(): string {
  const ts = Date.now().toString(36);
  const seq = (counter++).toString(36).padStart(4, "0");
  const rand = Math.random().toString(36).slice(2, 6);
  return `dsp_${ts}${seq}${rand}`;
}

export function computeCost(model: string, tokensIn: number, tokensOut: number): number {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING["sonnet"];
  const cost =
    (tokensIn / 1_000_000) * pricing.input +
    (tokensOut / 1_000_000) * pricing.output;
  return Math.round(cost * 10000) / 10000;
}

export function createEnvelope(opts: CreateOpts): DispatchEnvelope {
  return {
    id: generateId(),
    type: opts.type,
    agent: opts.agent,
    foundation: opts.foundation,
    parent_id: opts.parent_id ?? null,
    started_at: new Date().toISOString(),
    completed_at: null,
    status: "running",
    tokens_in: 0,
    tokens_out: 0,
    model: opts.model ?? "unknown",
    cost_usd: 0,
    error: null,
    work_item_id: opts.work_item_id ?? null,
  };
}

export function completeEnvelope(env: DispatchEnvelope, opts: CompleteOpts): DispatchEnvelope {
  const model = opts.model ?? env.model;
  const cost = computeCost(model, opts.tokens_in, opts.tokens_out);
  return {
    ...env,
    status: "completed",
    completed_at: new Date().toISOString(),
    tokens_in: opts.tokens_in,
    tokens_out: opts.tokens_out,
    model,
    cost_usd: cost,
  };
}

export function failEnvelope(env: DispatchEnvelope, error: string): DispatchEnvelope {
  return {
    ...env,
    status: "error",
    completed_at: new Date().toISOString(),
    error,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ellie/ellie-dev && bun test tests/dispatch-envelope.test.ts`
Expected: 6 pass, 0 fail

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-dev && git add src/dispatch-envelope.ts tests/dispatch-envelope.test.ts && git commit -m "[ELLIE-1092] feat: add DispatchEnvelope for unified dispatch tracking"
```

---

### Task 2: Coordinator Tools — Definitions and Handlers

**Files:**
- Create: `src/coordinator-tools.ts`
- Test: `tests/coordinator-tools.test.ts`

- [ ] **Step 1: Write the failing test for tool schema definitions**

```typescript
// tests/coordinator-tools.test.ts
import { describe, test, expect } from "bun:test";
import {
  COORDINATOR_TOOL_DEFINITIONS,
  type CoordinatorToolName,
} from "../src/coordinator-tools";

describe("Coordinator tool definitions", () => {
  const toolNames: CoordinatorToolName[] = [
    "dispatch_agent",
    "ask_user",
    "invoke_recipe",
    "read_context",
    "update_user",
    "complete",
  ];

  test("all 6 tools are defined", () => {
    expect(COORDINATOR_TOOL_DEFINITIONS).toHaveLength(6);
    const names = COORDINATOR_TOOL_DEFINITIONS.map(t => t.name);
    for (const name of toolNames) {
      expect(names).toContain(name);
    }
  });

  test("each tool has name, description, and input_schema", () => {
    for (const tool of COORDINATOR_TOOL_DEFINITIONS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.input_schema).toBeTruthy();
      expect(tool.input_schema.type).toBe("object");
    }
  });

  test("dispatch_agent requires agent and task", () => {
    const tool = COORDINATOR_TOOL_DEFINITIONS.find(t => t.name === "dispatch_agent")!;
    expect(tool.input_schema.required).toContain("agent");
    expect(tool.input_schema.required).toContain("task");
  });

  test("complete requires response", () => {
    const tool = COORDINATOR_TOOL_DEFINITIONS.find(t => t.name === "complete")!;
    expect(tool.input_schema.required).toContain("response");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ellie/ellie-dev && bun test tests/coordinator-tools.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the tool definitions**

```typescript
// src/coordinator-tools.ts
/**
 * Coordinator Tools — Custom tool definitions and handlers for the coordinator loop.
 * These are passed to the Anthropic Messages API as tool definitions.
 * Handlers execute locally and return results to the coordinator conversation.
 */

import { log } from "./logger.ts";
import type Anthropic from "@anthropic-ai/sdk";

const logger = log.child("coordinator-tools");

export type CoordinatorToolName =
  | "dispatch_agent"
  | "ask_user"
  | "invoke_recipe"
  | "read_context"
  | "update_user"
  | "complete";

export interface DispatchAgentInput {
  agent: string;
  task: string;
  context?: string;
  timeout_ms?: number;
  priority?: string;
}

export interface AskUserInput {
  question: string;
  options?: string[];
  timeout_ms?: number;
  urgency?: string;
}

export interface InvokeRecipeInput {
  recipe_name: string;
  input: string;
  agents_override?: string[];
}

export interface ReadContextInput {
  source: "forest" | "plane" | "memory" | "sessions";
  query: string;
}

export interface UpdateUserInput {
  message: string;
  channel?: string;
}

export interface CompleteInput {
  response: string;
  promote_to_memory?: boolean;
  update_plane?: boolean;
}

export type CoordinatorToolInput =
  | DispatchAgentInput
  | AskUserInput
  | InvokeRecipeInput
  | ReadContextInput
  | UpdateUserInput
  | CompleteInput;

export const COORDINATOR_TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "dispatch_agent",
    description:
      "Send a task to a specialist agent. Returns their output when complete. " +
      "You can call this tool multiple times in one response to dispatch agents in parallel.",
    input_schema: {
      type: "object" as const,
      properties: {
        agent: {
          type: "string",
          description: "Agent name from the active foundation roster (e.g. 'james', 'brian', 'kate')",
        },
        task: {
          type: "string",
          description: "Clear description of what the agent should do. Include all relevant context.",
        },
        context: {
          type: "string",
          description: "Additional context from prior dispatches or user conversation.",
        },
        timeout_ms: {
          type: "number",
          description: "Override default subagent timeout in milliseconds.",
        },
        priority: {
          type: "string",
          enum: ["high", "normal", "low"],
          description: "Dispatch priority. Default: normal.",
        },
      },
      required: ["agent", "task"],
    },
  },
  {
    name: "ask_user",
    description:
      "Pause the coordinator loop and ask the user a question via their messaging channel. " +
      "Loop resumes when the user replies. Use for approvals, clarifications, or decisions. " +
      "If the user doesn't reply within timeout_ms, returns { response: null, timed_out: true }.",
    input_schema: {
      type: "object" as const,
      properties: {
        question: {
          type: "string",
          description: "The question to ask the user.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Optional multiple choice options.",
        },
        timeout_ms: {
          type: "number",
          description: "How long to wait for user reply. Default: 300000 (5 min).",
        },
        urgency: {
          type: "string",
          enum: ["blocking", "when_you_can"],
          description: "Whether this blocks the loop or can proceed without an answer.",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "invoke_recipe",
    description:
      "Run a coordination recipe from the active foundation. Recipes encode multi-agent patterns " +
      "like code review pipelines, architecture round tables, or morning routines.",
    input_schema: {
      type: "object" as const,
      properties: {
        recipe_name: {
          type: "string",
          description: "Name of the recipe from the active foundation config.",
        },
        input: {
          type: "string",
          description: "What to feed into the recipe.",
        },
        agents_override: {
          type: "array",
          items: { type: "string" },
          description: "Override the default agents for this recipe invocation.",
        },
      },
      required: ["recipe_name", "input"],
    },
  },
  {
    name: "read_context",
    description:
      "Lightweight information gathering without dispatching a full agent. " +
      "Read from Forest knowledge tree, check Plane work items, query working memory, or check active sessions.",
    input_schema: {
      type: "object" as const,
      properties: {
        source: {
          type: "string",
          enum: ["forest", "plane", "memory", "sessions"],
          description: "Which system to query.",
        },
        query: {
          type: "string",
          description: "Search query or identifier.",
        },
      },
      required: ["source", "query"],
    },
  },
  {
    name: "update_user",
    description:
      "Send a progress message to the user without ending the coordinator loop. " +
      "Use to keep the user informed while dispatches are in flight.",
    input_schema: {
      type: "object" as const,
      properties: {
        message: {
          type: "string",
          description: "Progress update message to send.",
        },
        channel: {
          type: "string",
          description: "Override channel. Default: the channel the user messaged from.",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "complete",
    description:
      "End the coordinator loop and deliver the final response to the user. " +
      "You MUST call this tool to finish. The loop will not exit without it.",
    input_schema: {
      type: "object" as const,
      properties: {
        response: {
          type: "string",
          description: "Final synthesized response to send to the user.",
        },
        promote_to_memory: {
          type: "boolean",
          description: "Promote decisions from this session to Forest. Default: false.",
        },
        update_plane: {
          type: "boolean",
          description: "Update the associated Plane work item if applicable. Default: false.",
        },
      },
      required: ["response"],
    },
  },
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ellie/ellie-dev && bun test tests/coordinator-tools.test.ts`
Expected: 4 pass, 0 fail

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-dev && git add src/coordinator-tools.ts tests/coordinator-tools.test.ts && git commit -m "[ELLIE-1092] feat: add coordinator tool definitions"
```

---

### Task 3: Coordinator Context Manager

**Files:**
- Create: `src/coordinator-context.ts`
- Test: `tests/coordinator-context.test.ts`

- [ ] **Step 1: Write the failing test for context management**

```typescript
// tests/coordinator-context.test.ts
import { describe, test, expect } from "bun:test";
import {
  CoordinatorContext,
  type ContextPressureLevel,
} from "../src/coordinator-context";

describe("CoordinatorContext", () => {
  test("initializes with system prompt", () => {
    const ctx = new CoordinatorContext({
      systemPrompt: "You are Ellie, a coordinator.",
      maxTokens: 200_000,
    });

    const messages = ctx.getMessages();
    expect(messages).toHaveLength(0); // System prompt is separate, not in messages
    expect(ctx.getSystemPrompt()).toBe("You are Ellie, a coordinator.");
  });

  test("addUserMessage appends to history", () => {
    const ctx = new CoordinatorContext({
      systemPrompt: "You are Ellie.",
      maxTokens: 200_000,
    });

    ctx.addUserMessage("Update the dashboard");
    const messages = ctx.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("Update the dashboard");
  });

  test("addAssistantMessage appends tool use blocks", () => {
    const ctx = new CoordinatorContext({
      systemPrompt: "You are Ellie.",
      maxTokens: 200_000,
    });

    ctx.addAssistantMessage([
      { type: "text", text: "I'll dispatch James." },
      { type: "tool_use", id: "tu_1", name: "dispatch_agent", input: { agent: "james", task: "fix bug" } },
    ]);
    const messages = ctx.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
  });

  test("addToolResult appends tool result", () => {
    const ctx = new CoordinatorContext({
      systemPrompt: "You are Ellie.",
      maxTokens: 200_000,
    });

    ctx.addToolResult("tu_1", "Bug fixed. Tests pass.");
    const messages = ctx.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    // Tool results are sent as user messages with tool_result content blocks
  });

  test("getPressure returns normal when well under limit", () => {
    const ctx = new CoordinatorContext({
      systemPrompt: "You are Ellie.",
      maxTokens: 200_000,
    });

    ctx.recordTokenUsage(10_000);
    expect(ctx.getPressure()).toBe("normal");
  });

  test("getPressure returns warm at 50-70%", () => {
    const ctx = new CoordinatorContext({
      systemPrompt: "You are Ellie.",
      maxTokens: 200_000,
    });

    ctx.recordTokenUsage(120_000);
    expect(ctx.getPressure()).toBe("warm");
  });

  test("getPressure returns hot at 70-85%", () => {
    const ctx = new CoordinatorContext({
      systemPrompt: "You are Ellie.",
      maxTokens: 200_000,
    });

    ctx.recordTokenUsage(160_000);
    expect(ctx.getPressure()).toBe("hot");
  });

  test("getPressure returns critical above 85%", () => {
    const ctx = new CoordinatorContext({
      systemPrompt: "You are Ellie.",
      maxTokens: 200_000,
    });

    ctx.recordTokenUsage(180_000);
    expect(ctx.getPressure()).toBe("critical");
  });

  test("compact at warm level summarizes old tool results", () => {
    const ctx = new CoordinatorContext({
      systemPrompt: "You are Ellie.",
      maxTokens: 200_000,
    });

    // Add several loop iterations
    ctx.addUserMessage("Do three things");
    ctx.addAssistantMessage([{ type: "tool_use", id: "tu_1", name: "dispatch_agent", input: { agent: "james", task: "task 1" } }]);
    ctx.addToolResult("tu_1", "A".repeat(5000)); // Long result
    ctx.addAssistantMessage([{ type: "tool_use", id: "tu_2", name: "dispatch_agent", input: { agent: "brian", task: "task 2" } }]);
    ctx.addToolResult("tu_2", "B".repeat(5000)); // Long result
    ctx.addAssistantMessage([{ type: "tool_use", id: "tu_3", name: "dispatch_agent", input: { agent: "kate", task: "task 3" } }]);
    ctx.addToolResult("tu_3", "C".repeat(5000)); // Long result

    const before = ctx.getMessages().length;
    ctx.compact("warm");
    const after = ctx.getMessages().length;

    // Should have fewer messages after compaction
    expect(after).toBeLessThanOrEqual(before);
  });

  test("compact at critical level rebuilds from scratch", () => {
    const ctx = new CoordinatorContext({
      systemPrompt: "You are Ellie.",
      maxTokens: 200_000,
    });

    // Add many messages
    for (let i = 0; i < 10; i++) {
      ctx.addAssistantMessage([{ type: "tool_use", id: `tu_${i}`, name: "dispatch_agent", input: { agent: "james", task: `task ${i}` } }]);
      ctx.addToolResult(`tu_${i}`, `Result ${i}: ${"x".repeat(2000)}`);
    }

    ctx.compact("critical");
    const messages = ctx.getMessages();

    // Critical rebuild: should only have a summary + last iteration
    expect(messages.length).toBeLessThanOrEqual(4);
  });

  test("getCompactionSummary returns what was removed", () => {
    const ctx = new CoordinatorContext({
      systemPrompt: "You are Ellie.",
      maxTokens: 200_000,
    });

    ctx.addUserMessage("Do something");
    ctx.addAssistantMessage([{ type: "tool_use", id: "tu_1", name: "dispatch_agent", input: { agent: "james", task: "fix" } }]);
    ctx.addToolResult("tu_1", "Done. Fixed the auth bug in line 42. Tests pass: 15/15.");

    const summary = ctx.getCompactionSummary();
    expect(summary).toContain("james");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ellie/ellie-dev && bun test tests/coordinator-context.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/coordinator-context.ts
/**
 * Coordinator Context Manager — Manages the coordinator's Messages API conversation.
 * Tracks token pressure and compacts automatically to keep the coordinator lean.
 * Promotes details to working memory when compacting.
 */

import { log } from "./logger.ts";
import type Anthropic from "@anthropic-ai/sdk";

const logger = log.child("coordinator-context");

export type ContextPressureLevel = "normal" | "warm" | "hot" | "critical";

interface ContextOpts {
  systemPrompt: string;
  maxTokens: number; // Model's context window size
}

type MessageParam = Anthropic.MessageParam;
type ContentBlockParam = Anthropic.ContentBlockParam;

export class CoordinatorContext {
  private systemPrompt: string;
  private messages: MessageParam[] = [];
  private maxTokens: number;
  private lastTokenCount = 0;
  private compactedSummaries: string[] = [];

  constructor(opts: ContextOpts) {
    this.systemPrompt = opts.systemPrompt;
    this.maxTokens = opts.maxTokens;
  }

  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  getMessages(): MessageParam[] {
    return this.messages;
  }

  getTokenCount(): number {
    return this.lastTokenCount;
  }

  addUserMessage(text: string): void {
    this.messages.push({ role: "user", content: text });
  }

  addAssistantMessage(content: ContentBlockParam[]): void {
    this.messages.push({ role: "assistant", content });
  }

  addToolResult(toolUseId: string, result: string): void {
    this.messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: result }],
    });
  }

  recordTokenUsage(inputTokens: number): void {
    this.lastTokenCount = inputTokens;
  }

  getPressure(): ContextPressureLevel {
    const ratio = this.lastTokenCount / this.maxTokens;
    if (ratio >= 0.85) return "critical";
    if (ratio >= 0.70) return "hot";
    if (ratio >= 0.50) return "warm";
    return "normal";
  }

  /**
   * Generate a summary of tool results for compaction.
   * Extracts agent name and truncates long outputs to first 200 chars.
   */
  getCompactionSummary(): string {
    const summaries: string[] = [];
    for (const msg of this.messages) {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use" && block.name === "dispatch_agent") {
            const input = block.input as Record<string, unknown>;
            summaries.push(`${input.agent}: dispatched for "${(input.task as string)?.slice(0, 100)}"`);
          }
        }
      }
      if (msg.role === "user" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if ((block as Record<string, unknown>).type === "tool_result") {
            const tr = block as { tool_use_id: string; content: string };
            summaries.push(`  result: ${tr.content.slice(0, 200)}...`);
          }
        }
      }
    }
    return summaries.join("\n");
  }

  /**
   * Compact the conversation to reduce token pressure.
   * - warm: Summarize old tool results, keep last 3 exchanges
   * - hot: Collapse to summary + last 2 exchanges
   * - critical: Rebuild from scratch — system prompt + summary + last exchange
   */
  compact(level: ContextPressureLevel): void {
    if (level === "normal") return;

    const keepLast = level === "critical" ? 2 : level === "hot" ? 4 : 6;

    if (this.messages.length <= keepLast) return;

    // Summarize what we're removing
    const toRemove = this.messages.slice(0, this.messages.length - keepLast);
    const summaryParts: string[] = [];

    for (const msg of toRemove) {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use") {
            const input = block.input as Record<string, unknown>;
            if (block.name === "dispatch_agent") {
              summaryParts.push(`- Dispatched ${input.agent} for: ${(input.task as string)?.slice(0, 150)}`);
            } else if (block.name === "complete") {
              summaryParts.push(`- Completed with response`);
            } else {
              summaryParts.push(`- Called ${block.name}`);
            }
          } else if (block.type === "text") {
            summaryParts.push(`- Thought: ${block.text.slice(0, 150)}`);
          }
        }
      }
      if (msg.role === "user" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if ((block as Record<string, unknown>).type === "tool_result") {
            const tr = block as { content: string };
            summaryParts.push(`  → ${tr.content.slice(0, 200)}`);
          }
        }
      } else if (msg.role === "user" && typeof msg.content === "string") {
        summaryParts.push(`- User: ${msg.content.slice(0, 150)}`);
      }
    }

    const summary = `[Prior coordinator activity — compacted at ${level} pressure]\n${summaryParts.join("\n")}`;
    this.compactedSummaries.push(summary);

    // Keep only the last N messages, prepend a summary
    const kept = this.messages.slice(this.messages.length - keepLast);
    this.messages = [
      { role: "user", content: summary },
      ...kept,
    ];

    // Fix message ordering: ensure messages alternate user/assistant properly
    // The Messages API requires alternating roles. If we have two user messages
    // in a row after compaction, merge them.
    this.fixMessageOrdering();

    logger.info("Compacted coordinator context", {
      level,
      removed: toRemove.length,
      kept: this.messages.length,
      summaryChars: summary.length,
    });
  }

  /**
   * Ensure messages alternate between user and assistant.
   * Merge consecutive same-role messages.
   */
  private fixMessageOrdering(): void {
    const fixed: MessageParam[] = [];
    for (const msg of this.messages) {
      const prev = fixed[fixed.length - 1];
      if (prev && prev.role === msg.role) {
        // Merge: append content
        if (typeof prev.content === "string" && typeof msg.content === "string") {
          prev.content = prev.content + "\n\n" + msg.content;
        }
        // For array content, skip merge — keep the newer one
        continue;
      }
      fixed.push(msg);
    }
    this.messages = fixed;
  }

  /**
   * Full rebuild for critical pressure. Replaces entire conversation
   * with a working memory summary + the last exchange.
   */
  rebuildFromSummary(workingMemorySummary: string): void {
    const lastTwo = this.messages.slice(-2);
    this.messages = [
      { role: "user", content: `[Context restored from working memory]\n${workingMemorySummary}` },
      ...lastTwo,
    ];
    this.fixMessageOrdering();
    logger.info("Rebuilt coordinator context from working memory", { messageCount: this.messages.length });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ellie/ellie-dev && bun test tests/coordinator-context.test.ts`
Expected: 10 pass, 0 fail

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-dev && git add src/coordinator-context.ts tests/coordinator-context.test.ts && git commit -m "[ELLIE-1092] feat: add coordinator context manager with compaction"
```

---

### Task 4: Coordinator Loop — Core Module

**Files:**
- Create: `src/coordinator.ts`
- Test: `tests/coordinator.test.ts`

- [ ] **Step 1: Write the failing test for the coordinator loop**

```typescript
// tests/coordinator.test.ts
import { describe, test, expect, mock } from "bun:test";
import {
  runCoordinatorLoop,
  type CoordinatorDeps,
  type CoordinatorOpts,
  type CoordinatorResult,
} from "../src/coordinator";

// Mock dependencies — the coordinator calls these, we control the responses
function createMockDeps(overrides?: Partial<CoordinatorDeps>): CoordinatorDeps {
  return {
    callSpecialist: overrides?.callSpecialist ?? (async (agent, task) => ({
      agent,
      status: "completed" as const,
      output: `${agent} completed: ${task.slice(0, 50)}`,
      tokens_used: 1000,
      duration_ms: 5000,
    })),
    sendMessage: overrides?.sendMessage ?? (async (_channel, _msg) => {}),
    readForest: overrides?.readForest ?? (async (query) => `Forest result for: ${query}`),
    readPlane: overrides?.readPlane ?? (async (query) => `Plane result for: ${query}`),
    readMemory: overrides?.readMemory ?? (async (query) => `Memory result for: ${query}`),
    readSessions: overrides?.readSessions ?? (async (query) => `Sessions result for: ${query}`),
    getWorkingMemorySummary: overrides?.getWorkingMemorySummary ?? (async () => ""),
    updateWorkingMemory: overrides?.updateWorkingMemory ?? (async (_sections) => {}),
    promoteToForest: overrides?.promoteToForest ?? (async () => {}),
    logEnvelope: overrides?.logEnvelope ?? (async (_env) => {}),
  };
}

describe("Coordinator loop", () => {
  test("simple request — single dispatch and complete", async () => {
    // Stub the Anthropic client to return a dispatch_agent call then a complete call
    const result = await runCoordinatorLoop({
      message: "Check the relay status",
      channel: "telegram",
      userId: "dave",
      foundation: "software-dev",
      systemPrompt: "You are Ellie, a coordinator.",
      model: "claude-sonnet-4-6",
      agentRoster: ["james", "brian", "jason"],
      deps: createMockDeps(),
      // For testing: inject mock Anthropic responses
      _testResponses: [
        // Loop 1: coordinator decides to dispatch jason
        {
          stop_reason: "tool_use",
          content: [
            { type: "text", text: "Let me check with Jason." },
            { type: "tool_use", id: "tu_1", name: "dispatch_agent", input: { agent: "jason", task: "Check the relay service status" } },
          ],
          usage: { input_tokens: 5000, output_tokens: 200 },
        },
        // Loop 2: coordinator synthesizes and completes
        {
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: "tu_2", name: "complete", input: { response: "Relay is running fine. Jason confirmed all services are healthy." } },
          ],
          usage: { input_tokens: 6000, output_tokens: 100 },
        },
      ],
    });

    expect(result.response).toContain("Relay is running");
    expect(result.loopIterations).toBe(2);
    expect(result.envelopes.length).toBeGreaterThanOrEqual(1); // At least the specialist dispatch
  });

  test("parallel dispatch — two agents at once", async () => {
    const dispatched: string[] = [];
    const deps = createMockDeps({
      callSpecialist: async (agent, task) => {
        dispatched.push(agent);
        return { agent, status: "completed", output: `${agent} done`, tokens_used: 500, duration_ms: 3000 };
      },
    });

    const result = await runCoordinatorLoop({
      message: "Update dashboard and check briefing",
      channel: "telegram",
      userId: "dave",
      foundation: "software-dev",
      systemPrompt: "You are Ellie.",
      model: "claude-sonnet-4-6",
      agentRoster: ["james", "jason"],
      deps,
      _testResponses: [
        // Loop 1: dispatch two agents in parallel
        {
          stop_reason: "tool_use",
          content: [
            { type: "text", text: "Two tasks — dispatching both." },
            { type: "tool_use", id: "tu_1", name: "dispatch_agent", input: { agent: "james", task: "Update dashboard header" } },
            { type: "tool_use", id: "tu_2", name: "dispatch_agent", input: { agent: "jason", task: "Check morning briefing cron" } },
            { type: "tool_use", id: "tu_3", name: "update_user", input: { message: "James is on the dashboard, Jason is checking the cron." } },
          ],
          usage: { input_tokens: 5000, output_tokens: 300 },
        },
        // Loop 2: synthesize and complete
        {
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: "tu_4", name: "complete", input: { response: "Both done. Dashboard updated, cron restarted." } },
          ],
          usage: { input_tokens: 7000, output_tokens: 150 },
        },
      ],
    });

    expect(dispatched).toContain("james");
    expect(dispatched).toContain("jason");
    expect(result.response).toContain("Both done");
    expect(result.loopIterations).toBe(2);
  });

  test("max iterations safety rail triggers", async () => {
    // Return dispatch_agent calls forever — should hit max iterations
    const infiniteResponses = Array.from({ length: 15 }, (_, i) => ({
      stop_reason: "tool_use" as const,
      content: [
        { type: "tool_use" as const, id: `tu_${i}`, name: "dispatch_agent" as const, input: { agent: "james", task: `Task ${i}` } },
      ],
      usage: { input_tokens: 5000, output_tokens: 100 },
    }));

    const result = await runCoordinatorLoop({
      message: "Do everything",
      channel: "telegram",
      userId: "dave",
      foundation: "software-dev",
      systemPrompt: "You are Ellie.",
      model: "claude-sonnet-4-6",
      agentRoster: ["james"],
      deps: createMockDeps(),
      maxIterations: 3,
      _testResponses: infiniteResponses,
    });

    expect(result.loopIterations).toBe(3);
    expect(result.hitSafetyRail).toBe(true);
    expect(result.response).toBeTruthy(); // Auto-generated summary
  });

  test("specialist error flows back to coordinator", async () => {
    const deps = createMockDeps({
      callSpecialist: async (agent, _task) => ({
        agent,
        status: "error" as const,
        output: "",
        error: "timeout after 900s",
        tokens_used: 0,
        duration_ms: 900000,
      }),
    });

    const result = await runCoordinatorLoop({
      message: "Deploy the app",
      channel: "telegram",
      userId: "dave",
      foundation: "software-dev",
      systemPrompt: "You are Ellie.",
      model: "claude-sonnet-4-6",
      agentRoster: ["james"],
      deps,
      _testResponses: [
        // Loop 1: dispatch james
        {
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: "tu_1", name: "dispatch_agent", input: { agent: "james", task: "Deploy" } },
          ],
          usage: { input_tokens: 5000, output_tokens: 100 },
        },
        // Loop 2: coordinator sees the error and completes
        {
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: "tu_2", name: "complete", input: { response: "James timed out during deploy. I'll check if it went through." } },
          ],
          usage: { input_tokens: 6000, output_tokens: 100 },
        },
      ],
    });

    expect(result.response).toContain("timed out");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ellie/ellie-dev && bun test tests/coordinator.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the coordinator loop implementation**

```typescript
// src/coordinator.ts
/**
 * Coordinator Loop — Ellie's thinking brain.
 *
 * Maintains a conversation with Claude via the Messages API.
 * Think-Act-Observe-Think cycle: receives user message, decomposes into tasks,
 * dispatches specialists, synthesizes results, responds.
 *
 * Specialists continue running as CLI subprocesses.
 * This module only handles the coordinator's thinking and tool execution.
 */

import Anthropic from "@anthropic-ai/sdk";
import { log } from "./logger.ts";
import { CoordinatorContext } from "./coordinator-context.ts";
import {
  COORDINATOR_TOOL_DEFINITIONS,
  type DispatchAgentInput,
  type AskUserInput,
  type ReadContextInput,
  type UpdateUserInput,
  type CompleteInput,
  type InvokeRecipeInput,
} from "./coordinator-tools.ts";
import {
  createEnvelope,
  completeEnvelope,
  failEnvelope,
  type DispatchEnvelope,
} from "./dispatch-envelope.ts";

const logger = log.child("coordinator");

// ── Types ──────────────────────────────────────────────────

export interface SpecialistResult {
  agent: string;
  status: "completed" | "error";
  output: string;
  error?: string;
  tokens_used: number;
  duration_ms: number;
}

export interface CoordinatorDeps {
  callSpecialist: (agent: string, task: string, context?: string, timeoutMs?: number) => Promise<SpecialistResult>;
  sendMessage: (channel: string, message: string) => Promise<void>;
  readForest: (query: string) => Promise<string>;
  readPlane: (query: string) => Promise<string>;
  readMemory: (query: string) => Promise<string>;
  readSessions: (query: string) => Promise<string>;
  getWorkingMemorySummary: () => Promise<string>;
  updateWorkingMemory: (sections: Record<string, string>) => Promise<void>;
  promoteToForest: () => Promise<void>;
  logEnvelope: (envelope: DispatchEnvelope) => Promise<void>;
}

export interface CoordinatorOpts {
  message: string;
  channel: string;
  userId: string;
  foundation: string;
  systemPrompt: string;
  model: string;
  agentRoster: string[];
  deps: CoordinatorDeps;
  maxIterations?: number;
  sessionTimeoutMs?: number;
  costCapUsd?: number;
  workItemId?: string;
  // Testing: inject mock API responses instead of calling Anthropic
  _testResponses?: Array<{
    stop_reason: string;
    content: Array<Record<string, unknown>>;
    usage: { input_tokens: number; output_tokens: number };
  }>;
}

export interface CoordinatorResult {
  response: string;
  loopIterations: number;
  envelopes: DispatchEnvelope[];
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
  hitSafetyRail: boolean;
  durationMs: number;
}

// ── Coordinator Loop ───────────────────────────────────────

export async function runCoordinatorLoop(opts: CoordinatorOpts): Promise<CoordinatorResult> {
  const {
    message,
    channel,
    foundation,
    systemPrompt,
    model,
    agentRoster,
    deps,
    maxIterations = 10,
    sessionTimeoutMs = 20 * 60 * 1000,
    costCapUsd = 2.0,
    workItemId,
    _testResponses,
  } = opts;

  const startTime = Date.now();
  const ctx = new CoordinatorContext({
    systemPrompt: buildSystemPrompt(systemPrompt, agentRoster, foundation),
    maxTokens: model.includes("opus") ? 1_000_000 : 200_000,
  });

  const coordinatorEnvelope = createEnvelope({
    type: "coordinator",
    agent: "ellie",
    foundation,
    model,
    work_item_id: workItemId,
  });

  const envelopes: DispatchEnvelope[] = [coordinatorEnvelope];
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let iteration = 0;
  let finalResponse = "";
  let hitSafetyRail = false;
  let testResponseIndex = 0;

  // Initialize Anthropic client (skipped in test mode)
  const client = _testResponses ? null : new Anthropic();

  // Add the user's message to the conversation
  ctx.addUserMessage(message);

  // ── The Loop ───────────────────────────────────────────
  while (iteration < maxIterations) {
    iteration++;

    // Safety: check wall-clock timeout
    if (Date.now() - startTime > sessionTimeoutMs) {
      logger.warn("Coordinator session timeout", { iteration, elapsedMs: Date.now() - startTime });
      hitSafetyRail = true;
      finalResponse = `I ran out of time coordinating this request. Here's what happened so far:\n${ctx.getCompactionSummary()}`;
      break;
    }

    // Safety: check cost cap
    const currentCost = envelopes.reduce((sum, e) => sum + e.cost_usd, 0);
    if (currentCost >= costCapUsd) {
      logger.warn("Coordinator cost cap hit", { currentCost, cap: costCapUsd });
      hitSafetyRail = true;
      finalResponse = `I've reached the cost limit for this session ($${costCapUsd.toFixed(2)}). Here's what was accomplished:\n${ctx.getCompactionSummary()}`;
      break;
    }

    // ── THINK: Call the Messages API ─────────────────────
    let apiResponse: {
      stop_reason: string;
      content: Array<Record<string, unknown>>;
      usage: { input_tokens: number; output_tokens: number };
    };

    if (_testResponses) {
      // Test mode: use injected responses
      apiResponse = _testResponses[testResponseIndex++]!;
      if (!apiResponse) {
        hitSafetyRail = true;
        finalResponse = "Test: ran out of mock responses";
        break;
      }
    } else {
      // Production: call Anthropic Messages API
      try {
        const response = await client!.messages.create({
          model,
          max_tokens: 4096,
          system: ctx.getSystemPrompt(),
          messages: ctx.getMessages(),
          tools: COORDINATOR_TOOL_DEFINITIONS,
        });
        apiResponse = {
          stop_reason: response.stop_reason ?? "end_turn",
          content: response.content as Array<Record<string, unknown>>,
          usage: response.usage,
        };
      } catch (err) {
        const error = err as Error;
        logger.error("Coordinator API call failed", { error: error.message, iteration });

        // Handle specific API errors
        if (error.message?.includes("rate_limit") || (error as Record<string, unknown>).status === 429) {
          await new Promise(r => setTimeout(r, 5000 * iteration)); // Exponential backoff
          continue; // Retry this iteration
        }

        hitSafetyRail = true;
        finalResponse = `I encountered an error while thinking about your request. Please try again.`;
        break;
      }
    }

    // Track tokens
    totalTokensIn += apiResponse.usage.input_tokens;
    totalTokensOut += apiResponse.usage.output_tokens;
    ctx.recordTokenUsage(apiResponse.usage.input_tokens);

    // Add assistant response to conversation
    ctx.addAssistantMessage(apiResponse.content as Anthropic.ContentBlockParam[]);

    // ── ACT: If stop_reason is "end_turn", the coordinator responded with text only
    if (apiResponse.stop_reason === "end_turn") {
      // Extract text from content blocks
      const textBlocks = apiResponse.content.filter(b => b.type === "text");
      finalResponse = textBlocks.map(b => b.text as string).join("\n");
      break;
    }

    // ── ACT: Process tool calls ──────────────────────────
    const toolCalls = apiResponse.content.filter(b => b.type === "tool_use");
    if (toolCalls.length === 0) {
      // No tool calls and no end_turn — shouldn't happen, but handle gracefully
      const textBlocks = apiResponse.content.filter(b => b.type === "text");
      finalResponse = textBlocks.map(b => b.text as string).join("\n") || "I'm not sure how to help with that.";
      break;
    }

    // Check for `complete` tool — signals loop exit
    const completeCall = toolCalls.find(tc => tc.name === "complete");
    if (completeCall) {
      const input = completeCall.input as CompleteInput;
      finalResponse = input.response;

      if (input.promote_to_memory) {
        try { await deps.promoteToForest(); } catch (e) { logger.warn("Promote failed", { error: String(e) }); }
      }
      break;
    }

    // Execute all tool calls (dispatch_agent calls run in parallel)
    const dispatchCalls = toolCalls.filter(tc => tc.name === "dispatch_agent");
    const otherCalls = toolCalls.filter(tc => tc.name !== "dispatch_agent" && tc.name !== "complete");

    // Run dispatches in parallel
    const dispatchResults = await Promise.all(
      dispatchCalls.map(async (tc) => {
        const input = tc.input as DispatchAgentInput;

        // Validate agent is in roster
        if (!agentRoster.includes(input.agent)) {
          return { id: tc.id as string, result: `Error: Agent '${input.agent}' is not in the active foundation roster. Available: ${agentRoster.join(", ")}` };
        }

        const specialistEnv = createEnvelope({
          type: "specialist",
          agent: input.agent,
          foundation,
          parent_id: coordinatorEnvelope.id,
          model: "unknown", // CLI subprocess — model determined by specialist config
          work_item_id: workItemId,
        });

        try {
          const result = await deps.callSpecialist(
            input.agent,
            input.task,
            input.context,
            input.timeout_ms,
          );

          const completed = completeEnvelope(specialistEnv, {
            tokens_in: result.tokens_used,
            tokens_out: 0, // CLI doesn't give us this breakdown
          });
          envelopes.push(completed);
          await deps.logEnvelope(completed);

          if (result.status === "error") {
            return { id: tc.id as string, result: `Error from ${input.agent}: ${result.error || "Unknown error"}` };
          }
          return { id: tc.id as string, result: result.output };
        } catch (err) {
          const failed = failEnvelope(specialistEnv, String(err));
          envelopes.push(failed);
          await deps.logEnvelope(failed);
          return { id: tc.id as string, result: `Error dispatching ${input.agent}: ${String(err)}` };
        }
      })
    );

    // Execute other tool calls sequentially
    const otherResults = await Promise.all(
      otherCalls.map(async (tc) => {
        const name = tc.name as string;
        const input = tc.input as Record<string, unknown>;

        switch (name) {
          case "ask_user": {
            const askInput = input as AskUserInput;
            await deps.sendMessage(channel, askInput.question);
            // In production, this would pause and wait for user reply.
            // For now, return a placeholder — the ask_user pause mechanism
            // will be wired in the Telegram handler integration (Task 5).
            return { id: tc.id as string, result: JSON.stringify({ response: null, timed_out: false, note: "ask_user requires handler integration" }) };
          }
          case "update_user": {
            const updateInput = input as UpdateUserInput;
            await deps.sendMessage(updateInput.channel || channel, updateInput.message);
            return { id: tc.id as string, result: JSON.stringify({ sent: true }) };
          }
          case "read_context": {
            const readInput = input as ReadContextInput;
            let result: string;
            switch (readInput.source) {
              case "forest": result = await deps.readForest(readInput.query); break;
              case "plane": result = await deps.readPlane(readInput.query); break;
              case "memory": result = await deps.readMemory(readInput.query); break;
              case "sessions": result = await deps.readSessions(readInput.query); break;
              default: result = `Unknown source: ${readInput.source}`;
            }
            return { id: tc.id as string, result };
          }
          case "invoke_recipe": {
            const recipeInput = input as InvokeRecipeInput;
            // Recipes will be implemented in Phase 2 (Foundation System)
            return { id: tc.id as string, result: `Recipe '${recipeInput.recipe_name}' not yet available. Dispatching agents directly is recommended for now.` };
          }
          default:
            return { id: tc.id as string, result: `Unknown tool: ${name}` };
        }
      })
    );

    // ── OBSERVE: Feed all results back into the conversation ──
    const allResults = [...dispatchResults, ...otherResults];
    for (const { id, result } of allResults) {
      ctx.addToolResult(id, result);
    }

    // ── Context pressure check after each iteration ──
    const pressure = ctx.getPressure();
    if (pressure !== "normal") {
      logger.info("Context pressure detected", { pressure, iteration });
      if (pressure === "critical") {
        const wmSummary = await deps.getWorkingMemorySummary();
        ctx.rebuildFromSummary(wmSummary);
      } else {
        ctx.compact(pressure);
      }

      // Update working memory with current state
      try {
        await deps.updateWorkingMemory({
          conversation_thread: ctx.getCompactionSummary(),
          context_anchors: `Coordinator loop iteration ${iteration}, pressure: ${pressure}`,
        });
      } catch { /* non-critical */ }
    }
  }

  // If we exhausted iterations without completing
  if (!finalResponse && iteration >= maxIterations) {
    hitSafetyRail = true;
    finalResponse = `I reached the maximum coordination steps (${maxIterations}). Here's what was done:\n${ctx.getCompactionSummary()}`;
  }

  // Complete the coordinator envelope
  const completedCoordinator = completeEnvelope(coordinatorEnvelope, {
    tokens_in: totalTokensIn,
    tokens_out: totalTokensOut,
    model,
  });
  envelopes[0] = completedCoordinator;
  await deps.logEnvelope(completedCoordinator);

  const durationMs = Date.now() - startTime;
  logger.info("Coordinator loop complete", {
    iterations: iteration,
    totalTokensIn,
    totalTokensOut,
    totalCost: completedCoordinator.cost_usd,
    durationMs,
    hitSafetyRail,
    envelopes: envelopes.length,
  });

  return {
    response: finalResponse,
    loopIterations: iteration,
    envelopes,
    totalTokensIn,
    totalTokensOut,
    totalCostUsd: envelopes.reduce((sum, e) => sum + e.cost_usd, 0),
    hitSafetyRail,
    durationMs,
  };
}

// ── Helpers ────────────────────────────────────────────────

function buildSystemPrompt(base: string, agentRoster: string[], foundation: string): string {
  return `${base}

## Active Foundation: ${foundation}

## Your Agent Team
You have the following specialist agents available: ${agentRoster.join(", ")}

## How You Work
1. Analyze the user's request and decompose it into tasks
2. Dispatch specialists using the dispatch_agent tool — use multiple in parallel when tasks are independent
3. Send progress updates to the user with update_user while specialists work
4. When results come back, synthesize them into a clear response
5. Call the complete tool to deliver your final response

## Rules
- ALWAYS call the complete tool when you're done — the loop won't exit without it
- If a specialist fails, think about what to do: retry, try a different agent, ask the user, or report the failure
- For simple questions you can answer directly, just call complete with your response — no need to dispatch agents
- Keep the user informed with update_user when dispatching takes time`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ellie/ellie-dev && bun test tests/coordinator.test.ts`
Expected: 4 pass, 0 fail

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-dev && git add src/coordinator.ts tests/coordinator.test.ts && git commit -m "[ELLIE-1092] feat: add coordinator loop with think-act-observe-think cycle"
```

---

### Task 5: Wire Coordinator into Telegram Handlers

**Files:**
- Modify: `src/telegram-handlers.ts` (around lines 140-680)
- Test: `tests/coordinator.test.ts` (add integration test)

- [ ] **Step 1: Write the failing integration test**

Add to `tests/coordinator.test.ts`:

```typescript
describe("Coordinator integration", () => {
  test("buildCoordinatorDeps returns all required functions", async () => {
    // This test verifies the deps adapter exists and has the right shape
    const { buildCoordinatorDeps } = await import("../src/coordinator");

    expect(typeof buildCoordinatorDeps).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ellie/ellie-dev && bun test tests/coordinator.test.ts`
Expected: FAIL — `buildCoordinatorDeps` is not exported

- [ ] **Step 3: Add `buildCoordinatorDeps` to coordinator.ts**

Add this function at the bottom of `src/coordinator.ts`:

```typescript
// ── Dependency Builder ─────────────────────────────────────
// Bridges the coordinator's abstract deps to actual relay infrastructure.
// Called from telegram-handlers.ts and google-chat.ts.

import { callClaude } from "./claude-cli.ts";
import {
  readWorkingMemory,
  updateWorkingMemory as wmUpdate,
} from "./working-memory.ts";
import { emitEvent } from "./orchestration-ledger.ts";

export function buildCoordinatorDeps(opts: {
  sessionId: string;
  channel: string;
  sendFn: (channel: string, message: string) => Promise<void>;
  forestReadFn: (query: string) => Promise<string>;
  planeReadFn: (query: string) => Promise<string>;
}): CoordinatorDeps {
  return {
    callSpecialist: async (agent, task, context, timeoutMs) => {
      const prompt = context ? `${task}\n\nContext: ${context}` : task;
      const startMs = Date.now();
      try {
        const output = await callClaude(prompt, {
          allowedTools: undefined, // Use agent's configured tools
          model: undefined,       // Use agent's configured model
          timeoutMs: timeoutMs ?? 900_000,
        });
        return {
          agent,
          status: "completed" as const,
          output,
          tokens_used: 0, // CLI doesn't report tokens
          duration_ms: Date.now() - startMs,
        };
      } catch (err) {
        return {
          agent,
          status: "error" as const,
          output: "",
          error: String(err),
          tokens_used: 0,
          duration_ms: Date.now() - startMs,
        };
      }
    },

    sendMessage: opts.sendFn,

    readForest: opts.forestReadFn,

    readPlane: opts.planeReadFn,

    readMemory: async (query) => {
      const wm = await readWorkingMemory({ session_id: opts.sessionId, agent: "ellie" });
      if (!wm) return "No working memory found.";
      const sections = Object.entries(wm)
        .filter(([k, v]) => v && typeof v === "string" && (v as string).toLowerCase().includes(query.toLowerCase()))
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n");
      return sections || `No working memory matches for: ${query}`;
    },

    readSessions: async (_query) => {
      return "Session listing not yet implemented.";
    },

    getWorkingMemorySummary: async () => {
      const wm = await readWorkingMemory({ session_id: opts.sessionId, agent: "ellie" });
      if (!wm) return "";
      return Object.entries(wm)
        .filter(([_, v]) => v && typeof v === "string")
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n\n");
    },

    updateWorkingMemory: async (sections) => {
      await wmUpdate({ session_id: opts.sessionId, agent: "ellie", sections });
    },

    promoteToForest: async () => {
      // Will be wired to promoteToRiver in Phase 2
    },

    logEnvelope: async (envelope) => {
      emitEvent(
        envelope.id,
        envelope.status === "completed" ? "completed" : envelope.status === "error" ? "failed" : "dispatched",
        envelope.agent,
        envelope.work_item_id,
        {
          type: envelope.type,
          foundation: envelope.foundation,
          parent_id: envelope.parent_id,
          tokens_in: envelope.tokens_in,
          tokens_out: envelope.tokens_out,
          cost_usd: envelope.cost_usd,
          model: envelope.model,
          duration_ms: envelope.completed_at && envelope.started_at
            ? new Date(envelope.completed_at).getTime() - new Date(envelope.started_at).getTime()
            : 0,
        },
      );
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ellie/ellie-dev && bun test tests/coordinator.test.ts`
Expected: 5 pass, 0 fail

- [ ] **Step 5: Add feature-flagged coordinator path to telegram-handlers.ts**

In `src/telegram-handlers.ts`, add the import at the top (near other imports):

```typescript
import { runCoordinatorLoop, buildCoordinatorDeps } from "./coordinator.ts";
```

Then, find the section around line 598 where `callClaudeWithTyping` is called, and add a feature-flagged branch before it:

```typescript
  // ── COORDINATOR MODE (feature flag) ──────────────────────
  const COORDINATOR_MODE = process.env.COORDINATOR_MODE === "true";

  if (COORDINATOR_MODE) {
    // Send typing indicator
    await ctx.replyWithChatAction("typing");
    const typingInterval = setInterval(() => ctx.replyWithChatAction("typing").catch(() => {}), 4000);

    try {
      const coordinatorResult = await runCoordinatorLoop({
        message: effectiveText,
        channel: "telegram",
        userId: userId,
        foundation: "software-dev", // Hardcoded for Phase 1
        systemPrompt: enrichedPrompt,
        model: agentModel || "claude-sonnet-4-6",
        agentRoster: ["james", "brian", "kate", "alan", "jason", "amy", "marcus"],
        deps: buildCoordinatorDeps({
          sessionId: session.sessionId,
          channel: "telegram",
          sendFn: async (_ch, msg) => { await ctx.reply(msg); },
          forestReadFn: async (query) => {
            const res = await fetch("http://localhost:3001/api/bridge/read", {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-bridge-key": process.env.BRIDGE_KEY || "" },
              body: JSON.stringify({ query, scope_path: "2" }),
            });
            const data = await res.json() as { memories?: Array<{ content: string }> };
            return data.memories?.map(m => m.content).join("\n") || "No results.";
          },
          planeReadFn: async (query) => `Plane lookup not yet integrated for coordinator. Query: ${query}`,
        }),
        workItemId: detectedWorkItem || undefined,
      });

      clearInterval(typingInterval);

      // Send the coordinator's response
      const cleanedResponse = await sendWithApprovals(ctx, coordinatorResult.response, session.sessionId, "ellie");
      await saveMessage("assistant", cleanedResponse, undefined, "telegram", userId);

      // Log coordinator metrics
      logger.info("Coordinator response", {
        iterations: coordinatorResult.loopIterations,
        tokensIn: coordinatorResult.totalTokensIn,
        tokensOut: coordinatorResult.totalTokensOut,
        cost: coordinatorResult.totalCostUsd,
        hitRail: coordinatorResult.hitSafetyRail,
        duration: coordinatorResult.durationMs,
        envelopes: coordinatorResult.envelopes.length,
      });

      return; // Skip the old dispatch path
    } catch (err) {
      clearInterval(typingInterval);
      logger.error("Coordinator mode failed, falling back to direct dispatch", { error: String(err) });
      // Fall through to existing dispatch path
    }
  }
```

- [ ] **Step 6: Commit**

```bash
cd /home/ellie/ellie-dev && git add src/coordinator.ts src/telegram-handlers.ts tests/coordinator.test.ts && git commit -m "[ELLIE-1092] feat: wire coordinator loop into Telegram handlers with feature flag"
```

---

### Task 6: Wire Coordinator into Google Chat

**Files:**
- Modify: `src/google-chat.ts`

- [ ] **Step 1: Read the current Google Chat message handler**

Run: `cd /home/ellie/ellie-dev && grep -n "async.*message\|callClaude\|routeAndDispatch\|sendGoogleChat" src/google-chat.ts | head -20`

Identify where the dispatch currently happens.

- [ ] **Step 2: Add the same feature-flagged coordinator path**

Add the import at the top of `src/google-chat.ts`:

```typescript
import { runCoordinatorLoop, buildCoordinatorDeps } from "./coordinator.ts";
```

Then add the same `COORDINATOR_MODE` branch at the message handling point, adapted for Google Chat's `sendGoogleChatMessage` function instead of `ctx.reply`. The pattern is identical to Telegram — feature flag check, coordinator loop, fallback to existing dispatch on error.

- [ ] **Step 3: Commit**

```bash
cd /home/ellie/ellie-dev && git add src/google-chat.ts && git commit -m "[ELLIE-1092] feat: wire coordinator into Google Chat with feature flag"
```

---

### Task 7: End-to-End Validation

**Files:**
- Modify: `.env` (add `COORDINATOR_MODE=true`)

- [ ] **Step 1: Run the full test suite**

Run: `cd /home/ellie/ellie-dev && bun test`
Expected: All existing tests pass, plus the new coordinator tests

- [ ] **Step 2: Enable coordinator mode**

Add to `/home/ellie/ellie-dev/.env`:

```
COORDINATOR_MODE=true
```

- [ ] **Step 3: Restart the relay**

Run: `systemctl --user restart claude-telegram-relay`

- [ ] **Step 4: Test simple single-agent request**

Send on Telegram: "What's the status of ELLIE-1092?"

Expected: Ellie thinks, dispatches one agent or uses read_context, synthesizes, responds. Check logs:

Run: `journalctl --user -u claude-telegram-relay -f --no-pager | grep coordinator`

- [ ] **Step 5: Test multi-part decomposition**

Send on Telegram: "Check if the relay is healthy and also tell me what tickets are in progress"

Expected: Ellie decomposes into two tasks, dispatches in parallel, sends a progress update, synthesizes both results.

- [ ] **Step 6: Test direct response (no dispatch needed)**

Send on Telegram: "Hey Ellie, how's it going?"

Expected: Ellie responds directly via `complete` without dispatching any specialists.

- [ ] **Step 7: Disable coordinator and verify fallback**

Set `COORDINATOR_MODE=false` in `.env`, restart relay, send a test message. Verify existing dispatch path still works.

- [ ] **Step 8: Re-enable and commit final state**

Set `COORDINATOR_MODE=true`, restart relay.

```bash
cd /home/ellie/ellie-dev && git add .env && git commit -m "[ELLIE-1092] feat: enable coordinator mode by default"
```

---

## Summary

| Task | What It Builds | Files | Tests |
|------|---------------|-------|-------|
| 1 | Dispatch Envelope | `src/dispatch-envelope.ts` | 6 tests |
| 2 | Coordinator Tool Definitions | `src/coordinator-tools.ts` | 4 tests |
| 3 | Context Manager | `src/coordinator-context.ts` | 10 tests |
| 4 | Coordinator Loop | `src/coordinator.ts` | 4 tests |
| 5 | Telegram Integration | `src/telegram-handlers.ts` (modify) | 1 test |
| 6 | Google Chat Integration | `src/google-chat.ts` (modify) | — |
| 7 | End-to-End Validation | `.env` | Manual testing |

**Total:** 4 new files, 2 modified files, 4 test files, ~25 automated tests, 7 commits.
