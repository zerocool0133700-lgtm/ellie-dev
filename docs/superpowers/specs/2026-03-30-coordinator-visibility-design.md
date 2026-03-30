# Coordinator Visibility — Design Spec

**Tickets:** ELLIE-1141
**Date:** 2026-03-30
**Status:** Draft

## Problem

When Ellie orchestrates multi-agent work, nobody can see what's happening. Dave loses track of what he asked Ellie to do. Ellie loses track of what she dispatched because her conversation history gets compacted. Agent questions and tool approvals get buried in ellie-chat. There's no persistent, shared view of orchestration state.

## Solution

Use GTD as the single source of truth for all orchestration state. Ellie creates parent GTD items for orchestration requests and sub-items for each agent dispatch. A Chrome extension side panel provides persistent visibility across all Ellie Home pages — showing dispatch trees, agent questions, and tool approvals in one surface.

## Architecture Overview

**GTD is the nervous system.** Every dispatch, every agent question, every status change is a GTD item. Ellie reads GTD to know what's in flight. Dave reads GTD (via the side panel) to see what needs attention.

**Four components:**

1. **GTD schema updates** — `parent_id` and `created_by` columns enable hierarchical orchestration tracking
2. **GTD skill update** — teaches Ellie how to use GTD for orchestration: create parent items, sub-items for dispatches, route questions back to Dave
3. **Dispatches page** (`/dispatches`) — dashboard page showing the active orchestration tree with color-coded status
4. **Chrome extension** — side panel that loads `/dispatches` plus tool approvals, always visible on Ellie Home

## Component 1: GTD Schema Updates

### Modified Table: `todos` (Supabase)

Add two columns:

```sql
ALTER TABLE todos ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES todos(id);
ALTER TABLE todos ADD COLUMN IF NOT EXISTS created_by TEXT;

CREATE INDEX idx_todos_parent ON todos(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX idx_todos_created_by ON todos(created_by) WHERE created_by IS NOT NULL;
```

