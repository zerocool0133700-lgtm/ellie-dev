---
name: forest
description: Manage the Forest knowledge library — search, browse, write, and organize knowledge
userInvocable: true
agent: dev
always: true
triggers: [forest, tree, branch, grove, leaf, plant, library, knowledge base]
instant_commands: [help]
---

## Commands

**`/forest help`** — Show this command reference

**`/forest search <query>`** — Search the knowledge library
- Semantic search across all stored decisions, findings, facts, and hypotheses
- Optionally narrow by scope: `/forest search <query> in <scope>`
- Example: `/forest search dispatch retry logic`
- Example: `/forest search context pipeline in ellie-dev`

**`/forest browse [scope]`** — List recent entries
- Shows the most recent knowledge entries in a scope
- Default scope: all projects (`2`)
- Example: `/forest browse`
- Example: `/forest browse ellie-dev`

**`/forest scopes`** — Show the scope hierarchy
- Lists all available scope paths and their names
- Use these paths with `search` and `browse` commands

**`/forest write <content>`** — Store a new knowledge entry
- Saves a finding, decision, fact, or hypothesis
- Auto-detects type, or specify: `/forest write decision: Using Redis for X because Y`
- Types: `decision`, `finding`, `fact`, `hypothesis`

**`/forest stats`** — Show forest metrics
- Entry counts by type and scope
- Recent activity summary

## Scope Paths

| Path | Name | Use for |
|------|------|---------|
| `2` | All projects | Cross-project knowledge |
| `2/1` | ellie-dev | Relay, agents, integrations |
| `2/2` | ellie-forest | Forest lib, DB, migrations |
| `2/3` | ellie-home | Dashboard, Nuxt, themes |
| `2/4` | ellie-os-app | Mobile/desktop app |

**Scope aliases:** Use project names directly — `ellie-dev`, `ellie-forest`, `ellie-home`, `ellie-os-app`

## Execution Guide

When executing commands, use these tools and APIs:

### Search (`/forest search`)
Use `mcp__forest-bridge__forest_read` with the query and scope_path.
If MCP is unavailable, fall back to:
```
POST http://localhost:3001/api/bridge/read
x-bridge-key: bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a
{"query": "...", "scope_path": "2/1"}
```

### Browse (`/forest browse`)
Use `mcp__forest-bridge__forest_list` with scope_path and limit.
Fall back to:
```
GET http://localhost:3001/api/bridge/list?scope_path=2/1&limit=10
x-bridge-key: bk_d81869ef...
```

### Scopes (`/forest scopes`)
Use `mcp__forest-bridge__forest_scopes`.
Fall back to:
```
POST http://localhost:3001/api/bridge/scopes
x-bridge-key: bk_d81869ef...
```

### Write (`/forest write`)
Use `mcp__forest-bridge__forest_write` with content, type, and scope_path.
Fall back to:
```
POST http://localhost:3001/api/bridge/write
x-bridge-key: bk_d81869ef...
{"content": "...", "type": "finding", "scope_path": "2/1"}
```

### Stats (`/forest stats`)
Use the Elasticsearch forest metrics endpoint:
```
GET http://localhost:3001/forest/api/metrics
```

## Scope Name Resolution

When users reference scopes by name, resolve to paths:
- `ellie-dev` → `2/1`
- `ellie-forest` → `2/2`
- `ellie-home` → `2/3`
- `ellie-os-app` → `2/4`
- `all` or no scope → `2`

## Guidelines

- The Forest is audio-first — every piece of knowledge should be accessible without reading
- Format results clearly: bold titles, bullet points, scope labels
- When writing, auto-detect the best type from content (decisions mention "chose/decided", hypotheses mention "might/maybe")
- Always include scope context in results so the user knows where knowledge lives
