# Agent System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a comprehensive agent management system with full config visibility (5-tab detail view with prompt history debugging) and a 4-step agent creation wizard that writes across Supabase, Forest, and foundations.

**Architecture:** Relay-side APIs provide prompt history storage, context layer introspection, and agent creation. Dashboard-side Nuxt pages consume these APIs through server proxy routes. The agents page is restructured from 3 tabs to 5, and a new `/agents/create` wizard page is added.

**Tech Stack:** Bun + TypeScript (relay), Nuxt 4.3 + Vue 3.5 + Tailwind v4 (dashboard), Supabase (cloud DB), Forest/postgres.js (local DB)

---

## File Structure

### Relay (`/home/ellie/ellie-dev`)

| File | Action | Responsibility |
|------|--------|---------------|
| `migrations/supabase/20260329_agent_prompt_history.sql` | Create | Schema for prompt history table |
| `src/api/agent-prompts.ts` | Create | Store and retrieve prompt history |
| `src/api/agent-context-layers.ts` | Create | Return agent's prompt assembly layers |
| `src/api/agent-create.ts` | Create | Full agent creation (Supabase + Forest + Foundation) |
| `src/http-routes.ts` | Modify | Register new API routes |
| `src/ellie-chat-handler.ts` | Modify | Capture prompt after buildPrompt |
| `src/telegram-handlers.ts` | Modify | Capture prompt after buildPrompt |

### Dashboard (`/home/ellie/ellie-home`)

| File | Action | Responsibility |
|------|--------|---------------|
| `server/api/agents/[id]/prompts.ts` | Create | Proxy to relay prompt history API |
| `server/api/agents/[id]/context-layers.ts` | Create | Proxy to relay context layers API |
| `server/api/agents/create.post.ts` | Create | Proxy to relay agent creation API |
| `app/pages/agents/index.vue` | Modify | Restructure to 5 tabs |
| `app/pages/agents/create.vue` | Create | 4-step creation wizard |
| `app/composables/useAgentData.ts` | Create | Agent detail data fetching |

---

### Task 1: Prompt History Schema and API

**Files:**
- Create: `/home/ellie/ellie-dev/migrations/supabase/20260329_agent_prompt_history.sql`
- Create: `/home/ellie/ellie-dev/src/api/agent-prompts.ts`
- Modify: `/home/ellie/ellie-dev/src/http-routes.ts`

- [ ] **Step 1: Create the migration**

```sql
-- migrations/supabase/20260329_agent_prompt_history.sql
CREATE TABLE IF NOT EXISTS agent_prompt_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name TEXT NOT NULL,
  channel TEXT NOT NULL,
  work_item_id TEXT,
  prompt_text TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0,
  cost_estimate_usd NUMERIC(10, 4) DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_prompt_history_agent
  ON agent_prompt_history (agent_name, created_at DESC);

-- Auto-cleanup: delete entries older than 24 hours
-- (Triggered on INSERT to keep the table bounded)
CREATE OR REPLACE FUNCTION cleanup_old_prompts() RETURNS trigger AS $$
BEGIN
  DELETE FROM agent_prompt_history
  WHERE created_at < now() - interval '24 hours';

  -- Also enforce max 20 per agent
  DELETE FROM agent_prompt_history
  WHERE id IN (
    SELECT id FROM agent_prompt_history h
    WHERE h.agent_name = NEW.agent_name
    ORDER BY created_at DESC
    OFFSET 20
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_cleanup_old_prompts
  AFTER INSERT ON agent_prompt_history
  FOR EACH ROW EXECUTE FUNCTION cleanup_old_prompts();
```

- [ ] **Step 2: Apply the migration**

```bash
source .env && curl -s -X POST "https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query" \
  -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"query\": $(cat migrations/supabase/20260329_agent_prompt_history.sql | tr '\n' ' ' | jq -Rs .)}"
```

- [ ] **Step 3: Create the prompt history API**

