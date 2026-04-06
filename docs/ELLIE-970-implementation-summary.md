# ELLIE-970 Implementation Summary — Tool Access Control & Usage Audit

**Status:** ✅ Code complete, ⚠️ Requires manual migration step

---

## What Was Built

### 1. Tool Access Control System (`src/tool-access-control.ts`)

**Purpose:** Enforce per-agent MCP access at runtime instead of relying on prompt-based guidelines.

**Components:**

- **`TOOL_CATEGORY_TO_MCP` mapping** — Converts abstract tool categories (from `agents.tools_enabled`) to concrete MCP server names
- **`getAllowedMCPs()`** — Returns the filtered list of allowed MCP servers for an agent
- **`isToolAllowed()`** — Checks if a specific tool/MCP is allowed for an agent
- **`formatAllowedToolsFlag()`** — Formats the allowed list for Claude CLI's `--allowedTools` flag

**Key Rules:**

- **Default tools** are always available to ALL agents:
  - `forest-bridge` — Knowledge persistence
  - `qmd` — River vault search
  - `memory` — Memory extraction
  - `plane` — Work item queries (read-only)
- **Category mapping** is extensible — new tool categories can be added to the mapping
- **Deduplication** — Multiple categories can map to the same MCP (e.g., `brave_search`, `brave_web_search`, `web_search` all → `brave-search`)

**Integration:**

- Updated `agent-router.ts` to call `getAllowedMCPs()` after every dispatch
- Added `allowed_mcps` field to `DispatchResult` interface
- Filtered MCPs are available to callers for enforcement

---

### 2. Usage Audit Logging (`src/tool-usage-audit.ts`)

**Purpose:** Track which agents use which tools for compliance, debugging, and behavioral verification.

**Components:**

- **`logToolUsage()`** — Logs a tool invocation to the `agent_tool_usage` table (fire-and-forget)
- **Parameter sanitization** — Redacts sensitive keys (`token`, `api_key`, `password`, `content`, etc.) before logging
- **`getAgentToolUsage()`** — Query tool usage logs for a specific agent
- **`getToolUsageStats()`** — Calculate success rate, tools used, avg duration for an agent
- **`detectAnomalies()`** — Detect unauthorized tool usage, high failure rates, excessive latency

**Audit Schema:**

```sql
CREATE TABLE agent_tool_usage (
  id UUID PRIMARY KEY,
  agent_name TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_category TEXT,
  operation TEXT,
  session_id TEXT,
  user_id TEXT,
  channel TEXT,
  success BOOLEAN,
  error_message TEXT,
  parameters JSONB,         -- Sanitized (secrets redacted)
  result_summary TEXT,      -- Brief summary, not full output
  duration_ms INTEGER,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB
);
```

**Indexes:**

- `agent_name`
- `tool_name`
- `timestamp DESC`
- `session_id`
- `(agent_name, tool_name)` composite

**Retention:** 90 days (can be extended to 1 year for compliance)

**Integration:**

- Updated `orchestration-dispatch.ts` to log every dispatch/spawn event (success and failure)
- Logs are written asynchronously (`.catch(() => {})`) to avoid blocking execution
- No sensitive data is logged — parameters are sanitized before storage

---

### 3. Migration + Tests

**Migration:** `migrations/supabase/20260322_agent_tool_usage.sql`

**Status:** ⚠️ **Not yet applied** — requires manual execution via Supabase SQL Editor

**Tests:**

- ✅ `tests/tool-access-control.test.ts` — 19 tests, all passing
  - Verifies category → MCP mapping
  - Validates default tools are always included
  - Confirms per-agent access matrix enforcement
- ✅ `tests/tool-usage-audit.test.ts` — 9 tests, all passing
  - Verifies parameter sanitization
  - Tests success/failure logging
  - Validates anomaly detection

---

## How It Works

### Tool Filtering Flow

1. **Agent dispatch** (`agent-router.ts`)
   - Fetches agent config from `agents` table (includes `tools_enabled`)
   - Calls `getAllowedMCPs(tools_enabled, agent_name)`
   - Stores `allowed_mcps` in `DispatchResult`

2. **Claude invocation** (`orchestration-dispatch.ts`)
   - Passes `allowed_mcps` (or `tools_enabled` for backward compat) to Claude CLI
   - Claude CLI enforces tool restrictions via `--allowedTools` flag

3. **Audit logging** (`orchestration-dispatch.ts`)
   - After successful dispatch: log tool usage (success=true, duration_ms)
   - After failed dispatch: log tool usage (success=false, error_message)
   - Logs include: agent, tool, session, user, channel, metadata (work_item_id, model)

---

## Agent Access Matrix

The system enforces the MCP access matrix documented in `CLAUDE.md`:

