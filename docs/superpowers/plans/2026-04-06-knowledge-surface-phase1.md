# Knowledge Surface — Phase 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the reusable Ellie surface panel pattern — a chat panel that can be embedded on any UI surface, knows the surface state via `surface_context`, and lets Ellie propose actions that the page renders as preview cards. Mount it on `/knowledge` Tree tab as the first real application.

**Architecture:** Three coordinated changes: (1) extend the WebSocket protocol to carry `surface_context` from the panel and `surface_actions` array on responses, (2) inject a "Surface Context" section into the prompt builder so Ellie reasons with awareness, (3) build the `EllieSurfacePanel.vue` Vue component that handles the wire format, surface awareness banner, and proposal preview cards. Phase 1 ends with Ellie embedded on `/knowledge` Tree tab — surface-aware, with the proposal pattern wired end-to-end (no actual mutations yet, that's Phase 2).

**Tech Stack:** TypeScript, Bun, Nuxt 4, Vue 3, Tailwind v4, WebSocket

**Spec:** `docs/superpowers/specs/2026-04-06-knowledge-surface-and-ingestion-design.md` (Phase 1A/1B/1C — they ship together as one cohesive deliverable)

**Repos:**
- `ellie-dev` (the relay) — WebSocket schema, prompt builder, surface action tools
- `ellie-home` (the dashboard) — Vue panel component, types, mount on `/knowledge`

---

## File Structure

| File | Repo | Responsibility |
|------|------|----------------|
| Create: `src/surface-context.ts` | ellie-dev | Surface context type definitions + per-surface renderer registry |
| Create: `src/surface-tools.ts` | ellie-dev | Surface action tool definitions (propose_create_folder etc.) and the SurfaceAction type |
| Modify: `src/prompt-layers/index.ts` | ellie-dev | Inject Surface Context section when surface_context is present on a message |
| Modify: `src/ellie-chat-pipeline.ts` | ellie-dev | Pass surface_context through to the prompt builder |
| Modify: `src/ellie-chat-handler.ts` | ellie-dev | Accept surface_context from incoming WS messages, attach surface_actions to outgoing responses |
| Modify: `src/coordinator-tools.ts` | ellie-dev | Register surface action tools when surface_context is present |
| Create: `tests/surface-context.test.ts` | ellie-dev | Tests for context renderers + tool registration logic |
| Create: `tests/surface-tools.test.ts` | ellie-dev | Tests for tool argument parsing and surface_action emission |
| Create: `app/types/surface-context.ts` | ellie-home | TypeScript discriminated union types matching the relay |
| Create: `app/components/ellie/EllieSurfacePanel.vue` | ellie-home | Reusable embedded chat panel with surface awareness |
| Create: `app/components/ellie/ProposalPreviewCard.vue` | ellie-home | Visual preview card for mutating proposals |
| Modify: `app/composables/useEllieChat.ts` | ellie-home | Add surface_context to outgoing messages, route surface_actions to panels by surface_origin |
| Modify: `app/pages/knowledge.vue` | ellie-home | Mount EllieSurfacePanel on the right side, provide Tree tab surface context |

---

### Task 1: Define SurfaceContext types in the relay

**Files:**
- Create: `/home/ellie/ellie-dev/src/surface-context.ts`
- Create: `/home/ellie/ellie-dev/tests/surface-context.test.ts`

**Context:** This file holds the discriminated union types for `SurfaceContext` and a per-surface renderer registry. Each surface (e.g., `knowledge-tree`, `knowledge-river`) registers a renderer function that turns its context into the natural-language section that gets injected into Ellie's prompt.

- [ ] **Step 1: Write the failing test**

Create `/home/ellie/ellie-dev/tests/surface-context.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ellie/ellie-dev && bun test tests/surface-context.test.ts`
Expected: FAIL with "Cannot find module './src/surface-context'"

- [ ] **Step 3: Create the surface-context module**

Create `/home/ellie/ellie-dev/src/surface-context.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/ellie/ellie-dev && bun test tests/surface-context.test.ts`
Expected: PASS (3 tests pass)

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/surface-context.ts tests/surface-context.test.ts
git commit -m "[ELLIE-1455] add SurfaceContext types and renderer registry

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Define SurfaceAction types and tools in the relay

**Files:**
- Create: `/home/ellie/ellie-dev/src/surface-tools.ts`
- Create: `/home/ellie/ellie-dev/tests/surface-tools.test.ts`

**Context:** Surface action tools are the way Ellie proposes changes to a surface. They don't mutate state — they emit a `SurfaceAction` payload that gets attached to the response message. The panel receives the action and renders a preview card.

- [ ] **Step 1: Write the failing test**

Create `/home/ellie/ellie-dev/tests/surface-tools.test.ts`:

```typescript
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ellie/ellie-dev && bun test tests/surface-tools.test.ts`
Expected: FAIL with "Cannot find module './src/surface-tools'"

- [ ] **Step 3: Create the surface-tools module**

Create `/home/ellie/ellie-dev/src/surface-tools.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/ellie/ellie-dev && bun test tests/surface-tools.test.ts`
Expected: PASS (4 tests pass)

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/surface-tools.ts tests/surface-tools.test.ts
git commit -m "[ELLIE-1455] add SurfaceAction types and surface tool definitions

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Inject Surface Context section into the layered prompt builder

**Files:**
- Modify: `/home/ellie/ellie-dev/src/prompt-layers/types.ts`
- Modify: `/home/ellie/ellie-dev/src/prompt-layers/index.ts`
- Modify: `/home/ellie/ellie-dev/src/ellie-chat-pipeline.ts`
- Modify: `/home/ellie/ellie-dev/tests/surface-context.test.ts`

**Context:** When a message arrives from a surface panel, it carries `surface_context`. The prompt builder needs to render that context into a "Surface Context" section and include it in the prompt at priority 4 (between Awareness and Knowledge layers).

- [ ] **Step 1: Add `surfaceContext` field to LayeredPromptResult**

Read `/home/ellie/ellie-dev/src/prompt-layers/types.ts` and find the `LayeredPromptResult` interface. Add `surfaceContext: string` to it. The interface is somewhere in the file — search for `LayeredPromptResult`.

```typescript
// Inside the LayeredPromptResult interface:
export interface LayeredPromptResult {
  identity: string;
  awareness: string;
  surfaceContext: string;  // ELLIE-1455: rendered surface context (empty if none)
  knowledge: string;
  mode: LayeredMode;
  totalBytes: number;
}
```

- [ ] **Step 2: Update buildLayeredContext to accept and render surface_context**

Modify `/home/ellie/ellie-dev/src/prompt-layers/index.ts`:

Add to the imports at the top:
```typescript
import { renderSurfaceContext } from "../surface-context";
import type { SurfaceContext } from "../surface-context";
```

Update the `buildLayeredContext` function signature and body:

```typescript
export async function buildLayeredContext(
  message: string | null,
  channel: string | null,
  agent: string = "ellie",
  supabase: any = null,
  modeOverride?: LayeredMode,
  surfaceContext?: SurfaceContext | null,  // ELLIE-1455
): Promise<LayeredPromptResult> {
  const start = Date.now();

  // 1. Detect mode
  const { mode, signal } = modeOverride
    ? { mode: modeOverride, signal: `override:${modeOverride}` }
    : detectLayeredMode(message, channel);

  logger.info({ mode, signal, channel }, "Layered prompt: mode detected");

  // 2. Build all three layers in parallel
  const [identity, awareness, knowledgeResult] = await Promise.all([
    renderIdentityBlock(),
    buildAwareness(supabase).then(a => filterAwarenessByMode(a, mode)),
    retrieveKnowledge(message, mode, agent),
  ]);

  const knowledge = renderKnowledge(knowledgeResult);

  // ELLIE-1455: Render surface context if present
  const surfaceContextRendered = surfaceContext
    ? `## SURFACE CONTEXT\n${renderSurfaceContext(surfaceContext)}`
    : "";

  // 3. Check total budget
  const encoder = new TextEncoder();
  const totalBytes = encoder.encode(identity).length +
    encoder.encode(awareness).length +
    encoder.encode(surfaceContextRendered).length +
    encoder.encode(knowledge).length;

  if (totalBytes > TOTAL_BUDGET_BYTES) {
    logger.warn({ totalBytes, budget: TOTAL_BUDGET_BYTES, mode },
      "Layered prompt exceeds budget — knowledge will be trimmed");
  }

  const elapsed = Date.now() - start;
  logger.info({ mode, totalBytes, elapsed, hasSurfaceContext: !!surfaceContext }, "Layered prompt built");

  return {
    identity,
    awareness,
    surfaceContext: surfaceContextRendered,
    knowledge,
    mode,
    totalBytes,
  };
}
```

- [ ] **Step 3: Update gatherLayeredContext in pipeline to accept surfaceContext**

Modify `/home/ellie/ellie-dev/src/ellie-chat-pipeline.ts` (around line 164):

```typescript
import { buildLayeredContext } from "./prompt-layers/index";
import type { LayeredPromptResult } from "./prompt-layers/types";
import type { SurfaceContext } from "./surface-context";

/**
 * Layered alternative to _gatherContextSources().
 * Returns structured layers instead of a flat context bag.
 */