```typescript
// src/api/agent-prompts.ts
import { log } from "../logger.ts";
import { getRelayDeps } from "../relay-deps.ts";

const logger = log.child("agent-prompts");

interface ApiRequest {
  body?: Record<string, unknown>;
  query?: Record<string, string>;
  params?: Record<string, string>;
}

interface ApiResponse {
  status(code: number): ApiResponse;
  json(data: unknown): void;
}

/**
 * POST /api/agents/:name/prompts — Store a prompt snapshot
 */
export async function storePromptEndpoint(req: ApiRequest, res: ApiResponse): Promise<void> {
  const agentName = req.params?.name;
  const { channel, work_item_id, prompt_text, token_count, cost_estimate_usd } = req.body ?? {};

  if (!agentName || !prompt_text) {
    res.status(400).json({ error: "Missing agent_name or prompt_text" });
    return;
  }

  try {
    const { supabase } = getRelayDeps();
    if (!supabase) {
      res.status(503).json({ error: "Database not available" });
      return;
    }

    const { error } = await supabase.from("agent_prompt_history").insert({
      agent_name: agentName,
      channel: channel || "unknown",
      work_item_id: work_item_id || null,
      prompt_text,
      token_count: token_count || 0,
      cost_estimate_usd: cost_estimate_usd || 0,
    });

    if (error) {
      logger.error("Failed to store prompt", { agent: agentName, error: error.message });
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    logger.error("storePrompt error", { agent: agentName }, err);
    res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * GET /api/agents/:name/prompts — Retrieve prompt history
 * Query params: ?limit=5&full=true
 */
export async function getPromptsEndpoint(req: ApiRequest, res: ApiResponse): Promise<void> {
  const agentName = req.params?.name;
  const limit = parseInt(req.query?.limit || "5", 10);
  const full = req.query?.full === "true";

  if (!agentName) {
    res.status(400).json({ error: "Missing agent_name" });
    return;
  }

  try {
    const { supabase } = getRelayDeps();
    if (!supabase) {
      res.status(503).json({ error: "Database not available" });
      return;
    }

    const columns = full
      ? "id, agent_name, channel, work_item_id, prompt_text, token_count, cost_estimate_usd, created_at"
      : "id, agent_name, channel, work_item_id, token_count, cost_estimate_usd, created_at";

    const { data, error } = await supabase
      .from("agent_prompt_history")
      .select(columns)
      .eq("agent_name", agentName)
      .order("created_at", { ascending: false })
      .limit(Math.min(limit, 20));

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({ prompts: data || [] });
  } catch (err) {
    logger.error("getPrompts error", { agent: agentName }, err);
    res.status(500).json({ error: "Internal server error" });
  }
}
```

- [ ] **Step 4: Register routes in http-routes.ts**

Find the route dispatcher in `src/http-routes.ts`. Add routes for the prompt history endpoints. Follow the existing pattern (URL pathname matching + method check).

```typescript
// Add import at top
import { storePromptEndpoint, getPromptsEndpoint } from "./api/agent-prompts.ts";

// In the route dispatcher, add:
if (url.pathname.match(/^\/api\/agents\/[^/]+\/prompts$/) && req.method === "POST") {
  const agentName = url.pathname.split("/")[3];
  await storePromptEndpoint({ body: data, params: { name: agentName } }, mockRes);
  return;
}

if (url.pathname.match(/^\/api\/agents\/[^/]+\/prompts$/) && req.method === "GET") {
  const agentName = url.pathname.split("/")[3];
  await getPromptsEndpoint({ params: { name: agentName }, query: queryParams }, mockRes);
  return;
}
```

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-dev && git add migrations/supabase/20260329_agent_prompt_history.sql src/api/agent-prompts.ts src/http-routes.ts && git commit -m "feat: add prompt history API — store and retrieve agent prompts"
```

---

### Task 2: Prompt Capture in Handlers

**Files:**
- Modify: `/home/ellie/ellie-dev/src/ellie-chat-handler.ts`
- Modify: `/home/ellie/ellie-dev/src/telegram-handlers.ts`

- [ ] **Step 1: Add prompt capture helper**

Create a fire-and-forget helper that stores the prompt after buildPrompt returns. Add this to `src/api/agent-prompts.ts`:

```typescript
/**
 * Fire-and-forget prompt capture — called after buildPrompt in handlers.
 * Non-blocking: errors are logged but don't affect the dispatch.
 */
