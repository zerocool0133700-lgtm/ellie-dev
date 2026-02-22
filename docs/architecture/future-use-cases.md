# Forest Architecture — Future Use Cases & QA Model

## Future Use Cases

### Overview

Brief descriptions of each use case. See detailed walkthroughs below for full end-to-end flows.

### 1. Incident Response Tree
Something breaks in prod. Tree spawns in nursery, immediately promotes to forest. Multiple entities branch simultaneously — dev agent investigates code, research agent checks logs, strategy agent assesses impact. Creatures pull entities in as the scope widens. Tree closes with a post-mortem commit on trunk. Fast lifecycle, high urgency.

### 2. Onboarding Tree
New user (or new team member) goes through setup. Linear trunk with checkpoint branches — "configured Telegram," "set up Supabase," "personalized profile." Each step is a commit. If they go off-path (ask unrelated questions mid-setup), that's a branch that merges back. Tree closes when onboarding is complete. Template-driven — same trunk shape every time.

### 3. Learning/Research Tree
Dave asks "how does Cloudflare Workers KV compare to Durable Objects?" Research entity branches, comes back with findings. Dave asks a follow-up — another branch. Over days/weeks, this tree accumulates knowledge. Multi-trunk potential: one trunk per sub-topic. Never fully "done" — goes dormant, reactivates when relevant.

---

## Contract System Design — What Calls For It?

The unified architecture (git + Postgres + JSON schemas) enables a **rules engine pattern** where data contracts define structure, Postgres stores metadata and rules, and git holds the source of truth.

**Multi-Tenant by Design:** This architecture supports multiple users, workspaces, and organizations. Every tree, entity, and creature is tenant-scoped via workspace/user IDs. One Ellie instance can serve many users with full data isolation.

### Why Unified Postgres Architecture?

**The Stack:**
```
┌─────────────────────────────────────┐
│  Git Repos (source of truth)        │
│  .forest/trees/work-session-86/     │
│    ├── tree.json                    │
│    └── commits/                     │
└─────────────────────────────────────┘
              ↓ validated by
┌─────────────────────────────────────┐
│  JSON Schemas (contracts)            │
│  schemas/work-session-tree.schema   │
│  schemas/commit-message.schema      │
│  Stored in Postgres jsonb columns   │
└─────────────────────────────────────┘
              ↓ indexed in
┌─────────────────────────────────────┐
│  Postgres via Supabase (all data)   │
│  • trees table (fast queries)       │
│  • policies table (validation)      │
│  • forest_events table (audit log)  │
│  • contracts table (JSON schemas)   │
│  • Realtime subscriptions           │
│  • Edge functions for rules         │
└─────────────────────────────────────┘
              ↓ triggers
┌─────────────────────────────────────┐
│  Forest Creatures (orchestration)    │
│  Postgres triggers + pg-boss queue  │
│  Supabase realtime → dispatch       │
└─────────────────────────────────────┘
              ↓ fallback (if needed)
┌─────────────────────────────────────┐
│  Elasticsearch (document storage)    │
│  Full-text search, large documents  │
│  Only used when Postgres jsonb      │
│  or text search is insufficient     │
└─────────────────────────────────────┘
```

**Why Postgres wins:**
1. **JSON-native (jsonb)** — tree.json in git maps to Postgres jsonb column with full indexing
2. **Strong schema + flexibility** — relational integrity where needed, jsonb where desired
3. **Advanced queries** — GIN indexes on jsonb enable fast nested queries without NoSQL
4. **Realtime built-in** — Supabase realtime subscriptions replace change streams
5. **SQL aggregations** — window functions, CTEs, recursive queries for complex analytics
6. **Native validation** — Check constraints + edge functions validate JSON schemas
7. **Single source of truth** — No multi-database sync issues, no vocabulary drift
8. **pg-boss for dispatch** — Postgres-native job queue with retry, timeout, and fan-out
9. **Multi-tenant ready** — Row-level security (RLS) for workspace isolation

### Concrete Example: KPI Data Package Worker

**Use case:** Dashboard needs to display "Active Work Sessions by Agent" — a live chart that refreshes every 5 minutes.

**Postgres defines the KPI:**
```sql
-- kpis table (jsonb column for config)
INSERT INTO kpis (id, name, category, refresh_interval, config) VALUES (
  'kpi-active-work-sessions',
  'Active Work Sessions by Agent',
  'productivity',
  300,  -- seconds
  '{
    "schema": "schemas/kpi-work-sessions.schema.json",

    "source": {
      "type": "sql",
      "query": "
        SELECT
          te.entity_id as agent,
          COUNT(DISTINCT t.id) as count,
          AVG(EXTRACT(EPOCH FROM (c.committed_at - t.created_at))) as avg_duration
        FROM trees t
        JOIN tree_entities te ON te.tree_id = t.id
        LEFT JOIN commits c ON c.tree_id = t.id
        WHERE t.type = ''work_session''
          AND t.state IN (''growing'', ''paused'')
        GROUP BY te.entity_id
      "
    },

    "ui": {
      "component": "BarChart",
      "x_axis": "agent",
      "y_axis": "count",
      "tooltip": ["avg_duration"]
    }
  }'::jsonb
);
```

**JSON Schema validates output:**
```json
// schemas/kpi-work-sessions.schema.json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "kpi_id": { "type": "string" },
    "timestamp": { "type": "string", "format": "date-time" },
    "data": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "agent": { "type": "string" },
          "count": { "type": "integer", "minimum": 0 },
          "avg_duration": { "type": "number" }
        },
        "required": ["agent", "count"]
      }
    }
  },
  "required": ["kpi_id", "timestamp", "data"]
}
```

**Worker process (forest creature):**
```typescript
// src/creatures/kpi-worker.ts
async function fetchKPI(kpiId: string) {
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);

  // 1. Load KPI definition from Postgres
  const { data: kpi } = await supabase
    .from('kpis')
    .select('*')
    .eq('id', kpiId)
    .single();

  // 2. Execute the SQL query from config
  const { data: rawData } = await supabase.rpc('execute_dynamic_query', {
    query: kpi.config.source.query
  });

  // 3. Transform into data package
  const dataPackage = {
    kpi_id: kpiId,
    timestamp: new Date().toISOString(),
    data: rawData
  };

  // 4. Validate against schema
  const schema = JSON.parse(await fs.readFile(kpi.config.schema, 'utf-8'));
  const validate = ajv.compile(schema);
  if (!validate(dataPackage)) {
    throw new Error(`Validation failed: ${ajv.errorsText(validate.errors)}`);
  }

  // 5. Store result for UI consumption
  await supabase
    .from('kpi_data')
    .upsert({ kpi_id: kpiId, ...dataPackage });

  // 6. Publish to realtime channel
  await supabase.channel(`kpi:${kpiId}`).send({
    type: 'broadcast',
    event: 'update',
    payload: dataPackage
  });
}
```

**UI consumes via Supabase realtime:**
```typescript
// Dashboard component subscribes to real-time updates
const channel = supabase.channel('kpi:kpi-active-work-sessions');

channel
  .on('broadcast', { event: 'update' }, (payload) => {
    setData(payload.data);  // Live chart updates
  })
  .subscribe();
```

### The Rules Engine Pattern

**What this enables:**

1. **Zero-code KPI creation** — insert a Postgres row with jsonb config, worker auto-discovers it
2. **Self-validating** — JSON schema ensures data quality before UI sees it
3. **Real-time by default** — Supabase realtime subscriptions push updates instantly
4. **Portable** — KPI definitions can be exported/imported as JSON
5. **A/B testable** — run two SQL versions, compare results
6. **Version controlled** — KPI definitions live in git, Postgres is runtime
7. **Multi-tenant safe** — Row-level security isolates data per workspace

**The pattern applies to:**
- **Alerts** — rule fires → dispatch notification
- **Automations** — tree state changes → run action
- **Workflows** — entity commits → check policy → trigger next step
- **Dashboards** — any data package consumed by UI
- **Reports** — scheduled data aggregations with validation

### Open Questions

**What patterns call for contracts?**
- Anytime data flows between components (entities → trees, trees → UI, agents → agents)
- Anytime rules need to be dynamic (policies, KPIs, workflows)
- Anytime validation is critical (money, commits, approvals)
- Anytime you want self-describing systems (portable, exportable, versionable)

---

## Implementation Note

**Architecture Evolution:** The examples below reference MongoDB for historical/illustrative purposes. The actual implementation uses **Postgres (via Supabase)** as the sole database:

- MongoDB documents → **Postgres rows with jsonb columns**
- MongoDB change streams → **Supabase realtime subscriptions**
- MongoDB aggregation pipelines → **SQL queries with window functions & CTEs**
- MongoDB collections → **Postgres tables**

Read "MongoDB document" as "Postgres row" and `` as `config jsonb`. The semantic patterns remain identical.

---

## Detailed Use Case Walkthrough: Scheduled Automation Tree

### Overview
Morning briefing, weekly reviews, memory cleanup. These are recurring trees that follow the same pattern each time. Trunk is the template, each execution is a branch. The branch commits its outputs and merges. Think of it like a cron job with full audit history.

**Example:** Daily morning briefing at 8:00 AM CST

---

### Tree Creation

**MongoDB document:**
```js
// trees collection
{
  _id: "tree-automation-morning-briefing",
  type: "automation",
  state: "active",
  git_path: ".forest/trees/automation-morning-briefing",
  created_at: "2026-02-01T00:00:00Z",
  owner: "dave",

  // Automation-specific config
  schedule: {
    type: "cron",
    expression: "0 8 * * *",  // Daily at 8:00 AM
    timezone: "America/Chicago",
    enabled: true
  },

  // Template defines what happens each run
  template: {
    steps: [
      { entity: "calendar-agent", action: "fetch_todays_events" },
      { entity: "memory-agent", action: "recall_pending_actions" },
      { entity: "gmail-agent", action: "unread_summary" },
      { entity: "general-agent", action: "synthesize_briefing" }
    ],
    output_format: "telegram_message"
  },

  // Trunk is the master template, branches are executions
  trunks: [
    { name: "main", head: "template-v2", commits: 2 }
  ],

  // Track execution history
  executions: {
    total: 48,
    last_run: "2026-02-20T08:00:00Z",
    next_run: "2026-02-21T08:00:00Z",
    failures: 2,
    success_rate: 0.958
  },

  branches: [],  // Active execution branches

  // Retention policy
  retention: {
    branch_ttl: 2592000,  // 30 days in seconds
    composting: {
      enabled: true,
      keep_successful: 30,  // Keep last 30 successful runs
      keep_failed: 0,  // Keep all failures
      compress_after: 90  // Archive branches older than 90 days
    }
  }
}
```

**Git structure:**
```
.forest/trees/automation-morning-briefing/
├── tree.json (metadata)
├── schemas/
│   ├── automation-tree.schema.json
│   ├── execution-commit.schema.json
│   └── briefing-output.schema.json
├── template/
│   └── briefing-template-v2.json
└── executions/
    ├── 2026-02-20/
    ├── 2026-02-19/
    └── ...
```

---

### Execution Flow: Day 1 (2026-02-20)

**Step 1: Scheduled trigger**

A forest creature (`automation-scheduler`) watches MongoDB for automation trees:

```typescript
// src/creatures/automation-scheduler.ts
async function checkScheduledTrees() {
  const now = new Date();

  const dueForExecution = await db.collection('trees').find({
    type: 'automation',
    state: 'active',
    'schedule.enabled': true,
    'executions.next_run': { $lte: now }
  }).toArray();

  for (const tree of dueForExecution) {
    await executeAutomationTree(tree._id);
  }
}

setInterval(checkScheduledTrees, 60000);  // Check every minute
```

**Step 2: Branch creation**

At 8:00 AM CST, the creature creates an execution branch:

```js
// MongoDB update
{
  branches: [
    {
      name: "exec/2026-02-20-08-00",
      parent_trunk: "main",
      status: "running",
      created_at: "2026-02-20T08:00:00Z",
      execution_id: "exec-abc123"
    }
  ]
}
```

**Step 3: Entity dispatch (parallel)**

The creature dispatches all entities from the template in parallel:

```typescript
async function executeAutomationTree(treeId: string) {
  const tree = await db.collection('trees').findOne({ _id: treeId });
  const branch = `exec/${new Date().toISOString().split('T')[0]}-${Date.now()}`;

  // Create execution branch
  await createBranch(tree.git_path, branch, 'main');

  // Dispatch entities in parallel
  const results = await Promise.all(
    tree.template.steps.map(step =>
      dispatchEntity(step.entity, {
        tree_id: treeId,
        branch,
        action: step.action
      })
    )
  );

  // Commit results
  for (const result of results) {
    await commitToTree(tree.git_path, branch, {
      type: 'execution_step',
      entity: result.entity,
      data: result.output,
      timestamp: new Date().toISOString()
    });
  }
}
```

**Step 4: Entity commits**

Each entity commits its output to the execution branch:

**Calendar agent commit:**
```json
// commits/calendar-2026-02-20.json
{
  "$schema": "../schemas/execution-commit.schema.json",
  "type": "data_fetch",
  "entity": "calendar-agent",
  "action": "fetch_todays_events",
  "result": {
    "events": [
      {
        "time": "10:00 AM",
        "title": "Team standup",
        "calendar": "Work"
      },
      {
        "time": "2:00 PM",
        "title": "Dentist appointment",
        "calendar": "Personal"
      }
    ],
    "count": 2
  },
  "execution_time_ms": 234,
  "timestamp": "2026-02-20T08:00:15Z"
}
```

**Memory agent commit:**
```json
// commits/memory-2026-02-20.json
{
  "$schema": "../schemas/execution-commit.schema.json",
  "type": "data_fetch",
  "entity": "memory-agent",
  "action": "recall_pending_actions",
  "result": {
    "action_items": [
      {
        "text": "Install RAM in Mac Mini, boot it, enable SSH",
        "created": "2026-02-19",
        "priority": "medium"
      },
      {
        "text": "Finalize Ellie Feed Chrome extension post",
        "created": "2026-02-19",
        "priority": "low"
      }
    ],
    "count": 2
  },
  "execution_time_ms": 512,
  "timestamp": "2026-02-20T08:00:16Z"
}
```

**Gmail agent commit:**
```json
// commits/gmail-2026-02-20.json
{
  "$schema": "../schemas/execution-commit.schema.json",
  "type": "data_fetch",
  "entity": "gmail-agent",
  "action": "unread_summary",
  "result": {
    "unread_count": 0,
    "important": [],
    "digest": "No unread messages"
  },
  "execution_time_ms": 892,
  "timestamp": "2026-02-20T08:00:17Z"
}
```

**Step 5: Synthesis**

General agent reads all commits and synthesizes the briefing:

```json
// commits/synthesis-2026-02-20.json
{
  "$schema": "../schemas/execution-commit.schema.json",
  "type": "synthesis",
  "entity": "general-agent",
  "action": "synthesize_briefing",
  "sources": [
    { "commit": "calendar-2026-02-20.json" },
    { "commit": "memory-2026-02-20.json" },
    { "commit": "gmail-2026-02-20.json" }
  ],
  "result": {
    "message": "Good morning, Dave!\n\n📅 **Today's Schedule (2 events)**\n• 10:00 AM - Team standup\n• 2:00 PM - Dentist appointment\n\n✅ **Pending Action Items**\n• Install RAM in Mac Mini, boot it, enable SSH\n• Finalize Ellie Feed Chrome extension post\n\n📧 **Email**\nNo unread messages.\n\nHave a great day!",
    "format": "telegram_message"
  },
  "execution_time_ms": 1456,
  "timestamp": "2026-02-20T08:00:19Z"
}
```

**Step 6: Validate output**

Before merging, validate the synthesis against the contract:

```json
// schemas/briefing-output.schema.json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "type": { "const": "synthesis" },
    "result": {
      "type": "object",
      "properties": {
        "message": { "type": "string", "minLength": 10 },
        "format": { "enum": ["telegram_message", "gchat_message", "email"] }
      },
      "required": ["message", "format"]
    }
  },
  "required": ["type", "result"]
}
```

If validation fails, mark the execution as failed and don't merge.

**Step 7: Deliver output**

Send the message to Telegram:

```typescript
await telegram.sendMessage(TELEGRAM_USER_ID, synthesis.result.message);
```

**Step 8: Merge execution branch**

```typescript
await mergeBranch(tree.git_path, 'exec/2026-02-20-08-00', 'main');
```

**Step 9: Update MongoDB**

```js
{
  executions: {
    total: 49,  // +1
    last_run: "2026-02-20T08:00:00Z",
    next_run: "2026-02-21T08:00:00Z",  // Recalculated from cron
    failures: 2,
    success_rate: 0.959
  },
  branches: []  // Execution branch cleared after merge
}
```

---

### Execution Flow: Failure Case (2026-02-15)

**Scenario:** Gmail agent times out (API down)

**Step 1-4:** Same as above

**Step 5:** General agent gets partial data:
- ✅ Calendar: success
- ✅ Memory: success
- ❌ Gmail: timeout error

**Step 6:** General agent commits partial synthesis:

```json
// commits/synthesis-2026-02-15.json
{
  "type": "synthesis",
  "entity": "general-agent",
  "result": {
    "message": "Good morning, Dave!\n\n📅 **Today's Schedule**\n...\n\n📧 **Email**\n⚠️ Unable to fetch email (Gmail API timeout)",
    "format": "telegram_message",
    "warnings": ["gmail_fetch_failed"]
  },
  "execution_time_ms": 945,
  "timestamp": "2026-02-15T08:00:18Z"
}
```

**Step 7:** Validation passes (warnings are allowed, message exists)

**Step 8:** Deliver partial briefing to Telegram

**Step 9:** Merge, but mark as degraded:

```js
{
  executions: {
    total: 44,
    last_run: "2026-02-15T08:00:00Z",
    next_run: "2026-02-16T08:00:00Z",
    failures: 2,  // Not incremented (partial success)
    success_rate: 0.955,
    last_degraded: "2026-02-15T08:00:00Z"
  }
}
```

---

### Composting & Retention

**After 30 days:**

A creature (`tree-gardener`) runs retention policies:

```typescript
// src/creatures/tree-gardener.ts
async function compostExecutionBranches() {
  const trees = await db.collection('trees').find({
    type: 'automation',
    'retention.composting.enabled': true
  }).toArray();

  for (const tree of trees) {
    const branches = await listBranches(tree.git_path, 'exec/*');
    const sorted = branches.sort((a, b) => b.date - a.date);

    // Keep last N successful
    const toKeep = sorted.filter(b => b.status === 'success')
      .slice(0, tree.retention.composting.keep_successful);

    // Keep all failures
    const failures = sorted.filter(b => b.status === 'failed');

    const toCompost = sorted.filter(b =>
      !toKeep.includes(b) && !failures.includes(b)
    );

    for (const branch of toCompost) {
      // Archive to compressed storage
      await archiveBranch(tree.git_path, branch.name, {
        destination: `${tree.git_path}/archives/${branch.name}.tar.gz`,
        delete_after_archive: true
      });

      console.log(`[tree-gardener] Composted: ${branch.name}`);
    }
  }
}
```

**Result:**
- Last 30 successful runs: kept as branches (fast access)
- All 2 failures: kept as branches (debugging)
- Runs 31-48 (successful): archived to `.forest/trees/automation-morning-briefing/archives/`
- Archives older than 90 days: moved to cold storage (S3, Glacier, etc.)

---

### Contract System Integration

**MongoDB KPI (automation health):**

```js
// kpis collection
{
  _id: "kpi-automation-health",
  name: "Automation Tree Success Rate",
  source: {
    type: "aggregate",
    collection: "trees",
    pipeline: [
      { $match: { type: "automation" } },
      { $project: {
        name: "$_id",
        success_rate: "$executions.success_rate",
        last_failure: "$executions.last_degraded",
        next_run: "$executions.next_run"
      }},
      { $sort: { success_rate: 1 } }
    ]
  },
  ui: {
    component: "Table",
    columns: ["name", "success_rate", "last_failure", "next_run"],
    highlight_low: { column: "success_rate", threshold: 0.95 }
  }
}
```

**Creature (auto-disable on repeated failures):**

```typescript
// MongoDB change stream on trees
db.collection('trees').watch().on('change', async (change) => {
  const tree = change.fullDocument;

  if (tree.type === 'automation' && tree.executions.success_rate < 0.80) {
    // Auto-disable if success rate drops below 80%
    await db.collection('trees').updateOne(
      { _id: tree._id },
      { $set: { 'schedule.enabled': false } }
    );

    // Alert Dave
    await telegram.sendMessage(TELEGRAM_USER_ID,
      `⚠️ Disabled automation tree ${tree._id} due to low success rate (${tree.executions.success_rate * 100}%)`
    );

    console.log(`[creature] Auto-disabled: ${tree._id}`);
  }
});
```

---

### Comparison to Audit/Compliance Tree (#9)

**Scheduled Automation** and **Audit/Compliance** are similar but differ on retention:

| Aspect | Automation Tree | Audit Tree |
|--------|----------------|------------|
| **Purpose** | Recurring task execution | Compliance evidence |
| **Branch lifecycle** | Composted after N runs | Retained indefinitely |
| **Output** | Action (send message, update data) | Evidence (findings, reports) |
| **Review** | Optional (dashboards show health) | Required (critic reviews trends) |
| **Failure handling** | Retry next run | Must investigate |

**Audit tree example:**

```js
{
  _id: "tree-audit-security-sweep",
  type: "audit",  // Specialized automation with retention
  retention: {
    composting: {
      enabled: false,  // Never compost
      retention_period: null  // Keep forever
    },
    archive_threshold: 90  // Move to cold storage after 90 days
  }
}
```

The critic agent's review workflow would be:

```typescript
// Periodic review (monthly)
async function reviewAuditTrends(treeId: string) {
  const tree = await db.collection('trees').findOne({ _id: treeId });
  const branches = await listBranches(tree.git_path, 'exec/*');

  // Get last 3 months of findings
  const recentBranches = branches.filter(b =>
    b.date > new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
  );

  // Extract findings from each run
  const findings = recentBranches.map(b => {
    const commits = readCommits(tree.git_path, b.name);
    return commits.filter(c => c.type === 'finding');
  }).flat();

  // Trend analysis
  const trendReport = {
    total_findings: findings.length,
    critical: findings.filter(f => f.severity === 'critical').length,
    trend: findings.length > previousMonth ? 'increasing' : 'decreasing',
    recommendation: findings.length > 10
      ? 'Schedule remediation sprint'
      : 'Continue monitoring'
  };

  // Commit the review
  await commitToTree(tree.git_path, 'main', {
    type: 'trend_review',
    entity: 'critic-agent',
    data: trendReport,
    timestamp: new Date().toISOString()
  });
}
```

---

## Summary: Scheduled Automation Tree

**Initial setup** → template defines steps → cron schedule in MongoDB → creature triggers execution

**Execution** → branch created → entities dispatched in parallel → commits results → synthesis → validation → delivery → merge

**Retention** → composting removes old successful branches → failures retained → archives for long-term storage

**Monitoring** → KPIs track success rate → auto-disable on repeated failures → dashboard shows health

**Audit variant** → no composting → all branches retained forever → critic reviews trends → compliance evidence

---

## Detailed Use Case Walkthrough: Onboarding Tree

### Overview
A new user (or Dave setting up a new service) goes through a structured setup flow. The tree is **template-driven** — every onboarding follows the same trunk shape. Each phase is a checkpoint commit. If the user goes off-path (asks unrelated questions mid-setup), that's a branch that merges back. The tree closes when onboarding is complete — or stays open with partial completion if the user skips optional phases.

**Example:** New user sets up the Ellie Telegram relay (Phases 1-7 from CLAUDE.md)

---

### Template System

Before any onboarding tree exists, there's a **template** — a versioned blueprint stored in MongoDB that defines the phases, their order, and which are required.

**MongoDB template document:**
```js
// templates collection
{
  _id: "template-onboarding-relay-v1",
  type: "onboarding",
  version: 1,
  name: "Ellie Relay Onboarding",
  description: "Full setup: Telegram bot, Supabase, personalization, background service, voice",

  phases: [
    {
      id: "telegram",
      name: "Telegram Bot Setup",
      required: true,
      order: 1,
      estimated_minutes: 3,
      entity: "general-agent",
      checkpoint_schema: "schemas/checkpoint-telegram.schema.json",
      inputs: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_USER_ID"],
      validation: "bun run test:telegram",
      depends_on: []
    },
    {
      id: "database",
      name: "Database & Memory — Supabase",
      required: true,
      order: 2,
      estimated_minutes: 12,
      entity: "general-agent",
      checkpoint_schema: "schemas/checkpoint-database.schema.json",
      inputs: ["SUPABASE_URL", "SUPABASE_ANON_KEY", "OPENAI_API_KEY"],
      validation: "bun run test:supabase",
      depends_on: ["telegram"]
    },
    {
      id: "personalize",
      name: "Personalize",
      required: true,
      order: 3,
      estimated_minutes: 3,
      entity: "general-agent",
      checkpoint_schema: "schemas/checkpoint-personalize.schema.json",
      inputs: ["USER_NAME", "USER_TIMEZONE"],
      validation: null,  // No automated test — just file check
      depends_on: ["telegram"]
    },
    {
      id: "test",
      name: "End-to-End Test",
      required: true,
      order: 4,
      estimated_minutes: 2,
      entity: "general-agent",
      checkpoint_schema: "schemas/checkpoint-test.schema.json",
      inputs: [],
      validation: "bun run start",  // Manual — user confirms response
      depends_on: ["telegram", "database", "personalize"]
    },
    {
      id: "background",
      name: "Always On — Background Service",
      required: false,
      order: 5,
      estimated_minutes: 5,
      entity: "general-agent",
      checkpoint_schema: "schemas/checkpoint-background.schema.json",
      inputs: [],
      validation: null,  // Platform-specific check
      depends_on: ["test"]
    },
    {
      id: "proactive",
      name: "Proactive AI — Smart Check-ins & Briefing",
      required: false,
      order: 6,
      estimated_minutes: 5,
      entity: "general-agent",
      checkpoint_schema: "schemas/checkpoint-proactive.schema.json",
      inputs: [],
      validation: null,
      depends_on: ["background"]
    },
    {
      id: "voice",
      name: "Voice Transcription",
      required: false,
      order: 7,
      estimated_minutes: 5,
      entity: "general-agent",
      checkpoint_schema: "schemas/checkpoint-voice.schema.json",
      inputs: ["VOICE_PROVIDER"],
      validation: "bun run test:voice",
      depends_on: ["test"]
    },
    {
      id: "gchat",
      name: "Google Chat Integration",
      required: false,
      order: 8,
      estimated_minutes: 10,
      entity: "general-agent",
      checkpoint_schema: "schemas/checkpoint-gchat.schema.json",
      inputs: ["GOOGLE_CHAT_SERVICE_ACCOUNT_KEY_PATH", "GOOGLE_CHAT_ALLOWED_EMAIL"],
      validation: null,  // Manual — user confirms response in GChat
      depends_on: ["test"]
    }
  ],

  // Completion rules
  completion: {
    required_phases: ["telegram", "database", "personalize", "test"],
    optional_phases: ["background", "proactive", "voice", "gchat"],
    close_on_required_complete: false,  // Don't auto-close, offer optional phases
    dormancy_threshold: 86400  // 24 hours of inactivity → dormant
  },

  // Template versioning
  created_at: "2026-01-01T00:00:00Z",
  superseded_by: null  // Will point to v2 when updated
}
```

**Key design decision:** Templates are versioned but immutable. When you update the onboarding flow, you create `template-onboarding-relay-v2`. In-progress trees keep their original template. New trees get the latest.

---

### Tree Creation

**Trigger:** User clones the repo and runs `claude`. The general agent detects no `.env` exists (or it's incomplete) and spawns an onboarding tree.

**MongoDB tree document:**
```js
// trees collection
{
  _id: "tree-onboarding-user-abc123",
  type: "onboarding",
  state: "active",
  git_path: ".forest/trees/onboarding-user-abc123",
  created_at: "2026-02-20T09:00:00Z",
  owner: "abc123",  // User identifier

  // Link to template (frozen at creation time)
  template_id: "template-onboarding-relay-v1",
  template_version: 1,

  // Single trunk — linear progression
  trunks: [
    { name: "main", head: null, commits: 0 }
  ],

  branches: [],

  // Phase progress tracking
  progress: {
    current_phase: "telegram",
    completed: [],
    skipped: [],
    started_at: "2026-02-20T09:00:00Z",
    last_activity: "2026-02-20T09:00:00Z"
  },

  // Collected user inputs (encrypted at rest)
  collected_inputs: {}
}
```

**Git structure:**
```
.forest/trees/onboarding-user-abc123/
├── tree.json
├── schemas/
│   ├── onboarding-tree.schema.json
│   ├── checkpoint-telegram.schema.json
│   ├── checkpoint-database.schema.json
│   ├── checkpoint-personalize.schema.json
│   ├── checkpoint-test.schema.json
│   ├── checkpoint-background.schema.json
│   ├── checkpoint-proactive.schema.json
│   ├── checkpoint-voice.schema.json
│   └── checkpoint-gchat.schema.json
├── checkpoints/
│   └── (empty — commits land here as phases complete)
└── detours/
    └── (off-path conversations stored here)
```

---

### Phase Execution Flow

#### Phase 1: Telegram Bot Setup

**User interaction:**
```
Ellie: "Let's get you set up! First, I need your Telegram bot token.
       Open Telegram, search for @BotFather, send /newbot..."
User:  "Here's my token: 123456:ABC-DEF"
Ellie: "Got it. Now I need your Telegram user ID.
       Message @userinfobot on Telegram..."
User:  "My ID is 987654321"
```

**What happens in the tree:**

1. General agent collects inputs
2. Saves to `.env`
3. Runs validation (`bun run test:telegram`)
4. Commits checkpoint to trunk

**Checkpoint commit:**
```json
// checkpoints/phase-1-telegram.json
{
  "$schema": "../schemas/checkpoint-telegram.schema.json",
  "type": "checkpoint",
  "phase_id": "telegram",
  "phase_name": "Telegram Bot Setup",
  "status": "completed",
  "entity": "general-agent",

  "inputs_collected": {
    "TELEGRAM_BOT_TOKEN": "***REDACTED***",
    "TELEGRAM_USER_ID": "987654321"
  },

  "validation": {
    "command": "bun run test:telegram",
    "result": "pass",
    "output": "Test message sent successfully",
    "duration_ms": 1523
  },

  "started_at": "2026-02-20T09:00:00Z",
  "completed_at": "2026-02-20T09:04:30Z",
  "duration_minutes": 4.5,

  "timestamp": "2026-02-20T09:04:30Z"
}
```

**Checkpoint schema validates:**
```json
// schemas/checkpoint-telegram.schema.json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "phase_id": { "const": "telegram" },
    "status": { "enum": ["completed", "skipped", "failed"] },
    "inputs_collected": {
      "type": "object",
      "required": ["TELEGRAM_BOT_TOKEN", "TELEGRAM_USER_ID"]
    },
    "validation": {
      "type": "object",
      "properties": {
        "result": { "enum": ["pass", "fail", "skipped"] }
      },
      "required": ["result"]
    }
  },
  "required": ["phase_id", "status", "validation"]
}
```

**MongoDB update after Phase 1:**
```js
{
  progress: {
    current_phase: "database",  // Advance to next
    completed: ["telegram"],
    last_activity: "2026-02-20T09:04:30Z"
  },
  trunks: [
    { name: "main", head: "phase-1-telegram", commits: 1 }
  ]
}
```

---

#### Detour Handling: Off-Path Questions

**During Phase 2 (database setup), the user asks:**
```
User:  "Wait, what's Supabase? Is my data safe there?"
```

This isn't part of the onboarding template. The tree handles it as a **detour branch:**

1. General agent creates branch: `detour/supabase-question-2026-02-20`
2. Answers the question (possibly dispatching research entity)
3. Commits the exchange to the detour branch
4. Merges back to trunk (knowledge captured, doesn't block progress)

**Detour commit:**
```json
// detours/supabase-question.json
{
  "type": "detour",
  "during_phase": "database",
  "question": "What's Supabase? Is my data safe there?",
  "response_summary": "Explained Supabase as managed Postgres, data ownership, RLS policies, encryption at rest",
  "entity": "general-agent",
  "resolved": true,
  "returned_to_phase": "database",
  "timestamp": "2026-02-20T09:15:00Z"
}
```

**Key:** Detours don't reset phase progress. The user picks up right where they left off.

---

#### Partial Completion: User Skips Optional Phases

**After Phase 4 (e2e test passes), the user reaches optional phases:**

```
Ellie: "Core setup complete! Your bot is working.
       Want to set up background service (Phase 5)?
       Or skip to voice transcription (Phase 7)?
       You can also stop here — everything works."
User:  "I'll skip the background stuff for now. Set up voice."
```

**What happens:**
1. Phases 5 and 6 marked as `skipped` (not `failed`)
2. Jump to Phase 7 (voice) — dependency check passes (`test` is complete)
3. After voice completes, offer Phase 8 (gchat)
4. If user says "I'm done," tree enters completion flow

**MongoDB after partial completion:**
```js
{
  progress: {
    current_phase: null,  // No active phase
    completed: ["telegram", "database", "personalize", "test", "voice"],
    skipped: ["background", "proactive", "gchat"],
    last_activity: "2026-02-20T09:45:00Z"
  },
  state: "completed"  // All required phases done
}
```

**Completion commit on trunk:**
```json
// checkpoints/completion-summary.json
{
  "type": "completion",
  "status": "partial",  // Not all optional phases done
  "required_phases": {
    "telegram": "completed",
    "database": "completed",
    "personalize": "completed",
    "test": "completed"
  },
  "optional_phases": {
    "background": "skipped",
    "proactive": "skipped",
    "voice": "completed",
    "gchat": "skipped"
  },
  "total_duration_minutes": 45,
  "skipped_reason": "User chose to complete later",
  "timestamp": "2026-02-20T09:45:00Z"
}
```

---

### Reactivation: Coming Back Later

**6 months later, user messages:**
```
User: "I want to set up the background service now"
```

**Design decision:** Don't reopen the archived onboarding tree. Instead:

1. General agent semantic-searches for related context
2. Finds the completed onboarding tree → reads what was set up
3. Spawns a **new configuration tree** (lightweight, single-phase)
4. References the original onboarding tree ID in metadata

**Why not reopen?**
- Template may have changed (v2 might have different steps)
- User's environment may have changed (different OS, new dependencies)
- Cleaner history — original onboarding is a complete artifact

**New configuration tree:**
```js
{
  _id: "tree-config-background-service-abc123",
  type: "onboarding",  // Same type, different scope
  template_id: "template-onboarding-relay-v1",  // Or v2 if updated

  // Only the phases they need
  phases_override: ["background", "proactive"],  // Subset of template

  // Link to original
  related_trees: [
    { id: "tree-onboarding-user-abc123", relationship: "continuation" }
  ],

  progress: {
    current_phase: "background",
    completed: [],
    skipped: []
  }
}
```

This is lighter than a full onboarding tree — it knows the user already has Telegram, Supabase, etc. configured.

---

### Template Versioning

**Scenario:** You add Phase 9 (Microsoft Outlook) to the onboarding flow.

**What happens:**
1. Create `template-onboarding-relay-v2` with the new phase
2. Mark v1: `superseded_by: "template-onboarding-relay-v2"`
3. In-progress trees on v1 continue with v1 (no mid-onboarding surprises)
4. New onboarding trees get v2

**MongoDB:**
```js
// v1 update
{ superseded_by: "template-onboarding-relay-v2" }

// v2 creation
{
  _id: "template-onboarding-relay-v2",
  version: 2,
  phases: [
    // ... all v1 phases ...
    {
      id: "outlook",
      name: "Microsoft Outlook Integration",
      required: false,
      order: 9,
      estimated_minutes: 10,
      entity: "general-agent",
      depends_on: ["test"]
    }
  ],
  supersedes: "template-onboarding-relay-v1"
}
```

**Migration creature (optional):**
```typescript
// Could notify users on old templates about new phases
async function notifyTemplateUpdate(oldTemplate, newTemplate) {
  const activeTrees = await db.collection('trees').find({
    type: 'onboarding',
    template_id: oldTemplate._id,
    state: 'completed'
  }).toArray();

  for (const tree of activeTrees) {
    const newPhases = newTemplate.phases.filter(
      p => !oldTemplate.phases.find(op => op.id === p.id)
    );

    if (newPhases.length > 0) {
      // Notify user about new optional phases
      await notify(tree.owner,
        `New setup options available: ${newPhases.map(p => p.name).join(', ')}`
      );
    }
  }
}
```

---

### Contract System Integration

**Checkpoint validation schema (generic):**
```json
// schemas/checkpoint-generic.schema.json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "type": { "const": "checkpoint" },
    "phase_id": { "type": "string" },
    "status": { "enum": ["completed", "skipped", "failed"] },
    "validation": {
      "type": "object",
      "properties": {
        "result": { "enum": ["pass", "fail", "skipped"] }
      },
      "required": ["result"]
    },
    "started_at": { "type": "string", "format": "date-time" },
    "completed_at": { "type": "string", "format": "date-time" }
  },
  "required": ["type", "phase_id", "status"],

  "if": { "properties": { "status": { "const": "completed" } } },
  "then": {
    "required": ["validation", "started_at", "completed_at"],
    "properties": {
      "validation": {
        "properties": { "result": { "const": "pass" } }
      }
    }
  }
}
```

**KPI — Onboarding funnel:**
```js
// kpis collection
{
  _id: "kpi-onboarding-funnel",
  name: "Onboarding Completion Funnel",
  source: {
    type: "aggregate",
    collection: "trees",
    pipeline: [
      { $match: { type: "onboarding" } },
      { $unwind: "$progress.completed" },
      { $group: {
        _id: "$progress.completed",
        count: { $sum: 1 }
      }},
      { $sort: { count: -1 } }
    ]
  },
  ui: {
    component: "FunnelChart",
    expected_order: ["telegram", "database", "personalize", "test",
                     "background", "proactive", "voice", "gchat"]
  }
}
```

This tells you: "90% of users complete Telegram, 85% complete database, only 30% set up voice." Classic product funnel — but for your AI assistant setup.

**Creature — stalled onboarding nudge:**
```typescript
// Checks for onboarding trees that stalled
async function nudgeStalledOnboarding() {
  const stalledThreshold = 4 * 60 * 60 * 1000;  // 4 hours
  const now = new Date();

  const stalled = await db.collection('trees').find({
    type: 'onboarding',
    state: 'active',
    'progress.last_activity': { $lt: new Date(now - stalledThreshold) },
    'progress.current_phase': { $ne: null }
  }).toArray();

  for (const tree of stalled) {
    const phase = tree.progress.current_phase;
    await notify(tree.owner,
      `Still working on ${phase}? I can help if you're stuck. ` +
      `Or say "skip" to move on.`
    );
  }
}
```

---

### Summary: Onboarding Tree

**Template** → versioned blueprint defines phases, order, dependencies, required vs optional

**Creation** → detect new user or incomplete setup → spawn tree from latest template → freeze template version

**Execution** → linear phase progression → each phase collects inputs, validates, commits checkpoint → advance to next

**Detours** → off-path questions become branches → merge back without losing progress

**Partial completion** → required phases must pass → optional phases can be skipped → tree closes with completion summary

**Reactivation** → don't reopen old tree → spawn new lightweight config tree → reference original

**Template versioning** → immutable templates → in-progress trees keep their version → new trees get latest → creature notifies about new phases

**Funnel analytics** → KPI tracks where users drop off → creature nudges stalled onboarding

---

## Detailed Use Case Walkthrough: Multi-Agent Debate Tree

### Overview
Dave asks a strategic question or proposes a direction. Instead of one agent answering, all six specialized agents (general, dev, research, critic, strategy, content, finance) weigh in with their perspectives. Each agent gets a branch, commits their analysis, and a synthesis commit merges all viewpoints into a recommendation. This is the "board meeting" concept formalized — collaborative decision-making with full audit trail.

**Example:** "Should we migrate from Supabase to self-hosted Postgres?"

---

### Tree Creation

**Trigger:** Dave explicitly requests multi-agent input, or general agent detects a question with cross-cutting concerns (technical + strategic + financial implications).

**MongoDB tree document:**
```js
// trees collection
{
  _id: "tree-debate-postgres-migration",
  type: "debate",
  state: "active",
  git_path: ".forest/trees/debate-postgres-migration",
  created_at: "2026-02-20T10:00:00Z",
  owner: "dave",
  question: "Should we migrate from Supabase to self-hosted Postgres?",

  // Debate-specific config
  participants: [
    { entity: "dev-agent", role: "technical_feasibility" },
    { entity: "research-agent", role: "options_analysis" },
    { entity: "strategy-agent", role: "business_impact" },
    { entity: "finance-agent", role: "cost_analysis" },
    { entity: "critic-agent", role: "risk_assessment" },
    { entity: "content-agent", role: "documentation_impact" }
  ],

  // Orchestration mode
  orchestration: {
    mode: "parallel",  // All agents work simultaneously
    timeout_minutes: 15,
    consensus_strategy: "synthesis",  // Alternatives: vote, majority, weighted
    requires_all: false  // Proceed even if some agents timeout
  },

  // Single trunk — all branches merge here
  trunks: [
    { name: "main", head: null, commits: 0 }
  ],

  branches: [],

  // Voting/weighting (if used)
  voting: {
    enabled: false,
    weights: {
      "dev-agent": 2,
      "strategy-agent": 2,
      "critic-agent": 1.5,
      "finance-agent": 1.5,
      "research-agent": 1,
      "content-agent": 1
    }
  }
}
```

**Git structure:**
```
.forest/trees/debate-postgres-migration/
├── tree.json
├── schemas/
│   ├── debate-tree.schema.json
│   ├── position-commit.schema.json
│   └── synthesis-commit.schema.json
├── positions/
│   ├── dev-agent.json
│   ├── research-agent.json
│   ├── strategy-agent.json
│   ├── finance-agent.json
│   ├── critic-agent.json
│   └── content-agent.json
└── synthesis/
    └── final-recommendation.json
