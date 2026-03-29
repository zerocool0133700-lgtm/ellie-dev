# Agent System — Design Spec

**Date:** 2026-03-29
**Status:** Approved
**Author:** Dave + Claude Opus 4.6
**Scope:** Agent Detail View (full config visibility + prompt history) and Agent Creator (full lifecycle)

---

## Problem Statement

The agents page shows basic config (status, model, tools) but doesn't reveal how an agent is actually wired — the prompt assembly layers, creature DNA, skill eligibility, or what context gets injected. When something goes wrong ("why did James respond that way?"), there's no way to see the actual prompt that was sent. And creating new agents requires manual Supabase inserts + Obsidian file creation + foundation updates — no UI workflow exists.

## Design Decisions

**Agent Detail View:** Restructure the agents page from 3 tabs (Config, Profile, Performance) to 5 tabs (Overview, Context Layers, Prompt History, Config, Performance). The Context Layers tab shows every prompt assembly layer in priority order with content and token counts. The Prompt History tab stores and displays the last 5 full assembled prompts per agent for debugging.

**Agent Creator:** A 4-step wizard (Identity → Creature → Tools & Skills → Foundation Assignment) that creates the agent across all four systems: Supabase (record), Forest (wiring branch), Foundation (roster), and dashboard (display map).

**Prompt Storage:** New relay endpoint and Supabase table to persist assembled prompts. Auto-expire after 24 hours, max 20 per agent. Stored after `buildPrompt` completes, before Claude dispatch.

---

## Agent Detail View

### Tab Structure

| Tab | Purpose | Data Source | Editable? |
|-----|---------|-------------|-----------|
| **Overview** | Identity at a glance | Supabase agents + Forest wiring | No |
| **Context Layers** | How the prompt is assembled | Forest (soul, creature, role) + relay (section priorities, skills) | No (view-only) |
| **Prompt History** | Last 5 full prompts sent to this agent | New `agent_prompts` Supabase table | No (read-only debug) |
| **Config** | Editable agent settings | Supabase agents + Forest wiring | Yes |
| **Performance** | Session stats | Supabase agent_sessions | No |

### Overview Tab

Displays:
- Agent name + persona name (e.g., "james / James")
- Species icon + creature type (e.g., 🐜 ant)
- Role (developer)
- Current model (claude-sonnet-4-6)
- Status badge (active/inactive/maintenance)
- Foundations this agent belongs to (software-dev, life-management)
- Capabilities list
- Last dispatch: time, channel, work item
- Cognitive style from metadata (e.g., "depth-first, single-threaded, methodical verification")

### Context Layers Tab

Shows every layer that gets assembled into the agent's prompt, in priority order. Each layer is an expandable card showing:

1. **Soul** (priority 1) — The core identity document from River vault. Shows content preview, token count.
2. **Creature DNA** (priority 2) — Behavioral profile (squirrel/ant/owl/bee). Cognitive style, token budget, allowed skills.
3. **Role Template** (priority 3) — Agent-specific instructions from River (e.g., `dev-agent-template`). Shows the full template text.
4. **Archetype Context** (priority 4) — Structured persona context from Forest.
5. **Skills Snapshot** (priority 5) — Which skills are eligible and loaded for this agent. Shows skill names with triggers.
6. **Working Memory** (priority 6) — The 7-section working memory template. Shows which sections are typically populated.
7. **Context Sources** (priority 7+) — Dynamic sources injected per-request: recent messages, context docket, forest awareness, calendar, Gmail, Outlook, work items, etc. Shows which sources are enabled and their typical token usage.

Each card shows:
- Layer name + priority number
- Token budget allocation
- Content preview (first 200 chars)
- Expand to see full content
- "Not configured" state if the layer is missing

Data source: Relay API endpoint that returns the agent's wiring from Forest + the section priority config from creature profile.

### Prompt History Tab

Lists the last 5 (up to 20) full assembled prompts sent to this agent.

Each entry shows:
- Timestamp (relative + absolute)
- Channel (telegram/ellie-chat/google-chat)
- Work item ID (if applicable)
- Token count
- Estimated cost
- Click to expand: full prompt text in a scrollable monospace viewer

**Storage:** New `agent_prompt_history` table in Supabase:

```sql
CREATE TABLE agent_prompt_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name TEXT NOT NULL,
  channel TEXT NOT NULL,
  work_item_id TEXT,
  prompt_text TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  cost_estimate_usd NUMERIC(10, 4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_prompt_history_agent ON agent_prompt_history (agent_name, created_at DESC);
```

**Capture point:** After `buildPrompt()` returns in the relay handlers (ellie-chat-handler.ts, telegram-handlers.ts), store the prompt before passing it to Claude. Fire-and-forget insert, non-blocking.

