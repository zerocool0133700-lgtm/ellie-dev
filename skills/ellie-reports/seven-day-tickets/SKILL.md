---
name: seven-day-tickets
description: Pull a 7-day activity report from Plane showing all tickets with recent updates, grouped by state and priority
triggers:
  - "seven day report"
  - "7 day tickets"
  - "what happened this week"
  - "ticket activity report"
requirements:
  - mcp: mcp__plane__*
  - env: PLANE_API_KEY
---

# Seven-Day Ticket Report

Pull all Plane tickets with activity in the last 7 days, grouped by state and priority.

## Purpose

This skill gives you a weekly snapshot of work movement — what's been completed, what's in progress, what's stuck. Use it for weekly reviews, standups, or just checking momentum.

## Workflow

### Step 1: Calculate Date Range

```javascript
const endDate = new Date();
const startDate = new Date();
startDate.setDate(startDate.getDate() - 7);
```

Convert to ISO strings for the Plane API filter.

### Step 2: Fetch All Issues

Use `mcp__plane__list_project_issues` with:
- `project_id`: `7194ace4-b80e-4c83-8042-c925598accf2`
- Filter: `updated_at__gte` = `startDate`

### Step 3: Map State IDs to Names

Plane returns state UUIDs. Map them:
- `f3546cc1-69ed-4af9-8350-5e3b1b22a50e` → Backlog
- `92d0bdb9-cc96-41e0-b26f-47e82ea6dab8` → Todo
- `e551b5a8-8bad-43dc-868e-9b5fb48c3a9e` → In Progress
- `41fddf8d-d937-4964-9888-b27f416dcafa` → Done
- `3273d02b-7026-4848-8853-2711d6ba3c9b` → Cancelled

### Step 4: Group and Count

Group tickets by:
1. **State** (Done, In Progress, Todo, Backlog, Cancelled)
2. **Priority** (urgent, high, medium, low, none)

Count totals for each group.

### Step 5: Format Output

Present in this structure:

```
## Seven-Day Ticket Report
**Date Range:** [start] to [end]
**Total Tickets:** [count]

### By State
- [count] Done
- [count] In Progress
- [count] Todo
- [count] Backlog
- [count] Cancelled

### By Priority
- [count] urgent
- [count] high
- [count] medium
- [count] low
- [count] none

### Most Recently Updated (Top 15)
[Ticket ID]  [State]  [Priority]  [Title]
...
```

### Step 6: Save Raw Data

Write the full JSON to `/tmp/seven-day-report.json` for later analysis.

Tell the user where the file is saved so they can dig into it if needed.

## Rules

- Always pull exactly 7 days — no more, no less
- If no tickets match, say "No activity in the last 7 days" (don't fail)
- Sort "Most Recently Updated" by `updated_at` descending
- Limit "Most Recently Updated" to 15 tickets (keeps output scannable)
- Include all states, even if count is 0 (shows nothing was missed)

## Edge Cases

**No PLANE_API_KEY set:**
→ Tell the user: "Plane integration not configured. Set PLANE_API_KEY in .env."

**Plane API returns error:**
→ Show the error message, suggest checking workspace/project settings.

**Empty result set:**
→ "No tickets were updated in the last 7 days."

## Future Extensions

This is the baseline. Later iterations may add:
- State transition history (Backlog → In Progress → Done)
- Velocity charts (tickets completed per day)
- Correlations (which tickets are blocked, which move fast)
- Deep dives (drill into a specific state or priority)

For now: **Get the data. See what it is. Move on.**
