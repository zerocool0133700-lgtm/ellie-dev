import { describe, test, expect } from "bun:test";
import {
  buildSurfaceAction,
  isAutoApply,
  type SurfaceAction,
  type SurfaceToolName,
} from "../src/surface-tools";

describe("Surface tools", () => {
  test("buildSurfaceAction creates action with proposal_id", () => {
    const action = buildSurfaceAction("propose_create_folder", {
      paths: ["research/quantum/", "research/quantum/papers/"],
      reason: "group quantum papers",
    });

    expect(action.tool).toBe("propose_create_folder");
    expect(action.args.paths).toHaveLength(2);
    expect(action.proposal_id).toMatch(/^prop_/);
  });

  test("isAutoApply returns true for navigation tools", () => {
    expect(isAutoApply("propose_select_folder")).toBe(true);
    expect(isAutoApply("propose_switch_tab")).toBe(true);
    expect(isAutoApply("highlight_drop_zone")).toBe(true);
  });

  test("isAutoApply returns false for mutating tools", () => {
    expect(isAutoApply("propose_create_folder")).toBe(false);
    expect(isAutoApply("propose_move_folder")).toBe(false);
  });

  test("buildSurfaceAction generates unique proposal_ids", () => {
    const a = buildSurfaceAction("propose_create_folder", { paths: ["a/"], reason: "" });
    const b = buildSurfaceAction("propose_create_folder", { paths: ["b/"], reason: "" });
    expect(a.proposal_id).not.toBe(b.proposal_id);
  });

  test("SURFACE_TOOL_DEFINITIONS uses Anthropic SDK shape", async () => {
    const { SURFACE_TOOL_DEFINITIONS } = await import("../src/surface-tools");
    expect(SURFACE_TOOL_DEFINITIONS).toHaveLength(5);
    for (const tool of SURFACE_TOOL_DEFINITIONS) {
      expect(tool).toHaveProperty("name");
      expect(tool).toHaveProperty("description");
      expect(tool).toHaveProperty("input_schema");
      expect(tool).not.toHaveProperty("inputSchema");
      expect(tool).not.toHaveProperty("execute");
    }
  });
});
