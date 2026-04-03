# Thread Abstraction Phase 1: Data Layer + Routing + Core Isolation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add thread support to Ellie Chat — tables, CRUD API, thread-scoped working memory and conversations, coordinator roster filtering, direct chat mode, and cross-thread awareness.

**Architecture:** New `chat_threads` and `thread_participants` tables in Supabase. `thread_id` added to conversations, messages, and working memory. The ellie-chat-handler reads thread_id from WebSocket messages and routes either through the coordinator loop (with filtered roster) or directly to an agent (new `runDirectChat` path). Working memory is scoped per-thread with cross-thread awareness signals.

**Tech Stack:** TypeScript (Bun), Supabase (chat_threads), Forest DB (working_memory), WebSocket, Anthropic Messages API

**Spec:** `docs/superpowers/specs/2026-04-03-thread-abstraction-design.md` — Phase 1

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `migrations/supabase/20260403_chat_threads.sql` | Create | chat_threads, thread_participants, thread_read_state tables + thread_id columns |
| `migrations/forest/20260403_working_memory_thread.sql` | Create | Add thread_id to working_memory |
| `src/api/threads.ts` | Create | Thread CRUD API (list, create, get, update participants) |
| `src/thread-context.ts` | Create | Thread lookup, participant filtering, cross-thread awareness |
| `src/direct-chat.ts` | Create | Direct mode chat (no coordinator) |
| `src/working-memory.ts` | Modify | Thread-scoped init/read/update + cross-thread awareness query |
| `src/conversations.ts` | Modify | Pass thread_id to get_or_create_conversation |
| `src/ellie-chat-handler.ts` | Modify | Read thread_id from WS, route based on routing_mode |
| `src/coordinator.ts` | Modify | Accept roster filter for thread participants |
| `src/http-routes.ts` | Modify | Wire thread API endpoints |
| `tests/thread-context.test.ts` | Create | Thread lookup + filtering tests |
| `tests/direct-chat.test.ts` | Create | Direct mode tests |

---

### Task 1: Supabase migration — thread tables

**Files:**
- Create: `migrations/supabase/20260403_chat_threads.sql`

- [ ] **Step 1: Write the migration**

Create `/home/ellie/ellie-dev/migrations/supabase/20260403_chat_threads.sql`:

```sql
-- Thread abstraction layer — ELLIE-1374 Phase 1

-- Thread table
CREATE TABLE IF NOT EXISTS chat_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES chat_channels(id),
  name TEXT NOT NULL,
  routing_mode TEXT NOT NULL DEFAULT 'coordinated',
  direct_agent TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_threads_channel ON chat_threads(channel_id);

-- Thread participants
CREATE TABLE IF NOT EXISTS thread_participants (
  thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (thread_id, agent)
);

-- Unread tracking
CREATE TABLE IF NOT EXISTS thread_read_state (
  thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  last_read_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (thread_id, user_id)
);

-- Add thread_id to existing tables
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS thread_id UUID REFERENCES chat_threads(id);
CREATE INDEX IF NOT EXISTS idx_conversations_thread ON conversations(thread_id) WHERE thread_id IS NOT NULL;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread_id UUID;
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id) WHERE thread_id IS NOT NULL;

-- Seed the default "General" thread for the ellie-chat channel
-- (channel_id looked up dynamically — the ellie-chat channel may or may not have a chat_channels row)
DO $$
DECLARE
  v_channel_id UUID;
  v_thread_id UUID;
BEGIN
  -- Find or create a channel row for ellie-chat
  SELECT id INTO v_channel_id FROM chat_channels WHERE slug = 'general' LIMIT 1;
  IF v_channel_id IS NULL THEN
    INSERT INTO chat_channels (name, slug, context_mode, sort_order)
    VALUES ('General', 'general', 'conversation', 0)
    RETURNING id INTO v_channel_id;
  END IF;

  -- Create default thread
  INSERT INTO chat_threads (channel_id, name, routing_mode, created_by)
  VALUES (v_channel_id, 'General', 'coordinated', 'system')
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_thread_id;

  -- If thread was created, add all agents as participants
  IF v_thread_id IS NOT NULL THEN
    INSERT INTO thread_participants (thread_id, agent) VALUES
      (v_thread_id, 'ellie'),
      (v_thread_id, 'james'),
      (v_thread_id, 'kate'),
      (v_thread_id, 'alan'),
      (v_thread_id, 'brian'),
      (v_thread_id, 'jason'),
      (v_thread_id, 'amy'),
      (v_thread_id, 'marcus')
    ON CONFLICT DO NOTHING;
  END IF;
END $$;
```

