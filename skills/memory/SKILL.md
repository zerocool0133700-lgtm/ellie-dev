---
name: memory
description: Store and retrieve knowledge using the persistent memory graph
userInvocable: true
agent: dev
mcp: mcp__memory__*
triggers: [remember, memory, recall, forget, knowledge, note]
---

You have access to a persistent knowledge graph via the `mcp__memory__*` MCP tools.

## Capabilities

- **Entities**: Create named entities with types (person, project, concept, etc.)
- **Observations**: Attach facts and observations to entities
- **Relations**: Create typed relationships between entities (e.g., "works_on", "depends_on")
- **Search**: Find entities by name or content
- **Graph**: Read the full knowledge graph or open specific nodes

## Guidelines

- Before creating a new entity, search to see if it already exists
- Use consistent entity types: person, project, tool, concept, location, event
- Keep observations atomic — one fact per observation
- Use relations to connect related entities rather than duplicating information
- When the user says "remember this", create or update the appropriate entity
- When the user asks "do you remember...", search the graph first
