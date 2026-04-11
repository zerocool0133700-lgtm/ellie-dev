# Dispatch Observability Phase 4: Post-Completion Drill-Down — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tap a completed dispatch card to see the full outcome — summary, files changed, decisions, commits, cost, and Plane ticket status. For formations, show nested agent contributions.

**Architecture:** The relay already has `GET /api/dispatches/:run_id/outcome` (Phase 1). The dashboard needs a Nuxt server proxy route, a drill-down Vue component, and wiring into the existing DispatchCard expand button. Data is fetched on demand (not eagerly).

**Tech Stack:** Vue 3 (Nuxt 4), Tailwind CSS, TypeScript, `$fetch` for API calls

**Spec:** `docs/superpowers/specs/2026-04-03-dispatch-observability-design.md` — Phase 4 section

**Depends on:** Phase 1 (outcome storage + API), Phase 2 (dispatch cards with expand button)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `ellie-home/server/api/dispatches/[id]/outcome.get.ts` | Create | Nuxt proxy to relay outcome API |
| `ellie-home/app/composables/useDispatchOutcome.ts` | Create | Fetch + cache outcome data |
| `ellie-home/app/components/dispatch/DispatchDrillDown.vue` | Create | Expandable detail view |
| `ellie-home/app/components/dispatch/FormationBreakdown.vue` | Create | Nested agent contributions |
| `ellie-home/app/components/dispatch/DispatchSidePanel.vue` | Modify | Wire expand → drill-down |
| `ellie-home/app/pages/ellie-chat.vue` | Modify | Handle drill-down events |

---

### Task 1: Nuxt proxy route for outcome API

**Files:**
- Create: `ellie-home/server/api/dispatches/[id]/outcome.get.ts`

- [ ] **Step 1: Create the proxy route**

Create `/home/ellie/ellie-home/server/api/dispatches/[id]/outcome.get.ts`:

```typescript
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const relayUrl = config.relayUrl || 'http://localhost:3001'
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'Missing dispatch ID' })

  const res = await fetch(`${relayUrl}/api/dispatches/${encodeURIComponent(id)}/outcome`, {
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) {
    if (res.status === 404) throw createError({ statusCode: 404, message: 'Outcome not found' })
    throw createError({ statusCode: res.status, message: 'Failed to fetch outcome' })
  }
  return res.json()
})
```

- [ ] **Step 2: Commit**

```bash
cd /home/ellie/ellie-home
git add server/api/dispatches/\[id\]/outcome.get.ts
git commit -m "[DISPATCH-P4] feat: Nuxt proxy for dispatch outcome API (ELLIE-1321)"
```

---

### Task 2: useDispatchOutcome composable

**Files:**
- Create: `ellie-home/app/composables/useDispatchOutcome.ts`

- [ ] **Step 1: Create the composable**

Create `/home/ellie/ellie-home/app/composables/useDispatchOutcome.ts`:

```typescript
/**
 * useDispatchOutcome — fetch and cache outcome data for drill-down
 * ELLIE-1320
 */

import { ref } from 'vue'

export interface DispatchOutcomeData {
  run_id: string
  agent: string
  work_item_id: string | null
  dispatch_type: string
  status: string
  summary: string | null
  files_changed: string[]
  decisions: string[]
  commits: string[]
  forest_writes: string[]
  duration_ms: number | null
  tokens_in: number | null
  tokens_out: number | null
  cost_usd: number | null
  created_at: string
  participants?: Array<{
    agent: string
    summary: string | null
    duration_ms: number | null
    cost_usd: number | null
  }>
}

// Cache outcomes to avoid refetching
const cache = new Map<string, DispatchOutcomeData>()

const loading = ref(false)
const error = ref<string | null>(null)
const currentOutcome = ref<DispatchOutcomeData | null>(null)

async function fetchOutcome(runId: string): Promise<DispatchOutcomeData | null> {
  // Check cache first
  const cached = cache.get(runId)
  if (cached) {
    currentOutcome.value = cached
    return cached
  }

  loading.value = true
  error.value = null

  try {
    const data = await $fetch<DispatchOutcomeData>(`/api/dispatches/${encodeURIComponent(runId)}/outcome`)
    cache.set(runId, data)
    currentOutcome.value = data
    return data
  } catch (err: any) {
    if (err?.statusCode === 404) {
      error.value = 'Outcome not found'
    } else {
      error.value = 'Failed to load outcome'
    }
    currentOutcome.value = null
    return null
  } finally {
    loading.value = false
  }
}

function clearOutcome() {
  currentOutcome.value = null
  error.value = null
}

export function useDispatchOutcome() {
  return {
    loading,
    error,
    currentOutcome,
    fetchOutcome,
    clearOutcome,
  }
}
```

