# Orchestrator Observability — Design Spec

**Tickets:** ELLIE-1131, ELLIE-1132, ELLIE-1133
**Date:** 2026-03-29
**Status:** Draft

## Problem

The coordinator dispatches to specialist agents without passing skill context, routing decisions are invisible, and there's no way to review what Ellie did in a session or why. The most painful symptom: agents keep reaching for Google Calendar instead of using the UMS skill, and there's no way to see why or prevent it declaratively.

## Architecture: Three-Layer Model

The system separates concerns into three distinct layers:

### Layer 1: Agent (Role/Job)

Defines **what work needs doing**. Has responsibilities, goals, a seat at the team. Does not know about tools or skills. Examples: "dev agent," "finance agent," "research agent."

- Lives in: `agents` table (Supabase)
- Key fields: name, role description, model, status
- New field: `creature_id` (FK) — which creature is assigned to this role

### Layer 2: Creature (Worker)

The entity that **does the work**. Carries a toolbox. Assigned to an agent role. Different creatures of the same archetype can have different toolboxes. Each creature is an individual instance — no shared state between creatures assigned to different agents.

- Lives in: Forest DB (entities/creatures)
- Identified by: archetype (dev, research, finance, etc.) + individual entity ID

### Layer 3: Skills (Toolbox)

The tools in the creature's toolbox. Managed independently of job definitions. Skills are added to or removed from a creature's toolbox without touching the agent layer.

- Lives in: new `creature_skills` table (Forest DB)
- Each row: creature_id + skill_name

### How the Layers Interact

```
Agent (role)  ──references──>  Creature (worker)  ──owns──>  Skills (toolbox)
   Brian           →              arch-001            →      [ums-calendar, github, plane]
   James           →              ant-003             →      [forest, memory]
   Sarah           →              bee-007             →      [ums-calendar, finance-tools]
```

**Guardrail:** No API or UI path assigns skills directly to an agent. Skills only go on creatures. If an agent needs different tools, swap its creature or update the creature's toolbox.

## Schema Changes

### New Table: `creature_skills` (Forest DB)

```sql
CREATE TABLE creature_skills (
  creature_id UUID NOT NULL REFERENCES entities(id),
  skill_name TEXT NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  added_by TEXT NOT NULL DEFAULT 'manual',  -- 'manual', 'archetype_default', 'migration'
  PRIMARY KEY (creature_id, skill_name)
);
```

### New Table: `archetype_default_skills` (Forest DB)

Reference table — defines what a fresh creature of a given archetype gets. Used for bootstrapping, not at runtime.

```sql
CREATE TABLE archetype_default_skills (
  archetype TEXT NOT NULL,    -- 'dev', 'research', 'finance', etc.
  skill_name TEXT NOT NULL,
  PRIMARY KEY (archetype, skill_name)
);
```

### New Table: `routing_decisions` (Supabase)

```sql
CREATE TABLE routing_decisions (
  id TEXT PRIMARY KEY,                    -- unique decision ID
  session_id UUID,                        -- links to broader session
  dispatch_envelope_id TEXT,              -- FK to dispatch envelope
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_message TEXT,                      -- truncated input that triggered routing
  agents_considered TEXT[],               -- agent names evaluated
  agent_chosen TEXT NOT NULL,             -- which agent was picked
  confidence NUMERIC(3,2) NOT NULL,       -- 0.00–1.00
  match_type TEXT NOT NULL,               -- slash_command, skill_trigger, smart_regex, llm_classifier, session_continuity
  reasoning TEXT NOT NULL,                -- one-line: "calendar query matched ums-calendar skill on dev agent"
  skills_loaded TEXT[]                    -- skills injected into the specialist prompt
);
```

### Modified: `agents` Table (Supabase)

- Add `creature_id UUID` — logical reference to the creature in Forest DB (not an enforced FK since it crosses databases). Resolved at runtime via the Forest library.
- Deprecate `tools_enabled` — skill ownership moves to creature. Keep temporarily for migration, remove after cutover.

## Coordinator Dispatch Flow (Changed)

The prompt builder already handles skill injection via `getSkillSnapshot(allowedSkills, message)`. The coordinator does not build prompts itself.

**Current flow:**
1. Coordinator picks agent based on role/job match
2. `allowedSkills` read from agent's `tools_enabled` field
3. Prompt builder injects skill context

**New flow:**
1. Coordinator picks agent based on role/job match
2. Look up agent's `creature_id`
3. Query `creature_skills` for that creature's skill list
4. Pass skill list as `allowedSkills` to existing prompt builder
5. Prompt builder injects skill context (unchanged)
6. Log routing decision to `routing_decisions` table