- [ ] **Step 2: Apply the migration**

This is a Supabase migration. Apply via the migration runner or SQL editor:
```bash
cd /home/ellie/ellie-dev && bun run migrate --db supabase
```

Or if the runner doesn't handle it, apply manually via the Supabase dashboard SQL editor.

- [ ] **Step 3: Verify**

```bash
# Check tables exist (via Supabase MCP or psql to the Supabase DB)
# Verify the default General thread was created
```

- [ ] **Step 4: Commit**

```bash
git add migrations/supabase/20260403_chat_threads.sql
git commit -m "[THREADS-P1] migration: chat_threads, thread_participants, thread_read_state + thread_id columns"
```

---

### Task 2: Forest DB migration — working_memory thread_id

**Files:**
- Create: `migrations/forest/20260403_working_memory_thread.sql`

- [ ] **Step 1: Write the migration**

Create `/home/ellie/ellie-dev/migrations/forest/20260403_working_memory_thread.sql`:

```sql
-- Add thread_id to working_memory for thread-scoped isolation — ELLIE-1374
ALTER TABLE working_memory ADD COLUMN IF NOT EXISTS thread_id TEXT;
CREATE INDEX IF NOT EXISTS idx_working_memory_thread ON working_memory(thread_id) WHERE thread_id IS NOT NULL;
```

- [ ] **Step 2: Apply**

```bash
psql -U ellie -d ellie-forest -f migrations/forest/20260403_working_memory_thread.sql
```

- [ ] **Step 3: Verify**

```bash
psql -U ellie -d ellie-forest -c "\d working_memory" | grep thread_id
```

Expected: `thread_id | text |`

- [ ] **Step 4: Commit**

```bash
git add migrations/forest/20260403_working_memory_thread.sql
git commit -m "[THREADS-P1] migration: add thread_id to working_memory"
```

---

### Task 3: Thread context module — lookup, participants, cross-thread awareness

**Files:**
- Create: `src/thread-context.ts`
- Create: `tests/thread-context.test.ts`

- [ ] **Step 1: Write the test file**

Create `/home/ellie/ellie-dev/tests/thread-context.test.ts`:

```typescript
/**
 * Thread context — lookup, participants, cross-thread awareness
 * ELLIE-1374
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: mock(), warn: mock(), error: mock(), debug: mock() }) },
}));

const mockSupabase = {
  from: mock(() => mockSupabase),
  select: mock(() => mockSupabase),
  eq: mock(() => mockSupabase),
  single: mock(() => Promise.resolve({ data: null, error: null })),
  order: mock(() => Promise.resolve({ data: [], error: null })),
};

import {
  getThread,
  getThreadParticipants,
  filterRosterByThread,
  buildCrossThreadAwareness,
  type ChatThread,
} from "../src/thread-context.ts";

describe("thread-context", () => {
  test("filterRosterByThread filters to thread participants only", () => {
    const fullRoster = ["james", "kate", "alan", "brian", "jason", "amy", "marcus", "ellie"];
    const threadAgents = ["james", "brian", "ellie"];
    const filtered = filterRosterByThread(fullRoster, threadAgents);
    expect(filtered).toEqual(["james", "brian", "ellie"]);
  });

  test("filterRosterByThread returns full roster if no thread filter", () => {
    const fullRoster = ["james", "kate"];
    const filtered = filterRosterByThread(fullRoster, null);
    expect(filtered).toEqual(["james", "kate"]);
  });

  test("buildCrossThreadAwareness returns null for empty sibling records", () => {
    const result = buildCrossThreadAwareness("james", "thread-1", []);
    expect(result).toBeNull();
  });

  test("buildCrossThreadAwareness builds awareness string from sibling records", () => {
    const siblings = [
      { thread_id: "thread-2", thread_name: "ELLIE-500 work", context_anchors: "Working on v2 API endpoint, file: src/api/v2.ts" },
    ];
    const result = buildCrossThreadAwareness("james", "thread-1", siblings);
    expect(result).not.toBeNull();
    expect(result).toContain("ELLIE-500 work");
    expect(result).toContain("v2 API endpoint");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/ellie/ellie-dev && bun test tests/thread-context.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement thread-context.ts**

Create `/home/ellie/ellie-dev/src/thread-context.ts`:

```typescript
/**
 * Thread Context — ELLIE-1374
 *
 * Thread lookup, participant filtering, and cross-thread awareness.
 * Used by the ellie-chat-handler to resolve thread config and by
 * the coordinator to filter the agent roster.
 */

import { log } from "./logger.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

const logger = log.child("thread-context");

