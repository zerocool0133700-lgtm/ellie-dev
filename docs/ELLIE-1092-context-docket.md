# ELLIE-1092 — General Agent Plane MCP Access Fix

## Context Docket

**Ticket:** ELLIE-1092
**Status:** Done (merged 2026-03-28, commit `e566c89`)
**Summary:** The general agent's tool categories were being passed as raw strings to Claude CLI instead of being converted to `mcp__*` format, meaning the general agent couldn't actually use Plane or any other MCP tools at dispatch time.

---

## What Was Wrong

The `localDispatch()` function in `agent-router.ts` read `tools_enabled` from the Supabase `agents` table (e.g. `["forest_bridge", "plane_lookup", "google_workspace"]`) and passed these raw category names directly to the Claude CLI. The CLI expects `mcp__plane__*` format, so the tools were silently ignored.

The same bug affected `dispatchAgent()` when it received results from the edge function — raw category names came back and were never converted.

## What Was Done

### New file: `src/tool-access-control.ts` (217 lines)

Central module for converting abstract DB tool categories to concrete CLI tool patterns.

| Export | Purpose |
|--------|---------|
| `TOOL_CATEGORY_TO_MCP` | Maps all known categories (e.g. `plane_lookup`) to MCP server names (e.g. `plane`) |
| `ALWAYS_ALLOWED_TOOLS` | `forest-bridge`, `qmd`, `memory`, `plane` — available to all agents regardless of config |
| `getAllowedMCPs()` | Returns MCP server names for an agent, merging config + always-allowed |
| `formatMCPsForCLI()` | Converts MCP names to CLI patterns: `plane` -> `mcp__plane__*` |
| `getAllowedToolsForCLI()` | Full conversion: categories -> MCP names -> CLI patterns, plus built-in tools (`Read`, `Edit`, `Write`, `Bash`, `Glob`, `Grep`, `WebSearch`, `WebFetch`) |

### Updated: `src/agent-router.ts`

- **Line 233-234:** `localDispatch()` now calls `getAllowedToolsForCLI()` to convert categories before returning the dispatch result
- **Line 243:** `tools_enabled` in the returned agent config uses the CLI-formatted array
- **Line 300-301:** `dispatchAgent()` applies the same conversion to edge function results

### New test: `tests/general-agent-plane-access.test.ts` (76 lines)

5 test cases covering:
1. `formatMCPsForCLI` produces correct `mcp__*__*` patterns
2. General agent gets all expected MCPs (plane, google-workspace, forest-bridge, brave-search, memory, qmd)
3. Dev agent gets plane via `ALWAYS_ALLOWED_TOOLS` plus its explicit tools (supabase, git)
4. Empty `tools_enabled` still returns always-allowed tools
5. Null `tools_enabled` still returns always-allowed tools

---

## Is the General Agent Configured?

**Yes.** The general agent is fully configured in `seeds/supabase/001_agents.sql`:

- **Name:** `general`
- **Type:** `general`
- **Status:** `active`
- **Species:** squirrel (breadth-first forager)
- **Capabilities:** conversation, coordination, task_routing, context_management, general_assistance
- **Tools enabled:** `forest_bridge`, `plane_lookup`, `google_workspace`, `web_search`, `memory_extraction`, `agent_router`

After ELLIE-1092, these categories resolve to the following CLI tools at dispatch:

| Category | CLI Pattern |
|----------|------------|
| `forest_bridge` | `mcp__forest-bridge__*` |
| `plane_lookup` | `mcp__plane__*` |
| `google_workspace` | `mcp__google-workspace__*` |
| `web_search` | `mcp__brave-search__*` |
| `memory_extraction` | `mcp__memory__*` |
| `agent_router` | `mcp__agent-router__*` |
| *(always-allowed)* | `mcp__qmd__*` |
| *(built-in)* | `Read`, `Edit`, `Write`, `Bash`, `Glob`, `Grep`, `WebSearch`, `WebFetch` |

## Is Ellie Using the General Agent?

**Yes.** The general agent is the **default coordinator** in the routing system. When a user message arrives:

1. `agent-router.ts:routeAndDispatch()` determines which agent handles the message
2. The general agent is the fallback/default — it handles all messages that aren't routed to a specialist
3. `dispatchAgent()` or `localDispatch()` fetches the agent config from Supabase
4. ELLIE-1092 ensures the tool categories are now correctly converted to CLI format
5. The general agent receives a properly formatted tool list and can use all its MCPs

The general agent acts as Ellie's primary persona — it coordinates, routes to specialists when needed, and handles direct conversation, calendar, email, search, and knowledge management.

---

## Files Changed

| File | Change |
|------|--------|
| `src/tool-access-control.ts` | **New** — tool category-to-CLI conversion module |
| `src/agent-router.ts` | **Updated** — uses `getAllowedToolsForCLI()` in both dispatch paths |
| `tests/general-agent-plane-access.test.ts` | **New** — test coverage for the fix |
| `seeds/supabase/001_agents.sql` | **Unchanged** — general agent config was already correct; the bug was in conversion |