This is a **data source swap**, not a prompt builder rewrite. The existing `getSkillSnapshot()` machinery stays the same.

## Routing Transparency (ELLIE-1132)

### What Gets Captured

Every routing decision produces one row in `routing_decisions`:

| Field | Source |
|-------|--------|
| `agents_considered` | Intent classifier evaluates candidates |
| `agent_chosen` | Final routing decision |
| `confidence` | Classifier confidence score (0.0–1.0) |
| `match_type` | How it was routed: slash_command, skill_trigger, smart_regex, llm_classifier, session_continuity |
| `reasoning` | One-line summary of why |
| `skills_loaded` | Skills injected into the specialist prompt for this dispatch |

### Reasoning Generation by Match Type

- **slash_command:** `"Explicit /dev command — direct route"`
- **skill_trigger:** `"Trigger 'schedule' matched ums-calendar skill on general agent"`
- **smart_regex:** `"Pattern match: calendar query → general agent"`
- **llm_classifier:** Extract reasoning from classifier response
- **session_continuity:** `"Continuing active session with dev agent (confidence override: 0.85)"`

### Integration Point

Append-only logging layer inserted **after** routing decision, **before** dispatch executes. Fire-and-forget — logging failures do not block dispatch.

## Dashboard: Agents Page — Skills Tab (ELLIE-1133 Part 1)

### Changes to Existing Agents Page

**Agent header:** Add creature badge alongside the role badge. Example: `Brian` `dev` `arch creature`

**New "Skills" tab** between Context Layers and Prompts:

- **Creature Toolbox section:** Shows all skills in the creature's toolbox as chips. Each chip shows:
  - Skill name
  - Mode: `always-on` or `on trigger`
  - One-line description (from SKILL.md)
- **Skill detail cards:** Expandable list below the chips. Each card shows name, description, trigger words, and requirements.
- **Guardrail footer:** "Skills are managed on the creature. To change this agent's skills, update the [creature name] creature's toolbox or assign a different creature."

**No add/remove skill buttons on this page.** Skills are read-only here — managed at the creature level. This enforces the three-layer model.

## Dashboard: Orchestrator Session Replay (ELLIE-1133 Part 2)

### New Page: `/orchestrator`

Session replay timeline — "game tape" for reviewing everything Ellie did.

### Session Selector

Top bar with session metadata: date/time range, duration, dispatch count, total cost. Previous/Next navigation to browse sessions.

### Timeline View

Vertical timeline with one card per routing decision. Each card shows:

- **Timestamp**
- **User message** (truncated)
- **Confidence badge** — color-coded:
  - Green (0.7+): solid match
  - Orange (<0.7): weak match, card gets highlighted border
- **Match type badge** — slash_command, skill_trigger, llm_classifier, etc.
- **Routing outcome** — agent chosen + agent name
- **Skills loaded** — which skills were injected for this dispatch
- **Reasoning** — one-line explanation

**Visual scanning rule:** Orange = problem. You scan the timeline for orange entries to find weak routing decisions.

### Session Summary Footer

Persistent footer showing: dispatch count, agents used, low-confidence count, total cost, session duration.

### Data Source

Reads from `routing_decisions` table, joined with `dispatch_envelopes` for cost/token data. Sessions grouped by session_id.

## Build Order

Skills-first (bottom up) — each layer validates the one below it:

1. **Agent-Skill binding** (ELLIE-1131) — schema changes, creature_skills table, coordinator data source swap
2. **Agents page Skills tab** (ELLIE-1133 part 1) — creature badge, skills tab, API endpoint
3. **Routing capture** (ELLIE-1132) — routing_decisions table, logging layer in intent classifier
4. **Orchestrator replay** (ELLIE-1133 part 2) — new /orchestrator page, timeline view, session summary

## Migration Strategy

1. Create new tables (`creature_skills`, `archetype_default_skills`, `routing_decisions`)
2. Populate `archetype_default_skills` with sensible defaults per archetype
3. For each existing agent: create creature entity in Forest if not exists, populate `creature_skills` from agent's current `tools_enabled`
4. Add `creature_id` to agents table, link to creature entities
5. Swap coordinator's skill resolution from `tools_enabled` to creature lookup
6. Verify all agents dispatch with correct skills
7. Deprecate `tools_enabled` (leave column, stop reading it)

## What This Does NOT Cover

- Creature management UI (creating, editing creatures and their toolboxes) — separate ticket
- Foundation team composition — which agents belong to which foundation
- Real-time routing intervention — the replay is retrospective, not live control
- Cost attribution per skill or per tool — total cost tracked, not broken down
