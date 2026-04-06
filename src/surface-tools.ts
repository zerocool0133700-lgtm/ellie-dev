/**
 * Surface action tools — Ellie's vocabulary for proposing changes to a UI surface.
 *
 * These are PROPOSAL tools, not action tools. They do NOT mutate state on the relay.
 * They emit a SurfaceAction payload that gets attached to the response message.
 * The panel receives the payload and:
 *   - Auto-applies navigation tools (propose_select_folder, propose_switch_tab, highlight_drop_zone)
 *   - Renders preview cards for mutating tools (propose_create_folder, propose_move_folder)
 *
 * See: docs/superpowers/specs/2026-04-06-knowledge-surface-and-ingestion-design.md
 */

export type SurfaceToolName =
  | "propose_create_folder"
  | "propose_move_folder"
  | "propose_select_folder"
  | "propose_switch_tab"
  | "highlight_drop_zone";

export interface SurfaceAction {
  tool: SurfaceToolName;
  args: Record<string, unknown>;
  proposal_id: string;
}

const AUTO_APPLY_TOOLS: ReadonlySet<SurfaceToolName> = new Set([
  "propose_select_folder",
  "propose_switch_tab",
  "highlight_drop_zone",
]);

export function isAutoApply(tool: SurfaceToolName): boolean {
  return AUTO_APPLY_TOOLS.has(tool);
}

export function buildSurfaceAction(
  tool: SurfaceToolName,
  args: Record<string, unknown>,
): SurfaceAction {
  return {
    tool,
    args,
    proposal_id: `prop_${crypto.randomUUID().slice(0, 8)}`,
  };
}

// Tool definitions in the format expected by the coordinator/tool registry.
// Each tool's "execute" function returns a SurfaceAction (no side effects).
export const SURFACE_TOOL_DEFINITIONS = [
  {
    name: "propose_create_folder",
    description: "Propose creating one or more new folders in the user's River vault. Use when the user describes content they want to organize. The user must accept the proposal before any folders are actually created.",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Relative folder paths to create, e.g. ['research/quantum/', 'research/quantum/papers/']",
        },
        reason: {
          type: "string",
          description: "Why this structure makes sense for what the user is loading",
        },
      },
      required: ["paths", "reason"],
    },
    execute: (args: Record<string, unknown>): SurfaceAction =>
      buildSurfaceAction("propose_create_folder", args),
  },
  {
    name: "propose_move_folder",
    description: "Propose moving a folder to a new location in the River vault. The user must accept before the move happens.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Current folder path" },
        to: { type: "string", description: "Destination folder path" },
        reason: { type: "string", description: "Why this move makes sense" },
      },
      required: ["from", "to", "reason"],
    },
    execute: (args: Record<string, unknown>): SurfaceAction =>
      buildSurfaceAction("propose_move_folder", args),
  },
  {
    name: "propose_select_folder",
    description: "Switch the user's selected folder in the panel. Auto-applied (no accept needed). Use to navigate the user to a folder that's relevant to the conversation.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Folder path to select" },
      },
      required: ["path"],
    },
    execute: (args: Record<string, unknown>): SurfaceAction =>
      buildSurfaceAction("propose_select_folder", args),
  },
  {
    name: "propose_switch_tab",
    description: "Switch the active tab on /knowledge. Auto-applied.",
    inputSchema: {
      type: "object",
      properties: {
        tab: {
          type: "string",
          enum: ["tree", "river", "graph", "canvas", "curation"],
        },
      },
      required: ["tab"],
    },
    execute: (args: Record<string, unknown>): SurfaceAction =>
      buildSurfaceAction("propose_switch_tab", args),
  },
  {
    name: "highlight_drop_zone",
    description: "Auto-expand the ingestion drop zone in the River tab and lock the target folder. Use after the user accepts a folder structure proposal, when you're ready for them to drop files. Auto-applied.",
    inputSchema: {
      type: "object",
      properties: {
        target_folder: { type: "string" },
      },
      required: ["target_folder"],
    },
    execute: (args: Record<string, unknown>): SurfaceAction =>
      buildSurfaceAction("highlight_drop_zone", args),
  },
];