export function capturePrompt(opts: {
  agentName: string;
  channel: string;
  workItemId?: string;
  promptText: string;
  tokenCount: number;
}): void {
  // Don't capture in coordinator mode — the coordinator builds its own lean prompt
  fetch("http://localhost:3001/api/agents/" + encodeURIComponent(opts.agentName) + "/prompts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      channel: opts.channel,
      work_item_id: opts.workItemId || null,
      prompt_text: opts.promptText,
      token_count: opts.tokenCount,
    }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {}); // Silent failure
}
```

- [ ] **Step 2: Add capture to ellie-chat-handler.ts**

Find the line after `buildPrompt` returns (around line 1190 in the non-coordinator path, after `const enrichedPrompt = await buildPrompt(...)`). Add:

```typescript
// Capture prompt for debugging (fire-and-forget)
import { capturePrompt } from "./api/agent-prompts.ts";
capturePrompt({
  agentName: ellieChatActiveAgent || "general",
  channel: "ellie-chat",
  workItemId: ellieChatWorkItem,
  promptText: enrichedPrompt,
  tokenCount: enrichedPrompt.length / 4, // rough estimate
});
```

- [ ] **Step 3: Add capture to telegram-handlers.ts**

Find the same pattern after `buildPrompt` returns in the Telegram handler (non-coordinator path). Add the same `capturePrompt` call with `channel: "telegram"`.

- [ ] **Step 4: Commit**

```bash
cd /home/ellie/ellie-dev && git add src/api/agent-prompts.ts src/ellie-chat-handler.ts src/telegram-handlers.ts && git commit -m "feat: capture prompts after buildPrompt for debugging"
```

---

### Task 3: Context Layers API

**Files:**
- Create: `/home/ellie/ellie-dev/src/api/agent-context-layers.ts`
- Modify: `/home/ellie/ellie-dev/src/http-routes.ts`

- [ ] **Step 1: Create the context layers endpoint**

This endpoint returns the agent's prompt assembly layers — what content goes into each section and at what priority.

```typescript
// src/api/agent-context-layers.ts
import { log } from "../logger.ts";
import { getRelayDeps } from "../relay-deps.ts";

const logger = log.child("agent-context-layers");

interface ApiRequest {
  params?: Record<string, string>;
}

interface ApiResponse {
  status(code: number): ApiResponse;
  json(data: unknown): void;
}

