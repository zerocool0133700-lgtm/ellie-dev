# Knowledge Surface & Data Ingestion — Design Spec

> **Date:** 2026-04-06
> **Status:** Reviewed (Rev 2 — incorporates feedback from Ellie, Alan, Brian)
> **Context:** Today, getting knowledge into Ellie's system means manually editing Obsidian files or writing Forest memories via the bridge API. There is no in-app way to upload a PDF, drop a Word doc, or have Ellie help organize where things go. This spec establishes both (1) a reusable pattern for embedding Ellie on any UI surface and (2) the first application of that pattern: a data ingestion control surface on `/knowledge` that converts uploaded files into River markdown and Forest semantic chunks.
>
> **The Two-Coin Vision:** The product must be excellent AND Ellie must be excellent. `/knowledge` is the embodiment of this — the surface is fully manual and beautifully usable on its own (coin one: product excellent), and Ellie is present as a contextually-aware, helpful layer on top (coin two: Ellie excellent). Both halves are first-class. The spec is structured so both halves can ship and be evaluated independently — but the design lives at the intersection.

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
- **Default to a surface-scoped thread, NOT the main chat thread.** Each surface gets its own auto-created thread on first use, named after the surface (e.g., `knowledge-river`, `knowledge-tree`). This means surface actions and proposals never bleed into `/ellie-chat`.
- Thread selector available in the panel header for users who want to switch threads (e.g., share a conversation across surfaces deliberately).
- The `surface_origin` field is included on every outgoing message as a redundant safeguard: `{ surface_id, surface_origin: 'knowledge-river-panel' }`. The relay tags response messages with the same field, and clients filter by it. So even if a user moves the panel's thread to the main chat thread, surface action cards only render in panels that match the origin.

**Why surface-scoped threads:**
The shared-thread model creates a subtle bug: a surface action sent on the main chat thread arrives at `/ellie-chat` with no action handlers, leaving an orphaned proposal. Surface-scoped threads eliminate the bug entirely. Users who *want* a cross-surface conversation can manually select the same thread in both places — the system supports it, just doesn't default to it.

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
| `propose_select_folder` | Switch the user's selected folder. Auto-applied (read-only navigation). | `path: string` |
| `propose_switch_tab` | Switch tabs within `/knowledge`. Auto-applied. | `tab: "tree" \| "river" \| "graph" \| "canvas" \| "curation"` |
| `highlight_drop_zone` | Auto-expand Zone B and select the target folder, signaling "I'm ready for your files." Used when Ellie has just proposed structure that the user accepted, and now wants to invite the upload. Auto-applied (no accept needed). | `target_folder: string` |

(Earlier draft had a `propose_ingest_files` tool — Brian's review correctly noted it was a no-op masquerading as an action. It's been replaced by `highlight_drop_zone`, which has real behavior: it auto-expands Zone B and locks the selected folder, so the user lands on a primed surface ready to receive files.)

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

If Ellie just wants to *show* something to the user (e.g., "let's open `research/`"), she calls `propose_select_folder` which the panel can apply *immediately* without an Accept button — because nothing is being mutated, only navigation. The `propose_*` naming is preserved for consistency, but the panel's action handler decides per-tool whether to require explicit acceptance. Mutating tools (`create_folder`, `move_folder`) always require explicit acceptance. Navigation tools (`select_folder`, `switch_tab`, `highlight_drop_zone`) apply immediately.

### Proposal Preview Card — visual specification

The card is the most important visual element in the conversational flow. It is a child component of `EllieSurfacePanel.vue` rendered inline with chat messages — directly below the message that contains the `surface_action`. Component name: `ProposalPreviewCard.vue`.

**Structure:**

```
┌─────────────────────────────────────────────┐
│ ┃ PROPOSAL — preview in River               │ ← header bar (cyan, 28px tall)
│ ┃ Create folders                            │ ← short summary of action type
├─────────────────────────────────────────────┤
│ ☑ + research/quantum-computing/             │ ← per-item rows with checkboxes
│ ☑ + research/quantum-computing/papers/      │   (default checked, click to toggle)
│ ☑ + research/quantum-computing/notes/       │
├─────────────────────────────────────────────┤
│ Reason: Group quantum papers with separate  │ ← Ellie's reason (collapsible if long)
│   spaces for source PDFs and notes.         │
├─────────────────────────────────────────────┤
│  [✓ Accept selected]   [✗ Reject all]       │ ← action buttons (cyan/gray)
└─────────────────────────────────────────────┘
```

