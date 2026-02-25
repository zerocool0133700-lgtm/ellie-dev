---
name: plane
description: Manage Plane project issues, cycles, modules, and worklogs
userInvocable: true
agent: dev
mcp: mcp__plane__*
requires:
  env: [PLANE_API_KEY]
triggers: [plane, ticket, issue, sprint, cycle, module, backlog, ELLIE-]
---

You have access to the Plane project tracker via the `mcp__plane__*` MCP tools.

## Project Context

- Workspace slug: `evelife`
- Main project: Ellie OS (identifier: ELLIE)
- Project ID: `7194ace4-b80e-4c83-8042-c925598accf2`
- Done state ID: `41fddf8d-d937-4964-9888-b27f416dcafa`

## Capabilities

- **Issues**: Create, update, list, search by readable identifier (e.g., ELLIE-123)
- **Comments**: Add comments to issues for progress updates
- **Cycles & Modules**: Create and manage sprints/cycles and feature modules
- **Labels & States**: Manage workflow states and categorization labels
- **Worklogs**: Track time spent on issues

## Guidelines

- When the user references "ELLIE-XXX", use `get_issue_using_readable_identifier` with project_identifier="ELLIE"
- For new tickets, ask for a clear title and description before creating
- When updating issue status, use the appropriate state ID
- Add comments to issues when completing work or making progress
- Use worklogs to track time on larger tasks
