# GTD Agent Upgrade — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Telegram question disambiguation, progress event throttling with API, kanban agent card rendering, and end-to-end integration test.

**Architecture:** Telegram questions get tagged with short IDs and routed via reply-to-message or fallback disambiguation. Progress events flow from the relay through a throttle buffer to Forest's `orchestration_events` table, exposed via a new API endpoint. Kanban cards differentiate agent items visually. Integration test validates the full question lifecycle.

**Tech Stack:** Bun + TypeScript (relay), Nuxt 4.3 + Tailwind v4 (dashboard), Forest/Postgres (orchestration_events)

**Spec:** `docs/superpowers/specs/2026-04-02-gtd-native-agent-coordination-design.md` + `docs/superpowers/specs/2026-04-02-telegram-question-disambiguation-design.md`

**Plane tickets:** ELLIE-1276, ELLIE-1277, ELLIE-1278, ELLIE-1295

---

### Task 1: Telegram Question Tagging (ELLIE-1276 Part 1)

**Files:**
- Modify: `src/ellie-chat-handler.ts` (where coordinator ask_user questions get sent to Telegram)
- Modify: `src/ask-user-queue.ts` (add `questionId` and `telegramMessageId` to PendingQuestion)
- Test: `tests/telegram-disambiguation.test.ts` (new)

- [ ] **Step 1: Write failing test for question message formatting**

Create `tests/telegram-disambiguation.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test'
import { formatQuestionMessage } from '../src/telegram-question-format'

describe('formatQuestionMessage', () => {
  test('includes agent name and question ID', () => {
    const msg = formatQuestionMessage({
      agentName: 'james',
      questionId: 'q-7f3a2b1c',
      question: 'Should we use JWT or session cookies?',
      whatINeed: 'Pick one — this decides the session store.',
      decisionUnlocked: 'Session store implementation',
    })
    expect(msg).toContain('james asks (q-7f3a)')
    expect(msg).toContain('Should we use JWT or session cookies?')
    expect(msg).toContain('What I need:')
    expect(msg).toContain('Pick one')
    expect(msg).toContain('Unlocks:')
  })

  test('includes choices when provided', () => {
    const msg = formatQuestionMessage({
      agentName: 'kate',
      questionId: 'q-aabbccdd',
      question: 'Which approach?',
      whatINeed: 'Choose one',
      decisionUnlocked: 'Will proceed',
      choices: ['Option A', 'Option B'],
    })
    expect(msg).toContain('1. Option A')
    expect(msg).toContain('2. Option B')
  })

  test('displays short ID (first 4 hex chars)', () => {
    const msg = formatQuestionMessage({
      agentName: 'alan',
      questionId: 'q-deadbeef',
      question: 'Test?',
      whatINeed: 'Answer',
      decisionUnlocked: 'Next step',
    })
    expect(msg).toContain('q-dead')
    expect(msg).not.toContain('q-deadbeef')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/telegram-disambiguation.test.ts`

Expected: FAIL — module `telegram-question-format` not found.

- [ ] **Step 3: Create `src/telegram-question-format.ts`**

```typescript
/**
 * Telegram Question Formatting — ELLIE-1276
 *
 * Formats coordinator ask_user questions for Telegram display
 * with agent name, short question ID, and structured metadata.
 */

interface QuestionFormatInput {
  agentName: string
  questionId: string
  question: string
  whatINeed: string
  decisionUnlocked: string
  choices?: string[]
}

/**
 * Format a question for Telegram display.
 * Shows short question ID (first 4 hex chars after q-) for readability.
 */
export function formatQuestionMessage(input: QuestionFormatInput): string {
  const shortId = input.questionId.slice(0, 6) // "q-7f3a" from "q-7f3a2b1c"
  const lines: string[] = [
    `${input.agentName} asks (${shortId}):`,
    input.question,
    '',
    `What I need: ${input.whatINeed}`,
    `Unlocks: ${input.decisionUnlocked}`,
  ]

  if (input.choices && input.choices.length > 0) {
    lines.push('')
    input.choices.forEach((c, i) => lines.push(`${i + 1}. ${c}`))
  }

  return lines.join('\n')
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/telegram-disambiguation.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/telegram-question-format.ts tests/telegram-disambiguation.test.ts
git commit -m "[ELLIE-1276] Add Telegram question formatting with agent name and short ID"
```

---

### Task 2: Disambiguation Algorithm (ELLIE-1276 Part 2)

**Files:**
- Modify: `src/telegram-question-format.ts` (add disambiguateAnswer)
- Test: `tests/telegram-disambiguation.test.ts` (extend)

- [ ] **Step 1: Write failing tests for disambiguation**

Add to `tests/telegram-disambiguation.test.ts`:

