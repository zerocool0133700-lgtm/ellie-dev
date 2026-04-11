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

import type Anthropic from "@anthropic-ai/sdk";

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

/**
 * Tab identifiers used by the /knowledge page.
 *
 * Note these are intentionally shorter than SurfaceId ("tree" vs "knowledge-tree").
 * SurfaceId is the globally-qualified context identifier; KnowledgeTab is the
 * local UI tab name. Curation is a tab that does not yet have a surface context
 * renderer — switching to it is allowed, but Ellie will see an empty context on
 * the next turn (safe degradation).
 */
export const KNOWLEDGE_TABS = ["tree", "river", "graph", "canvas", "curation"] as const;
export type KnowledgeTab = typeof KNOWLEDGE_TABS[number];

const TOOL_CLASSIFICATION: Record<SurfaceToolName, "auto" | "mutating"> = {
  propose_create_folder: "mutating",
  propose_move_folder: "mutating",
  propose_select_folder: "auto",
  propose_switch_tab: "auto",
  highlight_drop_zone: "auto",
};

export function isAutoApply(tool: SurfaceToolName): boolean {
  return TOOL_CLASSIFICATION[tool] === "auto";
}

export function buildSurfaceAction(
  tool: SurfaceToolName,
  args: Record<string, unknown>,
): SurfaceAction {
  return {
    tool,
    args,
    proposal_id: `prop_${crypto.randomUUID()}`,
  };
}

/**
 * Tool definitions in the format expected by the Anthropic SDK and the coordinator registry.
 *
 * Each tool is an Anthropic.Tool with no execute closure. Task 6 will dispatch via a
 * switch on tool name. buildSurfaceAction and isAutoApply are the dispatch helpers.
 */
export const SURFACE_TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "propose_create_folder",
    description: "Propose creating one or more new folders in the user's River vault. Use when the user describes content they want to organize. The user must accept the proposal before any folders are actually created.",
    input_schema: {
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
  },
  {
    name: "propose_move_folder",
    description: "Propose moving a folder to a new location in the River vault. The user must accept before the move happens.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Current folder path" },
        to: { type: "string", description: "Destination folder path" },
        reason: { type: "string", description: "Why this move makes sense" },
      },
      required: ["from", "to", "reason"],
    },
  },
  {
    name: "propose_select_folder",
    description: "Switch the user's selected folder in the panel. Auto-applied (no accept needed). Use to navigate the user to a folder that's relevant to the conversation.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Folder path to select" },
      },
      required: ["path"],
    },
  },
  {
    name: "propose_switch_tab",
    description: "Switch the active tab on /knowledge. Auto-applied.",
    input_schema: {
      type: "object",
      properties: {
        tab: {
          type: "string",
          enum: [...KNOWLEDGE_TABS],
        },
      },
      required: ["tab"],
    },
  },
  {
    name: "highlight_drop_zone",
    description: "Auto-expand the ingestion drop zone in the River tab and lock the target folder. Use after the user accepts a folder structure proposal, when you're ready for them to drop files. Auto-applied.",
    input_schema: {
      type: "object",
      properties: {
        target_folder: { type: "string" },
      },
      required: ["target_folder"],
    },
  },
];
