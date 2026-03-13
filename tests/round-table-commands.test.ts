/**
 * Tests for Round Table Command Interface — ELLIE-702
 */
import { describe, expect, test, beforeEach } from "bun:test";
import {
  parseCommand,
  executeCommand,
  handleRoundTableCommand,
  _makeMockCommandDeps,
  type ParsedCommand,
  type RoundTableCommandDeps,
} from "../src/round-table/commands.ts";
import { RoundTableSessionManager } from "../src/round-table/router-integration.ts";

// ── Command Parsing ─────────────────────────────────────────────

describe("parseCommand", () => {
  test("bare /roundtable shows help", () => {
    const cmd = parseCommand("/roundtable");
    expect(cmd.subcommand).toBe("help");
  });

  test("/roundtable <query> → start", () => {
    const cmd = parseCommand("/roundtable What should we do about Q2?");
    expect(cmd.subcommand).toBe("start");
    expect(cmd.args).toBe("What should we do about Q2?");
  });

  test("/roundtable start <query> → explicit start", () => {
    const cmd = parseCommand("/roundtable start Should we hire or contract?");
    expect(cmd.subcommand).toBe("start");
    expect(cmd.args).toBe("Should we hire or contract?");
  });

  test("/roundtable status → status", () => {
    const cmd = parseCommand("/roundtable status");
    expect(cmd.subcommand).toBe("status");
  });

  test("/roundtable status <session_id> → status with ID", () => {
    const cmd = parseCommand("/roundtable status rt-abc-123");
    expect(cmd.subcommand).toBe("status");
    expect(cmd.options.sessionId).toBe("rt-abc-123");
  });

  test("/roundtable list → list", () => {
    const cmd = parseCommand("/roundtable list");
    expect(cmd.subcommand).toBe("list");
  });

  test("/roundtable formations → formations", () => {
    const cmd = parseCommand("/roundtable formations");
    expect(cmd.subcommand).toBe("formations");
  });

  test("/roundtable cancel → cancel", () => {
    const cmd = parseCommand("/roundtable cancel");
    expect(cmd.subcommand).toBe("cancel");
  });

  test("/roundtable cancel <session_id> → cancel with ID", () => {
    const cmd = parseCommand("/roundtable cancel rt-xyz");
    expect(cmd.subcommand).toBe("cancel");
    expect(cmd.options.sessionId).toBe("rt-xyz");
  });

  test("/roundtable help → help", () => {
    const cmd = parseCommand("/roundtable help");
    expect(cmd.subcommand).toBe("help");
  });

  test("/rt shorthand works", () => {
    const cmd = parseCommand("/rt What now?");
    expect(cmd.subcommand).toBe("start");
    expect(cmd.args).toBe("What now?");
  });

  test("/round-table works", () => {
    const cmd = parseCommand("/round-table status");
    expect(cmd.subcommand).toBe("status");
  });

  // Options parsing
  test("--formations option extracted", () => {
    const cmd = parseCommand("/roundtable start Test query --formations=boardroom,think-tank");
    expect(cmd.subcommand).toBe("start");
    expect(cmd.args).toBe("Test query");
    expect(cmd.options.formations).toEqual(["boardroom", "think-tank"]);
  });

  test("--channel option extracted", () => {
    const cmd = parseCommand("/roundtable start Test --channel=dashboard");
    expect(cmd.options.channel).toBe("dashboard");
    expect(cmd.args).toBe("Test");
  });

  test("--ticket option extracted", () => {
    const cmd = parseCommand("/roundtable start Test --ticket=ELLIE-100");
    expect(cmd.options.workItemId).toBe("ELLIE-100");
  });

  test("multiple options extracted", () => {
    const cmd = parseCommand("/roundtable start Q2 plan --formations=boardroom --channel=telegram --ticket=ELLIE-50");
    expect(cmd.options.formations).toEqual(["boardroom"]);
    expect(cmd.options.channel).toBe("telegram");
    expect(cmd.options.workItemId).toBe("ELLIE-50");
    expect(cmd.args).toBe("Q2 plan");
  });

  test("options in middle of query", () => {
    const cmd = parseCommand("/roundtable What --channel=dashboard should we do?");
    expect(cmd.options.channel).toBe("dashboard");
    expect(cmd.args).toBe("What should we do?");
  });

  test("case insensitive prefix", () => {
    const cmd = parseCommand("/ROUNDTABLE help");
    expect(cmd.subcommand).toBe("help");
  });
});

// ── Command Execution: Help ─────────────────────────────────────

describe("executeCommand — help", () => {
  test("returns help text", async () => {
    const deps = _makeMockCommandDeps();
    const result = await executeCommand(deps, parseCommand("/roundtable help"));
    expect(result.success).toBe(true);
    expect(result.output).toContain("Round Table Commands");
    expect(result.output).toContain("/roundtable");
    expect(result.output).toContain("--formations");
  });
});

// ── Command Execution: Formations ───────────────────────────────