// ── Types ──────────────────────────────────────────────────

export interface ChatThread {
  id: string;
  channel_id: string;
  name: string;
  routing_mode: "coordinated" | "direct";
  direct_agent: string | null;
  created_by: string | null;
  created_at: string;
}

// ── Lookup ─────────────────────────────────────────────────

/** Get a thread by ID. Returns null if not found. */
export async function getThread(supabase: SupabaseClient, threadId: string): Promise<ChatThread | null> {
  const { data, error } = await supabase
    .from("chat_threads")
    .select("*")
    .eq("id", threadId)
    .single();

  if (error || !data) return null;
  return data as ChatThread;
}

/** Get the default "General" thread for ellie-chat. */
export async function getDefaultThread(supabase: SupabaseClient): Promise<ChatThread | null> {
  const { data, error } = await supabase
    .from("chat_threads")
    .select("*")
    .eq("name", "General")
    .eq("routing_mode", "coordinated")
    .order("created_at", { ascending: true })
    .limit(1)
    .single();

  if (error || !data) return null;
  return data as ChatThread;
}

/** Get participant agent names for a thread. */
export async function getThreadParticipants(supabase: SupabaseClient, threadId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("thread_participants")
    .select("agent")
    .eq("thread_id", threadId);

  if (error || !data) return [];
  return data.map((r: { agent: string }) => r.agent);
}

// ── Roster Filtering ───────────────────────────────────────

/**
 * Filter the full agent roster to only include thread participants.
 * If threadAgents is null, returns the full roster (no filtering).
 */
export function filterRosterByThread(fullRoster: string[], threadAgents: string[] | null): string[] {
  if (!threadAgents) return fullRoster;
  const threadSet = new Set(threadAgents);
  return fullRoster.filter(a => threadSet.has(a));
}

// ── Cross-Thread Awareness ─────────────────────────────────

export interface SiblingThreadRecord {
  thread_id: string;
  thread_name: string;
  context_anchors: string | null;
}

/**
 * Build a cross-thread awareness signal for an agent.
 * Injects sibling thread context_anchors so the agent knows
 * it's active elsewhere and doesn't contradict itself.
 *
 * Returns null if no sibling threads have relevant context.
 */
export function buildCrossThreadAwareness(
  agent: string,
  currentThreadId: string,
  siblingRecords: SiblingThreadRecord[],
): string | null {
  const relevant = siblingRecords.filter(
    r => r.thread_id !== currentThreadId && r.context_anchors
  );

  if (relevant.length === 0) return null;

  const lines = relevant.map(r =>
    `- Thread "${r.thread_name}": ${r.context_anchors!.slice(0, 300)}`
  );

  return `## Cross-Thread Awareness
You are also active in other threads. Be consistent with your work there:
${lines.join("\n")}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /home/ellie/ellie-dev && bun test tests/thread-context.test.ts
```

Expected: 4 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/thread-context.ts tests/thread-context.test.ts
git commit -m "[THREADS-P1] feat: thread context module — lookup, roster filtering, cross-thread awareness (ELLIE-1374)"
```

---

### Task 4: Thread CRUD API

**Files:**
- Create: `src/api/threads.ts`
- Modify: `src/http-routes.ts`

- [ ] **Step 1: Create threads API module**

Create `/home/ellie/ellie-dev/src/api/threads.ts`:

```typescript
/**
 * Thread API — ELLIE-1374
 *
 * CRUD operations for chat threads.
 * GET    /api/threads           — list threads
 * POST   /api/threads           — create thread
 * GET    /api/threads/:id       — get thread with participants
 * PATCH  /api/threads/:id       — update thread
 * POST   /api/threads/:id/participants — add participant
 * DELETE /api/threads/:id/participants/:agent — remove participant
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "../logger.ts";
import { broadcastToEllieChatClients } from "../relay-state.ts";

const logger = log.child("threads-api");

export async function listThreads(supabase: SupabaseClient): Promise<{
  threads: Array<{ id: string; name: string; routing_mode: string; direct_agent: string | null; created_at: string; agent_count: number }>;
}> {
  const { data: threads, error } = await supabase
    .from("chat_threads")
    .select("id, name, routing_mode, direct_agent, created_at")
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);

  // Get participant counts
  const result = [];
  for (const t of threads || []) {
    const { count } = await supabase
      .from("thread_participants")
      .select("*", { count: "exact", head: true })
      .eq("thread_id", t.id);
    result.push({ ...t, agent_count: count || 0 });
  }

  return { threads: result };
}

export async function createThread(supabase: SupabaseClient, opts: {
  name: string;
  channel_id: string;
  routing_mode: "coordinated" | "direct";
  direct_agent?: string;
  agents: string[];
  created_by?: string;
}): Promise<{ thread: { id: string; name: string } }> {
  const { data, error } = await supabase
    .from("chat_threads")
    .insert({
      name: opts.name,
      channel_id: opts.channel_id,
      routing_mode: opts.routing_mode,
      direct_agent: opts.direct_agent || null,
      created_by: opts.created_by || null,
    })
    .select("id, name")
    .single();

  if (error) throw new Error(error.message);

  // Add participants
  if (opts.agents.length > 0) {
    const rows = opts.agents.map(agent => ({ thread_id: data.id, agent }));
    await supabase.from("thread_participants").insert(rows);
  }

  // Broadcast to WebSocket clients
  try {
    broadcastToEllieChatClients({
      type: "thread_created",
      thread: { id: data.id, name: data.name, routing_mode: opts.routing_mode, agents: opts.agents },
    });
  } catch { /* best-effort */ }

  logger.info("Thread created", { id: data.id, name: opts.name, agents: opts.agents });
  return { thread: data };
}

