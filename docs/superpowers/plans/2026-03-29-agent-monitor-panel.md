# Agent Monitor Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pull-down agent activity monitor to ellie-chat that shows real-time specialist dispatch status with tool feeds, progress bars, and structured summaries. Remove the channels sidebar.

**Architecture:** The relay streams specialist CLI stdout as WebSocket events (`agent_tool_call`, `agent_progress`). A new `useAgentMonitor` composable tracks per-agent state. A new `AgentMonitorPanel.vue` component renders the pull-down bar with collapsible tabs. The `ChannelSidebar` is removed from ellie-chat.

**Tech Stack:** Bun + TypeScript (relay), Nuxt 4.3 + Vue 3.5 + Tailwind v4 (dashboard), WebSocket events

---

## File Structure

### Relay (`/home/ellie/ellie-dev`)

| File | Action | Responsibility |
|------|--------|---------------|
| `src/coordinator.ts` | Modify | Stream tool_call events during specialist dispatch |

### Dashboard (`/home/ellie/ellie-home`)

| File | Action | Responsibility |
|------|--------|---------------|
| `app/composables/useAgentMonitor.ts` | Create | Track per-agent state from WebSocket events |
| `app/components/ellie/AgentMonitorPanel.vue` | Create | Pull-down panel with collapsed bar + expanded tabs |
| `app/composables/useEllieChat.ts` | Modify | Route new event types to useAgentMonitor |
| `app/pages/ellie-chat.vue` | Modify | Mount AgentMonitorPanel, remove ChannelSidebar |

---

### Task 1: Stream Tool Call Events from Relay

**Files:**
- Modify: `/home/ellie/ellie-dev/src/coordinator.ts`

The coordinator's `callSpecialist` currently buffers CLI output. We need to emit `agent_tool_call` events as the specialist works. The Claude CLI with `--output-format stream-json` outputs JSON lines that include tool_use blocks.

- [ ] **Step 1: Update callSpecialist to use streaming spawn**

In `src/coordinator.ts`, find the `callSpecialist` function inside `buildCoordinatorDeps` (around line 630). Currently it calls `callClaude(prompt, { timeoutMs, allowedTools })` which buffers output.

Replace the `callClaude` call with a streaming approach that reads stdout line-by-line:

```typescript
// In buildCoordinatorDeps, replace the callSpecialist implementation:
callSpecialist: async (agent: string, task: string, context?: string, timeoutMs?: number) => {
  const { spawnClaudeStreaming } = await import("./claude-cli.ts");
  const { getAllowedToolsForCLI } = await import("./tool-access-control.ts");

  const registryTools = opts.registry?.getAgentTools(agent);
  const agentToolCategories = (registryTools && registryTools.length > 0)
    ? registryTools
    : (AGENT_TOOLS[agent] ?? AGENT_TOOLS["general"]);
  const allowedTools = getAllowedToolsForCLI(agentToolCategories, agent);

  const prompt = context ? `${task}\n\nContext:\n${context}` : task;
  const start = Date.now();
  const spawnId = `dsp_${Date.now().toString(36)}`;

  try {
    const output = await spawnClaudeStreaming(prompt, {
      timeoutMs,
      allowedTools,
      onToolUse: (toolName: string, toolInput: Record<string, unknown>) => {
        // Emit agent_tool_call event for monitor
        opts.sendEventFn?.({
          type: "agent_tool_call",
          spawnId,
          agent,
          tool: toolName,
          target: (toolInput.file_path || toolInput.command || toolInput.pattern || toolInput.query || "").toString().slice(0, 200),
          status: "running",
          ts: Date.now(),
        }).catch(() => {});
      },
      onToolResult: (toolName: string, durationMs: number) => {
        opts.sendEventFn?.({
          type: "agent_tool_call",
          spawnId,
          agent,
          tool: toolName,
          target: "",
          status: "done",
          duration_ms: durationMs,
          ts: Date.now(),
        }).catch(() => {});
      },
    });

    return {
      agent,
      status: "completed" as const,
      output,
      cost_usd: 0,
      tokens_used: 0,
      duration_ms: Date.now() - start,
    };
  } catch (err) {
    return {
      agent,
      status: "error" as const,
      output: "",
      error: err instanceof Error ? err.message : String(err),
      cost_usd: 0,
      tokens_used: 0,
      duration_ms: Date.now() - start,
    };
  }
},
```

