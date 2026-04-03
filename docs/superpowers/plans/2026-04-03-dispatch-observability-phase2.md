# Dispatch Observability Phase 2: Dispatch Cards in Ellie Chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show dispatch activity in Ellie Chat as compact inline indicators in the message stream + a collapsible side panel with full dispatch cards, updated live via WebSocket.

**Architecture:** A new `useDispatchCards` composable manages reactive card state from `dispatch_event` WebSocket messages (Phase 1). Inline indicators slot into the chat message stream. A collapsible side panel shows full cards. Both update in-place as events arrive — no page refresh.

**Tech Stack:** Vue 3 (Nuxt 4), Tailwind CSS (v4, classes only), WebSocket (`dispatch_event` from Phase 1), TypeScript

**Spec:** `docs/superpowers/specs/2026-04-03-dispatch-observability-design.md` — Phase 2 section

**Depends on:** Phase 1 (unified `dispatch_event` WebSocket messages)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `ellie-home/app/composables/useDispatchCards.ts` | Create | Reactive card state from WebSocket events |
| `ellie-home/app/components/dispatch/DispatchInlineIndicator.vue` | Create | Compact status line in chat stream |
| `ellie-home/app/components/dispatch/DispatchSidePanel.vue` | Create | Collapsible right panel with cards |
| `ellie-home/app/components/dispatch/DispatchCard.vue` | Create | Individual card in panel |
| `ellie-home/app/pages/ellie-chat.vue` | Modify | Integrate inline indicators + side panel |
| `ellie-home/app/composables/useEllieChat.ts` | Modify | Handle `dispatch_event` WebSocket messages |

---

### Task 1: useDispatchCards composable

**Files:**
- Create: `ellie-home/app/composables/useDispatchCards.ts`

- [ ] **Step 1: Create the composable**

Create `/home/ellie/ellie-home/app/composables/useDispatchCards.ts`:

```typescript
/**
 * useDispatchCards — reactive dispatch card state from WebSocket events
 * ELLIE-1312, 1314
 *
 * Manages a Map of dispatch cards keyed by run_id. Updated by dispatch_event
 * messages from the relay WebSocket. Cards track status, progress, timing.
 */

import { ref, computed } from 'vue'

export type DispatchCardStatus = 'dispatched' | 'in_progress' | 'done' | 'failed' | 'stalled' | 'cancelled'

export interface DispatchCard {
  run_id: string
  agent: string
  title: string
  work_item_id: string | null
  dispatch_type: string
  status: DispatchCardStatus
  progress_line: string | null
  started_at: number
  completed_at: number | null
  duration_ms: number | null
  cost_usd: number | null
}

// Module-level state — singleton, survives page navigation
const cards = ref<Map<string, DispatchCard>>(new Map())
const focusedRunId = ref<string | null>(null)
const panelOpen = ref(false)

// Computed
const activeCards = computed(() =>
  Array.from(cards.value.values())
    .filter(c => c.status === 'dispatched' || c.status === 'in_progress' || c.status === 'stalled')
    .sort((a, b) => b.started_at - a.started_at)
)

const completedCards = computed(() =>
  Array.from(cards.value.values())
    .filter(c => c.status === 'done' || c.status === 'failed' || c.status === 'cancelled')
    .sort((a, b) => (b.completed_at ?? b.started_at) - (a.completed_at ?? a.started_at))
)

const allCards = computed(() =>
  [...activeCards.value, ...completedCards.value]
)

const activeCount = computed(() => activeCards.value.length)
const needsAttention = computed(() =>
  Array.from(cards.value.values()).filter(c => c.status === 'stalled' || c.status === 'failed').length
)

/**
 * Handle a dispatch_event WebSocket message. Creates or updates a card.
 */
function handleDispatchEvent(msg: {
  run_id: string
  event_type: string
  agent: string
  title: string
  work_item_id?: string | null
  progress_line?: string | null
  dispatch_type?: string
  status: DispatchCardStatus
  timestamp: number
  duration_ms?: number
  cost_usd?: number
}) {
  const existing = cards.value.get(msg.run_id)

  if (existing) {
    // Update in place
    existing.status = msg.status
    if (msg.progress_line) existing.progress_line = msg.progress_line
    if (msg.duration_ms != null) existing.duration_ms = msg.duration_ms
    if (msg.cost_usd != null) existing.cost_usd = msg.cost_usd
    if (msg.status === 'done' || msg.status === 'failed' || msg.status === 'cancelled') {
      existing.completed_at = msg.timestamp
    }
    // Trigger reactivity
    cards.value = new Map(cards.value)
  } else {
    // Create new card
    const card: DispatchCard = {
      run_id: msg.run_id,
      agent: msg.agent,
      title: msg.title,
      work_item_id: msg.work_item_id ?? null,
      dispatch_type: msg.dispatch_type ?? 'single',
      status: msg.status,
      progress_line: msg.progress_line ?? null,
      started_at: msg.timestamp,
      completed_at: null,
      duration_ms: null,
      cost_usd: null,
    }
    cards.value.set(msg.run_id, card)
    cards.value = new Map(cards.value)
  }
}

function focusCard(runId: string) {
  focusedRunId.value = runId
  panelOpen.value = true
}

function togglePanel() {
  panelOpen.value = !panelOpen.value
}

function clearCompleted() {
  for (const [id, card] of cards.value) {
    if (card.status === 'done' || card.status === 'failed' || card.status === 'cancelled') {
      cards.value.delete(id)
    }
  }
  cards.value = new Map(cards.value)
}

export function useDispatchCards() {
  return {
    cards,
    activeCards,
    completedCards,
    allCards,
    activeCount,
    needsAttention,
    focusedRunId,
    panelOpen,
    handleDispatchEvent,
    focusCard,
    togglePanel,
    clearCompleted,
  }
}
```

