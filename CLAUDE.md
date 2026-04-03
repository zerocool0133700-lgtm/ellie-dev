# Ellie Chat Relay — Operations Guide

> Claude Code reads this file automatically. It defines how agents work with this codebase.

## What This Is

The Ellie Chat Relay is Ellie's brain — an HTTP/WebSocket server that powers Ellie Chat and adapts to messaging channels (Telegram, Google Chat, Discord, Slack). The HTTP/WebSocket side is primary. The bot integrations are adapters.

## Channel Priority

Ellie Chat is the primary experience. Every feature, every agent interaction, every tool — available in Ellie Chat without restriction. This is where the full rich experience lives: dispatch container cards, the inquiry mechanism, real-time agent activity.

**When building something new:**
1. Design for Ellie Chat first
2. Ask: "What's the Telegram-appropriate version?" second
3. Adapter channels (Google Chat, Discord, Slack) get what makes sense for their medium

**No feature should be Telegram-only.** If it exists in Telegram, it exists in Ellie Chat. Telegram gets text summaries and inline buttons. Ellie Chat gets the full UI.

---

## First-Time Setup

For setting up a new relay instance from scratch, see [docs/setup-guide.md](docs/setup-guide.md).

## Channel Adapters

The relay connects to multiple messaging channels. Each is optional and configured via environment variables.

| Channel | Type | Config Required | Handler |
|---------|------|----------------|---------|
| **Ellie Chat** | WebSocket (primary) | Always on | `src/ellie-chat-handler.ts` |
| **Telegram** | Long-polling adapter | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_USER_ID` | `src/telegram-handlers.ts` |
| **Google Chat** | Webhook adapter | `GOOGLE_CHAT_SERVICE_ACCOUNT_KEY_PATH` | `src/google-chat.ts` |
| **Discord** | Bot adapter | `DISCORD_BOT_TOKEN` | `src/channels/discord/` |
| **Slack** | Bot adapter | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` | `src/channels/slack/` |

For detailed channel setup instructions, see [docs/setup-guide.md](docs/setup-guide.md).

---

## Work Session Dispatch Protocol

> **For the project owner (Dave).** If `.env` has `PLANE_API_KEY` set and Plane MCP is available, this protocol is active. Otherwise, skip this section — it does not apply to first-time setup users.

### IMPORTANT: When to Use This Protocol

**USE** this protocol when Dave explicitly asks to **work on**, **implement**, **fix**, **build**, or **code** something.

**DO NOT USE** this protocol for:
- Status checks ("check on ELLIE-5", "what's the status of 139")
- Information queries ("what is ELLIE-5 about?", "show me the ticket")
- Reviews ("look at ELLIE-5", "review the work on 139")

For status checks, just use `mcp__plane__get_issue_using_readable_identifier` to fetch and display the ticket — do NOT call `/api/work-session/start`, `/api/work-session/complete`, or update the Plane issue state.

## Session Startup

When Dave starts a Claude Code session and mentions a work item (e.g., "work on ELLIE-5") or asks to work on something:

1. **Fetch the work item** using Plane MCP:
   ```
   mcp__plane__get_issue_using_readable_identifier("ELLIE", "5")
   ```

2. **Display the work item** — title, description summary, priority, and acceptance criteria.

3. **Move the issue to In Progress** in Plane:
   ```
   mcp__plane__update_issue(project_id, issue_id, { state: "<started-state-id>" })
   ```

4. **Notify the relay** so Dave sees it on Telegram:
   ```bash
   POST http://localhost:3001/api/work-session/start
   {
     "work_item_id": "ELLIE-5",
     "title": "Implement Claude Code Work Session Dispatch Protocol",
     "project": "ellie-dev"
   }
   ```
   The relay auto-detects which agent is active from the routing system. Do NOT hardcode `"agent": "dev"` — the relay resolves this from the active agent session. Only pass `"agent"` if you need to override the auto-detection.
   The relay creates the session record and returns `session_id` in the response.

