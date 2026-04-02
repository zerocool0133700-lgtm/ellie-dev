/**
 * Tests for coordinator-tools.ts
 *
 * Covers: COORDINATOR_TOOL_DEFINITIONS shape and CoordinatorToolName type.
 * These tool definitions are passed to the Anthropic Messages API as the
 * `tools` parameter for the coordinator (Ellie) loop.
 */

import { describe, test, expect } from "bun:test";
import {
  COORDINATOR_TOOL_DEFINITIONS,
  type CoordinatorToolName,
} from "../src/coordinator-tools.ts";

// ── 1. All 6 tools are defined ──────────────────────────────────

describe("COORDINATOR_TOOL_DEFINITIONS", () => {
  const EXPECTED_TOOLS: CoordinatorToolName[] = [
    "dispatch_agent",
    "ask_user",
    "invoke_recipe",
    "read_context",
    "update_user",
    "complete",
  ];

  test("defines all 6 expected tools", () => {
    const names = COORDINATOR_TOOL_DEFINITIONS.map((t) => t.name);
    for (const expected of EXPECTED_TOOLS) {
      expect(names).toContain(expected);
    }
    expect(COORDINATOR_TOOL_DEFINITIONS).toHaveLength(6);
  });

  // ── 2. Each tool has name, description, input_schema with type "object" ──

  test("each tool has name, description, and input_schema typed as object", () => {
    for (const tool of COORDINATOR_TOOL_DEFINITIONS) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);

      expect(typeof tool.description).toBe("string");
      expect((tool.description as string).length).toBeGreaterThan(0);

      expect(tool.input_schema).toBeDefined();
      expect(tool.input_schema.type).toBe("object");
    }
  });

  // ── 3. dispatch_agent requires agent and task ─────────────────

  test("dispatch_agent requires agent and task fields", () => {
    const tool = COORDINATOR_TOOL_DEFINITIONS.find(
      (t) => t.name === "dispatch_agent"
    );
    expect(tool).toBeDefined();

    const schema = tool!.input_schema as {
      required?: string[];
      properties: Record<string, unknown>;
    };

    expect(schema.required).toContain("agent");
    expect(schema.required).toContain("task");
    expect(schema.properties["agent"]).toBeDefined();
    expect(schema.properties["task"]).toBeDefined();
  });

  // ── 4. complete requires response ────────────────────────────

  test("complete requires response field", () => {
    const tool = COORDINATOR_TOOL_DEFINITIONS.find(
      (t) => t.name === "complete"
    );
    expect(tool).toBeDefined();

    const schema = tool!.input_schema as {
      required?: string[];
      properties: Record<string, unknown>;
    };

    expect(schema.required).toContain("response");
    expect(schema.properties["response"]).toBeDefined();
  });

  // ── 5. ask_user mandatory question metadata (ELLIE-1270) ─────

  test("ask_user requires question, what_i_need, and decision_unlocked", () => {
    const tool = COORDINATOR_TOOL_DEFINITIONS.find(
      (t) => t.name === "ask_user"
    );
    expect(tool).toBeDefined();

    const schema = tool!.input_schema as {
      required?: string[];
      properties: Record<string, unknown>;
    };

    expect(schema.required).toContain("question");
    expect(schema.required).toContain("what_i_need");
    expect(schema.required).toContain("decision_unlocked");
  });

  test("ask_user has answer_format with enum ['text', 'choice', 'approve_deny']", () => {
    const tool = COORDINATOR_TOOL_DEFINITIONS.find(
      (t) => t.name === "ask_user"
    );
    expect(tool).toBeDefined();

    const schema = tool!.input_schema as {
      properties: Record<string, { type?: string; enum?: string[] }>;
    };

    const answerFormat = schema.properties["answer_format"];
    expect(answerFormat).toBeDefined();
    expect(answerFormat.enum).toBeDefined();
    expect(answerFormat.enum).toContain("text");
    expect(answerFormat.enum).toContain("choice");
    expect(answerFormat.enum).toContain("approve_deny");
    expect(answerFormat.enum).toHaveLength(3);
  });

  test("ask_user has choices as an array of strings", () => {
    const tool = COORDINATOR_TOOL_DEFINITIONS.find(
      (t) => t.name === "ask_user"
    );
    expect(tool).toBeDefined();

    const schema = tool!.input_schema as {
      properties: Record<string, { type?: string; items?: { type?: string } }>;
    };

    const choices = schema.properties["choices"];
    expect(choices).toBeDefined();
    expect(choices.type).toBe("array");
    expect(choices.items).toBeDefined();
    expect(choices.items!.type).toBe("string");
  });

  test("ask_user still has backward-compatible options, timeout_ms, and urgency fields", () => {
    const tool = COORDINATOR_TOOL_DEFINITIONS.find(
      (t) => t.name === "ask_user"
    );
    expect(tool).toBeDefined();

    const schema = tool!.input_schema as {
      properties: Record<string, unknown>;
    };

    expect(schema.properties["options"]).toBeDefined();
    expect(schema.properties["timeout_ms"]).toBeDefined();
    expect(schema.properties["urgency"]).toBeDefined();
  });
});
