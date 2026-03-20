/**
 * Memory Arc Detection Tests — ELLIE-934 + Fixes #1, #2, #11b, #12
 *
 * Tests arc direction inference (now exported) and detection function shapes.
 */

import { describe, test, expect } from "bun:test";
import { inferDirection } from "../../ellie-forest/src/arcs";

describe("ELLIE-934: inferDirection (now exported)", () => {
  test("growing when confidence increases", () => {
    expect(inferDirection([0.3, 0.4, 0.7, 0.9])).toBe("growing");
  });

  test("declining when confidence decreases", () => {
    expect(inferDirection([0.9, 0.8, 0.4, 0.3])).toBe("declining");
  });

  test("stable when flat", () => {
    expect(inferDirection([0.5, 0.5, 0.5, 0.5])).toBe("stable");
  });

  test("stable for small delta within threshold", () => {
    expect(inferDirection([0.5, 0.5, 0.55, 0.55])).toBe("stable");
  });

  test("exploring for single value", () => {
    expect(inferDirection([0.5])).toBe("exploring");
  });

  test("exploring for empty", () => {
    expect(inferDirection([])).toBe("exploring");
  });

  test("handles two values", () => {
    expect(inferDirection([0.3, 0.9])).toBe("growing");
    expect(inferDirection([0.9, 0.3])).toBe("declining");
  });

  test("long growing sequence", () => {
    expect(inferDirection([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9])).toBe("growing");
  });
});

describe("Fix #1/#2: detection functions are exported and typed correctly", () => {
  test("detectArcsFromChains is async function", async () => {
    const { detectArcsFromChains } = await import("../../ellie-forest/src/arcs");
    expect(typeof detectArcsFromChains).toBe("function");
  });

  test("detectArcsFromClusters is async function", async () => {
    const { detectArcsFromClusters } = await import("../../ellie-forest/src/arcs");
    expect(typeof detectArcsFromClusters).toBe("function");
  });

  test("inferDirection is re-exported from index", async () => {
    const { inferDirection: exported } = await import("../../ellie-forest/src/index");
    expect(typeof exported).toBe("function");
    expect(exported([0.3, 0.9])).toBe("growing");
  });
});
