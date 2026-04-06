# Knowledge Surface & Data Ingestion — Design Spec

> **Date:** 2026-04-06
> **Status:** Brainstormed
> **Context:** Today, getting knowledge into Ellie's system means manually editing Obsidian files or writing Forest memories via the bridge API. There is no in-app way to upload a PDF, drop a Word doc, or have Ellie help organize where things go. This spec establishes both (1) a reusable pattern for embedding Ellie on any UI surface and (2) the first application of that pattern: a data ingestion control surface on `/knowledge` that converts uploaded files into River markdown and Forest semantic chunks.

## Problem

Three connected problems:

1. **No in-app ingestion path.** PDFs, Word docs, HTML, CSV — none of these can flow into Ellie's knowledge today without leaving the dashboard. Dave has accumulated reference material that should be searchable but isn't, because the friction of manual conversion + manual filing is too high.

2. **Ellie isn't present where the work happens.** `/ellie-chat` is the only surface where Ellie lives. Every other page (Tree view, River search, Graph, Canvas) is silent — the user has to context-switch to chat, describe what they're looking at, and hope Ellie understands without seeing the screen.

3. **No conversational control surface.** Even if ingestion existed as a manual upload form, the user would have to *also* navigate folders, *also* create the right structure, *also* remember where things go. The natural interaction is "I want to load some quantum papers" — and have Ellie help propose structure, then take action when the user accepts.

These three are connected because solving them in isolation produces three half-features. Solving them together produces a single coherent surface where (a) Ellie is always present and aware of what you're doing, (b) you can do everything manually without her, and (c) when you describe what you want, she helps.

## Design Principles

- **Manual first, Ellie second.** Every action on the surface must be doable without saying a word to Ellie. She is an assistant layer on top of a fully-functional manual surface.
- **Ellie sees what the user sees.** When Ellie is embedded on a surface, she receives a `surface_context` payload describing the current state — which tab, what's selected, what's loaded. She doesn't have to guess.
- **Proposals are previewed before they happen.** When Ellie suggests a structural change (create folders, move files, ingest), the panel renders a visual preview card with Accept/Reject. Nothing mutates without explicit user approval.
- **Visual previews matter for dyslexia.** Seeing the proposed structure beats parsing prose. Multi-item proposals get granular ✓/✗ per item.
- **Reusable pattern, not bespoke code.** The Ellie panel and the surface-context machinery are designed once and reused on every future surface. `/knowledge` is the first application; the same pattern will land on Graph, Canvas, the Forest tree, and beyond.
- **`/ellie-chat` stays unchanged.** The conversation surface is separate from the control surface. They share message history (via threads) but the chat page is a focus-mode interface; the surface panels are tools.

---

## Architecture

### Three layers

**1. Surface page** (`/knowledge`) — fully manual. Tabs (Tree, Graph, Canvas, River, Curation), navigation, search, file operations. Works completely without Ellie.

**2. Ellie panel** (`EllieSurfacePanel.vue`) — embedded on the page as a right sidebar (collapsible, with bottom-drawer alternative). Has the full chat controls (mic, read mode, avatar, send). Talks to the same WebSocket as `/ellie-chat` but carries an extra `surface_context` payload.

**3. Surface bridge** — a structured action protocol. When Ellie proposes a change, the response message includes a `surface_action` field. The page interprets the action, renders a preview card, and on accept, applies it locally. No browser automation hacks — Ellie emits intent, the page applies it.

### Data flow

```
User on /knowledge → River tab → research/ folder selected
                            ↓
Panel sends message with surface_context = {
  surface_id: "knowledge", tab: "river",
  selection: { folder: "research/", file_count: 12 }
}
                            ↓
Relay's prompt-builder injects "## SURFACE CONTEXT" section
                            ↓
Ellie reasons with full awareness, calls propose_create_folder
                            ↓
Response message includes surface_action.tool = "propose_create_folder"
                            ↓
Panel renders proposal preview card with diff + Accept/Reject
                            ↓
User clicks Accept → page calls createFolders([...]) locally
                            ↓
Ack flows back to relay so Ellie knows what landed
```

---

## The Ellie Panel (Reusable Component)

**Component:** `app/components/ellie/EllieSurfacePanel.vue` (in `ellie-home`)