export async function getContextLayersEndpoint(req: ApiRequest, res: ApiResponse): Promise<void> {
  const agentName = req.params?.name;
  if (!agentName) {
    res.status(400).json({ error: "Missing agent_name" });
    return;
  }

  try {
    // Get creature profile for section priorities
    const { getCreatureProfile } = await import("../creature-profile.ts");
    const profile = getCreatureProfile(agentName);

    // Get River docs (soul, creature, role templates)
    const { getCachedRiverDoc } = await import("../bridge-river.ts");
    const soul = await getCachedRiverDoc("soul").catch(() => null);
    const creatureName = profile?.creature || "squirrel";
    const creatureDoc = await getCachedRiverDoc(`${creatureName}`).catch(() => null);
    const roleTemplate = await getCachedRiverDoc(`${agentName}-agent-template`).catch(() => null);

    // Get agent record from Supabase for tools/capabilities
    const { supabase } = getRelayDeps();
    let agentRecord: Record<string, unknown> | null = null;
    if (supabase) {
      const { data } = await supabase
        .from("agents")
        .select("*")
        .eq("name", agentName)
        .single();
      agentRecord = data;
    }

    // Get eligible skills
    const { getSkillSnapshot } = await import("../skills/index.ts");
    let skillSnapshot: { prompt?: string; skills?: string[] } = {};
    try {
      skillSnapshot = await getSkillSnapshot(profile?.allowed_skills, "");
    } catch { /* non-critical */ }

    // Build layers array in priority order
    const layers = [
      {
        name: "Soul",
        priority: profile?.section_priorities?.soul ?? 1,
        source: "River vault (soul.md)",
        content: soul?.slice(0, 500) || null,
        token_estimate: soul ? Math.round(soul.length / 4) : 0,
        configured: !!soul,
      },
      {
        name: "Creature DNA",
        priority: profile?.section_priorities?.archetype ?? 2,
        source: `River vault (${creatureName}.md)`,
        content: creatureDoc?.slice(0, 500) || null,
        token_estimate: creatureDoc ? Math.round(creatureDoc.length / 4) : 0,
        configured: !!creatureDoc,
        metadata: {
          creature: creatureName,
          cognitive_style: (agentRecord?.metadata as Record<string, unknown>)?.cognitive_style || null,
          token_budget: profile?.token_budget || null,
        },
      },
      {
        name: "Role Template",
        priority: profile?.section_priorities?.role ?? 3,
        source: `River vault (${agentName}-agent-template.md)`,
        content: roleTemplate?.slice(0, 500) || null,
        token_estimate: roleTemplate ? Math.round(roleTemplate.length / 4) : 0,
        configured: !!roleTemplate,
      },
      {
        name: "Skills",
        priority: profile?.section_priorities?.skills ?? 5,
        source: "Skill registry (SKILL.md files)",
        content: skillSnapshot.skills?.join(", ") || "No skills loaded",
        token_estimate: skillSnapshot.prompt ? Math.round(skillSnapshot.prompt.length / 4) : 0,
        configured: (skillSnapshot.skills?.length ?? 0) > 0,
        metadata: {
          skill_count: skillSnapshot.skills?.length ?? 0,
          allowed_skills: profile?.allowed_skills || null,
        },
      },
      {
        name: "Working Memory",
        priority: profile?.section_priorities?.working_memory ?? 6,
        source: "Supabase (working_memory table)",
        content: "7 sections: session_identity, task_stack, conversation_thread, investigation_state, decision_log, context_anchors, resumption_prompt",
        token_estimate: 0, // Dynamic, varies per session
        configured: true,
      },
      {
        name: "Tools Enabled",
        priority: 99,
        source: "Supabase (agents.tools_enabled)",
        content: ((agentRecord?.tools_enabled as string[]) || []).join(", "),
        token_estimate: 0,
        configured: !!agentRecord?.tools_enabled,
        metadata: {
          tool_categories: agentRecord?.tools_enabled || [],
          capabilities: agentRecord?.capabilities || [],
        },
      },
    ];

    // Sort by priority
    layers.sort((a, b) => a.priority - b.priority);

    res.json({
      agent: agentName,
      creature: creatureName,
      token_budget: profile?.token_budget || 100000,
      layers,
    });
  } catch (err) {
    logger.error("getContextLayers error", { agent: agentName }, err);
    res.status(500).json({ error: "Internal server error" });
  }
}
```

- [ ] **Step 2: Register route in http-routes.ts**

```typescript
import { getContextLayersEndpoint } from "./api/agent-context-layers.ts";

// Add route:
if (url.pathname.match(/^\/api\/agents\/[^/]+\/context-layers$/) && req.method === "GET") {
  const agentName = url.pathname.split("/")[3];
  await getContextLayersEndpoint({ params: { name: agentName } }, mockRes);
  return;
}
```

- [ ] **Step 3: Commit**

```bash
cd /home/ellie/ellie-dev && git add src/api/agent-context-layers.ts src/http-routes.ts && git commit -m "feat: add context layers API — returns agent prompt assembly layers"
```

---

### Task 4: Agent Creation API

**Files:**
- Create: `/home/ellie/ellie-dev/src/api/agent-create.ts`
- Modify: `/home/ellie/ellie-dev/src/http-routes.ts`

- [ ] **Step 1: Create the agent creation endpoint**

```typescript
// src/api/agent-create.ts
import { log } from "../logger.ts";
import { getRelayDeps } from "../relay-deps.ts";

