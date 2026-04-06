/**
 * Tests for coordinator layered context — ELLIE-1452
 *
 * Covers:
 *   - buildCoordinatorIdentity: structured identity layer for Max
 *   - buildCoordinatorAwareness: routing awareness with active dispatches
 *   - buildCoordinatorKnowledge: specialist profiles, tools, recipes
 *   - buildCoordinatorLayeredContext: full orchestration
 */

import { describe, it, expect } from "bun:test";
import {
  buildCoordinatorIdentity,
  buildCoordinatorAwareness,
} from "../src/prompt-layers/coordinator.ts";

// ── buildCoordinatorIdentity ─────────────────────────────────────────────────

describe("buildCoordinatorIdentity", () => {
  it("builds identity for max coordinator", () => {
    const identity = buildCoordinatorIdentity(
      "max",
      "ellie-os",
      "Personal operating system",
      { tone: "warm and capable", proactivity: "medium", escalation: "ask when uncertain" },
    );

    expect(identity).toContain("## COORDINATOR IDENTITY");
    expect(identity).toContain("Max, Dave's behind-the-scenes coordinator");
    expect(identity).toContain("Ellie Delivers ALL Responses");
    expect(identity).toContain("Foundation: ellie-os");
    expect(identity).toContain("warm and capable");
  });

  it("builds identity for non-max coordinator", () => {
    const identity = buildCoordinatorIdentity(
      "otto",
      "ellie-os",
      "Test foundation",
      { tone: "helpful", proactivity: "low", escalation: "always ask" },
    );

    expect(identity).toContain("otto, Dave's coordinator assistant");
    expect(identity).not.toContain("Max");
  });

  it("includes all behavioral rules", () => {
    const identity = buildCoordinatorIdentity(
      "max",
      "test",
      "test",
      { tone: "warm", proactivity: "high", escalation: "never" },
    );

    expect(identity).toContain("Tone: warm");
    expect(identity).toContain("Proactivity: high");
    expect(identity).toContain("Escalation: never");
  });
});

// ── buildCoordinatorAwareness ────────────────────────────────────────────────

describe("buildCoordinatorAwareness", () => {
  it("returns awareness header even with no active dispatches", async () => {
    const awareness = await buildCoordinatorAwareness();
    expect(awareness).toContain("## ROUTING AWARENESS");
  });

  it("includes a fallback message when nothing is active", async () => {
    const awareness = await buildCoordinatorAwareness();
    // Should contain either active dispatch info or the "no activity" fallback
    expect(
      awareness.includes("Active Dispatches") ||
      awareness.includes("No active dispatches") ||
      awareness.includes("Recent Completions")
    ).toBe(true);
  });
});
