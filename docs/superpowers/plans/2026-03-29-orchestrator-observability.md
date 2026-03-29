# Orchestrator Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move skill ownership from agents to creatures (three-layer model), capture routing decisions with confidence scores, and add skills visibility to the agents page and a session replay view to the dashboard.

**Architecture:** Database is the single source of truth for skill bindings. Agents reference creatures, creatures own skills. The coordinator resolves skills by traversing agent → creature → toolbox, passing the result to the existing prompt builder. Routing decisions are logged as append-only rows with confidence scores. Two new dashboard views: a Skills tab on the agents page and an /orchestrator session replay page.

**Tech Stack:** TypeScript/Bun (relay), postgres.js (Forest DB), Supabase (cloud DB), Nuxt 4.3 + Tailwind v4 (dashboard)

**Spec:** `docs/superpowers/specs/2026-03-29-orchestrator-observability-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `migrations/forest/20260329_creature_skills.sql` | Schema for `creature_skills` and `archetype_default_skills` tables |
| `migrations/supabase/20260329_routing_decisions.sql` | Schema for `routing_decisions` table |
| `migrations/supabase/20260329_agents_creature_id.sql` | Add `creature_id` column to agents table |
| `seeds/forest/creature_skills.sql` | Populate archetype defaults and migrate existing agent skills to creatures |
| `ellie-forest/src/creature-skills.ts` | CRUD functions for creature skill bindings |
| `src/routing-decision-log.ts` | Append-only logging for routing decisions |
| `tests/creature-skills.test.ts` | Tests for creature skill resolution |
| `tests/routing-decision-log.test.ts` | Tests for routing decision capture |
| `ellie-home/server/api/agents/[id]/skills.get.ts` | API: get skills for an agent via creature lookup |
| `ellie-home/server/api/orchestrator/sessions.get.ts` | API: list orchestrator sessions |
| `ellie-home/server/api/orchestrator/sessions/[id].get.ts` | API: get routing decisions for a session |
| `ellie-home/app/pages/orchestrator.vue` | Orchestrator session replay page |

### Modified Files

| File | Change |
|------|--------|
| `ellie-forest/src/index.ts` | Export new `creature-skills` module |
| `src/agent-router.ts` | Swap skill resolution from `tools_enabled` to creature lookup |
| `src/intent-classifier.ts` | Add routing decision logging after classification |
| `ellie-home/app/pages/agents/index.vue` | Add creature badge, Skills tab |

---

## Task 1: Forest DB Schema — creature_skills and archetype_default_skills

**Files:**
- Create: `migrations/forest/20260329_creature_skills.sql`

- [ ] **Step 1: Write the migration**

```sql
-- creature_skills: the toolbox
CREATE TABLE IF NOT EXISTS creature_skills (
  creature_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  skill_name TEXT NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  added_by TEXT NOT NULL DEFAULT 'manual',
  PRIMARY KEY (creature_id, skill_name)
);

CREATE INDEX idx_creature_skills_creature ON creature_skills(creature_id);
CREATE INDEX idx_creature_skills_skill ON creature_skills(skill_name);

-- archetype_default_skills: reference table for bootstrapping
CREATE TABLE IF NOT EXISTS archetype_default_skills (
  archetype TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  PRIMARY KEY (archetype, skill_name)
);
```

- [ ] **Step 2: Apply the migration**

Run: `bun run migrate --db forest`
Expected: Migration applied successfully, tables created.

- [ ] **Step 3: Verify tables exist**

Run: `psql -U ellie -d ellie_forest -c "\dt creature_skills; \dt archetype_default_skills;"`
Expected: Both tables listed.

- [ ] **Step 4: Commit**

```bash
git add migrations/forest/20260329_creature_skills.sql
git commit -m "[ELLIE-1131] Add creature_skills and archetype_default_skills tables"
```

---

## Task 2: Supabase Schema — routing_decisions table and agents.creature_id

**Files:**
- Create: `migrations/supabase/20260329_routing_decisions.sql`
- Create: `migrations/supabase/20260329_agents_creature_id.sql`

- [ ] **Step 1: Write the routing_decisions migration**

```sql
CREATE TABLE IF NOT EXISTS routing_decisions (
  id TEXT PRIMARY KEY,
  session_id UUID,
  dispatch_envelope_id TEXT,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_message TEXT,
  agents_considered TEXT[],
  agent_chosen TEXT NOT NULL,
  confidence NUMERIC(3,2) NOT NULL,
  match_type TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  skills_loaded TEXT[]
);

CREATE INDEX idx_routing_decisions_session ON routing_decisions(session_id);
CREATE INDEX idx_routing_decisions_timestamp ON routing_decisions(timestamp DESC);
CREATE INDEX idx_routing_decisions_confidence ON routing_decisions(confidence) WHERE confidence < 0.7;
```

- [ ] **Step 2: Write the agents creature_id migration**

```sql
ALTER TABLE agents ADD COLUMN IF NOT EXISTS creature_id UUID;

COMMENT ON COLUMN agents.creature_id IS 'Logical FK to Forest DB entities table — resolved at runtime via ellie-forest library';
```

- [ ] **Step 3: Apply both migrations**

Run: `bun run migrate --db supabase`
Expected: Both migrations applied successfully.

- [ ] **Step 4: Commit**

```bash
git add migrations/supabase/20260329_routing_decisions.sql migrations/supabase/20260329_agents_creature_id.sql
git commit -m "[ELLIE-1132] Add routing_decisions table and agents.creature_id column"
```

---

## Task 3: Forest Library — creature-skills CRUD

**Files:**
- Create: `ellie-forest/src/creature-skills.ts`
- Modify: `ellie-forest/src/index.ts`
- Create: `tests/creature-skills.test.ts`

- [ ] **Step 1: Write the failing test for getSkillsForCreature**

Create `tests/creature-skills.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../ellie-forest/src/db";

