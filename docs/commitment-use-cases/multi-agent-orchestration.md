# Multi-Agent Orchestration — Behavioral Use Case

**Use Case:** Dave talks to Ellie (general agent), Ellie contracts with specialist subagents via GTD, monitors progress, integrates results, and keeps Dave in the loop
**System:** GTD + Agent Router + Work Session API + Inter-Agent Request System
**Vision:** Replace sequential Dave↔Ellie↔VS Code↔critic dispatch with Dave↔Ellie(orchestrator)↔subagents pattern

---

## When This Use Case Applies

Trigger this workflow when:

- **User requests multi-step work requiring specialist expertise:** "Research X, then build Y, then review it"
- **User asks for analysis + implementation:** "Figure out the best approach for X and implement it"
- **User delegates a complex task:** "Get this done" (where "this" requires multiple agents)
- **User wants ongoing monitoring:** "Work on this and keep me posted"

**Do NOT trigger for:**
- Quick single-agent tasks (< 30 minutes, single domain)
- Direct dispatch to a specialist ("send this to dev", "ask research to find X")
- Status checks or read-only queries

---

## Core Distinction: Orchestration vs. Direct Dispatch

### Direct Dispatch (Old Pattern)

**When to use:**
- User explicitly names the agent: "send this to dev", "ask research to find X"
- Task is small (< 30 minutes), single-domain, and doesn't need tracking
- No ongoing monitoring or integration required

**How it works:**
1. General agent receives request
2. Routes to specialist via agent router
3. Specialist completes and responds
4. General agent relays result to user

**No GTD tracking, no work sessions, no progress updates.** Just pass-through routing.

---

### GTD Orchestration (New Pattern)

**When to use:**
- Task is complex (> 30 minutes), multi-step, or cross-domain
- User wants monitoring and progress updates
- Work may span multiple sessions or require iteration
- Result needs integration or synthesis

**How it works:**
1. General agent breaks work into GTD tasks
2. Creates GTD tasks with `delegated_to: <agent>` field
3. Monitors progress via GTD status checks
4. Integrates results when tasks complete
5. Keeps user informed with progress updates

**Full GTD tracking, work session logging, progress visibility.**

---

## Decision Tree: Orchestrate or Dispatch?

```
User makes a request
    │
    ├─ Does user explicitly name an agent? ──Yes──> Direct dispatch
    │                                      └─ No ──> Continue
    │
    ├─ Is the task < 30 minutes? ──Yes──> Direct dispatch
    │                            └─ No ──> Continue
    │
    ├─ Is the task single-domain? ──Yes──> Direct dispatch (if quick)
    │                            └─ No ──> Orchestrate
    │
    ├─ Does user want updates/monitoring? ──Yes──> Orchestrate
    │                                    └─ No ──> Dispatch or handle inline
    │
    └─ Multi-step or cross-domain? ──Yes──> Orchestrate
                                  └─ No ──> Dispatch or handle inline
```

**Golden rule:** If it needs tracking or spans multiple agents, orchestrate via GTD. If it's quick and targeted, direct dispatch.

---

## Dispatch Mechanism — Agent Tool (PRIMARY)

**CRITICAL:** For all specialist dispatch (including orchestration), use the **Agent tool** — never use `/api/orchestration/dispatch`.

### Why the Agent Tool

Using the Agent tool ensures:
- **Real-time visibility:** Dave sees all specialist work bubbling up in the conversation
- **Integrated results:** Agent outputs appear inline, not isolated
- **Natural flow:** Work feels like a conversation, not a black box
- **Progress transparency:** User can see agent thinking, tool usage, and intermediate results
- **Context preservation:** Agent has full conversation history and can ask clarifying questions

### How to Dispatch via Agent Tool

```
Agent tool invocation:
- description: "Work on ELLIE-922 critical issues"
- prompt: "Fix the 3 critical race conditions in ELLIE-922: concurrent checkpoint race (add PostgreSQL advisory locks), non-atomic snapshot creation (wrap in transaction), and verification race with agent updates (add safeguard_locked flag)."
- subagent_type: "dev"
```