```typescript
import { disambiguateAnswer, stripRoutingPrefix } from '../src/telegram-question-format'

interface MockQuestion {
  questionId: string
  agentName: string
  question: string
  choices?: string[]
}

describe('disambiguateAnswer', () => {
  const q1: MockQuestion = {
    questionId: 'q-7f3a2b1c',
    agentName: 'james',
    question: 'JWT or session cookies?',
    choices: ['JWT', 'Session cookies'],
  }
  const q2: MockQuestion = {
    questionId: 'q-aabbccdd',
    agentName: 'kate',
    question: 'Use materialized view?',
    choices: ['Yes', 'No'],
  }

  test('single pending question routes directly', () => {
    const result = disambiguateAnswer('use JWT', [q1])
    expect(result).toBe(q1)
  })

  test('agent name prefix routes correctly', () => {
    const result = disambiguateAnswer('james: use JWT', [q1, q2])
    expect(result).toBe(q1)
  })

  test('agent name prefix is case-insensitive', () => {
    const result = disambiguateAnswer('James: use JWT', [q1, q2])
    expect(result).toBe(q1)
  })

  test('choice matching routes to correct question', () => {
    const result = disambiguateAnswer('JWT', [q1, q2])
    expect(result).toBe(q1)
  })

  test('choice matching is case-insensitive', () => {
    const result = disambiguateAnswer('jwt', [q1, q2])
    expect(result).toBe(q1)
  })

  test('explicit question ID routes by ID', () => {
    const result = disambiguateAnswer('q-aabb yes', [q1, q2])
    expect(result).toBe(q2)
  })

  test('ambiguous answer returns "ambiguous"', () => {
    const result = disambiguateAnswer('sounds good', [q1, q2])
    expect(result).toBe('ambiguous')
  })

  test('no pending questions returns "ambiguous"', () => {
    const result = disambiguateAnswer('hello', [])
    expect(result).toBe('ambiguous')
  })
})

describe('stripRoutingPrefix', () => {
  test('strips agent name prefix', () => {
    expect(stripRoutingPrefix('james: use JWT', 'james')).toBe('use JWT')
  })

  test('strips question ID prefix', () => {
    expect(stripRoutingPrefix('q-7f3a use JWT', 'james')).toBe('use JWT')
  })

  test('leaves plain answers unchanged', () => {
    expect(stripRoutingPrefix('use JWT', 'james')).toBe('use JWT')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/telegram-disambiguation.test.ts`

Expected: FAIL — `disambiguateAnswer` and `stripRoutingPrefix` not exported.

- [ ] **Step 3: Add disambiguation functions to `src/telegram-question-format.ts`**

```typescript
interface DisambiguationQuestion {
  questionId: string
  agentName: string
  question: string
  choices?: string[]
}

/**
 * Determine which pending question an answer belongs to.
 * Returns the matched question or 'ambiguous' if can't determine.
 */
export function disambiguateAnswer(
  answerText: string,
  pendingQuestions: DisambiguationQuestion[],
): DisambiguationQuestion | 'ambiguous' {
  if (pendingQuestions.length === 0) return 'ambiguous'
  if (pendingQuestions.length === 1) return pendingQuestions[0]

  const lower = answerText.toLowerCase().trim()

  // 1. Agent name prefix: "james: use JWT"
  const agentMatch = pendingQuestions.find(q =>
    lower.startsWith(q.agentName.toLowerCase() + ':'),
  )
  if (agentMatch) return agentMatch

  // 2. Choice matching: answer exactly matches a choice
  const choiceMatch = pendingQuestions.find(q =>
    q.choices?.some(c => c.toLowerCase() === lower),
  )
  if (choiceMatch) return choiceMatch

  // 3. Explicit question ID: "q-7f3a use JWT"
  const idMatch = answerText.match(/q-([0-9a-f]{4,8})/i)
  if (idMatch) {
    const match = pendingQuestions.find(q =>
      q.questionId.startsWith(`q-${idMatch[1]}`),
    )
    if (match) return match
  }

  return 'ambiguous'
}

/**
 * Strip routing prefix from answer text.
 * "james: use JWT" → "use JWT"
 * "q-7f3a use JWT" → "use JWT"
 */
export function stripRoutingPrefix(answerText: string, agentName: string): string {
  // Strip agent name prefix
  const agentPrefix = new RegExp(`^${agentName}:\\s*`, 'i')
  const stripped = answerText.replace(agentPrefix, '')
  if (stripped !== answerText) return stripped.trim()

  // Strip question ID prefix
  const idPrefix = /^q-[0-9a-f]{4,8}\s+/i
  return answerText.replace(idPrefix, '').trim()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/telegram-disambiguation.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/telegram-question-format.ts tests/telegram-disambiguation.test.ts
git commit -m "[ELLIE-1276] Add disambiguation algorithm with agent prefix, choice matching, and ID routing"
```

---

### Task 3: Wire Disambiguation into Telegram Handler (ELLIE-1276 Part 3)