5. **Begin work** on the task.

If Dave doesn't mention a specific work item, ask:
> Are you working on a defined work item from Plane? I can fetch open items, or we can work without one.

## During Work

### Progress Updates
On **major milestones** (schema changes, feature complete, significant commits), POST to the relay:

```bash
POST http://localhost:3001/api/work-session/update
{
  "work_item_id": "ELLIE-5",
  "message": "Brief description of what was done"
}
```

The relay finds the active session for the work item automatically.

### Decision Logging
When choosing between approaches, log the decision:

```bash
POST http://localhost:3001/api/work-session/decision
{
  "work_item_id": "ELLIE-5",
  "message": "Decision: Using X approach because Y. Alternatives considered: A, B"
}
```

## Session Complete

When the work item is done (or the session ends):

1. **POST completion** to the relay:
   ```bash
   POST http://localhost:3001/api/work-session/complete
   {
     "work_item_id": "ELLIE-5",
     "summary": "What was accomplished"
   }
   ```
   The relay marks the session complete, updates Plane to Done, and posts a summary to Telegram.

2. **Update Plane issue** — move to Done (if completed) or leave In Progress (if blocked/paused). Add a completion comment with the summary.

3. **Commit with work item prefix:**
   ```
   [ELLIE-5] Brief description of change
   ```

4. **Push to remote** if Dave asks.

## Git Workflow

### Commit Messages
```
[ELLIE-{id}] Brief description of change
```

### Pre-commit
- Run type checks if available
- Ensure no `.env` or secrets are staged
- Reference the work item ID in the commit

## UI Development Workflow

When working on UI code in the `ellie-home` project:

1. **After editing any UI files** (`.vue`, `.ts`, `.js`, `.css` in `ellie-home/`):
   - Always rebuild: `cd /home/ellie/ellie-home && bun run build`
   - Or restart the dev server if running in dev mode: `bun run dev`

2. **Remind the user to hard refresh** their browser:
   - Chrome/Firefox: `Ctrl+Shift+R` (Linux/Windows) or `Cmd+Shift+R` (macOS)
   - This clears the browser cache and loads the latest version

3. **Common mistake:** Editing UI files but forgetting to rebuild means changes won't appear to the user, even though the code was modified.

**ALWAYS** mention the rebuild step when completing UI changes, not just when the user reports "it's not working."

## Plane Reference

- **Workspace:** evelife
- **Project identifier:** ELLIE
- **Project UUID:** 7194ace4-b80e-4c83-8042-c925598accf2
- **Base URL:** https://plane.ellie-labs.dev

### State IDs
- Backlog: `f3546cc1-69ed-4af9-8350-5e3b1b22a50e`
- Todo: `92d0bdb9-cc96-41e0-b26f-47e82ea6dab8`
- In Progress: `e551b5a8-8bad-43dc-868e-9b5fb48c3a9e`
- Done: `41fddf8d-d937-4964-9888-b27f416dcafa`
- Cancelled: `3273d02b-7026-4848-8853-2711d6ba3c9b`

## Relay API Reference

All endpoints at `http://localhost:3001`:

| Endpoint | Purpose |
|----------|---------|
| `POST /api/work-session/start` | Log session initiation, notify Telegram |
| `POST /api/work-session/update` | Progress/decision/milestone/blocker updates |
| `POST /api/work-session/decision` | Architectural decision with reasoning |
| `POST /api/work-session/complete` | Session completion, Plane state update |

---

## Forest Bridge Protocol

> Feed the forest. As you work, write discoveries, decisions, and findings to the knowledge tree so future sessions can build on them.

### Bridge Key

```
x-bridge-key: bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a
```

### When to Write

Write to the bridge on **significant learnings** — not every small step, but things future sessions would benefit from knowing:

- **Decisions** (`type: "decision"`) — architectural choices with reasoning ("Chose X over Y because Z")
- **Findings** (`type: "finding"`) — discoveries about the codebase, gotchas, patterns ("postgres.js sql.array() is for ANY(), not INSERTs")
- **Facts** (`type: "fact"`) — stable truths about the system ("Relay listens on port 3001, dashboard on 3000")
- **Hypotheses** (`type: "hypothesis"`) — educated guesses that need validation

### How to Write

```bash
curl -s -X POST http://localhost:3001/api/bridge/write \
  -H "x-bridge-key: bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Description of what was learned",
    "type": "decision",
    "scope_path": "2/1",
    "work_item_id": "ELLIE-177"
  }'
```

### Scope Paths

Pick the most specific scope that fits:

| Path | Name | Use for |
|------|------|---------|
| `2` | Projects | Cross-project knowledge |
| `2/1` | ellie-dev | Relay, agents, integrations |
| `2/2` | ellie-forest | Forest lib, DB, migrations |
| `2/3` | ellie-home | Dashboard, Nuxt, themes |
| `2/4` | ellie-os-app | Mobile/desktop app |

Sub-scopes exist under each project (e.g. `2/1/1` = agents, `2/1/2` = finance). Use `/api/bridge/scopes` to browse.

### How to Read (pull context before working)

```bash
# Semantic search
curl -s -X POST http://localhost:3001/api/bridge/read \
  -H "x-bridge-key: bk_d81869ef..." \
  -H "Content-Type: application/json" \
  -d '{"query": "how does the agent router work", "scope_path": "2/1"}'

# List recent memories in a scope
curl -s "http://localhost:3001/api/bridge/list?scope_path=2/1&limit=10" \
  -H "x-bridge-key: bk_d81869ef..."
```

### Guidelines

- Write **after** completing a task or making a decision, not while still exploring
- Keep content concise but self-contained — future sessions won't have your context
- Include `work_item_id` when the knowledge relates to a specific ticket
- Don't duplicate what's already in CLAUDE.md — the bridge is for dynamic knowledge

## Skills System (ELLIE-217)

Agent capabilities are defined as `SKILL.md` files in `skills/*/SKILL.md`. Each has YAML frontmatter (name, triggers, requirements) and markdown instructions injected into agent prompts.

- **Location:** `skills/` (bundled), `~/.ellie/skills/` (personal), `<workspace>/skills/` (project overrides)
- **Core modules:** `src/skills/` — loader, eligibility, snapshot, commands, watcher
- **Always-on skills:** `briefing` (Forest pre-work search), `forest` (knowledge library)
- **Env-gated skills:** `plane`, `github`, `google-workspace`, `miro`, `memory`
- **Hot-reload:** Edit any SKILL.md and the relay picks it up automatically
- **Slash commands:** User-invocable skills become `/command` (e.g., `/plane list issues`)

To add a new skill: create `skills/<name>/SKILL.md` with frontmatter + instructions.

## Project Architecture

### Working Memory — Session-Scoped Context (ELLIE-538/539)

Working memory is a session-scoped document that survives context compression. It lives in the `working_memory` table (Forest DB) and is injected into every agent prompt automatically.

**7 sections** (all optional strings, updated as work progresses):
- `session_identity` — agent name, ticket ID, channel
- `task_stack` — ordered todo list with active task highlighted
- `conversation_thread` — narrative summary (not a transcript)
- `investigation_state` — hypotheses, files read, current exploration
- `decision_log` — choices made with reasoning
- `context_anchors` — must-survive details (exact error messages, line numbers, values)
- `resumption_prompt` — continuation note written for your future self

**API** (all at `http://localhost:3001/api/working-memory/`):

| Endpoint | Method | Body | Purpose |
|----------|--------|------|---------|
| `init` | POST | `{ session_id, agent, sections?, channel? }` | Start/reinit session |
| `update` | PATCH | `{ session_id, agent, sections }` | Merge section updates |
| `read` | GET | `?session_id=&agent=` | Fetch active record |
| `checkpoint` | POST | `{ session_id, agent }` | Increment turn counter |
| `promote` | POST | `{ session_id, agent, scope_path?, work_item_id? }` | Archive + write decisions to Forest |

