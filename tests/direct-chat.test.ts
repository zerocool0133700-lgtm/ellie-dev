import { describe, test, expect, mock } from "bun:test";

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: mock(), warn: mock(), error: mock(), debug: mock() }) },
}));

mock.module("../src/prompt-builder.ts", () => ({
  getCachedRiverDoc: mock(() => "# Ellie Soul\nPatient teacher..."),
}));

import { buildDirectPrompt } from "../src/direct-chat.ts";

describe("direct-chat", () => {
  test("buildDirectPrompt includes soul", () => {
    const prompt = buildDirectPrompt({
      agent: "ellie",
      message: "hey, how's it going?",
    });
    expect(prompt).toContain("Ellie Soul");
    expect(prompt).toContain("hey, how's it going?");
  });

  test("buildDirectPrompt includes conversation history", () => {
    const prompt = buildDirectPrompt({
      agent: "james",
      message: "check the tests",
      conversationHistory: "User: look at the API\nJames: on it",
    });
    expect(prompt).toContain("look at the API");
    expect(prompt).toContain("check the tests");
  });

  test("buildDirectPrompt includes working memory when provided", () => {
    const prompt = buildDirectPrompt({
      agent: "james",
      message: "what about the auth?",
      workingMemorySummary: "Working on v2 API, decided to use Express router",
    });
    expect(prompt).toContain("v2 API");
    expect(prompt).toContain("Express router");
  });

  test("buildDirectPrompt includes cross-thread awareness", () => {
    const prompt = buildDirectPrompt({
      agent: "james",
      message: "status update?",
      crossThreadAwareness: "## Cross-Thread Awareness\nAlso active in ELLIE-500 thread",
    });
    expect(prompt).toContain("Cross-Thread Awareness");
    expect(prompt).toContain("ELLIE-500");
  });
});
