# Ellie Chat Consolidation — Phase 2: UI Consolidation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Ellie Chat UI reflect the Phase 1 backend changes — domain label, thread isolation in the UI, contributor avatars, Workshop message cards, unread badges, and dead code cleanup.

**Architecture:** Modify existing Vue components in ellie-home (Nuxt 4 + Tailwind v4). Replace EllieModeSelector with a static domain label. Update message rendering to show contributor avatars. Add Workshop card rendering. Update thread switching to reload messages from the server by thread_id. Clean up orphaned channel/mode code.

**Tech Stack:** Nuxt 4, Vue 3, Tailwind CSS v4, Bun

**Spec:** `docs/superpowers/specs/2026-04-06-ellie-chat-consolidation-design.md` (Phase 2 section)

**Note:** All UI files are in `/home/ellie/ellie-home/`. Build with `cd /home/ellie/ellie-home && bun run build`. The dashboard runs at port 3000 behind Cloudflare tunnel. After UI changes, rebuild and tell Dave to hard-refresh (`Ctrl+Shift+R`).

---

## File Structure

| File | Responsibility |
|------|----------------|
| Delete: `app/components/EllieModeSelector.vue` | Remove dead mode selector |
| Delete: `app/composables/useActiveMode.ts` | Remove dead mode composable |
| Modify: `app/pages/ellie-chat.vue` | Header restructure, contributor avatars, Workshop cards, thread isolation |
| Modify: `app/components/thread/ThreadSelector.vue` | Unread badges, last-activity sort |
| Modify: `app/composables/useEllieChat.ts` | Thread-aware message loading from server, send thread_id on auth |
| Create: `app/components/ellie/WorkshopCard.vue` | Workshop debrief card component |

---

### Task 1: Remove EllieModeSelector and add domain label

**Files:**
- Delete: `app/components/EllieModeSelector.vue`
- Delete: `app/composables/useActiveMode.ts`
- Modify: `app/pages/ellie-chat.vue`

- [ ] **Step 1: Delete the mode selector files**

```bash
cd /home/ellie/ellie-home
rm app/components/EllieModeSelector.vue
rm app/composables/useActiveMode.ts
```

- [ ] **Step 2: Update ellie-chat.vue header**

In `app/pages/ellie-chat.vue`, find the header left side (around line 9-12):

```html
<div class="flex items-center gap-3">
  <h1 class="text-xl font-semibold">Ellie Chat</h1>
  <EllieAvatarVideo />
  <EllieModeSelector />
</div>
```

Replace with:

```html
<div class="flex items-center gap-3">
  <span class="text-xs px-2.5 py-1 rounded-lg bg-gray-800 border border-gray-700 text-gray-400">Software Dev</span>
  <h1 class="text-xl font-semibold">Ellie Chat</h1>
  <EllieAvatarVideo />
</div>
```

The domain label is static text styled like the other header pills — not a dropdown (only one domain in v1).

- [ ] **Step 3: Remove any useActiveMode imports in ellie-chat.vue**

Search for `useActiveMode` in ellie-chat.vue's script section. If it's imported or destructured, remove those lines. Also remove any `mode` references that were only used by the mode selector.

Check if `mode` is passed in the WebSocket send payload — if so, it can be left as `undefined` or removed. The backend now auto-detects mode via the layered prompt system.

- [ ] **Step 4: Build and verify**

```bash
cd /home/ellie/ellie-home && bun run build
```

Expected: Clean build, no errors about missing EllieModeSelector.

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-home
git add -A
git commit -m "[ELLIE-1464] replace mode selector with static domain label"
```

---

### Task 2: Contributor avatars on multi-agent messages

**Files:**
- Modify: `app/pages/ellie-chat.vue`

- [ ] **Step 1: Find the message header rendering**

In `app/pages/ellie-chat.vue`, find the assistant message header (around line 182):

```html
<div class="flex items-center gap-2 mb-1">
  <EllieAgentAvatar v-if="msg.role === 'assistant'" :agent="msg.agent || 'general'" size="xs" />
  <span ...>{{ displayName }}</span>
  <span>{{ formatTime(msg.ts) }}</span>
  <span v-if="msg.duration_ms">{{ duration }}s</span>