**Prompt injection** (ELLIE-539):
- `resumption_prompt` is **always injected** at priority 2 (between soul and protocols)
- Full working memory injected on demand when `fullWorkingMemory: true` passed to `buildPrompt()`
- Cache set via `setWorkingMemoryCache(agent, record)` before each prompt build
- Tests use `_injectWorkingMemoryForTesting(agent, sections)` to control cache state

**Write protocol for agents:**
- Update working memory after **meaningful actions**: task changes, decisions, findings
- Refresh `conversation_thread` every **3–5 turns** (narrative summary, not transcript)
- Update `context_anchors` whenever you encounter a critical detail (error message, exact line number, specific value) that must survive context compression
- Update `resumption_prompt` when pausing or completing a sub-task — write it for your future self
- **Do NOT** update after every tool call — only on meaningful state changes

---

### River Vault — Prompt Architecture (ELLIE-532/537)

All agent prompt content (soul, memory-protocol, confirm-protocol, forest-writes, dev/research/strategy-agent-template, playbook-commands, work-commands, planning-mode) lives in the **River Obsidian vault** (`/home/ellie/obsidian-vault/`), synced to Ellie via `src/bridge-river.ts` (QMD endpoint).

- Prompts are fetched at runtime via a stale-while-revalidate cache (`getCachedRiverDoc(key)`)
- When a River doc is unavailable, the section is **omitted entirely** — no hardcoded fallback (ELLIE-537)
- Use `_injectRiverDocForTesting(key, content)` in tests to control cache state without hitting QMD
- Doc keys: `soul`, `memory-protocol`, `confirm-protocol`, `forest-writes`, `dev-agent-template`, `research-agent-template`, `strategy-agent-template`, `playbook-commands`, `work-commands`, `planning-mode`

To edit prompts: open the River vault in Obsidian, edit the relevant `.md` file — changes propagate to the relay automatically.

---

### Agent MCP Access Matrix

Each agent has different tool and MCP access based on their role. This matrix defines which MCPs each agent should use:

| MCP | Ellie (General) | James (Dev) | Kate (Research) | Alan (Strategy) | Brian (Critic) | Amy (Content) | Marcus (Finance) | Jason (Ops) |
|-----|----------------|-------------|-----------------|-----------------|----------------|---------------|-----------------|-------------|
| **Google Workspace** | | | | | | | | |
| - Gmail | ✅ [CONFIRM:] | ❌ | ⚠️ [CONFIRM:] | ⚠️ Docs only | ❌ | ✅ [CONFIRM:] | ❌ | ❌ |
| - Calendar | ✅ [CONFIRM:] | ❌ | ❌ | ✅ Roadmaps | ❌ | ❌ | ❌ | ❌ |
| - Tasks | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| - Drive | ✅ | ⚠️ Docs only | ✅ Reports | ✅ Strategy docs | ❌ | ✅ Content | ⚠️ Sheets (future) | ⚠️ Runbooks |
| - Docs | ✅ | ⚠️ Read-only | ✅ Reports | ✅ Strategy docs | ❌ | ✅ Content | ❌ | ⚠️ Runbooks |
| - Sheets | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️ (future) | ❌ |
| - Contacts | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **GitHub** | ⚠️ Status only | ✅ Full | ❌ | ⚠️ Read-only | ✅ PRs/reviews | ❌ | ❌ | ✅ Deploys |
| **Plane** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Brave Search** | ✅ | ✅ | ✅ Core | ✅ Markets | ❌ | ✅ Content | ❌ | ✅ Ops tools |
| **Miro** | ❌ | ❌ | ⚠️ Optional | ✅ Diagrams | ❌ | ⚠️ Visuals | ❌ | ❌ |
| **Forest Bridge** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **QMD (River)** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Memory** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Sequential Thinking** | ❌ | ⚠️ Complex arch | ✅ Deep analysis | ✅ Strategy | ✅ Quality | ❌ | ❌ | ❌ |