**Visual rules:**
- 1px cyan dashed border around the entire card (matches Zone B drop zone styling for visual coherence)
- Background: `bg-gray-900/40` (slightly darker than the chat bubble)
- Width: matches chat message width, max 400px
- Diff lines: `+` rows in green (`text-emerald-400`), `-` rows in red (`text-red-400`), `→` rows in cyan (move/rename)
- Each row has a small icon prefix: 📁 for folder, 📄 for file, ⬆ for upload
- Checkboxes on the left of each row for granular accept (default checked)
- Footer buttons: cyan filled "Accept selected" (default action, primary), gray outline "Reject all" (secondary)
- Disabled state during apply: button text becomes "Applying..." with a small spinner

**Behavior:**
- Card appears as soon as the message arrives, with all items checked
- User can uncheck individual items
- "Accept selected" is enabled when at least one item is checked
- "Reject all" sends a `proposal_response` with `applied: false` and disables the card (greys out, replaces buttons with "Rejected" label)
- "Accept selected" sends `proposal_response` with `applied: true` and `applied_subset` (the checked items). On success, the card becomes a "Done" state with a green check and the timestamp. On failure, the card shows an error and keeps the buttons enabled for retry.
- Once a card is in Done or Rejected state, it stays in the chat scroll as a permanent record (just like a Workshop card) — scrolling back shows the historical decision.

**Reusability:**
The card is generic across surfaces. It takes a `surface_action` prop, infers the visual representation from the tool name (`propose_create_folder` → "Create folders" + folder icons; `propose_move_folder` → "Move folder" + before/after diff). New tools register a small renderer descriptor when they're added, so the card knows how to display them.

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

### Zone B — Ingest Drop Zone (bottom, collapsible)

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

**Collapsible by default:**
Most of the time the user is browsing River, not ingesting. Zone B starts as a thin 40px bar at the bottom that says `⬆ Ingest into {selected folder}` — the bar is the trigger surface. Three ways to expand:
1. **Click the bar** → expands to ~40% of vertical space
2. **Drag a file from anywhere over the page** → auto-expands as soon as the drag enters the window
3. **Hover the bar for >300ms** → expands (forgiving for users who want to peek without clicking)

When expanded, an arrow toggle in the bar collapses it back. Expanded state persists per-session in `sessionStorage` so a workflow that involves multiple uploads doesn't keep collapsing.

When ingestion is in progress, the zone stays expanded until the last file completes, then collapses on a 5-second delay (giving the user time to read the result).

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

### Pipeline host

**The pipeline runs on the relay (`ellie-dev`, port 3001), NOT in `ellie-home`.** The relay already owns the bridge API, the Forest write paths, the WebSocket protocol, and `document-ingestion.ts`. Putting `/api/knowledge/ingest` in `ellie-home` would mean either duplicating those capabilities or proxying back to the relay for every step. The clean split:
- **`ellie-home`** (the dashboard): uploads files, renders progress, displays results. No pipeline logic.
- **`ellie-dev`** (the relay): owns the entire ingestion pipeline. Receives multipart upload, runs the stages, emits WebSocket events.

The `ellie-home` Nuxt server route (if any) is a thin pass-through that forwards multipart form data to the relay endpoint with the bridge key for authentication.

### Pipeline stages (per file)