**Props:**
```typescript
defineProps<{
  surfaceId: string                                        // "knowledge", "tree", etc.
  surfaceContext: Ref<Record<string, unknown>>             // reactive — updates as user clicks
  onAction?: (action: SurfaceAction) => Promise<ActionResult>  // proposal handler
}>()
```

**Layout:**
- Right sidebar, ~340px wide, full vertical height
- Collapsible to a 24px strip showing only the avatar — click to expand
- Position toggle: right sidebar (default) or bottom drawer (full-width across the bottom)
- Persists `collapsed` and `position` state to `localStorage` keyed by `surfaceId`

**Top-to-bottom structure:**

| Region | Contents |
|---|---|
| **Header** | Ellie avatar · "Ellie" label · spacer · Read mode 🔊 · Avatar 👤 · Position toggle ⇆ · Collapse |
| **Surface awareness banner** | Cyan strip, always visible: `🧭 SEEING: River tab · research/ · 12 files`. Updates in real-time from `surfaceContext`. |
| **Chat scroll area** | Reuses message rendering from `/ellie-chat` (markdown-it, contributor avatars, Workshop cards). Includes proposal preview cards inline with messages. |
| **Input row** | Mic 🎤 · text input · send ▶ |

**Connection model:**
- Uses the same WebSocket as `/ellie-chat` (`/ws/ellie-chat`) — single shared connection
- Sends `surface_context` field on every outgoing message
- Shares the same active thread by default (so a conversation on `/ellie-chat` continues on `/knowledge`)
- Thread selector available in the panel header (small dropdown) for users who want a separate conversation

**Composes existing infrastructure:**
- `useEllieChat()` for messages, send, thread state, WebSocket
- `useMarkdown()` for rendering
- `useThreads()` for thread switching
- Does NOT reimplement chat — it's a thin shell around the existing composables plus surface awareness

---

## Surface Context Wiring (Relay-side)

**Schema extension:**

WebSocket `message` payload (user → relay) gains an optional field:
```typescript
{
  type: "message",
  text: string,
  // ... existing fields
  surface_context?: {
    surface_id: string,
    tab?: string,
    selection?: Record<string, unknown>,
    [key: string]: unknown,    // surface-specific extensions
  }
}
```

**Prompt injection:**

`src/prompt-builder.ts` (or the layered prompt builder if `LAYERED_PROMPT=true`) gets a new section: **Surface Context**, injected at priority 4 (between Awareness and Knowledge layers).

When `surface_context` is present, render it as natural language:

```
## SURFACE CONTEXT
The user is on /knowledge → River tab.
- Selected folder: research/ (12 files, 2 subfolders)
- Recent files: quantum-paper.md, thesis-notes.md, readme.md, ...
- River has 38 indexed docs across 24 folders.
- No ingestion in progress.

You can propose actions that affect this surface using the surface_action tools.
```

The exact format varies by `surface_id` — each surface registers a renderer that knows how to format its own context. For v1, only the `knowledge` surface has a renderer.

---

## Surface Action Tools (Proposal Pattern)

A new tool group registered for Ellie when the active message has `surface_context.surface_id === "knowledge"`.

| Tool | Purpose | Args |
|---|---|---|
| `propose_create_folder` | Suggest one or more new folders in River. | `paths: string[]`, `reason: string` |
| `propose_move_folder` | Suggest moving a folder. | `from: string`, `to: string`, `reason: string` |
| `propose_select_folder` | Switch the user's selected folder. | `path: string` |
| `propose_switch_tab` | Switch tabs within `/knowledge`. | `tab: "tree" \| "river" \| "graph" \| "canvas" \| "curation"` |
| `propose_ingest_files` | Prime the user that the drop zone is ready (no upload, just guidance). | `target_folder: string`, `expected_count?: number` |

These are **proposal tools**, not action tools. They emit a `surface_action` payload attached to the response message metadata — they do NOT mutate state on the relay or in any database.

**Wire format on the response message:**

```json
{
  "type": "response",
  "text": "I'd suggest creating research/quantum-computing/ with two subfolders.",
  "agent": "ellie",
  "surface_action": {
    "tool": "propose_create_folder",
    "args": {
      "paths": [
        "research/quantum-computing/",
        "research/quantum-computing/papers/",
        "research/quantum-computing/notes/"
      ],
      "reason": "Group quantum papers together with separate spaces for source PDFs and notes."
    },
    "proposal_id": "prop_abc123"
  }
}
```