- [ ] **Step 2: Add spawnClaudeStreaming to claude-cli.ts**

In `src/claude-cli.ts`, add a new export that streams stdout:

```typescript
export async function spawnClaudeStreaming(
  prompt: string,
  options: {
    timeoutMs?: number;
    allowedTools?: string[];
    onToolUse?: (toolName: string, toolInput: Record<string, unknown>) => void;
    onToolResult?: (toolName: string, durationMs: number) => void;
  },
): Promise<string> {
  const args = [CLAUDE_PATH, "-p", "--output-format", "stream-json"];

  if (AGENT_MODE) {
    const tools = options.allowedTools?.length ? options.allowedTools : ALLOWED_TOOLS;
    args.push("--allowedTools", ...tools);
  }

  const timeoutMs = options.timeoutMs ?? CLI_TIMEOUT_MS;
  const proc = spawn(args, {
    stdin: new Blob([prompt]),
    stdout: "pipe",
    stderr: "pipe",
    cwd: PROJECT_DIR || undefined,
    env: { ...process.env, CLAUDECODE: "" },
  });

  let output = "";
  const decoder = new TextDecoder();
  let toolStartTimes = new Map<string, number>();

  // Set up timeout
  const timeoutId = setTimeout(() => proc.kill(), timeoutMs);

  try {
    // Read stdout line by line
    for await (const chunk of proc.stdout) {
      const text = decoder.decode(chunk);
      output += text;

      // Try to parse JSON lines for tool_use events
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use") {
            const toolName = parsed.content_block.name;
            toolStartTimes.set(parsed.index?.toString() ?? toolName, Date.now());
            options.onToolUse?.(toolName, parsed.content_block.input ?? {});
          }
          if (parsed.type === "content_block_stop" && toolStartTimes.size > 0) {
            const key = parsed.index?.toString() ?? "";
            const startTime = toolStartTimes.get(key);
            if (startTime) {
              options.onToolResult?.("tool", Date.now() - startTime);
              toolStartTimes.delete(key);
            }
          }
        } catch {
          // Not valid JSON — ignore
        }
      }
    }

    clearTimeout(timeoutId);
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Claude CLI exited with code ${exitCode}: ${stderr.slice(0, 500)}`);
    }

    // Extract the final text result from the stream-json output
    // stream-json wraps the result — extract the last text content block
    try {
      const lines = output.split("\n").filter(l => l.trim());
      const resultLine = lines.find(l => l.includes('"type":"result"'));
      if (resultLine) {
        const parsed = JSON.parse(resultLine);
        return parsed.result ?? output;
      }
    } catch {}

    return output;
  } catch (err) {
    clearTimeout(timeoutId);
    try { proc.kill(); } catch {}
    throw err;
  }
}
```

Note: The exact stream-json format from Claude CLI may differ. The `onToolUse` / `onToolResult` callbacks are best-effort — if parsing fails, the monitor just doesn't show live tool calls (falls back to start/finish only).

- [ ] **Step 3: Verify relay tests pass**

Run: `cd /home/ellie/ellie-dev && bun test tests/coordinator.test.ts tests/coordinator-cost-cap.test.ts`
Expected: All pass (streaming is only used in production, tests use `_testResponses`)

- [ ] **Step 4: Commit**

```bash
cd /home/ellie/ellie-dev && git add src/coordinator.ts src/claude-cli.ts && git commit -m "[ELLIE-1099] feat: stream specialist tool calls as WebSocket events"
```

---

### Task 2: Agent Monitor Composable

**Files:**
- Create: `/home/ellie/ellie-home/app/composables/useAgentMonitor.ts`

- [ ] **Step 1: Create the composable**

```typescript
// app/composables/useAgentMonitor.ts