const logger = log.child("agent-create");

interface ApiRequest {
  body?: Record<string, unknown>;
}

interface ApiResponse {
  status(code: number): ApiResponse;
  json(data: unknown): void;
}

interface CreateAgentInput {
  name: string;           // system key (lowercase, alphanumeric + hyphens)
  persona_name: string;   // display name
  role: string;           // one-word role
  color: string;          // hex color
  description: string;
  model: string;
  creature: string;       // squirrel | ant | owl | bee | custom
  tools: string[];        // tool category names
  capabilities: string[];
  foundations: string[];   // foundation names to add agent to
  token_budget?: number;
  section_priorities?: Record<string, number>;
}

export async function createAgentEndpoint(req: ApiRequest, res: ApiResponse): Promise<void> {
  const input = req.body as CreateAgentInput;

  // Validate
  if (!input?.name || !input?.persona_name || !input?.role) {
    res.status(400).json({ error: "Missing required fields: name, persona_name, role" });
    return;
  }

  if (!/^[a-z0-9-]+$/.test(input.name)) {
    res.status(400).json({ error: "Agent name must be lowercase alphanumeric with hyphens only" });
    return;
  }

  const { supabase } = getRelayDeps();
  if (!supabase) {
    res.status(503).json({ error: "Database not available" });
    return;
  }

  const results: Record<string, string> = {};

  try {
    // 1. Check name uniqueness
    const { data: existing } = await supabase
      .from("agents")
      .select("name")
      .eq("name", input.name)
      .single();

    if (existing) {
      res.status(409).json({ error: `Agent "${input.name}" already exists` });
      return;
    }

    // 2. Create Supabase agent record
    const { error: insertError } = await supabase.from("agents").insert({
      name: input.name,
      type: input.role,
      status: "active",
      capabilities: input.capabilities || [],
      tools_enabled: input.tools || [],
      metadata: {
        species: input.creature,
        cognitive_style: getCognitiveStyle(input.creature),
        description: input.description,
        persona_name: input.persona_name,
        color: input.color,
      },
    });

    if (insertError) {
      res.status(500).json({ error: `Supabase insert failed: ${insertError.message}` });
      return;
    }
    results.supabase = "created";

    // 3. Create Forest wiring branch
    try {
      const bridgeKey = process.env.BRIDGE_KEY || "";
      const wiringContent = buildWiringContent(input);
      await fetch("http://localhost:3001/api/bridge/write", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-bridge-key": bridgeKey,
        },
        body: JSON.stringify({
          content: wiringContent,
          type: "fact",
          scope_path: "2/1",
          metadata: {
            agent_name: input.name,
            source: "agent-creator",
          },
        }),
        signal: AbortSignal.timeout(10000),
      });
      results.forest = "created";
    } catch (err) {
      results.forest = `failed: ${err instanceof Error ? err.message : String(err)}`;
      logger.warn("Forest wiring creation failed", { agent: input.name, error: results.forest });
    }

    // 4. Add to foundations
    for (const foundationName of (input.foundations || [])) {
      try {
        // Fetch current foundation
        const { data: foundation } = await supabase
          .from("foundations")
          .select("agents")
          .eq("name", foundationName)
          .single();

        if (foundation) {
          const agents = (foundation.agents as unknown[]) || [];
          agents.push({
            name: input.name,
            role: input.role,
            tools: input.tools || [],
            model: input.model || "claude-sonnet-4-6",
          });

          await supabase
            .from("foundations")
            .update({ agents })
            .eq("name", foundationName);

          results[`foundation:${foundationName}`] = "added";
        } else {
          results[`foundation:${foundationName}`] = "not found";
        }
      } catch (err) {
        results[`foundation:${foundationName}`] = `failed: ${String(err)}`;
      }
    }

    logger.info("Agent created", { name: input.name, results });
    res.json({ success: true, agent_name: input.name, results });
  } catch (err) {
    logger.error("createAgent error", { name: input.name }, err);
    res.status(500).json({ error: "Internal server error", results });
  }
}