**Acceptance flow:**

When the user clicks Accept (or accepts a granular subset), the panel sends a structured ack message back to the relay:

```json
{
  "type": "proposal_response",
  "proposal_id": "prop_abc123",
  "applied": true,
  "applied_subset": ["research/quantum-computing/", "research/quantum-computing/papers/"],
  "rejected_subset": ["research/quantum-computing/notes/"]
}
```

Ellie sees this ack on her next turn so she can acknowledge what landed and not repeat suggestions.

**Read-only operations don't need proposals:**

If Ellie just wants to *show* something to the user (e.g., "let's open `research/`"), she calls `propose_select_folder` which the panel can apply *immediately* without an Accept button — because nothing is being mutated, only navigation. The `propose_*` naming is preserved for consistency, but the panel's action handler decides per-tool whether to require explicit acceptance. Mutating tools (`create_folder`, `move_folder`, `ingest_files`) always require explicit acceptance. Navigation tools (`select_folder`, `switch_tab`) apply immediately.

---

## River Tab — Two Zones

The River tab on `/knowledge` is restructured into two vertically-stacked zones.

### Zone A — River Navigation (top, ~60% of vertical space)

**Contents:**
- **Search box** — universal command bar. Type to filter folders by name. If no match, the first result becomes "Create '<name>' here →". Search is the find/create/move primitive.
- **Selected folder header** — shows active folder path with file count: `research/` — 12 files
- **Folder contents grid** — files (with format icons) and subfolders inside the selected folder
- **Breadcrumb / back arrow** — to navigate up

**Behaviors:**
- Selecting a folder updates `surface_context.selection.folder` (panel banner updates immediately)
- Clicking a file opens a preview modal (rendered markdown + frontmatter)
- Clicking a subfolder navigates into it
- Newly-ingested files appear with a "NEW" badge for ~30 seconds after the `ingest_complete` event

### Zone B — Ingest Drop Zone (bottom, ~40% of vertical space)

**Contents:**
- **Drop target** — full-width dashed cyan border, large enough to be an obvious drop target
- **Headline** — `⬆ INGEST INTO {selected folder}` — always shows where files will land
- **"Choose Files" button** — fallback for users who prefer click-to-browse
- **Format hint line** — `PDF · Word · HTML · CSV · JSON · MD · …`
- **Path summary line** — `raw → uploads-archive/{folder}` · `md → {folder}` · `summary → Forest`

**Behaviors:**
- Drag files anywhere over Zone B → they upload, convert, plant in Forest, and land in the selected folder
- Click "Choose Files" → multi-file picker opens
- Multi-file: drop or pick up to 50 files at once (parallel processing, max 3 concurrent)
- During upload, the zone transforms into a progress display (one row per file with status)
- On completion, new files appear in Zone A with NEW badges + a Workshop card appears in the Ellie panel

**Selected folder relationship:**
- Zone A's selected folder IS Zone B's upload target
- If nothing is selected, Zone B is dimmed and headline reads `⬆ INGEST INTO (select a folder above)`
- Changing folders in Zone A instantly updates Zone B's headline

### Why two zones in one tab (vs. separate tab)

Context matters at every step. The selected folder in Zone A is the upload target in Zone B. They are not independent screens; they are one workflow. A separate Ingest tab would force the user to verify "did this land in the right place?" by switching back. One tab, two zones, shared selection.

---

## Conversion Pipeline (raw → River MD → Forest summary)

### Storage layout (sidecar pattern)

```
/home/ellie/obsidian-vault/ellie-river/
  research/
    quantum-paper.md          ← converted markdown (canonical, in River, indexed by QMD)
    thesis-notes.md

/home/ellie/uploads-archive/    ← parallel tree, NOT in River, NOT Syncthing-synced
  research/
    quantum-paper.pdf          ← original raw file, preserved
    thesis-notes.docx
```

**MD frontmatter holds the back-reference to the original:**

```yaml
---
title: Quantum Computing Paper
source: quantum-paper.pdf
source_path: uploads-archive/research/quantum-paper.pdf
ingested_at: 2026-04-06T15:30:00Z
ingested_by: dave
original_size: 2451200
original_format: pdf
forest_chunks: 4
ingestion_id: ing_abc123
---
```

