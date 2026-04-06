import { describe, test, expect } from "bun:test";
import {
  renderSurfaceContext,
  registerSurfaceRenderer,
  type SurfaceContext,
  type KnowledgeTreeContext,
} from "../src/surface-context";

describe("SurfaceContext renderer registry", () => {
  test("renders knowledge-tree context to natural language", () => {
    const ctx: KnowledgeTreeContext = {
      surface_id: "knowledge-tree",
      surface_origin: "panel-abc123",
      selection: {
        scope_path: "2/1/3",
        scope_name: "memory",
        memory_count: 432,
      },
      forest_summary: {
        total_scopes: 163,
        total_memories: 4274,
      },
    };

    const rendered = renderSurfaceContext(ctx);

    expect(rendered).toContain("/knowledge");
    expect(rendered).toContain("Tree");
    expect(rendered).toContain("memory");
    expect(rendered).toContain("2/1/3");
    expect(rendered).toContain("432");
    expect(rendered).toContain("163");
    expect(rendered).toContain("4274");
  });

  test("returns empty string for unregistered surface_id", () => {
    const ctx = {
      surface_id: "unknown-surface" as any,
      surface_origin: "panel-xyz",
    };
    const rendered = renderSurfaceContext(ctx as SurfaceContext);
    expect(rendered).toBe("");
  });

  test("custom renderer can be registered and used", () => {
    registerSurfaceRenderer("custom-test" as any, (ctx) => `CUSTOM: ${ctx.surface_origin}`);
    const ctx = {
      surface_id: "custom-test" as any,
      surface_origin: "panel-test",
    };
    const rendered = renderSurfaceContext(ctx as SurfaceContext);
    expect(rendered).toBe("CUSTOM: panel-test");
  });
});
