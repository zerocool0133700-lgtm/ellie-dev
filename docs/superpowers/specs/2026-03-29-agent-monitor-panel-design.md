# Agent Monitor Panel — Design Spec

**Date:** 2026-03-29
**Status:** Approved
**Author:** Dave + Claude Opus 4.6
**Scope:** Real-time agent activity monitor for Ellie Chat dashboard

---

## Problem Statement

When the coordinator dispatches specialists (James, Brian, Kate, etc.), the dashboard shows nothing for 2-5 minutes. The user has no visibility into which agents are working, what they're doing, or how far along they are. Spawn events currently appear as inline chat messages that are easy to miss. The channels sidebar is redundant now that the coordinator handles routing.

## Design Decisions

**Layout:** Top pull-down panel at the top of ellie-chat. Collapsed state shows agent avatars with progress bars. Expanded state shows tabs with summary card + tool activity feed. No channels sidebar — removed entirely.

**Visibility levels:** Progressive — collapsed shows avatars + progress (zero reading required), expanded shows structured summary + live tool feed. Full streaming of specialist stdout is opt-in per agent tab.

**Tab lifecycle:** Tabs persist after completion (green for done, red for failed) until manually dismissed. This lets the user review results on their own time.

**Streaming approach:** Start with milestone events (C-level), with streaming stdout (A-level) as a progressive enhancement. The relay parses CLI subprocess stdout into structured events.

---

## Architecture

### Three Layers

| Layer | Location | Responsibility |
|-------|----------|---------------|
| **Event Streaming** | Relay (`ellie-dev`) | Parse specialist CLI stdout into WebSocket events |
| **State Management** | Dashboard composable (`ellie-home`) | Track per-agent state from events |
| **UI Rendering** | Dashboard component (`ellie-home`) | Render the monitor panel with tabs |

### WebSocket Event Types

Four event types power the monitor. Two already exist (ELLIE-1099), two are new:

| Event | Status | When | Key Fields |
|-------|--------|------|------------|
| `spawn_status` | Exists | Agent dispatched | `spawnId`, `agent`, `task`, `status: "running"` |
| `agent_tool_call` | **New** | Agent uses a tool | `spawnId`, `agent`, `tool` (Read/Edit/Bash/Grep/Glob/WebSearch), `target` (file path or query), `status` (running/done), `duration_ms` |
| `agent_progress` | **New** | Milestone reached | `spawnId`, `agent`, `files_touched[]`, `tests: {pass, fail}`, `phase` (reading/editing/testing/complete) |
| `spawn_announcement` | Exists | Agent finished | `spawnId`, `agent`, `status` (completed/failed), `durationSec`, `resultPreview` |

### Event Format Examples

```json
{
  "type": "agent_tool_call",
  "spawnId": "dsp_abc123",
  "agent": "james",
  "tool": "Edit",
  "target": "src/markdown-fixer.ts",
  "status": "done",
  "duration_ms": 1200,
  "ts": 1711800000000
}
```

```json
{
  "type": "agent_progress",
  "spawnId": "dsp_abc123",
  "agent": "james",
  "files_touched": ["src/markdown-fixer.ts", "src/response-tag-processor.ts"],
  "tests": { "pass": 15, "fail": 0 },
  "phase": "testing",
  "ts": 1711800000000
}
```

---

## Relay Changes

### Streaming Specialist Output

Currently `callSpecialist` in `coordinator.ts` calls `callClaude` which spawns a CLI subprocess and buffers all output until exit. To stream tool calls:

**Change:** Read the subprocess stdout line-by-line. The Claude CLI in `--output-format stream-json` mode emits JSON objects for each tool use and text block. Parse these incrementally and forward relevant ones as WebSocket events via `deps.sendEvent`.

**What to parse from CLI stream:**
- `{"type": "tool_use", "name": "Read", "input": {"file_path": "..."}}` → `agent_tool_call` event with status "running"
- `{"type": "tool_result", ...}` → update the tool_call to status "done" with duration
- Text blocks containing test output → parse pass/fail counts → `agent_progress` event

**What NOT to parse:**
- Full file contents (too large for WebSocket)
- Internal thinking/reasoning blocks
- Anything > 1KB — truncate to preview

**Fallback:** If `--output-format stream-json` is not available or the output can't be parsed, fall back to the existing behavior (spawn_status at start, spawn_announcement at end, nothing in between). The monitor shows the collapsed avatar with an indeterminate progress bar.

### Progress Estimation

The progress bar needs a percentage. Since we don't know upfront how long an agent will take:

- **0-10%**: dispatched, waiting for first tool call
- **10-80%**: proportional to tool calls received (normalize to this range)
- **80-95%**: agent is in "testing" phase (detected by Bash tool calls containing "test")
- **95-100%**: agent output received, synthesizing

This is a heuristic, not exact. Close enough for UX.

---

## Dashboard Changes

### Remove Channels Sidebar

