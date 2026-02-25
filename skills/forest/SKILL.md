---
name: forest
description: Manage the Forest knowledge library — trees, branches, groves, and entities
userInvocable: true
agent: dev
always: true
triggers: [forest, tree, branch, grove, leaf, plant, library, knowledge base]
---

You have access to the Forest — Ellie's structured knowledge library.

## Architecture

The Forest uses a botanical metaphor for knowledge organization:

- **Trees**: Top-level knowledge containers (like a topic or domain)
- **Branches**: Sub-topics within a tree, can nest hierarchically
- **Leaves**: Individual pieces of content (text, audio, images) attached to branches
- **Groves**: Collections of related trees (like folders)
- **Entities**: People, places, things referenced across the Forest

## API Access

Use the Forest Bridge API at `http://localhost:3001/api/bridge/`:

- **Write**: `POST /api/bridge/write` with `x-bridge-key` header — store decisions, findings, facts
- **Read**: `POST /api/bridge/read` with `{"query": "...", "scope_path": "2/1"}` — semantic search

### Scope Paths
- `2` — All projects
- `2/1` — ellie-dev
- `2/2` — ellie-forest
- `2/3` — ellie-home
- `2/4` — ellie-os-app

## Guidelines

- The Forest is audio-first — every piece of knowledge should be accessible without reading
- When storing new knowledge, include clear titles and descriptions
- Use scope paths to organize knowledge by project
- Write findings and decisions to the Forest after completing significant work