export interface ToolFeedEntry {
  tool: string;
  target: string;
  status: "running" | "done";
  duration_ms?: number;
  ts: number;
}

export interface AgentMonitorState {
  id: string;
  agent: string;
  task: string;
  status: "running" | "completed" | "failed";
  phase: "dispatched" | "reading" | "editing" | "testing" | "complete";
  progress: number;
  startedAt: number;
  completedAt?: number;
  durationSec?: number;
  toolFeed: ToolFeedEntry[];
  filesTouched: string[];
  tests?: { pass: number; fail: number };
  resultPreview?: string;
  error?: string;
}

const agents = ref<AgentMonitorState[]>([]);
const isExpanded = ref(false);
const activeTab = ref<string | null>(null);

const activeAgents = computed(() => agents.value.filter(a => a.status === "running"));
const hasActivity = computed(() => agents.value.length > 0);

function handleSpawnStatus(msg: { spawnId: string; agent: string; task: string; status: string; ts: number }) {
  const existing = agents.value.find(a => a.id === msg.spawnId);
  if (existing) {
    existing.status = "running";
    return;
  }
  agents.value.push({
    id: msg.spawnId,
    agent: msg.agent,
    task: msg.task,
    status: "running",
    phase: "dispatched",
    progress: 5,
    startedAt: msg.ts,
    toolFeed: [],
    filesTouched: [],
  });
  // Auto-select first tab
  if (!activeTab.value) activeTab.value = msg.spawnId;
}

function handleToolCall(msg: { spawnId: string; agent: string; tool: string; target: string; status: string; duration_ms?: number; ts: number }) {
  const agentState = agents.value.find(a => a.id === msg.spawnId);
  if (!agentState) return;

  if (msg.status === "running") {
    agentState.toolFeed.push({
      tool: msg.tool,
      target: msg.target,
      status: "running",
      ts: msg.ts,
    });
    // Keep feed to last 50 entries
    if (agentState.toolFeed.length > 50) agentState.toolFeed.splice(0, agentState.toolFeed.length - 50);

    // Update phase from tool name
    if (["Read", "Grep", "Glob", "WebSearch", "WebFetch"].includes(msg.tool)) {
      agentState.phase = "reading";
    } else if (["Edit", "Write"].includes(msg.tool)) {
      agentState.phase = "editing";
    } else if (msg.tool === "Bash" && msg.target.includes("test")) {
      agentState.phase = "testing";
    }

    // Track files
    if (msg.target && !agentState.filesTouched.includes(msg.target)) {
      agentState.filesTouched.push(msg.target);
    }
  } else if (msg.status === "done") {
    // Update last matching running entry
    const lastRunning = [...agentState.toolFeed].reverse().find(t => t.status === "running");
    if (lastRunning) {
      lastRunning.status = "done";
      lastRunning.duration_ms = msg.duration_ms;
    }
  }

  // Update progress (heuristic: 10-80% based on tool call count)
  const totalCalls = agentState.toolFeed.length;
  agentState.progress = Math.min(80, 10 + totalCalls * 5);
  if (agentState.phase === "testing") agentState.progress = Math.max(agentState.progress, 80);
}

function handleProgress(msg: { spawnId: string; agent: string; files_touched?: string[]; tests?: { pass: number; fail: number }; phase?: string; ts: number }) {
  const agentState = agents.value.find(a => a.id === msg.spawnId);
  if (!agentState) return;

  if (msg.files_touched) agentState.filesTouched = msg.files_touched;
  if (msg.tests) agentState.tests = msg.tests;
  if (msg.phase) agentState.phase = msg.phase as AgentMonitorState["phase"];
}

