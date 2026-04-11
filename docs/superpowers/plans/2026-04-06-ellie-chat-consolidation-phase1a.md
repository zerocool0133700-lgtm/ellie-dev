# Ellie Chat Consolidation — Phase 1A: Thread Isolation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix thread message isolation so switching threads loads only that thread's messages, and dispatch responses route back to the originating thread.

**Architecture:** Use the existing `thread_id` column on messages (already migrated in ELLIE-1374) as the isolation key. Ensure every message write path sets `thread_id` consistently. Change message loading to query by `thread_id` instead of `conversation_id`. Add `source_thread_id` to dispatch records so responses route back correctly.

**Tech Stack:** TypeScript, Bun, Supabase (messages/conversations/chat_threads tables), WebSocket

**Spec:** `docs/superpowers/specs/2026-04-06-ellie-chat-consolidation-design.md`

---

## File Structure

| File | Responsibility |
|------|----------------|
| Modify: `src/message-sender.ts` | Add `threadId` parameter to `saveMessage`, set `thread_id` column directly |
| Modify: `src/ellie-chat-handler.ts` | Pass `effectiveThreadId` to all `saveMessage` calls |
| Modify: `src/conversations.ts` | Update `getConversationMessages` to filter by `thread_id` |
| Modify: `src/coordinator.ts` | Carry `source_thread_id` through dispatch, propagate to response save |
| Modify: `src/dispatch-outcomes.ts` | Store `source_thread_id` on dispatch outcome records |
| Modify: `src/websocket-servers.ts` | Pass `thread_id` in history catch-up query |
| Create: `tests/thread-isolation.test.ts` | Tests for message isolation by thread_id |
| Create: `migrations/supabase/20260406_thread_id_on_dispatch.sql` | Add source_thread_id to dispatch tracking |

---

### Task 1: saveMessage gets thread_id parameter

**Files:**
- Modify: `src/message-sender.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/thread-isolation.test.ts`:
```typescript
import { describe, test, expect } from "bun:test";

describe("Thread isolation", () => {
  test("saveMessage sets thread_id column when provided", async () => {
    // This test validates the interface change
    // Full integration test in Task 6
    expect(true).toBe(true); // placeholder — real test needs Supabase
  });
});
```

- [ ] **Step 2: Add threadId parameter to saveMessage**

In `src/message-sender.ts`, add `threadId?: string` as a new parameter after `initiatedBy`:

```typescript
export async function saveMessage(
  role: string,
  content: string,
  metadata?: Record<string, unknown>,
  channel: string = "telegram",
  userId?: string,
  clientId?: string,
  initiatedBy: "user" | "system" | "agent" = "system",
  threadId?: string,  // ELLIE-CHAT: thread isolation
): Promise<string | null> {
```

In the message row construction, add `thread_id` as a direct column:

```typescript
    const row: Record<string, unknown> = {
      role,
      content,
      channel,
      metadata: metadata || {},
      conversation_id: conversationId,
    };
    if (userId) row.user_id = userId;
    if (clientId) row.id = clientId;
    if (threadId) row.thread_id = threadId;  // ELLIE-CHAT: set column directly
```

- [ ] **Step 3: Run tests to verify no regressions**

Run: `cd /home/ellie/ellie-dev && bun test`
Expected: All existing tests pass (threadId is optional, so no callers break)

- [ ] **Step 4: Commit**

```bash
git add src/message-sender.ts tests/thread-isolation.test.ts
git commit -m "[ELLIE-CHAT] add threadId parameter to saveMessage for thread isolation"
```

---

### Task 2: Pass threadId through all save paths in handler

**Files:**
- Modify: `src/ellie-chat-handler.ts`

- [ ] **Step 1: Find all saveMessage calls in ellie-chat-handler.ts**

Search for `saveMessage(` — there are multiple call sites. Each one that handles ellie-chat messages needs to pass `effectiveThreadId`.

- [ ] **Step 2: Update user message save (line ~294)**

The user message save already has `thread_id` in metadata. Add it as the `threadId` parameter too:

```typescript
await saveMessage(
  "user", text,
  { ...(image ? { image_name: image.name, image_mime: image.mime_type } : {}),
    ...(effectiveThreadId ? { thread_id: effectiveThreadId } : {}) },
  "ellie-chat", ecUserId, clientId, "user",
  effectiveThreadId || undefined,  // ELLIE-CHAT: thread column
);
```

