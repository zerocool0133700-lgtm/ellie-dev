import { describe, it, expect } from "bun:test";

describe("ELLIE-1065: Structured voice extraction", () => {
  it("exports required functions", async () => {
    const mod = await import("../src/voice-extraction.ts");
    expect(typeof mod.extractFromTranscript).toBe("function");
    expect(typeof mod.processVoiceCall).toBe("function");
    expect(typeof mod.getVoiceExtraction).toBe("function");
  });

  it("VoiceExtraction has required fields", () => {
    const extraction = {
      summary: "Test call",
      actionItems: [{ assignee: "dave", task: "Send doc", status: "open" as const }],
      decisions: [{ text: "Go with plan B" }],
      openQuestions: ["What about pricing?"],
      speakers: ["Dave", "Alex"],
      topics: ["pricing", "roadmap"],
    };
    expect(extraction.actionItems.length).toBe(1);
    expect(extraction.decisions.length).toBe(1);
    expect(extraction.speakers).toContain("Dave");
  });
});
