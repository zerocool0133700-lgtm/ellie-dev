# Agent Boot Protocol — ELLIE-924

This document defines the standard boot sequence for specialist agents (dev, research, content, strategy, critic, ops) when they start a new session.

## Purpose

Agents should be **proactive** — checking for assigned work on boot rather than waiting for explicit dispatch. This enables orchestration workflows where the general agent (Ellie) delegates tasks via GTD and specialist agents pick them up automatically.

## Boot Sequence

When a specialist agent starts (either via explicit dispatch or conversation start), follow this sequence:

### 1. Check GTD for Assigned Work

**Query:** `GET /api/gtd/next-actions?agent={agent_type}&sort=sequence`

Example for dev agent:
```bash
GET /api/gtd/next-actions?agent=dev&sort=sequence&limit=5
```

**Response:** List of GTD tasks assigned to this agent, ordered by priority/sequence.

**Decision logic:**
- If no assigned tasks → proceed to normal conversation mode
- If 1 task assigned → announce it and ask if user wants to work on it now
- If 2+ tasks assigned → list them and ask which to work on first

### 2. Announce Assigned Work (if any)

When assigned tasks exist, greet the user and surface the work:

**Single task:**
> "Hi! I have 1 task assigned to me: **[task content]**. Should I start working on this?"

**Multiple tasks:**
> "Hi! I have 3 tasks assigned to me:
> 1. [task 1]
> 2. [task 2]
> 3. [task 3]
>
> Which should I tackle first?"

### 3. Proceed Based on User Input

- **User confirms a task** → start work, update task status to "open", log progress
- **User says "later" or "skip"** → proceed to normal conversation mode
- **User assigns a different task** → work on that instead

## Implementation Example

Here's how the dev agent would implement this in practice:

```typescript
// Agent boot (injected into prompt context)
const assignedTasks = await fetch("http://localhost:3001/api/gtd/next-actions?agent=dev&sort=sequence&limit=5")
  .then(r => r.json());

if (assignedTasks.next_actions?.length > 0) {
  // Surface assigned work to the user
  const tasks = assignedTasks.next_actions;
  if (tasks.length === 1) {
    // Single task — offer to start
    respondToUser(`Hi! I have 1 task assigned to me: "${tasks[0].content}". Should I start working on this?`);
  } else {
    // Multiple tasks — list and ask priority
    const taskList = tasks.map((t, i) => `${i+1}. ${t.content}`).join("\n");
    respondToUser(`Hi! I have ${tasks.length} tasks assigned to me:\n${taskList}\n\nWhich should I tackle first?`);
  }
} else {
  // No assigned work — normal conversation mode
  respondToUser("Hi! No tasks assigned to me right now. How can I help?");
}
```

## GTD as Agent Inbox

Think of GTD as each agent's **inbox**. When the general agent (Ellie) orchestrates multi-step work:

1. Ellie breaks work into sub-tasks
2. Creates GTD tasks with `assigned_agent: "dev"` (or research, content, etc.)
3. Specialist agents check their "inbox" on boot and pick up assigned work
4. Agents update task status as they work (inbox → open → done)
5. Ellie monitors progress via GTD status

This pattern enables:
- **Asynchronous orchestration** — Ellie doesn't block waiting for agents
- **Visible delegation** — Dave sees all assigned work in GTD dashboard
- **Agent autonomy** — Agents can prioritize and manage their own workload
- **Progress tracking** — GTD status reflects real-time agent activity

## Status Updates

As agents work on GTD tasks, update status via the GTD API:

**Start work:**
```bash
PATCH /api/gtd/todos/{id}
{ "status": "open" }
```

**Complete work:**
```bash
PATCH /api/gtd/todos/{id}
{ "status": "done", "completed_at": "2026-03-19T12:34:56Z" }
```

**Block on dependency:**
```bash
PATCH /api/gtd/todos/{id}
{ "status": "waiting_for", "waiting_on": "Reason for block" }
```

## Integration with Work Sessions

When an agent starts work on a GTD task that references a work item (e.g., `source_ref: "ELLIE-922"`), also start a work session:

```bash
POST /api/work-session/start
{
  "work_item_id": "ELLIE-922",
  "title": "Fix compaction safeguards",
  "project": "ellie-dev"
}
```

This ensures:
- Plane ticket moves to "In Progress"
- Work session tracked in database
- Dave gets Telegram/Google Chat notification
- Forest records agent activity

## Monitoring and Escalation

The orchestration monitor (`orchestration-monitor.ts`) watches for:

- **Unstarted tasks** — assigned >5 minutes ago but still in "inbox" status
- **Stalled tasks** — status="open" but no updates in >10 minutes

When detected, Dave gets a notification:
> "⚠️ GTD task unstarted for 6min — assigned to dev: 'Implement compaction rollback'"

This allows Dave to intervene if agents aren't picking up work or are stuck.

## Testing

To test the boot protocol:

1. Create a GTD task assigned to an agent:
```bash
POST /api/gtd/inbox
{
  "content": "Test task for dev agent",
  "assigned_agent": "dev",
  "delegated_by": "general"
}
```

2. Start a conversation with the dev agent
3. Verify the agent surfaces the assigned task on boot
4. Confirm the agent offers to start work or asks for priority

## See Also

- [Multi-Agent Orchestration Use Case](./commitment-use-cases/multi-agent-orchestration.md)
- [GTD Operations Manual](./gtd-operations-manual.md)
- [ELLIE-922 Postmortem](./postmortems/ELLIE-922-orchestration.md)