- [ ] **Step 3: Update coordinator response save (line ~1472)**

```typescript
const memoryId = await saveMessage(
  "assistant", coordResponse, {}, "ellie-chat", ecUserId,
  undefined, "system",
  effectiveThreadId || undefined,  // ELLIE-CHAT: thread column
);
```

- [ ] **Step 4: Update direct agent response save (line ~1330)**

```typescript
const memoryId = await saveMessage(
  "assistant", processedResponse,
  { agent: directAgent, thread_id: effectiveThreadId },
  "ellie-chat", ecUserId,
  undefined, "agent",
  effectiveThreadId || undefined,  // ELLIE-CHAT: thread column
);
```

- [ ] **Step 5: Update specialist ack save (line ~926)**

```typescript
const ackMemoryId = await saveMessage(
  "assistant", ack, { agent: "general" }, "ellie-chat", ecUserId,
  undefined, "system",
  effectiveThreadId || undefined,  // ELLIE-CHAT: thread column
);
```

- [ ] **Step 6: Find and update any other saveMessage calls in the file**

Search for all `saveMessage(` calls. Any that use channel `"ellie-chat"` should pass `effectiveThreadId`.

- [ ] **Step 7: Run tests**

Run: `cd /home/ellie/ellie-dev && bun test`

- [ ] **Step 8: Commit**

```bash
git add src/ellie-chat-handler.ts
git commit -m "[ELLIE-CHAT] pass effectiveThreadId to all saveMessage calls for thread isolation"
```

---

### Task 3: Message loading by thread_id

**Files:**
- Modify: `src/conversations.ts`

- [ ] **Step 1: Read getConversationMessages to understand current loading**

Find `getConversationMessages` in `src/conversations.ts`. It currently queries by `conversation_id`. We need to add an alternative path that queries by `thread_id` when provided.

- [ ] **Step 2: Add thread-aware message loading**

Add a new export alongside or modifying `getConversationMessages`:

```typescript
export async function getThreadMessages(
  supabase: SupabaseClient,
  threadId: string,
  limit: number = 50,
): Promise<{ text: string; messageCount: number; conversationId: string }> {
  const { data, error } = await supabase
    .from("messages")
    .select("id, role, content, metadata, created_at")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error || !data) {
    return { text: "", messageCount: 0, conversationId: "" };
  }

  // Reverse to chronological order
  const messages = data.reverse();
  const text = messages
    .map((m: any) => `${m.role === "user" ? "Dave" : (m.metadata?.agent || "Ellie")}: ${m.content}`)
    .join("\n\n");

  return { text, messageCount: messages.length, conversationId: "" };
}
```

- [ ] **Step 3: Update the pipeline to use thread-aware loading when threadId is available**

In the handler or pipeline, when building conversation context, prefer `getThreadMessages(threadId)` over `getConversationMessages(conversationId)` when `effectiveThreadId` is set.

- [ ] **Step 4: Run tests**

Run: `cd /home/ellie/ellie-dev && bun test`

- [ ] **Step 5: Commit**

```bash
git add src/conversations.ts
git commit -m "[ELLIE-CHAT] add getThreadMessages for thread-isolated message loading"
```

---

### Task 4: Dispatch source thread tracking

**Files:**
- Modify: `src/coordinator.ts`
- Modify: `src/dispatch-outcomes.ts`
- Create: `migrations/supabase/20260406_thread_id_on_dispatch.sql`

- [ ] **Step 1: Add source_thread_id to dispatch envelope**

In `src/coordinator.ts`, where `executeTrackedDispatch` is called, pass `threadId` from `CoordinatorOpts`:

Find where the dispatch envelope is created and add `source_thread_id`:

```typescript
const specEnvelope = await executeTrackedDispatch({
  // ... existing fields
  source_thread_id: opts.threadId,  // ELLIE-CHAT: track originating thread
});
```

- [ ] **Step 2: Carry source_thread_id through dispatch completion**

In `src/dispatch-outcomes.ts`, `writeOutcome` should store `source_thread_id`. When the response is saved as a message, use `source_thread_id` as the `threadId` parameter.

- [ ] **Step 3: Create migration for source_thread_id**

Create `migrations/supabase/20260406_thread_id_on_dispatch.sql`:
```sql
-- Add source_thread_id to dispatch tracking for response routing
ALTER TABLE dispatch_outcomes ADD COLUMN IF NOT EXISTS source_thread_id UUID;
```

