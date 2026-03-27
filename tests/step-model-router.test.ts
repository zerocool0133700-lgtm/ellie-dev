import { describe, it, expect } from "bun:test";
import { resolveStepModel, parseStylesheet, DEFAULT_STYLESHEET } from "../src/step-model-router.ts";

describe("ELLIE-1080: Per-step model routing", () => {
  describe("resolveStepModel", () => {
    it("routes classify steps to haiku", () => {
      const result = resolveStepModel("classify-intent");
      expect(result.model).toBe("haiku");
      expect(result.reasoning_effort).toBe("low");
    });

    it("routes implement steps to opus", () => {
      const result = resolveStepModel("implement-feature");
      expect(result.model).toBe("opus");
      expect(result.reasoning_effort).toBe("high");
    });

    it("routes review steps to sonnet", () => {
      const result = resolveStepModel("review-code");
      expect(result.model).toBe("sonnet");
    });

    it("uses default for unmatched steps", () => {
      const result = resolveStepModel("custom-step");
      expect(result.model).toBe("sonnet");
    });

    it("explicit step model overrides stylesheet", () => {
      const result = resolveStepModel("classify-intent", "opus");
      expect(result.model).toBe("opus");
    });
  });

  describe("parseStylesheet", () => {
    it("parses config into stylesheet", () => {
      const ss = parseStylesheet({
        default: "haiku",
        rules: [
          { match: "deploy*", model: "opus", reasoning_effort: "high" },
        ],
      });
      expect(ss.default).toBe("haiku");
      expect(ss.rules.length).toBe(1);
      expect(ss.rules[0].model).toBe("opus");
    });
  });

  describe("DEFAULT_STYLESHEET", () => {
    it("has rules for common step patterns", () => {
      expect(DEFAULT_STYLESHEET.rules.length).toBeGreaterThan(5);
    });

    it("defaults to sonnet", () => {
      expect(DEFAULT_STYLESHEET.default).toBe("sonnet");
    });
  });
});