- [ ] **Step 2: Commit**

```bash
cd /home/ellie/ellie-home
git add app/composables/useDispatchOutcome.ts
git commit -m "[DISPATCH-P4] feat: useDispatchOutcome composable for drill-down data (ELLIE-1320)"
```

---

### Task 3: FormationBreakdown component

**Files:**
- Create: `ellie-home/app/components/dispatch/FormationBreakdown.vue`

- [ ] **Step 1: Create the component**

Create `/home/ellie/ellie-home/app/components/dispatch/FormationBreakdown.vue`:

```vue
<template>
  <div class="space-y-2">
    <h4 class="text-xs font-medium text-gray-400 uppercase tracking-wider">Agent Contributions</h4>
    <div
      v-for="(p, idx) in participants"
      :key="idx"
      class="border border-gray-800 rounded-lg p-2"
    >
      <div class="flex items-center justify-between mb-1">
        <div class="flex items-center gap-2">
          <div
            class="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white"
            :style="{ backgroundColor: getColor(p.agent) }"
          >
            {{ getInitial(p.agent) }}
          </div>
          <span class="text-xs font-medium text-gray-300">{{ getDisplayName(p.agent) }}</span>
        </div>
        <div class="flex items-center gap-2 text-[10px] text-gray-600 tabular-nums">
          <span v-if="p.duration_ms != null">{{ formatDuration(p.duration_ms) }}</span>
          <span v-if="p.cost_usd != null">${{ p.cost_usd.toFixed(2) }}</span>
        </div>
      </div>
      <p v-if="p.summary" class="text-xs text-gray-500 line-clamp-3">{{ p.summary }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useAgentProfiles } from '~/composables/useAgentProfiles'

defineProps<{
  participants: Array<{
    agent: string
    summary: string | null
    duration_ms: number | null
    cost_usd: number | null
  }>
}>()

const { getColor, getDisplayName, getInitial } = useAgentProfiles()

function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  return `${min}m ${sec % 60}s`
}
</script>
```

- [ ] **Step 2: Commit**

```bash
cd /home/ellie/ellie-home
git add app/components/dispatch/FormationBreakdown.vue
git commit -m "[DISPATCH-P4] feat: FormationBreakdown component for multi-agent drill-down (ELLIE-1322)"
```

---

### Task 4: DispatchDrillDown component

**Files:**
- Create: `ellie-home/app/components/dispatch/DispatchDrillDown.vue`

- [ ] **Step 1: Create the component**

Create `/home/ellie/ellie-home/app/components/dispatch/DispatchDrillDown.vue`:

```vue
<template>
  <div class="flex flex-col h-full overflow-hidden">
    <!-- Header -->
    <div class="flex items-center justify-between px-3 py-2 border-b border-gray-800">
      <div class="flex items-center gap-2">
        <button class="text-gray-500 hover:text-gray-300 text-xs" @click="$emit('close')">
          &larr; Back
        </button>
        <span class="text-sm font-medium text-gray-200">Dispatch Details</span>
      </div>
      <!-- Plane ticket badge -->
      <a
        v-if="outcome?.work_item_id"
        :href="`https://plane.ellie-labs.dev/evelife/projects/7194ace4-b80e-4c83-8042-c925598accf2/issues/?search=${outcome.work_item_id}`"
        target="_blank"
        class="text-xs px-2 py-0.5 rounded-full bg-cyan-900/50 text-cyan-400 hover:bg-cyan-900/70"
      >
        {{ outcome.work_item_id }}
      </a>
    </div>

    <!-- Loading state -->
    <div v-if="loading" class="flex-1 flex items-center justify-center">
      <span class="text-xs text-gray-600">Loading outcome...</span>
    </div>

    <!-- Error state -->
    <div v-else-if="error" class="flex-1 flex items-center justify-center">
      <span class="text-xs text-red-400">{{ error }}</span>
    </div>

    <!-- Outcome content -->
    <div v-else-if="outcome" class="flex-1 overflow-y-auto px-3 py-3 space-y-4">
      <!-- Agent + status header -->
      <div class="flex items-center gap-2">
        <div
          class="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white"
          :style="{ backgroundColor: getColor(outcome.agent) }"
        >
          {{ getInitial(outcome.agent) }}
        </div>
        <div>
          <span class="text-sm font-medium text-gray-200">{{ getDisplayName(outcome.agent) }}</span>
          <span class="text-xs ml-2 px-2 py-0.5 rounded-full" :class="statusBadge">{{ outcome.status }}</span>
        </div>
      </div>

      <!-- Summary -->
      <div v-if="outcome.summary">
        <h4 class="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">Summary</h4>
        <p class="text-xs text-gray-300 whitespace-pre-wrap">{{ outcome.summary }}</p>
      </div>

      <!-- Files changed -->
      <div v-if="outcome.files_changed?.length > 0">
        <h4 class="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">Files Changed</h4>
        <ul class="space-y-0.5">
          <li v-for="file in outcome.files_changed" :key="file" class="text-xs text-gray-500 font-mono truncate">
            {{ file }}
          </li>
        </ul>
      </div>

      <!-- Decisions -->
      <div v-if="outcome.decisions?.length > 0">
        <h4 class="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">Decisions</h4>
        <ul class="space-y-1">
          <li v-for="decision in outcome.decisions" :key="decision" class="text-xs text-gray-400">
            &bull; {{ decision }}
          </li>
        </ul>
      </div>

      <!-- Commits -->
      <div v-if="outcome.commits?.length > 0">
        <h4 class="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">Commits</h4>
        <ul class="space-y-0.5">
          <li v-for="sha in outcome.commits" :key="sha" class="text-xs text-cyan-500 font-mono">
            {{ sha.slice(0, 8) }}
          </li>
        </ul>
      </div>

      <!-- Forest writes -->
      <div v-if="outcome.forest_writes?.length > 0">
        <h4 class="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">Forest Writes</h4>
        <ul class="space-y-0.5">
          <li v-for="id in outcome.forest_writes" :key="id" class="text-xs text-gray-500 font-mono">
            {{ id.slice(0, 12) }}
          </li>
        </ul>
      </div>

      <!-- Duration + cost -->
      <div class="flex items-center gap-4 text-xs text-gray-600 tabular-nums border-t border-gray-800 pt-2">
        <span v-if="outcome.duration_ms != null">Duration: {{ formatDuration(outcome.duration_ms) }}</span>
        <span v-if="outcome.tokens_in != null">Tokens: {{ (outcome.tokens_in + (outcome.tokens_out ?? 0)).toLocaleString() }}</span>
        <span v-if="outcome.cost_usd != null">Cost: ${{ outcome.cost_usd.toFixed(2) }} (estimate)</span>
      </div>

      <!-- Formation participants -->
      <FormationBreakdown
        v-if="outcome.participants && outcome.participants.length > 0"
        :participants="outcome.participants"
      />
    </div>

    <!-- Empty state -->
    <div v-else class="flex-1 flex items-center justify-center">
      <span class="text-xs text-gray-600">No outcome data</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { watch, onMounted } from 'vue'
import { useDispatchOutcome, type DispatchOutcomeData } from '~/composables/useDispatchOutcome'
import { useAgentProfiles } from '~/composables/useAgentProfiles'

const props = defineProps<{
  runId: string
}>()

defineEmits<{
  close: []
}>()

const { loading, error, currentOutcome: outcome, fetchOutcome } = useDispatchOutcome()
const { getColor, getDisplayName, getInitial } = useAgentProfiles()

const statusBadge = computed(() => {
  switch (outcome.value?.status) {
    case 'completed': return 'bg-emerald-900/50 text-emerald-400'
    case 'failed': return 'bg-red-900/50 text-red-400'
    default: return 'bg-gray-800 text-gray-500'
  }
})

function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  return `${min}m ${sec % 60}s`
}