describe("executeCommand — formations", () => {
  test("lists available formations", async () => {
    const deps = _makeMockCommandDeps();
    const result = await executeCommand(deps, parseCommand("/roundtable formations"));
    expect(result.success).toBe(true);
    expect(result.output).toContain("Available Formations");
    expect(result.output).toContain("boardroom");
    expect(result.output).toContain("think-tank");
  });
});

// ── Command Execution: Start ────────────────────────────────────

describe("executeCommand — start", () => {
  test("starts session and returns output", async () => {
    const deps = _makeMockCommandDeps();
    const result = await executeCommand(deps, parseCommand("/roundtable What is our Q2 plan?"));
    expect(result.success).toBe(true);
    expect(result.output).toContain("Round table result");
    expect(result.sessionId).toBe("rt-cmd-1");
  });

  test("fails without query", async () => {
    const deps = _makeMockCommandDeps();
    const result = await executeCommand(deps, parseCommand("/roundtable start"));
    expect(result.success).toBe(false);
    expect(result.output).toContain("Please provide a query");
  });

  test("validates formation overrides", async () => {
    const deps = _makeMockCommandDeps();
    const cmd = parseCommand("/roundtable start test --formations=boardroom,fake-formation");
    const result = await executeCommand(deps, cmd);
    expect(result.success).toBe(false);
    expect(result.output).toContain("Unknown formation");
    expect(result.output).toContain("fake-formation");
  });

  test("valid formation overrides pass", async () => {
    const deps = _makeMockCommandDeps();
    const cmd = parseCommand("/roundtable start test --formations=boardroom");
    const result = await executeCommand(deps, cmd);
    expect(result.success).toBe(true);
  });

  test("handles failed round table", async () => {
    const deps = _makeMockCommandDeps({
      sessionId: "rt-fail",
      output: "",
      success: false,
      error: "Synthesis failed",
    });
    const result = await executeCommand(deps, parseCommand("/roundtable What now?"));
    expect(result.success).toBe(false);
    expect(result.output).toContain("Synthesis failed");
  });

  test("passes channel from context", async () => {
    let capturedChannel: string | undefined;
    const deps: RoundTableCommandDeps = {
      routerDeps: {
        runRoundTable: async (_q, opts) => {
          capturedChannel = opts?.channel;
          return { sessionId: "s1", output: "done", success: true };
        },
      },
      sessionManager: new RoundTableSessionManager(),
    };

    await executeCommand(deps, parseCommand("/roundtable test"), { channel: "google-chat" });
    expect(capturedChannel).toBe("google-chat");
  });

  test("--channel overrides context channel", async () => {
    let capturedChannel: string | undefined;
    const deps: RoundTableCommandDeps = {
      routerDeps: {
        runRoundTable: async (_q, opts) => {
          capturedChannel = opts?.channel;
          return { sessionId: "s1", output: "done", success: true };
        },
      },
      sessionManager: new RoundTableSessionManager(),
    };

    await executeCommand(
      deps,
      parseCommand("/roundtable test --channel=dashboard"),
      { channel: "telegram" },
    );
    expect(capturedChannel).toBe("dashboard");
  });
});

// ── Command Execution: Status ───────────────────────────────────

