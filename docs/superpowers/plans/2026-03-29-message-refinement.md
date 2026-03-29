# Message Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically refine user text messages via Haiku in the background, storing clean markdown in the messages table and preserving the raw original in a new raw_messages table.

**Architecture:** Fire-and-forget hook in saveMessage() triggers background refinement. Raw preserved first, then Haiku rewrites, then messages table updated. Failure leaves raw in place.

**Tech Stack:** TypeScript/Bun, Supabase, Anthropic SDK (Haiku)

**Spec:** `docs/superpowers/specs/2026-03-29-message-refinement-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `migrations/supabase/20260329_raw_messages.sql` | Create raw_messages table |
| `src/message-refiner.ts` | Haiku refinement + raw storage + messages update |

### Modified Files

| File | Change |
|------|--------|
| `src/message-sender.ts` | Add fire-and-forget hook after insert |

---

## Task 1: Create raw_messages table

**Files:**
- Create: `migrations/supabase/20260329_raw_messages.sql`

- [ ] **Step 1: Write the migration**

```sql
CREATE TABLE IF NOT EXISTS raw_messages (
  id UUID PRIMARY KEY,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Apply via Management API**

```bash
curl -s -X POST "https://api.supabase.com/v1/projects/tzugbqcbuxbzjgnufell/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg q "$(cat migrations/supabase/20260329_raw_messages.sql)" '{query: $q}')"
```

- [ ] **Step 3: Commit**

```bash
git add migrations/supabase/20260329_raw_messages.sql
git commit -m "[ELLIE-1135] Add raw_messages table for message refinement"
```

---

## Task 2: Build message-refiner.ts

**Files:**
- Create: `src/message-refiner.ts`

- [ ] **Step 1: Check how the Anthropic client is accessed**

The relay injects the Anthropic client via dependency injection (same pattern as intent-classifier). Check `src/relay.ts` or `src/relay-state.ts` for the Anthropic instance. The message-refiner needs access to both the Anthropic client and the Supabase client.

- [ ] **Step 2: Create message-refiner.ts**

```typescript
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "./logger.ts";

const logger = log.child("message-refiner");

const REFINE_SYSTEM_PROMPT = `You clean up raw conversational messages into clear, readable markdown.
Rules:
- Keep first-person voice — this should still sound like the speaker
- Fix grammar, spelling, punctuation
- Break run-on sentences into coherent ones
- Add markdown formatting where helpful (bullets, headers for long messages)
- Don't add information, opinions, or change meaning
- Don't add a title or wrap in code blocks
- For short messages (under ~20 words), just fix grammar and return — don't over-format
- Return ONLY the cleaned text, nothing else`;

let _anthropic: Anthropic | null = null;
let _supabase: SupabaseClient | null = null;

export function initMessageRefiner(anthropic: Anthropic, supabase: SupabaseClient): void {
  _anthropic = anthropic;
  _supabase = supabase;
}

async function refineWithHaiku(rawText: string): Promise<string> {
  if (!_anthropic) throw new Error("Anthropic client not initialized");

  const response = await _anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    system: REFINE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: rawText }],
  });

  const block = response.content[0];
  if (block.type !== "text") throw new Error("Unexpected response type");
  return block.text;
}

export async function refineAndStoreMessage(
  messageId: string,
  rawText: string,
  channel: string,
): Promise<void> {
  if (!_supabase || !_anthropic) {
    logger.warn("Refiner not initialized, skipping", { messageId });
    return;
  }

  try {
    // 1. Store raw message
    const { error: rawErr } = await _supabase
      .from("raw_messages")
      .insert({ id: messageId, content: rawText });

    if (rawErr) {
      logger.warn("Failed to store raw message", { messageId, error: rawErr.message });
      return;
    }

    // 2. Refine with Haiku
    const refined = await refineWithHaiku(rawText);

    // 3. Update messages table with refined content
    const { error: updateErr } = await _supabase
      .from("messages")
      .update({ content: refined })
      .eq("id", messageId);

    if (updateErr) {
      logger.warn("Failed to update message with refined content", { messageId, error: updateErr.message });
      return;
    }

    logger.info("Message refined", { messageId, channel, rawLen: rawText.length, refinedLen: refined.length });
  } catch (err) {
    logger.warn("Message refinement failed", { messageId, error: (err as Error).message });
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/message-refiner.ts
git commit -m "[ELLIE-1135] Add message refiner — Haiku background refinement"
```

---

## Task 3: Wire into saveMessage and relay startup

**Files:**
- Modify: `src/message-sender.ts` (~line 86)
- Modify: `src/relay.ts` (startup — init the refiner)

- [ ] **Step 1: Add the hook in message-sender.ts**

After the existing `resilientTask` calls inside the `if (data?.id)` block (around line 96, after the mountain ingestion task), add:

```typescript
// ELLIE-1135: Background message refinement — clean up user text messages
if (role === "user" && !content.startsWith("[")) {
  resilientTask("refineMessage", "best-effort", async () => {
    const { refineAndStoreMessage } = await import("./message-refiner.ts");
    await refineAndStoreMessage(data.id, content, channel);
  });
}
```

Uses dynamic import so the refiner module is only loaded when needed. `resilientTask` with `"best-effort"` ensures failures don't affect anything.

- [ ] **Step 2: Initialize the refiner in relay startup**

Find where `initClassifier(anthropic, supabase)` is called in `src/relay.ts`. Add nearby:

```typescript
import { initMessageRefiner } from "./message-refiner.ts";
// ... after anthropic and supabase are initialized:
initMessageRefiner(anthropic, supabase);
```

- [ ] **Step 3: Commit**

```bash
git add src/message-sender.ts src/relay.ts
git commit -m "[ELLIE-1135] Wire message refinement into saveMessage + relay startup"
```

---

## Summary

| Task | What It Does |
|------|-------------|
| 1 | Create raw_messages table in Supabase |
| 2 | Build message-refiner.ts (Haiku call + raw storage + update) |
| 3 | Wire hook into saveMessage + init at relay startup |
