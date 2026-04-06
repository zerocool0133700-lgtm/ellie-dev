# GTD Operations Manual — Agent Guide

> Lessons learned from building the 7 Foundational Documents project.
> This manual applies to ALL agents using the GTD system.

**What is this system?**
This is a **GTD-inspired** task management system adapted for multi-agent orchestration. It borrows core GTD concepts (inbox, next actions, contexts, waiting-for, projects) but is **not pure GTD** — it's tailored for AI agents coordinating work across Telegram, dashboard, and work sessions.

**Important exclusion:**
The **GTD 2-minute rule** (if it takes less than 2 minutes, do it now) is **not enforced** by this system. Agents decide whether to execute tasks immediately or defer them based on context, workload, and user preference — not by a fixed time threshold.

---

## System Architecture

**Database:** Supabase `todos` and `todo_projects` tables
**API:** `http://localhost:3001/api/gtd/*` (relay server)
**Agent types:** `general`, `dev`, `research`, `content`, `critic`, `strategy`, `ops`
**Display names:** general=Ellie, dev=James, research=Kate, content=Amy, critic=Brian, strategy=Alan, ops=Jason

## Core Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/gtd/inbox` | POST | Capture new items to inbox |
| `/api/gtd/next-actions` | GET | List open tasks (supports `?agent=TYPE` filter) |
| `/api/gtd/todos/:id` | PATCH | Update task (status, priority, content, etc.) |
| `/api/gtd/summary` | GET | Quick state snapshot |
| `/api/gtd/team` | GET | Team-wide workload overview |
| `/api/gtd/delegate` | POST | Delegate task to another agent |
| `/api/gtd/delegate/complete` | POST | Complete delegated task |
| `/api/gtd/contexts` | GET | List available context tags |
| `/api/gtd/waiting-for` | POST | Auto-create waiting-for task (ELLIE-918) |

## Task Lifecycle

### 1. Creation
```bash
POST /api/gtd/inbox
{
  "content": "Task description",
  "priority": "high" | "medium" | "low" | null,
  "tags": ["@context-tag"],          // Legacy format, still supported
  "context": "deep-work",             // New: Context name (replaces @ tags)
  "effort": "quick" | "medium" | "deep", // Auto-classified if omitted (ELLIE-917)
  "scheduled_at": "2026-03-20T10:00:00Z", // When to do it (distinct from due_date)
  "is_reference": false,              // Mark as reference material (ELLIE-921)
  "source_type": "agent",
  "source_ref": "conversation_id"
}
```

**Result:** Task enters `inbox` status, unassigned

**New Fields (ELLIE-914 / ELLIE-915):**
- **`effort`**: Task size estimate — `quick` (<15m), `medium` (15-60m), `deep` (>1hr)
  - Auto-classified from content keywords if not provided (ELLIE-917)