```

---

### Execution Flow

#### Step 1: Dispatch all agents (parallel)

**Creature (`debate-orchestrator`) dispatches all six agents simultaneously:**

```typescript
// src/creatures/debate-orchestrator.ts
async function orchestrateDebate(treeId: string) {
  const tree = await db.collection('trees').findOne({ _id: treeId });

  // Create branches for each participant
  const branches = await Promise.all(
    tree.participants.map(async (p) => {
      const branchName = `position/${p.entity}-${Date.now()}`;
      await createBranch(tree.git_path, branchName, 'main');
      return { entity: p.entity, branch: branchName, role: p.role };
    })
  );

  // Update MongoDB with active branches
  await db.collection('trees').updateOne(
    { _id: treeId },
    { $set: { branches: branches.map(b => ({
      name: b.branch,
      entity: b.entity,
      status: 'active',
      created_at: new Date()
    }))}}
  );

  // Dispatch all agents in parallel
  const positions = await Promise.all(
    branches.map(b => dispatchAgent(b.entity, {
      tree_id: treeId,
      branch: b.branch,
      question: tree.question,
      role: b.role,
      timeout: tree.orchestration.timeout_minutes * 60 * 1000
    }))
  );

  return positions;
}
```

---

#### Step 2: Each agent commits their position

**Dev agent perspective:**
```json
// positions/dev-agent.json
{
  "$schema": "../schemas/position-commit.schema.json",
  "type": "position",
  "entity": "dev-agent",
  "role": "technical_feasibility",
  "question": "Should we migrate from Supabase to self-hosted Postgres?",

  "position": "feasible_with_tradeoffs",

  "analysis": {
    "complexity": "medium-high",
    "estimated_effort": "2-3 weeks",
    "risks": [
      "Migration downtime (mitigated by staging + feature flag)",
      "Schema migration complexity (Supabase uses standard Postgres, low risk)",
      "Auth system rewrite (Supabase Auth → custom JWT)"
    ],
    "dependencies": [
      "Postgres instance provisioning (ellie-home or cloud)",
      "Connection pooling (pgBouncer recommended)",
      "Backup automation (pg_dump + cron or managed service)"
    ],
    "technical_debt": "Current Supabase Edge Functions need rewriting as API routes"
  },

  "recommendation": "Technically feasible. Recommend phased migration: read-only replica first, then cutover.",

  "confidence": 0.8,
  "timestamp": "2026-02-20T10:05:00Z"
}
```

**Finance agent perspective:**
```json
// positions/finance-agent.json
{
  "$schema": "../schemas/position-commit.schema.json",
  "type": "position",
  "entity": "finance-agent",
  "role": "cost_analysis",
  "question": "Should we migrate from Supabase to self-hosted Postgres?",

  "position": "cost_savings_significant",

  "analysis": {
    "current_cost": {
      "supabase_pro": "$25/month",
      "database_bandwidth": "~$5/month",
      "edge_functions": "$2/month",
      "total": "$32/month"
    },
    "self_hosted_cost": {
      "postgres_hosting": "$0 (ellie-home) or $12/month (DigitalOcean managed)",
      "backup_storage": "$3/month (500GB S3)",
      "maintenance_time": "$0 (Dave does it) or $50/month (managed service)",
      "total_diy": "$3/month",
      "total_managed": "$65/month"
    },
    "break_even": {
      "scenario": "Self-host on ellie-home",
      "savings": "$29/month = $348/year",
      "payback_period": "Migration effort (60 hours) ÷ savings = ~6 months"
    }
  },

  "recommendation": "Self-hosting on ellie-home is significantly cheaper. If reliability concerns arise, DigitalOcean managed Postgres ($12/mo) still saves $20/mo vs Supabase.",

  "confidence": 0.9,
  "timestamp": "2026-02-20T10:06:00Z"
}
```

**Critic agent perspective:**
```json
// positions/critic-agent.json
{
  "$schema": "../schemas/position-commit.schema.json",
  "type": "position",
  "entity": "critic-agent",
  "role": "risk_assessment",
  "question": "Should we migrate from Supabase to self-hosted Postgres?",

  "position": "proceed_with_caution",

  "analysis": {
    "risks_identified": [
      {
        "risk": "Data loss during migration",
        "severity": "critical",
        "likelihood": "low",
        "mitigation": "Dry-run migration on copy of prod DB, validate row counts, rollback plan"
      },
      {
        "risk": "Supabase-specific features break (RLS, realtime)",
        "severity": "high",
        "likelihood": "medium",
        "mitigation": "Rewrite RLS as application-level permissions, replace realtime with SSE"
      },
      {
        "risk": "ellie-home hardware failure",
        "severity": "high",
        "likelihood": "low",
        "mitigation": "Automated backups to S3, 24-hour restore SLA acceptable"
      },
      {
        "risk": "Increased maintenance burden",
        "severity": "medium",
        "likelihood": "medium",
        "mitigation": "Start with managed Postgres, self-host only if cost becomes issue"
      }
    ],
    "challenges": [
      "No longer have Supabase's automatic connection pooling",
      "Lose Supabase Studio UI (replace with pgAdmin or custom dashboard)",
      "Edge Functions rewrite adds scope creep"
    ]
  },

  "recommendation": "Risks are manageable with proper planning. Do NOT underestimate auth rewrite effort. Recommend 3-phase migration plan with rollback points.",

  "confidence": 0.85,
  "timestamp": "2026-02-20T10:07:00Z"
}
```

**Strategy agent perspective:**
```json
// positions/strategy-agent.json
{
  "$schema": "../schemas/position-commit.schema.json",
  "type": "position",
  "entity": "strategy-agent",
  "role": "business_impact",
  "question": "Should we migrate from Supabase to self-hosted Postgres?",

  "position": "aligns_with_long_term_goals",

  "analysis": {
    "strategic_alignment": {
      "control": "Self-hosting gives full control over data, schema, and deployment timing",
      "learning": "Deepens understanding of Postgres internals, valuable for scaling",
      "optionality": "Easier to switch hosting providers (not locked into Supabase API)"
    },
    "timing": {
      "current_usage": "Low traffic, early stage — ideal time to migrate before growth",
      "opportunity_cost": "3 weeks migration = 3 weeks not building features",
      "alternative": "Defer migration until Supabase costs exceed $100/month"
    },
    "business_risk": "If Dave productizes Ellie, self-hosting scales better cost-wise"
  },

  "recommendation": "Strategically sound IF migration happens now (low complexity) rather than later (high user impact). Defer if feature velocity is higher priority.",

  "confidence": 0.75,
  "timestamp": "2026-02-20T10:08:00Z"
}
```

**Research agent perspective:**
```json
// positions/research-agent.json
{
  "$schema": "../schemas/position-commit.schema.json",
  "type": "position",
  "entity": "research-agent",
  "role": "options_analysis",
  "question": "Should we migrate from Supabase to self-hosted Postgres?",

  "position": "multiple_viable_paths",

  "analysis": {
    "options": [
      {
        "option": "Self-host on ellie-home",
        "pros": ["$0 hosting cost", "Full control", "Local network speed"],
        "cons": ["Hardware failure risk", "No managed backups", "Maintenance burden"],
        "best_for": "Cost-conscious, low-traffic, Dave comfortable with ops"
      },
      {
        "option": "Managed Postgres (DigitalOcean, Render, Neon)",
        "pros": ["Automated backups", "HA/failover", "Monitoring included"],
        "cons": ["$12-50/month depending on size", "Still vendor lock-in"],
        "best_for": "Reliability over cost, hands-off management"
      },
      {
        "option": "Stay on Supabase",
        "pros": ["Zero migration effort", "All features work today", "Edge Functions included"],
        "cons": ["$32/month current, scales expensively", "Less control"],
        "best_for": "Feature velocity is top priority"
      },
      {
        "option": "Hybrid — Postgres on ellie-home + Supabase as failover",
        "pros": ["Best of both worlds", "Failover safety net"],
        "cons": ["Complexity", "Need data sync strategy"],
        "best_for": "Risk mitigation during transition"
      }
    ],
    "recommendation": "Option 1 (self-host) if Dave is comfortable with maintenance. Option 2 (managed) if reliability is critical. Option 4 (hybrid) for phased migration."
  },

  "confidence": 0.9,
  "timestamp": "2026-02-20T10:09:00Z"
}
```

**Content agent perspective:**
```json
// positions/content-agent.json
{
  "$schema": "../schemas/position-commit.schema.json",
  "type": "position",
  "entity": "content-agent",
  "role": "documentation_impact",
  "question": "Should we migrate from Supabase to self-hosted Postgres?",

  "position": "significant_documentation_overhaul",

  "analysis": {
    "documentation_changes": [
      {
        "file": "CLAUDE.md",
        "sections_affected": ["Phase 2: Database & Memory"],
        "rewrite_scope": "Replace Supabase setup instructions with Postgres + pgBouncer + backup automation"
      },
      {
        "file": "README.md",
        "sections_affected": ["Prerequisites", "Deployment"],
        "rewrite_scope": "Update prerequisites (remove Supabase MCP, add Postgres connection docs)"
      },
      {
        "file": "db/schema.sql",
        "sections_affected": ["RLS policies"],
        "rewrite_scope": "Convert Supabase RLS to app-level permissions (breaking change for users)"
      }
    ],
    "new_documentation_needed": [
      "Postgres installation guide (macOS, Linux, Windows)",
      "Backup/restore procedures",
      "Connection pooling setup (pgBouncer)",
      "Migration guide for existing Supabase users"
    ],
    "estimated_effort": "8-12 hours documentation rewrite + user migration support"
  },

  "recommendation": "Doable, but coordinate with dev timeline. Documentation must be ready BEFORE users attempt migration.",

  "confidence": 0.85,
  "timestamp": "2026-02-20T10:10:00Z"
}
```

---

#### Step 3: Synthesis commit

**After all positions are committed, the creature (or general agent) synthesizes:**

```json
// synthesis/final-recommendation.json
{
  "$schema": "../schemas/synthesis-commit.schema.json",
  "type": "synthesis",
  "question": "Should we migrate from Supabase to self-hosted Postgres?",

  "sources": [
    { "entity": "dev-agent", "commit": "dev-agent.json", "position": "feasible_with_tradeoffs" },
    { "entity": "finance-agent", "commit": "finance-agent.json", "position": "cost_savings_significant" },
    { "entity": "critic-agent", "commit": "critic-agent.json", "position": "proceed_with_caution" },
    { "entity": "strategy-agent", "commit": "strategy-agent.json", "position": "aligns_with_long_term_goals" },
    { "entity": "research-agent", "commit": "research-agent.json", "position": "multiple_viable_paths" },
    { "entity": "content-agent", "commit": "content-agent.json", "position": "significant_documentation_overhaul" }
  ],

  "consensus_analysis": {
    "agreement_areas": [
      "Migration is technically feasible (dev, research)",
      "Cost savings are significant (finance)",
      "Risks are manageable with planning (critic)",
      "Aligns with long-term control goals (strategy)"
    ],
    "disagreement_areas": [
      "Timing: strategy suggests deferring if feature velocity is priority",
      "Hosting choice: research presents 4 options, no clear winner without Dave's preference"
    ],
    "critical_risks": [
      "Auth rewrite effort underestimated (critic warning)",
      "Documentation rewrite must precede user migration (content)",
      "ellie-home hardware failure (critic + research)"
    ]
  },

  "recommendation": {
    "decision": "Proceed with phased migration to self-hosted Postgres on ellie-home",
    "rationale": "Cost savings ($348/year), strategic control, low current traffic makes this the ideal time. Risks are manageable with proper planning.",
    "conditions": [
      "Do NOT rush — allocate 3 weeks full-time equivalent",
      "Phase 1: Set up Postgres on ellie-home as read-replica (1 week)",
      "Phase 2: Rewrite auth + Edge Functions (1 week)",
      "Phase 3: Cutover with rollback plan (3 days)",
      "Automated backups to S3 BEFORE cutover",
      "Documentation rewrite completes in Phase 1"
    ],
    "alternatives": {
      "if_risk_averse": "Use DigitalOcean managed Postgres ($12/mo) instead of self-host",
      "if_time_constrained": "Defer migration, revisit when Supabase costs exceed $50/month"
    },
    "next_steps": [
      "Dave decides: self-host vs managed vs defer",
      "If proceed: create ELLIE-XX work item with 3-phase plan",
      "If defer: set reminder to revisit in 3 months"
    ]
  },

  "confidence": 0.82,  // Weighted average of all agent confidences
  "synthesis_method": "multi_perspective_analysis",
  "timestamp": "2026-02-20T10:15:00Z"
}
```

---

#### Step 4: Merge all branches

```typescript
// After synthesis, merge all position branches to trunk
for (const branch of tree.branches) {
  await mergeBranch(tree.git_path, branch.name, 'main');
}

