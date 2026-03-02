---
name: obsidian
description: Read and write notes in the Obsidian vault — visual workspace for brainstorming, daily notes, and working knowledge
userInvocable: true
agent: dev
triggers: [obsidian, vault, note, notes, daily note, workspace, canvas, brainstorm, visual]
instant_commands: [help]
---

## Obsidian Vault

The vault is a folder of Markdown files at `/home/ellie/obsidian-vault/`. You can read and write files directly using Bash or the `obsidian-vault` MCP filesystem tools.

**Browser access:** `http://<server-ip>:8082/` — full Obsidian UI in a browser tab
**Dashboard:** `/obsidian` page in LE Home

---

## Vault Structure

```
/home/ellie/obsidian-vault/
├── Daily Notes/          ← Date-stamped logs (YYYY-MM-DD.md)
├── Forest/               ← Working notes before promotion to Forest library
├── Projects/             ← One subfolder per ELLIE-XXX or named project
├── Areas/                ← Ongoing life areas (health, work, family, finances)
├── Resources/            ← Reference material and research
└── Archive/              ← Completed or closed items
```

---

## Reading Notes

```bash
# Read a specific note
cat "/home/ellie/obsidian-vault/Daily Notes/2026-03-02.md"

# List all notes in a folder
ls "/home/ellie/obsidian-vault/Projects/"

# Search across the vault
grep -r "ELLIE-409" /home/ellie/obsidian-vault/
```

---

## Writing Notes

```bash
# Create or append to today's daily note
DATE=$(date +%Y-%m-%d)
cat >> "/home/ellie/obsidian-vault/Daily Notes/${DATE}.md" << 'EOF'
## 15:30 — Obsidian integration shipped
ELLIE-409 complete. Vault live, MCP connected, dashboard page added.
EOF

# Create a project note
cat > "/home/ellie/obsidian-vault/Projects/ELLIE-409.md" << 'EOF'
# ELLIE-409 — Obsidian Integration
Status: Done
Shipped: 2026-03-02
EOF
```

---

## Forest ↔ Obsidian Flow

| Tool | Use for |
|---|---|
| **Obsidian** | Visual brainstorming, working notes, daily logs, rough drafts |
| **Forest** | Structured long-term knowledge — decisions, findings, facts |

Flow: think in Obsidian → refine → promote to Forest
To promote a note to Forest, use `/forest write` or the Harvest button in the conversations page.

---

## MCP Access (Claude Code sessions)

The `obsidian-vault` MCP server is registered globally. In Claude Code, you can use `mcp__obsidian-vault__*` tools to read, write, and list vault files without needing Bash.

---

## Commands

**`/obsidian help`** — Show this reference
**`/obsidian read <path>`** — Read a note (relative to vault root)
**`/obsidian write <path>`** — Write/append to a note
**`/obsidian search <query>`** — Grep search across vault
**`/obsidian today`** — Read or create today's daily note
