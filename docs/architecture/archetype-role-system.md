# Archetype + Role System Architecture

**Primary repository:** `ellie-dev`
**Status:** In progress (ELLIE-603 through ELLIE-609)
**Related code:** `src/agent-profile-builder.ts`, `src/creature-profile.ts`, `src/prompt-builder.ts`

## Design Principle

**Archetypes define HOW an agent behaves. Roles define WHAT it does.**

This is a two-axis composition model. Any archetype can pair with any role:

| | Dev (role) | Research (role) | Strategy (role) |
|---|---|---|---|
| **Ant** (archetype) | depth-first coder | exhaustive researcher | methodical planner |
| **Squirrel** (archetype) | breadth-first coder | foraging researcher | caching strategist |
| **Road Runner** (archetype) | fast-shipping coder | rapid surveyor | quick decision-maker |

An agent is defined by three layers: **creature** (archetype) + **role** + **wiring**.

---

## Layer Model

```
┌─────────────────────────────────────┐
│           Agent Wiring              │  config: creature, role, budget,
│         (agents/dev)                │  skills, section priorities
├─────────────────────────────────────┤
│     Role (roles/dev)                │  WHAT: capabilities, tools,
│                                     │  communication contract,
│                                     │  autonomy boundaries
├─────────────────────────────────────┤
│   Creature (creatures/ant)          │  HOW: cognitive style,
│                                     │  working pattern, anti-patterns,
│                                     │  growth metrics
├─────────────────────────────────────┤
│           Soul (soul/soul)          │  WHO: core identity, values,
│                                     │  personality (shared by all)
└─────────────────────────────────────┘
```

Assembly order (bottom-up):
1. **Soul** — who Ellie is (shared across all agents)
2. **Creature** — behavioral DNA (how it works)
3. **Role** — functional capabilities (what it does)
4. **Wiring** — config that binds creature + role + context

---

## Archetypes (Behavioral DNA)

An archetype defines the agent's **working style** independent of its function.

### Schema

**Location:** `config/archetypes/{name}.md` (file-based) or Forest tree `creatures/{name}` (Forest-based)

**Required sections:**

| Section | Purpose |
|---|---|
| `## Species` | Name and one-line behavioral summary |
| `## Working Pattern` | How the creature approaches tasks |
| `## Cognitive Style` | How it thinks and reasons |
| `## Communication Style` | How it reports progress and surfaces blockers |
| `## Anti-Patterns` | What this creature never does |
| `## Growth Metrics` | Measurable indicators of effectiveness |

**Frontmatter** (YAML):

```yaml
---
species: ant
cognitive_style: depth-first, single-threaded
---
```

### Current Archetypes

| Creature | Style | Best For |
|---|---|---|
| **Ant** | Depth-first, single-threaded, exhaustive | Implementation, debugging, focused tasks |
| **Squirrel** | Breadth-first, foraging, caching | Research, exploration, information gathering |
| **Chipmunk** | Organized, methodical, stockpiling | Content creation, structured output |
| **Deer** | Cautious, observant, measured | Strategy, risk assessment, review |
| **Road Runner** | Fast, decisive, momentum-driven | Quick fixes, rapid iteration, triage |

### Key Properties

- **Composable** — any creature pairs with any role
- **Behavioral only** — no tool lists, no capability definitions, no skill references
- **Stable** — creatures don't change per-session; they're personality constants
- **Measurable** — each creature defines growth metrics for self-assessment

---

## Roles (Functional Capabilities)

A role defines **what** the agent can do — its tools, autonomy boundaries, and communication contracts.

### Schema

**Location:** `config/roles/{name}.md` (file-based) or Forest tree `roles/{name}` (Forest-based)

**Required sections:**

| Section | Purpose |
|---|---|
| `## Capabilities` | What this role can do (tools, actions) |
| `## Context Requirements` | What information the role needs to function |
| `## Tool Categories` | Grouped tool access (file, git, database, etc.) |
| `## Communication Contract` | How this role reports its work |
| `## Autonomy Boundaries` | What it can decide alone vs. needs approval |
| `## Anti-Patterns` | Role-specific things to avoid |

**Frontmatter** (YAML):

```yaml
---
role: dev
tools: [file, git, database, test, build]
---
```

### Current Roles

| Role | Function | Key Tools |
|---|---|---|
| **Dev** | Code, test, debug, deploy | File ops, git, bash, database |
| **Research** | Gather, evaluate, synthesize | Web search, Forest, documents |
| **Strategy** | Plan, prioritize, decide | Plane, Forest, calendar |
| **Content** | Write, edit, publish | Docs, email, messaging |
| **Finance** | Track, analyze, report | Sheets, data, calculations |
| **Ops** | Deploy, monitor, maintain | Systemd, nginx, infrastructure |
| **Critic** | Review, assess, challenge | Code review, Forest, Plane |
| **General** | Conversation, triage, route | All channels, basic tools |

### Key Properties

- **Capability-scoped** — defines tool access and action boundaries
- **Creature-agnostic** — works with any archetype
- **Contract-based** — includes explicit communication expectations
- **Approval-gated** — documents what needs user approval vs. autonomous action

---

## Agent Wiring

The wiring file binds a creature + role into a concrete agent with runtime configuration.

### Schema

**Location:** Forest tree `agents/{name}`

**Frontmatter:**

```yaml
---
creature: ant
role: dev
token_budget: 28000
context_mode: deep-work
soul: true
relationship_sections: [psych, health]
skills:
  - github
  - plane
  - memory
  - forest
  - verify
section_priorities:
  archetype: 1
  work-item: 2
  forest-awareness: 2
  structured-context: 3
  skills: 3
  conversation: 5
---
```

### Fields

