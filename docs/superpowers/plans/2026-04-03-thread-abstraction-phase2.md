# Thread Abstraction Phase 2: Frontend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add thread UI to Ellie Chat — dropdown selector, new thread form, thread switching with isolated message history, unread tracking, and thread_id on all outgoing WebSocket messages.

**Architecture:** A `useThreads` composable fetches threads from the API and manages active thread state. A `ThreadSelector` dropdown component sits in the chat header. Thread switching saves/loads message history per thread via sessionStorage (same pattern as existing channel switching). All outgoing WebSocket messages include `thread_id`. Incoming messages filter by active thread.

**Tech Stack:** Vue 3 (Nuxt 4), Tailwind CSS, TypeScript, `$fetch` for API, WebSocket

**Spec:** `docs/superpowers/specs/2026-04-03-thread-abstraction-design.md` — Phase 2

**Depends on:** Phase 1 (thread tables, API endpoints, WebSocket thread_id support)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `ellie-home/server/api/threads/index.get.ts` | Create | Nuxt proxy: list threads |
| `ellie-home/server/api/threads/index.post.ts` | Create | Nuxt proxy: create thread |
| `ellie-home/server/api/threads/[id].get.ts` | Create | Nuxt proxy: get thread |
| `ellie-home/app/composables/useThreads.ts` | Create | Thread state, fetch, switch, create |
| `ellie-home/app/components/thread/ThreadSelector.vue` | Create | Dropdown + new thread form |
| `ellie-home/app/composables/useEllieChat.ts` | Modify | Add thread_id to send(), filter incoming by thread |
| `ellie-home/app/pages/ellie-chat.vue` | Modify | Integrate ThreadSelector, wire thread switching |

---

### Task 1: Nuxt proxy routes for thread API

**Files:**
- Create: `ellie-home/server/api/threads/index.get.ts`
- Create: `ellie-home/server/api/threads/index.post.ts`
- Create: `ellie-home/server/api/threads/[id].get.ts`

- [ ] **Step 1: Create list threads proxy**

Create `/home/ellie/ellie-home/server/api/threads/index.get.ts`:

```typescript
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const relayUrl = config.relayUrl || 'http://localhost:3001'
  const res = await fetch(`${relayUrl}/api/threads`, {
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw createError({ statusCode: res.status, message: 'Failed to fetch threads' })
  return res.json()
})
```

- [ ] **Step 2: Create create thread proxy**

Create `/home/ellie/ellie-home/server/api/threads/index.post.ts`:

```typescript
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const relayUrl = config.relayUrl || 'http://localhost:3001'
  const body = await readBody(event)
  const res = await fetch(`${relayUrl}/api/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw createError({ statusCode: res.status, message: 'Failed to create thread' })
  return res.json()
})
```

- [ ] **Step 3: Create get thread proxy**

Create `/home/ellie/ellie-home/server/api/threads/[id].get.ts`:

```typescript
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const relayUrl = config.relayUrl || 'http://localhost:3001'
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'Missing thread ID' })
  const res = await fetch(`${relayUrl}/api/threads/${encodeURIComponent(id)}`, {
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) {
    if (res.status === 404) throw createError({ statusCode: 404, message: 'Thread not found' })
    throw createError({ statusCode: res.status, message: 'Failed to fetch thread' })
  }
  return res.json()
})
```

- [ ] **Step 4: Commit**

```bash
cd /home/ellie/ellie-home
git add server/api/threads/
git commit -m "[THREADS-P2] feat: Nuxt proxy routes for thread API (ELLIE-1374)"
```

---

### Task 2: useThreads composable

**Files:**
- Create: `ellie-home/app/composables/useThreads.ts`

- [ ] **Step 1: Create the composable**

Create `/home/ellie/ellie-home/app/composables/useThreads.ts`:

```typescript
/**
 * useThreads — thread state management for Ellie Chat
 * ELLIE-1374 Phase 2
 *
 * Fetches threads from the API, manages active thread,
 * handles thread switching with message history isolation.
 */

import { ref, computed } from 'vue'

export interface Thread {
  id: string
  name: string
  routing_mode: 'coordinated' | 'direct'
  direct_agent: string | null
  agent_count: number
  created_at: string
}