// Test creature ID — will be created in beforeAll
let testCreatureId: string;

beforeAll(async () => {
  // Create a test entity to use as a creature
  const [entity] = await sql`
    INSERT INTO entities (name, type, active)
    VALUES ('test-creature-skills-arch', 'creature', true)
    ON CONFLICT (name) DO UPDATE SET active = true
    RETURNING id
  `;
  testCreatureId = entity.id;

  // Seed some skills
  await sql`
    INSERT INTO creature_skills (creature_id, skill_name, added_by)
    VALUES
      (${testCreatureId}, 'github', 'test'),
      (${testCreatureId}, 'plane', 'test'),
      (${testCreatureId}, 'ums-calendar', 'test')
    ON CONFLICT DO NOTHING
  `;
});

afterAll(async () => {
  await sql`DELETE FROM creature_skills WHERE creature_id = ${testCreatureId}`;
  await sql`DELETE FROM entities WHERE id = ${testCreatureId}`;
  await sql.end();
});

describe("creature-skills", () => {
  it("getSkillsForCreature returns skill names for a creature", async () => {
    const { getSkillsForCreature } = await import("../ellie-forest/src/creature-skills");
    const skills = await getSkillsForCreature(testCreatureId);
    expect(skills).toContain("github");
    expect(skills).toContain("plane");
    expect(skills).toContain("ums-calendar");
    expect(skills.length).toBe(3);
  });

  it("getSkillsForCreature returns empty array for unknown creature", async () => {
    const { getSkillsForCreature } = await import("../ellie-forest/src/creature-skills");
    const skills = await getSkillsForCreature("00000000-0000-0000-0000-000000000000");
    expect(skills).toEqual([]);
  });

  it("addSkillToCreature adds a new skill", async () => {
    const { addSkillToCreature, getSkillsForCreature } = await import("../ellie-forest/src/creature-skills");
    await addSkillToCreature(testCreatureId, "forest", "test");
    const skills = await getSkillsForCreature(testCreatureId);
    expect(skills).toContain("forest");
  });

  it("removeSkillFromCreature removes a skill", async () => {
    const { removeSkillFromCreature, getSkillsForCreature } = await import("../ellie-forest/src/creature-skills");
    await removeSkillFromCreature(testCreatureId, "forest");
    const skills = await getSkillsForCreature(testCreatureId);
    expect(skills).not.toContain("forest");
  });

  it("getDefaultSkillsForArchetype returns archetype defaults", async () => {
    const { getDefaultSkillsForArchetype } = await import("../ellie-forest/src/creature-skills");
    // Seed a default
    await sql`
      INSERT INTO archetype_default_skills (archetype, skill_name)
      VALUES ('test-arch', 'github'), ('test-arch', 'plane')
      ON CONFLICT DO NOTHING
    `;
    const defaults = await getDefaultSkillsForArchetype("test-arch");
    expect(defaults).toContain("github");
    expect(defaults).toContain("plane");
    // Cleanup
    await sql`DELETE FROM archetype_default_skills WHERE archetype = 'test-arch'`;
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/ellie/ellie-dev && bun test tests/creature-skills.test.ts`
Expected: FAIL — module `creature-skills` not found.

- [ ] **Step 3: Implement creature-skills.ts**

Create `ellie-forest/src/creature-skills.ts`:

```typescript
import { sql } from "./db";

/**
 * Get all skill names in a creature's toolbox.
 */
export async function getSkillsForCreature(creatureId: string): Promise<string[]> {
  const rows = await sql<{ skill_name: string }[]>`
    SELECT skill_name FROM creature_skills
    WHERE creature_id = ${creatureId}
    ORDER BY skill_name
  `;
  return rows.map((r) => r.skill_name);
}

/**
 * Add a skill to a creature's toolbox.
 */
export async function addSkillToCreature(
  creatureId: string,
  skillName: string,
  addedBy: string = "manual"
): Promise<void> {
  await sql`
    INSERT INTO creature_skills (creature_id, skill_name, added_by)
    VALUES (${creatureId}, ${skillName}, ${addedBy})
    ON CONFLICT DO NOTHING
  `;
}

/**
 * Remove a skill from a creature's toolbox.
 */
export async function removeSkillFromCreature(
  creatureId: string,
  skillName: string
): Promise<void> {
  await sql`
    DELETE FROM creature_skills
    WHERE creature_id = ${creatureId} AND skill_name = ${skillName}
  `;
}

/**
 * Get the default skill set for an archetype (for bootstrapping new creatures).
 */
export async function getDefaultSkillsForArchetype(archetype: string): Promise<string[]> {
  const rows = await sql<{ skill_name: string }[]>`
    SELECT skill_name FROM archetype_default_skills
    WHERE archetype = ${archetype}
    ORDER BY skill_name
  `;
  return rows.map((r) => r.skill_name);
}

/**
 * Resolve skills for an agent: agent → creature_id → creature_skills.
 * Returns null if the agent has no creature assigned.
 */
export async function resolveSkillsForAgent(agentCreatureId: string | null): Promise<string[] | null> {
  if (!agentCreatureId) return null;
  return getSkillsForCreature(agentCreatureId);
}
```

- [ ] **Step 4: Export from index.ts**

Add to `ellie-forest/src/index.ts`:

```typescript
export {
  getSkillsForCreature,
  addSkillToCreature,
  removeSkillFromCreature,
  getDefaultSkillsForArchetype,
  resolveSkillsForAgent,
} from "./creature-skills";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /home/ellie/ellie-dev && bun test tests/creature-skills.test.ts`
Expected: All 5 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add ellie-forest/src/creature-skills.ts ellie-forest/src/index.ts tests/creature-skills.test.ts
git commit -m "[ELLIE-1131] Add creature-skills CRUD library"
```

---

## Task 4: Seed Data — Archetype Defaults and Migrate Existing Skills

**Files:**
- Create: `seeds/forest/creature_skills.sql`

- [ ] **Step 1: Write the seed file**

This populates archetype defaults and migrates existing agent `tools_enabled` to creature skill bindings. Adjust skill names to match actual SKILL.md names in the system.

```sql
-- Archetype default skills
-- These define what a fresh creature of each type gets in its toolbox
INSERT INTO archetype_default_skills (archetype, skill_name) VALUES
  -- dev creatures
  ('dev', 'github'),
  ('dev', 'plane'),
  ('dev', 'forest'),
  ('dev', 'memory'),
  -- research creatures
  ('research', 'forest'),
  ('research', 'memory'),
  -- finance creatures
  ('finance', 'finance-tools'),
  ('finance', 'memory'),
  -- general creatures
  ('general', 'ums-calendar'),
  ('general', 'ums-comms'),
  ('general', 'memory'),
  ('general', 'forest'),
  -- strategy creatures
  ('strategy', 'forest'),
  ('strategy', 'memory'),
  ('strategy', 'plane')
ON CONFLICT DO NOTHING;

-- Migration: For each existing agent that has a linked entity in Forest,
-- copy their tools_enabled into creature_skills.
-- This is a one-time migration — run manually after verifying agent-to-entity mappings.
-- Example for known agents (adjust creature IDs after checking Forest entities):
--
-- INSERT INTO creature_skills (creature_id, skill_name, added_by)
-- SELECT e.id, unnest(a.tools_enabled), 'migration'
-- FROM agents a
-- JOIN entities e ON e.name = a.name AND e.type = 'creature'
-- WHERE a.tools_enabled IS NOT NULL AND array_length(a.tools_enabled, 1) > 0
-- ON CONFLICT DO NOTHING;
```

- [ ] **Step 2: Apply the seed**

Run: `psql -U ellie -d ellie_forest -f seeds/forest/creature_skills.sql`
Expected: INSERT 0 N rows for archetype defaults.

- [ ] **Step 3: Verify archetype defaults**

Run: `psql -U ellie -d ellie_forest -c "SELECT * FROM archetype_default_skills ORDER BY archetype, skill_name;"`
Expected: Rows for dev, research, finance, general, strategy archetypes with their skills.

- [ ] **Step 4: Commit**

```bash
git add seeds/forest/creature_skills.sql
git commit -m "[ELLIE-1131] Seed archetype default skills"
```

---

## Task 5: Coordinator Skill Resolution Swap

**Files:**
- Modify: `src/agent-router.ts` (lines 128, 224, 234)
- Create: `tests/agent-skill-resolution.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/agent-skill-resolution.test.ts`:

```typescript
import { describe, it, expect, mock, beforeEach } from "bun:test";

describe("agent skill resolution via creature", () => {
  it("resolves skills from creature_skills when creature_id is present", async () => {
    // Mock the Forest library call
    const mockResolve = mock(() => Promise.resolve(["github", "plane", "ums-calendar"]));

    // The function under test: given an agent record with creature_id,
    // it should call resolveSkillsForAgent and return the creature's skills
    // instead of using tools_enabled directly
    const { resolveAgentSkills } = await import("../src/agent-router");

    const agent = {
      name: "dev",
      creature_id: "test-creature-uuid",
      tools_enabled: ["old-skill-1", "old-skill-2"], // should be ignored
    };

    const skills = await resolveAgentSkills(agent, mockResolve);
    expect(skills).toEqual(["github", "plane", "ums-calendar"]);
    expect(mockResolve).toHaveBeenCalledWith("test-creature-uuid");
  });

  it("falls back to tools_enabled when creature_id is null", async () => {
    const mockResolve = mock(() => Promise.resolve(null));
    const { resolveAgentSkills } = await import("../src/agent-router");

    const agent = {
      name: "dev",
      creature_id: null,
      tools_enabled: ["fallback-skill"],
    };

    const skills = await resolveAgentSkills(agent, mockResolve);
    expect(skills).toEqual(["fallback-skill"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/ellie/ellie-dev && bun test tests/agent-skill-resolution.test.ts`
Expected: FAIL — `resolveAgentSkills` not exported from agent-router.

- [ ] **Step 3: Add resolveAgentSkills to agent-router.ts**

Add near the top of `src/agent-router.ts` (after imports):

```typescript
import { resolveSkillsForAgent } from "../ellie-forest/src/creature-skills";

/**
 * Resolve the effective skill list for an agent.
 * Uses creature's toolbox if creature_id is set, falls back to tools_enabled.
 */
export async function resolveAgentSkills(
  agent: { creature_id?: string | null; tools_enabled?: string[] },
  resolver: (creatureId: string | null) => Promise<string[] | null> = resolveSkillsForAgent
): Promise<string[]> {
  if (agent.creature_id) {
    const creatureSkills = await resolver(agent.creature_id);
    if (creatureSkills && creatureSkills.length > 0) {
      return creatureSkills;
    }
  }
  return agent.tools_enabled ?? [];
}
```

- [ ] **Step 4: Update localDispatch to use resolveAgentSkills**

In `src/agent-router.ts`, find the `localDispatch()` function around line 128 where `tools_enabled` is read from the agent query. Update the SELECT to include `creature_id`:

Change the agent query (around line 128) from:
```typescript
agents(id, name, type, system_prompt, model, tools_enabled, capabilities)
```
to:
```typescript
agents(id, name, type, system_prompt, model, tools_enabled, capabilities, creature_id)
```

Then around line 224 where `getAllowedMCPs(agent.tools_enabled, agent.name)` is called, replace with:

```typescript
const effectiveSkills = await resolveAgentSkills(agent);
const allowedMCPs = getAllowedMCPs(effectiveSkills, agent.name);
```

And around line 234, replace `getAllowedToolsForCLI(agent.tools_enabled, agent.name)` with:

```typescript
const cliTools = getAllowedToolsForCLI(effectiveSkills, agent.name);
```

- [ ] **Step 5: Run the tests**

Run: `cd /home/ellie/ellie-dev && bun test tests/agent-skill-resolution.test.ts`
Expected: All tests PASS.

Run: `cd /home/ellie/ellie-dev && bun test`
Expected: No regressions in existing tests.

- [ ] **Step 6: Commit**

```bash
git add src/agent-router.ts tests/agent-skill-resolution.test.ts
git commit -m "[ELLIE-1131] Resolve agent skills via creature toolbox"
```

---

## Task 6: Routing Decision Logger

**Files:**
- Create: `src/routing-decision-log.ts`
- Create: `tests/routing-decision-log.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/routing-decision-log.test.ts`:

```typescript
import { describe, it, expect, mock } from "bun:test";

describe("routing-decision-log", () => {
  it("builds a routing decision record from classification result", () => {
    const { buildRoutingDecision } = require("../src/routing-decision-log");

    const classification = {
      agent_name: "dev",
      rule_name: "skill_trigger",
      confidence: 0.88,
      reasoning: "Trigger 'schedule' matched ums-calendar skill on general agent",
      skill_name: "ums-calendar",
    };

    const decision = buildRoutingDecision({
      classification,
      sessionId: "session-123",
      userMessage: "check my schedule for next week",
      agentsConsidered: ["dev", "general", "research"],
      skillsLoaded: ["ums-calendar", "memory"],
    });

    expect(decision.id).toMatch(/^rd_/);
    expect(decision.agent_chosen).toBe("dev");
    expect(decision.confidence).toBe(0.88);
    expect(decision.match_type).toBe("skill_trigger");
    expect(decision.reasoning).toBe("Trigger 'schedule' matched ums-calendar skill on general agent");
    expect(decision.agents_considered).toEqual(["dev", "general", "research"]);
    expect(decision.skills_loaded).toEqual(["ums-calendar", "memory"]);
    expect(decision.user_message).toBe("check my schedule for next week");
    expect(decision.session_id).toBe("session-123");
  });

  it("generates deterministic reasoning for slash commands", () => {
    const { generateReasoning } = require("../src/routing-decision-log");

    const reasoning = generateReasoning({
      rule_name: "slash_command",
      agent_name: "dev",
      confidence: 1.0,
    });

    expect(reasoning).toBe("Explicit /dev command — direct route");
  });

  it("generates reasoning for skill triggers", () => {
    const { generateReasoning } = require("../src/routing-decision-log");

    const reasoning = generateReasoning({
      rule_name: "skill_trigger",
      agent_name: "general",
      skill_name: "ums-calendar",
      skill_description: "Schedule intelligence via UMS",
    });

    expect(reasoning).toContain("ums-calendar");
    expect(reasoning).toContain("general");
  });

  it("truncates user messages longer than 200 chars", () => {
    const { buildRoutingDecision } = require("../src/routing-decision-log");

    const longMessage = "a".repeat(300);
    const decision = buildRoutingDecision({
      classification: { agent_name: "dev", rule_name: "llm_classification", confidence: 0.8 },
      userMessage: longMessage,
      agentsConsidered: ["dev"],
      skillsLoaded: [],
    });

    expect(decision.user_message.length).toBeLessThanOrEqual(203); // 200 + "..."
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/ellie/ellie-dev && bun test tests/routing-decision-log.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement routing-decision-log.ts**

Create `src/routing-decision-log.ts`:

```typescript
import { createClient } from "@supabase/supabase-js";
import { logger } from "./logger";

const log = logger.child({ module: "routing-decision-log" });

export interface RoutingDecision {
  id: string;
  session_id: string | null;
  dispatch_envelope_id: string | null;
  timestamp: string;
  user_message: string;
  agents_considered: string[];
  agent_chosen: string;
  confidence: number;
  match_type: string;
  reasoning: string;
  skills_loaded: string[];
}

interface ClassificationInput {
  agent_name: string;
  rule_name: string;
  confidence: number;
  reasoning?: string;
  skill_name?: string;
  skill_description?: string;
}

interface BuildOpts {
  classification: ClassificationInput;
  sessionId?: string | null;
  dispatchEnvelopeId?: string | null;
  userMessage: string;
  agentsConsidered: string[];
  skillsLoaded: string[];
}

let idCounter = 0;

function generateId(): string {
  const ts = Date.now().toString(36);
  const seq = (idCounter++).toString(36).padStart(2, "0");
  const rand = Math.random().toString(36).slice(2, 6);
  return `rd_${ts}${seq}${rand}`;
}

function truncate(text: string, max: number = 200): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}

export function generateReasoning(classification: ClassificationInput): string {
  const { rule_name, agent_name, skill_name, reasoning } = classification;

  if (reasoning) return reasoning;

  switch (rule_name) {
    case "slash_command":
      return `Explicit /${agent_name} command — direct route`;
    case "skill_trigger":
      return `Trigger matched ${skill_name ?? "unknown"} skill on ${agent_name} agent`;
    case "smart_pattern":
      return `Pattern match routed to ${agent_name} agent`;
    case "session_continuity":
      return `Continuing active session with ${agent_name} agent`;
    case "llm_classification":
      return `LLM classified as ${agent_name} task`;
    default:
      return `Routed to ${agent_name} via ${rule_name}`;
  }
}

export function buildRoutingDecision(opts: BuildOpts): RoutingDecision {
  const { classification, sessionId, dispatchEnvelopeId, userMessage, agentsConsidered, skillsLoaded } = opts;

  return {
    id: generateId(),
    session_id: sessionId ?? null,
    dispatch_envelope_id: dispatchEnvelopeId ?? null,
    timestamp: new Date().toISOString(),
    user_message: truncate(userMessage),
    agents_considered: agentsConsidered,
    agent_chosen: classification.agent_name,
    confidence: classification.confidence,
    match_type: classification.rule_name,
    reasoning: generateReasoning(classification),
    skills_loaded: skillsLoaded,
  };
}

/**
 * Log a routing decision to Supabase. Fire-and-forget — failures don't block dispatch.
 */
export async function logRoutingDecision(
  supabase: ReturnType<typeof createClient>,
  decision: RoutingDecision
): Promise<void> {
  try {
    const { error } = await supabase.from("routing_decisions").insert(decision);
    if (error) {
      log.warn({ error: error.message, decision_id: decision.id }, "Failed to log routing decision");
    }
  } catch (err) {
    log.warn({ error: (err as Error).message, decision_id: decision.id }, "Routing decision log error");
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd /home/ellie/ellie-dev && bun test tests/routing-decision-log.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routing-decision-log.ts tests/routing-decision-log.test.ts
git commit -m "[ELLIE-1132] Add routing decision logger"
```

---

## Task 7: Wire Routing Decision Logging into Intent Classifier

**Files:**
- Modify: `src/intent-classifier.ts` (around lines 126-240)

- [ ] **Step 1: Import the logger at the top of intent-classifier.ts**

Add after existing imports:

```typescript
import { buildRoutingDecision, logRoutingDecision } from "./routing-decision-log";
```

- [ ] **Step 2: Add logging after classifyIntent returns**

In `classifyIntent()` (around line 126), the function builds a `ClassificationResult` and returns it. Before the return, add routing decision logging.

Find the return statement at the end of `classifyIntent()` and add before it:

```typescript
// Log routing decision — fire and forget
const decision = buildRoutingDecision({
  classification: {
    agent_name: result.agent_name,
    rule_name: result.rule_name,
    confidence: result.confidence,
    reasoning: result.reasoning,
    skill_name: result.skill_name,
    skill_description: result.skill_description,
  },
  sessionId: null, // Will be linked by dispatch envelope
  userMessage: message,
  agentsConsidered: agentDescriptions.map((a: { name: string }) => a.name),
  skillsLoaded: [], // Filled in later by dispatch
});

if (supabase) {
  logRoutingDecision(supabase, decision).catch(() => {});
}
```

Note: `agentDescriptions` is the cached list already loaded in the classifier. The exact variable name may differ — check the local scope. The `supabase` client is already available in the module scope of `intent-classifier.ts`.

- [ ] **Step 3: Run existing classifier tests to verify no regressions**

Run: `cd /home/ellie/ellie-dev && bun test tests/intent-classifier.test.ts`
Expected: All existing tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/intent-classifier.ts
git commit -m "[ELLIE-1132] Wire routing decision logging into intent classifier"
```

---

## Task 8: Dashboard API — Agent Skills Endpoint

**Files:**
- Create: `ellie-home/server/api/agents/[id]/skills.get.ts`

- [ ] **Step 1: Write the API endpoint**

Create `ellie-home/server/api/agents/[id]/skills.get.ts`:

```typescript
import { sql } from "~/server/utils/forest-db";

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id");
  if (!id) {
    throw createError({ statusCode: 400, message: "Agent ID required" });
  }

  // Get the agent's creature_id
  // Agent may be in Forest DB or Supabase — check Forest first (agents are entities)
  const agents = await sql`
    SELECT id, name, species FROM entities
    WHERE (id::text = ${id} OR name = ${id}) AND type = 'creature'
    LIMIT 1
  `;

  if (agents.length === 0) {
    return { skills: [], creature: null };
  }

  const creature = agents[0];

  // Get skills from creature's toolbox
  const skills = await sql`
    SELECT cs.skill_name, cs.added_at, cs.added_by
    FROM creature_skills cs
    WHERE cs.creature_id = ${creature.id}
    ORDER BY cs.skill_name
  `;

  // Get archetype defaults for comparison
  const defaults = await sql`
    SELECT skill_name FROM archetype_default_skills
    WHERE archetype = ${creature.species ?? "general"}
  `;

  const defaultSet = new Set(defaults.map((d: { skill_name: string }) => d.skill_name));

  return {
    creature: {
      id: creature.id,
      name: creature.name,
      species: creature.species,
    },
    skills: skills.map((s: { skill_name: string; added_at: string; added_by: string }) => ({
      name: s.skill_name,
      added_at: s.added_at,
      added_by: s.added_by,
      is_archetype_default: defaultSet.has(s.skill_name),
    })),
    archetype_defaults: defaults.map((d: { skill_name: string }) => d.skill_name),
  };
});
```

- [ ] **Step 2: Test manually**

Run: `cd /home/ellie/ellie-home && bun run build && sudo systemctl restart ellie-dashboard`

Then: `curl http://localhost:3000/api/agents/dev/skills | jq .`
Expected: JSON with `creature`, `skills` array, and `archetype_defaults`.

- [ ] **Step 3: Commit**

```bash
cd /home/ellie/ellie-home
git add server/api/agents/\[id\]/skills.get.ts
git commit -m "[ELLIE-1133] Add agent skills API endpoint"
```

---

## Task 9: Dashboard — Agents Page Skills Tab

**Files:**
- Modify: `ellie-home/app/pages/agents/index.vue` (tabs around line 67-74)

- [ ] **Step 1: Add "Skills" to the tabs array**

In `agents/index.vue`, find the tabs definition (around line 67-74) and add `"Skills"` between `"Context Layers"` and `"Prompts"` (or in the appropriate position based on the existing tab order).

- [ ] **Step 2: Add the creature badge to the agent header**

Find the agent detail header (around line 56-64) where the agent name and species are shown. Add a creature badge after the species badge:

```vue
<span
  v-if="selectedAgent?.creature"
  class="ml-2 px-2 py-0.5 rounded text-xs bg-sky-900/50 text-sky-300 border border-sky-800"
>
  {{ selectedAgent.creature.species }} creature
</span>
```

- [ ] **Step 3: Fetch skills data when an agent is selected**

In the `<script setup>` section, add a composable or watcher that fetches skills when `selectedAgentId` changes:

```typescript
const agentSkills = ref<{ creature: any; skills: any[]; archetype_defaults: string[] } | null>(null);

watch(selectedAgentId, async (id) => {
  if (!id) {
    agentSkills.value = null;
    return;
  }
  try {
    const data = await $fetch(`/api/agents/${id}/skills`);
    agentSkills.value = data;
  } catch {
    agentSkills.value = null;
  }
});
```

- [ ] **Step 4: Add the Skills tab content**

Add a new conditional block for the Skills tab:

```vue
<div v-if="activeTab === 'Skills'" class="space-y-4">
  <!-- Creature Toolbox -->
  <div>
    <div class="text-xs text-gray-400 uppercase tracking-wide mb-2">
      Creature Toolbox — {{ agentSkills?.creature?.species ?? 'unknown' }}
    </div>
    <div class="flex flex-wrap gap-2">
      <span
        v-for="skill in agentSkills?.skills ?? []"
        :key="skill.name"
        class="px-3 py-1 rounded-lg text-sm border"
        :class="skill.is_archetype_default
          ? 'bg-green-900/30 border-green-800 text-green-400'
          : 'bg-blue-900/30 border-blue-800 text-blue-400'"
      >
        {{ skill.name }}
      </span>
      <span
        v-if="!agentSkills?.skills?.length"
        class="text-sm text-gray-500"
      >
        No skills assigned
      </span>
    </div>
  </div>

  <!-- Skill Details -->
  <div class="space-y-2">
    <div class="text-xs text-gray-400 uppercase tracking-wide">Skill Details</div>
    <div
      v-for="skill in agentSkills?.skills ?? []"
      :key="skill.name"
      class="p-3 rounded-lg bg-gray-900 border border-gray-800"
    >
      <div class="flex justify-between items-center">
        <span class="text-sm font-medium text-gray-200">{{ skill.name }}</span>
        <span class="text-xs" :class="skill.is_archetype_default ? 'text-green-500' : 'text-blue-500'">
          {{ skill.is_archetype_default ? 'archetype default' : 'custom' }}
        </span>
      </div>
      <div class="text-xs text-gray-500 mt-1">
        Added {{ new Date(skill.added_at).toLocaleDateString() }} by {{ skill.added_by }}
      </div>
    </div>
  </div>

  <!-- Guardrail Footer -->
  <div class="text-xs text-gray-500 border-t border-gray-800 pt-3">
    Skills are managed on the creature. To change this agent's skills, update the
    <strong class="text-gray-400">{{ agentSkills?.creature?.species ?? 'unknown' }}</strong>
    creature's toolbox or assign a different creature.
  </div>
</div>
```

- [ ] **Step 5: Build and test**

Run: `cd /home/ellie/ellie-home && bun run build && sudo systemctl restart ellie-dashboard`

Open `dashboard.ellie-labs.dev`, go to Agents page, select an agent, click the Skills tab. Verify:
- Creature badge appears in the header
- Skills tab shows the creature's toolbox
- Guardrail footer text is present

- [ ] **Step 6: Commit**

```bash
cd /home/ellie/ellie-home
git add app/pages/agents/index.vue
git commit -m "[ELLIE-1133] Add Skills tab to agents page"
```

---

## Task 10: Dashboard API — Orchestrator Sessions Endpoint

**Files:**
- Create: `ellie-home/server/api/orchestrator/sessions.get.ts`
- Create: `ellie-home/server/api/orchestrator/sessions/[id].get.ts`

- [ ] **Step 1: Write the sessions list endpoint**

Create `ellie-home/server/api/orchestrator/sessions.get.ts`:

```typescript
import { serverSupabaseClient } from "#supabase/server";

export default defineEventHandler(async (event) => {
  const client = await serverSupabaseClient(event);
  const query = getQuery(event);
  const limit = Number(query.limit) || 20;

  // Get distinct sessions from routing_decisions, aggregated
  const { data, error } = await client.rpc("get_orchestrator_sessions", { row_limit: limit });

  if (error) {
    // Fallback: raw query
    const { data: raw, error: rawErr } = await client
      .from("routing_decisions")
      .select("session_id, timestamp, agent_chosen, confidence")
      .order("timestamp", { ascending: false })
      .limit(limit * 10);

    if (rawErr) {
      throw createError({ statusCode: 500, message: rawErr.message });
    }

    // Group by session manually
    const sessions = new Map<string, any>();
    for (const row of raw ?? []) {
      const sid = row.session_id ?? "no-session";
      if (!sessions.has(sid)) {
        sessions.set(sid, {
          session_id: sid,
          first_timestamp: row.timestamp,
          last_timestamp: row.timestamp,
          dispatch_count: 0,
          low_confidence_count: 0,
          agents_used: new Set<string>(),
        });
      }
      const s = sessions.get(sid)!;
      s.dispatch_count++;
      if (row.confidence < 0.7) s.low_confidence_count++;
      s.agents_used.add(row.agent_chosen);
      if (row.timestamp < s.first_timestamp) s.first_timestamp = row.timestamp;
      if (row.timestamp > s.last_timestamp) s.last_timestamp = row.timestamp;
    }

    return Array.from(sessions.values())
      .map((s) => ({ ...s, agents_used: Array.from(s.agents_used) }))
      .slice(0, limit);
  }

  return data;
});
```

- [ ] **Step 2: Write the session detail endpoint**

Create `ellie-home/server/api/orchestrator/sessions/[id].get.ts`:

```typescript
import { serverSupabaseClient } from "#supabase/server";

export default defineEventHandler(async (event) => {
  const client = await serverSupabaseClient(event);
  const sessionId = getRouterParam(event, "id");

  if (!sessionId) {
    throw createError({ statusCode: 400, message: "Session ID required" });
  }

  const { data, error } = await client
    .from("routing_decisions")
    .select("*")
    .eq("session_id", sessionId)
    .order("timestamp", { ascending: true });

  if (error) {
    throw createError({ statusCode: 500, message: error.message });
  }

  if (!data || data.length === 0) {
    return { session_id: sessionId, decisions: [], summary: null };
  }

  const agents = new Set(data.map((d) => d.agent_chosen));
  const lowConfidence = data.filter((d) => d.confidence < 0.7).length;

  return {
    session_id: sessionId,
    decisions: data,
    summary: {
      dispatch_count: data.length,
      agents_used: Array.from(agents),
      low_confidence_count: lowConfidence,
      first_timestamp: data[0].timestamp,
      last_timestamp: data[data.length - 1].timestamp,
    },
  };
});
```

- [ ] **Step 3: Commit**

```bash
cd /home/ellie/ellie-home
git add server/api/orchestrator/sessions.get.ts server/api/orchestrator/sessions/\[id\].get.ts
git commit -m "[ELLIE-1133] Add orchestrator sessions API endpoints"
```

---

## Task 11: Dashboard — Orchestrator Session Replay Page

**Files:**
- Create: `ellie-home/app/pages/orchestrator.vue`

- [ ] **Step 1: Create the page**

Create `ellie-home/app/pages/orchestrator.vue`:

```vue
<script setup lang="ts">
definePageMeta({ layout: "default" });

interface RoutingDecision {
  id: string;
  session_id: string;
  timestamp: string;
  user_message: string;
  agents_considered: string[];
  agent_chosen: string;
  confidence: number;
  match_type: string;
  reasoning: string;
  skills_loaded: string[];
}

interface SessionSummary {
  dispatch_count: number;
  agents_used: string[];
  low_confidence_count: number;
  first_timestamp: string;
  last_timestamp: string;
}

interface SessionListItem {
  session_id: string;
  first_timestamp: string;
  last_timestamp: string;
  dispatch_count: number;
  low_confidence_count: number;
  agents_used: string[];
}

const sessions = ref<SessionListItem[]>([]);
const selectedSessionId = ref<string | null>(null);
const decisions = ref<RoutingDecision[]>([]);
const summary = ref<SessionSummary | null>(null);
const loading = ref(false);

async function loadSessions() {
  try {
    sessions.value = await $fetch("/api/orchestrator/sessions");
    if (sessions.value.length > 0 && !selectedSessionId.value) {
      selectedSessionId.value = sessions.value[0].session_id;
    }
  } catch {
    sessions.value = [];
  }
}

async function loadSession(id: string) {
  loading.value = true;
  try {
    const data = await $fetch(`/api/orchestrator/sessions/${id}`);
    decisions.value = data.decisions;
    summary.value = data.summary;
  } catch {
    decisions.value = [];
    summary.value = null;
  } finally {
    loading.value = false;
  }
}

watch(selectedSessionId, (id) => {
  if (id) loadSession(id);
});

function navigateSession(dir: -1 | 1) {
  const idx = sessions.value.findIndex((s) => s.session_id === selectedSessionId.value);
  const next = idx + dir;
  if (next >= 0 && next < sessions.value.length) {
    selectedSessionId.value = sessions.value[next].session_id;
  }
}

function formatTime(ts: string) {
  return new Date(ts).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Chicago",
  });
}

function formatDate(ts: string) {
  return new Date(ts).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "America/Chicago",
  });
}

function duration(start: string, end: string) {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const mins = Math.round(ms / 60000);
  return mins < 1 ? "<1 min" : `${mins} min`;
}

function confidenceColor(c: number) {
  return c >= 0.7 ? "bg-green-500" : "bg-orange-500";
}

function confidenceBadgeClass(c: number) {
  return c >= 0.7
    ? "bg-green-900/50 text-green-400"
    : "bg-orange-900/50 text-orange-400";
}

function cardBorderClass(c: number) {
  return c >= 0.7
    ? "border-gray-800"
    : "border-orange-800/60 bg-orange-950/20";
}

onMounted(loadSessions);
</script>

<template>
  <div class="max-w-4xl mx-auto p-6">
    <h1 class="text-xl font-semibold text-gray-100 mb-6">Orchestrator Session Replay</h1>

    <!-- Session Selector -->
    <div v-if="summary" class="flex justify-between items-center mb-6 pb-4 border-b border-gray-800">
      <div>
        <span class="font-medium text-gray-200">
          {{ formatDate(summary.first_timestamp) }},
          {{ formatTime(summary.first_timestamp) }} — {{ formatTime(summary.last_timestamp) }}
        </span>
        <span class="text-sm text-gray-400 ml-3">
          {{ duration(summary.first_timestamp, summary.last_timestamp) }} &middot;
          {{ summary.dispatch_count }} dispatches
        </span>
      </div>
      <div class="flex gap-2">
        <button
          class="px-3 py-1 rounded text-xs bg-gray-700 text-gray-300 hover:bg-gray-600"
          @click="navigateSession(-1)"
        >
          &larr; Previous
        </button>
        <button
          class="px-3 py-1 rounded text-xs bg-gray-700 text-gray-300 hover:bg-gray-600"
          @click="navigateSession(1)"
        >
          Next &rarr;
        </button>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="text-gray-500 text-sm">Loading session...</div>

    <!-- Empty State -->
    <div v-else-if="decisions.length === 0" class="text-gray-500 text-sm">
      No routing decisions recorded yet. Decisions will appear here after the coordinator dispatches agents.
    </div>

    <!-- Timeline -->
    <div v-else class="relative pl-6 border-l-2 border-gray-800">
      <div v-for="d in decisions" :key="d.id" class="mb-5 relative">
        <!-- Timeline dot -->
        <div
          class="absolute -left-[29px] top-1 w-2.5 h-2.5 rounded-full"
          :class="confidenceColor(d.confidence)"
        />

        <!-- Timestamp -->
        <div class="text-xs text-gray-500">{{ formatTime(d.timestamp) }}</div>

        <!-- Decision Card -->
        <div
          class="mt-1 p-3 rounded-lg border bg-gray-900"
          :class="cardBorderClass(d.confidence)"
        >
          <!-- Header: message + badges -->
          <div class="flex justify-between items-start gap-3">
            <div class="min-w-0">
              <span class="text-xs text-gray-400">User:</span>
              <span class="text-sm text-gray-200 ml-1">{{ d.user_message }}</span>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <span class="px-2 py-0.5 rounded text-xs" :class="confidenceBadgeClass(d.confidence)">
                {{ d.confidence.toFixed(2) }}
              </span>
              <span class="px-2 py-0.5 rounded text-xs bg-sky-900/50 text-sky-300">
                {{ d.match_type }}
              </span>
            </div>
          </div>

          <!-- Routing outcome -->
          <div class="mt-2 text-sm">
            <span class="text-blue-400">&rarr; {{ d.agent_chosen }}</span>
            <span v-if="d.skills_loaded?.length" class="text-xs text-gray-500 ml-2">
              skills: {{ d.skills_loaded.join(", ") }}
            </span>
          </div>

          <!-- Reasoning -->
          <div
            class="mt-1 text-xs"
            :class="d.confidence < 0.7 ? 'text-orange-400' : 'text-gray-500'"
          >
            <span v-if="d.confidence < 0.7">&#9888; </span>{{ d.reasoning }}
          </div>
        </div>
      </div>
    </div>

    <!-- Session Summary Footer -->
    <div v-if="summary" class="mt-6 pt-4 border-t border-gray-800 flex gap-6 text-sm text-gray-400">
      <div><strong class="text-gray-200">{{ summary.dispatch_count }}</strong> dispatches</div>
      <div><strong class="text-gray-200">{{ summary.agents_used.length }}</strong> agents used</div>
      <div>
        <strong :class="summary.low_confidence_count > 0 ? 'text-orange-400' : 'text-gray-200'">
          {{ summary.low_confidence_count }}
        </strong> low confidence
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Build and test**

Run: `cd /home/ellie/ellie-home && bun run build && sudo systemctl restart ellie-dashboard`

Open `dashboard.ellie-labs.dev/orchestrator`. Verify:
- Page loads without errors
- Empty state message shows if no routing decisions exist yet
- Session selector, timeline, and summary footer render correctly once data exists

- [ ] **Step 3: Commit**

```bash
cd /home/ellie/ellie-home
git add app/pages/orchestrator.vue
git commit -m "[ELLIE-1133] Add orchestrator session replay page"
```

---

## Summary

| Task | Ticket | What It Does |
|------|--------|-------------|
| 1 | ELLIE-1131 | Forest DB schema: creature_skills + archetype_default_skills |
| 2 | ELLIE-1132 | Supabase schema: routing_decisions + agents.creature_id |
| 3 | ELLIE-1131 | creature-skills CRUD library with tests |
| 4 | ELLIE-1131 | Seed archetype defaults |
| 5 | ELLIE-1131 | Coordinator skill resolution swap |
| 6 | ELLIE-1132 | Routing decision logger with tests |
| 7 | ELLIE-1132 | Wire logging into intent classifier |
| 8 | ELLIE-1133 | Dashboard API: agent skills endpoint |
| 9 | ELLIE-1133 | Dashboard: agents page Skills tab |
| 10 | ELLIE-1133 | Dashboard API: orchestrator sessions endpoints |
| 11 | ELLIE-1133 | Dashboard: orchestrator session replay page |