function getCognitiveStyle(creature: string): string {
  const styles: Record<string, string> = {
    squirrel: "breadth-first, context-aware, strategic routing",
    ant: "depth-first, single-threaded, methodical verification",
    owl: "depth-first, pattern-recognition, systematic-review",
    bee: "specialized, task-focused, efficient execution",
  };
  return styles[creature] || "general-purpose";
}

function buildWiringContent(input: CreateAgentInput): string {
  const priorities = input.section_priorities || {
    soul: 1, archetype: 2, role: 3, relationship: 4, skills: 5,
  };

  return [
    `Agent Wiring: ${input.name} (${input.persona_name})`,
    ``,
    `Creature: ${input.creature}`,
    `Role: ${input.role}`,
    `Model: ${input.model || "claude-sonnet-4-6"}`,
    `Token Budget: ${input.token_budget || 100000}`,
    ``,
    `Description: ${input.description}`,
    `Cognitive Style: ${getCognitiveStyle(input.creature)}`,
    ``,
    `Section Priorities: ${JSON.stringify(priorities)}`,
    `Tools: ${(input.tools || []).join(", ")}`,
    `Capabilities: ${(input.capabilities || []).join(", ")}`,
  ].join("\n");
}
```

- [ ] **Step 2: Register route**

```typescript
import { createAgentEndpoint } from "./api/agent-create.ts";

if (url.pathname === "/api/agents/create" && req.method === "POST") {
  await createAgentEndpoint({ body: data }, mockRes);
  return;
}
```

- [ ] **Step 3: Commit**

```bash
cd /home/ellie/ellie-dev && git add src/api/agent-create.ts src/http-routes.ts && git commit -m "feat: add agent creation API — writes to Supabase, Forest, and foundations"
```

---

### Task 5: Dashboard — useAgentData Composable

**Files:**
- Create: `/home/ellie/ellie-home/app/composables/useAgentData.ts`

- [ ] **Step 1: Create the composable**

```typescript
// app/composables/useAgentData.ts

export interface ContextLayer {
  name: string;
  priority: number;
  source: string;
  content: string | null;
  token_estimate: number;
  configured: boolean;
  metadata?: Record<string, unknown>;
}

export interface PromptHistoryEntry {
  id: string;
  agent_name: string;
  channel: string;
  work_item_id: string | null;
  prompt_text?: string;
  token_count: number;
  cost_estimate_usd: number;
  created_at: string;
}