// Module-level singleton state
const threads = ref<Thread[]>([])
const activeThreadId = ref<string | null>(null)
const loading = ref(false)
const showNewThreadForm = ref(false)

const activeThread = computed(() =>
  threads.value.find(t => t.id === activeThreadId.value) ?? null
)

// Unread tracking: thread_id → count
const unreadCounts = ref<Map<string, number>>(new Map())

const totalUnread = computed(() => {
  let total = 0
  for (const [tid, count] of unreadCounts.value) {
    if (tid !== activeThreadId.value) total += count
  }
  return total
})

async function fetchThreads(): Promise<void> {
  loading.value = true
  try {
    const data = await $fetch<{ threads: Thread[] }>('/api/threads')
    threads.value = data.threads

    // Set active thread to first (General) if not set
    if (!activeThreadId.value && threads.value.length > 0) {
      activeThreadId.value = threads.value[0].id
    }
  } catch (err) {
    console.error('[useThreads] Failed to fetch threads:', err)
  } finally {
    loading.value = false
  }
}

function switchThread(threadId: string) {
  if (threadId === activeThreadId.value) return

  // Clear unread for the thread we're switching to
  unreadCounts.value.delete(threadId)
  unreadCounts.value = new Map(unreadCounts.value)

  activeThreadId.value = threadId
}

async function createThread(opts: {
  name: string
  routing_mode: 'coordinated' | 'direct'
  direct_agent?: string
  agents: string[]
}): Promise<Thread | null> {
  try {
    // Get channel_id from the General thread (all threads share a channel)
    const generalThread = threads.value[0]
    if (!generalThread) return null

    // Fetch the General thread to get channel_id
    const threadDetail = await $fetch<{ thread: { channel_id: string } }>(`/api/threads/${generalThread.id}`)

    const data = await $fetch<{ thread: { id: string; name: string } }>('/api/threads', {
      method: 'POST',
      body: {
        name: opts.name,
        channel_id: threadDetail.thread.channel_id,
        routing_mode: opts.routing_mode,
        direct_agent: opts.direct_agent,
        agents: opts.agents,
      },
    })

    // Refresh thread list
    await fetchThreads()

    // Switch to the new thread
    switchThread(data.thread.id)
    showNewThreadForm.value = false

    return threads.value.find(t => t.id === data.thread.id) ?? null
  } catch (err) {
    console.error('[useThreads] Failed to create thread:', err)
    return null
  }
}

function incrementUnread(threadId: string) {
  if (threadId === activeThreadId.value) return // Don't count active thread
  const current = unreadCounts.value.get(threadId) ?? 0
  unreadCounts.value.set(threadId, current + 1)
  unreadCounts.value = new Map(unreadCounts.value) // trigger reactivity
}

/**
 * Handle thread_created WebSocket event — add to list without refetching.
 */
function handleThreadCreated(thread: Thread) {
  if (!threads.value.find(t => t.id === thread.id)) {
    threads.value.push(thread)
  }
}

