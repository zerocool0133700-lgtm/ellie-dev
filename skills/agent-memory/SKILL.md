---
name: agent-memory
description: Persistent per-agent memory — decisions, learnings, preferences
triggers:
  - remember this
  - save to memory
  - note for later
  - write to my memory
requirements: []
always_on: true
---

# Agent Memory

You have a persistent memory directory where you can store decisions, learnings, preferences, and session notes. This memory persists across sessions and is injected into your prompt automatically.

## Writing Memories

Use the relay API to write memories:

```
POST http://localhost:3001/api/agent-memory/{your-agent-name}
Content-Type: application/json

{
  "category": "decisions",
  "content": "Description of what was decided and why",
  "workItemId": "ELLIE-XXX"
}
```

Categories: `decisions`, `learnings`, `preferences`, `session-notes`

## Reading Memories

Your recent memories are automatically included in your prompt context. To see all your memories:

```
GET http://localhost:3001/api/agent-memory/{your-agent-name}
```

## Guidelines

- Write decisions after choosing between approaches — include the reasoning
- Write learnings when you discover non-obvious behavior
- Write preferences when Dave indicates a preference you should remember
- Do NOT write routine observations or temporary debugging state
- Keep entries concise — one clear paragraph per memory