### Pipeline stages (per file)

1. **Upload** — `POST /api/knowledge/ingest` (new endpoint in `ellie-home/server/api/knowledge/`)
   - Multipart form: `file`, `target_folder`, `proposal_id?` (optional, links to Ellie's proposal)
2. **Validate** — check size (max 50 MB), check `canIngest(filename)` from `document-ingestion.ts`. Reject early with a clear error.
3. **Archive raw** — write the original buffer to `uploads-archive/{target_folder}/{filename}`. Create the directory tree if needed.
4. **Convert to MD** — call `ingestDocument(buffer, filename)` from `document-ingestion.ts` → returns `{ markdown, title, format, ... }`. For images, pass a `describeFn` that calls a vision model for caption.
5. **Build frontmatter** — assemble the YAML with source link, ingested_at, ingestion_id.
6. **Write to River** — `POST /api/bridge/river/write` with `operation: "create"`, `path: "{target_folder}/{slug}.md"`, content. The QMD reindex fires automatically as a side effect (BM25 index updated).
7. **Plant Forest summary chunks** — call new helper `planIngestionSummary(markdown, title, target_folder)`:
   - Splits markdown into ~500-token semantic chunks (paragraph-aware split)
   - For long docs (>3 chunks), generates a top-level summary as one extra chunk via LLM call
   - Each chunk is written to Forest via `bridgeWrite` with `type: "fact"`, metadata `{ river_doc_path, chunk_index, ingestion_id, target_folder }`
   - **Scope assignment** — a helper `riverFolderToScope(target_folder)` returns the Forest scope path. v1 default: a single dedicated scope `2/river-ingest` (created at first ingestion) with all chunks tagged by `target_folder` for filtering. Future: per-folder sub-scopes (`2/river-ingest/research`, etc.) once the dedicated branch is established.
8. **Update frontmatter** — write `forest_chunks: N` back into the MD (so the doc knows how many embeddings exist)
9. **Notify** — emit WebSocket event `{ type: "ingest_complete", ingestion_id, river_path, forest_chunk_count, target_folder, file_name }`
   - UI Zone A marks the file with NEW badge
   - Ellie panel renders a Workshop-style card with a permanent record

### Failure handling

- **Raw archive succeeds, conversion fails** → keep raw, write a placeholder MD with an error note in frontmatter. Surface chat message: "I saved the original but couldn't extract text. You can retry or open it manually."
- **Conversion succeeds, Forest planting fails** → MD lives in River (still searchable via BM25). Forest chunks queued for retry. Don't roll back what worked.
- All failures append to `uploads-archive/{folder}/.ingest-errors.jsonl` for later inspection.

### Concurrency

- 5 PDFs dropped at once → process in parallel (max 3 concurrent), queue the rest
- Each file is independent — one failure doesn't block the others
- Progress display shows all files: queued / uploading / converting / planting / done / failed

### Why this layout

- **Sidecar in a parallel tree** keeps River clean (only MD lives there, Obsidian and QMD don't get confused by binary files)
- **Forest summary chunks** make the content semantically searchable through Ellie's normal Layer 3 retrieval
- **Automatic, not manual** — every ingested file gets summarized for free
- **Scope assignment for v1** — all chunks land in a dedicated `2/river-ingest` Forest scope, tagged with `target_folder` metadata for filtering. Future: per-folder sub-scopes and smart content-based scope detection.

---

## Ellie's Surface Awareness in Action

### What Ellie knows about `/knowledge` (River tab)

```typescript
{
  surface_id: "knowledge",
  tab: "river",
  selection: {
    folder: "research/",
    folder_file_count: 12,
    folder_subfolder_count: 2,
    last_files: ["quantum-paper.md", "thesis-notes.md", "readme.md", "..."]  // up to 5
  },
  ingestion_state: {
    in_progress: false,
    queued: 0,
    last_ingested_at: "2026-04-06T15:30:00Z"
  },
  river_summary: {
    total_docs: 38,
    total_folders: 24
  }
}
```

### What Ellie knows about `/knowledge` (Tree tab)

```typescript
{
  surface_id: "knowledge",
  tab: "tree",
  selection: {
    scope_path: "2/1/3",       // selected scope
    scope_name: "memory",
    memory_count: 432
  },
  forest_summary: {
    total_scopes: 163,
    total_memories: 4274
  }
}
```

### Example conversational flow

**User (on `/knowledge`, River tab, no folder selected):** "I want to load some research papers about quantum computing."

**Ellie:**
> I'd suggest creating `research/quantum-computing/` with two subfolders — `papers/` for the source PDFs and `notes/` for your annotations. Want me to set that up?

→ Response message includes `surface_action.tool: "propose_create_folder"` with the three paths.

→ Panel renders proposal preview card with three checkboxes (all checked by default), Accept all / Cancel buttons.

**User clicks Accept all.**

→ Page calls `createFolders([...])` locally (which hits the River bridge create-folder API).

→ Page sends `proposal_response` ack to relay.

**Ellie's next turn:**
> Done. The folders are ready. Drag your PDFs into the drop zone below — they'll go into `research/quantum-computing/papers/`. I'll convert them to markdown and make them searchable.

→ Response includes `surface_action.tool: "propose_select_folder"` with `path: "research/quantum-computing/papers/"` (auto-applied since it's navigation, not mutation).

→ Zone B's headline updates to `⬆ INGEST INTO research/quantum-computing/papers/`

**User drops 3 PDFs.**

→ Zone B shows progress for each file.

→ Each file: archive raw → convert → write to River → plant Forest chunks → emit ingest_complete.

→ Workshop card appears in Ellie panel: "Ingested 3 files into research/quantum-computing/papers/"

→ Files appear in Zone A with NEW badges.

**Ellie (next turn, optionally):**
> All three landed. The first paper is about Shor's algorithm — want me to summarize what they say collectively, or are you saving them for later?

→ Ellie can answer this because the Forest chunks are now searchable via her Layer 3 retrieval.

---

## Phasing

### Phase 1A: Ellie Surface Panel (reusable component)

The foundation. Build the embedded chat panel as a reusable Vue component.

- New component `app/components/ellie/EllieSurfacePanel.vue`
- Composes existing `useEllieChat()` (no new WebSocket)
- Right sidebar layout, collapsible, position toggle (right/bottom)
- Header with controls (mic, read mode, avatar, position toggle, collapse)
- Surface awareness banner (cyan strip)
- Chat scroll area (reuses message rendering)
- Input row with mic + send
- Props: `surfaceId`, `surfaceContext`, `onAction`
- Persists collapsed/position state per `surfaceId`

**Acceptance:** Drop the component on any page, it works as a thin chat panel. No surface-specific behavior yet.

### Phase 1B: Surface context wiring (relay-side)

Teach the relay how to receive and use `surface_context`.

- Extend the WebSocket message schema to accept `surface_context` field
- New "Surface Context" section in `prompt-builder.ts` (or layered prompt builder), priority 4
- Per-surface renderer registry (v1: only `knowledge` renderer)
- Test: send a message with surface_context, verify Ellie's prompt includes it

**Acceptance:** Ellie can be told "you're on /knowledge → River → research/" and her replies reflect that awareness.

### Phase 1C: Surface action tools (proposal pattern)

Add the proposal-style tools and the wire format for actions.

- New tool group `surface_tools` registered when `surface_id === "knowledge"`
- Tools: `propose_create_folder`, `propose_move_folder`, `propose_select_folder`, `propose_switch_tab`, `propose_ingest_files`
- Each tool emits `surface_action` payload attached to response message metadata
- Wire into the `complete` flow so metadata travels with the message
- Panel receives the action, renders preview card with Accept/Reject (mutating tools) or auto-applies (navigation tools)
- Acceptance ack flows back to relay as `proposal_response` message

**Acceptance:** Ellie can say "I propose creating folder X" and the panel renders a clickable preview card.

### Phase 2A: Mount panel on /knowledge + Tree tab awareness

First real surface integration.

- Add `<EllieSurfacePanel>` to `app/pages/knowledge.vue`
- Right sidebar by default, collapsible
- Provide `surface_context` for Tree tab (current scope, scope tree summary, memory counts)
- Implement minimal action handlers: `propose_select_folder` (scope selection) is enough for Tree
- Ellie can answer "what's in scope X?" with full awareness
- No mutations on Tree tab (read-only awareness)

**Acceptance:** Open `/knowledge`, see Ellie panel, switch to Tree tab, click a scope, watch the surface awareness banner update.

### Phase 2B: River tab — Two zones layout

Restructure the existing River tab.

- Refactor to Zone A (top, ~60%) + Zone B (bottom, ~40%)
- Zone A: search box, selected folder header, folder contents grid, breadcrumb
- Search-as-command-bar logic (find / create / move from one input)
- Selected folder is shared state for the tab
- Manual folder navigation works (no Ellie involvement yet)
- Zone B: drop zone shell + Choose Files button + path summary line (drop zone is inert in this phase)
- Surface context for River tab

**Acceptance:** River tab has the new two-zone layout, manual folder navigation works, search/create/move work, drop zone is visible but inert.

### Phase 2C: Ingestion pipeline

Wire up the actual conversion pipeline.

- New endpoint `POST /api/knowledge/ingest` in `ellie-home/server/api/knowledge/`
- Validates file (size, `canIngest()`)
- Archives raw to `uploads-archive/{folder}/{filename}` (configurable root via env var)
- Calls `ingestDocument()` from `ellie-dev` (expose via internal API or shared module)
- Builds frontmatter, writes MD via `POST /api/bridge/river/write`
- Splits MD into chunks, plants each in Forest via bridge write
- Updates frontmatter with `forest_chunks` count
- Emits `ingest_complete` WebSocket event
- Drop zone in Zone B becomes live
- Multi-file with parallel processing (max 3 concurrent)
- Progress display in Zone B during upload
- New files appear in Zone A with NEW badge
- Workshop card in Ellie panel showing the ingestion record

**Acceptance:** Drop a PDF into Zone B, watch it convert, see the MD appear in Zone A, search River and find it, ask Ellie about its content and she finds the Forest chunk.

### Phase 2D: Ellie's River agency

Make Ellie active on the River tab with proposals/previews/accept.

- Action handlers for River tab: `propose_create_folder`, `propose_move_folder`, `propose_select_folder`, `propose_ingest_files`
- Proposal preview card component (cyan dashed border, granular ✓/✗ per item)
- Accept all / Reject buttons
- Acceptance ack flows back to relay
- Ellie's prompt includes surface tools when `surface_id === "knowledge"`
- Test conversational flows end-to-end

**Acceptance:** Full conversational ingestion flow works — describe to Ellie, she proposes structure, you accept, you drop files, everything lands in the right place.

### Phase 3 (future, separate specs)

- Ellie panel on more surfaces — Tree mutations, Graph, Canvas
- **Big Rock 2** — Supabase message → Forest categorization with learned rules (off-cycle background work + morning review surface for unknowns)
- Ingestion of URLs (paste a URL, scrape and convert)
- Smart Forest scope detection at ingestion time
- Cross-thread context sharing on the panel

---

## What Doesn't Change

- **`/ellie-chat` is unchanged** — the conversation surface stays as-is, focus mode, no panels
- **WebSocket protocol** — same connection, same auth, same thread system (just adds optional `surface_context` field)
- **River bridge API** — `POST /api/bridge/river/write` already exists with the right semantics
- **Forest bridge API** — `POST /api/bridge/write` already supports the chunk metadata pattern
- **`document-ingestion.ts`** — already handles all the file format conversions; we just orchestrate it

## Success Criteria

1. **Manual ingestion works** — drop a PDF on the River tab, watch it convert, see the MD in River, find Forest chunks via Ellie's normal search
2. **Conversational ingestion works** — say "I'm loading research papers" → Ellie proposes folders → accept → drop files → everything lands correctly
3. **Surface awareness is live** — switch tabs in `/knowledge`, click selections, watch the Ellie panel banner update; ask Ellie about the current selection and she answers with context
4. **`/ellie-chat` is unaffected** — the existing chat experience is exactly as it was before
5. **Reusable foundation** — `EllieSurfacePanel.vue` works as a drop-in component, ready to be added to any other page in a future spec
6. **No data loss** — if conversion fails partway, raw file is preserved and the failure is recorded; user can retry
7. **No silent mutations** — every structural change initiated by Ellie is previewed and accepted before it happens
