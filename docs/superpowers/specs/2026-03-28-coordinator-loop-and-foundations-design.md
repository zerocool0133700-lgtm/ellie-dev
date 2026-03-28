# Coordinator Loop & Foundations System — Design Spec

**Date:** 2026-03-28
**Status:** Approved
**Author:** Dave + Claude Opus 4.6
**Scope:** Ellie OS core orchestration redesign

---

## Problem Statement

Ellie's coordinator role is broken. She's a stateless router — she classifies intent, dispatches to one agent, and sleeps for up to 15 minutes waiting for a CLI subprocess to return. She can't:

1. **Decompose** multi-part requests into tasks for different agents
2. **Oversee** agent work in progress — no monitoring, no intervention
3. **Synthesize** results from multiple agents into a coherent response
4. **Feel like a coordinator** — she's a switchboard, not a project manager

Additionally, the current agent configuration is hardcoded for software development. The system needs swappable "foundations" — complete operating modes with different agent rosters, coordination patterns, approval flows, and personality adjustments — so it can serve different use cases (life management, small business, education) and different people with different needs.

## Design Decisions

**Approach:** SDK-Inspired Rebuild (no SDK dependency). Take the patterns from the Claude Agent SDK (coordinator loop, subagent spawning, tool scoping) and implement them directly using the Anthropic Messages API. Full ownership of the stack. No coupling to a v0.2 library.

**Why not the Agent SDK directly:** Ellie OS needs features the SDK doesn't provide — mid-flight user approval via Telegram, streaming progress updates, foundation hot-swapping, and integration with existing infrastructure (Forest, River, working memory, Plane). The SDK is young (v0.2) and would couple the core to an evolving dependency.

**Why not fixing the existing architecture:** The fundamental problem is structural. The current system dispatches a CLI subprocess and waits. No amount of improvement to routing or classification fixes the fact that the coordinator can't think between dispatches. A new coordinator loop using the Messages API is the minimum viable change.

**Foundation scope:** Everything is swappable. A foundation defines the agent roster, their tools, coordination recipes, approval flows, escalation paths, proactivity level, and communication tone. Different people need help in different ways.

---

## Architecture Overview

### Current Flow (Stateless Router)

```
User Message → Haiku Classifier → Pick Agent → CLI Subprocess (sleep 15 min) → Response
```

### New Flow (Coordinator Loop)

```
User Message → Ellie THINKS (Messages API) → Dispatches Subagents → Gets Results
            → Ellie THINKS Again (synthesize, decide) → Responds or Dispatches More
```

The coordinator maintains a conversation with Claude via the Messages API. She has custom tools that let her dispatch specialists, ask the user questions, send progress updates, and invoke coordination recipes. Specialists continue running as CLI subprocesses — they don't change.

### Core Components

| Component | File | Purpose |
|-----------|------|---------|
| **Coordinator Loop** | `src/coordinator.ts` | Ellie's thinking brain. Messages API conversation with custom tools. Think-Act-Observe-Think cycle. |
| **Coordinator Tools** | `src/coordinator-tools.ts` | Tool definitions and handlers: `dispatch_agent`, `ask_user`, `invoke_recipe`, `read_context`, `update_user`, `complete`. |
| **Context Manager** | `src/coordinator-context.ts` | Manages coordinator conversation history. Token tracking, automatic compaction, working memory integration. |
| **Dispatch Envelope** | `src/dispatch-envelope.ts` | Unified wrapper for both Messages API and CLI subprocess calls. One shape for logging, tracing, and cost. |
| **Foundation Registry** | `src/foundation-registry.ts` | Loads foundation configs. Hot-swappable at runtime. Active foundation shapes coordinator behavior. |
| **Foundation Loader** | `src/foundation-loader.ts` | Reads foundation definitions from Supabase + River vault. Merges structured data with markdown prompts. |

---

## The Coordinator Loop

### Think-Act-Observe-Think Cycle

Each user message triggers a coordinator loop:

1. **THINK** — Messages API call. Ellie reads the user message, foundation context, and working memory. Decides what to do.
2. **ACT** — Ellie calls her tools. Dispatches subagents, reads context, asks the user, sends progress updates, or invokes recipes.
3. **OBSERVE** — Tool results come back. Subagent outputs, API responses, user answers.
4. **THINK** — Ellie synthesizes results. Decides: respond to user? dispatch more work? ask a follow-up? Loop continues or exits.

