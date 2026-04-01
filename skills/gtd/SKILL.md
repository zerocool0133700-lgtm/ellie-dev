---
name: gtd
description: Getting Things Done — task management system. Captures tasks to inbox, surfaces context about priorities, provides GTD status. Supports passive mode (status only) and active mode (full conversational triggers).
triggers:
  - "task"
  - "inbox"
  - "gtd"
  - "todo"
  - "next actions"
  - "waiting for"
  - "someday"
  - "project"
  - "what should I work on"
  - "what's on my plate"
always_on: true
mode_aware: true
---

# GTD — Getting Things Done Integration

You help Dave manage tasks through the GTD system. You have two modes: **passive** (status display only) and **active** (full conversational integration).

## Mode Detection

Check the `gtdSkillMode` parameter passed to you:
- `passive` → Show status, no proactive triggers
- `active` → Full conversational integration

## Passive Mode

When in passive mode:
- **DO** provide GTD status when directly asked ("what's in my inbox?", "/gtd list")
- **DO** contribute to the summary bar
- **DON'T** proactively offer to capture tasks
- **DON'T** interrupt with GTD context unless explicitly asked

## Active Mode

When in active mode, all passive behaviors PLUS:
- **Proactive capture** — detect task mentions and offer to add to inbox
- **Context surfacing** — mention relevant GTD items when discussing work
- **Coach mode** — suggest processing inbox when it's full, remind about weekly review

## Summary Bar Contribution

Always provide a one-line status for the Ellie Chat summary bar (both modes):

```
GTD: {inbox_count} inbox | {next_actions_count} next | {waiting_count} waiting
```

Include green indicator if:
- Inbox has >10 items (needs processing)
- Any item is overdue
- Weekly review is overdue (>7 days since last review)

## API Endpoints

