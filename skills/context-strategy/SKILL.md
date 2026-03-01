---
name: context-strategy
description: >
  Mode-aware context docket filtering. Detects the interaction mode
  (conversation, strategy, workflow, deep-work, skill-only) and signals
  which context sections to load, suppress, or reprioritize. Reduces
  prompt bloat by only loading what each mode actually needs.
always: true
triggers:
  - strategy mode
  - planning mode
  - workflow mode
  - conversation mode
  - deep work mode
  - focus mode
  - ops mode
  - skill-only
  - triage mode
  - light mode
  - triage this
  - brain dump
  - let's plan
  - work on ELLIE-
  - dispatch
  - check on
  - manage agents
---

# Context Strategy — Mode-Aware Docket

The context docket loads structured data into every prompt. This skill
tells `buildPrompt()` which sections to include, suppress, or
reprioritize based on the current interaction mode.

## Modes

Five modes. Each maps to a different context profile.

### conversation (default)

**When:** Greetings, casual chat, quick questions, emotional check-ins,
non-work topics, morning hellos

**Signals:** "good morning", "hey", "how's it going", "what's up",
personal topics, no work item references, no action verbs

**Section priorities:**

| Section Label        | Priority | Notes                         |
|---------------------|----------|-------------------------------|
| soul                | 2        | Full — personality matters    |
| archetype           | 2        | Full                          |
| phase               | 3        | Full                          |
| profile             | 3        | Full                          |
| structured-context  | 4        | Key facts, goals, pending     |
| conversation        | 3        | Full recent messages          |
| agent-memory        | 8        | Suppress                      |
| forest-awareness    | 8        | Suppress                      |
| search              | 9        | Suppress                      |
| context-docket      | 7        | Light — summary counts only   |
| work-item           | 9        | Suppress                      |
| playbook-commands   | 9        | Suppress                      |
| work-commands       | 9        | Suppress                      |
| queue               | 8        | Suppress                      |
| skills              | 6        | Trim to names only            |

**Token target:** ~30k — fast, light, responsive

---

### strategy

**When:** Brain dumps, roadmapping, architectural decisions,
prioritization, "let's think through X", planning sessions

**Signals:** "brain dump", "let's plan", "strategy", "roadmap",
"prioritize", "think through", "flush out", "what should we",
"rework", "redesign"

**Section priorities:**

| Section Label        | Priority | Notes                          |
|---------------------|----------|--------------------------------|
| soul                | 5        | Condensed identity only        |
| archetype           | 7        | Suppress                       |
| phase               | 8        | Suppress                       |
| profile             | 4        | Communication style matters    |
| structured-context  | 3        | Full — work items, goals, facts|
| conversation        | 5        | Light summaries                |
| agent-memory        | 5        | Include — prior decisions      |
| forest-awareness    | 3        | Full — what's been decided     |
| search              | 8        | Suppress                       |
| context-docket      | 3        | Full — broad awareness         |
| work-item           | 9        | Suppress (no single ticket)    |
| playbook-commands   | 7        | Suppress                       |
| work-commands       | 7        | Suppress                       |
| queue               | 6        | Light                          |
| skills              | 5        | Trim to names only             |

**Token target:** ~60k — needs broad context for planning

---

### workflow

**When:** Dispatching agents, checking creature status, managing
tickets, reviewing outputs, orchestrating work

**Signals:** "dispatch", "check on", "status of creatures",
"what's running", "manage agents", "fan out", "assign", "close ticket",
"queue", "review output"

**Section priorities:**

| Section Label        | Priority | Notes                           |
|---------------------|----------|---------------------------------|
| soul                | 7        | Condensed identity only         |
| archetype           | 8        | Suppress                        |
| phase               | 9        | Suppress                        |
| profile             | 7        | Suppress (name + tz only)       |
| structured-context  | 3        | Work items + pending actions    |
| conversation        | 6        | Light                           |
| agent-memory        | 3        | Full — what agents have learned |
| forest-awareness    | 5        | Topic-specific only             |
| search              | 7        | Suppress                        |
| context-docket      | 4        | Creatures + sessions + activity |
| work-item           | 9        | Suppress (full list, not one)   |
| playbook-commands   | 2        | Full — this is operations       |
| work-commands       | 2        | Full                            |
| queue               | 2        | Full — what's pending           |
| skills              | 5        | Trim to names only              |

**Token target:** ~45k — operational awareness without overload

---

### deep-work

**When:** Implementing a specific ticket, writing code, debugging,
focused technical work on a single item

**Signals:** "work on ELLIE-XXX", "implement", "fix", "build", "code",
"debug", "let's do", specific ticket references with action verbs

**Section priorities:**

| Section Label        | Priority | Notes                              |
|---------------------|----------|------------------------------------|
| soul                | 7        | Condensed identity only            |
| archetype           | 8        | Suppress                           |
| phase               | 9        | Suppress                           |
| profile             | 7        | Suppress                           |
| structured-context  | 7        | Suppress (not the full backlog)    |
| conversation        | 5        | Only recent relevant messages      |
| agent-memory        | 4        | Filter to active ticket only       |
| forest-awareness    | 3        | Full — prior decisions on topic    |
| search              | 5        | Include — codebase context         |
| context-docket      | 8        | Suppress                           |
| work-item           | 2        | Full — the one we're working on    |
| playbook-commands   | 3        | Full — need tools                  |
| work-commands       | 3        | Full                               |
| queue               | 7        | Suppress                           |
| skills              | 5        | Trim to relevant skills only       |