export async function getThreadWithParticipants(supabase: SupabaseClient, threadId: string): Promise<{
  thread: any;
  participants: string[];
} | null> {
  const { data: thread, error } = await supabase
    .from("chat_threads")
    .select("*")
    .eq("id", threadId)
    .single();

  if (error || !thread) return null;

  const { data: parts } = await supabase
    .from("thread_participants")
    .select("agent")
    .eq("thread_id", threadId);

  return {
    thread,
    participants: (parts || []).map((p: { agent: string }) => p.agent),
  };
}

export async function addParticipant(supabase: SupabaseClient, threadId: string, agent: string): Promise<void> {
  await supabase.from("thread_participants").upsert({ thread_id: threadId, agent });
}

export async function removeParticipant(supabase: SupabaseClient, threadId: string, agent: string): Promise<void> {
  await supabase.from("thread_participants").delete().eq("thread_id", threadId).eq("agent", agent);
}
```

- [ ] **Step 2: Wire thread API into http-routes.ts**

In `/home/ellie/ellie-dev/src/http-routes.ts`, find the channel API routes (search for `/api/channels`). Near that section, add thread routes:

```typescript
  // ── Thread API — ELLIE-1374 ──

  // GET /api/threads
  if (url.pathname === "/api/threads" && req.method === "GET") {
    (async () => {
      try {
        const { listThreads } = await import("./api/threads.ts");
        const { getRelayDeps } = await import("./relay-deps.ts");
        const { supabase } = getRelayDeps();
        const result = await listThreads(supabase!);
        res.writeHead(200, { "Content-Type": "application/json", ...corsHeader(req.headers.origin) });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    })();
    return;
  }

  // POST /api/threads
  if (url.pathname === "/api/threads" && req.method === "POST") {
    (async () => {
      try {
        const body = await readBody(req);
        const { createThread } = await import("./api/threads.ts");
        const { getRelayDeps } = await import("./relay-deps.ts");
        const { supabase } = getRelayDeps();
        const result = await createThread(supabase!, body);
        res.writeHead(201, { "Content-Type": "application/json", ...corsHeader(req.headers.origin) });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    })();
    return;
  }

  // GET /api/threads/:id
  const threadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)$/);
  if (threadMatch && req.method === "GET") {
    (async () => {
      try {
        const { getThreadWithParticipants } = await import("./api/threads.ts");
        const { getRelayDeps } = await import("./relay-deps.ts");
        const { supabase } = getRelayDeps();
        const result = await getThreadWithParticipants(supabase!, threadMatch[1]);
        if (!result) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Thread not found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json", ...corsHeader(req.headers.origin) });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    })();
    return;
  }
```

Follow the exact patterns used by the existing channel routes for `readBody`, `corsHeader`, and async IIFE structure.

- [ ] **Step 3: Commit**

```bash
git add src/api/threads.ts src/http-routes.ts
git commit -m "[THREADS-P1] feat: thread CRUD API — list, create, get, participants (ELLIE-1374)"
```

---

### Task 5: Thread-scoped working memory

**Files:**
- Modify: `src/working-memory.ts`

- [ ] **Step 1: Add thread_id to initWorkingMemory**

In `/home/ellie/ellie-dev/src/working-memory.ts`, find `initWorkingMemory` (line ~74). Add `thread_id?: string` to the opts interface:

```typescript
export async function initWorkingMemory(opts: {
  session_id: string;
  agent: string;
  sections?: WorkingMemorySections;
  channel?: string;
  thread_id?: string;  // ELLIE-1374
}): Promise<WorkingMemoryRecord> {
```

In the INSERT query inside this function, add `thread_id`:

Find the INSERT statement and add `${opts.thread_id ?? null}` as the thread_id value. The column list and VALUES need to include `thread_id`.

- [ ] **Step 2: Add thread_id to readWorkingMemory**

Find `readWorkingMemory` function. Add `thread_id?: string` to its opts. When `thread_id` is provided, add it to the WHERE clause:

```typescript
export async function readWorkingMemory(opts: {
  session_id?: string;
  agent: string;
  thread_id?: string;  // ELLIE-1374
}): Promise<WorkingMemoryRecord | null> {
```

Add to the query: `AND (${opts.thread_id ? sql`thread_id = ${opts.thread_id}` : sql`thread_id IS NULL`})`

- [ ] **Step 3: Add cross-thread sibling query**

Add a new function to query sibling thread working memories for an agent:

```typescript
/**
 * Get working memory context_anchors from other threads for cross-thread awareness.
 * Returns records for all active threads where this agent has working memory,
 * excluding the current thread.
 */
export async function getSiblingThreadMemories(
  agent: string,
  currentThreadId: string,
): Promise<Array<{ thread_id: string; context_anchors: string | null }>> {
  const rows = await sql`
    SELECT wm.thread_id, wm.sections->'context_anchors' as context_anchors
    FROM working_memory wm
    WHERE wm.agent = ${agent}
      AND wm.thread_id IS NOT NULL
      AND wm.thread_id != ${currentThreadId}
      AND wm.archived_at IS NULL
  `;
  return rows as unknown as Array<{ thread_id: string; context_anchors: string | null }>;
}
```

- [ ] **Step 4: Run existing working memory tests**

```bash
cd /home/ellie/ellie-dev && bun test tests/working-memory*.test.ts
```

Expected: All existing tests pass (new params are optional).

- [ ] **Step 5: Commit**

```bash
git add src/working-memory.ts
git commit -m "[THREADS-P1] feat: thread-scoped working memory + cross-thread sibling query (ELLIE-1374)"
```

---

### Task 6: Thread-scoped conversations

**Files:**
- Modify: `src/conversations.ts`

- [ ] **Step 1: Add thread_id to getOrCreateConversation**

In `/home/ellie/ellie-dev/src/conversations.ts`, find `getOrCreateConversation` (line ~47). Add `threadId?: string` parameter:

```typescript
export async function getOrCreateConversation(
  supabase: SupabaseClient,
  channel: string,
  agent: string = "general",
  channelId?: string,
  userId?: string,
  initiatedBy: "user" | "system" | "agent" = "system",
  threadId?: string,  // ELLIE-1374
): Promise<string | null> {
```

Pass `threadId` to the RPC call. The Supabase RPC `get_or_create_conversation` needs a new parameter `p_thread_id`. For now, since the RPC is complex to modify, use a simpler approach: after the RPC returns a conversation_id, update it with the thread_id:

```typescript
    // ELLIE-1374: Tag conversation with thread_id
    if (threadId && conversationId) {
      await supabase
        .from("conversations")
        .update({ thread_id: threadId })
        .eq("id", conversationId)
        .is("thread_id", null);
    }
```

- [ ] **Step 2: Commit**

```bash
git add src/conversations.ts
git commit -m "[THREADS-P1] feat: thread-scoped conversations (ELLIE-1374)"
```

---

### Task 7: Direct chat mode

**Files:**
- Create: `src/direct-chat.ts`
- Create: `tests/direct-chat.test.ts`

- [ ] **Step 1: Write the test file**

Create `/home/ellie/ellie-dev/tests/direct-chat.test.ts`:

```typescript
/**
 * Direct chat mode — bypasses coordinator, talks to agent directly
 * ELLIE-1374
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: mock(), warn: mock(), error: mock(), debug: mock() }) },
}));

mock.module("../src/prompt-builder.ts", () => ({
  getCachedRiverDoc: mock(() => "# Ellie Soul\nPatient teacher..."),
}));

import { buildDirectPrompt } from "../src/direct-chat.ts";

describe("direct-chat", () => {
  test("buildDirectPrompt includes soul for ellie", () => {
    const prompt = buildDirectPrompt({
      agent: "ellie",
      message: "hey, how's it going?",
      conversationHistory: "User: hello\nEllie: hi there!",
    });
    expect(prompt).toContain("Ellie Soul");
    expect(prompt).toContain("hey, how's it going?");
  });

  test("buildDirectPrompt includes conversation history", () => {
    const prompt = buildDirectPrompt({
      agent: "james",
      message: "check the tests",
      conversationHistory: "User: look at the API\nJames: on it",
    });
    expect(prompt).toContain("look at the API");
    expect(prompt).toContain("check the tests");
  });

  test("buildDirectPrompt includes working memory when provided", () => {
    const prompt = buildDirectPrompt({
      agent: "james",
      message: "what about the auth?",
      workingMemorySummary: "Working on v2 API, decided to use Express router",
    });
    expect(prompt).toContain("v2 API");
    expect(prompt).toContain("Express router");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/ellie/ellie-dev && bun test tests/direct-chat.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement direct-chat.ts**

Create `/home/ellie/ellie-dev/src/direct-chat.ts`:

```typescript
/**
 * Direct Chat — ELLIE-1374
 *
 * Bypasses the coordinator loop for "direct" routing mode threads.
 * Builds a prompt with: soul + working memory + conversation history + Forest context.
 * No coordinator framing, no dispatch tools, no roster.
 *
 * Uses the Anthropic Messages API directly for conversational state.
 */

import Anthropic from "@anthropic-ai/sdk";
import { log } from "./logger.ts";
import { getCachedRiverDoc } from "./prompt-builder.ts";

const logger = log.child("direct-chat");

// ── Prompt Assembly ────────────────────────────────────────

export interface DirectPromptOpts {
  agent: string;
  message: string;
  conversationHistory?: string;
  workingMemorySummary?: string;
  forestContext?: string;
  crossThreadAwareness?: string;
}

/**
 * Build a direct chat prompt — soul + context layers, no coordinator framing.
 */
export function buildDirectPrompt(opts: DirectPromptOpts): string {
  const sections: string[] = [];

  // 1. Soul (for Ellie and all agents — the soul defines the core personality)
  const soul = getCachedRiverDoc("soul");
  if (soul) {
    sections.push(`# Soul\n${soul}`);
  }

  // 2. Agent identity
  sections.push(`You are ${opts.agent}. You are in a direct conversation with Dave — no coordinator, no dispatch. Just you and Dave talking.`);

  // 3. Working memory
  if (opts.workingMemorySummary) {
    sections.push(`## Working Memory\n${opts.workingMemorySummary}`);
  }

  // 4. Cross-thread awareness
  if (opts.crossThreadAwareness) {
    sections.push(opts.crossThreadAwareness);
  }

  // 5. Forest context
  if (opts.forestContext) {
    sections.push(`## Relevant Context\n${opts.forestContext}`);
  }

  // 6. Conversation history
  if (opts.conversationHistory) {
    sections.push(`## Recent Conversation\n${opts.conversationHistory}`);
  }

  // 7. Current message
  sections.push(`\nDave: ${opts.message}`);

  return sections.join("\n\n---\n\n");
}

// ── Direct Chat Execution ──────────────────────────────────

export interface DirectChatResult {
  response: string;
  tokens_in: number;
  tokens_out: number;
  duration_ms: number;
}

/**
 * Run a direct chat turn — call the Messages API with the assembled prompt.
 */
export async function runDirectChat(
  prompt: string,
  model: string = "claude-sonnet-4-6",
): Promise<DirectChatResult> {
  const client = new Anthropic();
  const start = Date.now();

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter(b => b.type === "text")
    .map(b => (b as { type: "text"; text: string }).text)
    .join("");

  return {
    response: text,
    tokens_in: response.usage.input_tokens,
    tokens_out: response.usage.output_tokens,
    duration_ms: Date.now() - start,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /home/ellie/ellie-dev && bun test tests/direct-chat.test.ts
```

Expected: 3 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/direct-chat.ts tests/direct-chat.test.ts
git commit -m "[THREADS-P1] feat: direct chat mode — prompt assembly + Messages API execution (ELLIE-1374)"
```

---

### Task 8: Wire threading into ellie-chat-handler

**Files:**
- Modify: `src/ellie-chat-handler.ts`

This is the main integration task — reading thread_id from WebSocket messages and routing based on thread config.

- [ ] **Step 1: Add imports**

At the top of `/home/ellie/ellie-dev/src/ellie-chat-handler.ts`, add:

```typescript
import { getThread, getDefaultThread, getThreadParticipants, filterRosterByThread, buildCrossThreadAwareness } from "./thread-context.ts";
import { buildDirectPrompt, runDirectChat } from "./direct-chat.ts";
import { getSiblingThreadMemories } from "./working-memory.ts";
```

- [ ] **Step 2: Extract thread_id from incoming WebSocket messages**

Find where the incoming message text is parsed in `_handleEllieChatMessage` (around line 900-920). After the text is extracted, add thread_id extraction:

```typescript
    // ELLIE-1374: Extract thread_id from message
    const threadId = typeof parsedMsg === "object" ? parsedMsg.thread_id : undefined;
```

Where `parsedMsg` is the parsed JSON from the WebSocket message. Read the code to find the exact variable name used for the parsed message object.

- [ ] **Step 3: Resolve thread config**

After thread_id extraction, resolve the thread:

```typescript
    // ELLIE-1374: Resolve thread
    let thread: Awaited<ReturnType<typeof getThread>> = null;
    let threadAgents: string[] | null = null;
    if (threadId && supabase) {
      thread = await getThread(supabase, threadId);
      if (thread) {
        threadAgents = await getThreadParticipants(supabase, threadId);
      }
    }
    if (!thread && supabase) {
      thread = await getDefaultThread(supabase);
      if (thread) {
        threadAgents = await getThreadParticipants(supabase, thread.id);
      }
    }
    const effectiveThreadId = thread?.id || null;
```

- [ ] **Step 4: Add direct mode routing**

Find the `COORDINATOR_MODE === "true"` check (around line 1162). BEFORE that check, add the direct mode path:

```typescript
    // ELLIE-1374: Direct mode — bypass coordinator entirely
    if (thread?.routing_mode === "direct" && thread.direct_agent) {
      const directAgent = thread.direct_agent;
      logger.info("[direct-chat] Direct mode", { agent: directAgent, threadId: effectiveThreadId });

      // Build prompt with soul + working memory + conversation history
      const { readWorkingMemory } = await import("./working-memory.ts");
      const wm = await readWorkingMemory({ agent: directAgent, thread_id: effectiveThreadId || undefined });
      const wmSummary = wm ? Object.entries(wm.sections).filter(([, v]) => v).map(([k, v]) => `## ${k}\n${v}`).join("\n\n") : undefined;

      // Cross-thread awareness
      let crossThreadCtx: string | undefined;
      if (effectiveThreadId) {
        const siblings = await getSiblingThreadMemories(directAgent, effectiveThreadId);
        if (siblings.length > 0) {
          // Need thread names — fetch from Supabase
          const enriched = [];
          for (const s of siblings) {
            const t = supabase ? await getThread(supabase, s.thread_id) : null;
            enriched.push({ thread_id: s.thread_id, thread_name: t?.name || "Unknown", context_anchors: s.context_anchors as string });
          }
          crossThreadCtx = buildCrossThreadAwareness(directAgent, effectiveThreadId, enriched) || undefined;
        }
      }

      const prompt = buildDirectPrompt({
        agent: directAgent,
        message: text,
        workingMemorySummary: wmSummary,
        crossThreadAwareness: crossThreadCtx,
      });

      try {
        const result = await runDirectChat(prompt);
        // Save response message
        const memoryId = await saveMessage("assistant", result.response, {}, "ellie-chat", ecUserId);
        deliverResponse(ws, {
          type: "response",
          text: result.response,
          agent: directAgent,
          thread_id: effectiveThreadId,
          memoryId: memoryId || undefined,
          ts: Date.now(),
          duration_ms: result.duration_ms,
        }, ecUserId);
      } catch (err) {
        logger.error("[direct-chat] Error", { error: String(err) });
        deliverResponse(ws, {
          type: "response",
          text: "Something went wrong in direct chat. Please try again.",
          agent: directAgent,
          thread_id: effectiveThreadId,
          ts: Date.now(),
        }, ecUserId);
      }
      return;
    }
```

- [ ] **Step 5: Pass thread context to coordinator loop**

In the coordinator mode section (line ~1162+), where `runCoordinatorLoop` is called, pass the thread's filtered roster. Find the `agentRoster` parameter and filter it:

```typescript
            agentRoster: threadAgents
              ? filterRosterByThread(foundationRegistry?.getAgentRoster() || ["james", "brian", "kate", "alan", "jason", "amy", "marcus", "ellie"], threadAgents)
              : foundationRegistry?.getAgentRoster() || ["james", "brian", "kate", "alan", "jason", "amy", "marcus", "ellie"],
```

- [ ] **Step 6: Add thread_id to response messages**

Find where responses are sent back via WebSocket (the `deliverResponse` calls in the coordinator section). Add `thread_id: effectiveThreadId` to the response payload.

- [ ] **Step 7: Pass thread_id to conversation creation**

Find the `getOrCreateConversation` calls (lines ~330, ~918, ~1627). Add the `effectiveThreadId` as the `threadId` parameter:

```typescript
    const convId = await getOrCreateConversation(supabase, "ellie-chat", "general", channelId, undefined, "user", effectiveThreadId || undefined);
```

- [ ] **Step 8: Commit**

```bash
git add src/ellie-chat-handler.ts
git commit -m "[THREADS-P1] feat: wire threading into ellie-chat-handler — routing + direct mode + roster filtering (ELLIE-1374)"
```

---

### Task 9: Thread-aware coordinator roster filtering

**Files:**
- Modify: `src/coordinator.ts`

- [ ] **Step 1: Read the coordinator**

The coordinator already receives `agentRoster` as a parameter. Task 8 filters it before passing. But the coordinator prompt also builds a roster from the registry. We need to ensure the prompt uses the filtered roster, not the full one.

Check that `effectiveRoster` (line ~165) uses `opts.agentRoster` when provided — it already does via the fallback chain. The registry's `getAgentRoster()` is only used when `opts.registry` is available, and `opts.agentRoster` takes precedence when the registry is null.

Actually, looking at line 165:
```typescript
const effectiveRoster = opts.registry?.getAgentRoster() ?? agentRoster;
```

This means the registry roster overrides the passed roster. For thread filtering to work, we need the passed roster to win. Change to:

```typescript
  // ELLIE-1374: Thread-filtered roster takes precedence over registry roster
  const effectiveRoster = agentRoster.length > 0 ? agentRoster : (opts.registry?.getAgentRoster() ?? []);
```

Wait — `agentRoster` always has values (it's a required parameter with a default). The issue is that the registry prompt (`getCoordinatorPrompt()`) builds its own roster independently. The fix is simpler: pass the filtered roster to the prompt builder.

Actually, `getCoordinatorPrompt()` reads agents from the foundation's agents array directly. To filter it, we'd need to modify the prompt method. A simpler approach: append a roster override to the system prompt.

In `runCoordinatorLoop()`, after `fullSystemPrompt` is built (line ~177), add:

```typescript
  // ELLIE-1374: If a filtered roster was passed (thread context), append a roster override
  if (opts.rosterFilter && opts.rosterFilter.length > 0) {
    const rosterOverride = `\n\n## THREAD ROSTER OVERRIDE\nThis conversation is in a thread. You can ONLY dispatch to these agents: ${opts.rosterFilter.join(", ")}. Do not dispatch to any agent not in this list.`;
    fullSystemPrompt += rosterOverride;
  }
```

Add `rosterFilter?: string[]` to `CoordinatorOpts`.

- [ ] **Step 2: Add rosterFilter to CoordinatorOpts**

In the `CoordinatorOpts` interface (around line 61), add:

```typescript
  rosterFilter?: string[];  // ELLIE-1374: Thread participant filter
```

- [ ] **Step 3: Pass rosterFilter from ellie-chat-handler**

In Task 8's coordinator loop call, add:

```typescript
            rosterFilter: threadAgents || undefined,
```

(This should be added to the `runCoordinatorLoop({...})` call in the ellie-chat-handler.)

- [ ] **Step 4: Run coordinator tests**

```bash
cd /home/ellie/ellie-dev && bun test tests/coordinator.test.ts
```

Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/coordinator.ts src/ellie-chat-handler.ts
git commit -m "[THREADS-P1] feat: thread-aware coordinator roster filtering (ELLIE-1374)"
```

---

### Task 10: Run tests, restart, verify

- [ ] **Step 1: Run all new tests**

```bash
cd /home/ellie/ellie-dev && bun test tests/thread-context.test.ts tests/direct-chat.test.ts
```

Expected: 7 pass, 0 fail.

- [ ] **Step 2: Run coordinator and existing tests**

```bash
bun test tests/coordinator.test.ts
```

Expected: All pass.

- [ ] **Step 3: Restart relay**

```bash
systemctl --user restart ellie-chat-relay
```

- [ ] **Step 4: Verify health**

```bash
curl -s http://localhost:3001/health | python3 -c "import sys,json; d=json.load(sys.stdin); print('Status:', d['status'])"
```

- [ ] **Step 5: Verify thread API**

```bash
curl -s http://localhost:3001/api/threads | python3 -c "import sys,json; d=json.load(sys.stdin); print('Threads:', len(d.get('threads',[])))"
```

Expected: At least 1 thread (the default "General").

- [ ] **Step 6: Push**

```bash
git push
```

- [ ] **Step 7: Commit the plan**

```bash
git add docs/superpowers/plans/2026-04-03-thread-abstraction-phase1.md
git commit -m "[THREADS-P1] complete: Phase 1 thread abstraction — data layer + routing + isolation"
```
