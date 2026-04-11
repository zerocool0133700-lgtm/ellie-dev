# Plane Work Item Dispatch — Behavioral Use Case

**Use Case:** Orchestrating work items (ELLIE-XXX tickets) across agents
**System:** Plane MCP + Work Session API + Agent Router
**Technical Reference:** CLAUDE.md "Work Session Dispatch Protocol"

---

## When This Use Case Applies

Trigger this workflow when:

- **User starts work on a ticket:** "work on ELLIE-XXX", "implement ELLIE-XXX", "fix ELLIE-XXX"
- **User mentions a ticket in task context:** "let's tackle ELLIE-XXX today"
- **Multi-agent work is needed:** Epic with child tickets requiring parallel work
- **Handoff between agents:** Dev finishes implementation, needs research/review/content

**Do NOT trigger for:**
- Status checks ("what's the status of ELLIE-XXX") — just query Plane and report
- Reviews ("look at ELLIE-XXX") — read-only, no work session needed
- Casual mentions ("we might revisit ELLIE-XXX later")

---

## Work Session Lifecycle

### 1. Session Start

When the user says "work on ELLIE-XXX":

1. **Fetch the ticket from Plane:**
   ```
   mcp__plane__get_issue_using_readable_identifier("ELLIE", "XXX")
   ```

2. **Display ticket summary:**
   - Title
   - Description (first 2-3 sentences or key acceptance criteria)
   - Priority
   - Current state

3. **Move to In Progress** (if not already):
   ```
   mcp__plane__update_issue(project_id, issue_id, { state: "e551b5a8-8bad-43dc-868e-9b5fb48c3a9e" })
   ```

4. **Notify the relay** (creates work session + Telegram/Google Chat notification):
   ```bash
   POST http://localhost:3001/api/work-session/start
   {
     "work_item_id": "ELLIE-XXX",
     "title": "Ticket title",
     "project": "ellie-dev"
   }
   ```
   **Do NOT hardcode `"agent"` field** — the relay auto-detects which agent is active.

5. **Begin work** on the task.

---

### 2. Progress Updates

Post progress updates on **major milestones** (not every tool call):

**When to update:**
- Schema changes applied
- Feature implemented and tests passing
- Significant commit made
- Blocked or waiting on external input
- Major design decision made

**How to update:**
```bash
POST http://localhost:3001/api/work-session/update
{
  "work_item_id": "ELLIE-XXX",
  "message": "Brief description of what was done"
}
```

The relay finds the active session automatically.

---

### 3. Decision Logging

When you choose between approaches, log the decision:

**When to log:**
- Architectural choices (REST vs GraphQL, SQL vs NoSQL)
- Design patterns (event-driven vs polling, sync vs async)
- Trade-offs (performance vs simplicity, flexibility vs constraints)
- Scope decisions (MVP vs complete, defer vs ship now)

**How to log:**
```bash
POST http://localhost:3001/api/work-session/decision
{
  "work_item_id": "ELLIE-XXX",
  "message": "Decision: Using X approach because Y. Alternatives considered: A, B"
}
```

**Why this matters:** Future sessions need to know WHY you chose this path, not just WHAT you built.

---

### 4. Session Complete