1. **Upload** — `POST http://localhost:3001/api/knowledge/ingest` (new endpoint on the **relay**, in `ellie-dev/src/api/knowledge.ts`)
   - Multipart form: `file`, `target_folder`, `proposal_id?` (optional, links to Ellie's proposal)
   - Authenticated via `x-bridge-key` header
2. **Validate** — check size (max 50 MB), check `canIngest(filename)` from `document-ingestion.ts`. Reject early with a clear error.
3. **Deduplication check** — compute `SHA-256` hash of the raw buffer. Check `uploads-archive/{target_folder}/.hashes.jsonl` (an append-only log) for an existing entry with the same hash AND same target folder. If duplicate, return early with `{ status: "duplicate", existing_path, existing_md_path }` and emit a chat message: "This file is already ingested at `{existing_md_path}`." Do NOT proceed with the rest of the pipeline. (Hash check is per-folder to allow the same file to live in multiple knowledge contexts intentionally.)
4. **Archive raw** — write the original buffer to `uploads-archive/{target_folder}/{filename}`. If a file with the same name already exists (different hash), append a numeric suffix (`{filename}-2.pdf`). Append the hash + filename + ingested_at to `.hashes.jsonl` in the same directory.
5. **Convert to MD** — call `ingestDocument(buffer, filename)` from `document-ingestion.ts` → returns `{ markdown, title, format, ... }`. For images, pass a `describeFn` that calls a vision model for caption.
6. **Build frontmatter** — assemble the YAML with source link, ingested_at, ingestion_id, source_hash.
7. **Write to River** — `POST /api/bridge/river/write` with `operation: "create"`, `path: "{target_folder}/{slug}.md"`, content. The QMD reindex fires asynchronously as a side effect.
8. **Plant Forest summary chunks** — call new helper `planIngestionSummary(markdown, title, target_folder)`:
   - **Scope resolution** — `riverFolderToScope(target_folder)` returns a per-folder Forest scope path: `2/river-ingest/{slug(target_folder)}`. The slug strips path separators (`research/quantum-computing` → `research-quantum-computing`). The scope is auto-created on first use via the bridge API. **This is critical** — Forest semantic search runs across a scope, so each top-level River folder gets its own scope to keep retrieval coherent.
   - **Chunking algorithm** (pseudocode):
     ```
     function chunkMarkdown(md: string, targetTokens = 500): string[]:
       paragraphs = split(md, /\n\n+/)
       chunks = []
       buffer = ""
       for p in paragraphs:
         if estimateTokens(buffer + p) > targetTokens AND buffer != "":
           chunks.push(buffer.trim())
           buffer = p
         else:
           buffer = buffer ? buffer + "\n\n" + p : p
         # If a single paragraph exceeds targetTokens, hard-split on sentences
         if estimateTokens(buffer) > targetTokens * 1.5:
           sentences = splitSentences(buffer)
           for s in sentences:
             if estimateTokens(currentSentenceChunk + s) > targetTokens:
               chunks.push(currentSentenceChunk.trim())
               currentSentenceChunk = s
             else:
               currentSentenceChunk += " " + s
           buffer = currentSentenceChunk
       if buffer.trim():
         chunks.push(buffer.trim())
       return chunks
     # estimateTokens(s) ≈ s.length / 4 (rough heuristic, no tokenizer dependency)
     ```
   - For long docs (>3 chunks), generate a top-level summary as an additional chunk via LLM call (Ellie or a small model). The summary chunk is written first (chunk_index 0) so it surfaces in semantic search.
   - Each chunk is written to Forest via `bridgeWrite` with `type: "fact"`, metadata `{ river_doc_path, chunk_index, ingestion_id, target_folder, source_hash }`
9. **Wait for QMD reindex ack** — before stage 10, wait for the QMD reindex to settle. The river bridge `write` endpoint already returns a `reindexed: true` flag. Hold for that signal (or a 2-second timeout) before stage 10 to avoid the race where the frontmatter update triggers a second reindex of stale content.
10. **Update frontmatter** — write `forest_chunks: N` back into the MD via `POST /api/bridge/river/write` with `operation: "update"` and a frontmatter-only patch. This triggers a second reindex, but the content is now stable.
11. **Notify** — emit WebSocket event `{ type: "ingest_complete", ingestion_id, river_path, forest_chunk_count, target_folder, file_name, source_hash }`
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
- **Per-folder Forest scopes** — each top-level River folder maps to its own Forest scope (`2/river-ingest/{folder_slug}`). This is necessary because Forest semantic search runs *across a scope*, so a flat dump would degrade retrieval coherence at volume. Per-folder scopes keep semantic neighborhoods clean. (Earlier draft used a flat scope with metadata tagging — Brian's review caught that this is incompatible with Forest's vector search model.)
- **Deduplication via SHA-256** — same file dropped twice is detected and skipped, with a clear chat message pointing to the existing version.

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

→ Response includes two surface actions: `propose_select_folder` with `path: "research/quantum-computing/papers/"` (auto-applied since it's navigation), then `highlight_drop_zone` with the same target (auto-applied — Zone B expands to its full size, primed and ready).

→ Zone B's headline updates to `⬆ INGEST INTO research/quantum-computing/papers/` and the zone is expanded.

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

### Phase 1A: Ellie Surface Panel + first mount on /knowledge (Tree tab awareness)

The foundation, built and validated together. Per Alan's review: separating "build the panel" from "mount it somewhere" creates a validation gap — you can't tell if the panel works in isolation. Build it AND wire it onto Tree tab in one phase.

- New component `app/components/ellie/EllieSurfacePanel.vue`
- Composes existing `useEllieChat()` (no new WebSocket)
- Right sidebar layout, collapsible, position toggle (right/bottom)
- Header with controls (mic, read mode, avatar, position toggle, collapse)
- Surface awareness banner (cyan strip)
- Chat scroll area (reuses message rendering)
- Input row with mic + send
- Props: `surfaceId`, `surfaceContext`, `onAction`
- Persists collapsed/position state per `surfaceId`
- **Surface-scoped thread auto-creation** — first mount on a surface auto-creates and selects a thread named `{surface_id}-{tab_or_default}` (e.g., `knowledge-tree`)
- Mount on `app/pages/knowledge.vue` as right sidebar
- Provide `surfaceContext` for Tree tab (current scope, scope tree summary, memory counts)
- Surface awareness banner updates as the user clicks around the Tree tab
- **No actions yet** — Ellie can answer questions about the visible state but has no surface tools wired up. This phase validates the panel + context wiring end to end.

**Acceptance:** Open `/knowledge`, see Ellie panel on the right, switch to Tree tab, click a scope, watch the surface awareness banner update. Ask Ellie "what's in this scope?" — she answers using the context (without yet being able to manipulate anything).

### Phase 1B: Surface context wiring (relay-side)

Teach the relay how to receive and use `surface_context`. (Phases 1A and 1B are tightly coupled — 1A's banner is meaningless without 1B's prompt injection. Build 1B in parallel with 1A; they ship together.)

- Extend the WebSocket message schema to accept `surface_context` field
- New "Surface Context" section in `prompt-builder.ts` (or layered prompt builder if `LAYERED_PROMPT=true`), priority 4
- Per-surface renderer registry (v1: only `knowledge-tree` renderer)
- Test: send a message with surface_context, verify Ellie's prompt includes it

**Acceptance:** Ellie can be told "you're on /knowledge → Tree → scope X" and her replies reflect that awareness.

### Phase 1C: Surface action tools + Proposal Preview Card (proposal pattern)

Add the proposal-style tools, the wire format, and the visual preview component.

- New tool group `surface_tools` registered when `surface_id === "knowledge"`
- Tools: `propose_create_folder`, `propose_move_folder`, `propose_select_folder`, `propose_switch_tab`, `highlight_drop_zone`
- Each mutating tool emits `surface_action` payload attached to response message metadata
- Wire into the `complete` flow so metadata travels with the message
- New component `ProposalPreviewCard.vue` per the visual spec above
- Card renders inline with chat messages when `surface_action` is present on a mutating tool
- Auto-applies for navigation tools (`propose_select_folder`, `propose_switch_tab`, `highlight_drop_zone`)
- Acceptance ack flows back to relay as `proposal_response` message
- Surface-scoped thread filtering ensures cards only render in the panel that originated the message

**Acceptance:** Ellie can say "I propose creating folder X" and the panel renders a clickable preview card. Accepting the card sends an ack back. Ellie can also auto-navigate (`propose_select_folder`) without an Accept button.

### Phase 2A: River tab — Two zones layout (manual)

Restructure the existing River tab into the two-zone layout with full manual workflows.

- Refactor to Zone A (top, ~60%) + Zone B (bottom, collapsible thin bar)
- Zone A: search box, selected folder header, folder contents grid, breadcrumb
- Search-as-command-bar logic (find / create / move from one input)
- Selected folder is shared state for the tab
- Manual folder navigation works (no Ellie involvement yet)
- Zone B: collapsible bar that expands on click/hover/file-drag, with drop zone + Choose Files button + path summary line (drop zone is inert in this phase)
- Surface context for River tab (folder, file_count, etc.)
- The River-tab variant of the surface-scoped thread (`knowledge-river`) is auto-created on first visit

**Acceptance:** River tab has the new two-zone layout, manual folder navigation works (including search-as-command-bar), Zone B expand/collapse works, surface context updates as the user clicks around. Drop zone is visible but inert.

### Phase 2B: Ingestion pipeline (the meat)

Wire up the actual conversion pipeline. Lives on the **relay**, not in `ellie-home`.

- New endpoint `POST http://localhost:3001/api/knowledge/ingest` in `ellie-dev/src/api/knowledge.ts`
- Authenticated via `x-bridge-key`
- Validates file (size, `canIngest()`)
- **SHA-256 deduplication check** against `uploads-archive/{folder}/.hashes.jsonl` — early-exits with a duplicate response if matched
- Archives raw to `uploads-archive/{folder}/{filename}` (configurable root via env var, defaults to `/home/ellie/uploads-archive`)
- Calls `ingestDocument()` directly (already in `ellie-dev`)
- Builds frontmatter (title, source, source_path, ingested_at, source_hash, ingestion_id)
- Writes MD via the existing `bridgeRiverWrite` helper (in-process, not HTTP)
- Splits MD into chunks via the chunking pseudocode in the pipeline section
- Resolves Forest scope via `riverFolderToScope(target_folder)` → `2/river-ingest/{folder_slug}`
- Plants each chunk in Forest via the in-process `bridgeWrite` helper
- For long docs (>3 chunks), generates an LLM summary chunk first
- Waits for QMD reindex ack (or 2-second timeout) before frontmatter update
- Updates MD frontmatter with `forest_chunks` count
- Emits WebSocket event `ingest_complete` to subscribed clients
- Multi-file with parallel processing (max 3 concurrent)
- Drop zone in Zone B becomes live (drag/drop and click-to-pick both work)
- Progress display in Zone B during upload (one row per file with status: queued/uploading/converting/planting/done/failed)
- New files appear in Zone A with NEW badge
- Workshop card in Ellie panel showing the ingestion record (durable history)

**Acceptance:** Drop a PDF into Zone B → archive raw → MD appears in River → Forest chunks in `2/river-ingest/{folder_slug}` → ask Ellie about its content via normal chat, she finds the chunk via Layer 3 retrieval. Drop the same PDF again → deduplication catches it, no duplicate work.

### Phase 2C: Ellie's River agency (proposals on River tab)

Make Ellie active on the River tab — she can propose structure changes, the panel previews them, the user accepts.

- Action handlers for River tab: `propose_create_folder`, `propose_move_folder`, `propose_select_folder`, `highlight_drop_zone`
- `ProposalPreviewCard.vue` from Phase 1C is now wired into the River-tab flow
- Ellie's prompt includes the surface tools when `surface_id === "knowledge"` and `tab === "river"`
- Surface-context renderer for River tab includes folder selection, file list, file counts, and recent ingestion state
- Test conversational flows end-to-end:
  - "I want to load research papers about quantum" → Ellie proposes folders → user accepts → `highlight_drop_zone` auto-fires → user drops PDFs → conversion happens → Ellie acknowledges in chat with content awareness

**Acceptance:** Full conversational ingestion flow works — describe to Ellie, she proposes structure, you accept, you drop files, everything lands in the right place, and Ellie can answer questions about what she just helped you load.

### Phase 3 (future, separate specs)

- **Cleanup/reconcile job** for orphaned Forest chunks (see "Cleanup & Delete" section above) — needs Plane ticket created NOW
- Ellie panel on more surfaces — Tree mutations, Graph, Canvas
- **Big Rock 2** — Supabase message → Forest categorization with learned rules (off-cycle background work + morning review surface for unknowns)
- Ingestion of URLs (paste a URL, scrape and convert)
- Content-based Forest scope refinement at ingestion time (smarter than per-folder)
- Cross-thread context sharing on the panel

---

## Cleanup & Delete (deferred, ticket required)

A user who deletes a River MD file (via Obsidian, file manager, or a future delete UI) will leave orphaned Forest chunks pointing to a no-longer-existing path. This is a known gap and **not in scope for v1**, but it must be tracked:

- **The orphan problem:** Forest chunks have `metadata.river_doc_path`. If the doc disappears, the chunks still surface in Ellie's semantic search and reference a dead path.
- **The raw archive problem:** The PDF in `uploads-archive/` is preserved by design (you might want it back), but if the MD is gone, the archive entry is orphaned too.
- **v1 acceptance:** users are expected NOT to delete ingested files manually. If they do, retrieval may surface stale results until manual cleanup.
- **v2 plan:** a daily reconciliation job (`reconcile-river-ingest`) walks the Forest `2/river-ingest/*` scopes, checks each chunk's `river_doc_path` for existence, and either marks chunks as orphaned (excluded from retrieval) or deletes them. The same job sweeps `uploads-archive/.hashes.jsonl` for archive entries with no surviving MD.
- **Action:** create Plane ticket for v2 reconciliation work before this spec ships. Tagged for the next sprint after v1 stabilizes.

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