**Retention:** Cron or on-insert trigger deletes entries older than 24 hours. Max 20 per agent (delete oldest when exceeded).

**API:** `GET /api/agents/:name/prompts` — returns last N prompt history entries (without full text by default, with `?full=true` for expanded view).

### Config Tab (Enhanced)

Merges the existing Config and Profile tabs:

- **Status** — dropdown (active/inactive/maintenance)
- **Model** — dropdown grouped by provider
- **System Prompt** — textarea (the custom system prompt, separate from the assembled prompt)
- **Creature Wiring** — creature type selector + section priorities editor
- **Tools** — checkboxes grouped by category (file ops, search, Google, GitHub, Plane, bash, database, messaging, finance, visualization). Shows the MCP tool patterns that each category maps to.
- **Capabilities** — tag input for capability strings
- **Skills** — checklist of eligible skills from the skill registry

Save button with dirty detection (existing behavior, enhanced).

### Performance Tab

Keep existing: total sessions, success rate, avg response time. No changes needed.

---

## Agent Creator

### Entry Point

"Create Agent" button on the agents page header. Opens a full-page wizard overlay (or a new route `/agents/create`).

### Step 1: Identity

Fields:
- **Agent name** (text, lowercase, no spaces — this is the system key, e.g., "scheduler")
- **Persona name** (text — display name, e.g., "Sophie")
- **Role** (text — one-word role descriptor, e.g., "calendar-management")
- **Display color** (color picker — hex color for avatar and UI elements)
- **Description** (textarea — what this agent does)
- **Model** (dropdown — from `/api/models`)

Validation: name must be unique (check against existing agents), lowercase alphanumeric + hyphens only.

### Step 2: Creature Type

Choose from existing creature archetypes:

| Creature | Cognitive Style | Best For |
|----------|----------------|----------|
| 🐿️ Squirrel | Breadth-first, context-aware | Coordination, research, strategy |
| 🐜 Ant | Depth-first, single-threaded | Implementation, focused work |
| 🦉 Owl | Detail-oriented, systematic | Review, QA, analysis |
| 🐝 Bee | Specialized, task-focused | Single-purpose agents |

Each choice shows a preview of:
- Default token budget
- Default section priorities
- Cognitive style description

Option to create a **custom creature** with manual settings for token budget and section priorities.

### Step 3: Tools & Skills

**Tools** — checkboxes grouped by category:

| Group | Categories |
|-------|-----------|
| File Operations | read, write, edit, glob, grep |
| Search | brave_search, brave_web_search, web_search |
| Google Workspace | google_workspace (Gmail, Calendar, Drive, Docs) |
| GitHub | github_mcp, git |
| Plane | plane_mcp, plane_lookup |
| Bash | bash_builds, bash_tests, bash_systemctl, bash_journalctl, bash_process_mgmt |
| Database | supabase_mcp, psql_forest |
| Messaging | telegram, google_chat |
| Knowledge | forest_bridge, forest_bridge_read, forest_bridge_write, qmd_search, memory_extraction |
| Email | agentmail |
| Visualization | miro, excalidraw |
| Analysis | sequential_thinking |
| Finance | transaction_import, receipt_parsing |
| Routing | agent_router |

Each category shows a tooltip with the MCP tools it maps to (e.g., "plane_mcp → mcp__plane__*").

**Skills** — checklist from the skill registry (`skills/*/SKILL.md`). Shows skill name, description, and whether it requires env vars. Disabled skills show what's missing.

### Step 4: Foundation Assignment

- List of all foundations from Supabase
- Checkbox to add agent to each foundation
- For each selected foundation, the agent's position in the roster is previewed
- At least one foundation must be selected

### Create Action

When the user clicks "Create Agent":

1. **Validate** — check name uniqueness, required fields
2. **Supabase** — INSERT into `agents` table with name, type, status: "active", capabilities, tools_enabled, metadata (species, cognitive_style, description, persona_name)
3. **Forest** — Create wiring branch in Agent Profiles tree:
   - Path: `agents/{agent-name}`
   - Content: YAML frontmatter (creature, role, token_budget, section_priorities) + markdown instructions
4. **Foundation** — UPDATE `foundations.agents` JSONB for each selected foundation — append new AgentDef
5. **Coordinator fallback** — Update the hardcoded `AGENT_TOOLS` map in `coordinator.ts` (or better: remove the hardcoded map and always use the registry)
6. **Display map** — The `useAgentProfiles` composable already fetches from `/api/agents` so new agents appear automatically on next fetch

