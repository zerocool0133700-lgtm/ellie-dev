# Coordinator Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the orchestration system with GTD-backed dispatch tracking, add a real-time dispatches page, and wrap it in a Chrome extension side panel — giving both Dave and Ellie persistent visibility into multi-agent orchestration.

**Architecture:** GTD becomes the single source of truth. Coordinator creates GTD items when dispatching, reads them after compaction. Answers route through working memory context_anchors (structured, not string parsing). Auto-completion is transactional at the API level. WebSocket pushes real-time updates. Chrome extension is a thin iframe shell.

**Tech Stack:** TypeScript/Bun (relay), Supabase (GTD todos), postgres.js (direct SQL), Nuxt 4.3 + Tailwind v4 (dashboard), Chrome Manifest V3 (extension)

**Spec:** `docs/superpowers/specs/2026-03-30-coordinator-visibility-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `migrations/supabase/20260330_gtd_orchestration.sql` | Schema: parent_id, created_by, is_orchestration, urgency, dispatch_envelope_id, metadata, new statuses |
| `src/gtd-orchestration.ts` | GTD orchestration CRUD: create parent/child items, tree queries, auto-completion, cancel cascade, answer routing |
| `tests/gtd-orchestration.test.ts` | Tests for orchestration logic |
| `ellie-home/server/api/dispatches/active.get.ts` | Active orchestration trees |
| `ellie-home/server/api/dispatches/answer.post.ts` | Submit Dave's answer |
| `ellie-home/server/api/dispatches/cancel.post.ts` | Cancel item + children |
| `ellie-home/server/api/dispatches/approvals.get.ts` | Pending tool approvals (proxy) |
| `ellie-home/server/api/dispatches/approve.post.ts` | Approve tool (proxy) |
| `ellie-home/server/api/dispatches/deny.post.ts` | Deny tool (proxy) |
| `ellie-home/server/api/dispatches/badge.get.ts` | Badge count for extension |
| `ellie-home/app/pages/dispatches.vue` | Dispatches page with WebSocket |
| `ellie-dispatch-extension/manifest.json` | Chrome extension manifest |
| `ellie-dispatch-extension/sidepanel.html` | Side panel iframe |
| `ellie-dispatch-extension/background.js` | Badge count polling |

### Modified Files

| File | Change |
|------|--------|
| `src/api/gtd-types.ts` | Add parent_id, created_by, is_orchestration, urgency, dispatch_envelope_id, metadata to TodoRow |
| `src/api/gtd.ts` | Support new columns in create/query, filter is_orchestration |
| `src/coordinator-tools.ts` | Create GTD items on dispatch_agent, create question items on ask_user |
| `src/coordinator.ts` | Read GTD on compaction, check context_anchors for answers |
| `src/orchestration-monitor.ts` | Expand staleness detection for orchestration items, 30min timeout |
| `src/working-memory.ts` | No code change — context_anchors already supports free-form string content |
| `src/relay-state.ts` | Add dispatch_update broadcast events |
| `skills/gtd/SKILL.md` | Add orchestration pattern, recovery, narration sections |

---

## Task 1: GTD Schema Updates

**Files:**
- Create: `migrations/supabase/20260330_gtd_orchestration.sql`
- Modify: `src/api/gtd-types.ts`

- [ ] **Step 1: Write the migration**

```sql
-- ELLIE-1141: GTD orchestration support
ALTER TABLE todos ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES todos(id);
ALTER TABLE todos ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS is_orchestration BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS urgency TEXT CHECK (urgency IN ('blocking', 'normal', 'low'));
ALTER TABLE todos ADD COLUMN IF NOT EXISTS dispatch_envelope_id TEXT;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_todos_parent ON todos(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_todos_created_by ON todos(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_todos_orchestration ON todos(is_orchestration) WHERE is_orchestration = true;

-- Extend status check constraint to include failure states
-- First drop existing constraint, then recreate with new values
DO $$
BEGIN
  ALTER TABLE todos DROP CONSTRAINT IF EXISTS todos_status_check;
  ALTER TABLE todos ADD CONSTRAINT todos_status_check
    CHECK (status IN ('inbox', 'open', 'waiting_for', 'someday', 'done', 'cancelled', 'failed', 'timed_out'));
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Status constraint update skipped: %', SQLERRM;
END $$;
```

- [ ] **Step 2: Apply via Supabase Management API**

```bash
cd /home/ellie/ellie-dev
source .env
SQL=$(cat migrations/supabase/20260330_gtd_orchestration.sql)
curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg q "$SQL" '{query: $q}')"
```

- [ ] **Step 3: Update TodoRow interface in gtd-types.ts**

Add after the existing fields in the `TodoRow` interface:

```typescript
  // ELLIE-1141: Orchestration support
  parent_id: string | null;
  created_by: string | null;
  is_orchestration: boolean;
  urgency: "blocking" | "normal" | "low" | null;
  dispatch_envelope_id: string | null;
  metadata: Record<string, unknown>;
```

- [ ] **Step 4: Commit**

```bash
git add migrations/supabase/20260330_gtd_orchestration.sql src/api/gtd-types.ts
git commit -m "[ELLIE-1141] Add GTD orchestration schema — parent_id, created_by, is_orchestration, urgency, failure states"
```

---

## Task 2: GTD Orchestration CRUD Library

**Files:**
- Create: `src/gtd-orchestration.ts`
- Create: `tests/gtd-orchestration.test.ts`

- [ ] **Step 1: Write the tests**

Create `tests/gtd-orchestration.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "bun:test";

describe("gtd-orchestration", () => {
  it("createOrchestrationParent creates an is_orchestration item", async () => {
    const { createOrchestrationParent } = await import("../src/gtd-orchestration");
    const parent = await createOrchestrationParent({
      content: "Test orchestration parent",
      createdBy: "ellie",
      sourceRef: "ELLIE-1141",
    });
    expect(parent.id).toBeTruthy();
    expect(parent.is_orchestration).toBe(true);
    expect(parent.assigned_to).toBe("ellie");
    expect(parent.created_by).toBe("ellie");
    expect(parent.status).toBe("open");
    // Cleanup
    const { cancelItem } = await import("../src/gtd-orchestration");
    await cancelItem(parent.id);
  });

  it("createDispatchChild links to parent", async () => {
    const { createOrchestrationParent, createDispatchChild, cancelItem } = await import("../src/gtd-orchestration");
    const parent = await createOrchestrationParent({ content: "Parent", createdBy: "ellie" });
    const child = await createDispatchChild({
      parentId: parent.id,
      content: "Child task for dev",
      assignedAgent: "dev",
      assignedTo: "james",
      createdBy: "ellie",
    });
    expect(child.parent_id).toBe(parent.id);
    expect(child.assigned_agent).toBe("dev");
    expect(child.is_orchestration).toBe(true);
    await cancelItem(parent.id);
  });

  it("createQuestionItem creates blocking grandchild", async () => {
    const { createOrchestrationParent, createDispatchChild, createQuestionItem, cancelItem } = await import("../src/gtd-orchestration");
    const parent = await createOrchestrationParent({ content: "Parent", createdBy: "ellie" });
    const child = await createDispatchChild({ parentId: parent.id, content: "Child", assignedAgent: "critic", assignedTo: "brian", createdBy: "ellie" });
    const question = await createQuestionItem({
      parentId: child.id,
      content: "Should auth be in scope?",
      createdBy: "brian",
      urgency: "blocking",
    });
    expect(question.parent_id).toBe(child.id);
    expect(question.assigned_to).toBe("dave");
    expect(question.urgency).toBe("blocking");
    await cancelItem(parent.id);
  });

  it("getActiveOrchestrationTrees returns correct tree structure", async () => {
    const { createOrchestrationParent, createDispatchChild, getActiveOrchestrationTrees, cancelItem } = await import("../src/gtd-orchestration");
    const parent = await createOrchestrationParent({ content: "Tree test", createdBy: "ellie" });
    await createDispatchChild({ parentId: parent.id, content: "Child 1", assignedAgent: "dev", assignedTo: "james", createdBy: "ellie" });
    await createDispatchChild({ parentId: parent.id, content: "Child 2", assignedAgent: "critic", assignedTo: "brian", createdBy: "ellie" });
    const trees = await getActiveOrchestrationTrees();
    const tree = trees.find(t => t.id === parent.id);
    expect(tree).toBeTruthy();
    expect(tree!.children.length).toBe(2);
    await cancelItem(parent.id);
  });

  it("cancelItem cascades to children", async () => {
    const { createOrchestrationParent, createDispatchChild, cancelItem, getActiveOrchestrationTrees } = await import("../src/gtd-orchestration");
    const parent = await createOrchestrationParent({ content: "Cancel test", createdBy: "ellie" });
    await createDispatchChild({ parentId: parent.id, content: "Child", assignedAgent: "dev", assignedTo: "james", createdBy: "ellie" });
    await cancelItem(parent.id);
    const trees = await getActiveOrchestrationTrees();
    const found = trees.find(t => t.id === parent.id);
    expect(found).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/ellie/ellie-dev && bun test tests/gtd-orchestration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement gtd-orchestration.ts**

Create `src/gtd-orchestration.ts` with these functions:
- `createOrchestrationParent(opts)` — creates parent GTD item with `is_orchestration: true`
- `createDispatchChild(opts)` — creates child linked to parent
- `createQuestionItem(opts)` — creates grandchild assigned to dave with urgency
- `getActiveOrchestrationTrees()` — returns tree structure of active orchestration items
- `updateItemStatus(id, status, metadata?)` — update status, trigger `checkParentCompletion`
- `checkParentCompletion(parentId)` — transactional auto-completion check
- `cancelItem(id)` — cancel item + cascade to open children
- `answerQuestion(questionId, answerText)` — mark done, store answer in metadata
- `getOrchestrationBadgeCount()` — count items needing Dave's attention
- `findOrphanedParents(maxAgeMs)` — find stale orchestration parents for recovery
- `timeoutStaleChildren(parentId, maxAgeMs)` — mark old open children as timed_out

Uses the relay's Supabase client via `getRelayDeps()`. All parent completion checks use a Supabase RPC or raw SQL for atomicity.

- [ ] **Step 4: Run tests**

Run: `cd /home/ellie/ellie-dev && bun test tests/gtd-orchestration.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/gtd-orchestration.ts tests/gtd-orchestration.test.ts
git commit -m "[ELLIE-1141] Add GTD orchestration CRUD library"
```

---

## Task 3: Coordinator Integration

**Files:**
- Modify: `src/coordinator-tools.ts` (dispatch_agent handler, ~line 393)
- Modify: `src/coordinator.ts` (compaction recovery, ~line 533)

- [ ] **Step 1: Add GTD writes to dispatch_agent handler**

In `coordinator-tools.ts`, in the `dispatch_agent` processing section. Before the specialist is called, create the GTD child item. After the result comes back, update its status.

Read the file first. Find where `dispatchCalls` are processed. The pattern:
- Before `deps.callSpecialist()`: create GTD child item via `createDispatchChild()`
- After specialist returns: update item status to `done` or `failed` via `updateItemStatus()`
- Track the parent GTD item ID in the coordinator's working memory `task_stack`

Also: the first time dispatch_agent is called in a session, create the parent item. Store the parent ID so subsequent dispatches in the same session link to it.

- [ ] **Step 2: Add GTD writes to ask_user handler**

In the `ask_user` tool handling, create a question GTD item:

```typescript
const { createQuestionItem } = await import("./gtd-orchestration.ts");
await createQuestionItem({
  parentId: activeDispatchItemId, // the child item for the agent that's asking
  content: input.question,
  createdBy: currentAgentName,
  urgency: "blocking",
}).catch(() => {}); // fire and forget
```

- [ ] **Step 3: Add compaction recovery**

In `coordinator.ts`, in the compaction section (~line 533), after compacting or rebuilding context, inject the active GTD orchestration summary into working memory:

```typescript
// ELLIE-1141: Recover dispatch state from GTD after compaction
const { getActiveOrchestrationTrees } = await import("./gtd-orchestration.ts");
const trees = await getActiveOrchestrationTrees();
if (trees.length > 0) {
  const summary = trees.map(t => {
    const children = t.children.map(c => `  - ${c.assigned_to} (${c.assigned_agent}): ${c.content} [${c.status}]`).join("\n");
    return `Parent: ${t.content} [${t.status}]\n${children}`;
  }).join("\n\n");
  // Write to working memory task_stack
  await deps.updateWorkingMemory?.({ task_stack: `## Active Orchestration\n${summary}` });
}
```

- [ ] **Step 4: Add context_anchors answer reading**

At the start of each coordinator loop iteration, check working memory context_anchors for pending answers:

```typescript
// ELLIE-1141: Check for answers from Dave via dispatches page
const wm = await deps.readWorkingMemory?.();
if (wm?.context_anchors?.includes('"type":"agent_answer"')) {
  // Parse and inject as context for the next iteration
  // The answer is already in working memory — Claude will see it naturally
}
```

- [ ] **Step 5: Commit**

```bash
git add src/coordinator-tools.ts src/coordinator.ts
git commit -m "[ELLIE-1141] Wire coordinator to GTD — dispatch tracking + compaction recovery + answer routing"
```

---

## Task 4: Orchestration Monitor Expansion + Orphan Recovery

**Files:**
- Modify: `src/orchestration-monitor.ts`

- [ ] **Step 1: Add orchestration staleness detection**

Expand the existing `checkForStalledTasks()` to include orchestration items with a 30-minute hard timeout:

```typescript
// ELLIE-1141: Check orchestration items for staleness
const { data: orchItems } = await _supabase
  .from("todos")
  .select("id, assigned_agent, assigned_to, status, created_at, updated_at, content, parent_id")
  .eq("is_orchestration", true)
  .in("status", ["open"])
  .not("assigned_agent", "is", null);

const ORCHESTRATION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

for (const item of orchItems ?? []) {
  const age = Date.now() - new Date(item.updated_at).getTime();
  if (age > ORCHESTRATION_TIMEOUT_MS) {
    await updateItemStatus(item.id, "timed_out");
    // Notify via existing escalation pattern
  }
}
```

- [ ] **Step 2: Add orphan recovery on startup**

Add a `recoverOrphanedOrchestration()` function called from the monitor's init:

```typescript
export async function recoverOrphanedOrchestration(): Promise<number> {
  const { findOrphanedParents, timeoutStaleChildren, checkParentCompletion } = await import("./gtd-orchestration.ts");
  const orphans = await findOrphanedParents(2 * 60 * 60 * 1000); // 2 hours
  for (const orphan of orphans) {
    await timeoutStaleChildren(orphan.id, 30 * 60 * 1000);
    await checkParentCompletion(orphan.id);
  }
  return orphans.length;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/orchestration-monitor.ts
git commit -m "[ELLIE-1141] Expand orchestration monitor — 30min timeout + orphan recovery"
```

---

## Task 5: GTD Skill Update

**Files:**
- Modify: `skills/gtd/SKILL.md`

- [ ] **Step 1: Add orchestration sections to the GTD skill**

Add these sections after the existing GTD skill content:

```markdown
## Orchestration Pattern (ELLIE-1141)

When coordinating multi-agent work, use GTD to track every dispatch:

### Creating orchestration items

1. **Parent item** — your tracking anchor:
   - `POST /api/gtd/items` with `is_orchestration: true`, `assigned_to: "ellie"`, `created_by: "ellie"`
   - Link to ticket: `source_ref: "ELLIE-XXX"`

2. **Child items** — one per agent dispatch:
   - `POST /api/gtd/items` with `parent_id: {parent}`, `assigned_agent: "dev"`, `assigned_to: "james"`, `created_by: "ellie"`, `is_orchestration: true`

3. **Question items** — when an agent needs Dave's input:
   - `POST /api/gtd/items` with `parent_id: {agent_item}`, `assigned_to: "dave"`, `created_by: {agent}`, `urgency: "blocking"`, `is_orchestration: true`
   - Narrate: "Brian has a question — check the dispatch panel"

### Handling answers

Answers appear in your working memory `context_anchors` as structured JSON:
```json
{"type": "agent_answer", "question_item_id": "...", "parent_item_id": "...", "agent": "brian", "answer": "Yes, include auth"}
```
Route the answer to the correct agent and resume their work.

### Tracking completion

- Parent auto-completes at API level — don't track this yourself
- When parent status is `done`: synthesize results, respond to Dave
- When parent status is `waiting_for`: some children failed — report and ask Dave

### Recovery after compaction

- Read: `GET /api/gtd/items?assigned_to=ellie&is_orchestration=true&status=open`
- Check children for each parent to see what's in flight
- `timed_out` / `failed` children need attention
- This is your source of truth — not the conversation history

### Narration

Proactively narrate key moments via `update_user`:
- "Dispatching Brian (critique) and James (tests)."
- "Brian has a blocking question — check the dispatch panel."
- "James is done. Still waiting on Brian."
- "Brian's dispatch timed out. Retry or skip?"
- "All done. Here's the synthesis..."
```

- [ ] **Step 2: Commit**

```bash
git add skills/gtd/SKILL.md
git commit -m "[ELLIE-1141] Update GTD skill with orchestration pattern"
```

---

## Task 6: WebSocket Dispatch Events + Dashboard API

**Files:**
- Modify: `src/relay-state.ts` (add broadcast helper)
- Modify: `src/gtd-orchestration.ts` (broadcast on state changes)
- Create: `ellie-home/server/api/dispatches/active.get.ts`
- Create: `ellie-home/server/api/dispatches/answer.post.ts`
- Create: `ellie-home/server/api/dispatches/cancel.post.ts`
- Create: `ellie-home/server/api/dispatches/approvals.get.ts`
- Create: `ellie-home/server/api/dispatches/approve.post.ts`
- Create: `ellie-home/server/api/dispatches/deny.post.ts`
- Create: `ellie-home/server/api/dispatches/badge.get.ts`

- [ ] **Step 1: Add dispatch broadcast to relay-state.ts**

Add a broadcast function that sends dispatch events to all ellie-chat WS clients:

```typescript
export function broadcastDispatchEvent(event: Record<string, unknown>): void {
  broadcastToEllieChatClients({ ...event, _dispatch: true });
}
```

- [ ] **Step 2: Wire broadcasts into gtd-orchestration.ts**

After each state change (createDispatchChild, updateItemStatus, cancelItem), broadcast:

```typescript
import { broadcastDispatchEvent } from "./relay-state.ts";

// After creating/updating items:
broadcastDispatchEvent({ type: "dispatch_update" });
```

- [ ] **Step 3: Create all 7 dashboard API endpoints**

Each endpoint in `ellie-home/server/api/dispatches/`:

- `active.get.ts` — queries relay: `GET http://localhost:3001/api/dispatches/active`
- `answer.post.ts` — posts to relay: answer + write to working memory context_anchors
- `cancel.post.ts` — posts to relay: cancel item + cascade
- `approvals.get.ts` — queries relay: `GET http://localhost:3001/api/tool-approvals`
- `approve.post.ts` — posts to relay: approve tool
- `deny.post.ts` — posts to relay: deny tool
- `badge.get.ts` — queries relay: count of needs-attention items

Also add corresponding relay HTTP routes in `src/http-routes.ts` for the relay-side endpoints:
- `GET /api/dispatches/active` — calls `getActiveOrchestrationTrees()`
- `POST /api/dispatches/answer` — calls `answerQuestion()` + writes to working memory
- `POST /api/dispatches/cancel` — calls `cancelItem()`
- `GET /api/dispatches/badge` — calls `getOrchestrationBadgeCount()`

- [ ] **Step 4: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/relay-state.ts src/gtd-orchestration.ts src/http-routes.ts
git commit -m "[ELLIE-1141] Add dispatch WebSocket events + relay HTTP routes"

cd /home/ellie/ellie-home
git add server/api/dispatches/
git commit -m "[ELLIE-1141] Add dispatches API endpoints"
```

---

## Task 7: Dispatches Page

**Files:**
- Create: `ellie-home/app/pages/dispatches.vue`

- [ ] **Step 1: Create the dispatches page**

Build `app/pages/dispatches.vue` with:

**WebSocket connection:** Connect to relay WS at `ws://localhost:3001/ws/ellie-chat`, listen for `dispatch_update` and `tool_approval` events. Fall back to 10-second polling on disconnect.

**Layout sections:**
1. **Needs Your Attention** (top, orange): blocking questions with answer input, tool approvals with approve/deny buttons. Notification sound on new blocking items.
2. **Active Dispatches**: recursive tree view with color-coded left borders (green=parent, blue=working, orange=needs input, red=failed/timed_out, gray=done). Elapsed time per item. Cancel button. Expand/collapse for completed sub-trees.
3. **Bulk Actions**: "Cancel all failed", "Retry timed out" (when failures exist).
4. **Completed** (collapsed): recent completed trees.

**Patterns:** Nuxt 4.3, Tailwind v4 utility classes only, `$fetch` for API calls, times in CST.

- [ ] **Step 2: Build and test**

```bash
cd /home/ellie/ellie-home && bun run build && sudo systemctl restart ellie-dashboard
```

Open `dashboard.ellie-labs.dev/dispatches`. Verify empty state.

- [ ] **Step 3: Commit**

```bash
git add app/pages/dispatches.vue
git commit -m "[ELLIE-1141] Add dispatches page — real-time orchestration visibility"
```

---

## Task 8: Chrome Extension

**Files:**
- Create: `ellie-dispatch-extension/manifest.json`
- Create: `ellie-dispatch-extension/sidepanel.html`
- Create: `ellie-dispatch-extension/background.js`

- [ ] **Step 1: Create the extension directory and files**

Create `ellie-dispatch-extension/manifest.json`:

```json
{
  "manifest_version": 3,
  "name": "Ellie Dispatches",
  "version": "1.0.0",
  "description": "Ellie OS dispatch panel — see what agents are working on",
  "permissions": ["sidePanel"],
  "side_panel": {
    "default_path": "sidepanel.html"
  },
  "background": {
    "service_worker": "background.js"
  },
  "host_permissions": ["https://dashboard.ellie-labs.dev/*"],
  "icons": {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  }
}
```

Create `ellie-dispatch-extension/sidepanel.html`:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; padding: 0; }
    body { width: 100%; height: 100vh; overflow: hidden; background: #0a0e17; }
    iframe { width: 100%; height: 100%; border: none; }
    .offline { display: none; color: #94a3b8; text-align: center; padding: 40px 20px; font-family: system-ui; }
    .offline.show { display: block; }
    .offline button { margin-top: 12px; padding: 6px 16px; background: #1e293b; color: #e2e8f0; border: 1px solid #334155; border-radius: 6px; cursor: pointer; }
  </style>
</head>
<body>
  <iframe id="frame" src="https://dashboard.ellie-labs.dev/dispatches"></iframe>
  <div id="offline" class="offline">
    <p>Dashboard offline</p>
    <p style="font-size: 12px; margin-top: 8px; color: #64748b;">Retrying every 30 seconds...</p>
    <button onclick="retry()">Retry Now</button>
  </div>
  <script>
    const frame = document.getElementById('frame');
    const offline = document.getElementById('offline');
    let retryTimer;

    frame.onerror = () => showOffline();
    frame.onload = () => {
      offline.classList.remove('show');
      frame.style.display = 'block';
      clearInterval(retryTimer);
    };

    function showOffline() {
      frame.style.display = 'none';
      offline.classList.add('show');
      retryTimer = setInterval(retry, 30000);
    }

    function retry() {
      frame.src = 'https://dashboard.ellie-labs.dev/dispatches';
    }

    // Detect iframe load failure (CSP/network)
    setTimeout(() => {
      try {
        if (!frame.contentWindow?.document?.body?.innerHTML) showOffline();
      } catch { /* cross-origin, means it loaded */ }
    }, 5000);
  </script>
</body>
</html>
```

Create `ellie-dispatch-extension/background.js`:

```javascript
const BADGE_URL = 'https://dashboard.ellie-labs.dev/api/dispatches/badge';
const POLL_INTERVAL = 10000;

async function updateBadge() {
  try {
    const res = await fetch(BADGE_URL);
    if (!res.ok) throw new Error('fetch failed');
    const { needs_attention } = await res.json();
    if (needs_attention > 0) {
      chrome.action.setBadgeText({ text: String(needs_attention) });
      chrome.action.setBadgeBackgroundColor({ color: '#f97316' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  } catch {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  }
}

// Poll for badge updates
setInterval(updateBadge, POLL_INTERVAL);
updateBadge();

// Open side panel on click
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
```

- [ ] **Step 2: Create placeholder icons**

Create simple SVG-based PNG icons at 16x16, 48x48, 128x128 in `ellie-dispatch-extension/icons/`. Or copy from an existing extension and replace later.

- [ ] **Step 3: Test locally**

1. Open Chrome → `chrome://extensions/`
2. Enable Developer Mode
3. Click "Load unpacked" → select `ellie-dispatch-extension/`
4. Extension should appear with icon
5. Click icon → side panel opens with dispatches page
6. Badge should show count (or "!" if dashboard is down)

- [ ] **Step 4: Commit**

```bash
git add ellie-dispatch-extension/
git commit -m "[ELLIE-1141] Add Chrome extension — dispatches side panel + badge"
```

---

## Task 9: Deprecation — Remove Old Orchestration Modules

**Files:**
- Remove: `src/orchestration-tracker.ts`
- Remove: `src/orchestration-ledger.ts`
- Remove: `src/orchestration-dispatch.ts`
- Remove: `src/orchestration-init.ts`
- Remove: `src/dispatch-queue.ts`
- Modify: `src/relay.ts` (remove imports/init for deprecated modules)
- Modify: `src/coordinator.ts` (remove tracker calls)
- Remove: `ellie-home/app/components/ellie/OrchestrationPanel.vue`

- [ ] **Step 1: Identify all import sites**

Search for imports of each deprecated module across the codebase. Update callers to use GTD equivalents or remove dead code.

- [ ] **Step 2: Remove modules and update imports**

Remove each file and fix all broken imports. The orchestration-monitor stays (expanded in Task 4). The `/orchestrator` page stays (reads from `routing_decisions`, independent).

- [ ] **Step 3: Run all tests to verify no regressions**

```bash
cd /home/ellie/ellie-dev && bun test
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "[ELLIE-1141] Deprecate old orchestration modules — GTD is now the source of truth"
```

---

## Summary

| Task | Phase | What It Does |
|------|-------|-------------|
| 1 | Schema | parent_id, created_by, is_orchestration, urgency, failure states |
| 2 | API | GTD orchestration CRUD: trees, auto-completion, cancel, answer, orphan recovery |
| 3 | Coordinator | GTD writes on dispatch, compaction recovery, answer reading |
| 4 | Monitor | 30-min timeout for orchestration items, orphan recovery on startup |
| 5 | Skill | GTD skill orchestration pattern, recovery, narration |
| 6 | Events + API | WebSocket dispatch events, relay HTTP routes, dashboard API proxies |
| 7 | UI | /dispatches page with real-time tree, answers, approvals, bulk actions |
| 8 | Extension | Chrome side panel + badge count |
| 9 | Cleanup | Remove deprecated orchestration tracker/ledger/dispatch/init/queue |