export function useAgentData(agentName: Ref<string | null>) {
  const layers = ref<ContextLayer[]>([]);
  const prompts = ref<PromptHistoryEntry[]>([]);
  const layersLoading = ref(false);
  const promptsLoading = ref(false);

  async function fetchLayers() {
    if (!agentName.value) return;
    layersLoading.value = true;
    try {
      const data = await $fetch(`/api/agents/${agentName.value}/context-layers`);
      layers.value = (data as Record<string, unknown>).layers as ContextLayer[] ?? [];
    } catch (err) {
      console.error("Failed to fetch context layers", err);
      layers.value = [];
    } finally {
      layersLoading.value = false;
    }
  }

  async function fetchPrompts(full = false) {
    if (!agentName.value) return;
    promptsLoading.value = true;
    try {
      const data = await $fetch(`/api/agents/${agentName.value}/prompts${full ? '?full=true' : ''}`);
      prompts.value = (data as Record<string, unknown>).prompts as PromptHistoryEntry[] ?? [];
    } catch (err) {
      console.error("Failed to fetch prompt history", err);
      prompts.value = [];
    } finally {
      promptsLoading.value = false;
    }
  }

  async function fetchFullPrompt(promptId: string): Promise<string | null> {
    if (!agentName.value) return null;
    try {
      const data = await $fetch(`/api/agents/${agentName.value}/prompts?full=true&limit=20`);
      const all = (data as Record<string, unknown>).prompts as PromptHistoryEntry[] ?? [];
      const match = all.find(p => p.id === promptId);
      return match?.prompt_text ?? null;
    } catch {
      return null;
    }
  }

  // Auto-fetch when agent changes
  watch(agentName, (name) => {
    if (name) {
      fetchLayers();
      fetchPrompts();
    }
  });

  return {
    layers,
    prompts,
    layersLoading,
    promptsLoading,
    fetchLayers,
    fetchPrompts,
    fetchFullPrompt,
  };
}
```

- [ ] **Step 2: Create dashboard proxy routes**

Create two Nuxt server routes that proxy to the relay:

```typescript
// server/api/agents/[id]/prompts.ts
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id');
  const query = getQuery(event);
  const qs = new URLSearchParams(query as Record<string, string>).toString();
  const res = await fetch(`http://localhost:3001/api/agents/${id}/prompts${qs ? '?' + qs : ''}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw createError({ statusCode: res.status, message: 'Failed to fetch prompts' });
  return res.json();
});
```

```typescript
// server/api/agents/[id]/context-layers.ts
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id');
  const res = await fetch(`http://localhost:3001/api/agents/${id}/context-layers`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw createError({ statusCode: res.status, message: 'Failed to fetch context layers' });
  return res.json();
});
```

```typescript
// server/api/agents/create.post.ts
export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  const res = await fetch('http://localhost:3001/api/agents/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw createError({ statusCode: res.status, message: (err as Record<string, string>).error || 'Creation failed' });
  }
  return res.json();
});
```

- [ ] **Step 3: Commit**

```bash
cd /home/ellie/ellie-home && git add app/composables/useAgentData.ts server/api/agents/[id]/prompts.ts server/api/agents/[id]/context-layers.ts server/api/agents/create.post.ts && git commit -m "feat: add useAgentData composable + proxy routes for prompts, layers, creation"
```

---

### Task 6: Restructure Agents Page to 5 Tabs

**Files:**
- Modify: `/home/ellie/ellie-home/app/pages/agents/index.vue`

This is the largest UI task. The current 3-tab structure (Config, Profile, Performance) becomes 5 tabs (Overview, Context Layers, Prompt History, Config, Performance).

- [ ] **Step 1: Read the current agents page**

Read `/home/ellie/ellie-home/app/pages/agents/index.vue` thoroughly. Understand the current tab structure, data flow, and how the detail panel works.

- [ ] **Step 2: Add the new tabs and Overview content**

Replace the tab system with 5 tabs. The Overview tab shows identity at a glance:
- Agent name + persona name
- Species + creature type
- Role, model, status
- Foundations membership (query from Supabase)
- Capabilities list
- Last dispatch info
- Cognitive style

- [ ] **Step 3: Add Context Layers tab**

Use `useAgentData` composable. Render each layer as an expandable card showing:
- Layer name + priority number
- Source description
- Token estimate
- Configured status (green check or gray X)
- Expandable content preview (click to see full text)

- [ ] **Step 4: Add Prompt History tab**

Use `useAgentData` composable. Render a list of prompt entries:
- Timestamp (relative + absolute)
- Channel badge
- Work item ID (if present)
- Token count + cost estimate
- Click to expand: full prompt text in monospace scrollable viewer

- [ ] **Step 5: Merge Config + Profile into enhanced Config tab**

Combine the existing Config and Profile tabs. Add:
- Tools grouped by category with MCP mapping preview
- Skills checklist
- Creature wiring editor

- [ ] **Step 6: Build and verify**

```bash
cd /home/ellie/ellie-home && bun run build
```

- [ ] **Step 7: Commit**

```bash
cd /home/ellie/ellie-home && git add app/pages/agents/index.vue && git commit -m "feat: restructure agents page — 5 tabs with context layers + prompt history"
```

---

### Task 7: Agent Creation Wizard

**Files:**
- Create: `/home/ellie/ellie-home/app/pages/agents/create.vue`

- [ ] **Step 1: Create the wizard page**

4-step wizard with progress indicator at top. Each step is a section within the same page (no routing between steps).

**Step 1: Identity** — name, persona_name, role, color (picker with preset colors), description, model (dropdown from `/api/models`)

**Step 2: Creature Type** — 4 cards (squirrel, ant, owl, bee) with description, cognitive style preview, default token budget. Click to select.

**Step 3: Tools & Skills** — grouped checkboxes for tool categories (file ops, search, Google, GitHub, Plane, bash, database, messaging, knowledge, email, visualization, analysis, finance, routing). Each group shows what MCP tools it maps to.

**Step 4: Foundation Assignment** — fetch foundations from Supabase, checkbox for each. Preview shows roster.

**Create button** — calls `POST /api/agents/create` with all wizard state. Shows success/failure per system (Supabase, Forest, Foundation). On success, navigates to `/agents` with the new agent selected.

Validation:
- Step 1: name required, lowercase alphanumeric + hyphens, unique (check on blur)
- Step 2: creature required
- Step 3: at least one tool
- Step 4: at least one foundation

- [ ] **Step 2: Build and verify**

```bash
cd /home/ellie/ellie-home && bun run build
```

- [ ] **Step 3: Commit**

```bash
cd /home/ellie/ellie-home && git add app/pages/agents/create.vue && git commit -m "feat: add agent creation wizard — 4-step identity, creature, tools, foundation"
```

---

### Task 8: End-to-End Validation

- [ ] **Step 1: Restart relay**

```bash
systemctl --user restart claude-telegram-relay
```

- [ ] **Step 2: Rebuild and restart dashboard**

```bash
cd /home/ellie/ellie-home && bun run build && sudo systemctl restart ellie-dashboard
```

- [ ] **Step 3: Test agent detail — Overview tab**

Open `/agents`, select James. Verify Overview tab shows identity, model, status, foundations, capabilities.

- [ ] **Step 4: Test Context Layers tab**

Click Context Layers tab. Verify layers appear in priority order with content previews and token estimates.

- [ ] **Step 5: Test Prompt History tab**

Send a message to Ellie via dashboard (non-coordinator mode) to generate a prompt. Check Prompt History tab — verify entry appears with timestamp, channel, token count. Click to expand full prompt.

- [ ] **Step 6: Test Agent Creation**

Navigate to `/agents/create`. Create a test agent (name: "test-agent", persona: "Tester", creature: ant, tools: read + grep, foundation: software-dev). Verify it appears in the agent list.

- [ ] **Step 7: Clean up test agent**

Delete the test agent from Supabase and foundation:
```bash
source .env && curl -s -X POST "https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query" \
  -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"query": "DELETE FROM agents WHERE name = '\''test-agent'\''"}'
```

---

## Summary

| Task | What It Builds | Repo | Files |
|------|---------------|------|-------|
| 1 | Prompt history schema + API | ellie-dev | migration, agent-prompts.ts, http-routes.ts |
| 2 | Prompt capture in handlers | ellie-dev | ellie-chat-handler.ts, telegram-handlers.ts |
| 3 | Context layers API | ellie-dev | agent-context-layers.ts, http-routes.ts |
| 4 | Agent creation API | ellie-dev | agent-create.ts, http-routes.ts |
| 5 | Dashboard composable + proxy routes | ellie-home | useAgentData.ts, 3 server routes |
| 6 | Agents page restructure (5 tabs) | ellie-home | agents/index.vue |
| 7 | Agent creation wizard | ellie-home | agents/create.vue |
| 8 | End-to-end validation | both | manual testing |

**Total:** 6 new files (relay), 4 new files (dashboard), 3 modified relay files, 1 modified dashboard page, 8 commits.