// Merge synthesis
await commitToTree(tree.git_path, 'main', synthesisCommit);

// Update MongoDB
await db.collection('trees').updateOne(
  { _id: treeId },
  {
    $set: {
      state: 'completed',
      branches: [],
      'trunks.0.head': 'final-recommendation',
      'trunks.0.commits': 7  // 6 positions + 1 synthesis
    }
  }
);
```

---

#### Step 5: Deliver to user

**General agent formats the synthesis for Telegram:**

```
🗳️ **Multi-Agent Debate Complete**

**Question:** Should we migrate from Supabase to self-hosted Postgres?

**Recommendation:** ✅ Proceed with phased migration

**Why:**
• 💰 Saves $348/year (finance)
• 🎯 Aligns with long-term control goals (strategy)
• ⚙️ Technically feasible with 3-week effort (dev)
• ⚠️ Risks manageable with planning (critic)

**Critical conditions:**
• Allocate 3 weeks (don't rush)
• Automated S3 backups BEFORE cutover
• Documentation rewrite first
• Rollback plan ready

**Alternative if risk-averse:**
Use DigitalOcean managed Postgres ($12/mo) instead of self-host

**Next step:**
Your call — proceed, use managed alternative, or defer?

Full analysis: [link to tree commit history]
```

---

### Voting Alternative (Optional)

If `voting.enabled: true`, the creature uses weighted voting instead of synthesis:

```typescript
async function calculateVote(tree: DebateTree, positions: Position[]) {
  let totalWeight = 0;
  let yesWeight = 0;
  let noWeight = 0;

  for (const position of positions) {
    const weight = tree.voting.weights[position.entity] || 1;
    totalWeight += weight;

    if (position.position.includes('proceed') || position.position.includes('yes')) {
      yesWeight += weight;
    } else if (position.position.includes('reject') || position.position.includes('no')) {
      noWeight += weight;
    }
    // Neutral positions don't count toward either side
  }

  const yesPercent = (yesWeight / totalWeight) * 100;
  const noPercent = (noWeight / totalWeight) * 100;

  return {
    result: yesPercent > noPercent ? 'approve' : 'reject',
    yes_percent: yesPercent,
    no_percent: noPercent,
    breakdown: positions.map(p => ({
      entity: p.entity,
      position: p.position,
      weight: tree.voting.weights[p.entity]
    }))
  };
}
```

**Use case:** When you want a clear approve/reject decision rather than nuanced synthesis. Example: "Should we launch feature X?" — binary decision, weighted by agent expertise.

---

### Contract System Integration

**Position schema validation:**
```json
// schemas/position-commit.schema.json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "type": { "const": "position" },
    "entity": { "type": "string" },
    "role": { "type": "string" },
    "question": { "type": "string" },
    "position": { "type": "string", "minLength": 3 },
    "analysis": { "type": "object" },
    "recommendation": { "type": "string", "minLength": 10 },
    "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
  },
  "required": ["type", "entity", "role", "question", "position", "recommendation", "confidence"]
}
```

**KPI — Debate consensus health:**
```js
// kpis collection
{
  _id: "kpi-debate-consensus",
  name: "Debate Tree Consensus Quality",
  source: {
    type: "aggregate",
    collection: "trees",
    pipeline: [
      { $match: { type: "debate", state: "completed" } },
      { $project: {
        question: 1,
        participant_count: { $size: "$participants" },
        avg_confidence: { $avg: "$branches.confidence" },
        completion_time: { $subtract: ["$completed_at", "$created_at"] }
      }}
    ]
  },
  ui: {
    component: "Table",
    columns: ["question", "participant_count", "avg_confidence", "completion_time"]
  }
}
```

---

### Summary: Multi-Agent Debate Tree

**Trigger** → strategic question or Dave explicitly requests multi-agent input

**Dispatch** → all agents work in parallel, each on their own branch

**Positions** → each agent commits their analysis, recommendation, confidence score

**Synthesis** → creature or general agent merges all perspectives into unified recommendation

**Alternatives** → voting mode for binary decisions with weighted agent expertise

**Output** → comprehensive analysis with multiple viewpoints, clear next steps, full audit trail

**Pattern** → "board meeting" formalized — every stakeholder perspective captured before decision

---

## Detailed Use Case Walkthrough: Handoff/Escalation Tree

### Overview
Dave asks a question via Telegram. General agent starts working but realizes mid-task that it needs specialized expertise (dev, research, finance, etc.). Instead of closing the conversation and starting a new session, the general agent's branch goes dormant, a creature dispatches the specialist agent on a new branch, and the specialist picks up with full context from the general agent's commits. This tests the **push → pull transition** within a single tree and **creature chaining** (one creature's result triggers another).

**Example:** "How do I optimize the database queries in the relay?"

---

### Tree Creation

**Trigger:** Dave sends a message. General agent spawns a conversation tree.

**MongoDB tree document:**
```js
// trees collection
{
  _id: "tree-conversation-db-optimization",
  type: "conversation",
  state: "active",
  git_path: ".forest/trees/conversation-db-optimization",
  created_at: "2026-02-20T11:00:00Z",
  owner: "dave",
  channel: "telegram",
  message_id: "msg-abc123",

  // Single trunk (conversation history)
  trunks: [
    { name: "main", head: null, commits: 0 }
  ],

  branches: [
    {
      name: "general/initial-response",
      entity: "general-agent",
      status: "active",
      created_at: "2026-02-20T11:00:00Z"
    }
  ],

  // Escalation tracking
  escalations: []
}
```

**Git structure:**
```
.forest/trees/conversation-db-optimization/
├── tree.json
├── schemas/
│   ├── conversation-tree.schema.json
│   ├── message-commit.schema.json
│   └── escalation-commit.schema.json
└── messages/
    └── (commits land here)
```

---

### Execution Flow

#### Step 1: General agent starts

**Dave's message:**
```
"How do I optimize the database queries in the relay?"
```

**General agent workflow:**
1. Creates branch: `general/initial-response`
2. Analyzes the question
3. Attempts to answer

**Initial commit (general agent):**
```json
// messages/general-initial.json
{
  "$schema": "../schemas/message-commit.schema.json",
  "type": "analysis",
  "entity": "general-agent",
  "user_message": "How do I optimize the database queries in the relay?",

  "analysis": {
    "intent": "performance_optimization",
    "domain": "database",
    "complexity": "high",
    "requires_code_inspection": true,
    "potential_approaches": [
      "Add indexes to frequently queried columns",
      "Use connection pooling (pgBouncer)",
      "Optimize N+1 queries with JOINs",
      "Add query result caching"
    ]
  },

  "confidence": 0.4,  // Low — general agent knows concepts but not specifics

  "escalation_candidate": true,
  "recommended_specialist": "dev-agent",
  "reason": "Requires codebase inspection (src/memory.ts, src/relay.ts) to identify actual slow queries",

  "timestamp": "2026-02-20T11:00:30Z"
}
```

---

#### Step 2: General agent requests escalation

**Instead of responding to Dave directly, general agent commits an escalation request:**

```json
// messages/escalation-request.json
{
  "$schema": "../schemas/escalation-commit.schema.json",
  "type": "escalation_request",
  "from_entity": "general-agent",
  "to_entity": "dev-agent",
  "reason": "Requires codebase inspection and specific query optimization expertise",

  "context_summary": "Dave wants to optimize database queries in the relay. I know general approaches (indexing, pooling) but need to see actual code to identify bottlenecks.",

  "handoff_data": {
    "user_question": "How do I optimize the database queries in the relay?",
    "initial_analysis": "Likely N+1 queries or missing indexes",
    "files_to_inspect": ["src/memory.ts", "src/relay.ts", "src/agent-router.ts"],
    "recommended_tools": ["Grep for 'SELECT', 'findMany', 'query'"]
  },

  "timestamp": "2026-02-20T11:01:00Z"
}
```

**Commits to branch, then:**

```typescript
// General agent sets its branch to dormant
await db.collection('trees').updateOne(
  { _id: treeId, 'branches.name': 'general/initial-response' },
  { $set: { 'branches.$.status': 'dormant' } }
);

// Triggers escalation creature
await triggerCreature('escalation-dispatcher', { tree_id: treeId });
```

---

#### Step 3: Escalation creature dispatches dev agent

**Creature workflow:**

```typescript
// src/creatures/escalation-dispatcher.ts
async function handleEscalation(treeId: string) {
  const tree = await db.collection('trees').findOne({ _id: treeId });

  // Find escalation request in commits
  const commits = await readCommits(tree.git_path, 'general/initial-response');
  const escalationCommit = commits.find(c => c.type === 'escalation_request');

  if (!escalationCommit) return;  // No escalation needed

  // Create new branch for specialist
  const specialistBranch = `${escalationCommit.to_entity}/escalated-${Date.now()}`;
  await createBranch(tree.git_path, specialistBranch, 'main');

  // Update MongoDB
  await db.collection('trees').updateOne(
    { _id: treeId },
    {
      $push: {
        branches: {
          name: specialistBranch,
          entity: escalationCommit.to_entity,
          status: 'active',
          created_at: new Date(),
          escalated_from: 'general/initial-response'
        },
        escalations: {
          from: escalationCommit.from_entity,
          to: escalationCommit.to_entity,
          reason: escalationCommit.reason,
          timestamp: new Date()
        }
      }
    }
  );

  // Dispatch specialist with full context
  await dispatchAgent(escalationCommit.to_entity, {
    tree_id: treeId,
    branch: specialistBranch,
    context: escalationCommit.handoff_data,
    previous_branch: 'general/initial-response'
  });
}
```

**Key:** The specialist agent receives:
- Full context from general agent's analysis
- Specific files to inspect
- Recommended tools to use
- Link to previous branch (can read general's commits)

---

#### Step 4: Dev agent takes over

**Dev agent workflow:**
1. Reads context from escalation commit
2. Inspects codebase (as suggested)
3. Identifies specific slow queries
4. Commits findings and recommendations

**Dev agent commits:**

**Codebase inspection commit:**
```json
// messages/dev-inspection.json
{
  "$schema": "../schemas/message-commit.schema.json",
  "type": "codebase_inspection",
  "entity": "dev-agent",
  "escalated_from": "general-agent",

  "findings": [
    {
      "file": "src/memory.ts",
      "line": 45,
      "query": "SELECT * FROM messages WHERE conversation_id = $1",
      "issue": "No index on conversation_id — table scan on 10K+ rows",
      "impact": "high",
      "fix": "CREATE INDEX idx_messages_conversation_id ON messages(conversation_id)"
    },
    {
      "file": "src/relay.ts",
      "line": 123,
      "query": "Calling searchMemory() in loop (N+1 pattern)",
      "issue": "Each message triggers separate embedding search",
      "impact": "critical",
      "fix": "Batch embedding searches with Promise.all()"
    },
    {
      "file": "src/agent-router.ts",
      "line": 67,
      "query": "No connection pooling configured",
      "issue": "Each query creates new connection (overhead)",
      "impact": "medium",
      "fix": "Add pgBouncer or use Supabase pooler"
    }
  ],

  "timestamp": "2026-02-20T11:05:00Z"
}
```

**Recommendation commit:**
```json
// messages/dev-recommendations.json
{
  "$schema": "../schemas/message-commit.schema.json",
  "type": "recommendations",
  "entity": "dev-agent",

  "recommendations": [
    {
      "priority": 1,
      "action": "Add database indexes",
      "steps": [
        "Run: CREATE INDEX idx_messages_conversation_id ON messages(conversation_id)",
        "Run: CREATE INDEX idx_memory_embedding ON memory USING ivfflat(embedding vector_cosine_ops)",
        "Verify with EXPLAIN ANALYZE"
      ],
      "estimated_impact": "50-70% query time reduction",
      "effort": "5 minutes"
    },
    {
      "priority": 2,
      "action": "Fix N+1 query pattern in relay",
      "steps": [
        "Refactor searchMemory() to accept array of queries",
        "Batch searches with Promise.all()",
        "Update call sites in src/relay.ts"
      ],
      "estimated_impact": "80% reduction in embedding search time",
      "effort": "30 minutes"
    },
    {
      "priority": 3,
      "action": "Add connection pooling",
      "steps": [
        "Install pgBouncer on ellie-home",
        "Configure pool size (10 connections)",
        "Update SUPABASE_URL to point to pgBouncer port"
      ],
      "estimated_impact": "10-15% overall latency reduction",
      "effort": "2 hours"
    }
  ],

  "confidence": 0.95,
  "timestamp": "2026-02-20T11:10:00Z"
}
```

---

#### Step 5: Dev agent merges, creature transitions back

**Dev agent workflow:**
1. Commits recommendations
2. Merges branch to trunk
3. Triggers handoff creature

**Handoff creature:**
```typescript
// src/creatures/handoff-coordinator.ts
async function completeHandoff(treeId: string) {
  const tree = await db.collection('trees').findOne({ _id: treeId });

  // Find completed specialist branch
  const devBranch = tree.branches.find(b => b.entity === 'dev-agent' && b.status === 'active');
  if (!devBranch) return;

  // Merge specialist branch to trunk
  await mergeBranch(tree.git_path, devBranch.name, 'main');

  // Wake up general agent to deliver response
  const generalBranch = tree.branches.find(b => b.entity === 'general-agent' && b.status === 'dormant');
  await db.collection('trees').updateOne(
    { _id: treeId, 'branches.name': generalBranch.name },
    { $set: { 'branches.$.status': 'active' } }
  );

  // Dispatch general agent to synthesize final response
  await dispatchAgent('general-agent', {
    tree_id: treeId,
    branch: generalBranch.name,
    action: 'synthesize_handoff',
    specialist_branch: devBranch.name
  });
}
```

---

#### Step 6: General agent delivers final response

**General agent reads dev agent's commits and responds to Dave:**

```
**Database Optimization Recommendations** (via dev agent)

I had our dev agent inspect the codebase. Here's what they found:

**🔴 Critical Issue:**
N+1 query pattern in `src/relay.ts:123` — each message triggers a separate embedding search. Fix by batching searches with `Promise.all()`.
**Impact:** 80% faster
**Effort:** 30 minutes

**🟡 High Priority:**
Missing index on `messages.conversation_id` — causing table scans.
**Fix:** Run this SQL:
```
CREATE INDEX idx_messages_conversation_id ON messages(conversation_id);
```
**Impact:** 50-70% faster queries
**Effort:** 5 minutes

**🟢 Medium Priority:**
No connection pooling — each query creates new connection.
**Fix:** Set up pgBouncer (2 hours setup)
**Impact:** 10-15% overall latency reduction