The agent runs in the conversation context, and Dave sees progress updates, code changes, and results in real-time.

### What NOT to Use

❌ **NEVER use `/api/orchestration/dispatch`** — This is a **legacy endpoint** that is **deprecated for orchestration workflows**.

**Why this is an anti-pattern:**

The `/api/orchestration/dispatch` endpoint was designed for **background/async work** (cron jobs, scheduled tasks, webhook handlers), not interactive orchestration. Using it in orchestration creates a "black box" that:

- **Hides agent progress** — User can't see what the agent is doing or if it's stuck
- **Breaks conversation context** — Agent can't reference prior messages or ask questions
- **Returns results asynchronously** — No visibility into when work completes
- **Makes debugging impossible** — Error messages don't surface to the user
- **Lacks progress updates** — User left wondering if anything is happening
- **No intervention path** — User can't provide input or course-correct mid-task

**When `/api/orchestration/dispatch` IS appropriate:**
- Scheduled background tasks (cron jobs, periodic cleanup)
- Webhook handlers (external API callbacks)
- Event-driven automation (database triggers, file watchers)
- Non-interactive batch processing

**For all interactive work (user-initiated, orchestrated, or requiring feedback), use the Agent tool exclusively.**

If you encounter code using `/api/orchestration/dispatch` for orchestration, flag it as a bug and refactor to use the Agent tool.

---

## Alternative: ELLIE:: Tag System (LEGACY)

The `ELLIE::` tag system is an older dispatch mechanism. Prefer the Agent tool for new work.

To dispatch work to specialist agents via tags, use the `ELLIE::` tag system in your responses. The relay parses these tags, strips them from the user-facing text, and executes the dispatch asynchronously.

### Available Dispatch Commands

**Single-Agent Dispatch:**
```
ELLIE:: send ELLIE-922 to dev
```
- Dispatches the dev agent to work on ticket ELLIE-922
- Use when a specialist should handle a specific work item
- Agent runs asynchronously; you'll be notified when complete

**Sequential Pipeline (Multi-Step):**
```
ELLIE:: pipeline ELLIE-922 dev→research→dev "implement→validate→finalize"
```
- Chains multiple agents in sequence
- Each agent's output becomes input for the next
- Step descriptions help agents understand their role in the chain

**Work Session Management:**
```
ELLIE:: start session on ELLIE-922 with dev
ELLIE:: check in on session ELLIE-922
ELLIE:: escalate ELLIE-922 to research "dev hit blocker on API design"
ELLIE:: handoff ELLIE-922 from dev to research "prototype complete, need production approach"
ELLIE:: pause session ELLIE-922 "waiting for API key from user"
ELLIE:: resume session ELLIE-922
```

**Ticket Management:**
```
ELLIE:: create ticket "Session Branching + Compaction Safeguards" "Adopt OpenClaw's compaction safeguard pattern..."
ELLIE:: close ELLIE-922 "Implemented snapshot, verification, and rollback with full test coverage"
```

### Dispatch Patterns by Use Case

**Single agent, straightforward task:**
```
ELLIE:: send ELLIE-144 to dev
```

**Research then implement:**
```
ELLIE:: pipeline ELLIE-155 research→dev "evaluate options→implement recommendation"
```

**Parallel work (use multiple tags in one response):**
```
ELLIE:: send ELLIE-200 to dev
ELLIE:: send ELLIE-201 to content
ELLIE:: send ELLIE-202 to ops
```

**Complex workflow with handoffs:**
```
ELLIE:: start session on ELLIE-300 with dev
# Later, when dev hits a blocker:
ELLIE:: escalate ELLIE-300 to research "need competitor analysis before proceeding"
# After research completes:
ELLIE:: handoff ELLIE-300 from research to dev "findings attached, ready for implementation"
```

---

## Orchestration Workflow

### 1. Task Decomposition

When the user requests complex work, break it into clear sub-tasks:

**User request:** "Research the best approach for user authentication, implement it, and document it."

