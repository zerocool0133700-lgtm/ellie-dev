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

GTD runs at `http://localhost:3000/api/gtd`:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/gtd/items` | GET | List items (supports `?list=inbox|next_actions|waiting|someday|projects`) |
| `/api/gtd/items` | POST | Create new item |
| `/api/gtd/items/{id}` | PATCH | Update item (move between lists, mark complete, change priority) |
| `/api/gtd/items/{id}` | DELETE | Delete item |
| `/api/gtd/status` | GET | Summary counts for all lists |

## Conversational Triggers (Active Mode Only)

### Task Capture
When user mentions something they need to do:
- "I need to..." / "I should..." / "Don't let me forget..."
- "Remind me to..." / "Make sure I..."
- "Tomorrow I'll..." / "Next week I need to..."

**Response:**
> "Want me to add that to your GTD inbox? [Yes/No]"

If yes, POST to `/api/gtd/items`:
```json
{
  "title": "extracted task description",
  "list": "inbox",
  "source": "ellie-chat",
  "notes": "optional context from conversation"
}
```

### Context Surfacing
When discussing a project or work area, check if there are related GTD items:
- Search `/api/gtd/items?list=next_actions&search={topic}`
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
| "show my inbox" / "what's in my inbox" | GET `/api/gtd/items?list=inbox`, display as list |
| "show next actions" | GET `/api/gtd/items?list=next_actions` |
| "what's waiting" | GET `/api/gtd/items?list=waiting` |
| "gtd status" | GET `/api/gtd/status`, show summary |
| "add task: {title}" | POST to `/api/gtd/items` |
| "mark {id} done" | PATCH `/api/gtd/items/{id}` with `status: "completed"` |
| "move {id} to next actions" | PATCH with `list: "next_actions"` |

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
curl http://localhost:3000/api/gtd/status
curl http://localhost:3000/api/gtd/items?list=inbox
```

---

**Time saved:** ~3 min per task capture, ~10 min per status check
**Frequency:** Daily (capture), Weekly (review)
**Value:** High — GTD is core to Dave's workflow