The loop repeats until Ellie calls the `complete` tool to deliver a final response.

### Coordinator Tools

#### `dispatch_agent`

Send a task to a specialist. Returns their output. Can dispatch multiple in parallel (multiple tool_use blocks in one API response). Wraps the existing CLI subprocess dispatch.

```typescript
{
  name: "dispatch_agent",
  input_schema: {
    agent: string,        // "james" | "brian" | "kate" | etc.
    task: string,         // What the agent should do
    context?: string,     // Additional context from the coordinator
    timeout_ms?: number,  // Override default timeout
    priority?: string     // "high" | "normal" | "low"
  }
}
```

Returns: `{ agent, status, output, tokens_used, duration_ms, error? }`

When multiple `dispatch_agent` calls appear in one assistant response, they execute in parallel.

#### `ask_user`

Pause the loop and ask the user a question via Telegram/Google Chat. Loop resumes when the user replies.

```typescript
{
  name: "ask_user",
  input_schema: {
    question: string,     // What to ask
    options?: string[],   // Optional multiple choice
    timeout_ms?: number,  // How long to wait for reply
    urgency?: string      // "blocking" | "when_you_can"
  }
}
```

Returns: `{ response: string, selected_option?: string }`

If the user doesn't reply within `timeout_ms`, the tool returns `{ response: null, timed_out: true }`. The coordinator decides what to do — proceed with a default, skip the step, or try again.

#### `invoke_recipe`

Run a coordination recipe from the active foundation. Recipes encode patterns like code review pipelines, architecture round tables, or morning routines.

```typescript
{
  name: "invoke_recipe",
  input_schema: {
    recipe_name: string,     // "code-review" | "architecture-decision" | etc.
    input: string,           // What to feed the recipe
    agents_override?: string[] // Override default recipe agents
  }
}
```

Returns: `{ recipe, synthesis, agent_outputs[], rounds_executed }`

Recipes replace hardcoded formations and round tables. They're defined per-foundation in River markdown files and loaded at runtime.

#### `read_context`

Lightweight information gathering without dispatching a full agent.

```typescript
{
  name: "read_context",
  input_schema: {
    source: "forest" | "plane" | "memory" | "sessions",
    query: string
  }
}
```

Returns: `{ results: string }`

#### `update_user`

Send a progress message to the user without ending the loop.

```typescript
{
  name: "update_user",
  input_schema: {
    message: string,
    channel?: string
  }
}
```

Returns: `{ sent: true }`

#### `complete`

End the loop and deliver the final response. Required to exit — prevents runaway loops.

```typescript
{
  name: "complete",
  input_schema: {
    response: string,          // Final message to user
    promote_to_memory?: boolean, // Promote decisions to Forest
    update_plane?: boolean      // Update work item if applicable
  }
}
```

### Safety Rails

| Rail | Default | Behavior |
|------|---------|----------|
| Max loop iterations | 10 | Auto-complete with summary of what's done |
| Session timeout | 20 min | Wall-clock limit for the full coordinator loop |
| Cost cap (per-session) | $2.00 | Auto-complete on breach |
| Subagent timeout | 15 min (inherited) | Return error to coordinator on breach |

All configurable per foundation.

---

## Foundation Data Model

A foundation has four parts:

### 1. Identity

Name, description, icon, version. Stored in Supabase `foundations` table.

### 2. Agent Roster

Which agents exist, their tools, capabilities, and personality. Each foundation brings its own team.

```yaml
agents:
  - name: "james"
    role: "developer"
    tools: [read, write, edit, git, bash, plane, forest]
    model: "sonnet-4-6"
    prompt_key: "dev-agent-template"  # River doc key
  - name: "brian"
    role: "critic"
    tools: [read, grep, glob, plane]
    model: "sonnet-4-6"
    prompt_key: "critic-agent-template"
```

### 3. Coordination Recipes

Patterns the coordinator knows how to invoke. Defined in River markdown files per foundation.