**Legend:**
- ✅ Full access — Core tool for this agent
- ⚠️ Limited access — Specific use cases only (noted in cell)
- ❌ No access — Not relevant to this agent's role
- [CONFIRM:] — Requires user approval before executing (write/send operations)

**Access Notes:**

**Ellie (General — Coordinator):**
- Full Google Workspace access — manages Dave's day-to-day (email, calendar, tasks, docs)
- GitHub read-only — can check status and issues, cannot modify code
- All knowledge tools (Forest, QMD, Memory) — coordinates cross-agent knowledge
- No deep analysis tools (Miro, Sequential Thinking) — delegates to specialists

**James (Dev — Developer):**
- Full GitHub access — core development tool (PRs, issues, code)
- Google Workspace limited to reading docs — doesn't manage Dave's email/calendar
- All knowledge tools — writes technical findings to Forest
- Sequential Thinking only for complex architectural decisions — not routine dev work

**Kate (Research — Researcher):**
- Brave Search is core — primary research tool
- Google Workspace for research reports (Drive, Docs) and outreach (Gmail with [CONFIRM:])
- Sequential Thinking for deep analysis chains
- Miro optional for research visualization
- No GitHub — research is external, not code-focused

**Alan (Strategy — Strategist):**
- Brave Search for market research and competitive intel
- Google Workspace: Calendar for roadmaps, Docs/Drive for strategy documents
- Miro for visual diagrams (roadmaps, market maps)
- Sequential Thinking for deep strategic analysis
- GitHub read-only to understand technical constraints

**Brian (Critic — Quality Reviewer):**
- GitHub for reviewing PRs and code
- Sequential Thinking for deep quality analysis
- No external tools (Brave Search, Google Workspace, Miro) — assessments are internal

**Amy (Content — Content Creator):**
- Google Workspace: Docs for writing, Drive for storage, Gmail with [CONFIRM:] for outreach
- Brave Search for content research
- Miro optional for visual content planning
- No GitHub or Sequential Thinking — content creation is creative, not analytical

**Marcus (Finance — Financial Analyst):**
- Google Sheets (future) for financial tracking — currently uses Supabase
- All data is internal — no Brave Search, GitHub, or external tools
- No deep analysis tools — financial analysis is structured

**Jason (Ops — Operations Engineer):**
- GitHub for deployments, CI/CD, releases
- Brave Search for ops tools and best practices
- Google Drive/Docs (future) for runbooks
- No deep analysis tools — ops work is action-oriented

**Future Enhancements:**
- Tool access control enforcement (currently behavioral guidelines only)
- Per-agent MCP filtering in agent-router.ts
- Usage monitoring and audit logging

---

### Inter-Agent Communication Protocol

Agents communicate through multiple mechanisms, each suited to different scenarios. This protocol defines **when to use which path** and the **rules of engagement**.

#### Communication Mechanisms (Ordered by Complexity)

| # | Mechanism | File | When to Use |
|---|-----------|------|-------------|
| 1 | **Agent Queue** | `src/api/agent-queue.ts` | Async work items — "do this when you can" |
| 2 | **Agent Request** | `src/agent-request.ts` | One-off task requests — "I need help with X" |
| 3 | **Agent Exchange** | `src/agent-exchange.ts` | Direct collaboration after request is approved |
| 4 | **Delegations** | `src/agent-delegations.ts` | Manager→direct report task delegation |
| 5 | **Formations** | `src/formations/orchestrator.ts` | Structured multi-agent parallel/sequential work |
| 6 | **Round Table** | `src/round-table/orchestrator.ts` | 4-phase structured discussions (convene→discuss→converge→deliver) |
| 7 | **AgentMail** | `src/agentmail.ts` | Email-based inter-agent messaging |
| 8 | **Dispatch** | `src/orchestration-dispatch.ts` | Formal tracked dispatch with concurrency control |

