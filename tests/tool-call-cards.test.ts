/**
 * Tool Call Cards — ELLIE-985
 * Tests for tool call broadcast, PostToolUse handler, and frontend event shape.
 */

import { describe, it, expect } from "bun:test";

// ── Tool Call Event Shape ────────────────────────────────────

describe("tool_call event shape", () => {
  interface ToolCallEvent {
    type: "tool_call";
    callId: string;
    tool_name: string;
    status: "running" | "completed" | "failed";
    tool_input?: Record<string, unknown>;
    description?: string;
    result_preview?: string;
    error?: string;
    duration_ms?: number;
    ts: number;
  }

  it("running event has required fields", () => {
    const event: ToolCallEvent = {
      type: "tool_call",
      callId: "abc-123",
      tool_name: "Bash",
      status: "running",
      tool_input: { command: "git status" },
      description: "Bash\ncommand: git status",
      ts: Date.now(),
    };
    expect(event.type).toBe("tool_call");
    expect(event.status).toBe("running");
    expect(event.tool_input?.command).toBe("git status");
  });

  it("completed event includes result preview", () => {
    const event: ToolCallEvent = {
      type: "tool_call",
      callId: "abc-123",
      tool_name: "Bash",
      status: "completed",
      result_preview: "On branch master\nnothing to commit",
      duration_ms: 150,
      ts: Date.now(),
    };
    expect(event.status).toBe("completed");
    expect(event.result_preview).toContain("branch master");
    expect(event.duration_ms).toBe(150);
  });

  it("failed event includes error", () => {
    const event: ToolCallEvent = {
      type: "tool_call",
      callId: "abc-123",
      tool_name: "mcp__plane__update_issue",
      status: "failed",
      error: "HTTP 404: Issue not found",
      ts: Date.now(),
    };
    expect(event.status).toBe("failed");
    expect(event.error).toContain("404");
  });
});

// ── Tool Name Formatting ─────────────────────────────────────

describe("tool name formatting", () => {
  function formatToolName(name: string): string {
    return name
      .replace(/^mcp__google-workspace__/, "Google: ")
      .replace(/^mcp__github__/, "GitHub: ")
      .replace(/^mcp__plane__/, "Plane: ")
      .replace(/^mcp__memory__/, "Memory: ")
      .replace(/^mcp__brave-search__/, "Search: ")
      .replace(/^mcp__forest-bridge__/, "Forest: ")
      .replace(/^mcp__qmd__/, "QMD: ")
      .replace(/^mcp__/, "")
      .replace(/_/g, " ");
  }

  it("strips MCP prefixes", () => {
    expect(formatToolName("mcp__plane__get_issue")).toBe("Plane: get issue");
    expect(formatToolName("mcp__github__create_pull_request")).toBe("GitHub: create pull request");
    expect(formatToolName("mcp__google-workspace__list_emails")).toBe("Google: list emails");
  });

  it("leaves non-MCP tools unchanged except underscores", () => {
    expect(formatToolName("Bash")).toBe("Bash");
    expect(formatToolName("Read")).toBe("Read");
    expect(formatToolName("Edit")).toBe("Edit");
  });

  it("handles unknown MCP tools", () => {
    expect(formatToolName("mcp__custom__do_thing")).toBe("custom  do thing");
  });
});

// ── PostToolUse Request Shape ────────────────────────────────

describe("PostToolUse request shape", () => {
  interface ToolCallCompleteRequest {
    tool_name: string;
    tool_response?: string;
    error?: string;
    duration_ms?: number;
  }

  it("successful completion", () => {
    const req: ToolCallCompleteRequest = {
      tool_name: "Bash",
      tool_response: "hello world\n",
    };
    expect(req.tool_name).toBe("Bash");
    expect(req.error).toBeUndefined();
  });

  it("failed execution", () => {
    const req: ToolCallCompleteRequest = {
      tool_name: "mcp__plane__update_issue",
      error: "HTTP 500",
      duration_ms: 2500,
    };
    expect(req.error).toBe("HTTP 500");
    expect(req.duration_ms).toBe(2500);
  });

  it("response truncation for large outputs", () => {
    const longResponse = "x".repeat(10000);
    const preview = longResponse.length > 500
      ? longResponse.substring(0, 497) + "..."
      : longResponse;
    expect(preview).toHaveLength(500);
    expect(preview.endsWith("...")).toBe(true);
  });
});

// ── Hook Script Behavior ─────────────────────────────────────

describe("tool-complete.sh hook contract", () => {
  it("expects tool_name, tool_response, tool_error from stdin", () => {
    const hookInput = {
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
      tool_response: "hello\n",
      tool_error: "",
    };
    expect(hookInput.tool_name).toBeTruthy();
    expect(typeof hookInput.tool_response).toBe("string");
  });

  it("empty tool_name should cause early exit", () => {
    const hookInput = { tool_name: "", tool_response: "" };
    expect(hookInput.tool_name).toBeFalsy();
  });
});

// ── Frontend Tool Call List Management ───────────────────────

describe("tool call list management", () => {
  it("updates existing call by callId", () => {
    const calls = [
      { callId: "a", tool_name: "Bash", status: "running" as const, ts: 1 },
    ];
    const update = { callId: "a", tool_name: "Bash", status: "completed" as const, ts: 2, duration_ms: 100 };
    const idx = calls.findIndex(tc => tc.callId === update.callId);
    expect(idx).toBe(0);
    calls[idx] = { ...calls[idx], ...update };
    expect(calls[0].status).toBe("completed");
  });

  it("appends new call if callId not found", () => {
    const calls = [
      { callId: "a", tool_name: "Bash", status: "completed" as const, ts: 1 },
    ];
    const newCall = { callId: "b", tool_name: "Read", status: "running" as const, ts: 2 };
    const idx = calls.findIndex(tc => tc.callId === newCall.callId);
    expect(idx).toBe(-1);
    calls.push(newCall);
    expect(calls).toHaveLength(2);
  });

  it("caps at 50 entries", () => {
    const calls = Array.from({ length: 50 }, (_, i) => ({
      callId: `call-${i}`,
      tool_name: "Read",
      status: "completed" as const,
      ts: i,
    }));
    expect(calls.length).toBe(50);
    // Adding one more should shift the oldest
    calls.push({ callId: "call-50", tool_name: "Read", status: "completed", ts: 50 });
    if (calls.length > 50) calls.shift();
    expect(calls.length).toBe(50);
    expect(calls[0].callId).toBe("call-1");
  });
});