- [ ] **Step 2: Commit**

```bash
cd /home/ellie/ellie-home
git add app/composables/useDispatchCards.ts
git commit -m "[DISPATCH-P2] feat: useDispatchCards composable for reactive card state (ELLIE-1312)"
```

---

### Task 2: Wire dispatch_event into useEllieChat

**Files:**
- Modify: `ellie-home/app/composables/useEllieChat.ts`

- [ ] **Step 1: Read useEllieChat.ts to find the WebSocket message handler**

Read `/home/ellie/ellie-home/app/composables/useEllieChat.ts` and find the `ws.onmessage` handler (around line 167). Look for the switch/if-else that handles different message types (`spawn_status`, `spawn_announcement`, `agent_tool_call`, etc.).

- [ ] **Step 2: Add dispatch_event handler**

In the WebSocket message handler, find where `spawn_status` is handled (around line 380). Add a new case BEFORE the `spawn_status` handler for `dispatch_event`:

```typescript
      // Unified dispatch event (ELLIE-1308) — update dispatch cards
      if (msg.type === 'dispatch_event') {
        const { handleDispatchEvent } = useDispatchCards()
        handleDispatchEvent(msg)
        // Don't return — fall through so spawn_status/announcement still work
        // for backward compatibility with the existing agent monitor
      }
```

Import at the top of the file:
```typescript
import { useDispatchCards } from './useDispatchCards'
```

- [ ] **Step 3: Commit**

```bash
cd /home/ellie/ellie-home
git add app/composables/useEllieChat.ts
git commit -m "[DISPATCH-P2] feat: wire dispatch_event WebSocket messages to card state (ELLIE-1314)"
```

---

### Task 3: DispatchInlineIndicator component

**Files:**
- Create: `ellie-home/app/components/dispatch/DispatchInlineIndicator.vue`

- [ ] **Step 1: Create the component**

Create `/home/ellie/ellie-home/app/components/dispatch/DispatchInlineIndicator.vue`:

```vue
<template>
  <div
    class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs cursor-pointer transition-colors"
    :class="statusClasses"
    @click="$emit('focus', card.run_id)"
  >
    <!-- Status dot -->
    <span class="relative flex h-2 w-2">
      <span
        v-if="card.status === 'in_progress' || card.status === 'dispatched'"
        class="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
        :class="dotPingClass"
      />
      <span class="relative inline-flex rounded-full h-2 w-2" :class="dotClass" />
    </span>

    <!-- Agent + task -->
    <span class="font-medium" :style="{ color: agentColor }">{{ agentName }}</span>
    <span class="text-gray-400">
      {{ card.status === 'done' ? 'finished' : card.status === 'failed' ? 'failed' : 'is working on' }}
    </span>
    <span v-if="card.work_item_id" class="text-gray-300 font-mono">{{ card.work_item_id }}</span>

    <!-- Progress line -->
    <span v-if="card.progress_line" class="text-gray-500 truncate max-w-[200px]">
      — {{ card.progress_line }}
    </span>

    <!-- Elapsed time -->
    <span class="text-gray-600 ml-auto tabular-nums">{{ elapsed }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { DispatchCard } from '~/composables/useDispatchCards'

const props = defineProps<{
  card: DispatchCard
  agentColor: string
  agentName: string
}>()

defineEmits<{
  focus: [runId: string]
}>()

const statusClasses = computed(() => {
  switch (props.card.status) {
    case 'dispatched':
    case 'in_progress':
      return 'border border-amber-800/50 bg-amber-900/10'
    case 'done':
      return 'border border-emerald-800/50 bg-emerald-900/10'
    case 'failed':
      return 'border border-red-800/50 bg-red-900/10'
    case 'stalled':
      return 'border border-amber-800/50 bg-amber-900/20'
    case 'cancelled':
      return 'border border-gray-800/50 bg-gray-900/10'
    default:
      return 'border border-gray-800/50 bg-gray-900/10'
  }
})

const dotClass = computed(() => {
  switch (props.card.status) {
    case 'dispatched': return 'bg-blue-400'
    case 'in_progress': return 'bg-amber-400'
    case 'done': return 'bg-emerald-400'
    case 'failed': return 'bg-red-400'
    case 'stalled': return 'bg-amber-400'
    case 'cancelled': return 'bg-gray-400'
    default: return 'bg-gray-400'
  }
})

const dotPingClass = computed(() => {
  switch (props.card.status) {
    case 'dispatched': return 'bg-blue-400'
    case 'in_progress': return 'bg-amber-400'
    default: return ''
  }
})

const elapsed = computed(() => {
  const ms = props.card.duration_ms ?? (Date.now() - props.card.started_at)
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const remSec = sec % 60
  return `${min}m ${remSec}s`
})
</script>
```

- [ ] **Step 2: Commit**

```bash
cd /home/ellie/ellie-home
git add app/components/dispatch/DispatchInlineIndicator.vue
git commit -m "[DISPATCH-P2] feat: DispatchInlineIndicator component for chat stream (ELLIE-1312)"
```

---

### Task 4: DispatchCard component for side panel

**Files:**
- Create: `ellie-home/app/components/dispatch/DispatchCard.vue`

- [ ] **Step 1: Create the component**

Create `/home/ellie/ellie-home/app/components/dispatch/DispatchCard.vue`:

```vue
<template>
  <div
    class="rounded-lg border p-3 transition-all"
    :class="[
      cardClasses,
      isFocused ? 'ring-1 ring-cyan-500/50' : '',
    ]"
    :style="{ borderLeftColor: agentColor, borderLeftWidth: '3px' }"
  >
    <!-- Header: agent + status -->
    <div class="flex items-center justify-between mb-1">
      <div class="flex items-center gap-2">
        <!-- Agent avatar circle -->
        <div
          class="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white"
          :style="{ backgroundColor: agentColor }"
        >
          {{ agentInitial }}
        </div>
        <span class="text-sm font-medium text-gray-200">{{ agentName }}</span>
      </div>
      <!-- Status badge -->
      <span class="text-xs px-2 py-0.5 rounded-full" :class="badgeClasses">
        {{ badgeLabel }}
      </span>
    </div>

    <!-- Title -->
    <p class="text-xs text-gray-300 mb-1 line-clamp-2">{{ card.title }}</p>

    <!-- Work item link -->
    <a
      v-if="card.work_item_id"
      :href="`https://plane.ellie-labs.dev/evelife/projects/7194ace4-b80e-4c83-8042-c925598accf2/issues/?search=${card.work_item_id}`"
      target="_blank"
      class="text-xs text-cyan-400 hover:text-cyan-300 font-mono"
    >
      {{ card.work_item_id }}
    </a>

    <!-- Progress line -->
    <p v-if="card.progress_line" class="text-xs text-gray-500 mt-1 truncate">
      {{ card.progress_line }}
    </p>

    <!-- Footer: elapsed + cost -->
    <div class="flex items-center justify-between mt-2 text-xs text-gray-600">
      <span class="tabular-nums">{{ elapsed }}</span>
      <span v-if="card.cost_usd != null" class="tabular-nums">${{ card.cost_usd.toFixed(2) }}</span>
    </div>

    <!-- Expand button for drill-down (Phase 4) -->
    <button
      v-if="card.status === 'done' || card.status === 'failed'"
      class="mt-2 w-full text-xs text-gray-500 hover:text-gray-300 text-center py-1 border-t border-gray-800"
      @click="$emit('expand', card.run_id)"
    >
      Details
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { DispatchCard as DispatchCardType } from '~/composables/useDispatchCards'