</div>
```

- [ ] **Step 2: Add contributor avatar rendering**

After the primary `<EllieAgentAvatar>`, add contributor avatars when present:

```html
<div class="flex items-center gap-2 mb-1">
  <EllieAgentAvatar v-if="msg.role === 'assistant'" :agent="msg.agent || 'general'" size="xs" />
  <!-- Contributor avatars (Phase 1B attribution) -->
  <template v-if="msg.contributors && msg.contributors.length > 0">
    <span class="text-gray-600 text-[10px]">+</span>
    <EllieAgentAvatar
      v-for="contributor in msg.contributors"
      :key="contributor"
      :agent="contributor"
      size="xs"
      class="opacity-75 -ml-1"
    />
  </template>
  <span ...>{{ displayName }}</span>
  <span>{{ formatTime(msg.ts) }}</span>
  <span v-if="msg.duration_ms">{{ duration }}s</span>
</div>
```

The contributor avatars are slightly overlapping (`-ml-1`), reduced opacity (`opacity-75`), and separated from the primary avatar by a small `+` character. This makes them visually secondary.

- [ ] **Step 3: Ensure contributors field is on the message type**

In `useEllieChat.ts`, find the `EllieChatMessage` interface/type. Add `contributors?: string[]` if not present. Also ensure incoming WebSocket messages carry through the `contributors` field from metadata.

Find where incoming `response` messages are parsed and stored. The `contributors` field needs to be extracted from the message and stored on the message object.

Check: when messages are loaded from sessionStorage or from the server, do they include metadata? The `contributors` field might be in `metadata.contributors` and need to be mapped to a top-level field.

- [ ] **Step 4: Build and verify**

```bash
cd /home/ellie/ellie-home && bun run build
```

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-home
git add app/pages/ellie-chat.vue app/composables/useEllieChat.ts
git commit -m "[ELLIE-1466] contributor avatars on multi-agent messages"
```

---

### Task 3: Workshop message cards

**Files:**
- Create: `app/components/ellie/WorkshopCard.vue`
- Modify: `app/pages/ellie-chat.vue`

- [ ] **Step 1: Create WorkshopCard.vue**

Create `app/components/ellie/WorkshopCard.vue`:

```vue
<template>
  <div class="border border-gray-700 rounded-xl bg-gray-800/50 p-3 max-w-[75%]">
    <div class="flex items-center gap-2 mb-2">
      <span class="w-5 h-5 rounded bg-gray-700 flex items-center justify-center text-[10px]">&#9881;</span>
      <span class="text-xs font-semibold text-gray-300">Workshop</span>
      <span class="text-[10px] text-gray-500">{{ formatTime(ts) }}</span>
    </div>
    <div class="text-sm text-gray-200 font-medium mb-1">{{ title }}</div>
    <div v-if="summary" class="text-xs text-gray-400 mb-2">{{ summary }}</div>
    <div v-if="stats" class="flex gap-3 text-[10px] text-gray-500 mb-2">
      <span v-if="stats.decisions">{{ stats.decisions }} decisions</span>
      <span v-if="stats.docs">{{ stats.docs }} docs</span>
      <span v-if="stats.forestWrites">{{ stats.forestWrites }} Forest writes</span>
    </div>
    <button
      v-if="fullContent"
      @click="expanded = !expanded"
      class="text-[10px] text-gray-500 hover:text-gray-300 transition-colors">
      {{ expanded ? '▴ Collapse' : '▾ Expand details' }}
    </button>
    <div v-if="expanded" class="mt-2 text-xs text-gray-400 whitespace-pre-wrap border-t border-gray-700 pt-2">
      {{ fullContent }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{
  title: string
  summary?: string
  stats?: { decisions?: number; docs?: number; forestWrites?: number }
  fullContent?: string
  ts?: number
}>()

const expanded = ref(false)

function formatTime(ts?: number) {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
</script>
```

- [ ] **Step 2: Add Workshop card rendering to ellie-chat.vue**

In the message rendering loop, add a new condition BEFORE the catch-all user/assistant bubble (before the `v-else` at line ~180):