**Error handling:** If any step fails, show the error but don't roll back previous steps (partial creation is recoverable). Show which steps succeeded and which failed.

---

## API Endpoints

### New Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `GET /api/agents/:name/context-layers` | GET | Returns the agent's prompt assembly layers with content and token counts |
| `GET /api/agents/:name/prompts` | GET | Returns prompt history entries (meta only, `?full=true` for text) |
| `POST /api/agents` | POST | Create a new agent (Supabase + Forest + Foundation) |
| `POST /api/agents/:name/prompts` | POST | Store a prompt snapshot (called by relay after buildPrompt) |

### Existing Endpoints (No Changes)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `GET /api/agents` | GET | List all agents with session stats |
| `GET /api/agents/:name` | GET | Full agent detail |
| `PATCH /api/agents/:name` | PATCH | Update agent config |

---

## Data Flow

### Prompt History Capture

```
User message → routeAndDispatch → buildPrompt → enrichedPrompt
                                                    ↓
                                            Store to agent_prompt_history (fire-and-forget)
                                                    ↓
                                            callClaude(enrichedPrompt)
```

The capture happens in the relay handlers (telegram-handlers.ts, ellie-chat-handler.ts, http-routes.ts) right after `buildPrompt` returns. For coordinator mode, the coordinator doesn't use `buildPrompt` (it builds its own lean prompt), so specialist prompts are captured when `callSpecialist` is called.

### Agent Creation

```
Wizard Step 1-4 → POST /api/agents
                        ↓
                  Supabase INSERT (agents table)
                        ↓
                  Forest API (create wiring branch)
                        ↓
                  Supabase UPDATE (foundations.agents JSONB)
                        ↓
                  Return success + agent ID
```

---

## Dashboard Changes

### Files

| File | Action | What Changes |
|------|--------|-------------|
| `app/pages/agents/index.vue` | Modify | Restructure to 5 tabs, add Overview + Context Layers + Prompt History |
| `app/pages/agents/create.vue` | Create | 4-step wizard for agent creation |
| `app/composables/useAgentData.ts` | Create | Composable for agent detail data fetching (layers, prompts, etc.) |
| `app/components/ellie/ContextLayerCard.vue` | Create | Expandable card for a single context layer |
| `app/components/ellie/PromptViewer.vue` | Create | Scrollable monospace viewer for full prompt text |
| `app/components/ellie/CreatureSelector.vue` | Create | Creature type picker with previews |
| `app/components/ellie/ToolCategoryPicker.vue` | Create | Grouped checkbox picker for tool categories |

### Relay Changes

| File | Action | What Changes |
|------|--------|-------------|
| `src/api/agent-prompts.ts` | Create | API for storing and retrieving prompt history |
| `src/api/agent-context-layers.ts` | Create | API for returning agent's prompt assembly layers |
| `src/api/agent-create.ts` | Create | API for full agent creation (Supabase + Forest + Foundation) |
| `src/http-routes.ts` | Modify | Register new API routes |
| `src/telegram-handlers.ts` | Modify | Add prompt capture after buildPrompt |
| `src/ellie-chat-handler.ts` | Modify | Add prompt capture after buildPrompt |
| `migrations/supabase/20260329_agent_prompt_history.sql` | Create | Schema for prompt history table |

---

## Styling

Follow existing dashboard dark theme:
- Background: gray-950, panels: gray-900/gray-800
- Agent colors from `useAgentProfiles` AGENT_DISPLAY map
- Tailwind v4 utility classes only (no @apply in SFCs)
- Wizard steps: numbered circles with connecting lines, active step highlighted
- Context layer cards: expandable with smooth transitions
- Prompt viewer: monospace, dark background, syntax-highlighted if possible

---

## Testing Strategy

### API Tests
- Agent creation endpoint: validates name uniqueness, creates across all systems
- Prompt history: stores and retrieves, respects retention limits
- Context layers: returns correct layer structure for known agents

### UI Tests
- Wizard validation: required fields, name format, uniqueness check
- Tab switching in agent detail
- Prompt history expansion/collapse
- Context layer card expand/collapse

---

## Open Questions

1. **Prompt text size:** Full prompts can be 50K+ tokens (~200KB text). Storing 20 per agent × 8 agents = 32MB. Acceptable for Supabase? Recommendation: yes, with auto-expiry. Could compress if needed.

2. **Context layers live vs. cached:** Should the Context Layers tab show the current layer config (from Forest/creature profile) or the layers as they were actually assembled in the last prompt? Recommendation: current config (live), with Prompt History showing what was actually sent.

3. **Custom creatures:** How much customization for custom creature types? Recommendation: start with just token budget and section priorities. Add cognitive style and skill allowlist editing later.
