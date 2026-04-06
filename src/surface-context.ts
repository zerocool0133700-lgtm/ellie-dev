/**
 * Surface Context — typed state from a UI surface that Ellie's panel is embedded on.
 *
 * Each surface (knowledge-tree, knowledge-river, etc.) defines its own context shape.
 * The relay receives this on incoming messages from a surface panel and injects a
 * rendered version into Ellie's prompt so she reasons with awareness.
 *
 * See: docs/superpowers/specs/2026-04-06-knowledge-surface-and-ingestion-design.md
 */

export type SurfaceId =
  | "knowledge-tree"
  | "knowledge-river"
  | "knowledge-graph"
  | "knowledge-canvas";

export interface BaseSurfaceContext {
  surface_id: SurfaceId;
  surface_origin: string; // unique panel instance id
}

export interface KnowledgeTreeContext extends BaseSurfaceContext {
  surface_id: "knowledge-tree";
  selection: {
    scope_path: string | null;
    scope_name: string | null;
    memory_count: number;
  };
  forest_summary: {
    total_scopes: number;
    total_memories: number;
  };
}

export interface KnowledgeRiverContext extends BaseSurfaceContext {
  surface_id: "knowledge-river";
  selection: {
    folder: string | null;
    folder_file_count: number;
    folder_subfolder_count: number;
    last_files: string[];
  };
  ingestion_state: {
    in_progress: boolean;
    queued: number;
    last_ingested_at: string | null;
  };
  river_summary: {
    total_docs: number;
    total_folders: number;
  };
}

export type SurfaceContext = KnowledgeTreeContext | KnowledgeRiverContext;

// ── Renderer Registry ────────────────────────────────────────

type SurfaceRenderer = (ctx: SurfaceContext) => string;

const renderers = new Map<SurfaceId, SurfaceRenderer>();

export function registerSurfaceRenderer(id: SurfaceId, renderer: SurfaceRenderer): void {
  renderers.set(id, renderer);
}

export function renderSurfaceContext(ctx: SurfaceContext): string {
  const renderer = renderers.get(ctx.surface_id);
  return renderer ? renderer(ctx) : "";
}

// ── Built-in renderers ───────────────────────────────────────

registerSurfaceRenderer("knowledge-tree", (ctx) => {
  const c = ctx as KnowledgeTreeContext;
  const lines: string[] = [];
  lines.push("The user is on /knowledge → Tree tab.");
  if (c.selection.scope_path) {
    lines.push(`- Selected scope: ${c.selection.scope_name} (${c.selection.scope_path}) — ${c.selection.memory_count} memories`);
  } else {
    lines.push("- No scope selected.");
  }
  lines.push(`- Forest has ${c.forest_summary.total_scopes} scopes and ${c.forest_summary.total_memories} total memories.`);
  lines.push("");
  lines.push("You can propose actions that affect this surface — they will be added to the surface_actions array on your response.");
  return lines.join("\n");
});

registerSurfaceRenderer("knowledge-river", (ctx) => {
  const c = ctx as KnowledgeRiverContext;
  const lines: string[] = [];
  lines.push("The user is on /knowledge → River tab.");
  if (c.selection.folder) {
    lines.push(`- Selected folder: ${c.selection.folder} (${c.selection.folder_file_count} files, ${c.selection.folder_subfolder_count} subfolders)`);
    if (c.selection.last_files.length > 0) {
      lines.push(`- Recent files: ${c.selection.last_files.join(", ")}`);
    }
  } else {
    lines.push("- No folder selected.");
  }
  lines.push(`- River has ${c.river_summary.total_docs} indexed docs across ${c.river_summary.total_folders} folders.`);
  if (c.ingestion_state.in_progress) {
    lines.push(`- Ingestion in progress: ${c.ingestion_state.queued} files queued.`);
  }
  lines.push("");
  lines.push("You can propose actions that affect this surface — they will be added to the surface_actions array on your response.");
  return lines.join("\n");
});