const props = defineProps<{
  card: DispatchCardType
  agentColor: string
  agentName: string
  agentInitial: string
  isFocused?: boolean
}>()

defineEmits<{
  expand: [runId: string]
}>()

const cardClasses = computed(() => {
  switch (props.card.status) {
    case 'dispatched':
    case 'in_progress':
      return 'border-gray-700 bg-gray-800/50'
    case 'done':
      return 'border-gray-700/50 bg-gray-800/30'
    case 'failed':
      return 'border-red-900/50 bg-red-900/10'
    case 'stalled':
      return 'border-amber-900/50 bg-amber-900/10'
    case 'cancelled':
      return 'border-gray-800 bg-gray-900/30 opacity-60'
    default:
      return 'border-gray-700 bg-gray-800/50'
  }
})

const badgeClasses = computed(() => {
  switch (props.card.status) {
    case 'dispatched': return 'bg-blue-900/50 text-blue-400'
    case 'in_progress': return 'bg-amber-900/50 text-amber-400'
    case 'done': return 'bg-emerald-900/50 text-emerald-400'
    case 'failed': return 'bg-red-900/50 text-red-400'
    case 'stalled': return 'bg-amber-900/50 text-amber-400'
    case 'cancelled': return 'bg-gray-800 text-gray-500'
    default: return 'bg-gray-800 text-gray-500'
  }
})

const badgeLabel = computed(() => {
  switch (props.card.status) {
    case 'dispatched': return 'Dispatched'
    case 'in_progress': return 'Working'
    case 'done': return 'Done'
    case 'failed': return 'Failed'
    case 'stalled': return 'Stalled'
    case 'cancelled': return 'Cancelled'
    default: return props.card.status
  }
})