onMounted(() => fetchOutcome(props.runId))
watch(() => props.runId, (newId) => fetchOutcome(newId))
</script>
```

- [ ] **Step 2: Commit**

```bash
cd /home/ellie/ellie-home
git add app/components/dispatch/DispatchDrillDown.vue
git commit -m "[DISPATCH-P4] feat: DispatchDrillDown component with outcome details (ELLIE-1320)"
```

---

### Task 5: Wire drill-down into side panel and chat page

**Files:**
- Modify: `ellie-home/app/components/dispatch/DispatchSidePanel.vue`
- Modify: `ellie-home/app/pages/ellie-chat.vue`

- [ ] **Step 1: Update DispatchSidePanel to show drill-down**

Read `/home/ellie/ellie-home/app/components/dispatch/DispatchSidePanel.vue`. Add drill-down state and conditional rendering.

In the `<script setup>`:
```typescript
import { ref } from 'vue'
import { useDispatchOutcome } from '~/composables/useDispatchOutcome'

const drillDownRunId = ref<string | null>(null)
const { clearOutcome } = useDispatchOutcome()

function openDrillDown(runId: string) {
  drillDownRunId.value = runId
}

function closeDrillDown() {
  drillDownRunId.value = null
  clearOutcome()
}
```

In the template, wrap the existing card list and footer in a `v-if="!drillDownRunId"` block, and add a `v-else` block for the drill-down:

After the header `</div>` and before the summary line, add:

```vue
      <!-- Drill-down view -->
      <template v-if="drillDownRunId">
        <DispatchDrillDown :run-id="drillDownRunId" @close="closeDrillDown" />
      </template>

      <!-- Card list (hidden during drill-down) -->
      <template v-else>
```

Then close that template tag before the panel's closing `</aside>` — wrap the summary, card list, and footer in the `<template v-else>`.

Also update the `DispatchCard` `@expand` handler to call `openDrillDown` instead of emitting:

Change:
```vue
@expand="$emit('expand', $event)"
```
To:
```vue
@expand="openDrillDown($event)"
```

Remove the `expand` emit from defineEmits since it's handled internally now.

- [ ] **Step 2: Update ellie-chat.vue**

In `/home/ellie/ellie-home/app/pages/ellie-chat.vue`, find the `handleDrillDown` function (the `console.log` placeholder from Phase 2). Replace it with:

```typescript
function handleDrillDown(runId: string) {
  const { focusCard } = useDispatchCards()
  focusCard(runId)
  // Drill-down is handled inside DispatchSidePanel now
}
```

The DispatchSidePanel no longer needs the `@expand` emit on the chat page since it handles drill-down internally.

- [ ] **Step 3: Build**

```bash
cd /home/ellie/ellie-home && bun run build
```

Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
cd /home/ellie/ellie-home
git add app/components/dispatch/DispatchSidePanel.vue app/pages/ellie-chat.vue
git commit -m "[DISPATCH-P4] feat: wire drill-down into side panel (ELLIE-1320, 1322, 1323)"
```

---

### Task 6: Build, deploy, and verify

- [ ] **Step 1: Build the dashboard**

```bash
cd /home/ellie/ellie-home && bun run build
```

Expected: Build succeeds.

- [ ] **Step 2: Restart the dashboard**

```bash
sudo systemctl restart ellie-dashboard
```

- [ ] **Step 3: Verify the outcome API proxy works**

```bash
# Get a real run_id from the outcomes table
RUN_ID=$(psql -U ellie -d ellie-forest -t -c "SELECT run_id FROM dispatch_outcomes LIMIT 1;" | tr -d ' ')
echo "Testing with run_id: $RUN_ID"
curl -s "http://localhost:3000/api/dispatches/$RUN_ID/outcome" | python3 -c "import sys,json; d=json.load(sys.stdin); print('Agent:', d.get('agent'), '| Status:', d.get('status'))"
```

Expected: Agent name and status from the outcome record.

- [ ] **Step 4: Verify in browser**

Open dashboard.ellie-labs.dev, navigate to Ellie Chat:
- Open the dispatch side panel
- Find a completed dispatch card (green "Done" badge)
- Click "Details" on the card
- Verify: drill-down view shows summary, files, decisions, commits, duration, cost
- Click "Back" to return to the card list

- [ ] **Step 5: Push both repos**

```bash
cd /home/ellie/ellie-home && git push
cd /home/ellie/ellie-dev && git push
```

- [ ] **Step 6: Commit the plan**

```bash
cd /home/ellie/ellie-dev
git add docs/superpowers/plans/2026-04-03-dispatch-observability-phase4.md
git commit -m "[DISPATCH-P4] complete: Phase 4 post-completion drill-down"
```
