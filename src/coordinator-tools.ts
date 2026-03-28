/**
 * Coordinator Tool Definitions — Task 2 of the coordinator loop plan
 *
 * Exports COORDINATOR_TOOL_DEFINITIONS (Anthropic.Tool[]) to be passed as
 * the `tools` parameter to the Anthropic Messages API when running the
 * coordinator (Ellie) loop.
 *
 * The coordinator uses these tools to dispatch specialists, ask questions,
 * read context, send updates, and deliver a final response.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { log } from "./logger.ts";

const _logger = log.child("coordinator-tools");

// ── TypeScript interfaces for each tool's input ──────────────────────────────

export interface DispatchAgentInput {
  /** Identifier of the specialist agent to invoke (e.g. "james", "kate") */
  agent: string;
  /** Instruction for the specialist agent */
  task: string;
  /** Optional extra context to include with the task */
  context?: string;
  /** Maximum time to wait for the agent's response, in milliseconds */
  timeout_ms?: number;
  /** Scheduling priority: "critical" | "high" | "medium" | "low" */
  priority?: string;
}

export interface AskUserInput {
  /** The question to display to the user */
  question: string;
  /** Optional list of suggested answer options */
  options?: string[];
  /** Maximum time to wait for the user's answer, in milliseconds */
  timeout_ms?: number;
  /** Urgency level: "low" | "normal" | "high" */
  urgency?: string;
}

export interface InvokeRecipeInput {
  /** Name of the coordination recipe to run */
  recipe_name: string;
  /** Input payload to pass to the recipe */
  input: Record<string, unknown>;
  /** Override the default agent list for this recipe invocation */
  agents_override?: string[];
}

export interface ReadContextInput {
  /** Where to fetch information from */
  source: "forest" | "plane" | "memory" | "sessions";
  /** Natural-language query or identifier */
  query: string;
}

export interface UpdateUserInput {
  /** Progress message to send to the user */
  message: string;
  /** Delivery channel override (e.g. "telegram", "google-chat") */
  channel?: string;
}

export interface CompleteInput {
  /** Final response to deliver to the user */
  response: string;
  /** Whether to promote key decisions to long-term Forest memory */
  promote_to_memory?: boolean;
  /** Whether to update the associated Plane ticket when finishing */
  update_plane?: boolean;
}

// ── Tool name union type ──────────────────────────────────────────────────────

export type CoordinatorToolName =
  | "dispatch_agent"
  | "ask_user"
  | "invoke_recipe"
  | "read_context"
  | "update_user"
  | "complete";

// ── Tool definitions ──────────────────────────────────────────────────────────

export const COORDINATOR_TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "dispatch_agent",
    description:
      "Send a task to a specialist agent (e.g. developer, researcher, strategist). " +
      "The agent will execute the task and return a result. Use this to delegate focused " +
      "work rather than attempting it directly.",
    input_schema: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          description:
            "Identifier of the specialist to invoke (e.g. 'james', 'kate', 'alan').",
        },
        task: {
          type: "string",
          description: "Clear instruction describing what the specialist should do.",
        },
        context: {
          type: "string",
          description: "Optional additional context or background to include with the task.",
        },
        timeout_ms: {
          type: "number",
          description: "Maximum milliseconds to wait for the agent to respond. Default: 120000.",
        },
        priority: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
          description: "Scheduling priority for the dispatch. Default: 'medium'.",
        },
      },
      required: ["agent", "task"],
    },
  },

  {
    name: "ask_user",
    description:
      "Pause the coordinator loop and ask the user a question. Use when you need " +
      "clarification or a decision before proceeding. The loop resumes when the user responds.",
    input_schema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to present to the user.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of suggested answer choices to display.",
        },
        timeout_ms: {
          type: "number",
          description: "Maximum milliseconds to wait for a reply before timing out.",
        },
        urgency: {
          type: "string",
          enum: ["low", "normal", "high"],
          description: "Urgency level for the question. Affects how it is displayed.",
        },
      },
      required: ["question"],
    },
  },

  {
    name: "invoke_recipe",
    description:
      "Run a named coordination recipe — a predefined multi-agent workflow such as a " +
      "formation or round table. Use when a structured protocol already exists for the task.",
    input_schema: {
      type: "object",
      properties: {
        recipe_name: {
          type: "string",
          description: "Name of the recipe to invoke (e.g. 'architecture-review', 'content-pipeline').",
        },
        input: {
          type: "object",
          description: "Input payload to pass to the recipe.",
        },
        agents_override: {
          type: "array",
          items: { type: "string" },
          description: "Override the recipe's default agent list for this invocation.",
        },
      },
      required: ["recipe_name", "input"],
    },
  },

  {
    name: "read_context",
    description:
      "Fetch lightweight contextual information before acting. Use to query the Forest " +
      "knowledge base, Plane tickets, agent memory, or active sessions without dispatching " +
      "a full specialist.",
    input_schema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: ["forest", "plane", "memory", "sessions"],
          description: "Where to look: 'forest' (knowledge), 'plane' (tickets), 'memory' (agent memory), 'sessions' (active agent sessions).",
        },
        query: {
          type: "string",
          description: "Natural-language query or identifier to look up.",
        },
      },
      required: ["source", "query"],
    },
  },

  {
    name: "update_user",
    description:
      "Send a brief progress message to the user. Use to keep them informed while " +
      "longer work is in progress — for example, 'Dispatched James to review the code'.",
    input_schema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Progress message to send to the user.",
        },
        channel: {
          type: "string",
          description: "Delivery channel override (e.g. 'telegram', 'google-chat'). Defaults to the active channel.",
        },
      },
      required: ["message"],
    },
  },

  {
    name: "complete",
    description:
      "End the coordinator loop and deliver the final response to the user. " +
      "Always call this when the task is finished — do not produce a bare text reply instead.",
    input_schema: {
      type: "object",
      properties: {
        response: {
          type: "string",
          description: "The final response to deliver to the user.",
        },
        promote_to_memory: {
          type: "boolean",
          description: "If true, key decisions from this session are written to long-term Forest memory.",
        },
        update_plane: {
          type: "boolean",
          description: "If true, the associated Plane ticket is updated to reflect completion.",
        },
      },
      required: ["response"],
    },
  },
];

_logger.info("Coordinator tool definitions loaded", {
  count: COORDINATOR_TOOL_DEFINITIONS.length,
  names: COORDINATOR_TOOL_DEFINITIONS.map((t) => t.name),
});