```yaml
recipes:
  - name: "code-review"
    pattern: "pipeline"          # pipeline | fan-out | debate | round-table
    steps: [dev, critic]
    trigger: "before merge"      # Hint for coordinator
  - name: "architecture-decision"
    pattern: "round-table"
    agents: [dev, critic, strategy]
    phases: [convene, discuss, converge, deliver]
```

### 4. Behavior Rules

Approval flows, escalation paths, proactivity level, communication tone. This is what makes each foundation feel different.

```yaml
approvals:
  send_email: "always_confirm"
  git_push: "confirm_first_time"
  plane_update: "auto"
proactivity: "high"
tone: "direct, technical"
escalation: "block and ask user"
max_loop_iterations: 10
cost_cap_session: 2.00
cost_cap_daily: 20.00
coordinator_model: "sonnet-4-6"
```

### Example Foundations

| | Software Dev | Life Management | Small Business |
|---|---|---|---|
| **Agents** | James (dev), Brian (critic), Kate (research), Alan (strategy) | Coach (habits), Scheduler (calendar), Scribe (notes), Buddy (check-ins) | Marcus (finance), Amy (content), Scheduler, Outreach |
| **Recipes** | Code review pipeline, architecture round table, deploy checklist | Morning routine, weekly review, habit streak check | Invoice review, social post pipeline, monthly P&L |
| **Approvals** | Strict: confirm git push, confirm deploy, auto for reads | Gentle: suggest don't push, confirm only for outgoing messages | Mixed: auto for tracking, confirm for spending, confirm for client comms |
| **Tone** | Direct, technical, concise | Warm, encouraging, patient | Professional, clear, action-oriented |
| **Proactivity** | High — auto-run tests, flag issues | Medium — gentle reminders, never nag, celebrate wins | High — flag overdue invoices, remind about follow-ups |
| **Escalation** | Block and ask — never guess on architecture | Suggest and move on — don't block flow | Flag and continue — note the risk, keep moving |

### Storage

| Location | What | Why |
|----------|------|-----|
| Supabase `foundations` table | Identity, agent roster, tool mappings, behavior rules, active flag | Structured data the coordinator queries at startup and on swap |
| River vault `foundations/*.md` | Coordination recipes, system prompts, persona descriptions | Markdown loaded into coordinator context. Editable in Obsidian. Hot-reloaded. |

### Swap Mechanism

User says "switch to small business" or `/foundation small-business`. The coordinator:

1. Gracefully completes any active subagent dispatches
2. Reloads agent roster, recipes, and behavior rules from the new foundation
3. Updates working memory with the foundation switch
4. New messages route through the new foundation's configuration

---

## Context Manager

### The Problem

Each coordinator loop iteration adds to the Messages API conversation history. After ~8 subagent dispatches (~15K tokens each), the context fills up. The CLI handles compaction automatically. The Messages API does not.

### Three-Tier Context Strategy

| Tier | Location | Contents | Budget | Speed |
|------|----------|----------|--------|-------|
| **Hot** | Messages API conversation | System prompt, current message, last 2-3 loop iterations, active decisions, in-flight tool calls | ~50K tokens | Instant |
| **Warm** | Working memory (existing) | Session identity, task stack, conversation thread, investigation state, decision log, context anchors, resumption prompt | ~20K tokens | DB read (ms) |
| **Cold** | Forest + River (existing) | Prior session decisions, historical agent outputs, knowledge tree, completed subagent details | Unlimited | Semantic search (~100ms) |

### Context Flow Between Tiers

**Promote (Hot → Warm):** After each loop iteration, the context manager summarizes completed subagent outputs into a one-line result in the conversation and stores full detail in working memory.

**Recall (Warm/Cold → Hot):** The coordinator uses `read_context` to pull details back from working memory or Forest when needed.

**Archive (Warm → Cold):** When the coordinator loop completes, working memory promotes decisions and findings to Forest via the existing `promote()` API.

### Automatic Compaction

Token pressure is computed after every Messages API call using `usage.input_tokens`:

| Pressure | Threshold | Action |
|----------|-----------|--------|
| Normal | < 50% | No action |
| Warm | 50-70% | Promote completed subagent outputs to working memory. Keep summaries in conversation. |
| Hot | 70-85% | Collapse all but last 2 loop iterations into a single summary message. Full detail to working memory. |
| Critical | > 85% | Rebuild conversation from scratch: system prompt + working memory snapshot + last iteration. |