function handleSpawnAnnouncement(msg: { spawnId: string; agent: string; status: string; durationSec?: number; resultPreview?: string; error?: string; ts: number }) {
  const agentState = agents.value.find(a => a.id === msg.spawnId);
  if (!agentState) {
    // Create entry for agents we missed the spawn_status for
    agents.value.push({
      id: msg.spawnId,
      agent: msg.agent,
      task: "",
      status: msg.status === "completed" ? "completed" : "failed",
      phase: "complete",
      progress: 100,
      startedAt: msg.ts - (msg.durationSec ?? 0) * 1000,
      completedAt: msg.ts,
      durationSec: msg.durationSec,
      toolFeed: [],
      filesTouched: [],
      resultPreview: msg.resultPreview,
      error: msg.error ?? undefined,
    });
    return;
  }

  agentState.status = msg.status === "completed" ? "completed" : "failed";
  agentState.phase = "complete";
  agentState.progress = 100;
  agentState.completedAt = msg.ts;
  agentState.durationSec = msg.durationSec;
  agentState.resultPreview = msg.resultPreview;
  agentState.error = msg.error ?? undefined;
}

function toggleExpanded() {
  isExpanded.value = !isExpanded.value;
}

function selectTab(spawnId: string) {
  activeTab.value = spawnId;
  if (!isExpanded.value) isExpanded.value = true;
}

function dismissAgent(spawnId: string) {
  const idx = agents.value.findIndex(a => a.id === spawnId);
  if (idx >= 0) agents.value.splice(idx, 1);
  if (activeTab.value === spawnId) {
    activeTab.value = agents.value[0]?.id ?? null;
  }
  if (agents.value.length === 0) isExpanded.value = false;
}

function dismissAll() {
  agents.value = agents.value.filter(a => a.status === "running");
  if (agents.value.length === 0) {
    isExpanded.value = false;
    activeTab.value = null;
  } else {
    activeTab.value = agents.value[0]?.id ?? null;
  }
}

export function useAgentMonitor() {
  return {
    agents,
    activeAgents,
    hasActivity,
    isExpanded,
    activeTab,
    handleSpawnStatus,
    handleToolCall,
    handleProgress,
    handleSpawnAnnouncement,
    toggleExpanded,
    selectTab,
    dismissAgent,
    dismissAll,
  };
}
```

- [ ] **Step 2: Commit**

```bash
cd /home/ellie/ellie-home && git add app/composables/useAgentMonitor.ts && git commit -m "feat: add useAgentMonitor composable for agent activity tracking"
```

---

### Task 3: Agent Monitor Panel Component

**Files:**
- Create: `/home/ellie/ellie-home/app/components/ellie/AgentMonitorPanel.vue`

- [ ] **Step 1: Create the component**

```vue
<!-- app/components/ellie/AgentMonitorPanel.vue -->
<script setup lang="ts">
const { agents, activeAgents, hasActivity, isExpanded, activeTab, toggleExpanded, selectTab, dismissAgent, dismissAll } = useAgentMonitor();
const { getColor, getDisplayName, getInitial } = useAgentProfiles();

const selectedAgent = computed(() => {
  if (!activeTab.value) return null;
  return agents.value.find(a => a.id === activeTab.value) ?? null;
});

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function toolIcon(tool: string): string {
  const icons: Record<string, string> = {
    Read: "📖", Edit: "✏️", Write: "📝", Bash: "⚡", Grep: "🔍",
    Glob: "📂", WebSearch: "🌐", WebFetch: "🌐",
  };
  return icons[tool] || "🔧";
}

function statusColor(status: string): string {
  if (status === "done") return "color: rgb(134 239 172)";
  if (status === "running") return "color: rgb(147 197 253)";
  return "color: rgb(156 163 175)";
}

// Auto-scroll feed
const feedRef = ref<HTMLElement | null>(null);
watch(() => selectedAgent.value?.toolFeed.length, () => {
  nextTick(() => {
    if (feedRef.value) feedRef.value.scrollTop = feedRef.value.scrollHeight;
  });
});
</script>