Want me to apply the first two fixes now? (The index creation is instant, the N+1 fix needs code changes.)
```

**Final commit on trunk:**
```json
// messages/synthesis-handoff.json
{
  "$schema": "../schemas/message-commit.schema.json",
  "type": "synthesis",
  "entity": "general-agent",

  "handoff_summary": {
    "escalated_to": "dev-agent",
    "reason": "Required codebase inspection",
    "findings_count": 3,
    "recommendations_count": 3,
    "confidence_improvement": "0.4 → 0.95"
  },

  "user_response": "[formatted message above]",

  "timestamp": "2026-02-20T11:12:00Z"
}
```

---

### Creature Chaining

**The handoff involved two creatures in sequence:**

1. **Escalation dispatcher** (trigger: general agent commits escalation request)
   - Creates specialist branch
   - Dispatches specialist agent with context
   - Sets general branch to dormant

2. **Handoff coordinator** (trigger: specialist commits complete)
   - Merges specialist branch to trunk
   - Wakes general branch
   - Dispatches general agent to deliver final response

**MongoDB change streams enable this:**
```typescript
// Creature chaining via change streams
db.collection('trees').watch().on('change', async (change) => {
  const tree = change.fullDocument;

  // Trigger 1: Escalation request detected
  if (tree.branches.some(b => hasCommitType(b, 'escalation_request'))) {
    await triggerCreature('escalation-dispatcher', { tree_id: tree._id });
  }

  // Trigger 2: Specialist branch completed
  if (tree.branches.some(b => b.entity.includes('agent') && b.status === 'completed')) {
    await triggerCreature('handoff-coordinator', { tree_id: tree._id });
  }
});
```

---

### Multi-Hop Escalation (Chaining Pattern)

**Scenario:** General → Dev → QA

Dave asks: "Is the email integration secure?"

1. **General** → "Need code inspection" → escalates to **dev**
2. **Dev** → inspects code, finds auth flow → "Need security audit" → escalates to **QA/critic**
3. **QA** → runs security tests, commits findings → hands back to **general**
4. **General** → synthesizes and responds to Dave

**MongoDB tracks the chain:**
```js
{
  escalations: [
    {
      from: "general-agent",
      to: "dev-agent",
      reason: "Code inspection needed",
      timestamp: "2026-02-20T11:00:00Z"
    },
    {
      from: "dev-agent",
      to: "critic-agent",
      reason: "Security audit needed",
      timestamp: "2026-02-20T11:05:00Z"
    },
    {
      from: "critic-agent",
      to: "general-agent",
      reason: "Findings synthesized",
      timestamp: "2026-02-20T11:15:00Z"
    }
  ]
}
```

**This is the agile pipeline pattern:** BA → Architect → Dev → QA — all as branches within one tree, orchestrated by creatures.

---

### Contract System Integration

**Escalation commit schema:**
```json
// schemas/escalation-commit.schema.json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "type": { "const": "escalation_request" },
    "from_entity": { "type": "string" },
    "to_entity": { "type": "string" },
    "reason": { "type": "string", "minLength": 10 },
    "context_summary": { "type": "string" },
    "handoff_data": { "type": "object" }
  },
  "required": ["type", "from_entity", "to_entity", "reason", "handoff_data"]
}
```

**KPI — Escalation effectiveness:**
```js
// kpis collection
{
  _id: "kpi-escalation-quality",
  name: "Escalation Confidence Improvement",
  source: {
    type: "aggregate",
    collection: "trees",
    pipeline: [
      { $match: { type: "conversation", "escalations.0": { $exists: true } } },
      { $project: {
        escalation_count: { $size: "$escalations" },
        initial_confidence: { $first: "$branches.confidence" },
        final_confidence: { $last: "$branches.confidence" },
        improvement: { $subtract: [
          { $last: "$branches.confidence" },
          { $first: "$branches.confidence" }
        ]}
      }},
      { $group: {
        _id: null,
        avg_improvement: { $avg: "$improvement" },
        avg_hops: { $avg: "$escalation_count" }
      }}
    ]
  },
  ui: {
    component: "MetricCard",
    metrics: ["avg_improvement", "avg_hops"]
  }
}
```

**Insight:** "On average, escalations improve response confidence by 0.47 (from 0.45 to 0.92) with 1.2 hops per question."

---

### Summary: Handoff/Escalation Tree

**Initial response** → general agent starts, realizes it needs specialist expertise

**Escalation request** → general commits handoff data, sets branch dormant, triggers creature

**Specialist dispatch** → creature creates new branch, dispatches specialist with full context

**Specialist work** → inspects, analyzes, commits findings with high confidence

**Handoff back** → creature merges specialist branch, wakes general, general synthesizes final response

**Multi-hop** → specialists can escalate to other specialists (dev → QA → general)

**Creature chaining** → MongoDB change streams trigger creatures in sequence

**Pattern** → agile pipeline (BA → architect → dev → QA) all within one tree, zero context loss

**Audit trail** → full history of who answered what, why escalation happened, confidence improvement

---

## Detailed Use Case Walkthrough: Incident Response Tree

### Overview
Production outage. The relay stops responding. Multiple entities need to investigate simultaneously while Dave is alerted in real-time. Unlike scheduled work sessions, incident response trees spawn urgently, skip the nursery phase, and immediately enter the forest. Multiple agents branch in parallel, creatures pull in additional entities as the scope widens, and the tree closes with a mandatory post-mortem commit. Fast lifecycle, high urgency, comprehensive audit trail.

**Example:** Telegram relay crashes due to rate limiting from Anthropic API

---

### Tree Creation (Urgency Path)

**Trigger:** Monitoring detects relay downtime OR Dave manually reports via emergency keyword ("outage", "down", "not responding")

**Special creation flow:**
Unlike normal trees that spawn in nursery → grow → promote to forest, incident trees skip nursery and go **straight to forest**.

**MongoDB tree document:**
```js
// trees collection
{
  _id: "tree-incident-relay-crash-2026-02-20",
  type: "incident_response",
  state: "active",
  git_path: ".forest/trees/incident-relay-crash-2026-02-20",
  created_at: "2026-02-20T14:23:15Z",
  owner: "dave",

  // Incident-specific metadata
  incident: {
    severity: "critical",  // critical, high, medium, low
    status: "investigating",  // investigating, mitigated, resolved
    detected_at: "2026-02-20T14:23:15Z",
    detected_by: "monitoring",  // monitoring, user_report, automated_check
    impact: "Telegram relay completely down, no messages being processed",
    affected_services: ["telegram-relay", "agent-router", "memory-search"]
  },

  // Single trunk — all investigation branches merge here
  trunks: [
    { name: "main", head: null, commits: 0 }
  ],

  branches: [],

  // Post-mortem requirement
  requires_postmortem: true,
  postmortem_template: "schemas/incident-postmortem.schema.json"
}
```

**Git structure:**
```
.forest/trees/incident-relay-crash-2026-02-20/
├── tree.json
├── schemas/
│   ├── incident-tree.schema.json
│   ├── investigation-commit.schema.json
│   └── incident-postmortem.schema.json
├── investigation/
│   ├── dev-agent.json
│   ├── research-agent.json
│   └── strategy-agent.json
└── resolution/
    ├── mitigation.json
    ├── fix.json
    └── postmortem.json
```

---

### Execution Flow: Timeline of a 3-Minute Outage

#### T+0:00 — Detection & Alert

**Monitoring creature detects:**
```typescript
// src/creatures/monitoring.ts
async function checkRelayHealth() {
  const lastMessage = await db.collection('messages').findOne(
    { channel: 'telegram' },
    { sort: { timestamp: -1 } }
  );

  const timeSinceLastMessage = Date.now() - new Date(lastMessage.timestamp).getTime();

  if (timeSinceLastMessage > 5 * 60 * 1000) {  // 5 minutes
    await createIncidentTree({
      severity: 'critical',
      impact: 'Telegram relay down',
      detected_by: 'monitoring'
    });
  }
}
```

**Incident tree created:**
- Skips nursery (urgency override)
- Immediately enters forest state
- Alert sent to Dave via all available channels (SMS if configured, GChat, email)

**Dave receives alert:**
```
🚨 CRITICAL INCIDENT DETECTED

Telegram relay has not processed messages in 5 minutes.

Tree: tree-incident-relay-crash-2026-02-20
Status: Investigating
Entities dispatched: dev, research, strategy

Live status: https://dashboard.ellie/incidents/2026-02-20
```

---

#### T+0:30 — Parallel Investigation Dispatch

**Incident coordinator creature dispatches three entities simultaneously:**

```typescript
// src/creatures/incident-coordinator.ts
async function dispatchIncidentInvestigation(treeId: string) {
  const tree = await db.collection('trees').findOne({ _id: treeId });

  // Create branches for initial responders
  const initialResponders = [
    { entity: 'dev-agent', focus: 'code_and_logs' },
    { entity: 'research-agent', focus: 'external_dependencies' },
    { entity: 'strategy-agent', focus: 'impact_assessment' }
  ];

  // Parallel dispatch
  await Promise.all(
    initialResponders.map(async (responder) => {
      const branchName = `investigation/${responder.entity}-${Date.now()}`;
      await createBranch(tree.git_path, branchName, 'main');

      await db.collection('trees').updateOne(
        { _id: treeId },
        { $push: { branches: {
          name: branchName,
          entity: responder.entity,
          status: 'active',
          focus: responder.focus,
          created_at: new Date()
        }}}
      );

      await dispatchAgent(responder.entity, {
        tree_id: treeId,
        branch: branchName,
        incident: tree.incident,
        focus: responder.focus,
        urgency: 'critical'
      });
    })
  );
}
```

---

#### T+1:00 — Dev Agent Finds Root Cause

**Dev agent workflow:**
1. Checks relay process status: `systemctl --user status claude-telegram-relay`
2. Greps logs: `journalctl --user -u claude-telegram-relay --since "5 minutes ago"`
3. Finds error: `AnthropicError: Rate limit exceeded (429)`

**Dev agent commit:**
```json
// investigation/dev-agent.json
{
  "$schema": "../schemas/investigation-commit.schema.json",
  "type": "root_cause_identified",
  "entity": "dev-agent",
  "focus": "code_and_logs",

  "findings": {
    "root_cause": "Anthropic API rate limit exceeded",
    "error_message": "AnthropicError: Rate limit exceeded (429)",
    "affected_code": "src/relay.ts:234 — Agent dispatch loop has no rate limiter",
    "trigger_event": "Dave sent 15 rapid messages during debugging session at 14:20",
    "failure_mode": "Relay process crashed instead of queuing requests"
  },

  "evidence": {
    "logs": [
      "2026-02-20T14:21:45Z ERROR: AnthropicError: Rate limit exceeded",
      "2026-02-20T14:21:46Z FATAL: Unhandled exception in message handler",
      "2026-02-20T14:21:46Z INFO: Process exiting with code 1"
    ],
    "process_status": "inactive (failed)",
    "last_restart": "2026-02-20T08:00:00Z"  // Morning, before incident
  },

  "immediate_mitigation": {
    "action": "Restart relay with rate limit wrapper",
    "steps": [
      "Add p-queue to relay.ts agent dispatch",
      "Set concurrency: 3, interval: 1000ms",
      "Restart service: systemctl --user restart claude-telegram-relay"
    ],
    "estimated_time": "2 minutes"
  },

  "confidence": 0.95,
  "timestamp": "2026-02-20T14:24:00Z"
}
```

---

#### T+1:30 — Research Agent Checks External Dependencies

**Research agent workflow:**
1. Checks Anthropic status page: https://status.anthropic.com
2. Checks Supabase status: https://status.supabase.com
3. Monitors ellie-home connectivity

**Research agent commit:**
```json
// investigation/research-agent.json
{
  "$schema": "../schemas/investigation-commit.schema.json",
  "type": "external_dependency_check",
  "entity": "research-agent",
  "focus": "external_dependencies",

  "findings": {
    "anthropic_api": {
      "status": "operational",
      "current_rate_limits": {
        "tier_1": "50 requests/min",
        "tier_2": "1000 requests/min"
      },
      "dave_tier": "tier_1",
      "notes": "No outages reported, rate limits unchanged"
    },
    "supabase": {
      "status": "operational",
      "latency": "45ms average (normal)",
      "notes": "No incidents"
    },
    "ellie_home": {
      "status": "reachable",
      "ping": "12ms",
      "disk_space": "85% used (normal)",
      "memory": "60% used (normal)"
    }
  },

  "conclusion": "All external dependencies operational. Issue is internal to relay code.",

  "confidence": 0.9,
  "timestamp": "2026-02-20T14:24:30Z"
}
```

---

#### T+2:00 — Strategy Agent Assesses Impact

**Strategy agent workflow:**
1. Queries message queue: how many messages missed?
2. Checks conversation state: any active sessions interrupted?
3. Assesses user impact severity

**Strategy agent commit:**
```json
// investigation/strategy-agent.json
{
  "$schema": "../schemas/investigation-commit.schema.json",
  "type": "impact_assessment",
  "entity": "strategy-agent",
  "focus": "impact_assessment",

  "findings": {
    "messages_missed": {
      "count": 3,
      "details": [
        { "timestamp": "14:22:30", "from": "Dave", "content": "[debug] test message 13" },
        { "timestamp": "14:22:45", "from": "Dave", "content": "[debug] test message 14" },
        { "timestamp": "14:23:00", "from": "Dave", "content": "[debug] test message 15" }
      ]
    },
    "active_sessions_interrupted": 0,  // Dave was testing, no real work interrupted
    "data_loss": "none",  // Messages stored in Telegram, can be replayed
    "user_impact": "low",  // Only Dave affected, during debug session
    "business_continuity": "not_impacted"  // No client-facing services down
  },

  "risk_assessment": {
    "if_not_fixed": "Future outages likely during high-volume periods",
    "cascading_failures": "none detected",
    "reputation_impact": "none (internal tooling)"
  },

  "recommendation": "Low urgency for immediate fix, but HIGH priority to prevent recurrence before productization.",

  "confidence": 0.85,
  "timestamp": "2026-02-20T14:25:00Z"
}
```

---

#### T+2:30 — Dev Agent Applies Mitigation

**Dev agent adds rate limiting:**

```typescript
// src/relay.ts (dev agent edits)
import PQueue from 'p-queue';

const agentQueue = new PQueue({
  concurrency: 3,       // Max 3 concurrent Claude API calls
  interval: 1000,       // Per second
  intervalCap: 3        // 3 requests per interval = well under 50/min limit
});

async function dispatchAgent(agent: string, message: string) {
  return agentQueue.add(async () => {
    // Existing dispatch logic...
  });
}
```

**Restart service:**
```bash
systemctl --user restart claude-telegram-relay
```

**Mitigation commit:**
```json
// resolution/mitigation.json
{
  "$schema": "../schemas/investigation-commit.schema.json",
  "type": "mitigation_applied",
  "entity": "dev-agent",

  "action": "Added rate limiting to agent dispatch",
  "changes": [
    {
      "file": "src/relay.ts",
      "description": "Wrapped dispatchAgent() in p-queue with 3/sec limit",
      "lines_added": 12
    }
  ],
  "deployment": {
    "method": "systemctl restart",
    "completed_at": "2026-02-20T14:26:30Z",
    "verification": "Sent 10 rapid test messages — all processed without error"
  },

  "status": "relay operational",
  "timestamp": "2026-02-20T14:26:30Z"
}
```

**MongoDB incident update:**
```js
{
  incident: {
    status: "mitigated",  // Was: investigating
    mitigated_at: "2026-02-20T14:26:30Z",
    total_downtime_minutes: 3.25
  }
}
```

---

#### T+3:00 — Late Entity Pull-In (Memory Agent)

**As dev agent committed the mitigation, they realized:**
> "We should check if any conversation context was lost during the crash."

**Dev agent commits escalation:**
```json
// investigation/dev-escalation-memory.json
{
  "type": "entity_escalation",
  "from_entity": "dev-agent",
  "to_entity": "memory-agent",
  "reason": "Verify conversation state integrity after crash",
  "timestamp": "2026-02-20T14:27:00Z"
}
```

**Creature pulls in memory agent mid-incident:**
```typescript
// Watches for escalation commits, dispatches new entity
db.collection('trees').watch().on('change', async (change) => {
  const tree = change.fullDocument;

  if (tree.type === 'incident_response') {
    const escalations = await findEscalationCommits(tree);
    for (const esc of escalations) {
      if (!tree.branches.some(b => b.entity === esc.to_entity)) {
        await dispatchIncidentEntity(tree._id, esc.to_entity, {
          reason: esc.reason,
          escalated_from: esc.from_entity
        });
      }
    }
  }
});
```

**Memory agent commit:**
```json
// investigation/memory-agent.json
{
  "type": "integrity_check",
  "entity": "memory-agent",

  "findings": {
    "active_conversations": [
      {
        "id": "conv-google-chat-2026-02-20",
        "status": "active",
        "last_message": "2026-02-20T14:20:00Z",
        "integrity": "intact"
      }
    ],
    "recent_memories": {
      "count": 15,
      "embeddings_generated": 15,
      "integrity": "intact"
    },
    "data_loss": "none detected"
  },

  "conclusion": "No conversation state lost. All active sessions resumable.",

  "timestamp": "2026-02-20T14:28:00Z"
}
```

---

#### T+10:00 — Post-Mortem (Required)

**After mitigation, the tree CANNOT close until post-mortem is committed.**

**General agent synthesizes all findings into post-mortem:**

```json
// resolution/postmortem.json
{
  "$schema": "../schemas/incident-postmortem.schema.json",
  "type": "postmortem",
  "entity": "general-agent",

  "incident_summary": {
    "id": "tree-incident-relay-crash-2026-02-20",
    "severity": "critical",
    "duration_minutes": 3.25,
    "detected_at": "2026-02-20T14:23:15Z",
    "mitigated_at": "2026-02-20T14:26:30Z",
    "resolved_at": "2026-02-20T14:30:00Z",
    "impact": "Telegram relay down for 3 minutes, 3 messages missed (all recoverable)",
    "affected_users": ["Dave"],
    "data_loss": "none"
  },

  "timeline": [
    { "time": "14:20:00", "event": "Dave sends 15 rapid debug messages" },
    { "time": "14:21:45", "event": "Anthropic API rate limit exceeded (429)" },
    { "time": "14:21:46", "event": "Relay process crashes (unhandled exception)" },
    { "time": "14:23:15", "event": "Monitoring detects outage, incident tree created" },
    { "time": "14:23:45", "event": "Dev/research/strategy agents dispatched" },
    { "time": "14:24:00", "event": "Dev agent identifies root cause (missing rate limiter)" },
    { "time": "14:26:30", "event": "Dev agent applies mitigation (p-queue), restarts service" },
    { "time": "14:27:00", "event": "Memory agent pulled in to verify integrity" },
    { "time": "14:28:00", "event": "Memory agent confirms no data loss" },
    { "time": "14:30:00", "event": "Postmortem completed" }
  ],

  "root_cause_analysis": {
    "primary_cause": "Missing rate limiting in agent dispatch loop (src/relay.ts:234)",
    "contributing_factors": [
      "No retry/backoff logic for Anthropic API errors",
      "Process crashes instead of gracefully degrading",
      "No queue for handling bursts of messages"
    ],
    "why_not_caught_earlier": "Rate limits were never hit during normal usage (1-3 messages/min). Debug session triggered burst of 15 messages in 45 seconds."
  },

  "resolution_summary": {
    "immediate_mitigation": "Added p-queue rate limiter (3 concurrent, 3/sec)",
    "permanent_fix": "Same as mitigation (no follow-up needed)",
    "verification": "Sent 10 rapid test messages post-restart — all processed successfully"
  },

  "action_items": [
    {
      "id": "ELLIE-90",
      "title": "Add circuit breaker pattern for all external API calls",
      "assignee": "dev-agent",
      "priority": "high",
      "deadline": "2026-02-27",
      "description": "Prevent crashes on API failures. Gracefully degrade instead of exiting."
    },
    {
      "id": "ELLIE-91",
      "title": "Add rate limit monitoring dashboard",
      "assignee": "dev-agent",
      "priority": "medium",
      "deadline": "2026-03-15",
      "description": "Track Anthropic API usage vs limits, alert before hitting ceiling"
    },
    {
      "id": "ELLIE-92",
      "title": "Document relay failure modes in runbook",
      "assignee": "content-agent",
      "priority": "low",
      "deadline": "2026-03-31",
      "description": "Add 'what to do if relay stops responding' to docs/runbook.md"
    }
  ],

  "lessons_learned": [
    "Always rate-limit external API calls, even if you don't think you'll hit limits",
    "Fail gracefully — queue requests rather than crashing on rate limit errors",
    "Monitoring detected the outage faster than manual reporting would have (30 seconds vs ~5 minutes)"
  ],

  "sign_off": {
    "completed_by": "general-agent",
    "reviewed_by": "Dave",
    "approved": true,
    "timestamp": "2026-02-20T14:30:00Z"
  }
}
```

---

#### Tree Closure

**After post-mortem commit, the tree auto-merges and closes:**

```typescript
// All investigation branches merge to trunk
await mergeBranch(tree.git_path, 'investigation/dev-agent-...', 'main');
await mergeBranch(tree.git_path, 'investigation/research-agent-...', 'main');
await mergeBranch(tree.git_path, 'investigation/strategy-agent-...', 'main');
await mergeBranch(tree.git_path, 'investigation/memory-agent-...', 'main');