GTD runs at `http://localhost:3001/api/gtd`:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/gtd/inbox` | POST | Capture new items to inbox |
| `/api/gtd/next-actions` | GET | List open tasks (supports `?agent=TYPE` filter, `?limit=N`) |
| `/api/gtd/todos/{id}` | PATCH | Update task (status, priority, content, project_id, etc.) |
| `/api/gtd/summary` | GET | Quick state snapshot (inbox/open/waiting counts) |
| `/api/gtd/review-state` | GET | Weekly review status and nudges |
| `/api/gtd/team` | GET | Team-wide workload overview |
| `/api/gtd/delegate` | POST | Delegate task to another agent |
| `/api/gtd/delegate/complete` | POST | Complete delegated task |

## Conversational Triggers (Active Mode Only)

### Task Capture
When user mentions something they need to do:
- "I need to..." / "I should..." / "Don't let me forget..."
- "Remind me to..." / "Make sure I..."
- "Tomorrow I'll..." / "Next week I need to..."

**Response:**
> "Want me to add that to your GTD inbox? [Yes/No]"

If yes, POST to `/api/gtd/inbox`:
```json
{
  "content": "extracted task description",
  "source_type": "ellie-chat",
  "source_ref": "conversation_id",
  "priority": "medium",
  "tags": []
}
```

### Context Surfacing
When discussing a project or work area, check if there are related GTD items:
- Query `/api/gtd/next-actions` and filter by tags or content match
- If matches found, mention: *"By the way, you have 2 next actions related to this: [item 1], [item 2]"*

### Inbox Nudging
If `/api/gtd/status` shows inbox >15 items, gently nudge:
> "Your GTD inbox has 17 items — want to process a few together?"

### Weekly Review
If last review was >7 days ago (check `/api/gtd/status`), mention on Monday morning:
> "It's been 8 days since your last GTD weekly review. Good time to clear the deck?"

## Direct Commands (Both Modes)

Explicit GTD commands always work, regardless of mode:

| User says | You do |
|-----------|--------|
| "show my inbox" / "what's in my inbox" | GET `/api/gtd/next-actions` filtered by status=inbox |
| "show next actions" | GET `/api/gtd/next-actions` |
| "what's waiting" | GET `/api/gtd/next-actions` filtered by status=waiting_for |
| "gtd status" | GET `/api/gtd/summary`, show summary |
| "add task: {title}" | POST to `/api/gtd/inbox` |
| "mark {id} done" | PATCH `/api/gtd/todos/{id}` with `status: "done"` |
| "move {id} to waiting" | PATCH with `status: "waiting_for"` |

## Multi-Agent Coordination

This section explains how agents use GTD to coordinate work between themselves and with Dave.

### Agent-to-Agent Delegation

When one agent completes their part of a workflow and needs another specialist to continue:

**Delegation API:**
```
POST /api/gtd/delegate
{
  "todo_id": "uuid",
  "to_agent": "content" | "dev" | "research" | "critic" | "strategy" | "ops",
  "delegated_by": "general",
  "note": "Context for the delegated agent"
}
```

**Agent types map to display names:**
- `general` → Ellie
- `dev` → James
- `research` → Kate
- `content` → Amy
- `critic` → Brian
- `strategy` → Alan
- `ops` → Jason

**When to delegate:**
- Dev finishes research → delegate design to Strategy
- Research completes analysis → delegate writing to Content
- Content drafts post → delegate review to Critic
- Any agent hits a blocker requiring different expertise

**Example flow:**
1. Research agent (Kate) finishes competitor analysis
2. Kate: POST `/api/gtd/delegate` with `delegated_to: "amy"`, notes: "Analysis complete, ready for blog post"
3. Amy sees delegated item in her GTD queue
4. Amy writes the post
5. Amy: POST `/api/gtd/delegate` with `delegated_to: "brian"`, notes: "Draft complete, needs review"
6. Brian reviews and either completes or delegates back with feedback

### Workflow Pipelines

Common multi-agent workflows that use GTD as coordination:

**Research → Content → Critic:**
```
Kate (research) → Amy (content) → Brian (critic) → Dave (review)
```

**Strategy → Dev → Ops:**
```
Alan (strategy) → James (dev) → Jason (ops/deploy)
```

**Support flow:**
```
General → Specialist → Critic → General (respond to user)
```

### Role Assignment in Meetings

During board meetings or multi-agent sessions, assign roles via GTD:

**Example:**
> "Amy, you're taking notes for this board meeting."

This creates a GTD item:
```json
{
  "title": "Board Meeting Notes - March 18",
  "list": "next_actions",
  "assigned_to": "amy",
  "context": "board-meeting",
  "priority": "high",
  "due_date": "2026-03-18"
}
```

**Common role assignments:**
- Note-taker (capture decisions, action items)
- Facilitator (keep discussion on track, time management)
- Researcher (fact-check claims made during meeting)
- Devil's advocate (challenge assumptions)

### Team Workload Views

Agents can query team capacity before delegating:

**Check workload:**
```
GET /api/gtd/team/workload
```

Returns:
```json
{
  "amy": {"total": 12, "high_priority": 3, "overdue": 0},
  "james": {"total": 8, "high_priority": 5, "overdue": 1},
  "kate": {"total": 15, "high_priority": 2, "overdue": 0},
  ...
}
```

**Smart delegation:**
Before delegating, check who has capacity. Prefer agents with:
- Lower total count
- Fewer high-priority items
- No overdue items

**Velocity tracking:**
```
GET /api/gtd/team/velocity?days=7
```

Shows completion rates per agent over the last N days — helps identify bottlenecks.

### Delegation Rules

1. **Always include context** — the receiving agent needs to know why they got this
2. **Check capacity first** — don't overload agents who are already swamped
3. **Respect expertise** — delegate to the right specialist for the task
4. **Follow up** — if a delegated item sits for >24h, check in
5. **Escalate blockers** — if an agent can't complete, they should delegate back with explanation
6. **Close the loop** — when work completes, notify the original delegator

### Multi-Agent Output Format

When showing delegation status:

```
**Delegated Items**

From Kate (research):
→ Amy: "Draft blog post from competitor analysis" (delegated 2h ago)

From Amy (content):
→ Brian: "Review blog post for tone and accuracy" (delegated 30m ago)

