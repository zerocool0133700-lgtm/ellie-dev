/**
 * ELLIE-542 — Orchestration playbook commands
 *
 * Tests for the 6 new ELLIE:: orchestration commands added in ELLIE-542:
 *   - start-session   ELLIE:: start session on ELLIE-XXX with <agent>
 *   - check-in        ELLIE:: check in on session ELLIE-XXX
 *   - escalate        ELLIE:: escalate ELLIE-XXX to <agent> "reason"
 *   - handoff         ELLIE:: handoff ELLIE-XXX from <agent1> to <agent2> "context"
 *   - pause-session   ELLIE:: pause session ELLIE-XXX "blocker"
 *   - resume-session  ELLIE:: resume session ELLIE-XXX
 *
 * All tests operate on extractPlaybookCommands() — the pure parser layer
 * that does not require a live server or database.
 */

import { describe, it, expect } from "bun:test";
import { extractPlaybookCommands } from "../src/playbook.ts";

// ── start-session ─────────────────────────────────────────────────────────────

describe("extractPlaybookCommands — start-session (ELLIE-542)", () => {
  it("parses a start-session command", () => {
    const input = "ELLIE:: start session on ELLIE-542 with dev";
    const { commands, cleanedText } = extractPlaybookCommands(input);

    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe("start-session");
    expect(commands[0].ticketId).toBe("ELLIE-542");
    expect(commands[0].agentName).toBe("dev");
    expect(cleanedText).toBe("");
  });

  it("normalises agentName to lowercase", () => {
    const { commands } = extractPlaybookCommands("ELLIE:: start session on PROJ-10 with Research");
    expect(commands[0].agentName).toBe("research");
  });

  it("strips the tag and preserves surrounding text", () => {
    const input = "Starting now.\nELLIE:: start session on ELLIE-1 with dev\nGood to go.";
    const { commands, cleanedText } = extractPlaybookCommands(input);

    expect(commands).toHaveLength(1);
    expect(commands[0].ticketId).toBe("ELLIE-1");
    expect(cleanedText).toContain("Starting now.");
    expect(cleanedText).toContain("Good to go.");
    expect(cleanedText).not.toContain("ELLIE::");
  });

  it("stores the raw matched text", () => {
    const raw = "ELLIE:: start session on ELLIE-100 with dev";
    const { commands } = extractPlaybookCommands(raw);
    expect(commands[0].raw).toBe(raw);
  });

  it("is case insensitive on the ELLIE:: prefix", () => {
    const { commands } = extractPlaybookCommands("ellie:: start session on ELLIE-5 with dev");
    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe("start-session");
  });
});

// ── check-in ──────────────────────────────────────────────────────────────────

describe("extractPlaybookCommands — check-in (ELLIE-542)", () => {
  it("parses a check-in command", () => {
    const input = "ELLIE:: check in on session ELLIE-200";
    const { commands, cleanedText } = extractPlaybookCommands(input);

    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe("check-in");
    expect(commands[0].ticketId).toBe("ELLIE-200");
    expect(cleanedText).toBe("");
  });

  it("strips the tag and preserves surrounding text", () => {
    const input = "Still working.\nELLIE:: check in on session ELLIE-200\nOnward.";
    const { commands, cleanedText } = extractPlaybookCommands(input);

    expect(commands).toHaveLength(1);
    expect(cleanedText).toContain("Still working.");
    expect(cleanedText).not.toContain("ELLIE::");
  });

  it("stores the raw matched text", () => {
    const raw = "ELLIE:: check in on session PROJ-99";
    const { commands } = extractPlaybookCommands(raw);
    expect(commands[0].raw).toBe(raw);
  });

  it("is case insensitive", () => {
    const { commands } = extractPlaybookCommands("Ellie:: check in on session ELLIE-3");
    expect(commands).toHaveLength(1);
  });
});

// ── escalate ──────────────────────────────────────────────────────────────────