**Token target:** ~80k — room for codebase context + work item detail

---

### skill-only

**When:** Fast triage, quick dispatch, run-and-return tasks. Used by the
road-runner creature for immediate routing with minimal context overhead.
Anything where the skill instructions alone are sufficient.

**Signals:** "triage this", "triage ELLIE-XXX", "route this", "just dispatch",
"quick dispatch", "run and return", "just run", "quick run", "run skill"

**Section priorities:**

| Section Label        | Priority | Notes                                |
|---------------------|----------|--------------------------------------|
| skills              | 1        | Full — this IS the context           |
| archetype           | 2        | Full — creature identity matters     |
| playbook-commands   | 2        | Full — needs dispatch tools          |
| work-commands       | 2        | Full                                 |
| queue               | 3        | Light — what's pending               |
| orchestration-status| 3        | Light — what's running               |
| work-item           | 4        | Light — ticket ref only              |
| conversation        | 6        | Minimal — last message only          |
| soul                | 9        | Suppress                             |
| psy                 | 9        | Suppress                             |
| phase               | 9        | Suppress                             |
| profile             | 9        | Suppress                             |
| structured-context  | 9        | Suppress                             |
| agent-memory        | 9        | Suppress                             |
| forest-awareness    | 9        | Suppress                             |
| search              | 9        | Suppress                             |
| context-docket      | 9        | Suppress                             |
| health              | 9        | Suppress                             |
| incidents           | 9        | Suppress                             |

**Token target:** ~40k — the leanest mode; skills + archetype + tools only

---

## Mode Detection

### Hybrid approach — start light, escalate on signal.

**Step 1:** Every new interaction starts in `conversation` mode.

**Step 2:** On first user message, scan for mode signals:

| Signal Pattern                          | Mode      | Confidence |
|-----------------------------------------|-----------|------------|
| ELLIE-XXX + action verb (work, fix, build) | deep-work | high       |
| "brain dump", "let's plan", "strategy"  | strategy  | high       |
| "dispatch", "creatures", "what's running" | workflow | high       |
| "triage this", "route ELLIE-XXX", "quick dispatch" | skill-only | high |
| Greeting, no work context               | conversation | high    |
| Mentions work but not specific ticket   | strategy  | medium     |
| Mentions ticket but just wants status   | conversation | medium  |

**High confidence:** Switch immediately.
**Medium confidence:** Stay in current mode, flag potential switch.

### Step 3: Mid-conversation shifts

Watch for transitions:

- Conversation -> Strategy: "so I've been thinking...", "let me brain dump"
- Strategy -> Deep Work: "okay let's actually build that", "work on ELLIE-XXX"
- Deep Work -> Conversation: work item complete, shifting to chat
- Any -> Workflow: "dispatch this", "what are the creatures doing"
- Any -> Skill-Only: "triage this", "route ELLIE-XXX", "just dispatch"

On shift: add new mode's sections, suppress old mode's unique sections.
Don't reload everything — **merge, don't replace**.

---

## Manual Override

These phrases switch immediately, no detection needed:

- "strategy mode" -> strategy
- "workflow mode" / "ops mode" -> workflow
- "conversation mode" / "let's just talk" -> conversation
- "deep work" / "focus mode" -> deep-work
- "skill-only" / "triage mode" / "light mode" -> skill-only
- "load everything" / "full context" -> disable filtering

### Context Refresh

Re-query context sources without changing modes or restarting the conversation.

**Trigger phrases:**
- "refresh context"
- "reload context"
- "update memory"
- "pull latest"
- "re-check sources"

**What gets refreshed:**
- Forest memories (semantic search re-runs)
- Plane work items (fetch current ticket states)
- Google Calendar events
- Google Tasks
- Recent conversations (re-fetch summaries)
- Key facts, goals, pending actions (re-query from database)

**What stays the same:**
- Current mode (conversation/strategy/workflow/deep-work/skill-only)
- Section priorities (determined by current mode)
- Conversation history (doesn't re-summarize existing messages)

**When to use:**
- You've been working outside the conversation and context is stale
- You want to verify ticket states before making decisions
- You suspect calendar or task data has changed
- You want the latest Forest findings without starting a new session

**Implementation:**
When triggered, `buildPrompt()` should:
1. Re-invoke all active context-sources (based on current mode)
2. Replace stale data with fresh queries
3. Preserve the current mode and section priorities
4. Log: `[context] refresh triggered — reloading sources in {mode} mode`

---

## Implementation Contract

This skill defines the **strategy**. The implementation lives in
`prompt-builder.ts` and `context-sources.ts` (ELLIE-261).

The skill emits a `contextMode` value that `buildPrompt()` reads:

```typescript
type ContextMode = 'conversation' | 'strategy' | 'workflow' | 'deep-work' | 'skill-only';
```

`buildPrompt()` uses the mode to:
1. Remap section priorities from the tables above
2. Apply mode-specific token budget
3. Filter context-sources to only fetch what the mode needs
4. Log the active mode for debugging: `[context] mode: strategy`

---

## Rules

- **Never load the full docket in any mode.** Every mode suppresses something.
- **Default to conversation.** When in doubt, load less.
- **Respect mid-conversation shifts.** Don't lock into one mode.
- **Don't reload on every message.** Only switch on clear signals.
- **Log mode transitions.** `[MODE: conversation -> strategy]`
- **User override wins.** Manual mode switch is immediate and unconditional.
- **Backwards compatible.** If no mode is detected, behave exactly as today.