// Commit mitigation and postmortem to trunk
await commitToTree(tree.git_path, 'main', mitigationCommit);
await commitToTree(tree.git_path, 'main', postmortemCommit);

// Update MongoDB
await db.collection('trees').updateOne(
  { _id: treeId },
  {
    $set: {
      state: 'completed',
      'incident.status': 'resolved',
      'incident.resolved_at': new Date(),
      branches: []
    }
  }
);
```

**Dave receives incident summary:**
```
✅ INCIDENT RESOLVED

Telegram relay crash (tree-incident-relay-crash-2026-02-20)

Duration: 3.25 minutes
Root cause: Missing rate limiter on Anthropic API calls
Impact: 3 messages missed (all recovered)
Data loss: None

Mitigation applied: p-queue rate limiter (3/sec)
Action items created: ELLIE-90, ELLIE-91, ELLIE-92

Full postmortem: https://dashboard.ellie/incidents/2026-02-20/postmortem
```

---

### Incident Tree vs Normal Tree Lifecycle

| Aspect | Normal Tree | Incident Tree |
|--------|-------------|---------------|
| **Creation** | Nursery → forest promotion | Direct to forest (skip nursery) |
| **Urgency** | Standard priority | High/critical priority |
| **Entity dispatch** | Sequential (as needed) | Parallel (all at once) |
| **Late arrivals** | Planned additions | Escalation-triggered |
| **Closure requirement** | Optional summary | Mandatory post-mortem |
| **Retention** | Standard composting | Retained indefinitely (compliance) |
| **Notifications** | Normal channels | All channels + SMS if critical |

---

### Contract System Integration

**Post-mortem schema validation:**
```json
// schemas/incident-postmortem.schema.json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "type": { "const": "postmortem" },
    "incident_summary": {
      "type": "object",
      "required": ["id", "severity", "duration_minutes", "impact"]
    },
    "timeline": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "time": { "type": "string", "format": "date-time" },
          "event": { "type": "string" }
        },
        "required": ["time", "event"]
      },
      "minItems": 3
    },
    "root_cause_analysis": {
      "type": "object",
      "required": ["primary_cause", "contributing_factors"]
    },
    "action_items": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "title", "priority", "deadline"]
      },
      "minItems": 1
    },
    "sign_off": {
      "type": "object",
      "required": ["completed_by", "reviewed_by", "approved"]
    }
  },
  "required": ["type", "incident_summary", "timeline", "root_cause_analysis", "action_items", "sign_off"]
}
```

**KPI — Incident response effectiveness:**
```js
// kpis collection
{
  _id: "kpi-incident-response",
  name: "Incident Response Metrics",
  source: {
    type: "aggregate",
    collection: "trees",
    pipeline: [
      { $match: { type: "incident_response" } },
      { $project: {
        severity: "$incident.severity",
        duration: { $subtract: ["$incident.mitigated_at", "$incident.detected_at"] },
        detection_method: "$incident.detected_by",
        entity_count: { $size: "$branches" },
        postmortem_completed: { $ne: [null, "$postmortem"] }
      }},
      { $group: {
        _id: "$severity",
        avg_response_time: { $avg: "$duration" },
        count: { $sum: 1 },
        postmortem_rate: { $avg: { $cond: ["$postmortem_completed", 1, 0] } }
      }}
    ]
  },
  ui: {
    component: "Table",
    columns: ["severity", "avg_response_time", "count", "postmortem_rate"]
  }
}
```

---

### Summary: Incident Response Tree

**Detection** → monitoring or manual report triggers urgent tree creation

**Dispatch** → immediate forest promotion, parallel entity deployment (dev, research, strategy)

**Investigation** → each entity commits findings on separate branch

**Late arrivals** → escalation commits trigger creature to pull in additional entities (memory, finance, critic)

**Mitigation** → dev agent applies fix, commits mitigation, updates incident status

**Post-mortem** → mandatory before closure, validated against schema, creates action items in Plane

**Closure** → all branches merge, tree archived, summary delivered to Dave

**Retention** → never composted, retained indefinitely for compliance and trend analysis

**Pattern** → fast lifecycle (minutes to hours), high urgency, comprehensive audit trail

---

## Detailed Use Case Walkthrough: Migration/Refactor Tree

### Overview
Large-scale codebase changes that span multiple repositories. Unlike work sessions (single repo, single feature), migration trees coordinate parallel work across ellie-dev and ellie-home with explicit inter-branch dependencies. Think "migrate from Supabase to local Postgres" or "refactor agent routing to support multi-tenancy." This tests whether tree_config can express a lightweight DAG of dependencies, and whether one tree can span multiple git repos.

**Example:** Migrate from Supabase to self-hosted Postgres on ellie-home

---

### Tree Creation

**Trigger:** Dave approves the migration after multi-agent debate (#6 use case resulted in "proceed" decision)

**MongoDB tree document:**
```js
// trees collection
{
  _id: "tree-migration-postgres-2026",
  type: "migration",
  state: "active",
  created_at: "2026-02-21T09:00:00Z",
  owner: "dave",

  // Multi-repo git paths
  git_repos: [
    {
      name: "ellie-dev",
      path: "/home/ellie/ellie-dev/.forest/trees/migration-postgres-2026",
      primary: true
    },
    {
      name: "ellie-home",
      path: "/home/ellie/ellie-home/.forest/trees/migration-postgres-2026",
      primary: false
    }
  ],

  // Single trunk (migration plan)
  trunks: [
    { name: "main", head: null, commits: 0 }
  ],

  // Branches with dependency graph
  branches: [
    {
      name: "infra/postgres-setup",
      entity: "dev-agent",
      repo: "ellie-home",
      status: "pending",
      depends_on: [],  // No dependencies, can start immediately
      estimated_effort_hours: 4
    },
    {
      name: "schema/migration-script",
      entity: "dev-agent",
      repo: "ellie-dev",
      status: "pending",
      depends_on: ["infra/postgres-setup"],  // Can't migrate without DB
      estimated_effort_hours: 3
    },
    {
      name: "code/auth-rewrite",
      entity: "dev-agent",
      repo: "ellie-dev",
      status: "pending",
      depends_on: ["schema/migration-script"],  // Auth depends on schema
      estimated_effort_hours: 8
    },
    {
      name: "code/edge-functions-to-api",
      entity: "dev-agent",
      repo: "ellie-dev",
      status: "pending",
      depends_on: ["schema/migration-script"],  // Can run parallel with auth
      estimated_effort_hours: 6
    },
    {
      name: "test/integration-suite",
      entity: "qa-agent",
      repo: "ellie-dev",
      status: "pending",
      depends_on: ["code/auth-rewrite", "code/edge-functions-to-api"],  // Both must complete
      estimated_effort_hours: 4
    },
    {
      name: "deploy/cutover-plan",
      entity: "dev-agent",
      repo: "ellie-dev",
      status: "pending",
      depends_on: ["test/integration-suite"],  // Can't deploy until tests pass
      estimated_effort_hours: 2
    },
    {
      name: "docs/update-guide",
      entity: "content-agent",
      repo: "ellie-dev",
      status: "pending",
      depends_on: ["deploy/cutover-plan"],  // Document final state
      estimated_effort_hours: 4
    }
  ],

  // Dependency graph visualization (for dashboard)
  dependency_dag: {
    nodes: [
      { id: "infra/postgres-setup", level: 0 },
      { id: "schema/migration-script", level: 1 },
      { id: "code/auth-rewrite", level: 2 },
      { id: "code/edge-functions-to-api", level: 2 },
      { id: "test/integration-suite", level: 3 },
      { id: "deploy/cutover-plan", level: 4 },
      { id: "docs/update-guide", level: 5 }
    ],
    edges: [
      { from: "infra/postgres-setup", to: "schema/migration-script" },
      { from: "schema/migration-script", to: "code/auth-rewrite" },
      { from: "schema/migration-script", to: "code/edge-functions-to-api" },
      { from: "code/auth-rewrite", to: "test/integration-suite" },
      { from: "code/edge-functions-to-api", to: "test/integration-suite" },
      { from: "test/integration-suite", to: "deploy/cutover-plan" },
      { from: "deploy/cutover-plan", to: "docs/update-guide" }
    ]
  },

  // Progress tracking
  progress: {
    total_branches: 7,
    completed: 0,
    in_progress: 0,
    blocked: 0,
    estimated_total_hours: 31,
    actual_hours: 0
  }
}
```

**Git structure (multi-repo):**
```
# ellie-dev repo
/home/ellie/ellie-dev/.forest/trees/migration-postgres-2026/
├── tree.json (link to shared MongoDB doc)
├── schemas/
│   ├── migration-tree.schema.json
│   └── migration-commit.schema.json
└── branches/
    ├── schema/
    ├── code/
    ├── test/
    ├── deploy/
    └── docs/

# ellie-home repo
/home/ellie/ellie-home/.forest/trees/migration-postgres-2026/
├── tree.json (same MongoDB doc ID)
└── branches/
    └── infra/
```

---

### Execution Flow: Parallel Workflow with Dependencies

#### Stage 0: Infra Setup (Unblocked)

**Dev agent starts on ellie-home (no dependencies):**

Branch: `infra/postgres-setup`
Repo: `ellie-home`

**Tasks:**
1. Install Postgres on ellie-home
2. Configure postgres.conf (max_connections, shared_buffers)
3. Create database: `ellie_prod`
4. Set up pgBouncer for connection pooling
5. Configure automated backups to S3
6. Create service user + credentials

**Commit:**
```json
// ellie-home/.forest/trees/migration-postgres-2026/branches/infra/setup-complete.json
{
  "$schema": "../schemas/migration-commit.schema.json",
  "type": "infrastructure_setup",
  "entity": "dev-agent",
  "branch": "infra/postgres-setup",
  "repo": "ellie-home",

  "completed_tasks": [
    {
      "task": "Install Postgres 16",
      "method": "apt install postgresql-16",
      "verification": "psql --version → PostgreSQL 16.1"
    },
    {
      "task": "Create database",
      "command": "createdb ellie_prod",
      "verification": "psql -l | grep ellie_prod"
    },
    {
      "task": "Configure pgBouncer",
      "config_file": "/etc/pgbouncer/pgbouncer.ini",
      "pool_size": 10,
      "verification": "systemctl status pgbouncer → active"
    },
    {
      "task": "Set up backups",
      "method": "pg_dump cron job to S3",
      "schedule": "0 2 * * * (daily 2am)",
      "verification": "First backup completed → s3://ellie-backups/postgres/2026-02-21.sql.gz"
    }
  ],

  "credentials": {
    "host": "ellie-home.local",
    "port": 5432,
    "database": "ellie_prod",
    "user": "ellie_service",
    "password_location": ".env.ellie-home (encrypted)"
  },

  "connection_string": "postgresql://ellie_service:***@ellie-home.local:5432/ellie_prod",

  "duration_hours": 3.5,
  "status": "completed",
  "timestamp": "2026-02-21T12:30:00Z"
}
```

**MongoDB update:**
```js
{
  branches: [
    {
      name: "infra/postgres-setup",
      status: "completed",  // Was: pending
      completed_at: "2026-02-21T12:30:00Z",
      actual_effort_hours: 3.5
    },
    // ... other branches ...
  ],
  progress: {
    completed: 1,
    actual_hours: 3.5
  }
}
```

**Dependency unblock:**
Because `infra/postgres-setup` completed, `schema/migration-script` is now unblocked.

---

#### Stage 1: Schema Migration (Unblocked by Stage 0)

**Dev agent starts on ellie-dev:**

Branch: `schema/migration-script`
Repo: `ellie-dev`
Depends on: `infra/postgres-setup` ✅ (completed)

**Tasks:**
1. Export Supabase schema: `pg_dump --schema-only supabase_db > schema-export.sql`
2. Create migration script: `db/migrations/001-supabase-to-local.sql`
3. Test migration on local copy of Supabase data
4. Run migration on ellie-home Postgres
5. Verify row counts match

**Commit:**
```json
// ellie-dev/.forest/trees/migration-postgres-2026/branches/schema/migration-complete.json
{
  "$schema": "../schemas/migration-commit.schema.json",
  "type": "schema_migration",
  "entity": "dev-agent",
  "branch": "schema/migration-script",
  "repo": "ellie-dev",

  "migration_script": "db/migrations/001-supabase-to-local.sql",

  "completed_tasks": [
    {
      "task": "Export Supabase schema",
      "tables_exported": ["messages", "memory", "conversations", "logs", "work_sessions", "agents"],
      "output_file": "schema-export.sql"
    },
    {
      "task": "Create migration script",
      "file": "db/migrations/001-supabase-to-local.sql",
      "changes": [
        "Removed Supabase-specific extensions (supabase_functions, pg_net)",
        "Converted RLS policies to app-level permissions (removed POLICY statements)",
        "Added custom vector extension (pgvector instead of Supabase's)",
        "Updated triggers (removed Supabase webhooks, added local equivalents)"
      ]
    },
    {
      "task": "Test on staging copy",
      "staging_db": "ellie_staging (local Docker)",
      "result": "pass",
      "verification": "Row counts match: messages (10,234), memory (870), conversations (45)"
    },
    {
      "task": "Run migration on ellie-home",
      "command": "psql -h ellie-home.local -d ellie_prod -f db/migrations/001-supabase-to-local.sql",
      "result": "success",
      "duration_seconds": 45
    },
    {
      "task": "Verify data integrity",
      "checks": [
        { "table": "messages", "supabase_count": 10234, "postgres_count": 10234, "match": true },
        { "table": "memory", "supabase_count": 870, "postgres_count": 870, "match": true },
        { "table": "conversations", "supabase_count": 45, "postgres_count": 45, "match": true }
      ],
      "result": "all tables verified"
    }
  ],

  "duration_hours": 2.5,
  "status": "completed",
  "timestamp": "2026-02-21T15:00:00Z"
}
```

**MongoDB update:**
```js
{
  branches: [
    {
      name: "schema/migration-script",
      status: "completed",
      completed_at: "2026-02-21T15:00:00Z",
      actual_effort_hours: 2.5
    }
  ],
  progress: {
    completed: 2,
    actual_hours: 6  // 3.5 + 2.5
  }
}
```

**Dependency unblock (parallel branches):**
- `code/auth-rewrite` ✅ unblocked
- `code/edge-functions-to-api` ✅ unblocked

Both can now run **in parallel**.

---

#### Stage 2: Parallel Code Changes

**Two branches work simultaneously:**

##### Branch A: Auth Rewrite

Entity: dev-agent
Depends on: `schema/migration-script` ✅

**Tasks:**
1. Remove Supabase Auth SDK
2. Implement JWT auth with local Postgres user table
3. Add bcrypt password hashing
4. Create auth middleware
5. Update all protected routes

**Commit (auth-rewrite-complete.json):**
```json
{
  "type": "code_changes",
  "entity": "dev-agent",
  "branch": "code/auth-rewrite",

  "files_changed": [
    { "file": "src/auth.ts", "lines_added": 156, "lines_removed": 45 },
    { "file": "src/middleware/auth-check.ts", "lines_added": 78, "lines_removed": 0 },
    { "file": "src/relay.ts", "lines_added": 12, "lines_removed": 8 },
    { "file": "package.json", "changes": "removed @supabase/auth-helpers, added jsonwebtoken + bcryptjs" }
  ],

  "test_coverage": {
    "unit_tests_added": 24,
    "integration_tests_added": 8,
    "coverage_percent": 87
  },

  "duration_hours": 7,  // Over estimate by 1 hour (debugging edge case)
  "status": "completed",
  "timestamp": "2026-02-22T10:00:00Z"
}
```

##### Branch B: Edge Functions to API Routes

Entity: dev-agent (different instance/session)
Depends on: `schema/migration-script` ✅

**Tasks:**
1. Convert `supabase/functions/embed/index.ts` → `src/api/embed.ts`
2. Convert `supabase/functions/search/index.ts` → `src/api/search.ts`
3. Update embedding generation (OpenAI API calls now local)
4. Update search routes
5. Remove Supabase Edge Function deployment

**Commit (edge-functions-complete.json):**
```json
{
  "type": "code_changes",
  "entity": "dev-agent",
  "branch": "code/edge-functions-to-api",

  "files_changed": [
    { "file": "src/api/embed.ts", "lines_added": 123, "lines_removed": 0 },
    { "file": "src/api/search.ts", "lines_added": 89, "lines_removed": 0 },
    { "file": "src/memory.ts", "lines_added": 34, "lines_removed": 67 },
    { "file": "package.json", "changes": "removed @supabase/supabase-js edge functions deps" }
  ],

  "removed_files": [
    "supabase/functions/embed/index.ts",
    "supabase/functions/search/index.ts"
  ],

  "test_coverage": {
    "unit_tests_added": 18,
    "integration_tests_added": 6,
    "coverage_percent": 82
  },

  "duration_hours": 5.5,
  "status": "completed",
  "timestamp": "2026-02-22T11:30:00Z"
}
```

**MongoDB update (both branches complete):**
```js
{
  branches: [
    {
      name: "code/auth-rewrite",
      status: "completed",
      completed_at: "2026-02-22T10:00:00Z",
      actual_effort_hours: 7
    },
    {
      name: "code/edge-functions-to-api",
      status: "completed",
      completed_at: "2026-02-22T11:30:00Z",
      actual_effort_hours: 5.5
    }
  ],
  progress: {
    completed: 4,
    actual_hours: 18.5  // 6 + 7 + 5.5
  }
}
```

**Dependency unblock:**
`test/integration-suite` ✅ unblocked (both dependencies met)

---

#### Stage 3: QA Testing (Blocked Until Both Code Branches Complete)

**QA agent starts:**

Branch: `test/integration-suite`
Repo: `ellie-dev`
Depends on: `code/auth-rewrite` ✅ + `code/edge-functions-to-api` ✅

**Tasks:**
1. Run full test suite against local Postgres
2. Test auth flow (login, JWT refresh, protected routes)
3. Test embedding generation (memory insertion triggers embed API)
4. Test semantic search (search API returns correct results)
5. Load testing (100 concurrent users)

**Commit (integration-tests-complete.json):**
```json
{
  "type": "qa_validation",
  "entity": "qa-agent",
  "branch": "test/integration-suite",

  "test_results": {
    "unit_tests": {
      "total": 156,
      "passed": 154,
      "failed": 2,
      "skipped": 0
    },
    "integration_tests": {
      "total": 42,
      "passed": 40,
      "failed": 2,
      "skipped": 0
    },
    "failures": [
      {
        "test": "auth_flow_jwt_refresh",
        "reason": "JWT expiration logic off by 1 second (rounding error)",
        "severity": "low",
        "fix_required": true
      },
      {
        "test": "search_empty_query_handling",
        "reason": "Search API returns 500 instead of 400 on empty query",
        "severity": "medium",
        "fix_required": true
      }
    ]
  },

  "load_testing": {
    "concurrent_users": 100,
    "duration_minutes": 10,
    "requests_total": 15000,
    "requests_successful": 14998,
    "requests_failed": 2,
    "avg_response_time_ms": 145,
    "p95_response_time_ms": 320,
    "result": "pass (< 1% failure rate acceptable)"
  },

  "regressions_detected": 0,

  "verdict": "pass_with_fixes_required",

  "duration_hours": 5,  // 1 hour over estimate due to failures
  "status": "completed",
  "timestamp": "2026-02-22T16:30:00Z"
}
```

**Failures trigger dev-agent escalation:**

Because QA found 2 failures, a creature creates a **detour branch** for fixes:

```js
{
  branches: [
    // ... existing branches ...
    {
      name: "code/qa-fixes",
      entity: "dev-agent",
      repo: "ellie-dev",
      status: "active",
      depends_on: ["test/integration-suite"],
      parent_branch: "code/auth-rewrite",  // Fix is in auth code
      created_at: "2026-02-22T16:35:00Z"
    }
  ]
}
```

**Dev agent fixes and re-runs tests:**
```json
{
  "type": "bug_fixes",
  "entity": "dev-agent",
  "branch": "code/qa-fixes",

  "fixes": [
    {
      "issue": "JWT expiration rounding error",
      "file": "src/auth.ts:45",
      "change": "Changed Math.round() to Math.floor() for expiration timestamp",
      "verification": "auth_flow_jwt_refresh test now passes"
    },
    {
      "issue": "Search API 500 on empty query",
      "file": "src/api/search.ts:23",
      "change": "Added input validation, return 400 if query empty",
      "verification": "search_empty_query_handling test now passes"
    }
  ],

  "retest_results": {
    "unit_tests": { "passed": 156, "failed": 0 },
    "integration_tests": { "passed": 42, "failed": 0 }
  },

  "duration_hours": 1,
  "status": "completed",
  "timestamp": "2026-02-22T17:30:00Z"
}
```

**MongoDB update (QA complete after fixes):**
```js
{
  branches: [
    {
      name: "test/integration-suite",
      status: "completed",
      actual_effort_hours: 6  // 5 original + 1 fix time
    }
  ],
  progress: {
    completed: 5,
    actual_hours: 24.5
  }
}
```

**Dependency unblock:**
`deploy/cutover-plan` ✅ unblocked

---

#### Stage 4: Deployment Plan (Blocked Until Tests Pass)

**Dev agent creates cutover runbook:**

Branch: `deploy/cutover-plan`
Depends on: `test/integration-suite` ✅

**Commit:**
```json
{
  "type": "deployment_plan",
  "entity": "dev-agent",
  "branch": "deploy/cutover-plan",

  "cutover_steps": [
    {
      "step": 1,
      "action": "Enable maintenance mode",
      "command": "touch /home/ellie/ellie-dev/MAINTENANCE",
      "verification": "Relay returns 503 to new messages"
    },
    {
      "step": 2,
      "action": "Final Supabase data export",
      "command": "pg_dump supabase_db > final-export.sql",
      "verification": "Row counts match production"
    },
    {
      "step": 3,
      "action": "Import final data to ellie-home Postgres",
      "command": "psql -h ellie-home.local -d ellie_prod -f final-export.sql",
      "verification": "Row counts match export"
    },
    {
      "step": 4,
      "action": "Update .env connection strings",
      "changes": [
        "DATABASE_URL → postgresql://ellie-home.local:5432/ellie_prod",
        "Remove SUPABASE_URL and SUPABASE_ANON_KEY"
      ],
      "verification": "Relay starts without Supabase env vars"
    },
    {
      "step": 5,
      "action": "Deploy new relay code",
      "command": "systemctl --user restart claude-telegram-relay",
      "verification": "Relay connects to local Postgres, processes test message"
    },
    {
      "step": 6,
      "action": "Smoke test",
      "tests": [
        "Send message via Telegram → receives response",
        "Check memory persistence → new memory saved to Postgres",
        "Check semantic search → returns relevant results"
      ],
      "verification": "All tests pass"
    },
    {
      "step": 7,
      "action": "Disable maintenance mode",
      "command": "rm /home/ellie/ellie-dev/MAINTENANCE",
      "verification": "Relay accepts messages"
    }
  ],

  "rollback_plan": {
    "trigger": "If smoke test fails",
    "steps": [
      "Revert .env to Supabase connection strings",
      "Restart relay with old env",
      "Verify Supabase connectivity",
      "Investigate failure, retry cutover after fix"
    ],
    "estimated_rollback_time": "5 minutes"
  },

  "estimated_downtime": "10-15 minutes",

  "duration_hours": 1.5,
  "status": "completed",
  "timestamp": "2026-02-22T19:00:00Z"
}
```

**Dependency unblock:**
`docs/update-guide` ✅ unblocked

---

#### Stage 5: Documentation (Final Branch)

**Content agent updates all docs:**

Branch: `docs/update-guide`
Depends on: `deploy/cutover-plan` ✅

**Commit:**
```json
{
  "type": "documentation_update",
  "entity": "content-agent",
  "branch": "docs/update-guide",

  "files_updated": [
    {
      "file": "CLAUDE.md",
      "sections": ["Phase 2: Database & Memory"],
      "changes": "Replaced Supabase setup with local Postgres + pgBouncer instructions"
    },
    {
      "file": "README.md",
      "sections": ["Prerequisites", "Environment Variables"],
      "changes": "Removed Supabase, added Postgres connection string docs"
    },
    {
      "file": "db/README.md",
      "changes": "Added migration guide for existing Supabase users"
    },
    {
      "file": "docs/runbook.md",
      "sections": ["Database Troubleshooting"],
      "changes": "Added Postgres-specific troubleshooting (connection pooling, backups)"
    }
  ],

  "new_docs_created": [
    {
      "file": "docs/migration/supabase-to-postgres.md",
      "description": "Step-by-step migration guide for existing users",
      "estimated_reading_time": "15 minutes"
    },
    {
      "file": "docs/postgres-setup.md",
      "description": "Complete Postgres installation and configuration guide",
      "estimated_reading_time": "20 minutes"
    }
  ],

  "duration_hours": 3.5,
  "status": "completed",
  "timestamp": "2026-02-22T22:30:00Z"
}
```

---

### Tree Completion: All Branches Merged

**After all branches complete, the migration coordinator creature merges everything:**

```typescript
// src/creatures/migration-coordinator.ts
async function completeMigration(treeId: string) {
  const tree = await db.collection('trees').findOne({ _id: treeId });

  // Verify all branches completed
  const incomplete = tree.branches.filter(b => b.status !== 'completed');
  if (incomplete.length > 0) {
    console.log(`[migration] ${incomplete.length} branches still pending`);
    return;
  }

  // Merge branches in dependency order (topological sort)
  const sortedBranches = topologicalSort(tree.branches, tree.dependency_dag);

  for (const branch of sortedBranches) {
    const repo = tree.git_repos.find(r => r.name === branch.repo);
    await mergeBranch(repo.path, branch.name, 'main');
  }

  // Final summary commit
  await commitToTree(tree.git_repos[0].path, 'main', {
    type: 'migration_complete',
    summary: `Postgres migration completed in ${tree.progress.actual_hours} hours`,
    branches_merged: tree.branches.length,
    total_files_changed: 45,
    total_lines_added: 892,
    total_lines_removed: 234,
    timestamp: new Date()
  });

  // Update MongoDB
  await db.collection('trees').updateOne(
    { _id: treeId },
    {
      $set: {
        state: 'completed',
        completed_at: new Date(),
        branches: []
      }
    }
  );
}
```

**Dave receives migration summary:**
```
✅ MIGRATION COMPLETE

