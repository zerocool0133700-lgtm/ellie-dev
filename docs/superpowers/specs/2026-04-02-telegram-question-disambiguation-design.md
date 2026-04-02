# Telegram Question Disambiguation — Sub-Spec for ELLIE-1276

**Date:** 2026-04-02
**Status:** Draft
**Parent spec:** docs/superpowers/specs/2026-04-02-gtd-native-agent-coordination-design.md (Phase 2)
**Depends on:** ELLIE-1271 (structured question metadata must be live)

## Problem

When multiple agents ask questions simultaneously, Telegram presents them as a serial message stream. Dave's reply to agent A can get attributed to agent B. The current system has no mechanism to tag questions with IDs in Telegram or to disambiguate which question an answer belongs to.

## Current State

- Questions arrive in Telegram via `deps.sendMessage(channel, question)` — plain text, no ID tagging
- The ask-user queue tracks questions by internal UUID but this ID never appears in Telegram
- Dave replies to whichever message is most recent; the relay routes the answer to whatever question is "current"
- No Telegram `message_id` is stored for question messages

## Solution

### 1. Tag outgoing questions with short IDs

When the coordinator sends a question to Telegram, format it with the agent name and question ID:

```
james asks (q-7f3a):
Should the auth middleware use JWT or session cookies?

What I need: Pick one — this decides the session store implementation.
Unlocks: Session store implementation approach
```

The question ID comes from `metadata.question_id` (already generated in ELLIE-1271).

**Store the Telegram `message_id`** returned by the Telegram API `sendMessage` call. Write it to the GTD item's metadata:

```json
{
  "question_id": "q-7f3a2b1c",
  "telegram_message_id": 12345,
  ...
}
```

### 2. Primary routing: Telegram reply-to-message

If Dave uses Telegram's native reply feature (long-press a message → Reply), the reply contains `reply_to_message.message_id`. The relay matches this against stored `telegram_message_id` values to route unambiguously.

This is the cleanest path — no disambiguation needed.

### 3. Fallback routing: `disambiguateAnswer()`

When Dave sends a plain message (not a reply), the relay runs a disambiguation algorithm:

```typescript
function disambiguateAnswer(
  answerText: string,
  pendingQuestions: PendingQuestion[]
): PendingQuestion | 'ambiguous' {
  // 1. Single pending question → route directly
  if (pendingQuestions.length === 1) return pendingQuestions[0]

  // 2. Agent name prefix: "james: use JWT"
  const agentMatch = pendingQuestions.find(q =>
    answerText.toLowerCase().startsWith(q.agentName.toLowerCase() + ':')
  )
  if (agentMatch) return agentMatch

  // 3. Choice matching: answer exactly matches a choice option
  const choiceMatch = pendingQuestions.find(q =>
    q.choices?.some(c => c.toLowerCase() === answerText.trim().toLowerCase())
  )
  if (choiceMatch) return choiceMatch

  // 4. Explicit question ID: "q-7f3a use JWT"
  const idMatch = answerText.match(/q-([0-9a-f]{4,8})/i)
  if (idMatch) {
    const match = pendingQuestions.find(q =>
      q.questionId.startsWith(`q-${idMatch[1]}`)
    )
    if (match) return match
  }

  // 5. Ambiguous — ask for clarification
  return 'ambiguous'
}
```

### 4. Ambiguous response handling

When disambiguation returns `'ambiguous'`, Ellie sends a clarification message:

```
I have {n} questions waiting. Which one are you answering?

1. james (q-7f3a): Should the auth middleware use JWT or session cookies?
2. kate (q-8b2c): Worth adding a materialized view for 3x speedup?

Reply with the number, or answer on the dashboard: {link}
```

If Dave replies with a number (1, 2, etc.), route to that question. If still ambiguous, redirect to dashboard.

### 5. Answer stripping

When routing via agent name prefix or question ID, strip the routing prefix from the answer before writing:

- `"james: use JWT"` → answer text: `"use JWT"`
- `"q-7f3a use JWT"` → answer text: `"use JWT"`
- `"1"` (numbered reply to clarification) → re-ask for the actual answer, or if the original was a choice question, use the choice matching

## Data Model Changes

**No new columns.** Use existing `metadata` JSONB on todos:

```json
{
  "telegram_message_id": 12345
}
```

Added during question creation in the Telegram send path (not in the GTD creation — added after the Telegram API returns the message_id).

## Files to Modify

| File | Change |
|------|--------|
| `src/relay.ts` | Update ask_user Telegram send path: format message with ID, store returned message_id |
| `src/relay.ts` | Update incoming message handler: check reply_to_message first, then run disambiguateAnswer() |
| `src/ask-user-queue.ts` | Add `getPendingQuestions()` method returning question metadata for disambiguation |
| `tests/telegram-disambiguation.test.ts` | New: unit tests for disambiguateAnswer() function |

## Test Plan

Unit tests for `disambiguateAnswer()`:
- Single question → routes directly
- Agent name prefix → routes to correct agent
- Choice matching → routes to question with matching choice
- Explicit question ID → routes by ID
- No match → returns 'ambiguous'
- Agent prefix stripping → answer text has prefix removed
- Multiple questions, one with matching choice → correct routing

Integration test:
- Two agents ask questions → both appear in Telegram with IDs
- Dave replies to one via Telegram reply → correct routing
- Dave sends plain answer matching a choice → correct routing
- Dave sends ambiguous answer → clarification message sent

## Scope

**In scope:**
- Question ID tagging in Telegram messages
- Store telegram_message_id in GTD metadata
- reply-to-message routing (primary)
- disambiguateAnswer() fallback (agent prefix, choice match, explicit ID, clarification)
- Answer text stripping for prefixed answers

**Not in scope:**
- Embedding similarity matching (Alan suggested this — defer unless choice matching proves insufficient)
- Multi-message answers (Dave sends two messages for one question)
- Rich media answers (photos, voice replies as answers)
