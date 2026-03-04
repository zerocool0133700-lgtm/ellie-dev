import { describe, it, expect } from "bun:test";
import { applyTranscriptionCorrections } from "../src/transcription-postprocess.ts";

describe("applyTranscriptionCorrections", () => {
  it("corrects L.E. to Ellie", () => {
    expect(applyTranscriptionCorrections("Talk to L.E.")).toBe("Talk to Ellie");
  });

  it("corrects LE to Ellie", () => {
    expect(applyTranscriptionCorrections("Ask LE about that")).toBe("Ask Ellie about that");
  });

  it("corrects L.E.O.S. to Ellie OS", () => {
    expect(applyTranscriptionCorrections("Open L.E.O.S. now")).toBe("Open Ellie OS now");
  });

  it("corrects LEOS to Ellie OS", () => {
    expect(applyTranscriptionCorrections("Start LEOS")).toBe("Start Ellie OS");
  });

  it("corrects Elliot OS to Ellie OS", () => {
    expect(applyTranscriptionCorrections("Launch Elliot OS")).toBe("Launch Ellie OS");
  });

  it("corrects Elliot O.S. to Ellie OS", () => {
    expect(applyTranscriptionCorrections("Open Elliot O.S.")).toBe("Open Ellie OS");
  });

  it("handles case insensitivity", () => {
    expect(applyTranscriptionCorrections("talk to l.e.")).toBe("talk to Ellie");
  });

  it("returns empty string unchanged", () => {
    expect(applyTranscriptionCorrections("")).toBe("");
  });

  it("returns text with no matches unchanged", () => {
    const input = "Hello world, nothing to correct here.";
    expect(applyTranscriptionCorrections(input)).toBe(input);
  });

  it("handles multiple corrections in one string", () => {
    const result = applyTranscriptionCorrections("L.E.O.S. is great and L.E. helps");
    expect(result).toBe("Ellie OS is great and Ellie helps");
  });

  it("prioritizes longer patterns (L.E.O.S. before L.E.)", () => {
    // L.E.O.S. should not be partially matched as L.E. + O.S.
    const result = applyTranscriptionCorrections("L.E.O.S.");
    expect(result).toBe("Ellie OS");
  });
});