Postgres migration (tree-migration-postgres-2026)

Duration: 13.5 hours (spread over 2 days)
Branches: 7 (all merged)
Files changed: 45 (+892 -234 lines)
Tests: 198 passed, 0 failed

Changes:
• Postgres installed on ellie-home
• Schema migrated (10,234 rows verified)
• Auth rewritten (JWT-based, no Supabase dependency)
• Edge Functions converted to API routes
• QA suite passed (including load testing: 100 users, 145ms avg)
• Deployment runbook created
• Documentation updated

Next: Run cutover plan (docs/deploy/cutover-plan.json)
Estimated downtime: 10-15 minutes
```

---

### Multi-Repo Coordination

**Key insight:** One tree, two git repos.

**MongoDB stores both paths:**
```js
{
  git_repos: [
    { name: "ellie-dev", path: "/home/ellie/ellie-dev/.forest/...", primary: true },
    { name: "ellie-home", path: "/home/ellie/ellie-home/.forest/...", primary: false }
  ]
}
```

**Branches specify which repo they belong to:**
```js
{
  branches: [
    { name: "infra/postgres-setup", repo: "ellie-home" },
    { name: "schema/migration-script", repo: "ellie-dev" },
    // ...
  ]
}
```

**Commits go to the correct repo:**
```typescript
async function commitToBranch(treeId: string, branchName: string, data: any) {
  const tree = await db.collection('trees').findOne({ _id: treeId });
  const branch = tree.branches.find(b => b.name === branchName);
  const repo = tree.git_repos.find(r => r.name === branch.repo);

  await commitToTree(repo.path, branchName, data);
}
```

---

### Dependency DAG Enforcement

**Before starting a branch, the coordinator checks dependencies:**

```typescript
async function canStartBranch(tree: MigrationTree, branchName: string): boolean {
  const branch = tree.branches.find(b => b.name === branchName);

  for (const dep of branch.depends_on) {
    const depBranch = tree.branches.find(b => b.name === dep);
    if (depBranch.status !== 'completed') {
      return false;  // Blocked
    }
  }

  return true;  // All dependencies met
}
```

**Dashboard visualizes the DAG:**
```
Level 0: infra/postgres-setup [✅ complete]
          ↓
Level 1: schema/migration-script [✅ complete]
          ↓              ↓
Level 2: code/auth-rewrite [✅]   code/edge-functions-to-api [✅]
          ↘              ↙
Level 3: test/integration-suite [✅ complete]
          ↓
Level 4: deploy/cutover-plan [✅ complete]
          ↓
Level 5: docs/update-guide [✅ complete]
```

---

### Contract System Integration

**Migration commit schema:**
```json
// schemas/migration-commit.schema.json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "type": { "enum": ["infrastructure_setup", "schema_migration", "code_changes", "qa_validation", "deployment_plan", "documentation_update"] },
    "entity": { "type": "string" },
    "branch": { "type": "string" },
    "repo": { "type": "string" },
    "status": { "enum": ["in_progress", "completed", "blocked", "failed"] },
    "duration_hours": { "type": "number", "minimum": 0 }
  },
  "required": ["type", "entity", "branch", "status"]
}
```

**KPI — Migration velocity:**
```js
// kpis collection
{
  _id: "kpi-migration-velocity",
  name: "Migration Branch Completion Rate",
  source: {
    type: "aggregate",
    collection: "trees",
    pipeline: [
      { $match: { type: "migration" } },
      { $unwind: "$branches" },
      { $group: {
        _id: "$_id",
        avg_branch_duration: { $avg: "$branches.actual_effort_hours" },
        total_branches: { $sum: 1 },
        completed_branches: { $sum: { $cond: [{ $eq: ["$branches.status", "completed"] }, 1, 0] } }
      }}
    ]
  },
  ui: {
    component: "GanttChart",
    x_axis: "time",
    y_axis: "branch",
    color_by: "status"
  }
}
```

---

### Summary: Migration/Refactor Tree

**Multi-repo** → one tree spans ellie-dev + ellie-home, branches specify which repo

**Dependency DAG** → lightweight dependency graph in tree_config, enforced before branch dispatch

**Parallel execution** → branches at same dependency level run simultaneously

**QA gating** → test branch blocks deployment until all tests pass

**Failure handling** → QA failures trigger detour branch for fixes, then retest

**Merge order** → topological sort ensures dependencies merge before dependents

**Audit trail** → full history of infra changes + code changes + tests + deployment in one tree

**Pattern** → complex multi-week refactors with parallel work streams, explicit ordering

---

### 6. Client Deliverable Tree
If you ever productize Ellie — a client project tree. Multi-trunk (draft/final), contribution policies restrict who can commit to final trunk. Review branches require approval before merge. Export the tree as a deliverable artifact.

### 7. Migration/Refactor Tree
A large-scale codebase change that touches multiple repos. Think "move from Supabase to local Postgres" or "refactor agent routing." Multiple entities work in parallel across ellie-dev and ellie-home, but their branches have ordering dependencies — you can't merge the dashboard branch until the relay API branch lands. This tests whether tree_config can express inter-branch dependencies (a lightweight DAG), or whether you need the workflow tree type with explicit step ordering. It also tests multi-repo git_repo_path — one tree spanning two repos.

### 8. Handoff/Escalation Tree
Dave asks Ellie something via Telegram. General agent starts working. Midway through, it realizes this needs dev agent expertise. The conversation tree doesn't close and restart — the general agent's branch goes dormant, a creature dispatches dev agent on a new branch, and dev picks up with full context from general's commits. This tests the push → pull transition within a single tree, and whether creatures can chain (creature A's result triggers creature B). It's also the pattern for your future agile pipeline — BA hands off to architect hands off to dev hands off to QA — all as branches within one tree.

### 9. Audit/Compliance Tree

**Realistic scenario:** Monthly security & code quality audit for ellie-dev

**Timeline:** 47 minutes of automated scanning + trend analysis + next-day sign-off

---

#### MongoDB Document

```js
{
  tree_id: "550e8400-e29b-41d4-a716-446655440009",
  tree_type: "audit",
  status: "closed",
  schedule: "0 0 1 * *", // 1st of every month
  scope: {
    scan_types: ["security", "dependencies", "code-quality", "data-privacy"],
    entities: ["research", "dev", "critic"],
    severity_threshold: "low" // report all findings
  },
  retention: {
    policy: "indefinite", // NEVER compost
    evidence_required: true,
    signoff_required: true,
    signoff_role: "compliance-officer"
  },
  remediation: {
    auto_create_tickets: true,
    severity_threshold: "medium", // auto-ticket for medium+
    project: "ELLIE",
    assignee: null // triage assigns later
  },
  reporting: {
    format: "markdown",
    include_trends: true,
    lookback_periods: 3, // compare last 3 months
    compliance_frameworks: ["SOC2", "GDPR"]
  },
  executions: [
    {
      run_id: "2026-01-01",
      started_at: "2026-01-01T00:00:00Z",
      completed_at: "2026-01-01T00:52:14Z",
      findings_count: 15,
      high_severity: 1,
      medium_severity: 6,
      low_severity: 8,
      tickets_created: ["ELLIE-87", "ELLIE-88", "ELLIE-89", "ELLIE-90", "ELLIE-91", "ELLIE-92"],
      signoff_by: "dave@ellie-labs.dev",
      signoff_at: "2026-01-01T09:22:00Z"
    },
    {
      run_id: "2026-02-01",
      started_at: "2026-02-01T00:00:00Z",
      completed_at: "2026-02-01T00:47:23Z",
      findings_count: 12,
      high_severity: 1,
      medium_severity: 5,
      low_severity: 6,
      tickets_created: ["ELLIE-93", "ELLIE-94", "ELLIE-95", "ELLIE-96", "ELLIE-97"],
      signoff_by: "dave@ellie-labs.dev",
      signoff_at: "2026-02-01T08:15:00Z"
    }
  ]
}
```

---

#### Git Structure

```
audit-2026-security-compliance/
  trunk: main
  ├── exec/2025-12 (Dec audit - retained)
  ├── exec/2026-01 (Jan audit - retained)
  ├── exec/2026-02 (Feb audit - retained)
  │    ├── research/dependency-scan
  │    │    └── commit: findings-dependencies.json
  │    ├── dev/static-analysis
  │    │    └── commit: findings-static-analysis.json
  │    ├── critic/code-review
  │    │    └── commit: findings-code-quality.json
  │    └── synthesis/consolidated-report
  │         ├── commit: consolidated-findings.json
  │         ├── commit: trend-analysis.md
  │         └── commit: compliance-report.md
  └── exec/2026-03 (Mar audit - pending)