const elapsed = computed(() => {
  const ms = props.card.duration_ms ?? (Date.now() - props.card.started_at)
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const remSec = sec % 60
  return `${min}m ${remSec}s`
})
</script>
```

- [ ] **Step 2: Commit**

```bash
cd /home/ellie/ellie-home
git add app/components/dispatch/DispatchCard.vue
git commit -m "[DISPATCH-P2] feat: DispatchCard component for side panel (ELLIE-1312)"
```

---

### Task 5: DispatchSidePanel component

**Files:**
- Create: `ellie-home/app/components/dispatch/DispatchSidePanel.vue`

- [ ] **Step 1: Create the component**

Create `/home/ellie/ellie-home/app/components/dispatch/DispatchSidePanel.vue`:

```vue
<template>
  <transition
    enter-active-class="transition-all duration-200 ease-out"
    leave-active-class="transition-all duration-150 ease-in"
    enter-from-class="translate-x-full opacity-0"
    enter-to-class="translate-x-0 opacity-100"
    leave-from-class="translate-x-0 opacity-100"
    leave-to-class="translate-x-full opacity-0"
  >
    <aside
      v-if="panelOpen"
      class="w-80 border-l border-gray-800 bg-gray-900 flex flex-col overflow-hidden"
    >
      <!-- Header -->
      <div class="flex items-center justify-between px-3 py-2 border-b border-gray-800">
        <div class="flex items-center gap-2">
          <h3 class="text-sm font-medium text-gray-200">Dispatches</h3>
          <span
            v-if="activeCount > 0"
            class="text-xs px-1.5 py-0.5 rounded-full bg-amber-900/50 text-amber-400 tabular-nums"
          >
            {{ activeCount }}
          </span>
          <span
            v-if="needsAttention > 0"
            class="text-xs px-1.5 py-0.5 rounded-full bg-red-900/50 text-red-400 tabular-nums"
          >
            {{ needsAttention }}
          </span>
        </div>
        <button
          class="text-gray-500 hover:text-gray-300 text-xs"
          @click="togglePanel"
        >
          Close
        </button>
      </div>

      <!-- Summary line -->
      <div v-if="allCards.length > 0" class="px-3 py-1.5 text-xs text-gray-500 border-b border-gray-800/50">
        {{ activeCount }} active, {{ completedCards.length }} completed
        <template v-if="needsAttention > 0">, {{ needsAttention }} need attention</template>
      </div>

      <!-- Card list -->
      <div class="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        <template v-if="allCards.length === 0">
          <p class="text-xs text-gray-600 text-center py-8">No dispatches yet</p>
        </template>

        <DispatchCard
          v-for="card in allCards"
          :key="card.run_id"
          :card="card"
          :agent-color="getColor(card.agent)"
          :agent-name="getDisplayName(card.agent)"
          :agent-initial="getInitial(card.agent)"
          :is-focused="card.run_id === focusedRunId"
          @expand="$emit('expand', $event)"
        />
      </div>

      <!-- Footer actions -->
      <div v-if="completedCards.length > 0" class="px-3 py-2 border-t border-gray-800">
        <button
          class="text-xs text-gray-500 hover:text-gray-300"
          @click="clearCompleted"
        >
          Clear completed
        </button>
      </div>
    </aside>
  </transition>
</template>

<script setup lang="ts">
import { useDispatchCards } from '~/composables/useDispatchCards'
import { useAgentProfiles } from '~/composables/useAgentProfiles'

const {
  allCards, activeCards, completedCards, activeCount, needsAttention,
  focusedRunId, panelOpen, togglePanel, clearCompleted,
} = useDispatchCards()

const { getColor, getDisplayName, getInitial } = useAgentProfiles()

defineEmits<{
  expand: [runId: string]
}>()
</script>
```

- [ ] **Step 2: Commit**

```bash
cd /home/ellie/ellie-home
git add app/components/dispatch/DispatchSidePanel.vue
git commit -m "[DISPATCH-P2] feat: DispatchSidePanel collapsible right panel (ELLIE-1312)"
```

---

### Task 6: Integrate into ellie-chat.vue

**Files:**
- Modify: `ellie-home/app/pages/ellie-chat.vue`

- [ ] **Step 1: Read ellie-chat.vue to understand the layout**

Read `/home/ellie/ellie-home/app/pages/ellie-chat.vue` — focus on:
- The outer container (line ~2, the `flex` div)
- Where messages render (lines ~82-263)
- The existing `EllieAgentMonitorPanel` (line ~6)

- [ ] **Step 2: Import composables and components**

In the `<script setup>` section, add:

```typescript
import { useDispatchCards } from '~/composables/useDispatchCards'
import { useAgentProfiles } from '~/composables/useAgentProfiles'

const { allCards, activeCount, panelOpen, focusCard, togglePanel } = useDispatchCards()
const { getColor, getDisplayName } = useAgentProfiles()
```

- [ ] **Step 3: Add the side panel to the layout**

The current outer container is a flex column. Wrap the chat container and the side panel in a flex row so the panel sits on the right:

Find the outer `<div class="flex ... h-[calc(100vh-5.5rem)]">` container. Inside it, after the chat messages container, add:

```vue
    <!-- Dispatch Side Panel -->
    <DispatchSidePanel @expand="handleDrillDown" />