### Existing Infrastructure Reused

- Working memory (ELLIE-538/539): 7-section system, update/read/promote API, prompt injection
- Context pressure monitoring (ELLIE-528): token tracking, threshold warnings
- New work: automatic promotion between tiers, conversation rebuilding at critical pressure

---

## Unified Error Handling

### Principle

All errors flow back to the coordinator as tool results. The coordinator never crashes from a subagent failure. She receives an error and thinks about what to do — retry, try a different agent, ask the user, or give up gracefully.

### Error Categories

**Coordinator errors (Messages API):**

| Error | Handling |
|-------|----------|
| `rate_limit` | Exponential backoff, max 3 retries |
| `overloaded` | Back off 30s, retry once, then degrade to smaller model |
| `context_length` | Trigger critical compaction, rebuild conversation, retry |
| `auth / 5xx` | Log, notify user, abort loop |
| `tool_error` | Feed error back into loop — coordinator decides next step |

**Specialist errors (CLI subprocess):**

| Error | Handling |
|-------|----------|
| `timeout` | Kill process, return partial output to coordinator |
| `exit_code` | Capture stderr, return error to coordinator |
| `oom_kill` | Detect via exit signal, return OOM to coordinator |
| `empty_response` | Retry once with same prompt, then report failure to coordinator |

### Unified Dispatch Envelope

Every dispatch — Messages API or CLI — gets wrapped in the same envelope:

```typescript
interface DispatchEnvelope {
  id: string;              // Unique dispatch ID
  type: "coordinator" | "specialist";
  agent: string;           // "ellie" | "james" | "brian" ...
  foundation: string;      // "software-dev" | "life-mgmt" ...
  parent_id: string | null; // Coordinator dispatch that spawned this
  started_at: string;      // ISO timestamp
  completed_at: string | null;
  status: "running" | "completed" | "error" | "timeout";
  tokens_in: number;
  tokens_out: number;
  model: string;           // "sonnet-4-6" | "haiku-4-5" ...
  cost_usd: number;        // Computed from model pricing
  error: string | null;
  work_item_id: string | null;
}
```

Parent-child relationships enable full trace from user message through coordinator through specialists.

---

## Cost Tracking

### Per-Message Computation

- **Messages API (exact):** `cost = (usage.input_tokens * price_in) + (usage.output_tokens * price_out)`
- **CLI subprocess (estimated):** `cost = estimateFromResponse(model, prompt_chars, response_chars)`

### Aggregation Levels

| Level | Scope |
|-------|-------|
| Per dispatch | Single API call or CLI run |
| Per coordinator session | All dispatches in one loop |
| Per work item | Total cost for ELLIE-XXX |
| Per foundation | Which foundations cost what |
| Per day / week / month | Trending and budgeting |

### Cost Cap Enforcement

Each foundation defines cost limits. The coordinator checks before every dispatch.

| Cap | Default | On Breach |
|-----|---------|-----------|
| Per-session | $2.00 | Auto-complete with summary |
| Daily | $20.00 | Warn user, allow override, or block dispatches |
| Monthly | $200.00 | Emergency mode — coordinator only, no specialist dispatches |

Cost caps are per-foundation. A software-dev foundation running Opus specialists costs more than a life-management foundation running Haiku agents.

---

## Migration Path

### Phase 1 — Coordinator Loop (The Brain Transplant)

Build the coordinator loop with Messages API. Ellie thinks, dispatches specialists through existing CLI infrastructure, synthesizes results. One foundation hardcoded: software-dev.

**New files:**
- `src/coordinator.ts` — The coordinator loop
- `src/coordinator-context.ts` — Context management for the loop
- `src/coordinator-tools.ts` — Tool definitions and handlers
- `src/dispatch-envelope.ts` — Unified dispatch wrapper

**Changes to existing:**
- `telegram-handlers.ts` — Route to coordinator instead of direct dispatch
- `google-chat.ts` — Same
- `orchestration-ledger.ts` — Accept envelope format

