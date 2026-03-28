import { describe, test, expect } from "bun:test";
import {
  createEnvelope,
  completeEnvelope,
  failEnvelope,
  computeCost,
  type DispatchEnvelope,
} from "../src/dispatch-envelope";

describe("DispatchEnvelope", () => {
  test("createEnvelope produces a valid envelope with defaults", () => {
    const env = createEnvelope({
      type: "coordinator",
      agent: "ellie",
      foundation: "software-dev",
    });

    expect(env.id).toMatch(/^dsp_/);
    expect(env.type).toBe("coordinator");
    expect(env.agent).toBe("ellie");
    expect(env.foundation).toBe("software-dev");
    expect(env.parent_id).toBeNull();
    expect(env.status).toBe("running");
    expect(env.started_at).toBeTruthy();
    expect(env.completed_at).toBeNull();
    expect(env.tokens_in).toBe(0);
    expect(env.tokens_out).toBe(0);
    expect(env.cost_usd).toBe(0);
    expect(env.error).toBeNull();
    expect(env.work_item_id).toBeNull();
  });

  test("createEnvelope accepts optional fields", () => {
    const env = createEnvelope({
      type: "specialist",
      agent: "james",
      foundation: "software-dev",
      parent_id: "dsp_abc123",
      model: "claude-sonnet-4-6",
      work_item_id: "ELLIE-500",
    });

    expect(env.parent_id).toBe("dsp_abc123");
    expect(env.model).toBe("claude-sonnet-4-6");
    expect(env.work_item_id).toBe("ELLIE-500");
  });

  test("completeEnvelope sets status and timestamps", () => {
    const env = createEnvelope({ type: "specialist", agent: "james", foundation: "software-dev" });
    const completed = completeEnvelope(env, { tokens_in: 1000, tokens_out: 500, model: "claude-sonnet-4-6" });

    expect(completed.status).toBe("completed");
    expect(completed.completed_at).toBeTruthy();
    expect(completed.tokens_in).toBe(1000);
    expect(completed.tokens_out).toBe(500);
    expect(completed.cost_usd).toBeGreaterThan(0);
  });

  test("failEnvelope sets error and status", () => {
    const env = createEnvelope({ type: "specialist", agent: "james", foundation: "software-dev" });
    const failed = failEnvelope(env, "timeout after 900s");

    expect(failed.status).toBe("error");
    expect(failed.error).toBe("timeout after 900s");
    expect(failed.completed_at).toBeTruthy();
  });

  test("computeCost uses sonnet pricing correctly", () => {
    // Sonnet: $3/M input, $15/M output
    const cost = computeCost("claude-sonnet-4-6", 1_000_000, 1_000_000);
    expect(cost).toBe(18.0); // $3 + $15
  });

  test("computeCost falls back to sonnet for unknown models", () => {
    const cost = computeCost("unknown-model", 1_000_000, 0);
    expect(cost).toBe(3.0); // Sonnet input price
  });
});