```html
<!-- Workshop debrief card -->
<div v-else-if="msg.role === 'assistant' && msg.agent === 'workshop'" class="flex justify-start">
  <EllieWorkshopCard
    :title="extractWorkshopTitle(msg.text)"
    :summary="extractWorkshopSummary(msg.text)"
    :stats="extractWorkshopStats(msg.text)"
    :full-content="msg.text"
    :ts="msg.ts"
  />
</div>
```

- [ ] **Step 3: Add Workshop extraction helpers in ellie-chat.vue script**

```typescript
function extractWorkshopTitle(text: string): string {
  const match = text.match(/## Workshop Debrief: (.+)/);
  return match ? match[1].trim() : 'Workshop Debrief';
}

function extractWorkshopSummary(text: string): string {
  const match = text.match(/\*\*Summary:\*\*\s*(.+)/);
  return match ? match[1].trim() : '';
}

function extractWorkshopStats(text: string): { decisions?: number; docs?: number; forestWrites?: number } {
  const decisions = (text.match(/\*\*Decisions:\*\*/g) || []).length > 0
    ? (text.match(/^- /gm) || []).length
    : undefined;
  const docsMatch = text.match(/\*\*Docs created\/modified:\*\*/);
  const docs = docsMatch
    ? (text.slice(text.indexOf('**Docs created')).match(/^- /gm) || []).length
    : undefined;
  return { decisions, docs };
}
```

- [ ] **Step 4: Build and verify**

```bash
cd /home/ellie/ellie-home && bun run build
```

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-home
git add app/components/ellie/WorkshopCard.vue app/pages/ellie-chat.vue
git commit -m "[ELLIE-1467] Workshop debrief messages render as collapsible cards"
```

---

### Task 4: Thread selector unread badges and last-activity sort

**Files:**
- Modify: `app/components/thread/ThreadSelector.vue`

- [ ] **Step 1: Read ThreadSelector.vue to understand current rendering**

The thread list already has `unreadCounts` from `useThreads()`. Check if unread badges are already rendered. If not, add them.

- [ ] **Step 2: Add unread badge if missing**

In the thread list item, after the thread name, add:

```html
<span
  v-if="unreadCounts.get(thread.id)"
  class="ml-auto w-5 h-5 text-[10px] bg-cyan-500 text-white rounded-full flex items-center justify-center">
  {{ unreadCounts.get(thread.id) }}
</span>
```

- [ ] **Step 3: Sort threads by last activity**

In the template or a computed property, sort threads so most recently active appear first:

```typescript
const sortedThreads = computed(() =>
  [...threads.value].sort((a, b) => {
    // Main thread always first
    if (a.routing_mode === 'coordinated' && a.name === 'General') return -1;
    if (b.routing_mode === 'coordinated' && b.name === 'General') return 1;
    // Then by last message time (most recent first)
    return (b.last_message_at || '').localeCompare(a.last_message_at || '');
  })
);
```

Use `sortedThreads` in the `v-for` instead of raw `threads`.

- [ ] **Step 4: Build and verify**

```bash
cd /home/ellie/ellie-home && bun run build
```

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-home
git add app/components/thread/ThreadSelector.vue
git commit -m "[ELLIE-1468] thread selector unread badges and last-activity sort"
```

---

### Task 5: Thread switching loads messages from server

**Files:**
- Modify: `app/composables/useEllieChat.ts`

**Context:** Currently, thread switching only swaps sessionStorage buckets. After Phase 1A, the backend can serve messages by `thread_id`. We need to fetch from the server when switching threads.

- [ ] **Step 1: Add server-side message fetch**

In `useEllieChat.ts`, find the `switchChannel` function (around line 139). Add a server fetch path:

```typescript
async function fetchThreadMessages(threadId: string): Promise<EllieChatMessage[]> {
  try {
    const res = await fetch(`/api/messages?thread_id=${threadId}&limit=50&channel=ellie-chat`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data as any[]).map(m => ({
      id: m.id,
      role: m.role,
      text: m.content,
      agent: m.metadata?.agent || 'general',
      contributors: m.metadata?.contributors,
      ts: new Date(m.created_at).getTime(),
      thread_id: m.thread_id,
    }));
  } catch {
    return [];
  }
}
```