**Cutover strategy:**
1. Build behind feature flag (`COORDINATOR_MODE=true` in .env)
2. Test with simple single-agent requests
3. Test multi-part decomposition (parallel dispatches)
4. Test error recovery (intentional failures)
5. Remove flag — coordinator becomes default after a week of stability

**Done when:** Multi-part requests on Telegram decompose, dispatch in parallel, and synthesize into one response.

### Phase 2 — Foundation System (Make It Swappable)

Extract the hardcoded software-dev config into the foundation data model. Build the registry, swap mechanism, and create life-management as the second foundation.

**New files:**
- `src/foundation-registry.ts` — Load and manage foundations
- `src/foundation-loader.ts` — Read from Supabase + River
- `migrations/supabase/YYYYMMDD_foundations.sql` — Schema
- `seeds/supabase/002_foundations.sql` — Initial foundation data

**River vault:**
- `foundations/software-dev.md` — Extracted from current config
- `foundations/life-management.md` — New foundation
- `foundations/recipes/*.md` — Coordination recipes

**Done when:** "Switch to life management" reloads Ellie with different agents, tone, recipes, and approvals.

### Phase 3 — Cleanup + Polish (Retire What's Redundant)

Retire communication mechanisms the coordinator replaces. Add cost caps. Build small-business foundation.

**Retire:**
- `src/agentmail.ts` — Coordinator passes context directly
- `src/agent-request.ts` — Coordinator handles requests
- `src/agent-exchange.ts` — Coordinator mediates
- `src/agent-delegations.ts` — Coordinator delegates natively
- `src/intent-classifier.ts` — Coordinator IS the classifier

**Keep:**
- `src/agent-queue.ts` — Useful for async work when coordinator isn't active
- `src/formations/` — Become recipes in foundation config
- `src/round-table/` — Become recipes in foundation config
- `src/orchestration-*.ts` — Tracking, ledger, journal stay

**Done when:** Three foundations working. Retired code removed. Cost caps enforced. System is clean and extensible.

### What Stays The Same

These do NOT change across all three phases:

- Telegram / Google Chat entry points
- Specialist CLI subprocess dispatch
- Forest / River / Memory knowledge systems
- Working memory (promoted to coordinator infrastructure)
- Plane / Skills / Hooks
- Ellie's personality (loaded from River soul doc + memory system)

---

## Testing Strategy

### Phase 1 Tests

- **Unit:** Coordinator loop executes think-act-observe-think cycle
- **Unit:** Context manager compacts at each pressure level
- **Unit:** Dispatch envelope wraps both API and CLI calls
- **Integration:** Single-agent dispatch through coordinator
- **Integration:** Multi-agent parallel dispatch and synthesis
- **Integration:** Error recovery — timeout, empty response, API failure
- **Integration:** `ask_user` pauses loop and resumes on reply
- **Integration:** `update_user` sends progress to Telegram mid-loop

### Phase 2 Tests

- **Unit:** Foundation loader reads from Supabase + River
- **Unit:** Foundation registry hot-swaps at runtime
- **Integration:** Foundation swap reloads coordinator context
- **Integration:** Different foundations produce different agent rosters and behavior
- **Integration:** Recipes execute as expected per foundation

### Phase 3 Tests

- **Integration:** Full loop with cost cap enforcement
- **Integration:** Cost aggregation at all levels
- **Regression:** Existing Telegram/Google Chat flows work unchanged
- **Regression:** Specialist dispatch behavior unchanged

---

## Open Questions

1. **Coordinator model choice:** Sonnet for cost efficiency or Opus for better reasoning? Configurable per foundation, but what's the default? Recommendation: start with Sonnet, escalate to Opus for complex decomposition.

2. **Parallel dispatch limit:** How many subagents can run concurrently? Current system caps at 3. Coordinator loop might want higher since it's managing, not executing. Recommendation: 5, configurable per foundation.

3. **Recipe format:** How much structure in the River markdown? Pure prose the coordinator interprets, or structured YAML frontmatter with steps? Recommendation: YAML frontmatter for pattern/agents/steps, prose body for coordinator instructions.

4. **Foundation inheritance:** Can foundations extend a base? Or is each fully self-contained? Recommendation: start self-contained, add inheritance only if duplication becomes painful.
