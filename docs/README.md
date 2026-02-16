# Ellie Knowledge Base

> Personal knowledge management for Dave's AI assistant and development work.

## Structure

This folder contains markdown files organized by topic. Claude Code can read/edit these files directly, and they can optionally be opened in Obsidian for rich UI features.

### Folders

- **architecture/** — System designs, technical decisions, infrastructure notes
- **projects/** — Project-specific documentation (TheEveLife, Ellie Home, etc.)
- **reference/** — Quick reference guides, cheatsheets, API docs
- **journal/** — Daily notes, meeting summaries, work logs
- **ideas/** — Brainstorms, future plans, concept exploration

### Naming Conventions

- Use kebab-case for filenames: `my-document.md`
- Add dates for journals: `2026-02-16-journal.md`
- Keep titles descriptive: `telegram-relay-voice-optimization.md` not `voice.md`

### Linking

Standard markdown links work everywhere:
```markdown
See [architecture overview](./architecture/system-design.md) for details.
```

### Frontmatter (optional)

Add metadata at the top of files for better organization:
```yaml
---
title: Document Title
date: 2026-02-16
tags: [tag1, tag2]
status: draft | active | archived
---
```

### Search

Files are version-controlled in Git and can be indexed by Elasticsearch for fast semantic search across all documents.

## Usage

### Create a new document
```bash
# Via terminal
vim docs/projects/evelife-setup.md

# Or via Claude Code
# Just ask: "Create a doc about X in docs/projects/"
```

### View/edit in Obsidian (optional)
1. Open Obsidian
2. "Open folder as vault"
3. Select `/home/ellie/ellie-dev/docs`

### Commit changes
```bash
git add docs/
git commit -m "docs: add new architecture notes"
```

## Getting Started

Start with a few seed documents:
- Create a project doc for your current work
- Start a daily journal
- Add architecture notes from recent conversations

The system grows with you — add folders/conventions as needed.