describe("executeCommand — status", () => {
  test("shows active session status", async () => {
    const deps = _makeMockCommandDeps();
    deps.sessionManager.registerSession("rt-1", "Q2 strategy", "telegram");

    const result = await executeCommand(deps, parseCommand("/roundtable status rt-1"));
    expect(result.success).toBe(true);
    expect(result.output).toContain("rt-1");
    expect(result.output).toContain("Q2 strategy");
    expect(result.output).toContain("active");
  });

  test("shows completed session with output", async () => {
    const deps = _makeMockCommandDeps();
    deps.sessionManager.registerSession("rt-1", "test", "telegram");
    deps.sessionManager.completeSession("rt-1", "Result: expand into APAC");

    const result = await executeCommand(deps, parseCommand("/roundtable status rt-1"));
    expect(result.success).toBe(true);
    expect(result.output).toContain("completed");
    expect(result.output).toContain("expand into APAC");
  });

  test("shows failed session with error", async () => {
    const deps = _makeMockCommandDeps();
    deps.sessionManager.registerSession("rt-1", "test", "telegram");
    deps.sessionManager.failSession("rt-1", "Agent timeout");

    const result = await executeCommand(deps, parseCommand("/roundtable status rt-1"));
    expect(result.success).toBe(true);
    expect(result.output).toContain("failed");
    expect(result.output).toContain("Agent timeout");
  });

  test("finds active session by channel when no ID given", async () => {
    const deps = _makeMockCommandDeps();
    deps.sessionManager.registerSession("rt-1", "Q2", "telegram");

    const result = await executeCommand(
      deps,
      parseCommand("/roundtable status"),
      { channel: "telegram" },
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("rt-1");
  });

  test("reports not found for unknown session", async () => {
    const deps = _makeMockCommandDeps();
    const result = await executeCommand(deps, parseCommand("/roundtable status rt-nonexistent"));
    expect(result.success).toBe(false);
    expect(result.output).toContain("not found");
  });

  test("reports no active session on channel", async () => {
    const deps = _makeMockCommandDeps();
    const result = await executeCommand(
      deps,
      parseCommand("/roundtable status"),
      { channel: "telegram" },
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("No active");
  });

  test("shows work item if present", async () => {
    const deps = _makeMockCommandDeps();
    deps.sessionManager.registerSession("rt-1", "test", "telegram", "ELLIE-50");

    const result = await executeCommand(deps, parseCommand("/roundtable status rt-1"));
    expect(result.output).toContain("ELLIE-50");
  });
});

// ── Command Execution: List ─────────────────────────────────────

describe("executeCommand — list", () => {
  test("shows no sessions message when empty", async () => {
    const deps = _makeMockCommandDeps();
    const result = await executeCommand(deps, parseCommand("/roundtable list"));
    expect(result.success).toBe(true);
    expect(result.output).toContain("No active");
  });

  test("lists active sessions", async () => {
    const deps = _makeMockCommandDeps();
    deps.sessionManager.registerSession("rt-1", "Q2 strategy discussion", "telegram");
    deps.sessionManager.registerSession("rt-2", "Hiring decision", "google-chat");

    const result = await executeCommand(deps, parseCommand("/roundtable list"));
    expect(result.success).toBe(true);
    expect(result.output).toContain("rt-1");
    expect(result.output).toContain("rt-2");
    expect(result.output).toContain("Q2 strategy");
    expect(result.output).toContain("Hiring decision");
    expect(result.output).toContain("(2)");
  });

  test("does not list completed sessions", async () => {
    const deps = _makeMockCommandDeps();
    deps.sessionManager.registerSession("rt-1", "done", "telegram");
    deps.sessionManager.completeSession("rt-1", "output");

    const result = await executeCommand(deps, parseCommand("/roundtable list"));
    expect(result.output).toContain("No active");
  });
});

// ── Command Execution: Cancel ───────────────────────────────────

describe("executeCommand — cancel", () => {
  test("cancels active session by ID", async () => {
    const deps = _makeMockCommandDeps();
    deps.sessionManager.registerSession("rt-1", "test", "telegram");

    const result = await executeCommand(deps, parseCommand("/roundtable cancel rt-1"));
    expect(result.success).toBe(true);
    expect(result.output).toContain("cancelled");

    const session = deps.sessionManager.getSession("rt-1");
    expect(session!.status).toBe("failed");
  });

  test("cancels active session by channel when no ID", async () => {
    const deps = _makeMockCommandDeps();
    deps.sessionManager.registerSession("rt-1", "test", "telegram");

    const result = await executeCommand(
      deps,
      parseCommand("/roundtable cancel"),
      { channel: "telegram" },
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("cancelled");
  });

  test("fails for unknown session", async () => {
    const deps = _makeMockCommandDeps();
    const result = await executeCommand(deps, parseCommand("/roundtable cancel rt-nope"));
    expect(result.success).toBe(false);
    expect(result.output).toContain("not found");
  });

  test("fails for already completed session", async () => {
    const deps = _makeMockCommandDeps();
    deps.sessionManager.registerSession("rt-1", "test", "telegram");
    deps.sessionManager.completeSession("rt-1", "done");

    const result = await executeCommand(deps, parseCommand("/roundtable cancel rt-1"));
    expect(result.success).toBe(false);
    expect(result.output).toContain("already completed");
  });

  test("fails when no active session on channel", async () => {
    const deps = _makeMockCommandDeps();
    const result = await executeCommand(
      deps,
      parseCommand("/roundtable cancel"),
      { channel: "telegram" },
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("No active");
  });
});

// ── handleRoundTableCommand (full pipeline) ─────────────────────

describe("handleRoundTableCommand", () => {
  test("parses and executes in one call", async () => {
    const deps = _makeMockCommandDeps();
    const result = await handleRoundTableCommand(
      deps,
      "/roundtable What should we prioritize?",
      { channel: "telegram" },
    );
    expect(result.success).toBe(true);
    expect(result.sessionId).toBe("rt-cmd-1");
  });

  test("handles help", async () => {
    const deps = _makeMockCommandDeps();
    const result = await handleRoundTableCommand(deps, "/roundtable help");
    expect(result.success).toBe(true);
    expect(result.output).toContain("Round Table Commands");
  });

  test("handles status with context", async () => {
    const deps = _makeMockCommandDeps();
    deps.sessionManager.registerSession("rt-1", "test", "telegram");

    const result = await handleRoundTableCommand(
      deps,
      "/roundtable status",
      { channel: "telegram" },
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("rt-1");
  });

  test("unknown subcommand gives error", async () => {
    const deps = _makeMockCommandDeps();
    // Force an unknown subcommand by crafting the parsed command manually
    const result = await executeCommand(
      deps,
      { subcommand: "bogus", args: "", options: {} },
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("Unknown subcommand");
  });
});