describe("extractPlaybookCommands — escalate (ELLIE-542)", () => {
  it("parses an escalate command", () => {
    const input = 'ELLIE:: escalate ELLIE-300 to research "Need domain expertise"';
    const { commands, cleanedText } = extractPlaybookCommands(input);

    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe("escalate");
    expect(commands[0].ticketId).toBe("ELLIE-300");
    expect(commands[0].agentName).toBe("research");
    expect(commands[0].reason).toBe("Need domain expertise");
    expect(cleanedText).toBe("");
  });

  it("normalises agentName to lowercase", () => {
    const { commands } = extractPlaybookCommands('ELLIE:: escalate ELLIE-1 to Strategy "Blocked"');
    expect(commands[0].agentName).toBe("strategy");
  });

  it("preserves reason with spaces", () => {
    const { commands } = extractPlaybookCommands('ELLIE:: escalate ELLIE-10 to dev "Database schema unclear — needs design review"');
    expect(commands[0].reason).toBe("Database schema unclear — needs design review");
  });

  it("strips the tag and preserves surrounding text", () => {
    const input = 'I cannot proceed.\nELLIE:: escalate ELLIE-7 to research "Blocked on API docs"\nWaiting for help.';
    const { commands, cleanedText } = extractPlaybookCommands(input);

    expect(commands).toHaveLength(1);
    expect(cleanedText).toContain("I cannot proceed.");
    expect(cleanedText).toContain("Waiting for help.");
    expect(cleanedText).not.toContain("ELLIE::");
  });

  it("stores the raw matched text", () => {
    const raw = 'ELLIE:: escalate ELLIE-50 to dev "Urgent"';
    const { commands } = extractPlaybookCommands(raw);
    expect(commands[0].raw).toBe(raw);
  });
});

// ── handoff ───────────────────────────────────────────────────────────────────

describe("extractPlaybookCommands — handoff (ELLIE-542)", () => {
  it("parses a handoff command", () => {
    const input = 'ELLIE:: handoff ELLIE-400 from dev to research "Context: API spec done, DB schema TBD"';
    const { commands, cleanedText } = extractPlaybookCommands(input);

    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe("handoff");
    expect(commands[0].ticketId).toBe("ELLIE-400");
    expect(commands[0].fromAgent).toBe("dev");
    expect(commands[0].agentName).toBe("research");
    expect(commands[0].context).toBe("Context: API spec done, DB schema TBD");
    expect(cleanedText).toBe("");
  });

  it("normalises both agent names to lowercase", () => {
    const { commands } = extractPlaybookCommands('ELLIE:: handoff ELLIE-1 from Dev to Strategy "ctx"');
    expect(commands[0].fromAgent).toBe("dev");
    expect(commands[0].agentName).toBe("strategy");
  });

  it("preserves context with commas and punctuation", () => {
    const { commands } = extractPlaybookCommands('ELLIE:: handoff ELLIE-20 from dev to research "Phase 1 done, phase 2 needs ML expertise."');
    expect(commands[0].context).toBe("Phase 1 done, phase 2 needs ML expertise.");
  });

  it("strips the tag and preserves surrounding text", () => {
    const input = 'Handing off now.\nELLIE:: handoff ELLIE-5 from dev to research "All code reviewed"\nDone.';
    const { commands, cleanedText } = extractPlaybookCommands(input);

    expect(commands).toHaveLength(1);
    expect(cleanedText).toContain("Handing off now.");
    expect(cleanedText).not.toContain("ELLIE::");
  });

  it("stores the raw matched text", () => {
    const raw = 'ELLIE:: handoff ELLIE-9 from dev to research "ctx"';
    const { commands } = extractPlaybookCommands(raw);
    expect(commands[0].raw).toBe(raw);
  });
});

// ── pause-session ─────────────────────────────────────────────────────────────

describe("extractPlaybookCommands — pause-session (ELLIE-542)", () => {
  it("parses a pause-session command", () => {
    const input = 'ELLIE:: pause session ELLIE-500 "Waiting for external API credentials"';
    const { commands, cleanedText } = extractPlaybookCommands(input);

    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe("pause-session");
    expect(commands[0].ticketId).toBe("ELLIE-500");
    expect(commands[0].reason).toBe("Waiting for external API credentials");
    expect(cleanedText).toBe("");
  });

  it("preserves blocker reason with spaces", () => {
    const { commands } = extractPlaybookCommands('ELLIE:: pause session ELLIE-1 "Blocked: DB migration not deployed yet"');
    expect(commands[0].reason).toBe("Blocked: DB migration not deployed yet");
  });

  it("strips the tag and preserves surrounding text", () => {
    const input = 'Pausing for now.\nELLIE:: pause session ELLIE-8 "External dependency"\nWill resume later.';
    const { commands, cleanedText } = extractPlaybookCommands(input);

    expect(commands).toHaveLength(1);
    expect(cleanedText).toContain("Pausing for now.");
    expect(cleanedText).toContain("Will resume later.");
    expect(cleanedText).not.toContain("ELLIE::");
  });

  it("stores the raw matched text", () => {
    const raw = 'ELLIE:: pause session ELLIE-6 "Blocker"';
    const { commands } = extractPlaybookCommands(raw);
    expect(commands[0].raw).toBe(raw);
  });

  it("is case insensitive", () => {
    const { commands } = extractPlaybookCommands('ELLIE:: Pause Session ELLIE-2 "test"');
    expect(commands).toHaveLength(1);
  });
});