```

Add a panel toggle button in the header area (near the existing buttons):

```vue
    <!-- Dispatch panel toggle -->
    <button
      v-if="allCards.length > 0"
      class="relative text-gray-400 hover:text-gray-200 text-sm px-2 py-1 rounded"
      @click="togglePanel"
    >
      Dispatches
      <span
        v-if="activeCount > 0"
        class="absolute -top-1 -right-1 w-4 h-4 text-xs bg-amber-500 text-white rounded-full flex items-center justify-center"
      >
        {{ activeCount }}
      </span>
    </button>
```

- [ ] **Step 4: Add inline indicators in the message stream**

In the message rendering loop, find where `spawn_status` system messages are rendered (lines ~87-102, the `v-if="msg.role === 'system' && msg.spawnId"` block). After that block, add inline indicators for dispatch cards:

```vue
    <!-- Dispatch inline indicator (ELLIE-1312) -->
    <template v-if="msg.role === 'system' && msg.dispatchRunId">
      <div class="flex justify-center w-full">
        <DispatchInlineIndicator
          :card="getCardForMessage(msg.dispatchRunId)"
          :agent-color="getColor(msg.agent || 'general')"
          :agent-name="getDisplayName(msg.agent || 'general')"
          @focus="focusCard"
          v-if="getCardForMessage(msg.dispatchRunId)"
        />
      </div>
    </template>
```

Add the helper function in the script:

```typescript
function getCardForMessage(runId: string) {
  const { cards } = useDispatchCards()
  return cards.value.get(runId) ?? null
}

function handleDrillDown(runId: string) {
  // Phase 4 placeholder — will open drill-down view
  console.log('Drill-down requested for', runId)
}
```

- [ ] **Step 5: Create dispatch messages when dispatch_event arrives**

In `useEllieChat.ts`, when a `dispatch_event` with `event_type === 'dispatched'` arrives, insert a system message into the chat stream with the `dispatchRunId` field:

Find where `spawn_status` creates a system message (around line 380-401). Add similar logic for `dispatch_event`:

```typescript
      if (msg.type === 'dispatch_event' && msg.event_type === 'dispatched') {
        // Insert inline indicator message
        const indicatorMsg: EllieChatMessage = {
          id: `dispatch-${msg.run_id}`,
          role: 'system',
          text: '',
          agent: msg.agent,
          ts: msg.timestamp || Date.now(),
          dispatchRunId: msg.run_id,
        }
        messages.value.push(indicatorMsg)
      }
```

This requires adding `dispatchRunId?: string` to the `EllieChatMessage` interface (around line 13-24).

- [ ] **Step 6: Build and verify**

```bash
cd /home/ellie/ellie-home && bun run build
```

Expected: Build succeeds with no type errors.

- [ ] **Step 7: Commit**

```bash
cd /home/ellie/ellie-home
git add app/pages/ellie-chat.vue app/composables/useEllieChat.ts
git commit -m "[DISPATCH-P2] feat: integrate dispatch cards into Ellie Chat layout (ELLIE-1312, 1313)"
```

---

### Task 7: Build, deploy, and verify

- [ ] **Step 1: Build the dashboard**

```bash
cd /home/ellie/ellie-home && bun run build
```

Expected: Build succeeds.

- [ ] **Step 2: Restart the dashboard service**

```bash
sudo systemctl restart ellie-dashboard
```

Or if using dev mode:
```bash
cd /home/ellie/ellie-home && bun run dev
```

- [ ] **Step 3: Verify in browser**

Open dashboard.ellie-labs.dev, navigate to Ellie Chat:
- Send a message that triggers a dispatch (e.g., "check the status of ELLIE-500")
- Verify: inline indicator appears in the chat stream
- Verify: clicking the "Dispatches" button opens the side panel
- Verify: card appears in the side panel with correct agent color, status badge, progress line
- Verify: card updates in place as the dispatch progresses and completes

- [ ] **Step 4: Commit the plan**

```bash
cd /home/ellie/ellie-dev
git add docs/superpowers/plans/2026-04-03-dispatch-observability-phase2.md
git commit -m "[DISPATCH-P2] complete: Phase 2 dispatch cards in Ellie Chat"
```