**Files:**
- Modify: `src/telegram-handlers.ts:49,172+` (import new functions, use in message handling)
- Modify: `src/ellie-chat-handler.ts:61,273+` (same for ellie-chat path)

- [ ] **Step 1: Read `src/telegram-handlers.ts` around line 172**

Understand the current flow: `getPendingQuestions()` returns pending, handler routes to `pendingAgentQuestions[0]` (oldest). We need to replace this with disambiguation.

- [ ] **Step 2: Update telegram-handlers.ts**

At the import section (around line 49), add:

```typescript
import { disambiguateAnswer, stripRoutingPrefix, formatQuestionMessage } from './telegram-question-format'
```

At the message handling section (around line 172), replace the direct `pendingAgentQuestions[0]` routing with disambiguation:

```typescript
const pendingAgentQuestions = getPendingQuestions()
if (pendingAgentQuestions.length > 0) {
  // Map to disambiguation format
  const disambigQuestions = pendingAgentQuestions.map(q => ({
    questionId: q.id,
    agentName: q.agentName,
    question: q.question,
    choices: q.options,
  }))

  const match = disambiguateAnswer(messageText, disambigQuestions)

  if (match === 'ambiguous') {
    // Send clarification message
    const lines = [`I have ${pendingAgentQuestions.length} questions waiting. Which one are you answering?\n`]
    pendingAgentQuestions.forEach((q, i) => {
      lines.push(`${i + 1}. ${q.agentName}: ${q.question.slice(0, 80)}`)
    })
    lines.push(`\nReply with the number, or answer on the dashboard.`)
    await sendMessage(chatId, lines.join('\n'))
    return
  }

  // Strip routing prefix and answer the matched question
  const cleanAnswer = stripRoutingPrefix(messageText, match.agentName)
  answerQuestion(match.questionId, cleanAnswer)
  return
}
```

Note: Read the actual code to get the exact variable names (`chatId`, `sendMessage`, `messageText`). Adapt to whatever pattern exists. The key change is: replace `[0]` routing with `disambiguateAnswer()`.

- [ ] **Step 3: Update ellie-chat-handler.ts similarly**

At line 61, add the import. At line 273 where `getPendingQuestions()` is called, apply the same disambiguation pattern. Adapt variable names to the ellie-chat handler's conventions.

- [ ] **Step 4: Run existing tests**

Run: `bun test`

Expected: All existing tests pass (disambiguation is additive).

- [ ] **Step 5: Commit**

```bash
git add src/telegram-handlers.ts src/ellie-chat-handler.ts
git commit -m "[ELLIE-1276] Wire disambiguation into Telegram and ellie-chat message handlers"
```

---

### Task 4: Question Message Formatting in Coordinator (ELLIE-1276 Part 4)

**Files:**
- Modify: `src/coordinator.ts:370-392` (where ask_user sends the question to the user)
- Modify: `src/ellie-chat-handler.ts` (where paused state question is presented)

- [ ] **Step 1: Read `src/coordinator.ts` around lines 390-420**

Find where the question text is sent to Dave after `ask_user` pauses. The coordinator returns `pausedState` — the handler (in relay.ts or ellie-chat-handler.ts) sends the question to Telegram. Find that send call.

- [ ] **Step 2: Read `src/ellie-chat-handler.ts`**

Find where `CoordinatorPausedState.question` is sent to the user. This is where we format it with `formatQuestionMessage()`.

- [ ] **Step 3: Update the question send path**

Where the question is sent to Telegram/chat, replace plain text with formatted message:

```typescript
import { formatQuestionMessage } from './telegram-question-format'

// Where the question gets sent to the user:
const formattedQuestion = formatQuestionMessage({
  agentName: pausedState.lastAgentName ?? 'ellie', // or however the agent name is tracked
  questionId: questionMetadata?.question_id ?? 'q-unknown',
  question: pausedState.question,
  whatINeed: questionMetadata?.what_i_need ?? '',
  decisionUnlocked: questionMetadata?.decision_unlocked ?? '',
  choices: questionMetadata?.choices ?? undefined,
})

await sendMessage(channel, formattedQuestion)
```

Note: The exact integration depends on how the paused state flows to the message send. Read the code path carefully. The `question_id` may need to be stored on the `CoordinatorPausedState` interface — add it there if needed.

- [ ] **Step 4: Run tests**

Run: `bun test`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/coordinator.ts src/ellie-chat-handler.ts
git commit -m "[ELLIE-1276] Format Telegram questions with agent name, short ID, and metadata"
```

---

### Task 5: Progress Event Throttle Buffer (ELLIE-1277 Part 1)

**Files:**
- Create: `src/progress-throttle.ts`
- Test: `tests/progress-throttle.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/progress-throttle.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from 'bun:test'
import { ProgressThrottle } from '../src/progress-throttle'

