# Message Refinement — Design Spec

**Date:** 2026-03-29
**Status:** Draft

## Problem

User messages stored in the Supabase `messages` table are raw conversational text — run-on sentences, missing punctuation, stream-of-consciousness. This makes them poor source material for downstream systems (River capture, analytics, context building, conversation history). The existing River "Refine" button proves the concept works, but requires manual per-message effort.

## Solution

Automatically refine every user text message in the background using Haiku. The raw version is preserved in a new `raw_messages` table for drill-down. The `messages` table always ends up with clean, readable markdown.

## Scope

- Only regular text messages from the user (role = "user")
- Skip voice transcriptions, image captions, document descriptions, action approvals/denials (anything starting with `[`)
- Both Telegram and ellie-chat channels
- Background/async — no impact on Ellie's response latency

## Data Model

### New Table: `raw_messages` (Supabase)

```sql
CREATE TABLE raw_messages (
  id UUID PRIMARY KEY,           -- matches messages.id
  content TEXT NOT NULL,          -- original unrefined text
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

No FK constraint — logical reference to `messages.id` in the same database. Lookup: `SELECT content FROM raw_messages WHERE id = $messageId`.

No changes to the existing `messages` table schema.

## Refinement Flow

1. `saveMessage("user", rawText, ...)` inserts the raw text into `messages` and returns the message ID (existing behavior, unchanged)
2. After successful insert, if `role === "user"` and content does not start with `[`, fire-and-forget: `refineAndStoreMessage(messageId, rawText, channel).catch(() => {})`
3. Inside `refineAndStoreMessage()`:
   - Insert raw text into `raw_messages` with the same message ID
   - Call Haiku to refine the text
   - Update `messages` row: `UPDATE messages SET content = $refined WHERE id = $messageId`
4. On failure: log a warning, leave the `messages` table with the raw version. No retry.

### Hook Location

In `saveMessage()` in `src/message-sender.ts`, right after the successful Supabase insert (around line 80-90). The fire-and-forget call is the only change to existing code.

## LLM Refinement

**Model:** `claude-haiku-4-5-20251001`

**System Prompt:**
```
You clean up raw conversational messages into clear, readable markdown.
Rules:
- Keep first-person voice — this should still sound like the speaker
- Fix grammar, spelling, punctuation
- Break run-on sentences into coherent ones
- Add markdown formatting where helpful (bullets, headers for long messages)
- Don't add information, opinions, or change meaning
- Don't add a title or wrap in code blocks
- For short messages (under ~20 words), just fix grammar and return — don't over-format
- Return ONLY the cleaned text, nothing else
```

**User message:** The raw text to refine.

**Estimated cost:** ~$0.001 per message (Haiku pricing, ~100 token system prompt + variable user input).

**Estimated latency:** 1-2 seconds (async, does not block anything).

## New File

`src/message-refiner.ts` — contains:
- `refineAndStoreMessage(messageId: string, rawText: string, channel: string): Promise<void>` — orchestrator: insert raw, call Haiku, update messages
- `refineWithHaiku(rawText: string): Promise<string>` — the LLM call, returns cleaned text

Uses the Anthropic client pattern already established in the relay. Check `src/intent-classifier.ts` for how Haiku calls are made (likely `new Anthropic()` from `@anthropic-ai/sdk` with `ANTHROPIC_API_KEY` from env).

## Failure Handling

- If `raw_messages` insert fails: log warning, skip refinement (raw stays in messages, no raw backup)
- If Haiku call fails: log warning, raw stays in messages table (still readable)
- If messages update fails: log warning (raw is in both tables, which is fine)
- No retries — the raw version is always usable

## What This Does NOT Cover

- Refining assistant messages (only user messages)
- Refining voice/image/document/action messages
- UI changes (no new UI needed)
- Changing how the River button works (it continues to work independently)
- Migration of historical messages (only new messages going forward)
