# Google Tasks → UMS → GTD Integration

**ELLIE-300** | Architecture Documentation

> Unified Message System (UMS) integration for Google Tasks. External task systems flow through UMS so GTD can ingest them via a normalized interface.

## Overview

Google Tasks now flows through the Unified Message System (UMS) before reaching the GTD inbox. This architectural change:

- **Decouples** task ingestion from the source system
- **Normalizes** tasks into a common format alongside messages, emails, and calendar events
- **Enables** future integration of other task systems (Todoist, Microsoft To Do, etc.) without changing GTD
- **Resolves** endpoint conflict (ELLIE-277) — Google Tasks no longer needs a dedicated API route

## Architecture

```
Google Tasks API (MCP)
  │
  ├── Poll every 5 minutes (periodic-tasks.ts)
  │
  ↓
Google Tasks Connector (googleTasksConnector)
  │
  ├── Normalize task → UnifiedMessage
  ├── Content type: "task"
  ├── Metadata: title, notes, due_date, external_status
  │
  ↓
unified_messages table (Supabase)
  │
  ├── Stored with provider="google-tasks"
  ├── Duplicate detection via provider_id
  │
  ↓
UMS Event Bus
  │
  ├── Emit: "message.ingested" event
  │
  ↓
GTD Consumer (push subscriber)
  │
  ├── Listen: content_type="task"
  ├── Create inbox item in todos table
  ├── Status: "inbox"
  ├── Tags: ["imported", "source:google-tasks"]
  │
  ↓
todos table (Supabase)
```

## Components

### 1. Polling Task (`src/periodic-tasks.ts`)

**Location:** Lines 396-422

**What it does:**
- Runs every 5 minutes
- Calls Google Workspace MCP: `list_tasks`
- Fetches up to 100 tasks
- Passes each task to UMS for ingestion

**Code:**
```typescript
periodicTask(async () => {
  const tasksResult = await callMcpTool("google-workspace", "list_tasks", {
    tasklist_id: "@default",
    max_results: 100,
  });

  for (const task of tasksResult.tasks) {
    const message = await ingest(supabase, "google-tasks", task);
  }
}, 5 * 60_000, "google-tasks-poll");
```

