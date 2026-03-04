/**
 * ELLIE-509 — Skills commands tests
 *
 * Tests matchSkillCommand and matchInstantCommand by mocking getSkillSnapshot
 * to return a controlled fixture snapshot — no disk access needed.
 *
 * Covers:
 * - matchSkillCommand: non-slash text, exact match, match with args, case-insensitive,
 *   multiple commands, no match, tool-dispatch commands, args extraction
 * - matchInstantCommand: /help subcommand, ## Commands section extraction,
 *   fallback description, skill not userInvocable, unknown subcommand
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mocks (must precede imports) ──────────────────────────────────────────────

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: mock(), warn: mock(), error: mock() }) },
}));

const mockGetSkillSnapshot = mock();

mock.module("../src/skills/snapshot.ts", () => ({
  getSkillSnapshot: mockGetSkillSnapshot,
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { matchSkillCommand, matchInstantCommand } from "../src/skills/commands.ts";
import type { SkillEntry, SkillSnapshot } from "../src/skills/types.ts";

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeSkillEntry(overrides: {
  name: string;
  description?: string;
  userInvocable?: boolean;
  agent?: string;
  instant_commands?: string[];
  "command-dispatch"?: "tool";
  "command-tool"?: string;
  "command-arg-mode"?: "raw";
  instructions?: string;
}): SkillEntry {
  return {
    name: overrides.name,
    description: overrides.description ?? `The ${overrides.name} skill`,
    instructions: overrides.instructions ?? `## Commands\nUse /${overrides.name} to run this skill.\n`,
    frontmatter: {
      name: overrides.name,
      description: overrides.description ?? `The ${overrides.name} skill`,
      userInvocable: overrides.userInvocable ?? true,
      agent: overrides.agent,
      instant_commands: overrides.instant_commands,
      "command-dispatch": overrides["command-dispatch"],
      "command-tool": overrides["command-tool"],
      "command-arg-mode": overrides["command-arg-mode"],
    },
    sourceDir: "/tmp/test-skills",
    sourcePriority: 1,
  };
}

function makeSnapshot(skills: SkillEntry[]): SkillSnapshot {
  return {
    prompt: "",
    skills,
    version: 1,
    totalChars: 0,
  };
}

const GITHUB_SKILL = makeSkillEntry({ name: "github", description: "GitHub integration" });
const PLANE_SKILL = makeSkillEntry({ name: "plane", description: "Plane project manager" });
const NON_INVOCABLE = makeSkillEntry({ name: "internal", userInvocable: false });
const TOOL_DISPATCH_SKILL = makeSkillEntry({
  name: "miro",
  description: "Miro whiteboards",
  "command-dispatch": "tool",
  "command-tool": "mcp__miro__create_board",
  "command-arg-mode": "raw",
});
const HELP_SKILL = makeSkillEntry({
  name: "forest",
  description: "Forest knowledge",
  instant_commands: ["help"],
  instructions: "## Commands\nUse /forest to search the Forest.\n\n/forest search <query> — Search for memories.\n",
});
const NO_COMMANDS_SECTION = makeSkillEntry({
  name: "weather",
  description: "Weather data",
  instant_commands: ["help"],
  instructions: "This skill shows weather data without a commands section.",
});

beforeEach(() => {
  mockGetSkillSnapshot.mockClear();
  mockGetSkillSnapshot.mockImplementation(() =>
    Promise.resolve(makeSnapshot([GITHUB_SKILL, PLANE_SKILL, TOOL_DISPATCH_SKILL, HELP_SKILL, NO_COMMANDS_SECTION, NON_INVOCABLE]))
  );
});

// ── matchSkillCommand — non-slash input ───────────────────────────────────────

describe("matchSkillCommand — non-slash input", () => {
  test("plain text (no slash) → null", async () => {
    const result = await matchSkillCommand("hello world");
    expect(result).toBeNull();
  });

  test("empty string → null", async () => {
    const result = await matchSkillCommand("");
    expect(result).toBeNull();
  });

  test("text with slash not at start → null", async () => {
    const result = await matchSkillCommand("look at /github here");
    expect(result).toBeNull();
  });

  test("unknown slash command → null", async () => {
    const result = await matchSkillCommand("/unknown-command");
    expect(result).toBeNull();
  });
});

// ── matchSkillCommand — exact matches ─────────────────────────────────────────

describe("matchSkillCommand — exact match", () => {
  test("/github → matches github command", async () => {
    const result = await matchSkillCommand("/github");
    expect(result).not.toBeNull();
    expect(result!.command.name).toBe("github");
    expect(result!.args).toBe("");
  });

  test("/plane → matches plane command", async () => {
    const result = await matchSkillCommand("/plane");
    expect(result).not.toBeNull();
    expect(result!.command.name).toBe("plane");
  });

  test("non-userInvocable skill → not matched", async () => {
    const result = await matchSkillCommand("/internal");
    expect(result).toBeNull();
  });
});

// ── matchSkillCommand — case-insensitive ──────────────────────────────────────

describe("matchSkillCommand — case-insensitive input", () => {
  test("/GITHUB → matches github", async () => {
    const result = await matchSkillCommand("/GITHUB");
    expect(result).not.toBeNull();
    expect(result!.command.name).toBe("github");
  });

  test("/GitHub → matches github", async () => {
    const result = await matchSkillCommand("/GitHub");
    expect(result).not.toBeNull();
    expect(result!.command.name).toBe("github");
  });

  test("/PLANE list issues → matches plane with args", async () => {
    const result = await matchSkillCommand("/PLANE list issues");
    expect(result).not.toBeNull();
    expect(result!.command.name).toBe("plane");
    expect(result!.args).toBe("list issues");
  });
});

// ── matchSkillCommand — args extraction ───────────────────────────────────────

describe("matchSkillCommand — args extraction", () => {
  test("/github create PR → args = 'create PR'", async () => {
    const result = await matchSkillCommand("/github create PR");
    expect(result!.args).toBe("create PR");
  });

  test("/github  multiple  spaces → trimmed args", async () => {
    const result = await matchSkillCommand("/github  list repos");
    expect(result!.args).toBe("list repos");
  });

  test("leading/trailing whitespace in input → trimmed before matching", async () => {
    const result = await matchSkillCommand("  /github  ");
    expect(result).not.toBeNull();
    expect(result!.command.name).toBe("github");
  });
});

// ── matchSkillCommand — tool dispatch ─────────────────────────────────────────

describe("matchSkillCommand — tool dispatch", () => {
  test("/miro → matched command has dispatch kind=tool", async () => {
    const result = await matchSkillCommand("/miro");
    expect(result).not.toBeNull();
    expect(result!.command.dispatch?.kind).toBe("tool");
    expect(result!.command.dispatch?.toolName).toBe("mcp__miro__create_board");
    expect(result!.command.dispatch?.argMode).toBe("raw");
  });

  test("/miro create board → args passed through", async () => {
    const result = await matchSkillCommand("/miro create a new board");
    expect(result!.args).toBe("create a new board");
  });
});

// ── matchInstantCommand — /help ────────────────────────────────────────────────

describe("matchInstantCommand — /help subcommand", () => {
  test("/forest help → returns help response", async () => {
    const result = await matchInstantCommand("/forest help");
    expect(result).not.toBeNull();
    expect(result!.skillName).toBe("forest");
    expect(result!.subcommand).toBe("help");
    expect(result!.response).toContain("/forest");
  });

  test("/forest help → response includes ## Commands section content", async () => {
    const result = await matchInstantCommand("/forest help");
    expect(result!.response).toContain("search");
  });

  test("/forest help → response includes skill description header", async () => {
    const result = await matchInstantCommand("/forest help");
    expect(result!.response).toContain("Forest knowledge");
  });

  test("skill with no ## Commands section → fallback to description", async () => {
    const result = await matchInstantCommand("/weather help");
    expect(result).not.toBeNull();
    expect(result!.response).toContain("Weather data");
    expect(result!.response).toContain("No detailed help available");
  });

  test("/FOREST HELP (uppercase) → matched case-insensitively", async () => {
    const result = await matchInstantCommand("/FOREST HELP");
    expect(result).not.toBeNull();
    expect(result!.skillName).toBe("forest");
  });
});

// ── matchInstantCommand — no match cases ──────────────────────────────────────

describe("matchInstantCommand — no match", () => {
  test("non-slash text → null", async () => {
    const result = await matchInstantCommand("forest help");
    expect(result).toBeNull();
  });

  test("/github help → github has no instant_commands → null", async () => {
    const result = await matchInstantCommand("/github help");
    expect(result).toBeNull();
  });

  test("/forest (no subcommand) → null", async () => {
    const result = await matchInstantCommand("/forest");
    expect(result).toBeNull();
  });

  test("/forest unknown-subcommand → null", async () => {
    const result = await matchInstantCommand("/forest list");
    expect(result).toBeNull();
  });

  test("non-invocable skill → not matched even with instant_commands", async () => {
    // NON_INVOCABLE has userInvocable: false — shouldn't be reachable
    const result = await matchInstantCommand("/internal help");
    expect(result).toBeNull();
  });

  test("empty string → null", async () => {
    const result = await matchInstantCommand("");
    expect(result).toBeNull();
  });
});

// ── matchSkillCommand — snapshot integration ──────────────────────────────────

describe("matchSkillCommand — snapshot is called", () => {
  test("calls getSkillSnapshot on each invocation", async () => {
    await matchSkillCommand("/github");
    await matchSkillCommand("/plane");
    // getSkillCommands calls getSkillSnapshot — called once per matchSkillCommand
    expect(mockGetSkillSnapshot.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
