# Agent Boot GTD Polling — ELLIE-924

This snippet should be included in all specialist agent archetypes (dev, research, content, critic, strategy, ops) to enable proactive GTD task pickup.

## Boot Sequence

**On session start, check for assigned work BEFORE asking what to do:**

```bash
GET /api/gtd/next-actions?agent={agent_type}&sort=sequence&limit=5
```

Replace `{agent_type}` with your agent type (dev, research, content, critic, strategy, ops).

**If assigned tasks exist:**
- **1 task** → "Hi! I have 1 task assigned: '[task content]'. Should I start working on this?"
- **2+ tasks** → "Hi! I have [N] tasks assigned: [list]. Which should I tackle first?"
- **User confirms** → Start work on the selected task, update GTD status to "open"
- **User says "later"** → Acknowledge, proceed to normal conversation mode

**If no assigned tasks:**
- Proceed to normal conversation mode — "Hi! No tasks assigned. How can I help?"

## Why This Matters

When Ellie (general agent) orchestrates multi-step work, she creates GTD tasks assigned to specialist agents (`assigned_agent: "dev"`, `assigned_agent: "research"`, etc.). Checking on boot ensures agents pick up delegated work proactively instead of waiting for explicit dispatch.

**Think of GTD as your inbox.** The general agent delegates tasks → you check your inbox on boot → you pick up what's waiting.

## Updating GTD Task Status

When you start work on a GTD task:

```bash
PATCH /api/gtd/todos/{task_id}
{ "status": "open" }
```

When you complete it:

```bash
PATCH /api/gtd/todos/{task_id}
{ "status": "done", "completed_at": "2026-03-19T12:34:56Z" }
```

When blocked:

```bash
PATCH /api/gtd/todos/{task_id}
{ "status": "waiting_for", "waiting_on": "Reason for block" }
```

## Integration with Work Sessions

If the GTD task references a work item (e.g., `source_ref: "ELLIE-922"`), also start a work session:

```bash
POST /api/work-session/start
{
  "work_item_id": "ELLIE-922",
  "title": "Task title",
  "project": "ellie-dev"
}
```

This ensures:
- Plane ticket moves to "In Progress"
- Work session tracked in database
- Dave gets Telegram/Google Chat notification
- Forest records agent activity

## See Also

- [Agent Boot Protocol](./agent-boot-protocol.md) — Full boot sequence documentation
- [Multi-Agent Orchestration](./commitment-use-cases/multi-agent-orchestration.md) — Orchestration patterns
- [GTD Operations Manual](./gtd-operations-manual.md) — Full GTD reference