Note: Check if the dashboard already has a `/api/messages` proxy endpoint. If not, you may need to query Supabase directly using the Supabase client, or add a simple API route in ellie-home's `server/api/`.

- [ ] **Step 2: Update switchChannel to fetch from server**

Modify `switchChannel` to fetch server messages when switching, falling back to sessionStorage:

```typescript
async function switchChannel(targetChannelId: string) {
  // Save current messages
  saveMessages(currentChannelId);
  currentChannelId = targetChannelId;
  
  // Try server fetch first (Phase 1A thread isolation)
  const serverMessages = await fetchThreadMessages(targetChannelId);
  if (serverMessages.length > 0) {
    messages.value.splice(0, messages.value.length, ...serverMessages);
  } else {
    // Fall back to sessionStorage
    const cached = loadMessages(targetChannelId);
    messages.value.splice(0, messages.value.length, ...cached);
  }
  
  // Clear transient state
  typing.value = false;
  pendingConfirms.value = [];
  pendingToolApprovals.value = [];
}
```

- [ ] **Step 3: Send thread_id on WebSocket auth for catch-up**

Find the auth handshake in `useEllieChat.ts` (where `{ type: 'auth', key, since }` is sent). Add the active thread_id:

```typescript
ws.send(JSON.stringify({
  type: 'auth',
  key: authKey,
  since: lastReceivedTs,
  thread_id: currentChannelId || undefined,  // Phase 1A catch-up filtering
}));
```

- [ ] **Step 4: Build and verify**

```bash
cd /home/ellie/ellie-home && bun run build
```

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-home
git add app/composables/useEllieChat.ts
git commit -m "[ELLIE-1465] thread switching fetches messages from server, auth sends thread_id"
```

---

### Task 6: Clean up dead UI code

**Files:**
- Modify: `app/pages/ellie-chat.vue`

- [ ] **Step 1: Remove channel sidebar references if unused in template**

Search `ellie-chat.vue` for:
- `ChannelSidebar` — if not in the template, leave the import (other pages may use it)
- `showCreateChannel` — if the channel create modal is still in the template, consider keeping or removing
- `useActiveMode` — should already be removed in Task 1

- [ ] **Step 2: Update "New Chat" button to "New Thread"**

Find the "New Chat" button (around line 17):

```html
<button @click="startNewChat" ...>New Chat</button>
```

Rename to "New Thread":

```html
<button @click="startNewChat" ...>New Thread</button>
```

The function can keep its name internally — it's the user-facing label that matters.

- [ ] **Step 3: Build and verify**

```bash
cd /home/ellie/ellie-home && bun run build
```

- [ ] **Step 4: Commit**

```bash
cd /home/ellie/ellie-home
git add app/pages/ellie-chat.vue
git commit -m "[ELLIE-1469] clean up dead UI — rename New Chat to New Thread, remove orphaned refs"
```

---

## Notes for Implementers

### Build and deploy
After each task: `cd /home/ellie/ellie-home && bun run build`. The dashboard is a Nuxt SSR app. After building, restart the service: `sudo systemctl restart ellie-dashboard`. Tell Dave to hard-refresh (`Ctrl+Shift+R`).

### Tailwind v4 constraint
Tailwind v4 does NOT support `@apply` in Vue SFC `<style>` blocks. Use plain CSS or inline Tailwind classes in the template.

### Message type
The `EllieChatMessage` type in `useEllieChat.ts` may need `contributors?: string[]` and `agent?: string` added if they're not already there. Check the type definition before adding template references.

### Server-side message fetch
The dashboard may not have a direct `/api/messages` endpoint. Options:
1. Use the Supabase client directly in the composable (the dashboard already has Supabase configured)
2. Add a `server/api/messages.get.ts` Nuxt server route that proxies to Supabase
3. Use the relay API if it has a message listing endpoint

Check what's available before implementing Task 5.

### Workshop card detection
Workshop messages are identified by `msg.agent === 'workshop'` in the metadata. This is set by the Workshop debrief API (`src/api/workshop.ts`). The card component parses the markdown content to extract title, summary, and stats.