When the work item is done (or you're pausing/handing off):

1. **POST completion:**
   ```bash
   POST http://localhost:3001/api/work-session/complete
   {
     "work_item_id": "ELLIE-XXX",
     "summary": "What was accomplished"
   }
   ```

2. **Update Plane:**
   - If fully complete → Move to Done (`41fddf8d-d937-4964-9888-b27f416dcafa`)
   - If blocked/paused → Leave In Progress or move to Todo
   - Add completion comment with the summary

3. **Commit with work item prefix:**
   ```
   [ELLIE-XXX] Brief description of change
   ```

4. **Push to remote** if the user asks.

The relay auto-updates Plane to Done and posts a summary to Telegram + Google Chat.

---

## Epic Orchestration

**Epic:** A parent ticket with multiple child tickets that can be worked on in parallel by different agents.

### When to Use Epics

Create an epic when:

1. **Large feature with multiple sub-components:** "Enhanced GTD Multi-Agent System" = schema + API + UI + docs
2. **Cross-agent coordination:** Dev, research, content, and critic all contributing
3. **Phased rollout:** Foundation, MVP, polish (each phase = child tickets)

### Epic Fan-Out Pattern

**Goal:** Dispatch all child tickets to agents simultaneously for parallel work.

**Steps:**

1. **User mentions the epic:** "Let's work on ELLIE-XXX (Epic Name)"

2. **Fetch the epic and all child tickets:**
   ```
   mcp__plane__get_issue_using_readable_identifier("ELLIE", "XXX")
   mcp__plane__list_project_issues with parent filter
   ```

3. **Analyze child tickets** — group by agent type:
   - Schema changes → dev
   - API implementation → dev
   - UI components → dev (or content if mockups needed)
   - Documentation → content
   - Testing/validation → critic

4. **Present the dispatch plan:**
   > **ELLIE-XXX: Epic Name**
   >
   > This epic has 7 child tickets. I can dispatch them in parallel:
   >
   > **Dev Agent:**
   > - ELLIE-XXX+1: Schema changes
   > - ELLIE-XXX+2: API endpoints
   > - ELLIE-XXX+3: UI implementation
   >
   > **Content Agent:**
   > - ELLIE-XXX+4: Documentation
   >
   > **Critic Agent:**
   > - ELLIE-XXX+5: Pre-ship validation
   >
   > Want me to dispatch all of these now, or should we sequence them?

5. **On approval, dispatch:**
   - Create a work session for each child ticket
   - Notify the relay for each session
   - Let agents work in parallel
   - Monitor progress via `GET /api/work-session/active`

**Coordination during parallel work:**
- Agents post progress updates independently
- If one agent blocks another, use `POST /api/work-session/update` to surface the blocker
- When all child tickets complete, the epic auto-completes

---

## Agent Selection

**Core principle:** Route work to the agent with the right expertise.

| Agent Type | Expertise | Route When |
|------------|-----------|-----------|
| **dev** | Code, schemas, APIs, migrations, tests | "Implement X", "Fix bug in Y", "Build Z" |
| **research** | Data gathering, web searches, evidence analysis | "Find out about X", "What are the options for Y", "Research Z" |
| **content** | Writing, documentation, user-facing text | "Write the docs for X", "Draft a guide", "Create a README" |
| **strategy** | Planning, roadmaps, architectural design | "Plan the approach for X", "Design the Y system", "Think through Z" |
| **critic** | Review, quality checks, pre-ship validation | "Review this PR", "Check for issues", "Validate before ship" |
| **ops** | Infrastructure, deployments, monitoring | "Deploy X", "Check if Y is running", "Fix the Z service" |
| **general** | Coordination, GTD, conversation, routing | Default — everything else |

### Routing Decision Tree

```
User says "work on ELLIE-XXX"
    │
    ├─ Fetch ticket from Plane
    │
    ├─ Read ticket description
    │
    ├─ Does it require code/schema/API work? ──Yes──> Route to dev
    │                                        └─ No ──> Continue
    │
    ├─ Does it require research/analysis? ──Yes──> Route to research
    │                                     └─ No ──> Continue
    │
    ├─ Does it require writing/docs? ──Yes──> Route to content
    │                                └─ No ──> Continue
    │
    ├─ Does it require planning/strategy? ──Yes──> Route to strategy
    │                                     └─ No ──> Continue
    │
    ├─ Does it require review/validation? ──Yes──> Route to critic
    │                                     └─ No ──> Continue
    │
    └─ Default ──> general handles it
```

**If multiple agents are needed:**
- Break the work into sub-tasks (child tickets or GTD tasks)
- Route each sub-task to the appropriate agent
- General agent coordinates the handoffs

---

## Sub-Task Delegation

**Key question:** Should this be a **Plane sub-issue** or a **GTD task**?

### Use Plane Sub-Issues When:

1. **Work is substantial** (> 1 hour, `deep` effort)
2. **Work deserves its own ticket tracking** (comments, state transitions, history)
3. **Work is part of a larger epic** (needs to roll up to parent)
4. **Work may spawn follow-ups** (needs its own child tickets)

**Example:** ELLIE-914 (Epic) → ELLIE-915, 916, 917, 918, 919, 920, 921 (child issues)

### Use GTD Tasks When:

1. **Work is quick or medium effort** (< 1 hour)
2. **Work is a single action item** (no follow-ups expected)
3. **Work is agent-internal** (doesn't need external visibility)
4. **Work is a reminder or follow-up** (not a formal deliverable)

**Example:** "Update CLAUDE.md with ELLIE-914 notes" → GTD task, not Plane issue

### Mixed Approach

Some work items have both:
- **Plane ticket** = the formal work item (ELLIE-XXX)
- **GTD tasks** = the checklist of steps to complete it

**Example:**
- Plane ticket: ELLIE-920 (Calendar Sync Logic)
- GTD tasks:
  - Implement outbound sync (scheduled_at → Google Calendar)
  - Implement inbound sync (Google Calendar → GTD)
  - Add webhook/polling logic
  - Write tests

The GTD tasks reference `work_item_id: "ELLIE-920"` so they roll up to the Plane ticket.

---

## Progress Tracking

### How Often to Check In

**For your own work:**
- Update on major milestones (schema complete, feature shipped, blocker hit)
- Don't spam updates for every small step
- Log decisions when you make trade-offs

**For delegated work:**
- Check progress **once per day** if the work is time-sensitive
- Check progress **every 2-3 days** if the work is not urgent
- Don't nag — trust the agent to report blockers

**If an agent goes silent:**
- After 2 days on a high-priority ticket → ping them: "How's ELLIE-XXX coming?"
- After 5 days on any ticket → escalate to user: "ELLIE-XXX hasn't had updates — want me to check in?"

### Monitoring Active Sessions

Use the work session API to track active work:

```bash
GET http://localhost:3001/api/work-session/active
```

This shows all active sessions across all agents. Use it to:
- Detect stale sessions (no updates in 48+ hours)
- See who's working on what
- Identify blockers

---

## Completion Criteria

**How do you know when a ticket is truly done?**

### Definition of Done

A ticket is done when:

1. **Acceptance criteria met** — all requirements from the ticket description are satisfied
2. **Tests pass** (for code work) — no failing tests, new tests added for new features
3. **Docs updated** (if relevant) — README, CLAUDE.md, or skills updated
4. **User approved** — if the user needs to review, get explicit approval before marking Done
5. **Deployed or merged** (if applicable) — code is live, not just committed locally

### Incomplete Work

If you can't complete the ticket fully:

- **Move back to Todo** if you haven't started meaningful work
- **Leave In Progress** if work is underway but blocked
- **Comment on the ticket** with what's done and what's left
- **Create follow-up tickets** for deferred items

**Example:**
> **ELLIE-914 Comment:**
> Shipped as MVP with effort, contexts, waiting-for, and reference fields. Deferred to follow-up tickets:
> - ELLIE-922: Calendar toggle UI
> - ELLIE-923: Calendar sync logic
> - ELLIE-924: Update GTD skill docs

---

## Git Workflow

### Commit Message Format

```
[ELLIE-{id}] Brief description of change
```

**Examples:**
- `[ELLIE-914] Enhanced GTD Multi-Agent System — effort, contexts, calendar, reference`
- `[ELLIE-920] Calendar sync logic — outbound and inbound sync`

**Rules:**
- Always prefix with `[ELLIE-{id}]`
- Keep the summary under 72 characters (after the prefix)
- Use present tense ("Add feature", not "Added feature")

### Branch Strategy

**For small tickets (< 2 hours work):**
- Work directly on `master` (or `main`)
- Commit and push when done

**For large tickets (> 2 hours work):**
- Create a feature branch: `git checkout -b ELLIE-XXX-short-name`
- Commit work incrementally
- Open a PR when ready
- Merge after review

**For epics:**
- Each child ticket can be its own branch OR
- All child tickets work on the same epic branch, then merge once

---

## Inter-Agent Handoffs

When one agent finishes and another needs to continue:

### Handoff Protocol

1. **Complete your portion:**
   - Commit your work with `[ELLIE-XXX]` prefix
   - Document what you did in the work session summary

2. **Update the ticket:**
   - Add a comment: "Dev work complete. Ready for [next agent]."
   - Change assignee (if applicable)

3. **Notify via work session API:**
   ```bash
   POST http://localhost:3001/api/work-session/update
   {
     "work_item_id": "ELLIE-XXX",
     "message": "Dev portion complete. Handing off to content agent for docs."
   }
   ```

4. **Next agent picks it up:**
   - Fetch the ticket from Plane
   - Read the prior work session updates
   - Start a new work session for their portion

**Example flow:**
1. Dev implements feature → commits, posts update
2. Content writes docs → commits, posts update
3. Critic reviews → approves or sends back
4. General marks ticket Done

---

## Edge Cases & Exceptions

### Ticket Doesn't Exist

**Q:** User says "work on ELLIE-999" but it doesn't exist.
**A:** Report it: "ELLIE-999 doesn't exist in Plane. Want me to create it, or did you mean a different ticket?"

### Ticket Already Done

**Q:** User says "work on ELLIE-XXX" but it's already marked Done.
**A:** Confirm: "ELLIE-XXX is already marked Done in Plane. Want to reopen it, or is there a follow-up ticket?"

### Multiple Agents on One Ticket

**Q:** Can multiple agents work on the same ticket simultaneously?
**A:** Yes, if the work is clearly separable (e.g., dev does schema, content does docs). Post updates independently. General coordinates completion.

### Stuck or Blocked

**Q:** Work session is active but agent is stuck.
**A:** Post a blocker update:
```bash
POST http://localhost:3001/api/work-session/update
{
  "work_item_id": "ELLIE-XXX",
  "message": "BLOCKED: Waiting for user to clarify scope. Can't proceed without input."
}
```

The user will see this on Telegram + Google Chat and can unblock.

---

## Anti-Patterns (What NOT to Do)

❌ **Starting work without notifying the relay**
- Always call `POST /api/work-session/start` when beginning ticket work
- This creates the session record and notifies the user

❌ **Marking Done without completing acceptance criteria**
- Don't mark Done if tests are failing or docs are missing
- Incomplete = leave In Progress or move to Todo

❌ **Over-updating**
- Don't post a work session update for every tool call
- Only update on major milestones

❌ **Under-updating**
- Don't go silent for 3+ days on a high-priority ticket
- Post progress even if incremental ("50% done, schema complete")

❌ **Forgetting to log decisions**
- If you chose approach X over Y, log it
- Future sessions need to know WHY

❌ **Not linking commits to tickets**
- Always use `[ELLIE-XXX]` prefix in commit messages
- Makes git history searchable by ticket

❌ **Completing without pushing**
- If code work is done, push to remote before marking Done
- User expects work to be in the repo, not just local

---

## Quick Reference: Dispatch Checklist

When starting work on a ticket:

- [ ] Fetch ticket from Plane
- [ ] Display ticket summary to user
- [ ] Move ticket to In Progress (if not already)
- [ ] POST to `/api/work-session/start`
- [ ] Begin work
- [ ] Post progress updates on milestones
- [ ] Log decisions when choosing approaches
- [ ] Commit with `[ELLIE-XXX]` prefix
- [ ] Update Plane ticket with completion comment
- [ ] POST to `/api/work-session/complete`
- [ ] Move ticket to Done (if fully complete)

---

## Integration with Other Systems

- **GTD:** Create GTD tasks for sub-steps of a Plane ticket
- **Forest:** Log architectural decisions and findings from ticket work to Forest
- **Work Sessions:** All ticket work creates a work session (tracked in Supabase)
- **GitHub:** Commits reference tickets, PRs link to Plane issues

---

**Version:** 1.0
**Last Updated:** 2026-03-19
**Author:** Ellie (general)
**Status:** Active use case — part of Commitment Framework