export function useThreads() {
  return {
    threads,
    activeThreadId,
    activeThread,
    loading,
    showNewThreadForm,
    unreadCounts,
    totalUnread,
    fetchThreads,
    switchThread,
    createThread,
    incrementUnread,
    handleThreadCreated,
  }
}
```

- [ ] **Step 2: Commit**

```bash
cd /home/ellie/ellie-home
git add app/composables/useThreads.ts
git commit -m "[THREADS-P2] feat: useThreads composable — state, fetch, switch, create (ELLIE-1374)"
```

---

### Task 3: ThreadSelector component

**Files:**
- Create: `ellie-home/app/components/thread/ThreadSelector.vue`

- [ ] **Step 1: Create the component**

Create `/home/ellie/ellie-home/app/components/thread/ThreadSelector.vue`:

```vue
<template>
  <div class="relative" ref="dropdownRef">
    <!-- Trigger button -->
    <button
      class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 hover:border-gray-600 transition-colors text-sm"
      @click="open = !open"
    >
      <span class="text-gray-200 truncate max-w-[160px]">{{ activeThread?.name || 'General' }}</span>
      <span class="text-gray-500 text-xs">({{ activeThread?.agent_count || 0 }})</span>
      <span class="text-gray-500 text-xs">&#9662;</span>
      <!-- Unread badge -->
      <span
        v-if="totalUnread > 0"
        class="absolute -top-1 -right-1 w-4 h-4 text-[10px] bg-amber-500 text-white rounded-full flex items-center justify-center"
      >
        {{ totalUnread > 9 ? '9+' : totalUnread }}
      </span>
    </button>

    <!-- Dropdown -->
    <div
      v-if="open"
      class="absolute top-full left-0 mt-1 w-72 bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-50 overflow-hidden"
    >
      <!-- Thread list -->
      <div class="max-h-64 overflow-y-auto">
        <button
          v-for="thread in threads"
          :key="thread.id"
          class="w-full flex items-center justify-between px-3 py-2 text-left text-sm hover:bg-gray-800 transition-colors"
          :class="thread.id === activeThreadId ? 'bg-gray-800/50 text-cyan-400' : 'text-gray-300'"
          @click="selectThread(thread.id)"
        >
          <div class="flex items-center gap-2 min-w-0">
            <span class="truncate">{{ thread.name }}</span>
            <span class="text-gray-600 text-xs shrink-0">({{ thread.agent_count }})</span>
            <span v-if="thread.routing_mode === 'direct'" class="text-[10px] px-1.5 py-0.5 bg-purple-900/50 text-purple-400 rounded shrink-0">direct</span>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <!-- Unread indicator -->
            <span
              v-if="getUnread(thread.id) > 0"
              class="w-5 h-5 text-[10px] bg-amber-500 text-white rounded-full flex items-center justify-center"
            >
              {{ getUnread(thread.id) }}
            </span>
          </div>
        </button>
      </div>

      <!-- Divider + New thread -->
      <div class="border-t border-gray-800">
        <button
          v-if="!showNewThreadForm"
          class="w-full px-3 py-2 text-left text-sm text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-colors"
          @click="showNewThreadForm = true"
        >
          + New thread
        </button>

        <!-- New thread form -->
        <div v-else class="p-3 space-y-3">
          <input
            v-model="newThreadName"
            type="text"
            placeholder="Thread name"
            class="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-gray-200 placeholder-gray-600 focus:border-cyan-600 focus:outline-none"
            @keydown.enter="handleCreate"
            ref="nameInputRef"
          />

          <!-- Agent selection -->
          <div>
            <div class="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Agents</div>
            <div class="flex flex-wrap gap-1">
              <button
                v-for="agent in availableAgents"
                :key="agent.name"
                class="text-xs px-2 py-1 rounded border transition-colors"
                :class="selectedAgents.has(agent.name)
                  ? 'border-cyan-600 bg-cyan-900/30 text-cyan-400'
                  : 'border-gray-700 bg-gray-800 text-gray-500 hover:text-gray-300'"
                @click="toggleAgent(agent.name)"
              >
                {{ agent.label }}
              </button>
            </div>
          </div>

          <!-- Routing mode -->
          <div class="flex items-center gap-2">
            <button
              class="text-xs px-2 py-1 rounded border transition-colors"
              :class="newRoutingMode === 'coordinated'
                ? 'border-cyan-600 bg-cyan-900/30 text-cyan-400'
                : 'border-gray-700 bg-gray-800 text-gray-500'"
              @click="newRoutingMode = 'coordinated'"
            >
              Coordinated
            </button>
            <button
              class="text-xs px-2 py-1 rounded border transition-colors"
              :class="newRoutingMode === 'direct'
                ? 'border-purple-600 bg-purple-900/30 text-purple-400'
                : 'border-gray-700 bg-gray-800 text-gray-500'"
              @click="newRoutingMode = 'direct'"
            >
              Direct
            </button>
          </div>

          <!-- Direct agent selector -->
          <div v-if="newRoutingMode === 'direct'">
            <div class="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Talk to</div>
            <select
              v-model="newDirectAgent"
              class="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-gray-200 focus:outline-none"
            >
              <option v-for="agent in selectedAgentsList" :key="agent" :value="agent">
                {{ agentLabel(agent) }}
              </option>
            </select>
          </div>

          <!-- Actions -->
          <div class="flex items-center gap-2">
            <button
              class="text-xs px-3 py-1.5 rounded bg-cyan-700 text-white hover:bg-cyan-600 transition-colors disabled:opacity-50"
              :disabled="!newThreadName.trim() || selectedAgents.size === 0"
              @click="handleCreate"
            >
              Create
            </button>
            <button
              class="text-xs px-3 py-1.5 rounded text-gray-500 hover:text-gray-300 transition-colors"
              @click="cancelCreate"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