export async function gatherLayeredContext(
  message: string | null,
  channel: string | null,
  agent: string,
  supabase: any,
  surfaceContext?: SurfaceContext | null,
): Promise<LayeredPromptResult> {
  return buildLayeredContext(message, channel, agent, supabase, undefined, surfaceContext);
}
```

- [ ] **Step 4: Add a test for the surface context injection**

Append this to `/home/ellie/ellie-dev/tests/surface-context.test.ts`:

```typescript
import { buildLayeredContext } from "../src/prompt-layers/index";

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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /home/ellie/ellie-dev && bun test tests/surface-context.test.ts`
Expected: PASS (5 tests pass)

- [ ] **Step 6: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/prompt-layers/types.ts src/prompt-layers/index.ts src/ellie-chat-pipeline.ts tests/surface-context.test.ts
git commit -m "[ELLIE-1455] inject Surface Context section into layered prompt builder

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Plumb surface_context from WebSocket through the handler signature

**Files:**
- Modify: `/home/ellie/ellie-dev/src/websocket-servers.ts`
- Modify: `/home/ellie/ellie-dev/src/ellie-chat-handler.ts`

**Context (audit-corrected):** The actual /ellie-chat hot path runs through `runCoordinatorLoop` (when `COORDINATOR_MODE=true`), NOT through `gatherLayeredContext`/`buildLayeredContext`. The original plan wired surface context into a code path the coordinator branch never reads. This task plumbs `surface_context` from the raw WebSocket message → `handleEllieChatMessage` signature → into a local variable in the same scope as `coordMessage` (line ~1367) and `gatherLayeredContext` (line ~964) so both Tasks 5 and 6 can consume it. The actual coordinator wiring happens in Task 5.

- [ ] **Step 1: Add surface_context param to the WS dispatcher call**

Edit `/home/ellie/ellie-dev/src/websocket-servers.ts` around line 458. Current call:

```typescript
handleEllieChatMessage(ws, msg.text || "", !!msg.phone_mode, msg.image, msg.channel_id, msg.id, msg.mode, abortCtrl.signal, msg.reply_to, msg.thread_id);
```

Add `msg.surface_context` as a new final argument:

```typescript
handleEllieChatMessage(ws, msg.text || "", !!msg.phone_mode, msg.image, msg.channel_id, msg.id, msg.mode, abortCtrl.signal, msg.reply_to, msg.thread_id, msg.surface_context);
```

- [ ] **Step 2: Add surfaceContext param to handleEllieChatMessage**

Edit `/home/ellie/ellie-dev/src/ellie-chat-handler.ts` lines 219–248. Add an import near the existing imports at the top (around line 65):

```typescript
import type { SurfaceContext } from "./surface-context";
```

Update the exported `handleEllieChatMessage` signature (line 219) — append `surfaceContext` as the 11th parameter:

```typescript
export async function handleEllieChatMessage(
  ws: WebSocket,
  text: string,
  phoneMode: boolean = false,
  image?: { data: string; mime_type: string; name: string },
  channelId?: string,
  clientId?: string,
  mode?: string,
  abortSignal?: AbortSignal,
  replyTo?: { id: string; text: string; role: string; agent?: string },
  threadId?: string,
  surfaceContext?: SurfaceContext, // ELLIE-1455
): Promise<void> {
```

Update the inner `withTrace` call on line 233 to forward `surfaceContext`:

```typescript
return await withTrace(async () => _handleEllieChatMessage(ws, text, phoneMode, image, channelId, clientId, mode, abortSignal, replyTo, threadId, surfaceContext));
```

- [ ] **Step 3: Add surfaceContext param to _handleEllieChatMessage**

Update the inner `_handleEllieChatMessage` signature (line 250) to match — append the same param:

```typescript
async function _handleEllieChatMessage(
  ws: WebSocket,
  text: string,
  phoneMode: boolean,
  image?: { data: string; mime_type: string; name: string },
  channelId?: string,
  clientId?: string,
  mode?: string,
  abortSignal?: AbortSignal,
  replyTo?: { id: string; text: string; role: string; agent?: string },
  threadId?: string,
  surfaceContext?: SurfaceContext, // ELLIE-1455
): Promise<void> {
```

That's it for Task 4 — `surfaceContext` is now in the function-scope of `_handleEllieChatMessage`, which means it's visible at line ~964 (gatherLayeredContext call) AND at line ~1427 (runCoordinatorLoop call) AND at line ~1496 (responsePayload construction). Tasks 5 and 6 will consume it from this scope. **Critically, the variable is declared at the OUTER function scope so it survives into the `(async () => { ... })()` IIFE that wraps the coordinator block — no closure issues.**

- [ ] **Step 4: Pass to existing gatherLayeredContext call (defensive — Task 3 already added the param)**

Find line 964 and update the call to forward surfaceContext (this path is the non-coordinator branch but Task 3 already wired it through, so we should populate it for completeness):

```typescript
// Before (line 964):
layeredContext = await gatherLayeredContext(text, channelId || "ellie-chat", ecRouteAgent || "ellie", supabase);

// After:
layeredContext = await gatherLayeredContext(text, channelId || "ellie-chat", ecRouteAgent || "ellie", supabase, surfaceContext);
```

- [ ] **Step 5: Build and test**

Run: `cd /home/ellie/ellie-dev && bun test tests/surface-context.test.ts`
Expected: 8 tests still pass (no behavior change yet — this task just plumbs the param down).

Run: `cd /home/ellie/ellie-dev && bun build src/relay.ts --target=bun --outdir=/tmp/build-check 2>&1 | grep -i error | head -20` to verify no TypeScript errors. (Optional — Bun's loose type checking may not catch everything; visual inspection is the real check.)

- [ ] **Step 6: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/websocket-servers.ts src/ellie-chat-handler.ts
git commit -m "[ELLIE-1455] plumb surface_context from WS through ellie chat handler

Threads msg.surface_context from the WebSocket dispatcher into
handleEllieChatMessage and the inner _handleEllieChatMessage scope.
Now visible to both gatherLayeredContext (line 964) and the
coordinator block (line 1427) — Task 5 will consume it.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Add surfaceContext to CoordinatorOpts, render surface section in coordinator prompt, register surface tools

**Files:**
- Modify: `/home/ellie/ellie-dev/src/coordinator.ts`
- Modify: `/home/ellie/ellie-dev/src/prompt-layers/coordinator.ts`
- Modify: `/home/ellie/ellie-dev/src/ellie-chat-handler.ts`

**Context (audit-corrected):** `coordinator-tools.ts` is a static `Anthropic.Tool[]` constant — there is no `buildCoordinatorTools()` function. Tools are passed at line 949 inside `callMessagesAPI` with `tools: COORDINATOR_TOOL_DEFINITIONS`. To add surface tools we (a) thread `surfaceContext` into `CoordinatorOpts`, (b) compute an effective tools list inside `runCoordinatorLoop`, (c) thread that list through `callMessagesAPI`, (d) render the surface context as a 4th section in `buildCoordinatorLayeredContext` so Ellie's reasoning sees the surface state in her system prompt at priority 2.

- [ ] **Step 1: Add `surfaceContext` field to `CoordinatorOpts` and `CoordinatorResult`**

Edit `/home/ellie/ellie-dev/src/coordinator.ts`. Add an import near the top (alongside the other type imports):

```typescript
import type { SurfaceContext } from "./surface-context.ts";
import { SURFACE_TOOL_DEFINITIONS, type SurfaceAction, type SurfaceToolName } from "./surface-tools.ts";
```

In the `CoordinatorOpts` interface (line 66), add `surfaceContext?: SurfaceContext | null` right after the existing `rosterFilter` field:

```typescript
export interface CoordinatorOpts {
  // ... existing fields
  rosterFilter?: string[];
  surfaceContext?: SurfaceContext | null;  // ELLIE-1455
  resumeState?: CoordinatorPausedState;
  // ... rest
}
```

(Task 6 will also add `surfaceActions?: SurfaceAction[]` to `CoordinatorResult` — leave that for now.)

- [ ] **Step 2: Update `buildCoordinatorLayeredContext` to accept and render surfaceContext**

Edit `/home/ellie/ellie-dev/src/prompt-layers/coordinator.ts`.

Add an import near the top:

```typescript
import { renderSurfaceContext } from "../surface-context.ts";
import type { SurfaceContext } from "../surface-context.ts";
```

Update the `CoordinatorLayeredContext` interface (line 21) — add `surfaceContext: string`:

```typescript
export interface CoordinatorLayeredContext {
  identity: string;
  awareness: string;
  surfaceContext: string;   // ELLIE-1455: rendered surface context block ("" when none)
  knowledge: string;
  totalBytes: number;
}
```

Update the exported `buildCoordinatorLayeredContext` function (line 215) — add a 3rd parameter:

```typescript
export async function buildCoordinatorLayeredContext(
  registry: FoundationRegistry,
  threadId?: string,
  surfaceContext?: SurfaceContext | null,  // ELLIE-1455
): Promise<CoordinatorLayeredContext> {
```

Inside the function body, after computing `[identity, awareness, knowledge]` from `Promise.all`, add:

```typescript
  // ELLIE-1455: Render surface context block (empty string if none)
  const surfaceContextRendered = surfaceContext ? renderSurfaceContext(surfaceContext) : "";
```

Update the `totalBytes` calculation to include it:

```typescript
  const totalBytes = encoder.encode(identity).length +
    encoder.encode(awareness).length +
    encoder.encode(surfaceContextRendered).length +
    encoder.encode(knowledge).length;
```

Update the return statement:

```typescript
  return { identity, awareness, surfaceContext: surfaceContextRendered, knowledge, totalBytes };
```

- [ ] **Step 3: Make `runCoordinatorLoop` consume surfaceContext from opts and inject into the system prompt**

Back in `/home/ellie/ellie-dev/src/coordinator.ts`, find the layered-prompt block at lines 175–185. Currently:

```typescript
const useLayeredCoordinator = process.env.LAYERED_PROMPT === "true" && opts.registry;
let effectivePrompt: string;
if (useLayeredCoordinator) {
  const { buildCoordinatorLayeredContext } = await import("./prompt-layers/coordinator.ts");
  const layers = await buildCoordinatorLayeredContext(opts.registry!, opts.threadId);
  effectivePrompt = [layers.identity, layers.awareness, layers.knowledge].join("\n\n");
  logger.info({ totalBytes: layers.totalBytes }, "Coordinator using layered prompt pipeline");
} else {
  effectivePrompt = opts.registry ? await opts.registry.getCoordinatorPrompt(opts.threadId) : systemPrompt;
}
```

Update to pass `opts.surfaceContext` and include `layers.surfaceContext` in the joined prompt (between awareness and knowledge):

```typescript
const useLayeredCoordinator = process.env.LAYERED_PROMPT === "true" && opts.registry;
let effectivePrompt: string;
if (useLayeredCoordinator) {
  const { buildCoordinatorLayeredContext } = await import("./prompt-layers/coordinator.ts");
  const layers = await buildCoordinatorLayeredContext(opts.registry!, opts.threadId, opts.surfaceContext);
  // ELLIE-1455: surfaceContext (already includes its own "## SURFACE CONTEXT" heading) is injected
  // between awareness and knowledge — same priority slot as ellie's prompt-builder.
  const sections = [layers.identity, layers.awareness, layers.surfaceContext, layers.knowledge].filter(s => s);
  effectivePrompt = sections.join("\n\n");
  logger.info({ totalBytes: layers.totalBytes, hasSurfaceContext: !!opts.surfaceContext }, "Coordinator using layered prompt pipeline");
} else {
  effectivePrompt = opts.registry ? await opts.registry.getCoordinatorPrompt(opts.threadId) : systemPrompt;
  // ELLIE-1455: even on the non-layered fallback, prepend surface context if present
  if (opts.surfaceContext) {
    const surfaceBlock = renderSurfaceContext(opts.surfaceContext);
    effectivePrompt = `${effectivePrompt}\n\n${surfaceBlock}`;
  }
}
```

Note the `filter(s => s)` — this drops empty surfaceContext when none is provided so the `\n\n` join doesn't produce a double blank.

You'll also need to import `renderSurfaceContext` at the top of coordinator.ts:

```typescript
import { renderSurfaceContext } from "./surface-context.ts";
```

- [ ] **Step 4: Compute effective tools list inside runCoordinatorLoop**

In `runCoordinatorLoop`, add a constant after line 173 (`const effectiveCoordinatorAgent = ...`):

```typescript
// ELLIE-1455: Add surface action tools when a surface is attached
const effectiveTools = opts.surfaceContext
  ? [...COORDINATOR_TOOL_DEFINITIONS, ...SURFACE_TOOL_DEFINITIONS]
  : COORDINATOR_TOOL_DEFINITIONS;
```

(`COORDINATOR_TOOL_DEFINITIONS` should already be imported; if not, add `import { COORDINATOR_TOOL_DEFINITIONS } from "./coordinator-tools.ts";`)

- [ ] **Step 5: Thread effectiveTools through callMessagesAPI**

Update `callMessagesAPI` (line 936) to accept `tools` as a parameter:

```typescript
async function callMessagesAPI(
  client: Anthropic,
  opts: {
    model: string;
    systemPrompt: string;
    messages: Anthropic.MessageParam[];
    tools: Anthropic.Tool[];  // ELLIE-1455
  },
): Promise<Anthropic.Message> {
  return client.messages.create({
    model: opts.model,
    max_tokens: 4096,
    system: opts.systemPrompt,
    messages: opts.messages,
    tools: opts.tools,
  });
}
```

Update the single call site at line 317 to pass `effectiveTools`:

```typescript
const anthropicResponse = await callMessagesAPI(client!, {
  model: effectiveModel,
  systemPrompt: ctx.getSystemPrompt(),
  messages: ctx.getMessages(),
  tools: effectiveTools,  // ELLIE-1455
});
```

- [ ] **Step 6: Pass surfaceContext from the handler into runCoordinatorLoop**

Edit `/home/ellie/ellie-dev/src/ellie-chat-handler.ts` around line 1427. The current call to `runCoordinatorLoop({...})` has fields like `message`, `channel`, `userId`, `registry`, etc. Add:

```typescript
const coordinatorResult = await runCoordinatorLoop({
  message: coordMessage,
  channel: "ellie-chat",
  // ... existing fields
  threadId: effectiveThreadId || undefined,
  surfaceContext: surfaceContext ?? undefined,  // ELLIE-1455 — from Task 4 plumbing
  resumeState: resumeState || undefined,
});
```

The `surfaceContext` variable is already in scope from Task 4 (it's the `_handleEllieChatMessage` parameter).

- [ ] **Step 7: Test**

Run: `cd /home/ellie/ellie-dev && bun test tests/surface-context.test.ts`
Expected: 8 tests still pass.

Run: `cd /home/ellie/ellie-dev && bun test tests/surface-tools.test.ts`
Expected: 5 tests still pass.

If your repo has any tests for `coordinator.ts` or `prompt-layers/coordinator.ts`, run those too: `bun test tests/coordinator*.test.ts` — they should still pass since `surfaceContext` is optional and defaults to undefined.

- [ ] **Step 8: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/coordinator.ts src/prompt-layers/coordinator.ts src/ellie-chat-handler.ts
git commit -m "[ELLIE-1455] thread surfaceContext through coordinator loop and prompt

- CoordinatorOpts.surfaceContext (optional)
- buildCoordinatorLayeredContext renders surface block as 4th section
  injected between awareness and knowledge (priority 2 slot)
- callMessagesAPI takes a tools param so we can supply
  COORDINATOR_TOOL_DEFINITIONS + SURFACE_TOOL_DEFINITIONS only when
  a surface is attached
- Non-layered fallback path also prepends rendered surface context
- ellie-chat-handler passes surfaceContext from Task 4's scope into
  runCoordinatorLoop

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Dispatch surface tools in coordinator loop, collect surface_actions, attach to response

**Files:**
- Modify: `/home/ellie/ellie-dev/src/coordinator.ts`
- Modify: `/home/ellie/ellie-dev/src/ellie-chat-handler.ts`
- Create: `/home/ellie/ellie-dev/tests/surface-tools-dispatch.test.ts`

**Context (audit-corrected):** Tool dispatch in `coordinator.ts` is a hardcoded switch, not a closure-based registry. The `for (const tool of toolUses)` loop at line 380 splits tools into `complete` / `ask_user` / `dispatch_agent` / `otherCalls`. We add a 5th branch BEFORE the existing split: when the tool name is a surface tool, synthesize a `SurfaceAction` via `buildSurfaceAction`, push it onto a local `surfaceActions[]` accumulator, and feed an ack tool result back via `ctx.addToolResult`. The action array is returned from `runCoordinatorLoop` in BOTH return sites (paused and normal). The handler then attaches it to the response payload.

- [ ] **Step 1: Write a failing test for the dispatch path**

Create `/home/ellie/ellie-dev/tests/surface-tools-dispatch.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { runCoordinatorLoop, type CoordinatorOpts } from "../src/coordinator";

const stubDeps = {
  sendMessage: async () => {},
  readForest: async () => "",
  readPlane: async () => "",
  readMemory: async () => "",
  readSessions: async () => "",
  getWorkingMemorySummary: async () => "",
  updateWorkingMemory: async () => {},
  promoteToForest: async () => {},
  logEnvelope: async () => {},
};

describe("Coordinator surface tool dispatch", () => {
  test("collects surface_actions when surface tools are called", async () => {
    // Use _testResponses to inject a fake LLM response that calls propose_create_folder
    const fakeResponses = [
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "propose_create_folder",
            input: { paths: ["research/quantum/"], reason: "test" },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Proposal queued." }],
        usage: { input_tokens: 5, output_tokens: 5 },
      },
    ];

    const result = await runCoordinatorLoop({
      message: "create a folder for quantum research",
      channel: "ellie-chat",
      userId: "test",
      foundation: "test",
      systemPrompt: "test",
      model: "claude-haiku-4-5",
      agentRoster: ["ellie"],
      deps: stubDeps as any,
      surfaceContext: {
        surface_id: "knowledge-river",
        surface_origin: "panel-test",
        selection: { folder: null, folder_file_count: 0, folder_subfolder_count: 0, last_files: [] },
        ingestion_state: { in_progress: false, queued: 0, last_ingested_at: null },
        river_summary: { total_docs: 0, total_folders: 0 },
      },
      _testResponses: fakeResponses,
    } as CoordinatorOpts);

    expect(result.surfaceActions).toBeDefined();
    expect(result.surfaceActions).toHaveLength(1);
    expect(result.surfaceActions![0].tool).toBe("propose_create_folder");
    expect(result.surfaceActions![0].args.paths).toEqual(["research/quantum/"]);
    expect(result.surfaceActions![0].proposal_id).toMatch(/^prop_/);
  });

  test("surfaceActions is empty array when no surface tools called", async () => {
    const fakeResponses = [
      {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Hello!" }],
        usage: { input_tokens: 5, output_tokens: 5 },
      },
    ];

    const result = await runCoordinatorLoop({
      message: "hi",
      channel: "ellie-chat",
      userId: "test",
      foundation: "test",
      systemPrompt: "test",
      model: "claude-haiku-4-5",
      agentRoster: ["ellie"],
      deps: stubDeps as any,
      _testResponses: fakeResponses,
    } as CoordinatorOpts);

    expect(result.surfaceActions).toBeDefined();
    expect(result.surfaceActions).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /home/ellie/ellie-dev && bun test tests/surface-tools-dispatch.test.ts
```

Expected: FAIL — `result.surfaceActions` is undefined.

- [ ] **Step 3: Add `SURFACE_TOOL_NAMES` set near the top of coordinator.ts**

In `/home/ellie/ellie-dev/src/coordinator.ts`, after the existing imports (the `SURFACE_TOOL_DEFINITIONS` import was added in Task 5):

```typescript
const SURFACE_TOOL_NAMES: ReadonlySet<string> = new Set(SURFACE_TOOL_DEFINITIONS.map(d => d.name));
```

Also add `buildSurfaceAction` to the existing import:

```typescript
import { SURFACE_TOOL_DEFINITIONS, buildSurfaceAction, type SurfaceAction, type SurfaceToolName } from "./surface-tools.ts";
```

- [ ] **Step 4: Add `surfaceActions` field to `CoordinatorResult`**

In the `CoordinatorResult` interface (line 120), add the field:

```typescript
export interface CoordinatorResult {
  response: string;
  loopIterations: number;
  envelopes: DispatchEnvelope[];
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
  hitSafetyRail: boolean;
  durationMs: number;
  paused?: CoordinatorPausedState;
  surfaceActions?: SurfaceAction[];  // ELLIE-1455
}
```

- [ ] **Step 5: Add the `surfaceActions` accumulator and dispatch branch in `runCoordinatorLoop`**

In `runCoordinatorLoop`, near the top of the function body (around the existing `let totalTokensIn = 0;` declarations at line 220), add:

```typescript
const surfaceActions: SurfaceAction[] = [];  // ELLIE-1455
```

Then in the tool dispatch loop at line 380, add a NEW branch BEFORE the existing `complete` / `ask_user` / `dispatch_agent` / `else` cases. The order matters — surface tools must be checked first so they don't fall into `otherCalls`:

```typescript
for (const tool of toolUses) {
  // ELLIE-1455: Surface tools — synthesize action, ack to LLM, accumulate for response
  if (SURFACE_TOOL_NAMES.has(tool.name as string)) {
    const action = buildSurfaceAction(
      tool.name as SurfaceToolName,
      tool.input as Record<string, unknown>,
    );
    surfaceActions.push(action);
    ctx.addToolResult(
      tool.id as string,
      JSON.stringify({ status: "queued", proposal_id: action.proposal_id }),
    );
    logger.info("[surface] action queued", { tool: tool.name, proposal_id: action.proposal_id });
    continue;
  }

  if (tool.name === "complete") {
    // ... existing complete handler
  } else if (tool.name === "ask_user") {
    // ... existing ask_user handler
  } else if (tool.name === "dispatch_agent") {
    dispatchCalls.push(tool);
  } else {
    otherCalls.push(tool);
  }
}
```

- [ ] **Step 6: Populate `surfaceActions` in BOTH return sites**

a. **Paused return** (around line 487 — when `ask_user` pauses the loop):

```typescript
return {
  response: askInput.question,
  loopIterations,
  envelopes,
  totalTokensIn,
  totalTokensOut,
  totalCostUsd: computeCost(effectiveModel, totalTokensIn, totalTokensOut) + specialistCostUsd,
  hitSafetyRail: false,
  durationMs,
  paused: pausedState,
  surfaceActions,  // ELLIE-1455
};
```

b. **Normal return** (around line 833 — end of function):

```typescript
return {
  response,
  loopIterations,
  envelopes,
  totalTokensIn,
  totalTokensOut,
  totalCostUsd,
  hitSafetyRail,
  durationMs,
  surfaceActions,  // ELLIE-1455
};
```

- [ ] **Step 7: Run the dispatch test — expect PASS**

```bash
cd /home/ellie/ellie-dev && bun test tests/surface-tools-dispatch.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 8: Attach surface_actions to the response payload in the handler**

Edit `/home/ellie/ellie-dev/src/ellie-chat-handler.ts` at line 1496. The current `responsePayload` construction:

```typescript
const responsePayload = {
  type: "response",
  text: coordResponse,
  agent: "ellie",
  contributors: contributors.length > 0 ? contributors : undefined,
  thread_id: effectiveThreadId,
  memoryId: memoryId || undefined,
  ts: Date.now(),
  duration_ms: coordinatorResult.durationMs,
};
```

Update to include `surface_actions`:

```typescript
const responsePayload: Record<string, unknown> = {
  type: "response",
  text: coordResponse,
  agent: "ellie",
  contributors: contributors.length > 0 ? contributors : undefined,
  thread_id: effectiveThreadId,
  memoryId: memoryId || undefined,
  ts: Date.now(),
  duration_ms: coordinatorResult.durationMs,
};

// ELLIE-1455: Include surface_actions if Ellie called any surface tools
if (coordinatorResult.surfaceActions && coordinatorResult.surfaceActions.length > 0) {
  responsePayload.surface_actions = coordinatorResult.surfaceActions;
}
```

The same payload object is used by both `deliverResponse` (line 1506) and `broadcastToEllieChatClients` (line 1508), so this single edit is sufficient — no separate broadcast payload to update.

- [ ] **Step 9: Run all relay tests to confirm nothing else broke**

```bash
cd /home/ellie/ellie-dev && bun test tests/surface-context.test.ts tests/surface-tools.test.ts tests/surface-tools-dispatch.test.ts
```

Expected: 8 + 5 + 2 = 15 tests pass.

- [ ] **Step 10: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/coordinator.ts src/ellie-chat-handler.ts tests/surface-tools-dispatch.test.ts
git commit -m "[ELLIE-1455] coordinator dispatches surface tools, returns surfaceActions

- Add SURFACE_TOOL_NAMES set + dispatch branch BEFORE the existing
  complete/ask_user/dispatch_agent split. Synthesizes a SurfaceAction
  via buildSurfaceAction, acks back to the LLM with the proposal_id,
  accumulates into local array.
- Add surfaceActions[] field on CoordinatorResult, populated in BOTH
  the paused-return and normal-return paths.
- Handler attaches surface_actions to responsePayload (single edit
  serves both deliverResponse and broadcastToEllieChatClients).
- New tests/surface-tools-dispatch.test.ts uses _testResponses to
  inject fake LLM tool_use responses and verifies the action shows up
  on the result.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Define typed SurfaceContext in ellie-home

**Files:**
- Create: `/home/ellie/ellie-home/app/types/surface-context.ts`

**Context:** The Vue panel needs the same discriminated union types as the relay so the surface context is type-safe in the frontend.

- [ ] **Step 1: Create the types file**

Create `/home/ellie/ellie-home/app/types/surface-context.ts`:

```typescript
/**
 * Surface Context types — must mirror ellie-dev/src/surface-context.ts
 *
 * When the relay's types change, update this file in lockstep.
 */

export type SurfaceId =
  | 'knowledge-tree'
  | 'knowledge-river'
  | 'knowledge-graph'
  | 'knowledge-canvas'

export interface BaseSurfaceContext {
  surface_id: SurfaceId
  surface_origin: string
}

export interface KnowledgeTreeContext extends BaseSurfaceContext {
  surface_id: 'knowledge-tree'
  selection: {
    scope_path: string | null
    scope_name: string | null
    memory_count: number
  }
  forest_summary: {
    total_scopes: number
    total_memories: number
  }
}

export interface KnowledgeRiverContext extends BaseSurfaceContext {
  surface_id: 'knowledge-river'
  selection: {
    folder: string | null
    folder_file_count: number
    folder_subfolder_count: number
    last_files: string[]
  }
  ingestion_state: {
    in_progress: boolean
    queued: number
    last_ingested_at: string | null
  }
  river_summary: {
    total_docs: number
    total_folders: number
  }
}

export type SurfaceContext = KnowledgeTreeContext | KnowledgeRiverContext

// ── Surface actions (matches relay surface-tools.ts) ──

export type SurfaceToolName =
  | 'propose_create_folder'
  | 'propose_move_folder'
  | 'propose_select_folder'
  | 'propose_switch_tab'
  | 'highlight_drop_zone'

export interface SurfaceAction {
  tool: SurfaceToolName
  args: Record<string, unknown>
  proposal_id: string
}

export interface ProposalResponse {
  type: 'proposal_response'
  proposal_id: string
  applied: boolean
  applied_subset?: string[]
  rejected_subset?: string[]
}

const AUTO_APPLY_TOOLS = new Set<SurfaceToolName>([
  'propose_select_folder',
  'propose_switch_tab',
  'highlight_drop_zone',
])

export function isAutoApply(tool: SurfaceToolName): boolean {
  return AUTO_APPLY_TOOLS.has(tool)
}
```

- [ ] **Step 2: Verify Nuxt picks up the types**

Run: `cd /home/ellie/ellie-home && bun run build 2>&1 | tail -10`
Expected: Clean build, no TypeScript errors

- [ ] **Step 3: Commit**

```bash
cd /home/ellie/ellie-home
git add app/types/surface-context.ts
git commit -m "[ELLIE-1455] add typed SurfaceContext + SurfaceAction types

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Add surface_context + surface_origin to outgoing WS messages

**Files:**
- Modify: `/home/ellie/ellie-home/app/composables/useEllieChat.ts`

**Context (audit-corrected):** The `send()` function needs to accept a `surfaceContext` option AND when pushing the user message into the local `messages.value` array, must tag it with `surface_origin` from the context. Without that tag, the panel's filter at Task 11 (`m.surface_origin === props.surfaceContext.surface_origin`) will hide the user's own outgoing message until Ellie's response arrives. The plan's stated `send` line ~551 is stale — the actual line is ~592. Find the function by name, not line number.

- [ ] **Step 1: Add surfaceContext option to send() and include it in the payload**

Modify `/home/ellie/ellie-home/app/composables/useEllieChat.ts`. Find the `send` function by name (around line 592, may drift). Add `surfaceContext` to its options type and include it in the payload:

```typescript
function send(text: string, opts?: {
  phoneMode?: boolean
  image?: EllieChatImage
  channelId?: string
  mode?: string
  threadId?: string
  surfaceContext?: import('~/types/surface-context').SurfaceContext  // ELLIE-1455
}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  // ... existing logic ...

  const payload: Record<string, any> = {
    type: 'message',
    text,
    phone_mode: opts?.phoneMode || false,
    id: messageId,
  }
  // ... existing fields ...

  // ELLIE-1455: Surface context for panels embedded on a surface
  if (opts?.surfaceContext) {
    payload.surface_context = opts.surfaceContext
  }

  ws.send(JSON.stringify(payload))
  // ... existing logic ...
}
```

- [ ] **Step 1b: Tag the locally-pushed user message with surface_origin**

Find the part of `send()` that pushes the user's outgoing message into `messages.value` (around line 601-609 — look for `messages.value.push({ id, role: 'user', text, ... })`). Add `surface_origin` so the panel can see its own outgoing message immediately:

```typescript
messages.value.push({
  id: messageId,
  role: 'user',
  text,
  ts: Date.now(),
  image: opts?.image,
  replyTo: opts?.replyTo,
  surface_origin: opts?.surfaceContext?.surface_origin,  // ELLIE-1455
})
```

(The `surface_origin` field on `EllieChatMessage` will be added in Task 9 Step 1 — that task must run BEFORE Task 11 mounts the panel. If you're executing tasks out of order, also add the field to the interface here.)

- [ ] **Step 2: Verify build passes**

Run: `cd /home/ellie/ellie-home && bun run build 2>&1 | tail -5`
Expected: Clean build

- [ ] **Step 3: Commit**

```bash
cd /home/ellie/ellie-home
git add app/composables/useEllieChat.ts
git commit -m "[ELLIE-1455] send() accepts surfaceContext option and includes it in payload

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Carry surface_actions through incoming response messages + bypass thread filter for panels

**Files:**
- Modify: `/home/ellie/ellie-home/app/composables/useEllieChat.ts`

**Context (audit-corrected):** Three things to fix:
1. Add `surface_actions` and `surface_origin` to the `EllieChatMessage` interface
2. Carry both fields through the response and history handlers
3. **Critical:** the existing thread-id early-return at line 225 (`if (currentChannelId && msg.thread_id && msg.thread_id !== currentChannelId) return`) will silently drop panel responses if the user is sitting on a different thread in /ellie-chat. Bypass the filter when `msg.surface_origin` is present so panel responses always reach `messages.value` and the panel filter handles routing.
4. The plan's stated line numbers are slightly stale — find sections by content, not line number.

- [ ] **Step 1: Add surface_actions and surface_origin to the EllieChatMessage interface**

In `/home/ellie/ellie-home/app/composables/useEllieChat.ts`, find the `EllieChatMessage` interface (around line 13). Add two fields:

```typescript
interface EllieChatMessage {
  // ... existing fields
  contributors?: string[]
  surface_actions?: import('~/types/surface-context').SurfaceAction[]  // ELLIE-1455
  surface_origin?: string  // ELLIE-1455: panel that originated this message
}
```

- [ ] **Step 1b: Bypass the thread-id filter when surface_origin is present**

Find the response handler's thread-id early return (around line 225 — search for `currentChannelId && msg.thread_id`). Current:

```typescript
if (currentChannelId && msg.thread_id && msg.thread_id !== currentChannelId) return
```

Change to:

```typescript
// ELLIE-1455: panel responses are routed by surface_origin, not thread_id
if (currentChannelId && msg.thread_id && msg.thread_id !== currentChannelId && !msg.surface_origin) return
```

Apply the same change to the history handler's filter (around line 386 — search for the second occurrence of the same pattern). Same edit: append `&& !histMsg.surface_origin` to the condition.

- [ ] **Step 2: Carry surface_actions and surface_origin in the response handler**

Find the `if (msg.type === 'response')` block (around line 219). Update the `messages.value.push(...)` call to include both fields:

```typescript
messages.value.push({
  id: msg.memoryId || crypto.randomUUID(),
  role: 'assistant',
  text: msg.text,
  agent: msg.agent,
  ts: msg.ts,
  duration_ms: msg.duration_ms,
  contributors: msg.contributors,
  surface_actions: msg.surface_actions,  // ELLIE-1455
  surface_origin: msg.surface_origin,  // ELLIE-1455
})
```

- [ ] **Step 3: Same for the history handler**

Find the `if (msg.type === 'history' && Array.isArray(msg.messages))` block (around line 358). Update the message construction inside the loop:

```typescript
messages.value.push({
  id: histMsg.id,
  role: histMsg.role,
  text: histMsg.text,
  agent: histMsg.agent,
  ts: histMsg.ts,
  contributors: histMsg.contributors,
  surface_actions: histMsg.surface_actions,  // ELLIE-1455
  surface_origin: histMsg.surface_origin,  // ELLIE-1455
})
```

- [ ] **Step 4: Add a sendProposalResponse helper for accept/reject acks**

Inside the `useEllieChat()` function body, before the `return { ... }` at the end (around line 723 — search for the return object that includes `send, startNewChat, switchChannel`), add a helper:

```typescript
function sendProposalResponse(proposalId: string, applied: boolean, appliedSubset?: string[], rejectedSubset?: string[]) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify({
    type: 'proposal_response',
    proposal_id: proposalId,
    applied,
    applied_subset: appliedSubset,
    rejected_subset: rejectedSubset,
  }))
}
```

**Phase 1 note:** The relay does NOT yet have a handler for `type: 'proposal_response'`. This message goes into the void on the server side. Phase 2 (or a follow-up Phase 1.5 ticket) will add server-side handling. For Phase 1, the panel's accept/reject is purely client-side state — the relay echo just disappears. This is acceptable because the panel applies the action locally via `props.onAction(action)` in Task 11.

Add `sendProposalResponse` to the returned object from `useEllieChat()`:

```typescript
return {
  messages, connected, typing, typingAgent, send, startNewChat, switchChannel,
  // ... existing fields ...
  sendProposalResponse,  // ELLIE-1455
}
```

- [ ] **Step 5: Build and verify**

Run: `cd /home/ellie/ellie-home && bun run build 2>&1 | tail -5`
Expected: Clean build

- [ ] **Step 6: Commit**

```bash
cd /home/ellie/ellie-home
git add app/composables/useEllieChat.ts
git commit -m "[ELLIE-1455] surface_actions on messages + sendProposalResponse helper

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Create the ProposalPreviewCard component

**Files:**
- Create: `/home/ellie/ellie-home/app/components/ellie/ProposalPreviewCard.vue`

**Context:** This is the visual preview card for mutating proposals. It renders a single `SurfaceAction` with granular accept/reject. See the spec's "Proposal Preview Card — visual specification" section.

- [ ] **Step 1: Create the component**

Create `/home/ellie/ellie-home/app/components/ellie/ProposalPreviewCard.vue`:

```vue
<template>
  <div class="border border-cyan-700/60 border-dashed bg-gray-900/40 rounded-lg p-3 max-w-[400px] mt-2">
    <!-- Header bar -->
    <div class="flex items-center gap-2 mb-2 pb-2 border-b border-gray-700/50">
      <span class="text-[10px] text-cyan-400 font-bold uppercase tracking-wider">Proposal</span>
      <span class="text-[10px] text-gray-500">— preview in {{ surfaceLabel }}</span>
    </div>

    <!-- Action title -->
    <div class="text-xs text-gray-300 font-semibold mb-2">{{ actionTitle }}</div>

    <!-- Per-item rows with checkboxes -->
    <div class="space-y-1 mb-2">
      <label
        v-for="(item, idx) in items"
        :key="idx"
        class="flex items-start gap-2 cursor-pointer text-xs"
      >
        <input
          type="checkbox"
          :checked="checkedItems[idx]"
          @change="checkedItems[idx] = !checkedItems[idx]"
          :disabled="status !== 'pending'"
          class="mt-0.5 accent-cyan-500"
        />
        <span class="flex-1" :class="itemColor(item)">
          {{ itemPrefix(item) }} {{ item.label }}
        </span>
      </label>
    </div>

    <!-- Reason -->
    <div v-if="reason" class="text-[10px] text-gray-500 mb-3 italic">
      {{ reason }}
    </div>

    <!-- Action buttons -->
    <div v-if="status === 'pending'" class="flex gap-2">
      <button
        @click="onAccept"
        :disabled="!hasChecked"
        class="flex-1 px-3 py-1.5 rounded-md text-xs font-semibold bg-cyan-700 text-cyan-50 hover:bg-cyan-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        ✓ Accept selected
      </button>
      <button
        @click="onReject"
        class="px-3 py-1.5 rounded-md text-xs font-semibold border border-gray-600 text-gray-400 hover:text-gray-200 hover:border-gray-500 transition-colors"
      >
        ✗ Reject all
      </button>
    </div>

    <!-- Done state -->
    <div v-else-if="status === 'applied'" class="text-xs text-emerald-400 flex items-center gap-1.5">
      <span>✓</span>
      <span>Applied {{ appliedCount }} of {{ items.length }}</span>
      <span class="text-gray-500 text-[10px] ml-auto">{{ doneTime }}</span>
    </div>

    <!-- Rejected state -->
    <div v-else-if="status === 'rejected'" class="text-xs text-gray-500 flex items-center gap-1.5">
      <span>✗</span>
      <span>Rejected</span>
      <span class="text-gray-600 text-[10px] ml-auto">{{ doneTime }}</span>
    </div>

    <!-- Error state -->
    <div v-else-if="status === 'error'" class="text-xs text-red-400">
      ⚠ {{ errorMessage }}
      <button @click="status = 'pending'" class="ml-2 underline">Retry</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import type { SurfaceAction } from '~/types/surface-context'

interface PreviewItem {
  label: string
  kind: 'create' | 'delete' | 'move' | 'navigate'
  raw: unknown
}

const props = defineProps<{
  action: SurfaceAction
  surfaceLabel?: string
}>()

const emit = defineEmits<{
  accept: [appliedItems: string[], rejectedItems: string[]]
  reject: []
}>()

const status = ref<'pending' | 'applied' | 'rejected' | 'error'>('pending')
const errorMessage = ref('')
const doneTime = ref('')
const appliedCount = ref(0)

// Per-tool item extraction
const items = computed<PreviewItem[]>(() => {
  const a = props.action
  if (a.tool === 'propose_create_folder') {
    const paths = (a.args.paths as string[]) || []
    return paths.map(p => ({ label: p, kind: 'create', raw: p }))
  }
  if (a.tool === 'propose_move_folder') {
    const from = a.args.from as string
    const to = a.args.to as string
    return [{ label: `${from} → ${to}`, kind: 'move', raw: { from, to } }]
  }
  return []
})

const reason = computed(() => (props.action.args.reason as string) || '')

const actionTitle = computed(() => {
  const tool = props.action.tool
  if (tool === 'propose_create_folder') return 'Create folders'
  if (tool === 'propose_move_folder') return 'Move folder'
  return tool
})

const checkedItems = ref<boolean[]>(items.value.map(() => true))

const hasChecked = computed(() => checkedItems.value.some(v => v))

function itemPrefix(item: PreviewItem): string {
  if (item.kind === 'create') return '+'
  if (item.kind === 'delete') return '-'
  if (item.kind === 'move') return '→'
  return '·'
}

function itemColor(item: PreviewItem): string {
  if (item.kind === 'create') return 'text-emerald-400'
  if (item.kind === 'delete') return 'text-red-400'
  if (item.kind === 'move') return 'text-cyan-400'
  return 'text-gray-400'
}

function onAccept() {
  const accepted: string[] = []
  const rejected: string[] = []
  items.value.forEach((item, idx) => {
    if (checkedItems.value[idx]) accepted.push(item.label)
    else rejected.push(item.label)
  })
  appliedCount.value = accepted.length
  status.value = 'applied'
  doneTime.value = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  emit('accept', accepted, rejected)
}

function onReject() {
  status.value = 'rejected'
  doneTime.value = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  emit('reject')
}

defineExpose({ status, errorMessage })
</script>
```

- [ ] **Step 2: Build and verify**

Run: `cd /home/ellie/ellie-home && bun run build 2>&1 | tail -5`
Expected: Clean build

- [ ] **Step 3: Commit**

```bash
cd /home/ellie/ellie-home
git add app/components/ellie/ProposalPreviewCard.vue
git commit -m "[ELLIE-1455] add ProposalPreviewCard.vue for mutating proposal previews

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Create the EllieSurfacePanel component shell

**Files:**
- Create: `/home/ellie/ellie-home/app/components/ellie/EllieSurfacePanel.vue`

**Context:** This is the reusable embedded chat panel. It composes `useEllieChat`, displays the surface awareness banner, the chat scroll, the input row with controls, and renders proposal preview cards inline with messages.

- [ ] **Step 1: Create the component**

Create `/home/ellie/ellie-home/app/components/ellie/EllieSurfacePanel.vue`:

```vue
<template>
  <div
    v-if="!collapsed"
    class="bg-gray-900 border-l-2 border-cyan-700/60 flex flex-col h-full"
    :class="position === 'bottom' ? 'w-full border-l-0 border-t-2' : 'w-[340px]'"
  >
    <!-- Header -->
    <div class="bg-gray-800 px-3 py-2 border-b border-gray-700/50 flex items-center gap-2">
      <div class="w-5 h-5 rounded-full bg-purple-600 shrink-0"></div>
      <span class="text-xs font-semibold text-purple-300">Ellie</span>
      <div class="flex-1"></div>
      <button
        v-if="readModeAvailable"
        @click="$emit('toggle-read-mode')"
        :title="readMode ? 'Reading' : 'Read mode off'"
        class="text-[10px] px-1.5 py-0.5 rounded border border-gray-700 text-gray-400 hover:text-gray-200"
      >🔊</button>
      <button
        @click="position = position === 'right' ? 'bottom' : 'right'"
        title="Toggle panel position"
        class="text-[10px] text-gray-500 hover:text-gray-300 px-1"
      >⇆</button>
      <button
        @click="collapsed = true"
        title="Collapse panel"
        class="text-[10px] text-gray-500 hover:text-gray-300 px-1"
      >✕</button>
    </div>

    <!-- Surface awareness banner -->
    <div class="bg-cyan-950/40 border-b border-cyan-800/40 px-3 py-1.5 text-[10px] text-cyan-400 font-mono">
      🧭 {{ awarenessText }}
    </div>

    <!-- Chat scroll -->
    <div ref="scrollArea" class="flex-1 overflow-y-auto px-3 py-2 space-y-2">
      <div
        v-for="msg in panelMessages"
        :key="msg.id"
        class="text-xs"
      >
        <div class="flex items-center gap-1.5 mb-0.5">
          <span
            class="font-semibold"
            :class="msg.role === 'user' ? 'text-blue-400' : 'text-purple-300'"
          >{{ msg.role === 'user' ? 'Dave' : 'Ellie' }}</span>
          <span class="text-[9px] text-gray-600">{{ formatTime(msg.ts) }}</span>
        </div>
        <div class="chat-md text-gray-200" v-html="renderMarkdown(msg.text)" />

        <!-- Proposal preview cards (one per mutating action) -->
        <template v-if="msg.surface_actions">
          <ProposalPreviewCard
            v-for="action in mutatingActions(msg.surface_actions)"
            :key="action.proposal_id"
            :action="action"
            :surface-label="surfaceLabelText"
            @accept="(applied, rejected) => handleAccept(action, applied, rejected)"
            @reject="() => handleReject(action)"
          />
        </template>
      </div>
      <div v-if="typing" class="text-[10px] text-gray-500 italic">Ellie is typing…</div>
    </div>

    <!-- Input row -->
    <div class="bg-gray-800 px-2 py-2 border-t border-gray-700/50 flex items-center gap-1.5">
      <input
        v-model="inputText"
        @keydown.enter="onSend"
        placeholder="Talk to Ellie about your knowledge…"
        class="flex-1 bg-gray-950 border border-gray-700 text-gray-200 px-2 py-1 rounded text-xs focus:outline-none focus:border-cyan-600"
      />
      <button
        @click="onSend"
        :disabled="!inputText.trim() || !connected"
        class="px-2 py-1 text-xs text-cyan-400 disabled:opacity-30"
      >▶</button>
    </div>
  </div>

  <!-- Collapsed strip -->
  <div
    v-else
    @click="collapsed = false"
    class="bg-gray-800 border-l-2 border-cyan-700/60 w-6 h-full flex items-start justify-center pt-3 cursor-pointer hover:bg-gray-700"
    title="Expand Ellie panel"
  >
    <div class="w-4 h-4 rounded-full bg-purple-600"></div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import type { SurfaceContext, SurfaceAction, SurfaceId } from '~/types/surface-context'
import { isAutoApply } from '~/types/surface-context'
import ProposalPreviewCard from './ProposalPreviewCard.vue'

const props = defineProps<{
  surfaceId: SurfaceId
  surfaceContext: SurfaceContext
  onAction?: (action: SurfaceAction) => Promise<void> | void
  readModeAvailable?: boolean
  readMode?: boolean
}>()

defineEmits<{
  'toggle-read-mode': []
}>()

// Compose existing chat
const { messages, connected, typing, send, sendProposalResponse } = useEllieChat()
const { renderMarkdown } = useMarkdown()

// Panel-scoped state (persisted to localStorage by surfaceId)
const STORAGE_KEY = `ellie-surface-panel:${props.surfaceId}`
const collapsed = ref(false)
const position = ref<'right' | 'bottom'>('right')

onMounted(() => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      const parsed = JSON.parse(saved)
      collapsed.value = !!parsed.collapsed
      position.value = parsed.position === 'bottom' ? 'bottom' : 'right'
    }
  } catch {}
})

watch([collapsed, position], () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ collapsed: collapsed.value, position: position.value }))
  } catch {}
})

const inputText = ref('')
const scrollArea = ref<HTMLElement | null>(null)

// Filter messages to only those that originated from this panel.
// Messages without surface_origin (e.g., from /ellie-chat) are excluded.
const panelMessages = computed(() =>
  messages.value.filter(m => m.surface_origin === props.surfaceContext.surface_origin)
)

const awarenessText = computed(() => {
  const ctx = props.surfaceContext
  if (ctx.surface_id === 'knowledge-tree') {
    const sel = ctx.selection.scope_path
      ? `${ctx.selection.scope_name} (${ctx.selection.memory_count} memories)`
      : 'no scope selected'
    return `SEEING: Tree · ${sel}`
  }
  if (ctx.surface_id === 'knowledge-river') {
    const sel = ctx.selection.folder
      ? `${ctx.selection.folder} (${ctx.selection.folder_file_count} files)`
      : 'no folder selected'
    return `SEEING: River · ${sel}`
  }
  return `SEEING: ${ctx.surface_id}`
})

const surfaceLabelText = computed(() => {
  if (props.surfaceContext.surface_id === 'knowledge-river') return 'River'
  if (props.surfaceContext.surface_id === 'knowledge-tree') return 'Tree'
  return props.surfaceContext.surface_id
})

function mutatingActions(actions: SurfaceAction[]): SurfaceAction[] {
  return actions.filter(a => !isAutoApply(a.tool))
}

function autoApplyActions(actions: SurfaceAction[]): SurfaceAction[] {
  return actions.filter(a => isAutoApply(a.tool))
}

// Watch for new messages from THIS panel and auto-apply navigation actions.
// ELLIE-1455: Compare by id, not by length — `panelMessages` is filtered output
// from the shared `messages` ref, so insertions can happen anywhere (history
// dedup sorts by ts), and `slice(old.length)` would miss out-of-order arrivals.
watch(panelMessages, async (newMessages, oldMessages) => {
  const oldIds = new Set((oldMessages ?? []).map(m => m.id))
  const newOnes = newMessages.filter(m => !oldIds.has(m.id))
  for (const msg of newOnes) {
    if (msg.surface_actions) {
      for (const action of autoApplyActions(msg.surface_actions)) {
        if (props.onAction) await props.onAction(action)
      }
    }
  }
  // Scroll to bottom
  nextTick(() => {
    if (scrollArea.value) scrollArea.value.scrollTop = scrollArea.value.scrollHeight
  })
}, { deep: false })

async function handleAccept(action: SurfaceAction, applied: string[], rejected: string[]) {
  if (props.onAction) await props.onAction(action)
  sendProposalResponse(action.proposal_id, true, applied, rejected)
}

function handleReject(action: SurfaceAction) {
  sendProposalResponse(action.proposal_id, false)
}

function onSend() {
  const text = inputText.value.trim()
  if (!text) return
  // Tag outgoing message with surface_origin so the response can be routed back
  const ctx = { ...props.surfaceContext }
  send(text, { surfaceContext: ctx })
  inputText.value = ''
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
</script>

<style scoped>
.chat-md :deep(p) { margin-bottom: 0.25rem; }
.chat-md :deep(p:last-child) { margin-bottom: 0; }
.chat-md :deep(strong) { color: #f3f4f6; }
.chat-md :deep(code) { background: rgba(55,65,81,0.6); padding: 0 0.25rem; border-radius: 0.2rem; color: #6ee7b7; font-size: 0.7rem; }
</style>
```

- [ ] **Step 2: Build and verify**

Run: `cd /home/ellie/ellie-home && bun run build 2>&1 | tail -5`
Expected: Clean build

- [ ] **Step 3: Commit**

```bash
cd /home/ellie/ellie-home
git add app/components/ellie/EllieSurfacePanel.vue
git commit -m "[ELLIE-1455] add EllieSurfacePanel.vue reusable embedded chat panel

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Tag responses with surface_origin in the relay

**Files:**
- Modify: `/home/ellie/ellie-dev/src/ellie-chat-handler.ts`

**Context (audit-corrected):** Task 4 plumbed `surfaceContext` into `_handleEllieChatMessage`'s outer scope, so it's already accessible at the response payload site (line ~1496) inside the `(async () => { ... })()` IIFE — closures capture the outer variable. Just read `surfaceContext.surface_origin` and add it to the payload.

- [ ] **Step 1: Read surface_origin from the existing surfaceContext variable**

In `/home/ellie/ellie-dev/src/ellie-chat-handler.ts`, the `surfaceContext` parameter from Task 4 is already in scope at line ~1496 (inside the coordinator-block IIFE — closures capture the outer function scope).

- [ ] **Step 2: Echo surface_origin on the response payload**

Find the `responsePayload` construction at line 1496 (Task 6 already added `surface_actions` here). Add `surface_origin`:

```typescript
const responsePayload: Record<string, unknown> = {
  type: "response",
  text: coordResponse,
  agent: "ellie",
  // ... existing fields including surface_actions from Task 6
};

// ELLIE-1455: Echo surface_origin so the originating panel can filter
if (surfaceContext?.surface_origin) {
  responsePayload.surface_origin = surfaceContext.surface_origin;
}
```

The same payload is used for both `deliverResponse(ws, responsePayload, ecUserId)` (line 1506) and `broadcastToEllieChatClients(responsePayload)` (line 1508), so a single edit serves both. The broadcast goes to all connected clients, but Task 11's panel filter (`m.surface_origin === props.surfaceContext.surface_origin`) ensures only the matching panel renders it.

**Note:** Phase 1 only updates the coordinator-mode response payload. The non-coordinator paths (orchestrated dispatch at ~1101, direct mode at ~1196) are skipped because the panel only ships on the coordinator path. If you find a panel response not appearing during smoke test, check that `COORDINATOR_MODE=true` is set.

- [ ] **Step 3: Run tests and verify**

Run: `cd /home/ellie/ellie-dev && bun test tests/surface-context.test.ts tests/surface-tools.test.ts tests/surface-tools-dispatch.test.ts`
Expected: All 15 tests still pass.

- [ ] **Step 4: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/ellie-chat-handler.ts
git commit -m "[ELLIE-1455] echo surface_origin on coordinator response for panel routing

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Mount EllieSurfacePanel on /knowledge reusing existing refs

**Files:**
- Modify: `/home/ellie/ellie-home/app/pages/knowledge.vue`

**Context (audit-corrected):** `knowledge.vue` ALREADY defines `activeTab` (line 465) and `selectedScope` as `ref<string | null>` — a bare path string, NOT an object with `.path/.name/.memoryCount`. There is also `selectedScopeObj` (line 567) — a computed `scopes.value.find(s => s.path === selectedScope.value)` which has `.name` and `.path` (no `.memoryCount`). And there's an existing `memories.value` ref populated when a scope is loaded. This task must REUSE these existing refs and DERIVE the values, not redeclare them. Re-declaring would cause duplicate identifier compile errors.

Likewise, do NOT fetch from `/api/forest/summary` (doesn't exist). Use the existing `scopes.value` and `totalMemories` refs the page already has.

The template wrap must keep the page header outside the scrollable content area, otherwise the header scrolls with the body — a UX regression.

- [ ] **Step 1: Read the existing knowledge.vue layout and refs**

```bash
cd /home/ellie/ellie-home
grep -n "selectedScope\|selectedScopeObj\|activeTab\|scopes\|totalMemories\|memories\b\|onMounted" app/pages/knowledge.vue | head -40
```

Confirm the names and shapes of the existing refs before proceeding.

- [ ] **Step 2: Add only the NEW state — don't redeclare existing refs**

In the `<script setup>` of `knowledge.vue`, add the imports and ONLY the new state. Do NOT touch `activeTab`, `selectedScope`, `selectedScopeObj`, `scopes`, `memories` — they exist already.

```typescript
// ELLIE-1455: Surface panel mount
import type { SurfaceContext, KnowledgeTreeContext, SurfaceAction } from '~/types/surface-context'

// A stable surface origin for this panel instance (mount-time generated)
const surfaceOrigin = `knowledge-panel-${crypto.randomUUID().slice(0, 8)}`

// surfaceContext computed — references EXISTING refs (selectedScope, activeTab,
// selectedScopeObj, scopes, memories — declared elsewhere in this file).
const surfaceContext = computed<SurfaceContext | null>(() => {
  if (activeTab.value === 'tree') {
    const scopeObj = selectedScopeObj.value
    const ctx: KnowledgeTreeContext = {
      surface_id: 'knowledge-tree',
      surface_origin: surfaceOrigin,
      selection: {
        scope_path: selectedScope.value ?? null,                 // bare string
        scope_name: scopeObj?.name ?? null,                      // from existing computed
        memory_count: memories.value?.length ?? 0,               // existing ref
      },
      forest_summary: {
        total_scopes: scopes.value?.length ?? 0,                 // existing ref
        total_memories: scopes.value?.reduce((sum: number, s: any) => sum + (s.memory_count ?? 0), 0) ?? 0,
      },
    }
    return ctx
  }
  // Other tabs add their own contexts in later phases.
  return null
})

async function handleSurfaceAction(action: SurfaceAction) {
  // Phase 1: Tree tab has no actions to apply yet (read-only awareness).
  // Navigation actions (propose_select_folder, propose_switch_tab) would
  // be handled here in future tasks. For now, log and ack.
  console.log('[knowledge] Surface action received:', action)
}
```

If the actual ref names in your `knowledge.vue` differ from `selectedScopeObj`/`memories`/`scopes`, adapt the references in the computed block — but do NOT add `ref(...)` declarations for these names. They already exist.

- [ ] **Step 3: Wrap the tabbed content (NOT the page header) in the flex layout**

Find the existing template root in `/home/ellie/ellie-home/app/pages/knowledge.vue`. The current shape (around lines 1-12) is:

```vue
<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <!-- HEADER: title, scope counts, etc. -->
    </div>
    <!-- TABS BAR -->
    <!-- TAB CONTENT (tree, graph, canvas, river, curation) -->
  </div>
</template>
```

Wrap ONLY the tab content (NOT the header) in a flex container with the panel on the right:

```vue
<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <!-- HEADER stays unchanged -->
    </div>

    <!-- TABS BAR stays unchanged -->

    <!-- NEW: flex wrapper around the tab content + panel -->
    <div class="flex h-[calc(100vh-12rem)] gap-3">
      <div class="flex-1 min-w-0 overflow-y-auto">
        <!-- existing tab content unchanged -->
      </div>

      <!-- Ellie Surface Panel -->
      <EllieSurfacePanel
        v-if="surfaceContext"
        :surface-id="surfaceContext.surface_id"
        :surface-context="surfaceContext"
        :on-action="handleSurfaceAction"
      />
    </div>
  </div>
</template>
```

The exact `h-[calc(...)]` value may need tuning based on the header height — start with `12rem` and adjust if the panel runs off-screen. The key constraint: **the page header must remain ABOVE the flex wrapper so it doesn't scroll with the content.**

- [ ] **Step 4: Verify nothing else broke**

```bash
cd /home/ellie/ellie-home && bun run build 2>&1 | tail -20
```

Watch for: duplicate identifier errors (means you accidentally redeclared `activeTab`/`selectedScope`), missing import errors, layout regressions in the header.

- [ ] **Step 5: Build and verify**

Run: `cd /home/ellie/ellie-home && bun run build 2>&1 | tail -5`
Expected: Clean build

- [ ] **Step 6: Restart dashboard and smoke-test**

```bash
sudo systemctl restart ellie-dashboard
```

Hard-refresh the dashboard, navigate to `/knowledge`, click on Tree tab. The Ellie surface panel should appear on the right side. Click a scope in the tree — the awareness banner should update to show the scope name. (You won't see the memory count update unless `selectedScope` is wired to the actual tree click handler — that wire-up may need to happen in this task or a follow-up depending on the existing code.)

- [ ] **Step 7: Commit**

```bash
cd /home/ellie/ellie-home
git add app/pages/knowledge.vue
git commit -m "[ELLIE-1455] mount EllieSurfacePanel on /knowledge with Tree tab awareness

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: End-to-end smoke test

**Files:**
- No file changes — manual verification

- [ ] **Step 1: Restart the relay**

```bash
systemctl --user restart ellie-chat-relay
```

- [ ] **Step 2: Restart the dashboard**

```bash
sudo systemctl restart ellie-dashboard
```

- [ ] **Step 3: Navigate to /knowledge**

Open `https://dashboard.ellie-labs.dev/knowledge` (or the local equivalent). The Ellie surface panel should appear on the right side of the page.

- [ ] **Step 4: Click a scope in the Tree tab**

Pick a scope (e.g., `ellie-dev → relay`). Verify:
- The awareness banner shows `🧭 SEEING: Tree · relay (...memories)`
- No errors in the browser console
- No errors in `journalctl --user -u ellie-chat-relay` (run on another terminal)

- [ ] **Step 5: Send a message to Ellie about the scope**

In the panel's input box, type "what's in this scope?" and hit enter.

Expected:
- Ellie's response references the selected scope by name (proving surface_context made it into her prompt)
- The response appears in the panel, NOT in `/ellie-chat`
- No surface_actions are emitted (read-only Tree tab in Phase 1)

- [ ] **Step 6: Verify isolation from /ellie-chat**

Open `/ellie-chat` in another tab. Confirm:
- The surface panel message and Ellie's response do NOT appear in `/ellie-chat`'s message stream
- `/ellie-chat` works exactly as before

- [ ] **Step 7: Send Workshop debrief**

```bash
bun -e 'await fetch("http://localhost:3001/api/workshop/debrief", {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-bridge-key": "bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a" },
  body: JSON.stringify({
    session: "Phase 1: Knowledge Surface Panel Foundation",
    repo: "ellie-dev",
    branch: "ellie/knowledge-surface-1470",
    work_item_id: "ELLIE-1470",
    decisions: [
      "EllieSurfacePanel.vue is the reusable component pattern for embedding Ellie on any UI surface",
      "Surface context is typed (discriminated union) and threaded through CoordinatorOpts → buildCoordinatorLayeredContext → coordinator system prompt at priority 2",
      "Surface tools (5 tools) are appended to COORDINATOR_TOOL_DEFINITIONS only when surfaceContext is present; dispatched as a new branch in the runCoordinatorLoop tool loop BEFORE complete/ask_user/dispatch_agent",
      "Surface actions are accumulated in runCoordinatorLoop and returned on CoordinatorResult; the handler attaches them to responsePayload",
      "surface_origin field routes responses back to the originating panel; thread-id filter is bypassed for panel-tagged messages so cross-tab state does not silently drop them"
    ],
    docs_created: ["docs/superpowers/specs/2026-04-06-knowledge-surface-and-ingestion-design.md", "docs/superpowers/plans/2026-04-06-knowledge-surface-phase1.md"],
    files_changed: [
      "src/surface-context.ts",
      "src/surface-tools.ts",
      "src/prompt-layers/index.ts",
      "src/prompt-layers/types.ts",
      "src/prompt-layers/coordinator.ts",
      "src/prompt-builder.ts",
      "src/ellie-chat-pipeline.ts",
      "src/ellie-chat-handler.ts",
      "src/websocket-servers.ts",
      "src/coordinator.ts",
      "tests/surface-context.test.ts",
      "tests/surface-tools.test.ts",
      "tests/surface-tools-dispatch.test.ts",
      "ellie-home/app/types/surface-context.ts",
      "ellie-home/app/composables/useEllieChat.ts",
      "ellie-home/app/components/ellie/EllieSurfacePanel.vue",
      "ellie-home/app/components/ellie/ProposalPreviewCard.vue",
      "ellie-home/app/pages/knowledge.vue"
    ],
    scopes: ["2/1", "2/3"],
    summary: "Phase 1 of the knowledge surface work is complete. Ellie now lives as an embedded surface-aware panel on /knowledge Tree tab, sees the active scope via surface_context threaded through the coordinator loop, and the proposal pattern is wired end-to-end ready for Phase 2 to attach mutations on the River tab."
  })
}).then(r => r.json()).then(console.log)'
```

- [ ] **Step 8: Commit any fixes from smoke-test**

```bash
git add -A && git commit -m "[ELLIE-1455] Phase 1 smoke-test fixes" || true
```

---

## Notes for Implementers

### Repo coordination
This plan touches both `ellie-dev` and `ellie-home`. Work tasks in order — relay-side tasks (1-6, 12) before dashboard tasks (7-11, 13) — because the dashboard depends on the relay's wire format being in place. Restart each service after committing on its repo before testing the next dependent task.

### LAYERED_PROMPT feature flag
The relay supports both the legacy flat prompt builder and the new layered builder, gated by `LAYERED_PROMPT=true` in `.env`. Phase 1 only modifies the layered path (`gatherLayeredContext`). If `LAYERED_PROMPT=false`, surface context will not be injected. Verify the env flag is `true` before smoke-testing.

### Surface origin routing
The `surface_origin` field is the routing key. The panel filters incoming messages by `m.surface_origin === props.surfaceContext.surface_origin`. This means if you open `/knowledge` in two browser tabs, each tab gets its own panel instance with its own `surface_origin`, and responses don't cross-pollinate. The relay just echoes the origin — it doesn't enforce any uniqueness, that's the panel's job.

### Surface-scoped threads (deferred to Phase 2)
The spec calls for surface-scoped threads (`knowledge-tree`, `knowledge-river`) instead of sharing the main chat thread. Phase 1 doesn't implement this — the panel uses whatever thread `useEllieChat` is currently on. Phase 2 will add the auto-thread-creation logic when the River tab is built. The `surface_origin` filter is sufficient for Phase 1's isolation needs.

### Tool execution shape — POST-AUDIT NOTE
`coordinator-tools.ts` is a static `Anthropic.Tool[]` constant — there is no `buildCoordinatorTools()` builder. There is no `execute` field on tool definitions. Tool dispatch happens via a hardcoded switch in `runCoordinatorLoop` (line 380) and `handleTool()` (line 847). Task 5 (post-audit revision) adds `surfaceContext` to `CoordinatorOpts`, computes an effective tools list inside the loop, threads it through `callMessagesAPI`, and renders surface context as a section in the coordinator system prompt. Task 6 adds a new dispatch branch BEFORE the existing complete/ask_user/dispatch_agent split that synthesizes a `SurfaceAction` via `buildSurfaceAction(name, input)` and acks via `ctx.addToolResult`. Do not look for an `execute` closure — it doesn't exist.

### Note on the corrected on-disk shape from Tasks 1–3
The plan was patched after a code-review-driven audit found multiple shape mismatches. Specifically:
- `SURFACE_TOOL_DEFINITIONS` is `Anthropic.Tool[]` with `input_schema` (snake_case), no `execute` field — see surface-tools.ts.
- `renderSurfaceContext` already prepends `"## SURFACE CONTEXT\n"` — callers should not duplicate it.
- `LayeredPromptResult.surfaceContext` is consumed by `prompt-builder.ts` (the missing wire was added in Task 3's fix commit).
- Task 1 added `KnowledgeRiverContext` rendering tests, so the test count after Task 3 is 8 (not 5 as originally written).
- Task 7's ellie-home types should mirror this corrected shape — use the exhaustive `TOOL_CLASSIFICATION` Record pattern instead of the original `AUTO_APPLY_TOOLS` Set if you want the same compile-time guarantee on the frontend.

### What Phase 1 does NOT include
- River tab restructuring (Phase 2A)
- The actual ingestion pipeline (Phase 2B)
- Mutation handlers for `propose_create_folder` etc. (Phase 2C — Phase 1's `handleSurfaceAction` is a stub)
- Surface-scoped thread auto-creation (Phase 2A)
- Position toggle (right vs bottom drawer) — the panel supports it but Phase 1 only verifies right-sidebar mount
- Read mode and avatar wired into the panel header — props are accepted, parent must implement

After Phase 1 ships, Ellie is present on `/knowledge` Tree tab, can see the user's selection, and the proposal pattern's plumbing is fully connected end-to-end. Phase 2 attaches real behavior to it.