#### Decision Tree — Which Path to Use

```
Is this a quick, fire-and-forget task?
  YES → Agent Queue (POST /api/queue/create)
  NO ↓

Does it require back-and-forth collaboration?
  YES → Agent Request → Agent Exchange (after approval)
  NO ↓

Is this a manager delegating to a direct report?
  YES → Delegation (createDelegation)
  NO ↓

Does it need multiple agents working on the same problem?
  YES → Is it structured (defined protocol)?
    YES → Formation (invokeFormation)
    NO → Round Table (runRoundTable)
  NO ↓

Is it a formal work dispatch with tracking?
  YES → Orchestration Dispatch (executeTrackedDispatch)
  NO → Direct agent call via agent-router
```

#### Routing Rules

**1. Everything routes through Ellie (coordinator) by default.**
- Ellie receives the user message, decides who handles it
- Specialists do NOT independently decide to involve other agents
- Exception: Formations and Round Tables have their own internal routing

**2. Specialists CAN request help from other specialists.**
- Use `Agent Request` → coordinator (Ellie) approves or denies
- After approval, `Agent Exchange` opens a direct channel
- Example: Brian (critic) finds a bug → requests James (dev) to fix it
- Example: Kate (research) needs Amy (content) to write up findings

**3. Delegations follow the org chart.**
- Only valid between manager and direct report (`reports_to` field)
- Delegate: manager → direct report (downward)
- Escalate: direct report → manager (upward)
- Cannot skip levels — must go through the chain

**4. Formations are self-contained.**
- Once a formation is invoked, agents within it communicate through the formation protocol
- Fan-out: all agents work in parallel, facilitator synthesizes
- Debate: agents take turns arguing positions
- Pipeline: agents execute sequentially, each building on the previous
- No external agent communication during a formation

**5. Round Tables are the highest-level coordination.**
- Use for complex, multi-phase work requiring multiple formations
- 4 phases: Convene → Discuss → Converge → Deliver
- Each phase can invoke formations internally
- Reserved for strategic decisions, not routine tasks

#### Agent Queue — Async Work Items

**Use when:** An agent has work for another agent that doesn't need immediate response.

```
POST /api/queue/create
{ source: "brian", target: "james", priority: "high",
  category: "bug-fix", title: "Fix null check in router",
  content: "Details...", work_item_id: "ELLIE-999" }
```

**Priority levels:** `critical` | `high` | `medium` | `low`

**Lifecycle:** `new` → `acknowledged` → `completed`

**Auto-expiry:** Items older than 7 days are auto-archived.

**Target agent checks inbox:**
```
GET /api/queue/list?target=james&status=new
```

#### Agent Request + Exchange — Collaborative Work

**Step 1:** Agent submits request
```ts
submitAgentRequest({
  requestingAgent: "brian",
  targetAgent: "james",
  reason: "Found critical bug in dispatch logic",
  estimatedDuration: "30m",
  requiredCapability: "code-edit"
})
```

**Step 2:** Coordinator (Ellie) approves → sub-commitment created

**Step 3:** Exchange opens for direct communication
```ts
openExchange(requestId, { context: "Bug details..." })
// Agents exchange messages directly
addMessage(exchangeId, { from: "brian", content: "The bug is in line 42..." })
addMessage(exchangeId, { from: "james", content: "Fixed. Here's what I changed..." })
completeExchange(exchangeId, { summary: "Fixed null check" })
```

**Step 4:** Coordinator notified of completion

**Timeouts:**
- Request: 10 minutes to get approval
- Exchange: 10 minutes of inactivity
- Commitment: 30 minutes total

#### Delegations — Org Chart Work

**Use when:** A manager needs a direct report to handle a task, or a report needs to escalate.

```ts
// Manager delegates down
createDelegation({
  direction: "delegate",
  from_agent_id: "ellie",
  to_agent_id: "james",
  summary: "Implement the new API endpoint",
  work_item_id: "ELLIE-500"
})

// Direct report escalates up
createDelegation({
  direction: "escalate",
  from_agent_id: "james",
  to_agent_id: "ellie",
  summary: "Need decision on API design approach"
})
```

