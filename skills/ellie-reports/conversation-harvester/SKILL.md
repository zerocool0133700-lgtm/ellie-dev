---
name: conversation-harvester
description: Extract seeds (new knowledge) and rain (enrichment) from a conversation and present them for review before writing to the Forest
triggers:
  - "harvest this conversation"
  - "what seeds are in this conversation"
  - "feed the forest"
  - "conversation harvest"
requirements:
  - mcp: mcp__forest-bridge__*
---

# Conversation Harvester

Read a conversation transcript, compare it against what the Forest already knows, extract seeds (new knowledge) and rain (enrichment to existing knowledge), and present them for review.

## Purpose

The Forest only grows when agents explicitly write back. Most conversations end without capturing anything. This skill closes that gap — it scans a conversation for Forest-worthy knowledge and presents a batch for approval.

**Seeds** — brand new knowledge the Forest doesn't have yet.
**Rain** — enrichment, updates, or deeper context for things already growing in the Forest.
**Compost** — session-specific noise that looks like knowledge but isn't. Discard silently.

## Workflow

### Step 1: Get the Conversation Transcript

If the user specifies a conversation (by ID or description), fetch that one. Otherwise, use the **current conversation**.

Fetch messages from Supabase:
```sql
SELECT role, content, created_at
FROM messages
WHERE conversation_id = '<id>'
ORDER BY created_at ASC
```

Also fetch the conversation metadata:
```sql
SELECT channel, agent, summary, started_at, last_message_at
FROM conversations
WHERE id = '<id>'
```

If using the current conversation, pull messages from the active session context instead.

### Step 2: Extract Knowledge Candidates

Read through the transcript and identify:

**Seeds** (new knowledge):
- Decisions made with reasoning ("We chose X because Y")
- Findings about the codebase, tools, or architecture
- New facts about the system ("The relay listens on port 3001")
- Hypotheses formed ("I think the bottleneck is in the embedding pipeline")
- New patterns or conventions established
- New integrations, features, or capabilities added

**Rain** (enrichment):
- Updates to existing decisions ("We revisited X and now prefer Y")
- Deeper context for known facts
- New evidence supporting or refuting existing hypotheses
- Additional details about known entities or systems

**Corrections** (user corrected the AI — ELLIE-250):
- The user explicitly told the agent it was wrong and provided the correct information
- Examples: "No, that's wrong — it's actually X", "I said X not Y", "You're mistaken, the meeting is with Z"
- These are the highest-value captures — ground truth directly from the user
- Always type `fact`, always confidence `1.0`
- Tag with `correction:ground_truth` and `source:user_correction`

**Compost** (discard):
- Greetings, small talk, status checks
- Debugging back-and-forth that led nowhere
- Session logistics ("let me restart the service")
- Repeated information already well-established
- Temporary state ("I'm looking at line 42 right now")

For each candidate, determine:
- `content`: A concise, standalone description (future agents won't have this conversation's context)
- `type`: decision | finding | fact | hypothesis
- `scope_path`: Which project/area it belongs to (2/1=ellie-dev, 2/2=ellie-forest, etc.)
- `confidence`: 0.0-1.0 (how certain is this knowledge?)
- `tags`: Relevant topic tags
- `category`: seed, rain, or correction

### Step 3: Query the Forest

For each candidate, search the Forest to check if it already exists:

```bash
curl -s -X POST http://localhost:3001/api/bridge/read \
  -H "Content-Type: application/json" \
  -H "x-bridge-key: bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a" \
  -d '{"query": "<candidate content>", "scope_path": "<scope>"}'
```

Or use `mcp__forest-bridge__forest_read`.

**If a strong match exists** (similarity > 0.8): Reclassify as rain — propose an enrichment update.
**If a weak match exists** (similarity 0.5-0.8): Flag as "possibly related" — let the user decide.
**If no match**: Confirm as a seed.

### Step 4: Present the Harvest

Format the output as a scannable batch:

```
## Conversation Harvest
**Source:** [channel] conversation, [date range]
**Messages:** [count]

### Seeds (New Knowledge) — [count]

1. **[type]** [scope]
   > [content]
   Confidence: [0.0-1.0] | Tags: [tags]

2. **[type]** [scope]
   > [content]
   Confidence: [0.0-1.0] | Tags: [tags]

### Rain (Enrichment) — [count]

1. **[type]** [scope]
   > [content]
   Related to: [existing Forest entry summary]
   Confidence: [0.0-1.0] | Tags: [tags]

### Corrections (Ground Truth) — [count]

1. **fact** [scope]
   > [what the user said was correct]
   What was wrong: [what the AI got wrong]
   Confidence: 1.0 | Tags: [tags, correction:ground_truth]

### Summary
- [X] seeds ready to plant
- [Y] rain drops to nourish existing knowledge
- [C] corrections captured as ground truth
- [Z] items composted (discarded)
```

### Step 5: Ship on Approval

Wait for the user to review. They may:
- **Approve all** — write everything to the Forest
- **Edit items** — adjust content, type, confidence, or scope before writing
- **Remove items** — drop specific candidates
- **Approve selectively** — "ship seeds 1, 3, and rain 2"

For each approved item, write to the Forest:

```bash
curl -s -X POST http://localhost:3001/api/bridge/write \
  -H "Content-Type: application/json" \
  -H "x-bridge-key: bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a" \
  -d '{
    "content": "<approved content>",
    "type": "<type>",
    "scope_path": "<scope>",
    "confidence": <confidence>,
    "tags": [<tags>]
  }'
```

Or use `mcp__forest-bridge__forest_write`.

Report what was written:
```
## Harvest Complete
- [X] seeds planted
- [Y] rain drops applied
- Total: [N] new Forest entries
```

## Rules

- **Quality over quantity** — 3 high-value entries beat 15 mediocre ones
- **Standalone content** — every entry must make sense without the original conversation context
- **No personal memories** — facts about Dave, preferences, and action items go in the `memory` table (the existing system handles this). The Forest is for **institutional knowledge** about the system, architecture, and decisions
- **No duplicates** — always check the Forest first. If it's already there, it's rain, not a seed
- **Respect confidence** — don't inflate confidence. If something was speculative in the conversation, mark it as a hypothesis with low confidence
- **Scope accurately** — put entries in the most specific scope that fits. Don't dump everything in `2` (all projects) if it's clearly about `2/1` (ellie-dev)

## Edge Cases

**Conversation has no Forest-worthy content:**
→ "This conversation was mostly operational — no new knowledge to harvest. The existing memory system already captured the personal facts."

**Forest Bridge is unreachable:**
→ "Can't reach the Forest right now. I've prepared the harvest — want me to save it to `/tmp/harvest-pending.json` so we can ship it later?"

**Very long conversation (50+ messages):**
→ Focus on the latter half — early messages are often exploratory. Key decisions and findings usually emerge later in the conversation.

**User asks to harvest a conversation they're still in:**
→ That's fine — harvest what's there so far. Note that more seeds may emerge before the conversation closes.

## Future Extensions

This is v1 — manual trigger, review before shipping. Later iterations may add:
- Auto-trigger on conversation close (v2)
- Smarter deduplication using embedding similarity
- Dashboard UI for batch review with checkboxes
- Trend detection: "You keep discovering things about X — should we create a dedicated tree?"
- Cross-conversation pattern matching: "Three different conversations this week mentioned Y"

For now: **Harvest. Review. Ship. Grow the Forest.**
