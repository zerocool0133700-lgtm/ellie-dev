import { describe, test, expect } from "bun:test";
import { resolveAgentScope } from "../src/context-sources";

describe("resolveAgentScope", () => {
  test("resolves dev agent to 2/1", () => {
    expect(resolveAgentScope("dev")).toBe("2/1");
  });

  test("resolves general agent to 2", () => {
    expect(resolveAgentScope("general")).toBe("2");
  });

  test("resolves unknown agent to 2", () => {
    expect(resolveAgentScope("unknown-agent")).toBe("2");
  });

  test("resolves research agent to 2", () => {
    expect(resolveAgentScope("research")).toBe("2");
  });

  test("resolves critic agent to 2/1", () => {
    expect(resolveAgentScope("critic")).toBe("2/1");
  });
});