import { useThreads } from '~/composables/useThreads'

const {
  threads, activeThreadId, activeThread, totalUnread,
  showNewThreadForm, switchThread, createThread, unreadCounts,
} = useThreads()

const emit = defineEmits<{
  switch: [threadId: string]
}>()

const open = ref(false)
const dropdownRef = ref<HTMLElement | null>(null)
const nameInputRef = ref<HTMLInputElement | null>(null)
const newThreadName = ref('')
const newRoutingMode = ref<'coordinated' | 'direct'>('coordinated')
const newDirectAgent = ref('ellie')
const selectedAgents = ref(new Set(['ellie']))

const availableAgents = [
  { name: 'ellie', label: 'Ellie' },
  { name: 'james', label: 'James' },
  { name: 'kate', label: 'Kate' },
  { name: 'alan', label: 'Alan' },
  { name: 'brian', label: 'Brian' },
  { name: 'jason', label: 'Jason' },
  { name: 'amy', label: 'Amy' },
  { name: 'marcus', label: 'Marcus' },
]

const selectedAgentsList = computed(() => [...selectedAgents.value])

function agentLabel(name: string) {
  return availableAgents.find(a => a.name === name)?.label || name
}

function getUnread(threadId: string): number {
  return unreadCounts.value.get(threadId) ?? 0
}

function toggleAgent(name: string) {
  if (selectedAgents.value.has(name)) {
    selectedAgents.value.delete(name)
  } else {
    selectedAgents.value.add(name)
  }
  selectedAgents.value = new Set(selectedAgents.value) // trigger reactivity
}

function selectThread(threadId: string) {
  switchThread(threadId)
  emit('switch', threadId)
  open.value = false
}

async function handleCreate() {
  if (!newThreadName.value.trim() || selectedAgents.value.size === 0) return

  await createThread({
    name: newThreadName.value.trim(),
    routing_mode: newRoutingMode.value,
    direct_agent: newRoutingMode.value === 'direct' ? newDirectAgent.value : undefined,
    agents: [...selectedAgents.value],
  })

  // Reset form
  newThreadName.value = ''
  newRoutingMode.value = 'coordinated'
  newDirectAgent.value = 'ellie'
  selectedAgents.value = new Set(['ellie'])
  open.value = false
}

function cancelCreate() {
  showNewThreadForm.value = false
  newThreadName.value = ''
}

// Close dropdown on outside click
function handleClickOutside(e: MouseEvent) {
  if (dropdownRef.value && !dropdownRef.value.contains(e.target as Node)) {
    open.value = false
    if (showNewThreadForm.value) showNewThreadForm.value = false
  }
}

