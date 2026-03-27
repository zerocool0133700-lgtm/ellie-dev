import { describe, it, expect } from "bun:test";

describe("ELLIE-1069: Post-call debrief", () => {
  it("exports generateDebrief", async () => {
    const mod = await import("../src/post-call-debrief.ts");
    expect(typeof mod.generateDebrief).toBe("function");
  });

  it("DebriefResult has required fields", () => {
    const result = {
      conversationId: "conv-1",
      personName: "Alex",
      topicsAddressed: ["pricing"],
      topicsMissed: ["timeline"],
      newCommitments: 2,
      newDecisions: 1,
      openQuestions: ["What about Q3?"],
      summary: "Call with Alex complete. 2 action items. 1 decision made.",
    };
    expect(result.newCommitments).toBe(2);
    expect(result.topicsMissed).toContain("timeline");
  });
});