<template>
  <div v-if="hasActivity">
    <!-- Collapsed Bar -->
    <div
      class="flex items-center gap-3 px-4 py-1.5 cursor-pointer border-b border-white/[0.08] bg-black/30 select-none"
      @click="toggleExpanded"
    >
      <!-- Agent Avatars with Progress Bars -->
      <div class="flex gap-2 items-center">
        <div
          v-for="agent in agents"
          :key="agent.id"
          class="relative cursor-pointer"
          @click.stop="selectTab(agent.id)"
        >
          <div
            class="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white"
            :style="{ backgroundColor: agent.status === 'completed' ? 'transparent' : getColor(agent.agent), border: agent.status === 'completed' ? `2px solid rgb(16 185 129)` : agent.status === 'failed' ? '2px solid rgb(239 68 68)' : 'none' }"
          >
            <span v-if="agent.status === 'completed'" style="color: rgb(16 185 129)">✓</span>
            <span v-else-if="agent.status === 'failed'" style="color: rgb(239 68 68)">✕</span>
            <span v-else>{{ getInitial(agent.agent) }}</span>
          </div>
          <!-- Progress bar under avatar -->
          <div v-if="agent.status === 'running'" class="absolute -bottom-1 left-0.5 right-0.5 h-[3px] rounded-full bg-white/10 overflow-hidden">
            <div class="h-full rounded-full transition-all duration-500" :style="{ width: agent.progress + '%', backgroundColor: getColor(agent.agent) }" />
          </div>
        </div>
      </div>

      <!-- Expand/collapse indicator -->
      <span class="ml-auto text-xs text-white/30">{{ isExpanded ? '▲' : '▼' }}</span>
    </div>

    <!-- Expanded Panel -->
    <div v-if="isExpanded" class="border-b border-white/[0.08] bg-black/30" style="max-height: min(40vh, 300px); display: flex; flex-direction: column;">
      <!-- Tab Row -->
      <div class="flex items-center border-b border-white/[0.06] px-2">
        <div
          v-for="agent in agents"
          :key="agent.id"
          class="flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer border-b-2 transition-colors"
          :class="activeTab === agent.id ? 'border-current' : 'border-transparent opacity-50 hover:opacity-75'"
          :style="{ color: getColor(agent.agent) }"
          @click="selectTab(agent.id)"
        >
          <span class="w-1.5 h-1.5 rounded-full" :class="agent.status === 'running' ? 'animate-pulse' : ''" :style="{ backgroundColor: agent.status === 'completed' ? 'rgb(16 185 129)' : agent.status === 'failed' ? 'rgb(239 68 68)' : getColor(agent.agent) }" />
          {{ getDisplayName(agent.agent) }}
        </div>
        <!-- Dismiss all completed button -->
        <button
          v-if="agents.some(a => a.status !== 'running')"
          class="ml-auto text-[10px] text-white/30 hover:text-white/60 px-2 py-1"
          @click.stop="dismissAll"
        >clear done</button>
      </div>

      <!-- Selected Agent Content -->
      <div v-if="selectedAgent" class="flex flex-1 min-h-0 overflow-hidden">
        <!-- Summary Card (left 45%) -->
        <div class="w-[45%] p-3 border-r border-white/[0.06] overflow-y-auto text-xs">
          <!-- Task -->
          <div class="mb-2.5">
            <div class="uppercase text-[10px] tracking-wider text-white/30 mb-0.5">Task</div>
            <div class="text-white/80">{{ selectedAgent.task || 'Working...' }}</div>
          </div>
          <!-- Phase -->
          <div class="mb-2.5">
            <div class="uppercase text-[10px] tracking-wider text-white/30 mb-0.5">Phase</div>
            <div>
              <span class="px-1.5 py-0.5 rounded text-[10px] font-medium"
                :class="{
                  'bg-blue-500/20 text-blue-300': selectedAgent.phase === 'reading',
                  'bg-amber-500/20 text-amber-300': selectedAgent.phase === 'editing',
                  'bg-purple-500/20 text-purple-300': selectedAgent.phase === 'testing',
                  'bg-emerald-500/20 text-emerald-300': selectedAgent.phase === 'complete',
                  'bg-white/10 text-white/50': selectedAgent.phase === 'dispatched',
                }">{{ selectedAgent.phase }}</span>
            </div>
          </div>
          <!-- Files -->
          <div v-if="selectedAgent.filesTouched.length" class="mb-2.5">
            <div class="uppercase text-[10px] tracking-wider text-white/30 mb-0.5">Files</div>
            <div class="font-mono text-[11px] text-white/60">
              <div v-for="f in selectedAgent.filesTouched.slice(-5)" :key="f">{{ f.split('/').pop() }}</div>
              <div v-if="selectedAgent.filesTouched.length > 5" class="text-white/30">+{{ selectedAgent.filesTouched.length - 5 }} more</div>
            </div>
          </div>
          <!-- Tests -->
          <div v-if="selectedAgent.tests" class="mb-2.5">
            <div class="uppercase text-[10px] tracking-wider text-white/30 mb-0.5">Tests</div>
            <div>
              <span class="text-emerald-400">{{ selectedAgent.tests.pass }} pass</span>
              <span class="text-white/20 mx-1">·</span>
              <span :class="selectedAgent.tests.fail > 0 ? 'text-red-400' : 'text-white/40'">{{ selectedAgent.tests.fail }} fail</span>
            </div>
          </div>
          <!-- Duration -->
          <div class="mb-2.5">
            <div class="uppercase text-[10px] tracking-wider text-white/30 mb-0.5">Duration</div>
            <div class="text-white/60">{{ selectedAgent.durationSec ? formatDuration(selectedAgent.durationSec * 1000) : formatDuration(Date.now() - selectedAgent.startedAt) }}</div>
          </div>
          <!-- Result / Error (when complete) -->
          <div v-if="selectedAgent.resultPreview" class="mb-2.5">
            <div class="uppercase text-[10px] tracking-wider text-white/30 mb-0.5">Result</div>
            <div class="text-white/60 text-[11px]">{{ selectedAgent.resultPreview.slice(0, 200) }}</div>
          </div>
          <div v-if="selectedAgent.error">
            <div class="uppercase text-[10px] tracking-wider text-white/30 mb-0.5">Error</div>
            <div class="text-red-400 text-[11px]">{{ selectedAgent.error }}</div>
          </div>
          <!-- Dismiss -->
          <button
            v-if="selectedAgent.status !== 'running'"
            class="mt-2 text-[10px] text-white/30 hover:text-white/60 border border-white/10 rounded px-2 py-0.5"
            @click="dismissAgent(selectedAgent.id)"
          >dismiss</button>
        </div>

        <!-- Tool Feed (right 55%) -->
        <div ref="feedRef" class="flex-1 p-2 overflow-y-auto font-mono text-[11px] leading-relaxed">
          <div v-if="selectedAgent.toolFeed.length === 0" class="text-white/20 text-center py-4">
            Waiting for activity...
          </div>
          <div v-for="(entry, i) in selectedAgent.toolFeed" :key="i" :style="statusColor(entry.status)">
            <span>{{ entry.status === 'done' ? '✓' : '▸' }}</span>
            {{ toolIcon(entry.tool) }}
            {{ entry.tool }}
            <span v-if="entry.target" class="text-white/40">{{ entry.target.split('/').pop() || entry.target }}</span>
            <span v-if="entry.duration_ms" class="text-white/20 text-[10px] ml-1">{{ entry.duration_ms }}ms</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Commit**