onMounted(() => document.addEventListener('click', handleClickOutside))
onUnmounted(() => document.removeEventListener('click', handleClickOutside))
</script>
```

- [ ] **Step 2: Commit**

```bash
cd /home/ellie/ellie-home
git add app/components/thread/ThreadSelector.vue
git commit -m "[THREADS-P2] feat: ThreadSelector dropdown with new thread form (ELLIE-1374)"
```

---

### Task 4: Wire thread_id into useEllieChat send + message filtering

**Files:**
- Modify: `ellie-home/app/composables/useEllieChat.ts`

- [ ] **Step 1: Add thread_id to outgoing messages**

Read `/home/ellie/ellie-home/app/composables/useEllieChat.ts`. Find the `send()` function (around line 529). Add `threadId?: string` to the opts:

```typescript
function send(text: string, opts?: { phoneMode?: boolean; image?: EllieChatImage; channelId?: string; mode?: string; threadId?: string }) {
```

Then in the payload construction (around line 548), add:

```typescript
  if (opts?.threadId) {
    payload.thread_id = opts.threadId
  }
```

- [ ] **Step 2: Handle incoming thread_id for unread tracking**

Find where `dispatch_event` is handled (added in Phase 2 of dispatch observability). Also find where `response` messages are handled. For ALL incoming message types that have a `thread_id`, add unread tracking.

After the existing message type handlers (response, dispatch_event, etc.), add a catch-all for thread unread:

```typescript
      // ELLIE-1374: Track unread for non-active threads
      if (msg.thread_id) {
        const { incrementUnread, activeThreadId } = useThreads()
        if (msg.thread_id !== activeThreadId.value) {
          incrementUnread(msg.thread_id)
        }
      }
```

Import at the top:
```typescript
import { useThreads } from './useThreads'
```

- [ ] **Step 3: Handle thread_created WebSocket event**

In the WebSocket message handler, add:

```typescript
      // Thread management events (ELLIE-1374)
      if (msg.type === 'thread_created') {
        const { handleThreadCreated } = useThreads()
        handleThreadCreated(msg.thread)
      }
```

- [ ] **Step 4: Commit**

```bash
cd /home/ellie/ellie-home
git add app/composables/useEllieChat.ts
git commit -m "[THREADS-P2] feat: thread_id on outgoing messages + unread tracking (ELLIE-1374)"
```

---

### Task 5: Integrate ThreadSelector into ellie-chat.vue

**Files:**
- Modify: `ellie-home/app/pages/ellie-chat.vue`

- [ ] **Step 1: Add imports and state**

In the `<script setup>` section, add:

```typescript
import { useThreads } from '~/composables/useThreads'

const { activeThreadId, fetchThreads } = useThreads()

// Fetch threads on mount
onMounted(() => {
  fetchThreads()
})
```

Note: `onMounted` may already be imported — check first.

- [ ] **Step 2: Add ThreadSelector to the header**

Find the header area in the template (where the title, avatar, mode selector, and buttons are). Add the `<ThreadSelector>` component near the beginning of the header, after the title or before the existing buttons:

```vue
    <!-- Thread selector (ELLIE-1374) -->
    <ThreadSelector @switch="handleThreadSwitch" />
```

- [ ] **Step 3: Add thread switch handler**

In the script, add:

```typescript
function handleThreadSwitch(threadId: string) {
  // Save current thread's messages, load new thread's messages
  const { switchChannel } = useEllieChat()
  // Use thread ID as a channel key for message storage isolation
  switchChannel(threadId)
}
```

The existing `switchChannel` function (from `useEllieChat`) already saves/loads messages by channel ID from sessionStorage. By passing the thread ID as the channel key, each thread gets its own message history. This reuses the existing channel switching infrastructure.

- [ ] **Step 4: Pass thread_id to send**

Find where `send()` is called in the template (the message input submit handler). Add `threadId`:

Find the existing `send(text, { ... })` calls and add `threadId: activeThreadId.value || undefined` to the options object. There may be multiple call sites — check for:
- The main message input submit
- Any quick-action buttons that send messages

For each, ensure the `threadId` is passed:

```typescript
send(messageText, { threadId: activeThreadId.value || undefined })
```

- [ ] **Step 5: Build**

```bash
cd /home/ellie/ellie-home && bun run build
```

Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
cd /home/ellie/ellie-home
git add app/pages/ellie-chat.vue
git commit -m "[THREADS-P2] feat: integrate ThreadSelector into Ellie Chat (ELLIE-1374)"
```

---

### Task 6: Build, deploy, and verify

- [ ] **Step 1: Build dashboard**

```bash
cd /home/ellie/ellie-home && bun run build
```

Expected: Build succeeds.

- [ ] **Step 2: Restart dashboard**

```bash
sudo systemctl restart ellie-dashboard
```

- [ ] **Step 3: Verify in browser**

Open dashboard.ellie-labs.dev, navigate to Ellie Chat:
- Thread selector dropdown should appear in the header showing "General (8)"
- Click dropdown — should show the General thread
- Click "New thread" — form should appear with name input, agent checkboxes, routing mode toggle
- Create a thread "Test Direct" with routing_mode=direct, agent=ellie
- Switch between threads — message history should be isolated
- Send a message in the new thread — should use direct mode (no dispatch cards, direct agent response)

- [ ] **Step 4: Push**

```bash
cd /home/ellie/ellie-home && git push
cd /home/ellie/ellie-dev && git push
```

- [ ] **Step 5: Commit the plan**

```bash
cd /home/ellie/ellie-dev
git add docs/superpowers/plans/2026-04-03-thread-abstraction-phase2.md
git commit -m "[THREADS-P2] complete: Phase 2 thread frontend"
```
