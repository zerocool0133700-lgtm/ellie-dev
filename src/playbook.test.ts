import { describe, it, expect } from "bun:test";
import { extractPlaybookCommands } from "./playbook.ts";

describe("extractPlaybookCommands", () => {
  // ── send ──────────────────────────────────────────────────

  it("parses a send command", () => {
    const input = "ELLIE:: send ELLIE-144 to dev";
    const { commands, cleanedText } = extractPlaybookCommands(input);

    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe("send");
    expect(commands[0].ticketId).toBe("ELLIE-144");
    expect(commands[0].agentName).toBe("dev");
    expect(cleanedText).toBe("");
  });

  it("preserves surrounding text and strips the tag", () => {
    const input = "I'll dispatch this now.\nELLIE:: send ELLIE-5 to research\nLet me know if you need anything else.";
    const { commands, cleanedText } = extractPlaybookCommands(input);

    expect(commands).toHaveLength(1);
    expect(commands[0].ticketId).toBe("ELLIE-5");
    expect(commands[0].agentName).toBe("research");
    expect(cleanedText).toContain("I'll dispatch this now.");
    expect(cleanedText).toContain("Let me know if you need anything else.");
    expect(cleanedText).not.toContain("ELLIE::");
  });

  // ── close ─────────────────────────────────────────────────

  it("parses a close command", () => {
    const input = 'ELLIE:: close ELLIE-100 "Implemented the feature and deployed"';
    const { commands, cleanedText } = extractPlaybookCommands(input);

    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe("close");
    expect(commands[0].ticketId).toBe("ELLIE-100");
    expect(commands[0].summary).toBe("Implemented the feature and deployed");
    expect(cleanedText).toBe("");
  });

  // ── create ────────────────────────────────────────────────

  it("parses a create command", () => {
    const input = 'ELLIE:: create ticket "Add dark mode" "User requested dark mode toggle in settings"';
    const { commands, cleanedText } = extractPlaybookCommands(input);

    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe("create");
    expect(commands[0].title).toBe("Add dark mode");
    expect(commands[0].description).toBe("User requested dark mode toggle in settings");
    expect(cleanedText).toBe("");
  });

  // ── multiple commands ─────────────────────────────────────

  it("extracts multiple commands from one response", () => {
    const input = [
      "Here's what I'm doing:",
      'ELLIE:: create ticket "Fix login bug" "Login fails on mobile"',
      "ELLIE:: send ELLIE-50 to dev",
      "All done.",
    ].join("\n");
    const { commands, cleanedText } = extractPlaybookCommands(input);

    expect(commands).toHaveLength(2);
    expect(commands[0].type).toBe("send");
    expect(commands[1].type).toBe("create");
    expect(cleanedText).toContain("Here's what I'm doing:");
    expect(cleanedText).toContain("All done.");
  });

  // ── case insensitivity ────────────────────────────────────

  it("is case insensitive on the ELLIE:: prefix", () => {
    const input = "ellie:: send EVE-3 to strategy";
    const { commands } = extractPlaybookCommands(input);

    expect(commands).toHaveLength(1);
    expect(commands[0].ticketId).toBe("EVE-3");
    expect(commands[0].agentName).toBe("strategy");
  });

  it("handles mixed case", () => {
    const input = 'Ellie:: close PROJ-42 "Done with refactor"';
    const { commands } = extractPlaybookCommands(input);

    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe("close");
    expect(commands[0].summary).toBe("Done with refactor");
  });

  // ── no commands ───────────────────────────────────────────

  it("returns empty array when no commands present", () => {
    const input = "Just a normal response with no special tags.";
    const { commands, cleanedText } = extractPlaybookCommands(input);

    expect(commands).toHaveLength(0);
    expect(cleanedText).toBe(input);
  });

  it("ignores neutralized ELLIE__ tags (from orchestrator sanitization)", () => {
    const input = "ELLIE__ send ELLIE-10 to dev";
    const { commands } = extractPlaybookCommands(input);

    expect(commands).toHaveLength(0);
  });

  // ── edge cases ────────────────────────────────────────────

  it("handles extra whitespace in commands", () => {
    const input = "ELLIE::   send   ELLIE-7   to   finance";
    const { commands } = extractPlaybookCommands(input);

    // The regex uses \s+ between "send" and the ticket, and \s+ between "to" and agent
    // but only \s* after ELLIE:: — let's see what actually matches
    expect(commands).toHaveLength(1);
    expect(commands[0].ticketId).toBe("ELLIE-7");
  });

  it("handles different project prefixes in ticket IDs", () => {
    const input = "ELLIE:: send PROJ-999 to content";
    const { commands } = extractPlaybookCommands(input);

    expect(commands).toHaveLength(1);
    expect(commands[0].ticketId).toBe("PROJ-999");
  });

  it("stores the raw matched text", () => {
    const raw = "ELLIE:: send ELLIE-1 to dev";
    const { commands } = extractPlaybookCommands(raw);

    expect(commands[0].raw).toBe(raw);
  });
});
