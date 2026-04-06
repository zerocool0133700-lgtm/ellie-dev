import { describe, test, expect } from "bun:test";
import { buildLayeredContext } from "../src/prompt-layers/index";
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
    expect(rendered).toContain("surface_actions");
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

  test("renders knowledge-river context with folder and ingestion in progress", () => {
    const ctx: import("../src/surface-context").KnowledgeRiverContext = {
      surface_id: "knowledge-river",
      surface_origin: "panel-river-1",
      selection: {
        folder: "research/quantum",
        folder_file_count: 12,
        folder_subfolder_count: 2,
        last_files: ["paper-a.md", "paper-b.md"],
      },
      ingestion_state: {
        in_progress: true,
        queued: 3,
        last_ingested_at: "2026-04-06T12:00:00Z",
      },
      river_summary: {
        total_docs: 38,
        total_folders: 7,
      },
    };

    const rendered = renderSurfaceContext(ctx);

    expect(rendered).toContain("River");
    expect(rendered).toContain("research/quantum");
    expect(rendered).toContain("12");
    expect(rendered).toContain("paper-a.md");
    expect(rendered).toContain("38");
    expect(rendered).toContain("7");
    expect(rendered).toContain("3 files queued");
    expect(rendered).toContain("surface_actions");
  });

  test("knowledge-river renderer handles no folder selected", () => {
    const ctx: import("../src/surface-context").KnowledgeRiverContext = {
      surface_id: "knowledge-river",
      surface_origin: "panel-river-2",
      selection: {
        folder: null,
        folder_file_count: 0,
        folder_subfolder_count: 0,
        last_files: [],
      },
      ingestion_state: {
        in_progress: false,
        queued: 0,
        last_ingested_at: null,
      },
      river_summary: {
        total_docs: 38,
        total_folders: 7,
      },
    };

    const rendered = renderSurfaceContext(ctx);
    expect(rendered).toContain("No folder selected");
    expect(rendered).not.toContain("files queued");
  });
});

describe("Surface context injection in layered prompt", () => {
  test("surfaceContext field is empty string when no context provided", async () => {
    const result = await buildLayeredContext("hello", "ellie-chat", "ellie", null);
    expect(result.surfaceContext).toBe("");
  });

  test("surfaceContext field contains rendered section when context provided", async () => {
    const ctx: KnowledgeTreeContext = {
      surface_id: "knowledge-tree",
      surface_origin: "panel-test",
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
    const result = await buildLayeredContext("hello", "ellie-chat", "ellie", null, undefined, ctx);
    expect(result.surfaceContext).toContain("## SURFACE CONTEXT");
    expect(result.surfaceContext).toContain("Tree tab");
    expect(result.surfaceContext).toContain("memory");
  });
});