// ── resume-session ────────────────────────────────────────────────────────────

describe("extractPlaybookCommands — resume-session (ELLIE-542)", () => {
  it("parses a resume-session command", () => {
    const input = "ELLIE:: resume session ELLIE-600";
    const { commands, cleanedText } = extractPlaybookCommands(input);

    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe("resume-session");
    expect(commands[0].ticketId).toBe("ELLIE-600");
    expect(cleanedText).toBe("");
  });

  it("strips the tag and preserves surrounding text", () => {
    const input = "Credentials received.\nELLIE:: resume session ELLIE-600\nContinuing work.";
    const { commands, cleanedText } = extractPlaybookCommands(input);

    expect(commands).toHaveLength(1);
    expect(cleanedText).toContain("Credentials received.");
    expect(cleanedText).toContain("Continuing work.");
    expect(cleanedText).not.toContain("ELLIE::");
  });

  it("stores the raw matched text", () => {
    const raw = "ELLIE:: resume session ELLIE-77";
    const { commands } = extractPlaybookCommands(raw);
    expect(commands[0].raw).toBe(raw);
  });

  it("is case insensitive", () => {
    const { commands } = extractPlaybookCommands("ellie:: resume session ELLIE-4");
    expect(commands).toHaveLength(1);
  });
});

// ── mixed / multiple commands ─────────────────────────────────────────────────

describe("extractPlaybookCommands — mixed orchestration commands (ELLIE-542)", () => {
  it("extracts multiple orchestration commands from one response", () => {
    const input = [
      "Starting the session and checking in.",
      "ELLIE:: start session on ELLIE-700 with dev",
      "ELLIE:: check in on session ELLIE-701",
      "All dispatched.",
    ].join("\n");
    const { commands, cleanedText } = extractPlaybookCommands(input);

    expect(commands).toHaveLength(2);
    const types = commands.map(c => c.type);
    expect(types).toContain("start-session");
    expect(types).toContain("check-in");
    expect(cleanedText).toContain("Starting the session and checking in.");
    expect(cleanedText).toContain("All dispatched.");
    expect(cleanedText).not.toContain("ELLIE::");
  });

  it("extracts orchestration commands alongside existing send/close/create commands", () => {
    const input = [
      "ELLIE:: send ELLIE-800 to dev",
      'ELLIE:: pause session ELLIE-801 "Dependency blocked"',
      "ELLIE:: resume session ELLIE-802",
    ].join("\n");
    const { commands } = extractPlaybookCommands(input);

    expect(commands).toHaveLength(3);
    const types = commands.map(c => c.type);
    expect(types).toContain("send");
    expect(types).toContain("pause-session");
    expect(types).toContain("resume-session");
  });

  it("escalate and handoff together in one response", () => {
    const input = [
      'ELLIE:: escalate ELLIE-900 to research "Needs ML knowledge"',
      'ELLIE:: handoff ELLIE-901 from dev to strategy "Shifting focus"',
    ].join("\n");
    const { commands } = extractPlaybookCommands(input);

    expect(commands).toHaveLength(2);
    const escalate = commands.find(c => c.type === "escalate");
    const handoff = commands.find(c => c.type === "handoff");
    expect(escalate?.ticketId).toBe("ELLIE-900");
    expect(escalate?.reason).toBe("Needs ML knowledge");
    expect(handoff?.ticketId).toBe("ELLIE-901");
    expect(handoff?.fromAgent).toBe("dev");
    expect(handoff?.agentName).toBe("strategy");
  });

  it("returns no orchestration commands for plain text", () => {
    const { commands } = extractPlaybookCommands("Just a normal response with no tags.");
    const orchestrationTypes = ["start-session", "check-in", "escalate", "handoff", "pause-session", "resume-session"];
    const found = commands.filter(c => orchestrationTypes.includes(c.type));
    expect(found).toHaveLength(0);
  });

  it("ignores neutralised ELLIE__ tags", () => {
    const { commands } = extractPlaybookCommands("ELLIE__ start session on ELLIE-1 with dev");
    expect(commands).toHaveLength(0);
  });
});
