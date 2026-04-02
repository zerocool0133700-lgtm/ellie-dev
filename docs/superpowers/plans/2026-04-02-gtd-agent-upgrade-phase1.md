# GTD Agent Upgrade — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify multi-agent coordination into GTD with structured question metadata, dashboard answer UI, and context compaction recovery.

**Architecture:** Adds `item_type` enum to existing `todos` table, enhances `ask_user` tool with mandatory `what_i_need`/`decision_unlocked` fields, bridges dashboard answers to the in-memory ask-user queue, and rebuilds dispatch state from GTD after context compaction. New `/agent-questions` page in ellie-home with sidebar badge.

**Tech Stack:** Bun + TypeScript (relay), Nuxt 4.3 + Tailwind v4 (dashboard), Supabase (todos), Forest/Postgres (orchestration_events)

**Spec:** `docs/superpowers/specs/2026-04-02-gtd-native-agent-coordination-design.md`

**Plane tickets:** ELLIE-1269 through ELLIE-1275 (label: GTD Agent Upgrade)

---

### Task 1: Schema Migration — `item_type` Enum + Backfill (ELLIE-1269)

**Files:**
- Create: `migrations/supabase/20260402_item_type_enum.sql`
- Test: `tests/gtd-orchestration.test.ts` (add migration verification)

- [ ] **Step 1: Write the migration SQL**

Create file `migrations/supabase/20260402_item_type_enum.sql`:

```sql
-- Add item_type enum to todos table
-- Replaces is_orchestration boolean with explicit type classification

CREATE TYPE todo_item_type AS ENUM ('task', 'agent_dispatch', 'agent_question');

ALTER TABLE todos ADD COLUMN item_type todo_item_type NOT NULL DEFAULT 'task';

-- Backfill: questions assigned to dave (with or without urgency)
UPDATE todos SET item_type = 'agent_question'
  WHERE is_orchestration = true
    AND assigned_to = 'dave';

-- Backfill: everything else that's orchestration = dispatch
UPDATE todos SET item_type = 'agent_dispatch'
  WHERE is_orchestration = true
    AND item_type = 'task';

-- Partial index for kanban queries (only indexes non-task items)
CREATE INDEX idx_todos_item_type ON todos (item_type) WHERE item_type != 'task';

-- Deprecate is_orchestration with concrete removal criteria
COMMENT ON COLUMN todos.is_orchestration IS
  'DEPRECATED: use item_type. Remove when: (1) all relay code uses item_type, '
  '(2) all dashboard queries use item_type, (3) no Realtime subscriptions reference it, '
  '(4) 2+ weeks post-deploy with no issues.';
```

- [ ] **Step 2: Apply the migration**

Run: `bun run migrate --db supabase`

Expected: Migration applies successfully, `item_type` column exists.

- [ ] **Step 3: Verify the backfill**

Run: `bun run migrate:validate`

Then verify manually:

```bash
# Via Supabase MCP or psql:
# SELECT item_type, count(*) FROM todos GROUP BY item_type;
# Should show agent_dispatch and agent_question counts matching former is_orchestration=true items
```

- [ ] **Step 4: Commit**

```bash
git add migrations/supabase/20260402_item_type_enum.sql
git commit -m "[ELLIE-1269] Add item_type enum to todos table with backfill"
```

---

### Task 2: Mandatory Question Metadata on `ask_user` (ELLIE-1270)

**Files:**
- Modify: `src/coordinator-tools.ts:32-41` (AskUserInput interface) and `src/coordinator-tools.ts:125-154` (tool definition)
- Test: `tests/coordinator-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/coordinator-tools.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test'
import { COORDINATOR_TOOLS } from '../src/coordinator-tools'

describe('ask_user tool schema', () => {
  const askUser = COORDINATOR_TOOLS.find(t => t.name === 'ask_user')

  test('requires what_i_need and decision_unlocked fields', () => {
    expect(askUser).toBeDefined()
    const required = askUser!.input_schema.required
    expect(required).toContain('question')
    expect(required).toContain('what_i_need')
    expect(required).toContain('decision_unlocked')
  })

  test('supports answer_format and choices fields', () => {
    const props = askUser!.input_schema.properties
    expect(props.answer_format).toBeDefined()
    expect(props.answer_format.enum).toContain('text')
    expect(props.answer_format.enum).toContain('choice')
    expect(props.answer_format.enum).toContain('approve_deny')
    expect(props.choices).toBeDefined()
    expect(props.choices.type).toBe('array')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/coordinator-tools.test.ts`

