---
name: briefing
description: Search the Forest for prior context before starting work on a ticket or topic
always: true
triggers: [ELLIE-, ticket, work on, implement, build, fix, debug, investigate, refactor]
---

## Pre-Work Briefing Protocol

Before starting substantive work — especially when a ticket (ELLIE-XXX) or specific topic is mentioned — **always search the Forest first** for prior context left by other agents or Ellie.

### How to Search

Use the Forest Bridge API (via Bash with curl):

```
curl -s -X POST http://localhost:3001/api/bridge/read \
  -H "Content-Type: application/json" \
  -H "x-bridge-key: bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a" \
  -d '{"query": "<ticket ID or topic keywords>", "scope_path": "2"}'
```

Or use the `mcp__forest-bridge__forest_read` MCP tool if available.

### What to Search For

1. **Ticket references**: If the message contains `ELLIE-XXX`, search for that identifier
2. **Topic keywords**: Extract the main topic (e.g., "skills system", "calendar sync", "context pollution") and search for it
3. **Related files**: If specific files are mentioned, search for prior findings about those files

### Scope Paths
- `2` — All projects (broadest, use for general topics)
- `2/1` — ellie-dev (relay, agents, skills)
- `2/2` — ellie-forest (library, trees, branches)
- `2/3` — ellie-home (dashboard, UI)
- `2/4` — ellie-os-app (mobile app)

### What to Do With Results

- **Summarize** findings briefly before diving into work — don't dump raw JSON
- **Flag concerns** — if someone raised issues or open questions, address them
- **Build on decisions** — don't redo analysis that's already been done
- **Note hypotheses** — if someone formed a hypothesis, verify or refute it
- **Check confidence levels** — low confidence (< 0.7) findings are speculative

### When to Skip

- Trivial questions ("what time is it", "how are you")
- Pure conversation with no work component
- Follow-up messages in an active work session where briefing was already done

### After Completing Work

Write your own findings back to the Forest so future agents benefit:

```
curl -s -X POST http://localhost:3001/api/bridge/write \
  -H "Content-Type: application/json" \
  -H "x-bridge-key: bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a" \
  -d '{"content": "...", "type": "decision|finding|fact", "scope_path": "2/1", "confidence": 0.9, "tags": ["relevant", "tags"], "metadata": {"work_item_id": "ELLIE-XXX"}}'
```

This creates a compounding knowledge loop — each agent's work makes the next agent smarter.
