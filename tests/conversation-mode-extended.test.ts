import { describe, test, expect } from "bun:test";
import {
  detectLayeredMode,
  MODE_AWARENESS_FILTERS,
} from "../src/context-mode";
import type { LayeredMode } from "../src/prompt-layers/types";

describe("Layered mode detection", () => {
  test("voice channel → voice-casual", () => {
    const result = detectLayeredMode("hey how's it going", "voice");
    expect(result.mode).toBe("voice-casual");
  });

  test("voice channel with code signals → dev-session", () => {
    const result = detectLayeredMode("the Forest migration ELLIE-500 is broken", "voice");
    expect(result.mode).toBe("dev-session");
  });

  test("ellie-chat with ticket reference → dev-session", () => {
    const result = detectLayeredMode("work on ELLIE-123", "ellie-chat");
    expect(result.mode).toBe("dev-session");
  });

  test("personal topic → personal", () => {
    const result = detectLayeredMode("Georgia had a great day at school today", "telegram");
    expect(result.mode).toBe("personal");
  });

  test("planning language → planning", () => {
    const result = detectLayeredMode("what should we prioritize next week", "ellie-chat");
    expect(result.mode).toBe("planning");
  });

  test("no user message → heartbeat", () => {
    const result = detectLayeredMode(null, null);
    expect(result.mode).toBe("heartbeat");
  });

  test("casual greeting on telegram → voice-casual", () => {
    const result = detectLayeredMode("hey ellie", "telegram");
    expect(result.mode).toBe("voice-casual");
  });

  test("vscode channel → dev-session", () => {
    const result = detectLayeredMode("what does this function do", "vscode");
    expect(result.mode).toBe("dev-session");
  });

  test("default fallback → dev-session", () => {
    const result = detectLayeredMode("something ambiguous", "ellie-chat");
    expect(result.mode).toBe("dev-session");
  });

  test("all modes have awareness filters defined", () => {
    const modes: LayeredMode[] = ["voice-casual", "dev-session", "planning", "personal", "heartbeat"];
    for (const mode of modes) {
      expect(MODE_AWARENESS_FILTERS[mode]).toBeDefined();
      expect(MODE_AWARENESS_FILTERS[mode].work).toBeDefined();
    }
  });
});
