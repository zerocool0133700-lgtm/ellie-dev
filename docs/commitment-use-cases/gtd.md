# GTD Task Management — Behavioral Use Case

**Use Case:** Managing tasks via the GTD system
**System:** `POST /api/gtd/inbox`, `GET /api/gtd/next-actions`, `PATCH /api/gtd/todos/:id`
**Technical Reference:** [GTD Operations Manual](/home/ellie/ellie-dev/docs/gtd-operations-manual.md)

---

## When This Use Case Applies

Trigger this workflow when the user:

- **Explicitly requests task creation:** "Add this to my todo list", "Create a task for X", "Remind me to Y"
- **Mentions future work:** "I need to follow up on Z", "We should revisit this next week"
- **Delegates to you:** "Can you handle X?", "Please take care of Y"
- **Describes an action item:** "Next step is to do A", "Don't forget to B"

**Do NOT auto-create tasks for:**
- Casual mentions of things that might happen ("maybe I'll look into X someday")
- Hypothetical scenarios ("if we ever do Y, we'd need to Z")
- Things the user is already doing right now in this conversation

---

## Decision Tree: Auto-Create vs. Ask

### ✅ Auto-Create (No Confirmation Needed)

Create the task immediately when:

1. **User explicitly requests it:** "Add 'reply to Sarah's email' to my list"
2. **Action item is clear and concrete:** "Follow up with Zach about the API design"
3. **Low stakes:** The task is reversible (can be edited/deleted easily)
4. **You have all required context:** Priority, timing, and scope are clear or can be inferred

**After auto-creating:**
- Confirm briefly: "Added to your GTD list: [task name]"
- Mention the effort level if it's `deep` (helps with planning)
- Don't ask follow-up questions unless clarification is genuinely needed

### 🛑 Ask First (Get Confirmation)

Ask before creating when:

1. **Ambiguous scope:** "Should this be one task or multiple steps?"
2. **Unclear priority:** "Is this high/medium/low priority?"
3. **Timing unknown:** "When do you need this done?"
4. **Might be a project:** "This sounds like multiple tasks — want me to create a project?"
5. **User seems uncertain:** "Maybe I should... I don't know"

**How to ask:**
- Present the task you'd create: "I'll add: '[task name]' — sound good?"
- Offer options if unclear: "Should this be high priority or medium?"
- Keep it conversational, not robotic

---

## Effort Classification

When creating tasks, classify effort using these rules:

| Effort Level | Time Estimate | Keywords | Examples |
|--------------|---------------|----------|----------|
| **quick** | < 15 minutes | check, reply, send, update, fix typo, rename, ping | "Reply to Sarah's email", "Check ticket status" |
| **medium** | 15-60 minutes | review, implement, write, create, investigate, configure | "Review pull request", "Write meeting notes" |
| **deep** | > 1 hour | design, architect, refactor, migrate, build, research deeply | "Design the commitment framework", "Migrate database schema" |

### Classification Protocol

1. **User provides explicit effort:** Use their value (trust their judgment)
2. **Task description has clear keywords:** Auto-classify based on the table above
3. **Ambiguous or compound task:** Default to `medium` and mention it: "I'm marking this as 'medium effort' — let me know if it's bigger"
4. **Multi-step task:** If it spans multiple effort levels, ask if they want it split: "This sounds like multiple tasks — want me to break it down?"

**When in doubt:** Ask. "How big is this task? Quick, medium, or deep?"

---

## Context Selection

**Context** defines *where* or *how* a task should be done. Choose the context that best matches the task's nature.

### Context Types

| Context | Use When | Calendar Sync |
|---------|----------|---------------|
| `general` | Default — no specific context applies | No |
| `deep-work` | Requires focused, uninterrupted time | No |
| `email` | Email-related tasks | Yes |
| `appointments` | Scheduled meetings or calls | Yes |
| `errands` | Physical world tasks (shopping, pickup) | No |
| `phone` | Phone calls or voice messages | No |
| `plane` | Plane work item tasks (ELLIE-XXX) | No |
| `home` | Home/personal tasks | No |

### Selection Logic

1. **User specifies context:** Use their value (e.g., "Add this to my email list")
2. **Task content implies context:**
   - Contains "email", "reply", "send message" → `email`
   - Contains "call", "phone" → `phone`
   - Contains "ELLIE-", "ticket", "work item" → `plane`
   - Contains "meet", "schedule", "appointment" → `appointments`
   - Contains "focus", "design", "think through" → `deep-work`
3. **No clear signal:** Default to `general`

**Calendar-enabled contexts:**
- `email` and `appointments` have `calendar_enabled: true`
- Tasks in these contexts **with `scheduled_at`** will sync to Google Calendar (when ELLIE-920 ships)
- Don't mention calendar sync in user-facing messages yet — the feature isn't live