From James (dev):
→ Jason: "Deploy ELLIE-349 to production" (delegated yesterday, ⚠ overdue)
```

## Output Format

### Status Summary
```
**GTD Status**
- Inbox: 5 items (2 from today)
- Next Actions: 12 items (3 high priority)
- Waiting For: 4 items (1 overdue)
- Projects: 8 active
- Someday/Maybe: 23 items
```

### Item List
```
**Next Actions (12)**
1. [High] Call contractor about deck repair
2. [High] Review ELLIE-285 PR
3. [Medium] Order new keyboard
...
```

### Capture Confirmation
```
Added to inbox: "Review ELLIE-285 PR"
[View in GTD dashboard →]
```

## Edge Cases

**GTD API unavailable:**
→ "I can't reach the GTD system right now. Want me to remember this and add it when it's back?"

**Empty inbox:**
→ "Your inbox is clear — nice! 12 next actions ready to tackle."

**User declines capture:**
→ No problem, just remember it's in this conversation if you need it later.

**Ambiguous task description:**
→ Ask for clarification: "Want me to add that? What should I call it in your inbox?"

## Rules

- **Never auto-add to GTD without confirmation** (except in active mode with explicit user pattern)
- **Don't nag** — max 1 nudge per conversation about inbox processing
- **Respect list boundaries** — inbox is for unprocessed, next_actions for ready-to-do
- **Priority signals matter** — surface high-priority items when relevant
- **Be a coach, not a taskmaster** — suggest, don't demand
- **Context is key** — when surfacing GTD items, explain why they're relevant

## Integration with Other Modules

- **Forest** — When adding task to GTD, check if related Forest entries exist for context
- **Calendar** — Cross-reference next actions with calendar events
- **Briefing** — Include GTD status in morning briefing
- **Alerts** — Escalate overdue high-priority items as alerts

## Testing

Verify with:
```bash
curl http://localhost:3001/api/gtd/summary
curl http://localhost:3001/api/gtd/next-actions
curl http://localhost:3001/api/gtd/team
```

## Orchestration Pattern (ELLIE-1141)

When coordinating multi-agent work, use GTD to track every dispatch.

### Creating orchestration items

1. **Parent item** — your tracking anchor:
   - `POST /api/gtd/items` with `is_orchestration: true`, `assigned_to: "ellie"`, `created_by: "ellie"`
   - Link to ticket: `source_ref: "ELLIE-XXX"`

2. **Child items** — one per agent dispatch:
   - `POST /api/gtd/items` with `parent_id: {parent}`, `assigned_agent`, `assigned_to: {agent_name}`, `created_by: "ellie"`, `is_orchestration: true`

3. **Question items** — when an agent needs Dave's input:
   - `POST /api/gtd/items` with `parent_id: {agent_item}`, `assigned_to: "dave"`, `created_by: {agent}`, `urgency: "blocking"`, `is_orchestration: true`
   - Narrate: "Brian has a question — check the dispatch panel"

### Handling answers

Answers appear in your working memory `context_anchors` as structured JSON:
```json
{"type": "agent_answer", "question_item_id": "...", "parent_item_id": "...", "agent": "brian", "answer": "..."}
```
Route the answer to the correct agent and resume their work.

### Tracking completion

- Parent auto-completes at API level — don't track this yourself
- When parent status is `done`: synthesize results, respond to Dave
- When parent status is `waiting_for`: some children failed — report and ask Dave

### Recovery after compaction

- Read: `GET /api/gtd/items?assigned_to=ellie&is_orchestration=true&status=open`
- Check children for each parent to see what's in flight
- `timed_out` / `failed` children need attention
- This is your source of truth — not the conversation history

### Narration

Proactively narrate key moments via `update_user`:
- "Dispatching Brian (critique) and James (tests)."
- "Brian has a blocking question — check the dispatch panel."
- "James is done. Still waiting on Brian."
- "Brian timed out. Retry or skip?"
- "All done. Here's the synthesis..."

---

**Time saved:** ~3 min per task capture, ~10 min per status check
**Frequency:** Daily (capture), Weekly (review)
**Value:** High — GTD is core to Dave's workflow