- **`context`**: Plain string context (e.g., "email", "phone", "deep-work")
  - Replaces @ tag approach (Dave's preference: no @ symbols)
  - Must match a name from `gtd_contexts` table
- **`scheduled_at`**: When the task is scheduled (distinct from `due_date`)
  - `scheduled_at` = when to do it
  - `due_date` = when it must be done by
- **`is_reference`**: Boolean flag for reference material (default: false)
  - Reference items don't clutter next-actions list

### 2. Assignment
```bash
POST /api/gtd/delegate
{
  "todo_id": "uuid",
  "to_agent": "dev",
  "delegated_by": "general",
  "note": "Context for the assigned agent"
}
```

**Result:** Task moves to `open` status, `assigned_agent` set, `assigned_to` display name set

### 3. Completion
```bash
PATCH /api/gtd/todos/{id}
{
  "status": "done"
}
```

**What to include when marking complete:**
- **Work product reference** — path to the file, document, or artifact produced
- **Completion criteria met** — confirm acceptance criteria from the task
- **Next steps spawned** — if this task spawned follow-up work, mention it

**Example:**
```bash
PATCH /api/gtd/todos/cdc5c26c-bf1d-46bd-980a-29f26116f829
{
  "status": "done",
  "content": "Guardrails — What Ellie must never do | COMPLETED: docs/guardrails.md"
}
```

### 4. Cancellation
```bash
PATCH /api/gtd/todos/{id}
{
  "status": "cancelled"
}
```

**When to cancel:**
- Task is no longer relevant
- Duplicate of another task
- Superseded by a different approach

## Context System (ELLIE-916)

**Database Table:** `gtd_contexts`

The context system replaces the legacy @ tag approach with a structured context dropdown. Contexts define *where* or *how* a task should be done.

### Default Contexts

| Name | Label | Icon | Calendar Enabled |
|------|-------|------|------------------|
| `general` | General | 📋 | No |
| `deep-work` | Deep Work | 🔨 | No |
| `email` | Email | 📧 | Yes |
| `appointments` | Appointments | 📅 | Yes |
| `errands` | Errands | 🏃 | No |
| `phone` | Phone | 📞 | No |
| `plane` | Plane Tickets | ✈️ | No |
| `home` | Home | 🏠 | No |

### Calendar Integration (ELLIE-920)

**Status:** Schema ready, sync logic not yet implemented.

Contexts with `calendar_enabled: true` will sync with Google Calendar:
- **Outbound sync:** GTD todos with `scheduled_at` → Google Calendar events
- **Inbound sync:** Google Calendar events → GTD todos
- **Mapping:** `context_calendar_config` table links context → Google Calendar ID

**UI Note (ELLIE-919):** Calendar toggle UI not yet built — users can't enable/disable calendar per context yet.

### API: List Contexts

```bash
GET /api/gtd/contexts
```

**Response:**
```json
{
  "contexts": [
    { "id": "...", "name": "email", "label": "Email", "icon": "📧", "color": "#8B5CF6", "calendar_enabled": true },
    ...
  ]
}
```

## Projects vs. Standalone Tasks

### Project Structure
- **Projects** group related tasks under a shared outcome
- Each project has a `name` and desired `outcome` (what does done look like?)
- Tasks link to projects via `project_id` foreign key
- Projects have status: `active`, `completed`, `on_hold`

### When to Use Projects
Use projects for:
- Multi-step workflows (e.g., "7 Foundational Documents")
- Coordinated agent work (multiple specialists contributing)
- Long-term initiatives with a clear end state

**Example:** The 7 Foundational Documents are a project:
```
Project: "Foundational Documents for Ellie OS"
Outcome: "7 core documents defining how Ellie works, stored in River"
Tasks:
  1. Guardrails [done]
  2. Cognitive Operating Profile [open]
  3. Commitment Framework [open]
  4. People Frameworks [open]
  5. Decision Framework [open]
  6. Taxonomy [open]
  7. Extraction Methodology [open]
  8. Migrate all 7 to River [blocked, depends on 1-7]
```

### Sequence Field (NEEDED - see Known Gaps)
**Currently missing:** No `sequence` or `order` field in `todos` table.
**Impact:** Can't enforce or display task order within a project.
**Proposed fix:** Add `sequence INTEGER` to `todos`, ordered within `project_id` scope.

## Effort Classification (ELLIE-917)

When agents create tasks, the `effort` field is auto-classified from content keywords if not explicitly provided.

### Classification Rules

| Effort | Time Estimate | Keywords |
|--------|---------------|----------|
| `quick` | < 15 minutes | check, reply, send, update, fix typo, rename, ping |
| `medium` | 15-60 minutes | review, implement, write, create, investigate, configure |
| `deep` | > 1 hour | design, architect, refactor, migrate, build, research deeply |

**Example:**
- Content: "Check Plane ticket ELLIE-5" → Auto-classified as `quick`
- Content: "Design the Commitment Framework" → Auto-classified as `deep`

Agents can override by explicitly setting `effort` in the request body.

## Waiting-For Tasks (ELLIE-918)

When an agent delegates work to an external party (e.g., "Ask Dave about X"), use the waiting-for auto-creation endpoint:

```bash
POST /api/gtd/waiting-for
{
  "content": "Waiting for Dave to confirm calendar integration scope",
  "agent": "general",
  "work_item_id": "ELLIE-920",
  "context": "plane"
}
```

**Result:** Task created with:
- `status: "waiting_for"`
- `waiting_on: "<agent>"`
- `waiting_since: <timestamp>`
- `effort: <auto-classified>`

This pattern replaces manual creation of waiting-for tasks.

## Agent Workflow Patterns

### Solo Work
1. Get assigned task: `GET /api/gtd/next-actions?agent=dev`
2. Work on the task
3. Mark complete: `PATCH /api/gtd/todos/{id}` with `status: "done"`
4. Update task content to reference work product

### Handoff to Another Agent
1. Complete your portion
2. Delegate: `POST /api/gtd/delegate` with `to_agent` and context
3. Receiving agent sees it in their next-actions queue
4. Original task stays `open`, just changes assignment

### Parallel Work in a Project
Multiple agents can work on different tasks in the same project simultaneously. Each agent filters their own queue: `?agent=TYPE`.

## Completion Thresholds

**What qualifies as "done"?**

Different task types have different done criteria:

| Task Type | Done Means |
|-----------|------------|
| Document creation | File exists at specified path, reviewed and approved |
| Code feature | Tests pass, PR merged, deployed |
| Research | Report delivered, findings documented |
| Review | Feedback provided, approved or sent back with changes |
| Meeting role | Notes captured, action items logged |

**Always document the threshold in the task:**
- On creation: "Done when [criteria]"
- On completion: "COMPLETED: [what was delivered]"

## Known Gaps & Future Improvements

### 1. Reconciliation Guardrails (OPEN QUESTION)
**Issue:** How do we prevent duplicate tasks when multiple agents or passes create similar items?
**Status:** Needs design work (tracked as separate GTD task)
**Options considered:**
- Fuzzy matching on task content before insert
- Require explicit project linkage
- Dashboard reconciliation UI

### 2. Calendar Sync Logic (ELLIE-920)
**Issue:** Schema and config tables exist, but no sync implementation yet
**Status:** Deferred to ELLIE-920
**What's missing:**
- Outbound sync: GTD todos with `scheduled_at` → Google Calendar events
- Inbound sync: Google Calendar events → GTD todos
- Webhook/polling logic to keep them in sync

### 3. Calendar Toggle UI (ELLIE-919)
**Issue:** `calendar_enabled` field exists in DB, but no UI to change it per context
**Status:** Deferred to ELLIE-919
**What's missing:**
- Context management UI (create/edit/delete contexts)
- Calendar toggle checkbox per context
- Visual indicator in context dropdown for calendar-enabled contexts

### 4. GTD Skill Documentation (ELLIE-921)
**Issue:** `skills/gtd/SKILL.md` is outdated — missing all ELLIE-914 features
**Status:** Deferred to ELLIE-921
**What needs updating:**
- Effort field and classification
- Context system (no more @ tags)
- Calendar sync behavior
- Reference tagging (`is_reference`)
- Auto waiting-for delegation

### 5. Memory & Context Alignment
**Issue:** Agents need consistent boot context (foundational documents in River)
**Status:** In progress — 7 documents being created, will live in River
**Lessons learned:** Documents need to be in River AND referenced in agent prompt assembly so they survive context compression.

## Operational Checklist

When an agent starts work on a GTD task:
- [ ] Read the task content and acceptance criteria
- [ ] Check if it's part of a project — if so, understand the project outcome
- [ ] Check dependencies — are there tasks this blocks or is blocked by?
- [ ] Confirm assigned agent matches (don't work on someone else's task)
- [ ] Update `content` with progress notes as you go
- [ ] When complete, update content with work product reference
- [ ] Mark `status: "done"`
- [ ] If spawning follow-up work, create new task(s)

## Common Mistakes

❌ **Marking done without documenting what was completed**
✅ Update content: "Task name | COMPLETED: path/to/artifact"

❌ **Creating duplicate tasks (assigned + unassigned copies)**
✅ Check existing tasks before creating new ones

❌ **Working on unassigned tasks meant for delegation**
✅ Filter by your agent type: `?agent=YOUR_TYPE`

❌ **Forgetting to link tasks to projects**
✅ Set `project_id` when tasks are part of a larger initiative

❌ **No sequence/order, so multi-step projects are chaotic**
✅ (Pending schema fix) — manually track order in task content for now

## Integration with Other Systems

- **Forest Bridge:** Log decisions and findings from GTD work to Forest
- **Work Sessions:** GTD tasks can trigger work session dispatch (ELLIE-XXX pattern)
- **Plane:** Cross-reference with Plane work items for development tasks
- **River:** Completed foundational documents migrate from `docs/` to River vault

## Testing the System

Verify GTD is working:
```bash
# Check API health
curl http://localhost:3001/api/gtd/summary

# List your tasks
curl "http://localhost:3001/api/gtd/next-actions?agent=dev&limit=10"

# Team overview
curl http://localhost:3001/api/gtd/team
```

## Contact & Escalation

When GTD issues arise:
- Schema bugs → escalate to Dave + dev agent
- API failures → check relay logs: `journalctl --user -u claude-telegram-relay`
- Design questions (like reconciliation) → create GTD task for discussion

---

**Version:** 2.0 (ELLIE-914 MVP)
**Last updated:** 2026-03-19
**Authors:** Ellie (general), with input from Dave
**Status:** Living document — update as we learn

**Changelog:**
- **2.0 (2026-03-19):** ELLIE-914 shipped — effort field, context system, scheduled_at, reference tagging, waiting-for auto-creation
- **1.0 (2026-03-19):** Initial version based on 7 Foundational Documents project lessons