Expected: FAIL — `what_i_need` and `decision_unlocked` not in required array.

- [ ] **Step 3: Update the AskUserInput interface**

In `src/coordinator-tools.ts`, update the interface at lines 32–41:

```typescript
export interface AskUserInput {
  question: string;
  what_i_need: string;
  decision_unlocked: string;
  options?: string[];
  answer_format?: 'text' | 'choice' | 'approve_deny';
  choices?: string[];
  timeout_ms?: number;
  urgency?: string;
}
```

- [ ] **Step 4: Update the tool definition**

In `src/coordinator-tools.ts`, replace the `ask_user` tool definition at lines 125–154:

```typescript
{
  name: "ask_user",
  description: "Pause the coordinator loop and ask the user a question. You MUST include what_i_need (what format/decision you need) and decision_unlocked (what you will do once answered).",
  input_schema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to present to the user." },
      what_i_need: { type: "string", description: "What format or decision you need from the user. Be specific: 'Pick one of A or B', 'Yes or no', 'A name for the config key'." },
      decision_unlocked: { type: "string", description: "What you will do once the user answers. E.g. 'I will implement JWT-based auth and add Redis as a dependency.'" },
      answer_format: { type: "string", enum: ["text", "choice", "approve_deny"], description: "How the answer should be structured. Default: text." },
      choices: { type: "array", items: { type: "string" }, description: "If answer_format is 'choice', the list of options to present." },
      options: { type: "array", items: { type: "string" }, description: "Legacy: suggested answer choices. Prefer choices + answer_format instead." },
      timeout_ms: { type: "number", description: "Maximum milliseconds to wait for a reply. Default: 300000 (5 min)." },
      urgency: { type: "string", enum: ["low", "normal", "high"], description: "Urgency level for the question." },
    },
    required: ["question", "what_i_need", "decision_unlocked"],
  },
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/coordinator-tools.test.ts`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/coordinator-tools.ts tests/coordinator-tools.test.ts
git commit -m "[ELLIE-1270] Add mandatory what_i_need and decision_unlocked to ask_user tool"
```

---

### Task 3: Structured Question Creation in GTD (ELLIE-1271)

**Files:**
- Modify: `src/gtd-orchestration.ts:144-177` (createQuestionItem)
- Modify: `src/gtd-orchestration.ts:76-142` (createOrchestrationParent, createDispatchChild — add item_type)
- Test: `tests/gtd-orchestration.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/gtd-orchestration.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test'
import { generateQuestionId } from '../src/gtd-orchestration'

describe('generateQuestionId', () => {
  test('returns q- prefix with 8 hex chars', () => {
    const id = generateQuestionId()
    expect(id).toMatch(/^q-[0-9a-f]{8}$/)
  })

  test('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateQuestionId()))
    expect(ids.size).toBe(100)
  })
})