**Lifecycle:** `pending` → `accepted` → `completed` | `failed` | `rejected`

**Audit trail:** `getDelegationChain(work_item_id)` returns full delegation history.

#### Formations — Structured Multi-Agent Work

**Use when:** A defined protocol exists for how agents should collaborate.

**3 protocol patterns:**

| Pattern | How It Works | Example |
|---------|-------------|---------|
| **Fan-out** | All agents work in parallel, facilitator synthesizes | "Everyone analyze this from your perspective" |
| **Debate** | Agents take turns for N rounds | "Dev and Critic debate this architecture" |
| **Pipeline** | Sequential execution, each builds on previous | "Research → Strategy → Content pipeline" |

**Invocation:**
```ts
invokeFormation(deps, "architecture-review", userPrompt, {
  timeout: 30000,  // per-agent timeout
  synthesisTimeout: 60000  // facilitator timeout
})
```

**Returns:** `FormationInvocationResult` with synthesis + individual agent outputs.

#### Round Table — Complex Discussions

**Use when:** The problem requires structured analysis across multiple phases.

**4 phases:**

| Phase | Purpose | Default Agent |
|-------|---------|--------------|
| **Convene** | Analyze query, determine scope | Strategy |
| **Discuss** | Invoke relevant formations | (Formation agents) |
| **Converge** | Synthesize all formation outputs | Strategy |
| **Deliver** | Produce final polished deliverable | Strategy |

**Config:**
- Phase timeout: 120s per phase
- Session timeout: 15 min total (shared deadline prevents overshoot)
- Max concurrent dispatches: 3

#### Dispatch Tracking — Observability

Every agent dispatch is tracked through:

1. **Orchestration Dispatch** (`src/orchestration-dispatch.ts`) — generates `run_id`, enforces concurrency cap (max 3)
2. **Orchestration Tracker** (`src/orchestration-tracker.ts`) — tracks active runs, detects stalls
3. **Orchestration Ledger** (`src/orchestration-ledger.ts`) — event log (dispatched, completed, failed, timeout)
4. **Dispatch Journal** (`src/dispatch-journal.ts`) — daily markdown files in River (`dispatch-journal/YYYY-MM-DD.md`)

**Concurrency rules:**
- Max 3 concurrent dispatches (prevents OOM)
- Work item locking prevents duplicate dispatches to same ticket
- Queue on busy: if agent is occupied, work is queued instead of rejected

#### Anti-Patterns

- **Don't bypass the coordinator.** Specialists should not independently decide to invoke other agents without going through the request system.
- **Don't use formations for simple tasks.** If one agent can handle it, just dispatch directly.
- **Don't use round tables for routine work.** Reserve for strategic decisions requiring multi-phase analysis.
- **Don't mix mechanisms.** Pick one communication path per interaction. Don't start with a queue item and then also open an exchange.
- **Don't forget timeouts.** All mechanisms have auto-timeout. Design work to complete within the window.

#### Key Files Reference

| File | Purpose |
|------|---------|
| `src/agent-request.ts` | Request + approval workflow (ELLIE-600) |
| `src/agent-exchange.ts` | Direct agent-to-agent channel (ELLIE-601) |
| `src/agent-queue.ts` + `src/api/agent-queue.ts` | Async work queue (ELLIE-200/201) |
| `src/agent-delegations.ts` | Org-chart delegation (ELLIE-727) |
| `src/agent-registry.ts` | In-memory agent session tracking (ELLIE-599) |
| `src/commitment-ledger.ts` | Commitment + sub-commitment tracking (ELLIE-598) |
| `src/formations/orchestrator.ts` | Multi-agent formation protocols (ELLIE-675) |
| `src/round-table/orchestrator.ts` | 4-phase round table discussions (ELLIE-695) |
| `src/orchestration-dispatch.ts` | Tracked dispatch with concurrency (ELLIE-352) |
| `src/dispatch-journal.ts` | Daily dispatch audit trail (ELLIE-565) |
| `src/agentmail.ts` | Email-based inter-agent comms (ELLIE-785) |