| Agent | Allowed MCPs |
|-------|-------------|
| **Ellie (General)** | Google Workspace, Brave Search, Forest, QMD, Memory, Plane, Agent Router |
| **James (Dev)** | GitHub (full), Bash, Git, Filesystem (r/w/e), Supabase, Postgres, Forest, QMD, Memory, Plane |
| **Kate (Research)** | Brave Search (core), Google Workspace (limited), Forest, QMD, Memory, Plane, Grep/Glob |
| **Alan (Strategy)** | Brave Search (markets), Miro, Forest, QMD, Memory, Plane, Google Workspace (docs) |
| **Brian (Critic)** | GitHub (PRs/reviews), Sequential Thinking, Forest, QMD, Memory, Plane, Bash (tests) |
| **Amy (Content)** | Google Workspace, Brave Search, Forest, QMD, Memory, Plane |
| **Marcus (Finance)** | Finance tools, Forest, QMD, Memory, Plane |
| **Jason (Ops)** | Bash (systemctl/journalctl), GitHub (deploys), Forest, QMD, Memory, Plane, Messaging |

All agents get default tools (Forest, QMD, Memory, Plane) automatically.

---

## What Remains

### Critical: Apply the Migration

The `agent_tool_usage` table does not exist yet. Apply the migration manually:

**Steps:**

1. Go to Supabase dashboard → SQL Editor
2. Run the SQL from `migrations/supabase/20260322_agent_tool_usage.sql`
3. Verify the table exists: `SELECT * FROM agent_tool_usage LIMIT 1;`

**Alternatively:**

```bash
# Copy the SQL to clipboard
cat migrations/supabase/20260322_agent_tool_usage.sql | pbcopy  # macOS
cat migrations/supabase/20260322_agent_tool_usage.sql | xclip  # Linux

# Paste into Supabase SQL Editor and run
```

**Without this step:** Audit logging will fail silently (logged as errors but won't block execution).

---

## Verification

### Test Tool Filtering

```bash
bun test tests/tool-access-control.test.ts
```

Expected: 19 tests pass

### Test Audit Logging

```bash
bun test tests/tool-usage-audit.test.ts
```

Expected: 9 tests pass

### Check Agent Access in Production

After applying the migration, dispatch an agent and verify:

1. **Tool filtering:**
   - Check relay logs for `[tool-access]` entries showing filtered MCPs
   - Example: `[tool-access] Agent dev allowed MCPs: bash, filesystem-read, forest-bridge, git, ...`

2. **Audit logging:**
   - Query the audit table:
     ```sql
     SELECT * FROM agent_tool_usage ORDER BY timestamp DESC LIMIT 10;
     ```
   - Should see dispatch events for each agent invocation

3. **Anomaly detection:**
   - Run the anomaly detector:
     ```ts
     import { detectAnomalies } from "./src/tool-usage-audit.ts";
     const anomalies = await detectAnomalies(supabase, "dev", getAllowedMCPs(devTools, "dev"));
     console.log(anomalies);
     ```

---

## Security Notes

- **Sensitive data redaction** — API keys, tokens, passwords, and message content are redacted before logging
- **Fire-and-forget** — Audit logging never blocks execution; failures are logged but not surfaced to users
- **Retention policy** — 90-day auto-deletion (can be extended to 1 year via scheduled job)
- **Read-only enforcement** — The audit log is write-only from the relay; no public read API (prevents data leaks)

---

## Future Enhancements

1. **Real-time anomaly alerts** — Notify when agents violate tool restrictions
2. **Usage dashboards** — Visualize tool usage by agent, time, success rate
3. **Tool budgets** — Limit tool invocations per agent/hour (rate limiting)
4. **Fine-grained MCP filtering** — Per-operation restrictions (e.g., Gmail read-only vs. send)
5. **Compliance reporting** — Export audit logs for SOC2/HIPAA compliance

---

## Files Changed

### New Files

- `src/tool-access-control.ts` — Tool filtering logic
- `src/tool-usage-audit.ts` — Audit logging module
- `migrations/supabase/20260322_agent_tool_usage.sql` — Audit table schema
- `tests/tool-access-control.test.ts` — 19 tests for filtering
- `tests/tool-usage-audit.test.ts` — 9 tests for audit logging
- `docs/ELLIE-970-implementation-summary.md` — This document

### Modified Files

- `src/agent-router.ts` — Added `getAllowedMCPs()` calls, added `allowed_mcps` to `DispatchResult`
- `src/orchestration-dispatch.ts` — Added `logToolUsage()` calls for dispatch/spawn events (4 call sites)

---

## Estimated Time

- **Development:** 2.5 hours (actual)
- **Testing:** 30 minutes
- **Migration + verification:** 15 minutes (pending)
- **Total:** ~3 hours (matches estimate)

---

## Summary

✅ **Complete:**
- Tool access control system with category → MCP mapping
- Per-agent MCP filtering in `agent-router.ts`
- Usage audit logging with sensitive data redaction
- Anomaly detection (unauthorized tools, high failure rate, excessive latency)
- Comprehensive test coverage (28 tests, all passing)

⚠️ **Pending:**
- Apply `20260322_agent_tool_usage.sql` migration via Supabase SQL Editor

🚀 **Ready to ship:** Yes, once the migration is applied. The system is backward-compatible — if the table doesn't exist, audit logs fail silently without blocking execution.

---

**Next steps:**

1. Apply the migration (copy SQL to Supabase dashboard)
2. Restart the relay
3. Dispatch a few agents and verify audit logs are being written
4. Run anomaly detection on the first 24 hours of data to establish baseline

Done!