```

**Retention:** All `exec/*` branches retained indefinitely for compliance evidence.

---

#### Execution Flow (Feb 2026 Audit)

**T+0:00 — Creature triggers monthly audit**

- Cron creature wakes at midnight on Feb 1
- Creates new branch: `exec/2026-02`
- Dispatches research, dev, critic entities in parallel
- MongoDB: add new execution record with `status: "running"`

**T+0:15 — Research entity (dependency scan)**

- Scans `package.json`, `bun.lockb`
- Finds 3 outdated packages with known CVEs
- Commits `findings-dependencies.json`:

```json
{
  "entity": "research",
  "scan_type": "dependencies",
  "timestamp": "2026-02-01T00:15:32Z",
  "findings": [
    {
      "severity": "high",
      "package": "axios@0.27.2",
      "cve": "CVE-2023-45857",
      "evidence": "bun.lockb:line 42",
      "recommendation": "Upgrade to axios@1.6.5",
      "remediation_effort": "5 min"
    },
    {
      "severity": "medium",
      "package": "@anthropic-ai/sdk@0.9.1",
      "cve": null,
      "evidence": "package.json:line 18",
      "recommendation": "Upgrade to @anthropic-ai/sdk@0.27.0 for bug fixes",
      "remediation_effort": "15 min + testing"
    },
    {
      "severity": "low",
      "package": "dotenv@16.0.3",
      "cve": null,
      "evidence": "package.json:line 24",
      "recommendation": "Upgrade to dotenv@16.4.1 for minor improvements",
      "remediation_effort": "5 min"
    }
  ]
}
```

**T+0:22 — Dev entity (static analysis)**

- Runs ESLint, TypeScript strict mode, custom security rules
- Finds 6 code quality/security issues
- Commits `findings-static-analysis.json`:

```json
{
  "entity": "dev",
  "scan_type": "static-analysis",
  "timestamp": "2026-02-01T00:22:18Z",
  "findings": [
    {
      "severity": "medium",
      "rule": "no-secrets",
      "file": "src/relay.ts",
      "line": 127,
      "evidence": "Hardcoded API endpoint contains internal hostname",
      "recommendation": "Move to .env",
      "remediation_effort": "10 min"
    },
    {
      "severity": "medium",
      "rule": "sql-injection",
      "file": "src/memory.ts",
      "line": 89,
      "evidence": "String concatenation in SQL query",
      "recommendation": "Use parameterized queries",
      "remediation_effort": "20 min"
    },
    {
      "severity": "low",
      "rule": "typescript-strict",
      "file": "src/agent-router.ts",
      "line": 203,
      "evidence": "Implicit any type",
      "recommendation": "Add explicit type annotation",
      "remediation_effort": "5 min"
    }
    // ... 3 more low-severity findings omitted
  ]
}
```

**T+0:38 — Critic entity (code review)**

- Reviews recent commits (last 30 days)
- Checks test coverage, documentation, error handling
- Commits `findings-code-quality.json`:

```json
{
  "entity": "critic",
  "scan_type": "code-quality",
  "timestamp": "2026-02-01T00:38:45Z",
  "findings": [
    {
      "severity": "medium",
      "rule": "test-coverage",
      "file": "src/outlook.ts",
      "evidence": "New file added with 0% test coverage",
      "recommendation": "Add unit tests for email sending",
      "remediation_effort": "2 hours"
    },
    {
      "severity": "medium",
      "rule": "error-handling",
      "file": "src/google-chat.ts",
      "line": 156,
      "evidence": "Unhandled promise rejection possible",
      "recommendation": "Add try-catch and log errors",
      "remediation_effort": "15 min"
    },
    {
      "severity": "low",
      "rule": "documentation",
      "file": "src/api/work-session.ts",
      "evidence": "Public API lacks JSDoc comments",
      "recommendation": "Add function documentation",
      "remediation_effort": "30 min"
    }
  ]
}
```

**T+0:45 — Synthesis creature (consolidated report)**

- Reads all entity findings from their commits
- Groups by severity: 1 high, 5 medium, 6 low
- Auto-creates Plane tickets for medium+ severity items:
  - `ELLIE-93`: [Security] Upgrade axios to fix CVE-2023-45857
  - `ELLIE-94`: [Security] Remove hardcoded API endpoint
  - `ELLIE-95`: [Security] Fix SQL injection in memory.ts
  - `ELLIE-96`: [Testing] Add test coverage for outlook.ts
  - `ELLIE-97`: [Code Quality] Add error handling to google-chat.ts
- Commits `consolidated-findings.json`:

```json
{
  "scan_date": "2026-02-01",
  "summary": {
    "total_findings": 12,
    "high": 1,
    "medium": 5,
    "low": 6,
    "entities_scanned": 3,
    "duration_minutes": 45
  },
  "findings_by_severity": {
    "high": [
      {
        "entity": "research",
        "issue": "axios@0.27.2 has CVE-2023-45857",
        "ticket": "ELLIE-93"
      }
    ],
    "medium": [
      {
        "entity": "dev",
        "issue": "Hardcoded API endpoint in src/relay.ts:127",
        "ticket": "ELLIE-94"
      },
      {
        "entity": "dev",
        "issue": "SQL injection risk in src/memory.ts:89",
        "ticket": "ELLIE-95"
      },
      {
        "entity": "critic",
        "issue": "src/outlook.ts has 0% test coverage",
        "ticket": "ELLIE-96"
      },
      {
        "entity": "critic",
        "issue": "Unhandled promise rejection in src/google-chat.ts:156",
        "ticket": "ELLIE-97"
      },
      {
        "entity": "research",
        "issue": "@anthropic-ai/sdk outdated (0.9.1 → 0.27.0)",
        "ticket": null
      }
    ],
    "low": [
      // ... 6 low-severity items
    ]
  },
  "compliance_status": {
    "SOC2": "findings_require_remediation",
    "GDPR": "compliant_with_notes"
  }
}
```

**T+0:46 — Trend analysis creature**

- Reads last 3 months of audit branches: `exec/2025-12`, `exec/2026-01`, `exec/2026-02`
- Compares findings counts, remediation rates, persistent issues
- Commits `trend-analysis.md`:

```markdown
## Audit Trends — Last 3 Months

| Month | Total Findings | High | Medium | Low | Remediation Rate |
|-------|---------------|------|--------|-----|------------------|
| Dec   | 18            | 2    | 8      | 8   | 87% (14/16)      |
| Jan   | 15            | 1    | 6      | 8   | 100% (7/7)       |
| Feb   | 12            | 1    | 5      | 6   | pending          |

**Trend:** ✅ Improving — total findings decreased 33% over 3 months

**Persistent issues:**
- Test coverage gaps (appeared in all 3 months)
- Dependency updates lag (appeared in Dec, Feb)

**Recommendations:**
1. Add automated dependency update bot (Dependabot or Renovate)
2. Add pre-commit hook for test coverage threshold (80%)
3. Schedule quarterly security training for contributors

**Compliance status:** On track for SOC2 certification Q2 2026
```

**T+0:47 — Compliance report creature**

- Generates formal compliance report for SOC2, GDPR
- Commits `compliance-report.md`:

```markdown
# Compliance Report — February 2026

**Report Date:** 2026-02-01
**Audit Period:** 2026-01-01 to 2026-02-01
**Auditor:** Ellie AI (automated)
**Sign-off Required:** dave@ellie-labs.dev (Compliance Officer)

## Executive Summary

12 findings identified during automated security and code quality audit:
- 1 high-severity (dependency CVE)
- 5 medium-severity (security + quality)
- 6 low-severity (minor improvements)

All medium+ findings have remediation tickets created in Plane (ELLIE-93 to ELLIE-97).

## SOC2 Compliance

**Status:** Findings require remediation before certification

**Controls assessed:**
- CC6.1 (Logical Access): ✅ Pass
- CC6.6 (Encryption): ⚠️ Hardcoded endpoint (ELLIE-94)
- CC7.1 (System Monitoring): ✅ Pass
- CC7.2 (Change Management): ⚠️ Missing test coverage (ELLIE-96)

**Required actions:**
- Remediate ELLIE-94 (security config)
- Remediate ELLIE-96 (test coverage for new code)
- Target completion: 2026-02-15

## GDPR Compliance

**Status:** Compliant with notes

**Article 32 (Security of Processing):** ⚠️ SQL injection risk (ELLIE-95)
- User data queries in `src/memory.ts` use string concatenation
- Recommendation: Parameterized queries required
- Risk level: Medium (user data exposure possible)
- Target completion: 2026-02-08

**Article 25 (Data Protection by Design):** ✅ Pass

## Evidence Retention

All audit artifacts retained indefinitely:
- Dependency scan results: `exec/2026-02/research/dependency-scan`
- Static analysis results: `exec/2026-02/dev/static-analysis`
- Code review results: `exec/2026-02/critic/code-review`
- Trend analysis: `exec/2026-02/synthesis/trend-analysis.md`

## Sign-off

**Awaiting approval from:** dave@ellie-labs.dev
**Approval deadline:** 2026-02-03 (72 hours)
```

**T+0:47 — Tree closes (pending sign-off)**

- All entity branches merge to `exec/2026-02` trunk
- Tree status → `awaiting_signoff`
- Notification sent to Dave via Telegram + Google Chat:
  > 🔒 **Monthly Security Audit Complete**
  > 12 findings (1 high, 5 medium, 6 low)
  > 5 tickets created: ELLIE-93 to ELLIE-97
  > Trend: ✅ 33% improvement vs last month
  > [View full report](https://ellie-labs.dev/audits/2026-02)
  > **Action required:** Sign off within 72 hours

**T+8:15 (next morning) — Dave signs off**

- Dave reviews dashboard, reads compliance report
- Approves with comment: "Schedule remediation for high/medium items this sprint"
- MongoDB updated:
  ```js
  executions[1].signoff_by = "dave@ellie-labs.dev"
  executions[1].signoff_at = "2026-02-01T08:15:00Z"
  ```
- Tree status → `closed`
- Branch `exec/2026-02` **retained indefinitely** (never composted)

---

#### Failure Handling

**Scenario:** Research entity's dependency scanner crashes

**Response:**
1. Research branch shows `status: failed` in MongoDB
2. Creature logs error, retries scan once
3. If second attempt fails → branch commits error evidence
4. Synthesis proceeds with partial data (dev + critic only)
5. Report includes warning: "Dependency scan incomplete — manual review required"
6. Tree cannot close until Dave acknowledges incomplete scan

**Critical difference from Scheduled Automation:**
- **Automation tree:** Retry next run, failures are acceptable
- **Audit tree:** Cannot close with failures, manual review required

---

#### Contract System (JSON Schemas)

**AuditMetrics.schema.json** — validates KPI data packages

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "AuditMetrics",
  "type": "object",
  "required": ["scan_date", "findings", "remediation_rate"],
  "properties": {
    "scan_date": {
      "type": "string",
      "format": "date"
    },
    "findings": {
      "type": "object",
      "required": ["total", "by_severity"],
      "properties": {
        "total": { "type": "integer", "minimum": 0 },
        "by_severity": {
          "type": "object",
          "properties": {
            "critical": { "type": "integer", "minimum": 0 },
            "high": { "type": "integer", "minimum": 0 },
            "medium": { "type": "integer", "minimum": 0 },
            "low": { "type": "integer", "minimum": 0 }
          }
        }
      }
    },
    "remediation_rate": {
      "type": "number",
      "minimum": 0,
      "maximum": 100,
      "description": "Percentage of previous month's findings resolved"
    },
    "compliance_status": {
      "type": "object",
      "additionalProperties": {
        "enum": [
          "compliant",
          "compliant_with_notes",
          "findings_require_remediation",
          "non_compliant"
        ]
      }
    },
    "tickets_created": {
      "type": "array",
      "items": { "type": "string", "pattern": "^ELLIE-\\d+$" }
    }
  }
}
```

**Finding.schema.json** — validates individual finding structure

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Finding",
  "type": "object",
  "required": ["severity", "evidence", "recommendation"],
  "properties": {
    "severity": {
      "enum": ["critical", "high", "medium", "low"]
    },
    "entity": {
      "type": "string",
      "enum": ["research", "dev", "critic"]
    },
    "scan_type": {
      "type": "string",
      "enum": ["security", "dependencies", "code-quality", "data-privacy"]
    },
    "rule": { "type": "string" },
    "file": { "type": "string" },
    "line": { "type": "integer", "minimum": 1 },
    "evidence": {
      "type": "string",
      "minLength": 10,
      "description": "Detailed evidence supporting the finding"
    },
    "recommendation": {
      "type": "string",
      "minLength": 10
    },
    "remediation_effort": {
      "type": "string",
      "pattern": "^\\d+\\s*(min|hour|day)s?.*$"
    },
    "cve": {
      "type": ["string", "null"],
      "pattern": "^CVE-\\d{4}-\\d+$"
    },
    "ticket": {
      "type": ["string", "null"],
      "pattern": "^ELLIE-\\d+$"
    }
  }
}
```

---

#### KPI Data Package (MongoDB)

**Purpose:** Track audit effectiveness over time

**Structure:**

```js
{
  tree_id: "550e8400-e29b-41d4-a716-446655440009",
  kpi_type: "audit_health",
  generated_at: "2026-02-01T00:47:23Z",
  period: {
    start: "2025-12-01",
    end: "2026-02-01",
    months: 3
  },
  metrics: {
    avg_findings_per_month: 15,
    trend_direction: "improving",
    trend_percentage: -33, // 33% decrease
    avg_remediation_rate: 93.5, // (87 + 100) / 2
    high_severity_count: 4, // total across 3 months
    persistent_issues: [
      {
        issue: "test-coverage-gaps",
        occurrences: 3,
        months: ["2025-12", "2026-01", "2026-02"]
      },
      {
        issue: "dependency-updates-lag",
        occurrences: 2,
        months: ["2025-12", "2026-02"]
      }
    ]
  },
  compliance: {
    SOC2: {
      status: "on_track",
      target_date: "2026-06-30",
      blockers: []
    },
    GDPR: {
      status: "compliant",
      last_violation: null
    }
  }
}
```

**Worker process:**
1. Runs after each audit completion
2. Fetches last N months of audit executions from MongoDB
3. Aggregates findings, calculates trends
4. Validates against `AuditMetrics.schema.json`
5. Publishes to dashboard via SSE stream
6. Stores in `kpi_packages` collection for historical queries

---

#### Creature Orchestration

**Audit tree uses 4 creatures:**

1. **Audit Scheduler** (cron trigger)
   - MongoDB change stream: watches `trees` collection for `tree_type: "audit"`
   - Checks `schedule` field, triggers on matching cron expression
   - Creates new `exec/YYYY-MM` branch
   - Dispatches entity workers in parallel

2. **Synthesis Coordinator** (all entities complete)
   - MongoDB change stream: watches `executions[*].entity_results`
   - Waits for all 3 entities (research, dev, critic) to commit findings
   - Merges findings, creates consolidated report
   - Auto-creates Plane tickets for medium+ severity
   - Generates compliance report
   - Triggers trend analysis creature

3. **Trend Analyzer** (synthesis complete)
   - Reads last N months of audit branches from git
   - Calculates trends, identifies persistent issues
   - Commits `trend-analysis.md`
   - Publishes KPI data package to MongoDB

4. **Sign-off Enforcer** (report complete)
   - Sets tree status → `awaiting_signoff`
   - Sends notifications to compliance officer
   - Blocks tree closure until sign-off received
   - After 72 hours without sign-off → escalates to critical alert

---

#### Comparison to Scheduled Automation Tree (#5)

| Aspect | Automation Tree | Audit Tree |
|--------|----------------|------------|
| **Purpose** | Recurring task execution | Compliance evidence collection |
| **Branch lifecycle** | Composted after N runs | Retained indefinitely |
| **Failure handling** | Retry next run | Manual review required |
| **Review** | Optional (dashboards show health) | Mandatory (sign-off + trend analysis) |
| **Ticket creation** | Optional | Required for medium+ severity |
| **Compliance** | N/A | SOC2, GDPR, ISO 27001 support |

---

#### Key Design Validations

**✅ Retention policies** — `tree_config.retention.policy: "indefinite"` prevents composting

**✅ Evidence requirements** — All findings must include `evidence` field validated by JSON schema

**✅ Sign-off workflow** — Tree cannot close without compliance officer approval

**✅ Trend analysis** — Critic reviews multi-month patterns, not just current scan

**✅ Remediation tracking** — Auto-creates Plane tickets, links back to audit tree

**✅ Regulatory support** — Generates compliance reports for SOC2, GDPR frameworks

---

**Pattern** → periodic execution like automation, but with compliance-grade retention, mandatory review, and trend analysis

**Audit trail** → full history of findings, remediation, and trends retained forever for regulatory compliance

---

## Inter-Tree Relationships

**Observation:** Trees are currently independent in the model. But real-world use cases suggest relationships:

- **Migration trees** depend on project trees (can't refactor what doesn't exist)
- **Escalation trees** spawn from conversation trees (handoff creates new branch)
- **Audit trees** reference the trees they're auditing (compliance sweep checks work session trees)

**Potential solution:** A `tree_links` table with relationship types:
- `parent/child` — one tree spawned another
- `blocks` — tree A must complete before tree B can proceed
- `references` — tree A reads from tree B (read-only dependency)

**Decision:** Don't add until a real case demands it. The use cases above can be modeled without explicit links:
- Migration tree stores `related_tree_ids` in tree_config JSON
- Escalation stores `parent_conversation_id` in metadata
- Audit stores `audited_tree_ids` in its commits

If patterns emerge that MongoDB JSON can't express cleanly, revisit `tree_links`.

---

## QA in the Dev Process

QA isn't just another entity — it's a **contribution policy pattern**.

```
WorkSessionTree (ELLIE-86)
  trunk: main
  ├── branch: dev/implementation
  │    ├── commit: "add email routes"
  │    ├── commit: "wire up Graph API"
  │    └── merge → main (blocked until QA passes)
  │
  ├── branch: qa/validation  ← QA branches from same trunk
  │    ├── commit: "test plan created"
  │    ├── commit: "3/5 cases pass"
  │    ├── commit: "regression found in auth flow"
  │    └── merge → main (with test results)
  │
  └── trunk merges only when both branches clear
```

### QA as an Entity

- **Contribution policy**: QA can _block_ trunk merges. Dev can't close a tree without QA sign-off.
- **Creature pattern**: A "gate" creature — sits between dev branch merge and trunk acceptance. Pull pattern: dev finishes → creature dispatches QA entity → QA validates → creature allows merge.
- **Commits are test artifacts**: Each QA commit contains test results, not code changes. The tree's history shows _what was tested_ alongside _what was built_.

### Scaling

- QA entity could be an AI agent running automated tests
- Or a human reviewing via Telegram ("approve this merge?")
- Or both — AI runs tests, human reviews edge cases
- The contribution policy defines which pattern applies per tree type

### Key Insight

QA doesn't need its own tree type. It's a **role within any tree that has a gating policy**. Conversation trees don't need QA. Work session trees do. Project trees definitely do. The contribution policy on the tree determines whether QA is required.

### Schema Additions

Added to `contribution_policies`:
- `gate_entities UUID[]` — entities that must approve before trunk merge
- `gate_strategy TEXT` — how gate approval works (all_must_approve, any_can_approve, majority)

Added `gate` creature type for gating interactions.

Added new tree types to `tree_type` enum:
- `incident_response` — fast lifecycle, high urgency
- `onboarding` — template-driven, linear
- `learning` — long-lived, dormant/reactivatable
- `automation` — recurring, template trunk
- `debate` — multi-agent, synthesis merge
- `deliverable` — client-facing, gated output