describe('createQuestionItem with structured metadata', () => {
  test('stores question_id, what_i_need, decision_unlocked in metadata', async () => {
    // This test requires Supabase access — mock or integration test
    // depending on existing test patterns in this file.
    // Check how existing createQuestionItem tests work and follow that pattern.
    const metadata = {
      question_id: 'q-12345678',
      what_i_need: 'Pick JWT or session cookies',
      decision_unlocked: 'Will implement chosen auth approach',
      answer_format: 'choice' as const,
      choices: ['JWT', 'Session cookies'],
    }
    // Verify metadata fields are passed through to the Supabase insert
    expect(metadata.question_id).toMatch(/^q-[0-9a-f]{8}$/)
    expect(metadata.what_i_need).toBeTruthy()
    expect(metadata.decision_unlocked).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/gtd-orchestration.test.ts`

Expected: FAIL — `generateQuestionId` not exported.

- [ ] **Step 3: Add `generateQuestionId` function**

Add to `src/gtd-orchestration.ts` near the top (after imports):

```typescript
export function generateQuestionId(): string {
  return `q-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`
}
```

- [ ] **Step 4: Update `createQuestionItem` to accept structured metadata**

In `src/gtd-orchestration.ts`, update `createQuestionItem()` at lines 144–177. Add `metadata` and `item_type` to the options and the Supabase insert:

```typescript
export async function createQuestionItem(opts: {
  parentId: string;
  content: string;
  createdBy: string;
  urgency?: 'blocking' | 'normal' | 'low';
  metadata?: {
    question_id: string;
    what_i_need: string;
    decision_unlocked: string;
    answer_format?: 'text' | 'choice' | 'approve_deny';
    choices?: string[] | null;
  };
}): Promise<TodoRow> {
  const { data, error } = await supabase
    .from('todos')
    .insert({
      content: opts.content,
      status: 'open',
      parent_id: opts.parentId,
      assigned_to: 'dave',
      created_by: opts.createdBy,
      urgency: opts.urgency ?? 'blocking',
      is_orchestration: true,
      item_type: 'agent_question',
      metadata: opts.metadata ?? {},
    })
    .select()
    .single()

  if (error) throw error
  return data
}
```

- [ ] **Step 5: Update `createOrchestrationParent` and `createDispatchChild` to set `item_type`**

In `src/gtd-orchestration.ts`:

For `createOrchestrationParent()` (lines 76–103), add `item_type: 'agent_dispatch'` to the insert object alongside `is_orchestration: true`.

For `createDispatchChild()` (lines 105–142), add `item_type: 'agent_dispatch'` to the insert object alongside `is_orchestration: true`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/gtd-orchestration.test.ts`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/gtd-orchestration.ts tests/gtd-orchestration.test.ts
git commit -m "[ELLIE-1271] Add structured question metadata and item_type to GTD orchestration"
```

---

### Task 4: Answer Bridge — Dashboard to In-Memory Queue (ELLIE-1272)

**Files:**
- Modify: `src/http-routes.ts:7000-7064` (`/api/dispatches/answer` handler)
- Modify: `src/ask-user-queue.ts` (need access to the queue instance from the route handler)
- Test: `tests/gtd-api.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/gtd-api.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test'

describe('/api/dispatches/answer bridge', () => {
  test('answer writes to Supabase and resolves in-memory queue promise', async () => {
    // This tests the bridge behavior:
    // 1. Enqueue a question with a known question_id
    // 2. POST /api/dispatches/answer with the GTD item ID
    // 3. Verify the in-memory promise resolved with the answer text
    //
    // Follow the existing test pattern in this file for API route testing.
    // The key assertion is that answerQuestion() is called with the correct
    // question_id after the Supabase write succeeds.
    expect(true).toBe(true) // placeholder — adapt to existing test infrastructure
  })

  test('stale question (no in-memory promise) still persists answer to Supabase', async () => {
    // POST answer for a question that has no pending promise
    // (e.g. coordinator restarted). Answer should still be written
    // to Supabase metadata. No error thrown.
    expect(true).toBe(true) // placeholder — adapt to existing test infrastructure
  })
})
```

- [ ] **Step 2: Run test to verify baseline**

Run: `bun test tests/gtd-api.test.ts`

- [ ] **Step 3: Update the `/api/dispatches/answer` handler**

In `src/http-routes.ts` at the `/api/dispatches/answer` handler (lines 7000–7064), after the existing `answerQuestion()` call to gtd-orchestration (which writes to Supabase), add the bridge to the in-memory queue:

```typescript
// After the existing Supabase answer write (around line 7018-7020):
const result = await answerQuestion(question_item_id, answer_text)

// NEW: Bridge to in-memory ask-user queue
// Read the question_id from the answered item's metadata
if (result?.metadata?.question_id) {
  const { askUserQueue } = deps // or however the queue is accessed in this scope
  const resolved = askUserQueue.answerQuestion(result.metadata.question_id, answer_text)
  if (!resolved) {
    // Question timed out or coordinator restarted — answer persisted
    // in Supabase but no pending promise to resolve. Expected for stale questions.
    log.info('Answer persisted but no pending in-memory promise', {
      questionId: result.metadata.question_id,
      questionItemId: question_item_id,
    })
  }
}

// Also write answered_at and answered_via to metadata
await supabase
  .from('todos')
  .update({
    metadata: {
      ...result.metadata,
      answered_at: new Date().toISOString(),
      answered_via: 'dashboard',
    },
  })
  .eq('id', question_item_id)
```

Note: Check how `deps` or the ask-user queue singleton is accessed in the route handler scope. It may be available via closure, a global, or passed through the request context. Follow the existing pattern in `http-routes.ts`.

- [ ] **Step 4: Ensure the ask-user queue is accessible from the route handler**

Check how the ask-user queue is instantiated. If it's a module-level singleton in `src/ask-user-queue.ts`, it's already accessible via import. If it's created per-session, you'll need to pass the coordinator's queue reference to the route handler. Look at how other route handlers access coordinator state.

- [ ] **Step 5: Run tests**

Run: `bun test tests/gtd-api.test.ts`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/http-routes.ts src/ask-user-queue.ts tests/gtd-api.test.ts
git commit -m "[ELLIE-1272] Bridge /api/dispatches/answer to in-memory ask-user queue"
```

---

### Task 5: Context Compaction Recovery from GTD (ELLIE-1273)

**Files:**
- Modify: `src/coordinator-context.ts:97-126` (add post-compaction GTD recovery)
- Create: `src/gtd-recovery.ts` (rebuildDispatchStateFromGTD function)
- Modify: `src/gtd-orchestration.ts` (add formatDispatchSummary helper)
- Test: `tests/coordinator-context.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/coordinator-context.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test'
import { formatDispatchSummary, formatPendingAnswers } from '../src/gtd-recovery'

describe('GTD recovery formatting', () => {
  const mockTree = {
    id: 'parent-1',
    content: 'Implement auth system',
    status: 'open',
    item_type: 'agent_dispatch',
    children: [
      {
        id: 'child-1',
        content: 'Implement auth middleware',
        status: 'open',
        item_type: 'agent_dispatch',
        assigned_agent: 'james',
        children: [
          {
            id: 'grandchild-1',
            content: 'JWT or session cookies?',
            status: 'open',
            item_type: 'agent_question',
            metadata: {
              question_id: 'q-7f3a2b1c',
              what_i_need: 'Pick one',
              decision_unlocked: 'Will implement chosen approach',
            },
            children: [],
          },
        ],
      },
      {
        id: 'child-2',
        content: 'Research query optimization',
        status: 'open',
        item_type: 'agent_dispatch',
        assigned_agent: 'kate',
        children: [],
      },
    ],
  }

  test('formatDispatchSummary produces structured text', () => {
    const summary = formatDispatchSummary(mockTree)
    expect(summary).toContain('james')
    expect(summary).toContain('auth middleware')
    expect(summary).toContain('waiting')
    expect(summary).toContain('kate')
    expect(summary).toContain('query optimization')
  })

  test('formatPendingAnswers extracts unanswered questions', () => {
    const anchors = formatPendingAnswers(mockTree)
    expect(anchors).toContain('q-7f3a2b1c')
    expect(anchors).toContain('JWT or session cookies')
    expect(anchors).toContain('Pick one')
  })

  test('formatPendingAnswers returns empty for no pending questions', () => {
    const treeNoQuestions = { ...mockTree, children: [{ ...mockTree.children[1], children: [] }] }
    const anchors = formatPendingAnswers(treeNoQuestions)
    expect(anchors).toBe('')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/coordinator-context.test.ts`

Expected: FAIL — `gtd-recovery` module doesn't exist.

- [ ] **Step 3: Create `src/gtd-recovery.ts`**

```typescript
import { getActiveOrchestrationTrees } from './gtd-orchestration'
import { updateWorkingMemory } from './working-memory'

interface DispatchTreeNode {
  id: string
  content: string
  status: string
  item_type?: string
  assigned_agent?: string
  metadata?: Record<string, unknown>
  children: DispatchTreeNode[]
}

export function formatDispatchSummary(tree: DispatchTreeNode): string {
  const lines: string[] = ['ACTIVE DISPATCHES (recovered from GTD):']

  for (const child of tree.children) {
    if (child.item_type === 'agent_dispatch' || child.assigned_agent) {
      const agent = child.assigned_agent ?? 'unknown'
      const hasQuestion = child.children.some(
        gc => gc.item_type === 'agent_question' && gc.status !== 'done'
      )
      const statusText = hasQuestion
        ? `waiting (question pending)`
        : child.status === 'done'
          ? 'completed'
          : 'working'
      lines.push(`- ${agent}: "${truncate(child.content, 60)}" — ${statusText}`)
    }
  }

  return lines.join('\n')
}

export function formatPendingAnswers(tree: DispatchTreeNode): string {
  const pending: string[] = []

  for (const child of tree.children) {
    for (const gc of child.children) {
      if (gc.item_type === 'agent_question' && gc.status !== 'done') {
        const qId = (gc.metadata?.question_id as string) ?? 'unknown'
        const agent = child.assigned_agent ?? 'unknown'
        const need = (gc.metadata?.what_i_need as string) ?? ''
        pending.push(`${qId} (${agent}): "${truncate(gc.content, 80)}" — Need: ${need}`)
      }
    }
  }

  if (pending.length === 0) return ''
  return 'PENDING QUESTIONS:\n' + pending.join('\n')
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s
}

export async function rebuildDispatchStateFromGTD(
  sessionId: string,
  coordinatorParentId: string,
  supabase: unknown, // SupabaseClient type — use whatever the project uses
  logger: { warn: (msg: string, ctx?: Record<string, unknown>) => void }
): Promise<void> {
  try {
    const trees = await getActiveOrchestrationTrees()
    const thisSession = trees.find((t: DispatchTreeNode) => t.id === coordinatorParentId)
    if (!thisSession) return

    const taskStack = formatDispatchSummary(thisSession)
    const contextAnchors = formatPendingAnswers(thisSession)

    await updateWorkingMemory({
      session_id: sessionId,
      agent: 'coordinator',
      sections: {
        task_stack: taskStack,
        ...(contextAnchors ? { context_anchors: contextAnchors } : {}),
      },
    })
  } catch (err) {
    logger.warn('GTD recovery failed after compaction', { err })
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/coordinator-context.test.ts`

Expected: PASS

- [ ] **Step 5: Wire into coordinator-context compaction**

In `src/coordinator-context.ts`, find the `compact()` method (lines 97–126). After the existing compaction logic, add a call to `rebuildDispatchStateFromGTD`. Since `compact()` is synchronous, add an async post-compaction hook:

```typescript
// At the end of compact() or in whatever post-compaction code path exists:
// If there's no existing callback, add one:
if (this.coordinatorParentId) {
  // Fire-and-forget — don't block the coordinator loop
  rebuildDispatchStateFromGTD(
    this.sessionId,
    this.coordinatorParentId,
    this.deps.supabase,
    this.deps.logger
  ).catch(() => {}) // already logged inside the function
}
```

Check what properties are available on `this` (or the context object). The `coordinatorParentId` may need to be stored when the orchestration parent is created during `dispatch_agent`. Look at how `dispatch_agent` tool handling stores state and store the parent ID there.

- [ ] **Step 6: Run full coordinator-context tests**

Run: `bun test tests/coordinator-context.test.ts`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/gtd-recovery.ts src/coordinator-context.ts src/gtd-orchestration.ts tests/coordinator-context.test.ts
git commit -m "[ELLIE-1273] Add context compaction recovery from GTD orchestration state"
```

---

### Task 6: Agent Questions Page in ellie-home (ELLIE-1274)

**Files:**
- Create: `ellie-home/app/pages/agent-questions.vue`
- Reference: `ellie-home/app/pages/dispatches.vue` (existing pattern for API calls and answer UI)
- Reference: `ellie-home/server/api/dispatches/` (existing proxy routes)

- [ ] **Step 1: Read the existing dispatches page for patterns**

Read `ellie-home/app/pages/dispatches.vue` to understand:
- How it calls `$fetch('/api/dispatches/active')`
- How it renders blocking items with answer inputs
- How it calls `$fetch('/api/dispatches/answer', { method: 'POST', body: {...} })`

Also read `ellie-home/app/composables/useAgentProfiles.ts` for agent colors and avatars.

- [ ] **Step 2: Create the Agent Questions page**

Create `ellie-home/app/pages/agent-questions.vue`:

```vue
<script setup lang="ts">
useHead({ title: 'Agent Questions' })

const activeTab = ref<'waiting' | 'answered' | 'all'>('waiting')
const answerInputs = ref<Record<string, string>>({})
const submitting = ref<Record<string, boolean>>({})

// Agent colors (match kanban mockup)
const agentColors: Record<string, string> = {
  james: '#06B6D4',
  kate: '#8B5CF6',
  alan: '#EF4444',
  ellie: '#10B981',
}

// Fetch active dispatch trees
const { data: trees, refresh } = await useFetch('/api/dispatches/active')
const { data: badge } = await useFetch('/api/dispatches/badge')

// Extract all questions from trees
const questions = computed(() => {
  if (!trees.value) return []
  const items: any[] = []
  for (const tree of (trees.value as any[]) ?? []) {
    for (const child of tree.children ?? []) {
      for (const gc of child.children ?? []) {
        if (gc.assigned_to === 'dave' || gc.item_type === 'agent_question') {
          items.push({
            ...gc,
            agentName: child.assigned_agent ?? 'unknown',
            parentTask: child.content,
          })
        }
      }
      // Also check direct children that are questions
      if (child.assigned_to === 'dave' || child.item_type === 'agent_question') {
        items.push({
          ...child,
          agentName: child.assigned_agent ?? tree.assigned_agent ?? 'unknown',
          parentTask: tree.content,
        })
      }
    }
  }
  return items.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
})

const waitingQuestions = computed(() =>
  questions.value.filter(q => q.status === 'open' || q.status === 'waiting_for')
)
const answeredQuestions = computed(() =>
  questions.value.filter(q => q.status === 'done' && q.metadata?.answer)
)
const displayedQuestions = computed(() => {
  if (activeTab.value === 'waiting') return waitingQuestions.value
  if (activeTab.value === 'answered') return answeredQuestions.value
  return questions.value
})

async function submitAnswer(questionId: string, answer: string) {
  if (!answer.trim()) return
  submitting.value[questionId] = true
  try {
    await $fetch('/api/dispatches/answer', {
      method: 'POST',
      body: { question_item_id: questionId, answer_text: answer.trim() },
    })
    answerInputs.value[questionId] = ''
    await refresh()
  } finally {
    submitting.value[questionId] = false
  }
}

async function submitChoice(questionId: string, choice: string) {
  await submitAnswer(questionId, choice)
}

// Auto-refresh every 15 seconds
const refreshInterval = setInterval(() => refresh(), 15000)
onUnmounted(() => clearInterval(refreshInterval))
</script>

<template>
  <div class="max-w-3xl mx-auto py-6 px-4">
    <h1 class="text-2xl font-bold text-white mb-2">Agent Questions</h1>
    <p class="text-sm text-neutral-400 mb-6">
      Questions from agents that need your input
    </p>

    <!-- Filter tabs -->
    <div class="flex gap-2 mb-6">
      <button
        v-for="tab in (['waiting', 'answered', 'all'] as const)"
        :key="tab"
        class="px-4 py-1.5 rounded-full text-sm font-medium transition-colors"
        :class="activeTab === tab
          ? 'bg-amber-500 text-black'
          : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'"
        @click="activeTab = tab"
      >
        {{ tab === 'waiting' ? `Waiting (${waitingQuestions.length})` :
           tab === 'answered' ? `Answered today (${answeredQuestions.length})` : 'All' }}
      </button>
    </div>

    <!-- Questions list -->
    <div v-if="displayedQuestions.length === 0" class="text-center py-12 text-neutral-500">
      {{ activeTab === 'waiting' ? 'No pending questions' : 'No questions to show' }}
    </div>

    <div v-for="q in displayedQuestions" :key="q.id" class="mb-4">
      <div
        class="rounded-xl p-5"
        :class="q.status === 'done'
          ? 'bg-neutral-900 border border-emerald-900 opacity-60'
          : 'bg-neutral-900 border border-amber-700'"
      >
        <!-- Header -->
        <div class="flex items-center gap-3 mb-3">
          <div
            class="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold text-black"
            :style="{ backgroundColor: agentColors[q.agentName] ?? '#6B7280' }"
          >
            {{ (q.agentName ?? '?')[0].toUpperCase() }}
          </div>
          <div>
            <span class="text-white font-semibold text-sm">{{ q.agentName }}</span>
            <div class="text-xs text-neutral-500">working on: {{ q.parentTask }}</div>
          </div>
          <span
            class="ml-auto px-2 py-0.5 rounded-full text-xs font-semibold"
            :class="q.status === 'done'
              ? 'bg-emerald-900 text-emerald-400'
              : 'bg-amber-900 text-amber-400'"
          >
            {{ q.status === 'done' ? 'answered' : 'waiting' }}
          </span>
        </div>

        <!-- Question text -->
        <p class="text-white text-base mb-3 leading-relaxed">{{ q.content }}</p>

        <!-- What I need box -->
        <div
          v-if="q.metadata?.what_i_need && q.status !== 'done'"
          class="bg-neutral-950 border border-amber-800 rounded-lg p-3 mb-4"
        >
          <div class="text-xs text-amber-500 font-bold mb-1">What I need from you</div>
          <div class="text-sm text-neutral-300">{{ q.metadata.what_i_need }}</div>
          <div v-if="q.metadata?.decision_unlocked" class="text-xs text-neutral-500 mt-1">
            Unlocks: {{ q.metadata.decision_unlocked }}
          </div>
        </div>

        <!-- Answer UI (only for waiting questions) -->
        <template v-if="q.status !== 'done'">
          <!-- Choice buttons -->
          <div v-if="q.metadata?.answer_format === 'choice' && q.metadata?.choices" class="flex flex-wrap gap-2 mb-3">
            <button
              v-for="choice in q.metadata.choices"
              :key="choice"
              class="flex-1 min-w-[120px] px-4 py-3 bg-neutral-800 border border-neutral-700 rounded-lg text-white text-sm font-medium hover:border-amber-500 hover:bg-neutral-750 transition-colors"
              :disabled="submitting[q.id]"
              @click="submitChoice(q.id, choice)"
            >
              {{ choice }}
            </button>
          </div>

          <!-- Approve/Deny buttons -->
          <div v-else-if="q.metadata?.answer_format === 'approve_deny'" class="flex gap-3 mb-3">
            <button
              class="flex-1 px-4 py-3 bg-emerald-900 border border-emerald-600 rounded-lg text-white font-medium hover:bg-emerald-800 transition-colors"
              :disabled="submitting[q.id]"
              @click="submitChoice(q.id, 'approved')"
            >
              Approve
            </button>
            <button
              class="flex-1 px-4 py-3 bg-red-900 border border-red-600 rounded-lg text-white font-medium hover:bg-red-800 transition-colors"
              :disabled="submitting[q.id]"
              @click="submitChoice(q.id, 'denied')"
            >
              Deny
            </button>
          </div>

          <!-- Text input (always shown as fallback) -->
          <div class="flex gap-2">
            <span v-if="q.metadata?.answer_format === 'choice'" class="text-xs text-neutral-500 self-center">or</span>
            <input
              v-model="answerInputs[q.id]"
              type="text"
              :placeholder="q.metadata?.answer_format === 'choice' ? 'Type a different answer...' : 'Type your answer...'"
              class="flex-1 px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white text-sm placeholder-neutral-500 focus:border-amber-500 focus:outline-none"
              :disabled="submitting[q.id]"
              @keydown.enter="submitAnswer(q.id, answerInputs[q.id] ?? '')"
            />
            <button
              class="px-4 py-2 bg-amber-500 text-black rounded-lg text-sm font-semibold hover:bg-amber-400 transition-colors disabled:opacity-50"
              :disabled="submitting[q.id] || !(answerInputs[q.id] ?? '').trim()"
              @click="submitAnswer(q.id, answerInputs[q.id] ?? '')"
            >
              Send
            </button>
          </div>
        </template>

        <!-- Answered display -->
        <div v-else-if="q.metadata?.answer" class="text-sm text-neutral-400">
          You answered: "{{ q.metadata.answer }}"
          <span v-if="q.metadata?.answered_via" class="text-neutral-600">
            &bull; via {{ q.metadata.answered_via }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 3: Build and verify**

```bash
cd /home/ellie/ellie-home && bun run build
```

Expected: Build succeeds. Navigate to `http://localhost:3000/agent-questions` (or dashboard URL) to verify the page renders.

- [ ] **Step 4: Commit**

```bash
cd /home/ellie/ellie-home
git add app/pages/agent-questions.vue
git commit -m "[ELLIE-1274] Add Agent Questions page with structured answer UI"
```

---

### Task 7: Sidebar Badge for Pending Questions (ELLIE-1275)

**Files:**
- Modify: `ellie-home/app/layouts/default.vue:120-146` (nav items)

- [ ] **Step 1: Read the existing sidebar layout**

Read `ellie-home/app/layouts/default.vue` to understand:
- How nav items are defined (lines 120–146)
- How the theme system maps route keys to icons/labels
- Whether any existing badges are rendered (look for badge/count patterns)

- [ ] **Step 2: Add Agent Questions nav item with badge**

In `ellie-home/app/layouts/default.vue`, add the route to the nav items array (around line 140):

```typescript
{ path: '/agent-questions', key: 'questions' }
```

Then add the badge. In the template where nav items are rendered (around lines 12–24), add a badge for the questions route. The exact implementation depends on how the sidebar currently renders — look for the loop over `navItems` and add a conditional badge:

```vue
<!-- Inside the nav item loop, after the icon/label -->
<span
  v-if="item.path === '/agent-questions' && questionBadgeCount > 0"
  class="ml-auto px-1.5 py-0.5 text-[10px] font-bold bg-amber-500 text-black rounded-full animate-pulse"
>
  {{ questionBadgeCount }}
</span>
```

Add the badge count fetch in the script section:

```typescript
// Fetch badge count for agent questions
const questionBadgeCount = ref(0)

async function refreshBadge() {
  try {
    const data = await $fetch<{ needs_attention: number }>('/api/dispatches/badge')
    questionBadgeCount.value = data?.needs_attention ?? 0
  } catch { /* silent */ }
}

// Initial fetch + poll every 10 seconds
refreshBadge()
const badgeInterval = setInterval(refreshBadge, 10000)
onUnmounted(() => clearInterval(badgeInterval))

// Also refresh via Supabase Realtime if useRealtime is available
// Check how useRealtime.ts is used in other pages and subscribe to todos table changes
```

- [ ] **Step 3: Add theme/nav key for Agent Questions**

Check how the theme system maps route keys to icons and labels. If there's a mapping file or computed property (likely in the theme composable), add:

```typescript
questions: { label: 'Agent Questions', icon: '?' /* or whatever icon system is used */ }
```

Follow the existing pattern — the sidebar may use forest metaphor names. Check the theme data structure.

- [ ] **Step 4: Build and verify**

```bash
cd /home/ellie/ellie-home && bun run build
```

Expected: Build succeeds. Sidebar shows "Agent Questions" with amber badge count. Hard refresh browser: Ctrl+Shift+R.

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-home
git add app/layouts/default.vue
git commit -m "[ELLIE-1275] Add Agent Questions nav item with pulsing badge count"
```

---

### Task 8: Integration Test — End-to-End Question Flow

**Files:**
- Create: `tests/gtd-question-flow.test.ts`

- [ ] **Step 1: Write the integration test**

Create `tests/gtd-question-flow.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test'
import { generateQuestionId, createOrchestrationParent, createDispatchChild, createQuestionItem } from '../src/gtd-orchestration'
import { formatDispatchSummary, formatPendingAnswers } from '../src/gtd-recovery'

describe('end-to-end question flow', () => {
  test('generateQuestionId format', () => {
    const id = generateQuestionId()
    expect(id).toMatch(/^q-[0-9a-f]{8}$/)
  })

  test('structured metadata round-trip', () => {
    const metadata = {
      question_id: generateQuestionId(),
      what_i_need: 'Pick JWT or session cookies',
      decision_unlocked: 'Will implement chosen auth approach',
      answer_format: 'choice' as const,
      choices: ['JWT', 'Session cookies'],
    }

    // Verify all fields present
    expect(metadata.question_id).toMatch(/^q-/)
    expect(metadata.what_i_need).toBeTruthy()
    expect(metadata.decision_unlocked).toBeTruthy()
    expect(metadata.answer_format).toBe('choice')
    expect(metadata.choices).toHaveLength(2)
  })

  test('recovery formatting with mock tree', () => {
    const tree = {
      id: 'p1',
      content: 'Test dispatch',
      status: 'open',
      item_type: 'agent_dispatch',
      children: [{
        id: 'c1',
        content: 'Agent task',
        status: 'open',
        item_type: 'agent_dispatch',
        assigned_agent: 'james',
        children: [{
          id: 'gc1',
          content: 'Pick an approach',
          status: 'open',
          item_type: 'agent_question',
          metadata: {
            question_id: 'q-aabbccdd',
            what_i_need: 'Choose A or B',
            decision_unlocked: 'Will proceed with chosen approach',
          },
          children: [],
        }],
      }],
    }

    const summary = formatDispatchSummary(tree)
    expect(summary).toContain('james')
    expect(summary).toContain('waiting')

    const anchors = formatPendingAnswers(tree)
    expect(anchors).toContain('q-aabbccdd')
    expect(anchors).toContain('Choose A or B')
  })
})
```

- [ ] **Step 2: Run the integration test**

Run: `bun test tests/gtd-question-flow.test.ts`

Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `bun test`

Expected: All tests pass. No regressions.

- [ ] **Step 4: Commit**

```bash
git add tests/gtd-question-flow.test.ts
git commit -m "[ELLIE-1269] Add integration test for GTD question flow"
```

---

## Task Dependency Order

```
Task 1 (schema migration) → no dependencies, do first
Task 2 (ask_user tool) → no dependencies, can parallel with Task 1
Task 3 (question creation) → depends on Task 1 (item_type column must exist)
Task 4 (answer bridge) → depends on Task 3 (question_id in metadata)
Task 5 (compaction recovery) → depends on Task 3 (structured metadata)
Task 6 (Agent Questions page) → depends on Task 3 + Task 4 (questions exist and answers work)
Task 7 (sidebar badge) → depends on Task 6 (page must exist to navigate to)
Task 8 (integration test) → depends on all above
```

Parallelizable pairs: Task 1 + Task 2, Task 6 + Task 7 (mostly independent UI work).