Remove the `ChannelSidebar.vue` component from `ellie-chat.vue`. The chat area gets full width. Any channel-specific state in `useEllieChat.ts` can remain (it's used for internal routing) but the sidebar UI is removed.

### New Composable: `useAgentMonitor()`

**File:** `app/composables/useAgentMonitor.ts`

**State (reactive refs):**

```typescript
interface AgentMonitorState {
  id: string;              // spawnId
  agent: string;           // agent name (james, brian, etc.)
  task: string;            // task description
  status: "running" | "completed" | "failed";
  phase: "dispatched" | "reading" | "editing" | "testing" | "complete";
  progress: number;        // 0-100 estimated percentage
  startedAt: number;       // timestamp
  completedAt?: number;    // timestamp
  durationSec?: number;
  toolFeed: ToolFeedEntry[];     // scrolling list of tool calls
  filesTouched: string[];        // unique file paths
  tests?: { pass: number; fail: number };
  resultPreview?: string;        // first 300 chars of output
  error?: string;
}

interface ToolFeedEntry {
  tool: string;            // Read, Edit, Bash, Grep, etc.
  target: string;          // file path, command, query
  status: "running" | "done";
  duration_ms?: number;
  ts: number;
}
```

**API:**

```typescript
const {
  agents,              // Ref<AgentMonitorState[]> — all tracked agents
  activeAgents,        // Computed — agents with status "running"
  hasActivity,         // Computed — any agents tracked (including completed)
  isExpanded,          // Ref<boolean> — panel expanded state
  activeTab,           // Ref<string | null> — selected agent spawnId
  toggleExpanded,      // () => void
  selectTab,           // (spawnId: string) => void
  dismissAgent,        // (spawnId: string) => void — remove completed/failed agent
  dismissAll,          // () => void — clear all completed/failed
} = useAgentMonitor()
```

**Event handling:** Listens to the existing `useEllieChat()` WebSocket. When events arrive:
- `spawn_status` → create new `AgentMonitorState` entry
- `agent_tool_call` → append to agent's `toolFeed`, update `phase`
- `agent_progress` → update `filesTouched`, `tests`, `phase`, `progress`
- `spawn_announcement` → set `status` to completed/failed, set `resultPreview`

### New Component: `AgentMonitorPanel.vue`

**File:** `app/components/ellie/AgentMonitorPanel.vue`

**Three visual states:**

#### Hidden (no agents tracked)
- Component renders nothing. Chat has full height.

#### Collapsed (agents tracked, panel closed)
- Thin bar at top of chat area (36px height)
- Left side: agent avatars (colored circles with initial) + thin progress bar under each
  - Running agents: colored avatar with animated progress bar
  - Completed agents: green border, checkmark overlay
  - Failed agents: red border, X overlay
- Right side: expand chevron (▼)
- Click anywhere on bar to expand

#### Expanded (panel open)
- Expands to max 40% viewport height or 300px, whichever is smaller
- Top row: agent tabs (avatar + name), click to switch
- Selected tab content: split view
  - Left (45%): Summary card
    - Task description
    - Current phase badge (reading/editing/testing)
    - Files touched list
    - Test results (pass/fail counts)
    - Duration timer
  - Right (55%): Tool activity feed
    - Scrolling list, auto-scrolls to bottom
    - Each entry: icon + tool name + target + status + duration
    - Color coded: green (done), blue (running), yellow (in progress)
- Completed/failed tabs show result preview or error instead of live feed
- Each tab has a dismiss (X) button in the corner
- Collapse chevron (▲) at top right

### Styling

Follow existing ellie-chat dark theme:
- Background: `rgba(0,0,0,0.3)` for panel
- Borders: `rgba(255,255,255,0.08)`
- Agent colors: use existing `AGENT_DISPLAY` map from `useAgentProfiles.ts`
- Animations: `animate-pulse` for running indicators (matches existing typing indicator)
- Transitions: `transition-all duration-300` for expand/collapse
- Progress bars: thin (3px), agent-colored fill on dark track

### Accessibility (dyslexia-first)

- **No required reading** — status communicated via colors, icons, progress bars
- **Audio feedback** — optional subtle sound on agent complete/fail (reuse existing TTS infrastructure)
- **Large touch targets** — avatar circles minimum 28px, tabs full-height clickable
- **No flashing** — pulse animation is gentle (1.5s cycle), not rapid blink

---

## Changes Summary

### Relay (`ellie-dev`)

| File | Change |
|------|--------|
| `src/coordinator.ts` | Update `callSpecialist` to stream stdout and emit `agent_tool_call` / `agent_progress` events via `sendEvent` |

### Dashboard (`ellie-home`)

| File | Change |
|------|--------|
| `app/composables/useAgentMonitor.ts` | **New** — agent state tracking from WebSocket events |
| `app/composables/useEllieChat.ts` | Add routing for new event types to `useAgentMonitor` |
| `app/components/ellie/AgentMonitorPanel.vue` | **New** — the pull-down panel component |
| `app/pages/ellie-chat.vue` | Mount `AgentMonitorPanel` at top, remove `ChannelSidebar` |

### Files Removed

| File | Reason |
|------|--------|
| `app/components/ellie/ChannelSidebar.vue` | Replaced by agent monitor. Channels no longer needed. |

---

## Testing Strategy

### Relay
- **Unit:** Parse mock CLI stream-json output into `agent_tool_call` events
- **Unit:** Progress estimation heuristic produces reasonable percentages
- **Integration:** Coordinator dispatch sends spawn + tool_call + announcement events

### Dashboard
- **Unit:** `useAgentMonitor` correctly creates/updates/dismisses agent state from events
- **Unit:** Progress bar calculation from tool call count
- **Visual:** Monitor panel renders collapsed/expanded/hidden states correctly
- **Visual:** Tab switching, dismiss, auto-scroll behavior

---

## Open Questions

1. **Max concurrent agents in monitor:** How many tabs before the bar overflows? Recommendation: 6 tabs visible, horizontal scroll if more. Unlikely to exceed 6 in practice.

2. **Sound on completion:** Worth adding a subtle chime when an agent finishes? Could be a foundation-level setting (high proactivity = sounds on, low = silent).

3. **Mobile layout:** On small screens, the expanded panel should take more height (60% vs 40%). Collapsed bar stays the same.
