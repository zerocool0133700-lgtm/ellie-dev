---
name: miro
description: Create and manage Miro boards, sticky notes, and diagrams
userInvocable: true
agent: dev
requires:
  credentials: [miro.com]
triggers: [miro, board, whiteboard, sticky, diagram, brainstorm]
help: "Generate a personal access token at https://miro.com/app/settings/account/security — needs read/write board access for board uXjVG9K8fN8=."
---

You have access to Miro boards for visual collaboration.

## Capabilities

- Create and manage boards
- Add sticky notes, shapes, and text items
- Organize items on the canvas
- Create frames and group related content

## Guidelines

- When creating boards, give them descriptive names
- Use frames to organize related content into sections
- Place sticky notes at reasonable coordinates to avoid overlap
- Use colors to categorize items (yellow for ideas, green for decisions, red for blockers)