describe('ProgressThrottle', () => {
  let events: Array<{ runId: string; phase: string; detail: string }>
  let throttle: ProgressThrottle

  beforeEach(() => {
    events = []
    throttle = new ProgressThrottle({
      flushIntervalMs: 100, // fast for tests
      maxEventsPerRun: 10,
      onFlush: (runId, phase, detail) => {
        events.push({ runId, phase, detail })
      },
    })
  })

  test('deduplicates same-phase events within window', () => {
    throttle.record('run-1', 'reading', 'file-a.ts')
    throttle.record('run-1', 'reading', 'file-b.ts')
    throttle.flush()
    expect(events).toHaveLength(1)
    expect(events[0].detail).toBe('file-b.ts') // latest wins
  })

  test('emits on phase change', () => {
    throttle.record('run-1', 'reading', 'file-a.ts')
    throttle.record('run-1', 'editing', 'file-a.ts')
    throttle.flush()
    expect(events).toHaveLength(2)
    expect(events[0].phase).toBe('reading')
    expect(events[1].phase).toBe('editing')
  })

  test('respects max events per run', () => {
    for (let i = 0; i < 15; i++) {
      throttle.record('run-1', `phase-${i}`, `detail-${i}`)
    }
    throttle.flush()
    expect(events).toHaveLength(10)
  })

  test('tracks separate runs independently', () => {
    throttle.record('run-1', 'reading', 'file-a.ts')
    throttle.record('run-2', 'reading', 'file-b.ts')
    throttle.flush()
    expect(events).toHaveLength(2)
  })

  test('cleanup removes run tracking', () => {
    throttle.record('run-1', 'reading', 'file.ts')
    throttle.cleanupRun('run-1')
    throttle.flush()
    expect(events).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/progress-throttle.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/progress-throttle.ts`**

```typescript
/**
 * Progress Event Throttle — ELLIE-1277
 *
 * Buffers agent progress events and deduplicates by phase.
 * Same-phase events within a flush window are coalesced (latest detail wins).
 * Phase transitions emit the previous phase and start a new buffer.
 * Max events per run prevents unbounded growth.
 */

interface ThrottleOptions {
  flushIntervalMs: number
  maxEventsPerRun: number
  onFlush: (runId: string, phase: string, detail: string) => void
}

interface PendingEvent {
  phase: string
  detail: string
}

interface RunState {
  pending: PendingEvent[]
  flushedCount: number
  lastPhase: string | null
}

export class ProgressThrottle {
  private runs = new Map<string, RunState>()
  private opts: ThrottleOptions
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(opts: ThrottleOptions) {
    this.opts = opts
  }

  /** Start the auto-flush timer. Call once at startup. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.flush(), this.opts.flushIntervalMs)
  }

  /** Stop the auto-flush timer. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Record a progress event. Coalesces same-phase events. */
  record(runId: string, phase: string, detail: string): void {
    let state = this.runs.get(runId)
    if (!state) {
      state = { pending: [], flushedCount: 0, lastPhase: null }
      this.runs.set(runId, state)
    }

    if (phase === state.lastPhase && state.pending.length > 0) {
      // Same phase — overwrite latest detail
      state.pending[state.pending.length - 1].detail = detail
    } else {
      // New phase — push new entry
      state.pending.push({ phase, detail })
      state.lastPhase = phase
    }
  }

  /** Flush all buffered events through onFlush callback. */
  flush(): void {
    for (const [runId, state] of this.runs) {
      const remaining = this.opts.maxEventsPerRun - state.flushedCount
      if (remaining <= 0) {
        state.pending = []
        continue
      }

      const toFlush = state.pending.splice(0, remaining)
      for (const event of toFlush) {
        this.opts.onFlush(runId, event.phase, event.detail)
        state.flushedCount++
      }
    }
  }

  /** Clean up tracking for a completed run. */
  cleanupRun(runId: string): void {
    this.runs.delete(runId)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/progress-throttle.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/progress-throttle.ts tests/progress-throttle.test.ts
git commit -m "[ELLIE-1277] Add progress event throttle buffer with phase dedup and per-run cap"
```

---

### Task 6: Progress Events API Endpoint (ELLIE-1277 Part 2)

**Files:**
- Modify: `src/http-routes.ts` (add `GET /api/dispatches/:id/events`)
- Create: `ellie-home/server/api/dispatches/[id]/events.get.ts` (Nuxt proxy)
- Test: via manual verification (Forest DB query)

- [ ] **Step 1: Add the relay endpoint**

In `src/http-routes.ts`, add a new route handler. Find where the other `/api/dispatches/*` routes are (around line 6985). Add after the existing dispatch routes:

```typescript
// GET /api/dispatches/:id/events — fetch orchestration events for a dispatch item
const eventsMatch = url.pathname.match(/^\/api\/dispatches\/([^/]+)\/events$/);
if (eventsMatch && req.method === "GET") {
  const itemId = eventsMatch[1];
  (async () => {
    try {
      // Look up dispatch_envelope_id from the todo
      const { supabase: sbClient } = getRelayDeps();
      if (!sbClient) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Supabase unavailable" }));
        return;
      }

      const { data: todo } = await sbClient
        .from("todos")
        .select("dispatch_envelope_id")
        .eq("id", itemId)
        .single();

      if (!todo?.dispatch_envelope_id) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ events: [], dispatch_envelope_id: null }));
        return;
      }

      // Query Forest for orchestration events
      try {
        const { getForestDb } = await import("./orchestration-ledger.ts");
        const db = await getForestDb();
        if (!db) throw new Error("Forest DB unavailable");

        const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
        const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

        const events = await db`
          SELECT id, event_type, agent_type, work_item_id, payload, created_at
          FROM orchestration_events
          WHERE run_id = ${todo.dispatch_envelope_id}
          ORDER BY created_at DESC
          LIMIT ${Math.min(limit, 100)}
          OFFSET ${offset}
        `;

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ events, forest_unavailable: false }));
      } catch {
        // Forest unavailable — graceful degradation
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ events: [], forest_unavailable: true }));
      }
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error" }));
    }
  })();
  return;
}
```

Note: Check how `getForestDb` is exported from `orchestration-ledger.ts`. It may be a different function name — look for the Forest/Postgres connection getter. Adapt the SQL template literal to match the DB library used (likely `postgres.js` tagged template).

- [ ] **Step 2: Create Nuxt proxy route**

Create `ellie-home/server/api/dispatches/[id]/events.get.ts`:

```typescript
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const relayUrl = config.relayUrl || 'http://localhost:3001'
  const id = getRouterParam(event, 'id')
  const query = getQuery(event)
  const params = new URLSearchParams()
  if (query.limit) params.set('limit', String(query.limit))
  if (query.offset) params.set('offset', String(query.offset))
  const qs = params.toString() ? `?${params}` : ''

  const res = await fetch(`${relayUrl}/api/dispatches/${id}/events${qs}`, {
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw createError({ statusCode: res.status, message: 'Failed to fetch events' })
  return res.json()
})
```

- [ ] **Step 3: Build ellie-home to verify**

Run: `cd /home/ellie/ellie-home && bun run build`

Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/http-routes.ts
git commit -m "[ELLIE-1277] Add GET /api/dispatches/:id/events endpoint with Forest query and graceful degradation"

cd /home/ellie/ellie-home
git add server/api/dispatches/\[id\]/events.get.ts
git commit -m "[ELLIE-1277] Add Nuxt proxy for dispatch events endpoint"
```

---

### Task 7: Kanban Agent Card Component (ELLIE-1278 Part 1)

**Files:**
- Create: `ellie-home/app/components/dispatch/AgentKanbanCard.vue`

- [ ] **Step 1: Read existing patterns**

Read `ellie-home/app/pages/agent-questions.vue` lines 224-262 for the agent color/display name helpers. Read `ellie-home/app/pages/gtd-kanban.vue` lines 27-43 for the current card template.

- [ ] **Step 2: Create the agent kanban card component**

Create `ellie-home/app/components/dispatch/AgentKanbanCard.vue`:

```vue
<script setup lang="ts">
/**
 * AgentKanbanCard — Renders agent dispatch and question items
 * on the GTD kanban board with colored borders, avatars, and
 * answer controls for questions.
 *
 * ELLIE-1278
 */

const props = defineProps<{
  todo: {
    id: string
    content: string
    status: string
    item_type?: string
    assigned_agent?: string
    metadata?: Record<string, unknown>
    dispatch_envelope_id?: string
    created_at?: string
  }
}>()

const emit = defineEmits<{
  answered: [id: string, answer: string]
}>()

const answerInput = ref('')
const submitting = ref(false)
const expanded = ref(false)

const AGENT_COLORS: Record<string, string> = {
  general: '#10B981', ellie: '#10B981',
  dev: '#06B6D4', james: '#06B6D4',
  research: '#8B5CF6', kate: '#8B5CF6',
  strategy: '#EF4444', alan: '#EF4444',
  critic: '#EC4899', brian: '#EC4899',
  content: '#F59E0B', amy: '#F59E0B',
  ops: '#14B8A6', jason: '#14B8A6',
}

const DISPLAY_NAMES: Record<string, string> = {
  general: 'Ellie', ellie: 'Ellie', dev: 'James', james: 'James',
  research: 'Kate', kate: 'Kate', strategy: 'Alan', alan: 'Alan',
  critic: 'Brian', brian: 'Brian', content: 'Amy', amy: 'Amy',
  ops: 'Jason', jason: 'Jason',
}

const agentColor = computed(() => {
  const key = (props.todo.assigned_agent ?? '').toLowerCase()
  return AGENT_COLORS[key] ?? '#6B7280'
})

const agentInitial = computed(() => {
  const name = DISPLAY_NAMES[(props.todo.assigned_agent ?? '').toLowerCase()]
  return name ? name[0] : '?'
})

const agentName = computed(() => {
  return DISPLAY_NAMES[(props.todo.assigned_agent ?? '').toLowerCase()] ?? props.todo.assigned_agent ?? 'Agent'
})

const isQuestion = computed(() => props.todo.item_type === 'agent_question')
const isDispatch = computed(() => props.todo.item_type === 'agent_dispatch')
const isDone = computed(() => props.todo.status === 'done' || props.todo.status === 'cancelled')
const metadata = computed(() => props.todo.metadata ?? {})

// Activity timeline (lazy loaded)
const events = ref<unknown[]>([])
const eventsLoading = ref(false)

async function loadEvents() {
  if (!props.todo.dispatch_envelope_id || events.value.length > 0) return
  eventsLoading.value = true
  try {
    const data = await $fetch<{ events: unknown[] }>(`/api/dispatches/${props.todo.id}/events?limit=20`)
    events.value = data?.events ?? []
  } catch { /* silent */ }
  eventsLoading.value = false
}

function toggleExpand() {
  expanded.value = !expanded.value
  if (expanded.value) loadEvents()
}

async function submitAnswer(answer: string) {
  if (!answer.trim()) return
  submitting.value = true
  try {
    await $fetch('/api/dispatches/answer', {
      method: 'POST',
      body: { question_item_id: props.todo.id, answer_text: answer.trim() },
    })
    answerInput.value = ''
    emit('answered', props.todo.id, answer.trim())
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div
    class="rounded-lg p-3 cursor-pointer transition-colors"
    :class="isDone ? 'bg-neutral-900 opacity-60' : 'bg-neutral-900 hover:bg-neutral-800'"
    :style="{ borderLeft: `3px solid ${agentColor}` }"
    @click="toggleExpand"
  >
    <!-- Agent header -->
    <div class="flex items-center gap-2 mb-1.5">
      <div
        class="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold text-black shrink-0"
        :style="{ backgroundColor: agentColor }"
      >
        {{ agentInitial }}
      </div>
      <span class="text-xs font-semibold" :style="{ color: agentColor }">{{ agentName }}</span>
      <span v-if="isQuestion" class="ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-900 text-amber-400">
        waiting
      </span>
    </div>

    <!-- Content -->
    <p class="text-sm text-neutral-300 line-clamp-2">{{ todo.content }}</p>

    <!-- What I need box (questions only) -->
    <div v-if="isQuestion && metadata.what_i_need && !isDone" class="mt-2 bg-neutral-950 border border-amber-800 rounded-md p-2">
      <div class="text-[10px] text-amber-500 font-bold mb-0.5">What I need</div>
      <div class="text-xs text-neutral-400">{{ metadata.what_i_need }}</div>
    </div>

    <!-- Inline answer controls (questions, not done) -->
    <template v-if="isQuestion && !isDone">
      <!-- Choice buttons -->
      <div v-if="metadata.answer_format === 'choice' && metadata.choices" class="flex flex-wrap gap-1 mt-2">
        <button
          v-for="choice in (metadata.choices as string[])"
          :key="choice"
          class="px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs text-neutral-300 hover:border-amber-500 transition-colors"
          :disabled="submitting"
          @click.stop="submitAnswer(choice)"
        >
          {{ choice }}
        </button>
      </div>

      <!-- Text input -->
      <div class="flex gap-1 mt-2" @click.stop>
        <input
          v-model="answerInput"
          type="text"
          placeholder="Answer..."
          class="flex-1 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs text-white placeholder-neutral-500 focus:border-amber-500 focus:outline-none"
          :disabled="submitting"
          @keydown.enter="submitAnswer(answerInput)"
        />
        <button
          class="px-2 py-1 bg-amber-500 text-black rounded text-xs font-semibold disabled:opacity-50"
          :disabled="submitting || !answerInput.trim()"
          @click.stop="submitAnswer(answerInput)"
        >
          Send
        </button>
      </div>
    </template>

    <!-- Answered display -->
    <div v-else-if="isQuestion && isDone && metadata.answer" class="mt-1 text-xs text-neutral-500">
      Answered: "{{ metadata.answer }}"
    </div>

    <!-- Dispatch status (non-question agent items) -->
    <div v-if="isDispatch && !isQuestion" class="mt-1 text-[10px] text-neutral-500">
      {{ isDone ? 'completed' : 'working' }}
    </div>

    <!-- Expanded activity timeline -->
    <div v-if="expanded && isDispatch" class="mt-2 pt-2 border-t border-neutral-800">
      <div v-if="eventsLoading" class="text-xs text-neutral-600">Loading activity...</div>
      <div v-else-if="events.length === 0" class="text-xs text-neutral-600">No activity recorded</div>
      <div v-else class="space-y-1">
        <div v-for="(evt, i) in events.slice(0, 10)" :key="i" class="text-[10px] text-neutral-500">
          <span class="text-neutral-600">{{ (evt as any).event_type }}</span>
          {{ (evt as any).payload?.detail ?? '' }}
        </div>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 3: Build to verify**

Run: `cd /home/ellie/ellie-home && bun run build`

Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
cd /home/ellie/ellie-home
git add app/components/dispatch/AgentKanbanCard.vue
git commit -m "[ELLIE-1278] Add AgentKanbanCard component with colored borders, avatars, and inline answers"
```

---

### Task 8: Wire Agent Cards into Kanban (ELLIE-1278 Part 2)

**Files:**
- Modify: `ellie-home/app/pages/gtd-kanban.vue`

- [ ] **Step 1: Read `gtd-kanban.vue` fully**

Understand the current card rendering at lines 27-43. The goal: if a todo has `item_type === 'agent_dispatch'` or `item_type === 'agent_question'`, render `<AgentKanbanCard>` instead of the default card.

- [ ] **Step 2: Update gtd-kanban.vue**

In the template, inside the card loop (where each todo in a column is rendered), add a conditional:

```vue
<!-- Inside the v-for="todo in filteredTodos(col.status)" loop -->
<AgentKanbanCard
  v-if="todo.item_type === 'agent_dispatch' || todo.item_type === 'agent_question'"
  :todo="todo"
  @answered="loadTodos"
/>
<!-- existing card rendering for normal tasks (wrap in v-else) -->
<div v-else class="...existing card classes...">
  <!-- existing card content -->
</div>
```

Add the import at the top of the script section (if not auto-imported by Nuxt):

```typescript
// Nuxt auto-imports components from app/components/ — this should work without explicit import
```

- [ ] **Step 3: Build and verify**

Run: `cd /home/ellie/ellie-home && bun run build`

Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
cd /home/ellie/ellie-home
git add app/pages/gtd-kanban.vue
git commit -m "[ELLIE-1278] Wire AgentKanbanCard into GTD kanban for agent dispatch and question items"
```

---

### Task 9: End-to-End Integration Test (ELLIE-1295)

**Files:**
- Create: `tests/gtd-e2e-question-lifecycle.test.ts`

- [ ] **Step 1: Write the integration test**

Create `tests/gtd-e2e-question-lifecycle.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from 'bun:test'
import {
  generateQuestionId,
  createOrchestrationParent,
  createDispatchChild,
  createQuestionItem,
  answerQuestion as answerGtdQuestion,
  getActiveOrchestrationTrees,
} from '../src/gtd-orchestration'
import { formatDispatchSummary, formatPendingAnswers } from '../src/gtd-recovery'
import {
  enqueueQuestion,
  answerQuestion as answerQueueQuestion,
  getPendingQuestions,
  clearQuestionQueue,
} from '../src/ask-user-queue'
import { formatQuestionMessage, disambiguateAnswer, stripRoutingPrefix } from '../src/telegram-question-format'

describe('GTD question lifecycle — end-to-end', () => {
  beforeEach(() => {
    clearQuestionQueue()
  })

  test('question ID generation → formatting → disambiguation round-trip', () => {
    const qId = generateQuestionId()
    expect(qId).toMatch(/^q-[0-9a-f]{8}$/)

    // Format for Telegram
    const msg = formatQuestionMessage({
      agentName: 'james',
      questionId: qId,
      question: 'JWT or cookies?',
      whatINeed: 'Pick one',
      decisionUnlocked: 'Auth implementation',
      choices: ['JWT', 'Cookies'],
    })
    expect(msg).toContain('james asks')
    expect(msg).toContain(qId.slice(0, 6))
    expect(msg).toContain('1. JWT')
    expect(msg).toContain('2. Cookies')

    // Disambiguate an answer
    const questions = [{
      questionId: qId,
      agentName: 'james',
      question: 'JWT or cookies?',
      choices: ['JWT', 'Cookies'],
    }]
    const match = disambiguateAnswer('JWT', questions)
    expect(match).not.toBe('ambiguous')
    expect((match as typeof questions[0]).questionId).toBe(qId)
  })

  test('multi-agent disambiguation with agent prefix', () => {
    const q1 = { questionId: 'q-aaaaaaaa', agentName: 'james', question: 'Approach?', choices: ['A', 'B'] }
    const q2 = { questionId: 'q-bbbbbbbb', agentName: 'kate', question: 'Framework?', choices: ['React', 'Vue'] }

    // Agent prefix routes correctly
    expect(disambiguateAnswer('james: go with A', [q1, q2])).toBe(q1)
    expect(disambiguateAnswer('kate: Vue', [q1, q2])).toBe(q2)

    // Choice matching routes correctly
    expect(disambiguateAnswer('React', [q1, q2])).toBe(q2)

    // Ambiguous falls through
    expect(disambiguateAnswer('sounds good', [q1, q2])).toBe('ambiguous')
  })

  test('answer stripping removes routing prefix', () => {
    expect(stripRoutingPrefix('james: use JWT', 'james')).toBe('use JWT')
    expect(stripRoutingPrefix('q-7f3a use JWT', 'james')).toBe('use JWT')
    expect(stripRoutingPrefix('use JWT', 'james')).toBe('use JWT')
  })

  test('ask-user queue enqueue → answer → promise resolution', async () => {
    const queueId = enqueueQuestion('james', 'Which approach?', { options: ['A', 'B'] })
    expect(getPendingQuestions()).toHaveLength(1)

    // Answer resolves the promise
    const answered = answerQueueQuestion(queueId, 'Option A')
    expect(answered).toBe(true)
    expect(getPendingQuestions()).toHaveLength(0)

    // Answering again returns false
    expect(answerQueueQuestion(queueId, 'Option B')).toBe(false)
  })

  test('GTD tree creation with structured metadata', async () => {
    // Create a full 3-level tree
    const parent = await createOrchestrationParent({
      content: 'Build auth system',
      createdBy: 'test-e2e',
    })
    expect(parent.id).toBeTruthy()

    const child = await createDispatchChild({
      parentId: parent.id,
      content: 'Implement middleware',
      assignedAgent: 'dev',
      assignedTo: 'james',
      createdBy: 'test-e2e',
    })
    expect(child.id).toBeTruthy()

    const questionId = generateQuestionId()
    const question = await createQuestionItem({
      parentId: child.id,
      content: 'JWT or session cookies?',
      createdBy: 'test-e2e',
      urgency: 'blocking',
      metadata: {
        question_id: questionId,
        what_i_need: 'Pick one',
        decision_unlocked: 'Session store approach',
        answer_format: 'choice',
        choices: ['JWT', 'Session cookies'],
      },
    })
    expect(question.id).toBeTruthy()
    expect(question.metadata?.question_id).toBe(questionId)

    // Answer the question via GTD
    const answeredParent = await answerGtdQuestion(question.id, 'JWT')
    expect(answeredParent).toBeTruthy()

    // Verify tree state
    const trees = await getActiveOrchestrationTrees()
    // Parent may or may not be in active trees depending on child status
    expect(trees).toBeInstanceOf(Array)
  })

  test('recovery formatting produces readable summaries', () => {
    const tree = {
      id: 'p1',
      content: 'Build auth system',
      status: 'open',
      item_type: 'agent_dispatch',
      children: [
        {
          id: 'c1',
          content: 'Implement middleware',
          status: 'open',
          item_type: 'agent_dispatch',
          assigned_agent: 'james',
          children: [{
            id: 'gc1',
            content: 'JWT or session cookies?',
            status: 'open',
            item_type: 'agent_question',
            metadata: { question_id: 'q-testtest', what_i_need: 'Pick one' },
            children: [],
          }],
        },
        {
          id: 'c2',
          content: 'Write tests',
          status: 'done',
          item_type: 'agent_dispatch',
          assigned_agent: 'kate',
          children: [],
        },
      ],
    }

    const summary = formatDispatchSummary(tree)
    expect(summary).toContain('james')
    expect(summary).toContain('waiting')
    expect(summary).toContain('kate')
    expect(summary).toContain('completed')

    const pending = formatPendingAnswers(tree)
    expect(pending).toContain('q-testtest')
    expect(pending).toContain('Pick one')
  })
})
```

- [ ] **Step 2: Run the integration test**

Run: `bun test tests/gtd-e2e-question-lifecycle.test.ts`

Expected: PASS (some tests require Supabase — if those fail due to missing connection, that's expected in CI but should work locally).

- [ ] **Step 3: Run full test suite**

Run: `bun test`

Expected: All tests pass. No regressions.

- [ ] **Step 4: Commit**

```bash
cd /home/ellie/ellie-dev
git add tests/gtd-e2e-question-lifecycle.test.ts
git commit -m "[ELLIE-1295] Add end-to-end integration test for GTD question lifecycle"
```

---

## Task Dependency Order

```
Task 1 (question formatting) → no dependencies
Task 2 (disambiguation algorithm) → depends on Task 1
Task 3 (wire into handlers) → depends on Tasks 1 + 2
Task 4 (format in coordinator) → depends on Task 1
Task 5 (throttle buffer) → no dependencies
Task 6 (events API) → depends on Task 5 (conceptually, but code is independent)
Task 7 (agent card component) → no dependencies
Task 8 (wire into kanban) → depends on Task 7
Task 9 (integration test) → depends on Tasks 1-4 (imports their functions)
```

Parallelizable groups:
- **Group A:** Tasks 1+2 (Telegram formatting), then 3+4 (wiring)
- **Group B:** Tasks 5+6 (progress events)
- **Group C:** Tasks 7+8 (kanban cards)
- **Final:** Task 9 (after all above)