---

## Scheduled vs. Due Dates

Two distinct fields exist:

- **`scheduled_at`**: When the task is **scheduled** to be done (proactive timing)
- **`due_date`**: When the task **must be done by** (hard deadline)

### When to Set Each

| Field | Set When | Example |
|-------|----------|---------|
| `scheduled_at` | User says "do this on [date/time]", "schedule for [when]" | "Follow up with Zach on Friday at 2pm" |
| `due_date` | User says "by [date]", "before [deadline]", "needs to be done by [when]" | "Submit the report by end of day Tuesday" |
| Both | User gives both: "Work on this Friday, due Monday" | `scheduled_at: Friday`, `due_date: Monday` |
| Neither | No timing mentioned | Leave blank (user can schedule later) |

**Default behavior:**
- If user just says "Friday", interpret as `scheduled_at` (proactive scheduling)
- If user says "before Friday" or "by Friday", interpret as `due_date` (deadline)

---

## Reference Material Tagging

**Reference tasks** (`is_reference: true`) are information storage, not action items.

### When to Tag as Reference

Mark `is_reference: true` when:

1. **User explicitly says "reference":** "Save this as reference", "Keep this for later"
2. **Task is informational, not actionable:** "Notes from the meeting with Zach", "API documentation for X"
3. **Task is a resource link:** "Link to design mockups", "Zach's email about the project"

### When NOT to Tag as Reference

Do NOT mark as reference if:

- Task requires action (even if it's just "review X")
- Task has a clear next step
- Task is part of a project workflow

**Effect of reference tagging:**
- Reference tasks are excluded from `GET /api/gtd/next-actions` by default
- They live in a separate "reference" view (future UI feature)
- Good for reducing next-actions clutter

---

## Waiting-For Tasks

When you delegate work to an **external party** (not another agent), create a waiting-for task using `POST /api/gtd/waiting-for`.

### When to Use Waiting-For

Create a waiting-for task when:

1. **You ask the user for input:** "Waiting for Dave to confirm the scope"
2. **User mentions waiting on someone else:** "I'm waiting for Sarah to get back to me"
3. **External dependency:** "Can't proceed until Zach sends the API docs"

**Example:**
```bash
POST /api/gtd/waiting-for
{
  "content": "Waiting for Dave to approve the GTD commitment framework use cases",
  "agent": "general",
  "work_item_id": "ELLIE-914",
  "context": "plane"
}
```

### When NOT to Use Waiting-For

Do NOT create waiting-for tasks for:

- **Agent-to-agent handoffs:** Use `POST /api/gtd/delegate` instead
- **Internal blockers:** Just note the blocker in the task content
- **Hypothetical waits:** "If Dave ever decides X, then Y" — not a real wait

---

## Agent-to-Agent Delegation

When handing work to another agent, use `POST /api/gtd/delegate`.

### When to Delegate

Delegate a task when:

1. **Work requires a different agent's expertise:** General agent delegates code work to dev
2. **User explicitly assigns:** "Have James (dev) handle this"
3. **Current agent is blocked:** "I can't proceed — research agent needs to gather data first"

### Delegation Protocol

1. **Complete your portion** — don't pass half-finished work unless necessary
2. **Add context in the note** — what you did, what's left, why you're delegating
3. **Choose the right agent:**
   - `dev` — code, schemas, technical implementation
   - `research` — data gathering, web searches, analysis
   - `content` — writing, documentation, user-facing text
   - `strategy` — planning, roadmaps, architectural decisions
   - `critic` — review, quality checks, pre-ship validation
   - `ops` — infrastructure, deployments, monitoring

**Example:**
```bash
POST /api/gtd/delegate
{
  "todo_id": "uuid",
  "to_agent": "dev",
  "delegated_by": "general",
  "note": "User wants the GTD context dropdown UI built. Schema is done (ELLIE-916), API is ready. Need frontend implementation in ellie-home."
}
```

---

## Project Linkage

When a task is part of a larger initiative, link it to a project via `project_id`.

### When to Use Projects

Use projects for:

1. **Multi-step workflows:** "7 Foundational Documents", "GTD Enhanced System"
2. **Coordinated agent work:** Multiple agents contributing to a shared outcome
3. **Long-term initiatives:** Work spanning weeks or months with a clear end state

### When NOT to Use Projects

Skip projects for:

- One-off tasks with no related work
- Quick standalone actions
- Tasks that are self-contained

**If unsure:** Ask the user: "Should this be part of a project, or is it standalone?"

---

## Completion Protocol

When marking a task done (`PATCH /api/gtd/todos/:id` with `status: "done"`), always include:

1. **Work product reference:** Path to the file, document, or artifact produced
2. **Completion confirmation:** Briefly note what was delivered
3. **Spawned follow-ups:** If this task created new tasks, mention them

**Example:**
```bash
PATCH /api/gtd/todos/cdc5c26c-bf1d-46bd-980a-29f26116f829
{
  "status": "done",
  "content": "GTD Task Management Use Case | COMPLETED: docs/commitment-use-cases/gtd.md | Spawned: ELLIE-925 (update GTD skill docs)"
}
```

**Don't just flip status to done** — update the content field to document the outcome.

---

## Edge Cases & Exceptions

### Multiple Contexts

**Q:** What if a task fits multiple contexts?
**A:** Pick the **primary** context (where it will mostly be done). If truly ambiguous, default to `general`.

### Recurring Tasks

**Q:** User wants a task to repeat weekly/daily.
**A:** GTD system doesn't support recurrence yet. Create the first instance and note in content: "Recurring: weekly on Fridays". Future: ELLIE-XXX will add recurrence.

### Task Too Big

**Q:** Task is huge (multi-hour, multi-day).
**A:** Ask if they want it broken into sub-tasks: "This sounds like a big one — want me to break it into smaller steps?"

### Conflicting Priorities

**Q:** User has 10 high-priority tasks.
**A:** Gently surface the conflict: "You've got 10 high-priority tasks right now — want me to help prioritize?"

### Unknown Agent

**Q:** Task needs an agent type we don't have.
**A:** Default to `general` and note it: "I'm assigning this to Ellie (general) for now — let me know if it should go elsewhere."

---

## Anti-Patterns (What NOT to Do)

❌ **Creating tasks for everything mentioned**
- Don't turn casual conversation into a task list
- Only create tasks for clear, actionable commitments

❌ **Over-asking for confirmation**
- If the user said "add this to my list", just do it
- Don't ask 5 follow-up questions unless genuinely unclear

❌ **Under-specifying tasks**
- Vague: "Work on the thing"
- Good: "Update GTD Operations Manual with ELLIE-914 features"

❌ **Forgetting to link to projects**
- If a task is clearly part of a project, set `project_id`
- Don't create orphaned tasks that should be grouped

❌ **Duplicating tasks**
- Before creating, check if a similar task already exists
- If user says "remind me about X" and X is already in the list, just update it

❌ **Marking done without documenting**
- Always update `content` with what was completed
- Future sessions need to know what happened

---

## Quick Reference: Decision Flowchart

```
User mentions something
    │
    ├─ Is it a clear action item? ───Yes──> Auto-create task
    │                             └─ No ──> Skip (just conversation)
    │
    ├─ Do I have all context? ──────Yes──> Create with defaults
    │                           └─ No ──> Ask for clarification
    │
    ├─ What's the effort? ──> Keywords match? ─> Use auto-classification
    │                     └─> Ambiguous? ────> Default to `medium`, mention it
    │
    ├─ What's the context? ──> User specified? ─> Use their value
    │                      └─> Content implies? ─> Auto-select
    │                      └─> No signal? ─────> Default to `general`
    │
    ├─ Is it reference? ──> Informational only? ─> `is_reference: true`
    │                   └─> Actionable? ───────> `is_reference: false`
    │
    ├─ External wait? ──> Yes ─> POST /api/gtd/waiting-for
    │                 └─> No ──> Regular task
    │
    └─ Mark complete ──> Update `content` with work product, then `status: "done"`
```

---

## Integration with Other Systems

- **Plane:** Cross-reference GTD tasks with Plane work items (use `work_item_id` metadata)
- **Forest:** Log GTD learnings (process improvements, common patterns) to Forest
- **Work Sessions:** GTD tasks can trigger formal work sessions for large efforts
- **Calendar:** Tasks with `scheduled_at` in calendar-enabled contexts will sync to Google Calendar (ELLIE-920)

---

## Testing This Use Case

Verify behavioral rules are working:

1. **Auto-create test:** User says "Add 'reply to Sarah' to my list" → task should appear immediately
2. **Effort classification test:** Create task with "Design the new GTD UI" → should auto-classify as `deep`
3. **Context selection test:** Create task "Email Zach about the meeting" → should auto-select `email` context
4. **Reference test:** Create task "Notes from standup meeting" → should have `is_reference: true`
5. **Waiting-for test:** Create task "Waiting for Dave to approve X" → should use waiting-for endpoint

---

**Version:** 1.0
**Last Updated:** 2026-03-19
**Author:** Ellie (general)
**Status:** Active use case — part of Commitment Framework