- `parent_id` — links sub-items to their parent. Ellie's orchestration item is the parent; agent dispatches are children. Agent questions back to Dave are grandchildren.
- `created_by` — who created this item: `dave`, `ellie`, `brian`, `james`, etc. Separate from `assigned_to` (who's doing it) and `assigned_agent` (which agent type).

No other schema changes. The existing `status`, `assigned_agent`, `assigned_to`, `content`, `source_ref` fields handle everything else.

### Orchestration Item Hierarchy

```
Parent: "Review + test ELLIE-1124"
  assigned_to: ellie, created_by: dave, status: open
  │
  ├─ Child: "Critique ELLIE-1124 architecture"
  │    assigned_agent: critic, assigned_to: brian, created_by: ellie, parent_id: ^
  │    status: open → waiting_for (when question asked) → done
  │    │
  │    └─ Grandchild: "Should auth module be in scope?"
  │         assigned_to: dave, created_by: brian, parent_id: ^
  │         status: open → done (when Dave answers)
  │
  └─ Child: "Write tests for ELLIE-1124"
       assigned_agent: dev, assigned_to: james, created_by: ellie, parent_id: ^
       status: open → done
```

When all children are done, the parent item can be completed and Ellie synthesizes the results.

## Component 2: GTD Skill Update

### Updated Skill: `skills/gtd/SKILL.md`

The GTD skill needs new orchestration instructions added. Ellie already knows how to use GTD for personal task management. The update teaches her the orchestration pattern:

**New sections to add:**

#### Orchestration Pattern

When coordinating multi-agent work:

1. **Create a parent item** for the overall request:
   - `POST /api/gtd/items` with `content`, `assigned_to: "ellie"`, `created_by: "ellie"`, `source_ref: "ELLIE-XXX"` if ticket-linked
   - This is your tracking anchor — all dispatches link back to it

2. **Create sub-items** for each agent dispatch:
   - `POST /api/gtd/items` with `parent_id: {parent}`, `assigned_agent: "dev"`, `assigned_to: "james"`, `created_by: "ellie"`
   - Content should describe the specific task for that agent

3. **When an agent has a question for Dave:**
   - Create a sub-item under the agent's item: `parent_id: {agent_item}`, `assigned_to: "dave"`, `created_by: {agent_name}`
   - Content is the question
   - Use `update_user` to narrate: "Brian has a question about scope — check the dispatch panel"

4. **When Dave answers:**
   - Mark the question item as done
   - Resume the agent's work with the answer
   - Update the agent's item status back to open/working

5. **Track completion:**
   - When an agent completes, mark its sub-item as done
   - When all sub-items are done, mark the parent as done
   - Synthesize results and respond to Dave

6. **Recovery after compaction:**
   - Read your active GTD items: `GET /api/gtd/items?assigned_to=ellie&status=open`
   - For each parent item, read its children to see what's in flight
   - This is your source of truth — not the conversation history

#### Narration Pattern

When orchestrating, proactively narrate key moments via `update_user`:
- "I'm dispatching Brian for the architecture critique and James for the tests."
- "Brian has a question for you — check the dispatch panel."
- "James is done with the tests. Still waiting on Brian."
- "All agents are done. Here's the synthesis..."

### Coordinator Changes

The coordinator needs to use GTD for dispatch tracking instead of relying on conversation history:

1. **Before dispatch:** Create the parent GTD item (if first dispatch) and the sub-item for the agent
2. **After dispatch completes:** Update the sub-item status
3. **On compaction:** Read active GTD items to rebuild awareness. The working memory `task_stack` section should reflect the active GTD tree.
4. **On ask_user:** Create a sub-item assigned to Dave, narrate via update_user

This replaces the current pattern where dispatch state only lives in the Messages API conversation.

## Component 3: Dispatches Page (`/dispatches`)

### New Dashboard Page

A page at `/dispatches` showing the active orchestration tree. This page is also what the Chrome extension loads in its side panel.

### Layout

**Header:** "Dispatches" title + badge counts (active, waiting on you)

**Orchestration tree:** For each active parent item (Ellie's orchestration items):
- Parent item: title, status, time elapsed
- Children indented below with color-coded left borders:
  - **Green** — Ellie orchestrating (parent items)
  - **Blue** — agent working
  - **Orange** — needs Dave's input (question or approval)
  - **Green checkmark** — done
- Grandchildren (Dave questions) show inline with an answer input box
- Completed items fade to lower opacity

**Tool Approvals Section:** Below the orchestration tree, show pending tool approvals:
- Tool name, agent requesting, description
- Approve / Deny buttons
- Same orange color as "needs your input"

**Completed section:** Collapsed by default, shows recently completed orchestration trees

### Data Sources

- **GTD items:** `GET /api/gtd/items?status=open` filtered to items where `created_by` is an agent or `assigned_to` is an agent
- **Tool approvals:** from the relay's pending actions API (already exists for ellie-chat)
- Auto-refresh: poll every 5 seconds for updates

### API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `GET /api/dispatches/active` | GET | Active orchestration trees (parent + children) |
| `GET /api/dispatches/approvals` | GET | Pending tool approvals |
| `POST /api/dispatches/answer` | POST | Submit Dave's answer to an agent question |
| `POST /api/dispatches/approve` | POST | Approve a tool action |
| `POST /api/dispatches/deny` | POST | Deny a tool action |

### Answer Flow

When Dave types an answer in the dispatch panel:
1. `POST /api/dispatches/answer` with `{ question_item_id, answer_text }`
2. Backend marks the question GTD item as done with the answer in metadata
3. Backend sends the answer to ellie-chat as a synthetic user message: `[Answer to {agent}'s question: "{answer_text}"]` — this re-enters the coordinator loop so Ellie can route the answer back to the waiting agent
4. The parent agent item status updates back to open/working automatically when Ellie re-dispatches

## Component 4: Chrome Extension Side Panel

### Extension Structure

A Chrome Manifest V3 extension with a side panel:

- **manifest.json** — declares side panel, permissions (for Ellie Home domain only)
- **sidepanel.html** — loads `/dispatches` page from `dashboard.ellie-labs.dev` in an iframe
- **background.js** — polls for badge count updates (active items needing attention)
- **Icon badge** — shows count of items needing Dave's input (questions + approvals). Orange badge when > 0.

### Side Panel Behavior

- Opens as a persistent side panel on the right side of the browser
- Only activates on `dashboard.ellie-labs.dev` domain
- Loads the `/dispatches` page which handles all rendering and interaction
- Badge on the extension icon updates every 10 seconds with the count of items needing attention

### Why an iframe

The `/dispatches` page is a full Nuxt page. The extension just frames it. This means:
- One codebase for the dispatch view (not duplicated in the extension)
- Updates to `/dispatches` automatically appear in the extension
- The extension is a thin shell — ~50 lines of code

## Build Order

1. **GTD schema** — add `parent_id`, `created_by` columns
2. **GTD orchestration API** — endpoints for dispatch trees, answers, approvals
3. **GTD skill update** — orchestration pattern + narration instructions
4. **Coordinator integration** — create GTD items on dispatch, read on compaction
5. **Dispatches page** — `/dispatches` with tree view + approvals
6. **Chrome extension** — side panel shell + badge count

## What This Does NOT Cover

- Historical orchestration replay (use the existing `/orchestrator` session replay for that)
- Automated retry of failed dispatches (manual re-dispatch via Ellie)
- Mobile notification for "waiting on you" items (Chrome extension is desktop only)
- GTD weekly review changes (the orchestration items are transient — they complete and move to done)
- Agent-to-agent communication without going through Ellie (all orchestration flows through GTD via Ellie)
