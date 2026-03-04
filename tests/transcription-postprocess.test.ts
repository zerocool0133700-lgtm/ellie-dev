import { describe, it, expect } from "bun:test";
import { applyTranscriptionCorrections } from "../src/transcription-postprocess.ts";

describe("applyTranscriptionCorrections", () => {
  // Note: The regex patterns use \b boundaries, so trailing dots from
  // abbreviations at end of sentence may be preserved as sentence periods.

  it("corrects L.E. at end of sentence (trailing dot preserved as period)", () => {
    // "L.E." at end — regex matches "L.E" and trailing "." stays as sentence period
    expect(applyTranscriptionCorrections("Talk to L.E.")).toBe("Talk to Ellie.");
  });

  it("corrects LE to Ellie", () => {
    expect(applyTranscriptionCorrections("Ask LE about that")).toBe("Ask Ellie about that");
  });

  it("corrects L.E.O.S. at end (trailing dot preserved)", () => {
    expect(applyTranscriptionCorrections("Open L.E.O.S. now")).toBe("Open Ellie OS. now");
  });

  it("corrects LEOS to Ellie OS", () => {
    expect(applyTranscriptionCorrections("Start LEOS")).toBe("Start Ellie OS");
  });

  it("corrects Elliot OS to Ellie OS", () => {
    expect(applyTranscriptionCorrections("Launch Elliot OS")).toBe("Launch Ellie OS");
  });

  it("corrects Elliot O.S. at end (trailing dot preserved)", () => {
    expect(applyTranscriptionCorrections("Open Elliot O.S.")).toBe("Open Ellie OS.");
  });

  it("handles case insensitivity", () => {
    expect(applyTranscriptionCorrections("talk to l.e.")).toBe("talk to Ellie.");
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
    expect(result).toBe("Ellie OS. is great and Ellie. helps");
  });

  it("corrects L.E.O.S. at end of string", () => {
    const result = applyTranscriptionCorrections("L.E.O.S.");
    // Regex matches LEOS part, trailing dot preserved
    expect(result).toBe("Ellie OS.");
  });

  it("corrects LE mid-sentence without trailing dot", () => {
    const result = applyTranscriptionCorrections("Ask LE for help");
    expect(result).toBe("Ask Ellie for help");
  });
});