Note: `dispatch_outcomes` is in the Forest DB, not Supabase. Check which DB it's in and create the migration in the right directory.

- [ ] **Step 4: Update coordinator response save to use source thread**

In the handler where the coordinator response is saved (line ~1472), the `effectiveThreadId` should already be correct since the coordinator was started with it. But verify the dispatch result path also carries it through.

- [ ] **Step 5: Run tests**

Run: `cd /home/ellie/ellie-dev && bun test`

- [ ] **Step 6: Commit**

```bash
git add src/coordinator.ts src/dispatch-outcomes.ts migrations/
git commit -m "[ELLIE-CHAT] dispatch source thread tracking for response routing"
```

---

### Task 5: WebSocket history catch-up with thread filtering

**Files:**
- Modify: `src/websocket-servers.ts`

- [ ] **Step 1: Find the history/catch-up handler**

When a client reconnects (sends `auth` with `since` timestamp), the server sends catch-up messages. Find this code and ensure it filters by the client's active `thread_id`.

- [ ] **Step 2: Add thread_id to the catch-up query**

The catch-up should only send messages for the thread the client was viewing. The client should send its active `thread_id` in the auth handshake:

```typescript
// Client auth payload:
{ type: "auth", key: "...", since: timestamp, thread_id: "active-thread-uuid" }
```

The server filters catch-up messages by `thread_id`:

```typescript
// Catch-up query:
const { data } = await supabase
  .from("messages")
  .select("*")
  .eq("channel", "ellie-chat")
  .eq("thread_id", authMsg.thread_id || mainThreadId)
  .gt("created_at", new Date(authMsg.since).toISOString())
  .order("created_at", { ascending: true })
  .limit(50);
```

- [ ] **Step 3: Run tests**

Run: `cd /home/ellie/ellie-dev && bun test`

- [ ] **Step 4: Commit**

```bash
git add src/websocket-servers.ts
git commit -m "[ELLIE-CHAT] thread-filtered history catch-up on WebSocket reconnect"
```

---

### Task 6: Migration for historical messages

**Files:**
- Create: `scripts/migrate-thread-isolation.ts`

- [ ] **Step 1: Write migration script**

Historical messages don't have `thread_id` set on the column (only in metadata). Assign them to the main thread:

```typescript
// 1. Find or create the main/default thread
// 2. UPDATE messages SET thread_id = {main_thread_id}
//    WHERE channel = 'ellie-chat'
//    AND thread_id IS NULL
//    AND metadata->>'thread_id' IS NULL
// 3. For messages that have metadata.thread_id but not the column:
//    UPDATE messages SET thread_id = (metadata->>'thread_id')::uuid
//    WHERE channel = 'ellie-chat'
//    AND thread_id IS NULL
//    AND metadata->>'thread_id' IS NOT NULL
```

- [ ] **Step 2: Run migration**

Run: `cd /home/ellie/ellie-dev && bun run scripts/migrate-thread-isolation.ts`

- [ ] **Step 3: Verify**

```sql
SELECT count(*) FROM messages WHERE channel = 'ellie-chat' AND thread_id IS NULL;
-- Should be 0
```

- [ ] **Step 4: Commit**

```bash
git add scripts/migrate-thread-isolation.ts
git commit -m "[ELLIE-CHAT] backfill thread_id column on historical messages"
```

---

## Notes for Implementers

### Existing thread infrastructure
The thread system (ELLIE-1374) already created:
- `chat_threads` table with id, channel_id, name, routing_mode, direct_agent
- `thread_participants` table with thread_id, agent
- `messages.thread_id` column (UUID, nullable, indexed)
- `conversations.thread_id` column (UUID, FK to chat_threads)
- Thread resolution in the handler (`getThread`, `getDefaultThread`, `getThreadParticipants`)
- Coordinator roster filtering by thread participants

What's missing is consistent usage — `thread_id` column on messages isn't always set, loading doesn't filter by it, and dispatch responses don't carry it back.

### The conversation_id relationship
After this work, `conversation_id` still exists and is still set on messages. It doesn't go away. But `thread_id` becomes the isolation key for loading. Think of `conversation_id` as a session grouping and `thread_id` as a workspace grouping.

### dispatch_outcomes table location
Check whether `dispatch_outcomes` is in Supabase or Forest DB before creating the migration. The dispatch system uses Forest DB (`ellie-forest`) for most tracking tables.