```bash
cd /home/ellie/ellie-home && git add app/components/ellie/AgentMonitorPanel.vue && git commit -m "feat: add AgentMonitorPanel component — pull-down bar with tabs"
```

---

### Task 4: Wire Events + Mount Panel + Remove Sidebar

**Files:**
- Modify: `/home/ellie/ellie-home/app/composables/useEllieChat.ts`
- Modify: `/home/ellie/ellie-home/app/pages/ellie-chat.vue`

- [ ] **Step 1: Route new events in useEllieChat.ts**

In `app/composables/useEllieChat.ts`, find the `spawn_status` handler (around line 359). Add routing to useAgentMonitor BEFORE the existing handlers. Add these blocks before the existing `spawn_status` if-block:

```typescript
// Agent monitor events — route to useAgentMonitor
if (msg.type === 'agent_tool_call') {
  const { handleToolCall } = useAgentMonitor();
  handleToolCall(msg);
  return;
}

if (msg.type === 'agent_progress') {
  const { handleProgress } = useAgentMonitor();
  handleProgress(msg);
  return;
}
```

Then update the existing `spawn_status` and `spawn_announcement` handlers to ALSO notify the monitor:

After the existing `spawn_status` handler's `return`, add before the return:
```typescript
// Also notify agent monitor
const { handleSpawnStatus } = useAgentMonitor();
handleSpawnStatus(msg);
```