---

- **Relay:** `src/relay.ts` — Telegram bot + HTTP server + voice calls + Google Chat webhook
- **Google Chat:** `src/google-chat.ts` — Service account auth, message sending, webhook parsing
- **Memory:** `src/memory.ts` — Supabase-backed conversation history + semantic search
- **Agents:** `src/agent-router.ts` — multi-agent routing via Supabase edge functions
- **Skills:** `src/skills/` — SKILL.md loader, eligibility filter, prompt injection, slash commands (ELLIE-217)
- **Work Sessions:** `src/api/work-session.ts` — session lifecycle management (notifies Telegram + Google Chat)
- **Plane:** `src/plane.ts` — work item state sync
- **Voice:** Local Whisper transcription + ElevenLabs TTS streaming
- **Database:** Supabase (cloud) + Forest/Postgres (local). Migrations in `migrations/{supabase,forest}/`, seeds in `seeds/{supabase,forest}/`
- **Service:** systemd user service `ellie-chat-relay`

### Testing

All tests live in `tests/` — this is the single canonical test directory. Never add test files to `src/`.

```bash
bun test                                          # Run all tests
bun test tests/memory.test.ts                     # Run a specific test
```

Before closing a hardening ticket, run `bun test` to verify no regressions.

### SQL Migrations & Seeds

SQL files are organized by target database. Two databases exist:
- **Supabase** (cloud) — messages, conversations, memory, agents, work_sessions, todos, etc.
- **Forest** (local Postgres, `ellie-forest`) — trees, branches, entities, creatures, commits, knowledge_scopes, etc.

```
migrations/
  supabase/    # Schema migrations targeting Supabase (cloud Postgres)
  forest/      # Schema migrations targeting Forest (local Postgres)
seeds/
  supabase/    # Bootstrap/seed data for Supabase
  forest/      # Bootstrap/seed data for Forest
db/
  schema.sql   # Cumulative Supabase baseline (run to bootstrap a fresh project)
```

**Naming convention:** `YYYYMMDD_description.sql` — the directory indicates target DB.

**How to apply:**
- Automated: `bun run migrate` applies pending migrations to both databases
- Supabase requires `DATABASE_URL` env var (direct Postgres connection string)
- Forest uses local Unix socket by default (no config needed)
- Manual fallback: Supabase MCP `execute_sql` or SQL Editor; Forest via `psql`

**Migration runner commands:**
```bash
bun run migrate                       # Apply pending migrations to both DBs
bun run migrate --db forest           # Apply to Forest only
bun run migrate --db supabase         # Apply to Supabase only
bun run migrate --dry-run             # Preview without applying
bun run migrate:status                # Show applied vs pending vs modified
bun run migrate:validate              # Seed validation + code-vs-DB drift check
```

The runner uses a `_migration_ledger` table in each database to track applied files
with SHA-256 checksums. Modified files (checksum mismatch) are flagged but not re-applied.

**Rules:**
- Never put SQL files outside `migrations/` or `seeds/`
- Schema changes (CREATE, ALTER, DROP) go in `migrations/<db>/`
- Repeatable data inserts (seed agents, scopes, channels) go in `seeds/<db>/`
- One-time data backfills that accompany a schema change stay in `migrations/`

### Key Commands
```bash
systemctl --user restart ellie-chat-relay        # Restart relay
journalctl --user -u ellie-chat-relay            # View logs
bun run start                                     # Run manually
bun run test:telegram                             # Test Telegram
bun run test:supabase                             # Test database
bun run migrate                                   # Apply pending SQL migrations
bun run migrate:status                            # Check migration status
bun run migrate:validate                          # Validate seeds + detect drift
```