**Decomposition:**
1. Research: Evaluate authentication options (OAuth2, JWT, session-based)
2. Dev: Implement chosen authentication approach
3. Dev: Write tests for auth flow
4. Content: Document authentication setup and usage
5. Critic: Review implementation for security issues

**Present the plan to the user:**
> I'll break this into 5 tasks:
>
> 1. **Research** — Evaluate authentication options (OAuth2, JWT, session-based)
> 2. **Dev** — Implement chosen authentication approach
> 3. **Dev** — Write tests for auth flow
> 4. **Content** — Document authentication setup and usage
> 5. **Critic** — Review implementation for security issues
>
> Sound good? I'll create GTD tasks and route them to the right agents.

**Get user approval before proceeding.**

---

### 2. GTD Task Creation

For each sub-task, create a GTD task with proper delegation:

```bash
POST http://localhost:3001/gtd/task
{
  "title": "Evaluate authentication options (OAuth2, JWT, session-based)",
  "context": "authentication",
  "effort": "medium",
  "delegated_to": "research",
  "delegated_by": "general",
  "work_item_id": "ELLIE-XXX",
  "scheduled_at": null
}
```

**Key fields for orchestration:**
- `delegated_to` — Target agent (research, dev, content, critic, strategy, ops)
- `delegated_by` — Always "general" (you're the orchestrator)
- `work_item_id` — Link to parent Plane ticket if applicable
- `effort` — quick (< 15 min), medium (15-60 min), deep (> 1 hour)
- `context` — Domain tag (authentication, payments, email, etc.)

**Sequence vs. parallel:**
- If tasks must happen in order, use `depends_on: [prior_task_id]`
- If tasks can run in parallel, omit dependencies

---

### 3. Agent Notification

Once GTD tasks are created, notify the target agents:

**Inter-Agent Request System:**
```bash
POST http://localhost:3001/api/inter-agent/request
{
  "from_agent": "general",
  "to_agent": "research",
  "task_id": "gtd-task-uuid",
  "request_type": "gtd_task",
  "priority": "normal",
  "message": "Evaluate authentication options (OAuth2, JWT, session-based)"
}
```

This creates a notification that the target agent will see when they next activate.

**Alternatively, for immediate dispatch:** If the task is urgent, use the agent router to dispatch directly (but still create the GTD task for tracking).

---

### 4. Progress Monitoring

Check in on delegated tasks periodically:

**How often:**
- High-priority tasks → Check daily
- Normal priority → Check every 2-3 days
- Low priority → Check weekly

**How to check:**
```bash
GET http://localhost:3001/gtd/task?delegated_to=research&status=active
```

This shows all active tasks delegated to the research agent.

**What to look for:**
- Tasks marked `done` → Integrate results
- Tasks marked `blocked` → Escalate to user or unblock
- Tasks with no updates for 3+ days → Ping the agent

---

### 5. Result Integration

When a delegated task completes, the specialist agent marks it `done` and adds notes:

**Example:**
```
Task: Evaluate authentication options
Status: done
Completed by: research
Notes:
  Recommendation: OAuth2 via Google/GitHub providers
  Reasoning: Most secure, best UX, lowest maintenance burden
  Alternatives considered: JWT (stateless but harder to revoke), session-based (simpler but less scalable)
  Implementation guide: See attached document
```

**General agent (you) integrates this:**
1. Read the task notes
2. Summarize findings for the user
3. Propose next steps (implement the recommendation, or ask follow-up questions)

**Example response to user:**
> Research agent finished evaluating authentication options. Recommendation:
>
> **OAuth2 via Google/GitHub providers** — most secure, best UX, lowest maintenance burden.
>
> Alternatives considered:
> - JWT (stateless but harder to revoke)
> - Session-based (simpler but less scalable)
>
> Want me to dispatch the implementation to dev now, or review the full analysis first?

---

### 6. User Updates

Keep the user informed at key milestones:

**When to update:**
- After creating the task breakdown (show the plan)
- When a major task completes (summarize results)
- When a blocker emerges (explain the issue and ask for input)
- When the full workflow completes (deliver final result)

**What NOT to do:**
- Don't spam updates for every small step
- Don't update until you have something meaningful to share
- Don't leave the user in the dark for 3+ days on high-priority work

---

### 7. Completion & Close-Out

When all sub-tasks are done:

1. **Synthesize results:**
   - Integrate findings from research
   - Confirm implementation from dev
   - Summarize docs from content
   - Address issues from critic

2. **Deliver final result:**
   - Present the completed work to the user
   - Highlight key decisions and trade-offs
   - Surface any open questions or follow-ups

3. **Mark parent work item complete** (if applicable):
   - If this was part of a Plane ticket, mark it Done
   - If this was a standalone request, confirm completion

4. **Log to Forest:**
   - Write key decisions and findings to Forest for future reference
   - Tag with relevant context (work_item_id, agent roles, outcome)

---

## Agent Roles & Expertise

| Agent | Specialization | Typical Tasks |
|-------|---------------|--------------|
| **research** | Data gathering, web searches, evidence analysis | "Find X", "Compare Y and Z", "What are the options for W" |
| **dev** | Code, schemas, APIs, migrations, tests | "Implement X", "Fix bug in Y", "Build Z" |
| **content** | Writing, documentation, user-facing text | "Write docs for X", "Draft a guide", "Create README" |
| **strategy** | Planning, roadmaps, architectural design | "Plan approach for X", "Design Y system", "Think through Z" |
| **critic** | Review, quality checks, pre-ship validation | "Review PR", "Check for issues", "Validate before ship" |
| **ops** | Infrastructure, deployments, monitoring | "Deploy X", "Check if Y is running", "Fix Z service" |
| **finance** | Expense tracking, budget analysis, financial reporting | "Track spending", "Analyze budget", "Report on X category" |
| **general** | Coordination, conversation, routing, GTD orchestration | Everything else (default) |

---

## Delegation Patterns

### Sequential Delegation (Waterfall)

**Pattern:** Task B depends on Task A output.

**Example:** Research → Dev → Content → Critic

```
1. Research: Evaluate authentication options
2. Dev: Implement recommended approach (depends on #1)
3. Content: Document implementation (depends on #2)
4. Critic: Review for security issues (depends on #2)
```

**Implementation:**
- Use `depends_on` field in GTD tasks
- Agent B can't start until Agent A completes

---

### Parallel Delegation (Fan-Out)

**Pattern:** Multiple tasks can run simultaneously.

**Example:** Epic with independent sub-tasks

```
ELLIE-914: Enhanced GTD Multi-Agent System
├─ ELLIE-915: Schema changes (dev) ──┐
├─ ELLIE-916: API endpoints (dev) ────┤──> All can run in parallel
├─ ELLIE-917: Auto-classification (dev)┤
├─ ELLIE-918: Waiting-for logic (dev)──┘
└─ ELLIE-924: Documentation (content) ──> Also parallel
```

**Implementation:**
- Create all GTD tasks at once
- No dependencies between them
- All agents work simultaneously
- General agent monitors and integrates when all complete

---

### Iterative Delegation (Feedback Loop)

**Pattern:** Task output requires review and revision.

**Example:** Content → Critic → Content → Critic → Done

```
1. Content: Draft user guide
2. Critic: Review for clarity and completeness
3. Content: Revise based on feedback (depends on #2)
4. Critic: Final review (depends on #3)
```

**Implementation:**
- Create initial task for Content
- Critic completes review, marks task `blocked` with feedback
- General agent creates follow-up task for Content with revision instructions
- Repeat until Critic approves

---

## Edge Cases & Exceptions

### Agent Doesn't Respond

**Q:** GTD task delegated to research, but no progress after 3 days.
**A:** Ping the agent via inter-agent request:
```bash
POST /api/inter-agent/request
{
  "from_agent": "general",
  "to_agent": "research",
  "request_type": "status_check",
  "message": "Checking in on task: Evaluate authentication options. Any blockers?"
}
```

If still no response after 2 more days, escalate to user: "Research hasn't responded on task X — want me to take it over or reassign?"

---

### Task Blocked by External Dependency

**Q:** Dev agent marks task `blocked` with note: "Waiting for user to clarify scope."
**A:** Surface the blocker to the user:
> Dev agent hit a blocker on task "Implement authentication":
>
> **Blocker:** Waiting for you to clarify scope — should this support multi-factor auth (MFA) or just basic OAuth2?
>
> Want to provide input now, or should we defer MFA to a follow-up ticket?

---

### User Changes Requirements Mid-Workflow

**Q:** User says "Actually, skip the OAuth2 approach — let's use JWT instead."
**A:** Update the workflow:
1. Mark current dev task as `cancelled` in GTD
2. Update research task notes with the new direction
3. Create new dev task: "Implement JWT-based authentication"
4. Notify dev agent of the change
5. Confirm with user: "Got it — switching to JWT. I'll update the dev agent and we'll proceed from there."

---

### Multiple Agents Waiting on One Blocker

**Q:** Dev and content are both waiting for research to finish.
**A:** Prioritize research task:
1. Ping research: "This task is blocking 2 other agents — can you prioritize?"
2. Escalate to user if research is stuck
3. If research can't unblock quickly, consider interim solution (e.g., dev starts with placeholder, refines later)

---

## Anti-Patterns (What NOT to Do)

❌ **Orchestrating trivial tasks**
- Don't create GTD tasks for "Check if service is running" — just do it
- Orchestration is for complex, multi-step, cross-agent work

❌ **Over-delegating**
- Don't delegate everything — you (general) can handle simple tasks
- Only delegate when specialist expertise is truly needed

❌ **Under-monitoring**
- Don't dispatch tasks and forget about them
- Check in regularly, especially on high-priority work

❌ **Micromanaging specialists**
- Don't ping agents every hour for status updates
- Trust them to work and report blockers

❌ **Not integrating results**
- Don't just pass raw specialist output to the user
- Synthesize, summarize, and present coherently

❌ **Forgetting to close the loop**
- Don't leave tasks open after the user moves on
- Mark tasks `done` or `cancelled` to keep the GTD system clean

❌ **Creating GTD tasks without delegation**
- If you're creating a task for yourself (general), don't use `delegated_to`
- Delegation is specifically for routing to specialists

---

## Quick Reference: Orchestration Checklist

When the user requests complex work:

- [ ] Understand the request and identify required agents
- [ ] Break work into discrete sub-tasks
- [ ] Present the task breakdown to the user for approval
- [ ] Create GTD tasks for each sub-task with `delegated_to` field
- [ ] Notify target agents via inter-agent request system
- [ ] Monitor progress (check delegated tasks every 1-3 days)
- [ ] Integrate results as tasks complete
- [ ] Update user at key milestones
- [ ] Synthesize final deliverable when all tasks done
- [ ] Close out GTD tasks and parent work item
- [ ] Log key decisions and findings to Forest

---

## Integration with Other Systems

- **GTD:** Primary tracking system for orchestration — all delegated tasks live here
- **Plane:** Parent work items (ELLIE-XXX) link to GTD tasks via `work_item_id`
- **Work Sessions:** Specialists log progress via work session API as they work
- **Forest:** Key decisions and findings from orchestrated work get written to Forest
- **Inter-Agent Requests:** Used to notify and ping specialist agents
- **Agent Router:** Used for immediate dispatch when urgency requires it

---

## Measuring Success

**How do you know if orchestration is working well?**

**Good signs:**
- User asks "what's the status" and you have a clear answer
- Specialists complete tasks without needing to be nagged
- Work finishes faster than if user had to coordinate manually
- User says "just get it done" and you do

**Bad signs:**
- User asks "what's the status" and you don't know
- Tasks sit idle for days without progress
- User has to manually follow up with specialists
- Deliverables are fragmented (no integration or synthesis)

**Metrics to track:**
- Average time from delegation to completion per agent
- Number of tasks that go stale (no updates for 5+ days)
- User satisfaction with orchestrated workflows

---

**Version:** 1.0
**Last Updated:** 2026-03-19
**Author:** Ellie (general)
**Status:** Active use case — part of Commitment Framework
