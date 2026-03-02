---
name: audit
description: Run data integrity checks across Supabase and Elasticsearch — verifies message sync, orphaned records, and conversation count accuracy
userInvocable: true
agent: dev
triggers: [audit, data integrity, orphaned messages, integrity check, es sync, message sync]
instant_commands: [help]
---

## Commands

**`/audit help`** — Show this reference

**`/audit`** or **`/audit data-integrity`** — Run the data integrity audit (last 7 days)

**`/audit data-integrity --days <n>`** — Run audit over a custom window (max 30 days)

## What It Checks

1. **ES ↔ Supabase message count** — Verifies Elasticsearch and Supabase have the same number of messages per day
2. **Orphaned messages** — Counts messages with `conversation_id = null` (unlinked from any conversation)
3. **Conversation count integrity** — Verifies each conversation's stated `message_count` matches actual linked messages
4. **Per-day summary** — Tabular breakdown of all metrics for each day in the window

## How to Run

Call the relay audit endpoint and display the result:

```bash
curl -s "http://localhost:3001/api/audit/data-integrity?days=7" | jq .
```

For a formatted report with the same table layout as the ELLIE-406 manual audit, parse the `daily` array and `issues` array from the JSON response.

## Interpreting Results

- `clean: true` — No issues found, all checks passed
- `issues[]` — Array of problems found:
  - `es_mismatch` — ES and SB message counts differ for a day (data loss risk)
  - `orphaned_messages` — Messages exist with null conversation_id (invisible to UI and agents)
  - `broken_conv_count` — A conversation's stated count doesn't match actual linked messages

## History / Trends

Each audit run is appended to `ellie-dev/data/audit-history.jsonl`.
To check recent trend: read the last N lines and compare `totals.orphaned` over time.

```bash
tail -5 /home/ellie/ellie-dev/data/audit-history.jsonl | jq '{ranAt, clean, totals}'
```

## Schedule

Runs automatically every **Sunday at 11 PM CST** alongside the channel gardener.
Alerts via Telegram + Google Chat if any issues are found. Silent on clean runs.