**Limitations:**
- Hardcoded `max_results: 100` — users with >100 tasks will only see the first 100
- No pagination support
- See [Known Limitations](#known-limitations) for details

### 2. Google Tasks Connector (`src/ums/connectors/google-tasks.ts`)

**What it does:**
- Implements `UMSConnector` interface
- Transforms raw Google Tasks payload → `UnifiedMessageInsert`
- Extracts task metadata (title, notes, due date, status)

**Normalization logic:**
```typescript
normalize(rawPayload: unknown): UnifiedMessageInsert | null {
  const task = rawPayload as GoogleTaskItem;
  if (!task.id || !task.title) return null;

  return {
    provider: "google-tasks",
    provider_id: task.id,  // Unique task ID from Google
    channel: "google-tasks:default",
    sender: null,
    content: `${task.title}\n\n${task.notes || ""}`,
    content_type: "task",
    provider_timestamp: task.updated || null,
    metadata: {
      title: task.title,
      notes: task.notes,
      due_date: task.due,
      external_status: task.status,
    },
    raw: rawPayload,  // Preserve original payload
  };
}
```

**Key decisions:**
- `provider_id` = Google's task ID (enables duplicate detection)
- `content` = concatenated title + notes (searchable text)
- `metadata` = structured fields for future use
- `raw` = full original payload preserved for debugging

### 3. GTD Consumer (`src/ums/consumers/gtd.ts`)

**What it does:**
- Push subscriber — listens to all UMS messages
- Filters for `content_type="task"`
- Creates inbox entries in `todos` table

**Task handling (lines 56-66):**
```typescript
if (message.content_type === "task") {
  await createInboxItem(supabase, {
    content: message.content,
    priority: null,
    tags: ["imported", `source:${message.provider}`],
    source_type: "ums",
    source_ref: `${message.provider}:${message.provider_id}`,
  });
  return;
}
```

**Why tasks are always actionable:**
Unlike messages (which require heuristic detection), tasks are inherently actionable. If it's in Google Tasks, it goes to GTD inbox — no pattern matching needed.

### 4. Database Schema

**unified_messages table:**
```sql
id              uuid PRIMARY KEY
provider        text NOT NULL           -- "google-tasks"
provider_id     text NOT NULL           -- Google's task ID
channel         text NOT NULL           -- "google-tasks:default"
sender          text                    -- NULL for tasks
content         text NOT NULL           -- "Task title\n\nTask notes"
content_type    text NOT NULL           -- "task"
provider_timestamp timestamptz          -- Task's updated timestamp
metadata        jsonb                   -- { title, notes, due_date, external_status }
raw             jsonb                   -- Full original payload
created_at      timestamptz DEFAULT now()

UNIQUE (provider, provider_id)         -- Prevents duplicates
```

**todos table:**
```sql
id          uuid PRIMARY KEY
content     text NOT NULL          -- Task title + notes (truncated to 2000 chars)
status      text DEFAULT 'inbox'  -- Always "inbox" for new tasks
priority    text                  -- NULL (tasks don't carry priority)
tags        text[]                -- ["imported", "source:google-tasks"]
source_type text                  -- "ums"
source_ref  text                  -- "google-tasks:{task_id}"
created_at  timestamptz DEFAULT now()
```

## Data Flow Example

**Google Task:**
```json
{
  "id": "MTIzNDU2Nzg5",
  "title": "Review Q1 budget proposal",
  "notes": "Focus on marketing spend variance",
  "due": "2026-03-25T00:00:00.000Z",
  "status": "needsAction",
  "updated": "2026-03-21T14:30:00.000Z"
}
```

**After normalization (UnifiedMessage):**
```json
{
  "provider": "google-tasks",
  "provider_id": "MTIzNDU2Nzg5",
  "channel": "google-tasks:default",
  "sender": null,
  "content": "Review Q1 budget proposal\n\nFocus on marketing spend variance",
  "content_type": "task",
  "provider_timestamp": "2026-03-21T14:30:00.000Z",
  "metadata": {
    "title": "Review Q1 budget proposal",
    "notes": "Focus on marketing spend variance",
    "due_date": "2026-03-25T00:00:00.000Z",
    "external_status": "needsAction"
  },
  "raw": { /* original payload */ }
}
```

**GTD inbox item (todos):**
```json
{
  "content": "Review Q1 budget proposal\n\nFocus on marketing spend variance",
  "status": "inbox",
  "priority": null,
  "tags": ["imported", "source:google-tasks"],
  "source_type": "ums",
  "source_ref": "google-tasks:MTIzNDU2Nzg5"
}
```

## Known Limitations

### 1. Task Updates Not Captured

**Status:** Architectural limitation (by design)

**What happens:**
- UMS uses `ignoreDuplicates: true` when inserting messages
- If a Google Task is modified after initial ingestion, the update is silently skipped
- GTD inbox shows the original task text

**Example scenario:**
1. Poll fetches task "Buy milk" → ingested to UMS → GTD inbox created
2. User edits task to "Buy milk and eggs" in Google Tasks
3. Next poll fetches updated task → UMS sees duplicate `provider_id` → skips
4. GTD still shows "Buy milk"

**Why this exists:**
UMS is designed as an append-only "dumb pipe" — not a state synchronization system. This is consistent with other connectors (Gmail, calendar events).

**Workaround:**
Users should complete the task in GTD, which will trigger the next poll to capture a fresh version if the task is still open in Google Tasks.

**Future enhancement:**
ELLIE-301 (future ticket) — Add update detection by comparing `provider_timestamp` or using delta/webhook approach.

### 2. Pagination Not Implemented

**Status:** Warning (edge case)

**What happens:**
- Polling task hardcodes `max_results: 100`
- If a user has >100 Google Tasks, only the first 100 are fetched
- Remaining tasks are never ingested

**Impact:**
- Low for personal use (most users have <100 tasks)
- High for power users or team accounts

**Fix:**
Add pagination loop:
```typescript
let pageToken = null;
do {
  const result = await callMcpTool("google-workspace", "list_tasks", {
    tasklist_id: "@default",
    max_results: 100,
    page_token: pageToken,
  });
  // process tasks
  pageToken = result.nextPageToken;
} while (pageToken);
```

**Tracked as:** ELLIE-302 (future enhancement)

### 3. Completed Tasks Re-polled Every Cycle

**Status:** Minor inefficiency

**What happens:**
- Poll fetches all tasks (completed + incomplete)
- UMS skips duplicates, but the API call still transfers completed tasks

**Impact:**
- Wasted bandwidth (minimal — tasks are small)
- No functional issue

**Fix:**
Filter to incomplete tasks only:
```typescript
const tasksResult = await callMcpTool("google-workspace", "list_tasks", {
  tasklist_id: "@default",
  max_results: 100,
  show_completed: false,  // Add this parameter
});
```

**Tracked as:** ELLIE-303 (future optimization)

## Configuration

### Environment Variables

None required — Google Workspace MCP handles authentication.

### Enabling the Integration

The integration is **enabled by default** if:
1. Google Workspace MCP is configured (see `skills/google-workspace/SKILL.md`)
2. Relay is running (`systemctl --user start claude-telegram-relay`)

### Disabling the Integration

To disable Google Tasks polling without removing the MCP:

**Option 1:** Comment out the periodic task in `src/periodic-tasks.ts`:
```typescript
// periodicTask(async () => {
//   // Google Tasks poll code
// }, 5 * 60_000, "google-tasks-poll");
```

**Option 2:** Set polling interval to a very long duration (effectively disables):
```typescript
}, 24 * 60 * 60_000, "google-tasks-poll");  // Poll once per day
```

Restart the relay after changes:
```bash
systemctl --user restart claude-telegram-relay
```

## Testing

### Integration Test

**File:** `tests/ums-google-tasks-gtd-integration.test.ts`

**Coverage:**
- Basic task ingestion (title + notes)
- Completed task handling
- Duplicate detection

**Run:**
```bash
bun test tests/ums-google-tasks-gtd-integration.test.ts
```

**Expected output:**
```
✓ Google Tasks → UMS → GTD — basic task flow
✓ Google Tasks → UMS → GTD — completed task
✓ Google Tasks → UMS → GTD — duplicate task skipped
```

### Manual Testing

1. **Create a task in Google Tasks:**
   - Go to [tasks.google.com](https://tasks.google.com)
   - Add a new task: "Test UMS ingestion"
   - Add notes: "Verify this appears in GTD inbox"

2. **Wait for next poll (max 5 minutes) or trigger manually:**
   ```bash
   # Restart relay to trigger immediate poll
   systemctl --user restart claude-telegram-relay
   ```

3. **Check UMS table:**
   ```sql
   SELECT provider, content, content_type, metadata
   FROM unified_messages
   WHERE provider = 'google-tasks'
   ORDER BY created_at DESC
   LIMIT 5;
   ```

4. **Check GTD inbox:**
   ```sql
   SELECT content, tags, source_ref
   FROM todos
   WHERE 'source:google-tasks' = ANY(tags)
   ORDER BY created_at DESC
   LIMIT 5;
   ```

5. **Verify on dashboard:**
   - Open Ellie dashboard: `http://localhost:3000`
   - Navigate to GTD Inbox
   - Look for task with tag `source:google-tasks`

## Monitoring

### Logs

**Successful poll:**
```
[ums-consumer-gtd] GTD consumer: inbox item created { source: "google-tasks:MTIzNDU2Nzg5", tags: ["imported", "source:google-tasks"] }
[periodic-tasks] Google Tasks poll complete { ingested: 3 }
```

**No new tasks:**
```
(No log output — poll runs silently when no new tasks found)
```

**Errors:**
```
[periodic-tasks] Google Tasks poll failed { err: "MCP call failed" }
[ums-consumer-gtd] GTD consumer failed { messageId: "uuid", err: "Database error" }
```

### Check Logs

```bash
# View last 100 lines
journalctl --user -u claude-telegram-relay -n 100

# Follow live logs (Ctrl+C to stop)
journalctl --user -u claude-telegram-relay -f

# Filter for Google Tasks activity
journalctl --user -u claude-telegram-relay | grep -i "google tasks"
```

## Future Enhancements

### ELLIE-301: Task Update Detection

**Problem:** Task edits in Google Tasks don't propagate to GTD inbox

**Solution approaches:**
1. **Timestamp comparison** — Compare `provider_timestamp` before skipping duplicates
2. **Webhook subscription** — Use Google Tasks push notifications (requires OAuth app setup)
3. **Delta sync** — Track last sync timestamp, only fetch changed tasks

**Trade-offs:**
- Timestamp: simple but requires changing UMS upsert logic
- Webhook: real-time but complex setup, requires public endpoint
- Delta: efficient but depends on API support

### ELLIE-302: Pagination Support

**Problem:** Users with >100 tasks only see first 100

**Solution:**
Add pagination loop to polling task (see [Pagination Not Implemented](#2-pagination-not-implemented))

**Effort:** Low (20 minutes)

### ELLIE-303: Filter Completed Tasks

**Problem:** Polling fetches completed tasks that will be skipped anyway

**Solution:**
Pass `show_completed: false` to MCP call

**Effort:** Trivial (5 minutes)

### ELLIE-304: Multi-Tasklist Support

**Problem:** Only fetches tasks from `@default` list

**Solution:**
1. Fetch all tasklists: `list_tasklists`
2. Poll each list separately
3. Set `channel` to `google-tasks:{list_name}`

**Effort:** Medium (1 hour)

### ELLIE-305: Bidirectional Sync

**Problem:** Completing a task in GTD doesn't mark it complete in Google Tasks

**Solution:**
1. GTD consumer watches for `status` changes on `todos` where `source_type="ums"`
2. When task marked complete, call `update_task` via MCP
3. Requires tracking `provider_id` in `source_ref`

**Effort:** High (3-4 hours, requires careful duplicate prevention)

## References

- **UMS Architecture:** `src/ums/connector.ts` — connector interface
- **GTD Operations Manual:** `docs/gtd-operations-manual.md` — inbox workflow
- **Google Workspace Skill:** `skills/google-workspace/SKILL.md` — MCP setup
- **Commit:** `f35ebcd` — implementation commit
- **Related Tickets:**
  - ELLIE-294: UMS connector interface
  - ELLIE-303: GTD consumer
  - ELLIE-277: Endpoint conflict resolution

---

**Last Updated:** 2026-03-21
**Maintainer:** Dave