After the existing `spawn_announcement` handler, add before the return:
```typescript
// Also notify agent monitor
const { handleSpawnAnnouncement } = useAgentMonitor();
handleSpawnAnnouncement(msg);
```

- [ ] **Step 2: Mount AgentMonitorPanel in ellie-chat.vue**

In `app/pages/ellie-chat.vue`, find the main chat area div (around line 33):
```html
<div class="flex flex-col flex-1 min-w-0 relative pl-4">
```

Add the monitor panel as the FIRST child inside this div:
```html
<div class="flex flex-col flex-1 min-w-0 relative pl-4">
  <!-- Agent Monitor Panel — pull-down from top -->
  <EllieAgentMonitorPanel />

  <!-- existing header, chat thread, input bar... -->
```

- [ ] **Step 3: Remove ChannelSidebar from ellie-chat.vue**

Find and remove these sections:
1. The sidebar overlay div (around line 5-6): `<div v-if="showSidebar" class="fixed inset-0 bg-black/40 z-20 md:hidden" ...`
2. The sidebar container div (around line 9-12): `<div v-if="showSidebar" class="fixed left-0 ... ><EllieChannelSidebar ...`
3. The sidebar toggle button: `<button @click="showSidebar = !showSidebar" ...`
4. The `showSidebar` ref in the script section
5. The `pl-4` on the main chat area can become `px-4` (equal padding both sides now)

Do NOT delete the `ChannelSidebar.vue` component file itself yet — just remove it from the page. It can be cleaned up later.

- [ ] **Step 4: Build and verify**

```bash
cd /home/ellie/ellie-home && bun run build
```

Check for any build errors. The component should auto-import.

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-home && git add app/composables/useEllieChat.ts app/pages/ellie-chat.vue && git commit -m "feat: mount agent monitor, route events, remove channel sidebar"
```

---

### Task 5: End-to-End Validation

- [ ] **Step 1: Restart relay**

```bash
systemctl --user restart claude-telegram-relay
```

- [ ] **Step 2: Rebuild dashboard**

```bash
cd /home/ellie/ellie-home && bun run build && sudo systemctl restart ellie-dashboard
```

- [ ] **Step 3: Test — dispatch an agent**

Open Ellie Chat. Send: "Have James check the relay health"

Expected:
- Monitor bar appears at top with James avatar + progress bar
- Click to expand — see summary card (task, phase) + tool feed (entries appearing)
- When James completes — tab turns green, result preview shown
- Dismiss button clears the tab

- [ ] **Step 4: Test — multiple agents**

Send: "Have James review the code and get Brian to critique it"

Expected: Two tabs appear. Both show progress independently.

- [ ] **Step 5: Test — no agents**

Send: "Hey Ellie how's it going?"

Expected: Monitor bar stays hidden. No agents dispatched.

---

## Summary

| Task | What It Builds | Repo | Files |
|------|---------------|------|-------|
| 1 | Stream tool_call events from specialist CLI | ellie-dev | coordinator.ts, claude-cli.ts |
| 2 | Agent monitor composable (state tracking) | ellie-home | useAgentMonitor.ts |
| 3 | Agent monitor panel component (UI) | ellie-home | AgentMonitorPanel.vue |
| 4 | Wire events + mount panel + remove sidebar | ellie-home | useEllieChat.ts, ellie-chat.vue |
| 5 | End-to-end validation | both | manual testing |

**Total:** 2 new files (dashboard), 2 modified files (dashboard), 2 modified files (relay), 5 commits.