| Field | Type | Purpose |
|---|---|---|
| `creature` | string | Which archetype to use (e.g., `ant`) |
| `role` | string | Which role to use (e.g., `dev`) |
| `token_budget` | number | Max tokens for the assembled prompt |
| `context_mode` | string | `conversation`, `deep-work`, or `planning` |
| `soul` | boolean | Whether to include the soul layer |
| `relationship_sections` | string[] | Which relationship layers to include |
| `skills` | string[] | Allowed skills for this agent |
| `section_priorities` | Record | Priority ordering for prompt sections |

---

## Assembly Pipeline

```
                    ┌──────────────┐
                    │ Agent Name   │  "dev"
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │ Load Wiring  │  agents/dev → {creature: ant, role: dev, ...}
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
       ┌──────▼──────┐ ┌──▼──────┐ ┌───▼─────────┐
       │ Load Soul   │ │ Load    │ │ Load Role   │
       │ soul/soul   │ │ Creature│ │ roles/dev   │
       │             │ │ ant     │ │             │
       └──────┬──────┘ └──┬──────┘ └───┬─────────┘
              │            │            │
              └────────────┼────────────┘
                           │
                    ┌──────▼───────┐
                    │  Assemble    │  Soul → Creature → Role → Relationships
                    │  Prompt      │  (separated by ---)
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │ BuiltPrompt  │  {prompt, tokenBudget, skills, ...}
                    └──────────────┘
```

**Implementation:** `src/agent-profile-builder.ts`

Two entry points:
- **`buildAgentProfilePrompt(name)`** — full assembly (soul + creature + role + relationships)
- **`buildCreatureRoleContent(name)`** — creature + role only (used by prompt-builder for the archetype slot)

---

## Migration Path

### Current State (Legacy)

```
config/archetypes/dev.md      ← blends Ant DNA + Dev capabilities + wiring
config/archetypes/research.md ← blends Squirrel DNA + Research capabilities + wiring
```

Each file contains frontmatter (token budget, skills, priorities) + combined archetype/role content. Loaded by `src/creature-profile.ts` and injected into the archetype slot by `src/prompt-builder.ts`.

### Target State

```
config/archetypes/ant.md       ← pure behavioral DNA (no tools, no capabilities)
config/roles/dev.md            ← pure capabilities (no behavioral style)
Forest tree agents/dev         ← wiring: creature=ant, role=dev, budget=28000
```

Loaded by `src/agent-profile-builder.ts`, which reads from the Forest tree with file-based fallback.

### Migration Steps (ELLIE-603 → ELLIE-609)

1. **ELLIE-603** — Define archetype schema, validate existing files against it
2. **ELLIE-604** — Build archetype loader (file → parsed creature profile)
3. **ELLIE-605** — Define role schema, create `config/roles/` directory
4. **ELLIE-606** — Build role loader module
5. **ELLIE-607** — Add archetype-role binding to agent config (wiring files)
6. **ELLIE-608** — Wire into prompt-builder (replace single archetype slot with creature + role)
7. **ELLIE-609** — Add growth metrics collection for archetype compliance

### Backwards Compatibility

During migration, both paths work:
- **Forest tree path** — `agent-profile-builder.ts` reads `creatures/` + `roles/` + `agents/`
- **File fallback** — `prompt-builder.ts` reads `config/archetypes/{agent}.md` as a combined blob

The file-based archetypes (`dev.md`, `research.md`, etc.) continue working until all agents are migrated to the Forest tree structure. No breaking changes.

---

## File Layout (Target)

```
config/
  archetypes/          ← behavioral DNA only
    ant.md             ← depth-first, single-threaded
    squirrel.md        ← breadth-first, foraging
    chipmunk.md        ← organized, stockpiling
    deer.md            ← cautious, observant
    road-runner.md     ← fast, momentum-driven
  roles/               ← functional capabilities only
    dev.md             ← code, test, debug, deploy
    research.md        ← gather, evaluate, synthesize
    strategy.md        ← plan, prioritize, decide
    content.md         ← write, edit, publish
    finance.md         ← track, analyze, report
    ops.md             ← deploy, monitor, maintain
    critic.md          ← review, assess, challenge
    general.md         ← conversation, triage, route
```

Forest tree mirrors the same structure under `creatures/` and `roles/` branches.

---

## Growth Metrics (ELLIE-609)

Each archetype defines measurable behaviors. The system can track compliance:

### Ant Metrics
- **Task completion rate** — finishes what it starts
- **Investigation depth** — thoroughness of tracing before fixing
- **Blocker identification speed** — surfaces blockers early vs. struggling silently
- **Scope discipline** — changes match ticket scope, no drift
- **Commit quality** — atomic commits with clear messages

### Squirrel Metrics
- **Source diversity** — how many distinct sources consulted
- **Cache hit rate** — how often stored findings are reused
- **Connection density** — links drawn between disparate facts
- **Synthesis quality** — clarity of summarized findings

### Collection Method
Growth metrics are collected per-session from:
- Work session events (start, update, complete)
- Git commit analysis (scope, atomicity)
- Dispatch tracking (completion rate, time-to-done)
- Critic feedback (rework requests)

Stored in Forest for longitudinal analysis.

---

## Design Decisions

| Decision | Reasoning |
|---|---|
| Archetype = behavior, Role = capability | Allows recomposition — an "ant researcher" works differently than a "squirrel researcher" even though both research |
| Forest tree as primary store | Versioned, branchable, auditable — same infrastructure as other knowledge |
| File-based fallback | Works without Forest connection, easy to edit in any editor |
| Wiring as separate layer | Keeps creature and role files clean — config lives in one place |
| Growth metrics per-archetype | Different creatures should be measured differently (depth vs. breadth) |
