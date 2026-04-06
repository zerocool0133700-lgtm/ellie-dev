# OpenClaw Session Branching + Compaction Safeguards — Research Report

**Research Date:** 2026-03-19
**Researcher:** General Agent
**Purpose:** Evaluate OpenClaw's compaction safeguards for adoption into Ellie OS

---

## Executive Summary

OpenClaw implements a **pre-compaction snapshot** system that captures session state before context compression, enabling rollback if critical context gets dropped. This addresses the exact gap identified in Ellie: working memory exists but has no rollback mechanism.

**Key Finding:** OpenClaw's safeguard is not about *preventing* compaction failures — it's about **detecting and recovering** from them.

**Adoption Path for Ellie:**
1. Write working memory to a Forest branch **before** compaction starts
2. Verify `context_anchors` and `decision_log` survive **after** compaction completes
3. If critical sections are lost, **restore** from the Forest branch

---

## OpenClaw's Compaction Safeguard Architecture

### 1. Pre-Compaction Snapshot

**Location:** `src/agents/pi-embedded-runner/run/attempt.ts:2615-2622`

```typescript
// Capture snapshot before compaction wait so we have complete messages if timeout occurs
const wasCompactingBefore = activeSession.isCompacting;
const snapshot = activeSession.messages.slice();  // ← snapshot the message array
const wasCompactingAfter = activeSession.isCompacting;
// Only trust snapshot if compaction wasn't running before or after capture
const preCompactionSnapshot = wasCompactingBefore || wasCompactingAfter ? null : snapshot;
const preCompactionSessionId = activeSession.sessionId;
```

**Race Condition Protection:**
- Checks `isCompacting` **before** and **after** capture
- If compaction is active during snapshot, discard it (`null`)
- Prevents capturing mid-compaction state

**What's Captured:**
- Full message history (`activeSession.messages.slice()`)
- Session ID (`preCompactionSessionId`)
- Stored **in-memory** (not persisted to disk)

---

### 2. Compaction Timeout Recovery

**Location:** `src/agents/pi-embedded-runner/run/compaction-timeout.ts`

```typescript
export function selectCompactionTimeoutSnapshot(params: {
  timedOutDuringCompaction: boolean;
  preCompactionSnapshot: AgentMessage[] | null;
  currentSnapshot: AgentMessage[];
}): SnapshotSelection {
  if (!params.timedOutDuringCompaction) {
    return { messagesSnapshot: params.currentSnapshot, source: "current" };
  }
  if (params.preCompactionSnapshot) {
    return { messagesSnapshot: params.preCompactionSnapshot, source: "pre-compaction" };
  }
  return { messagesSnapshot: params.currentSnapshot, source: "current" };
}
```

**Timeout Logic:**
- Compaction has 60-second aggregate timeout (`COMPACTION_RETRY_AGGREGATE_TIMEOUT_MS`)
- If timeout occurs, use pre-compaction snapshot (if available)
- Log warning: `"proceeding with pre-compaction state"`

**Use Case:**
- Compaction hangs or exceeds timeout
- Model returns malformed summary
- Network failure during compaction API call

---

### 3. Quality Checks (Compaction Safeguard Extension)

**Location:** `src/agents/pi-extensions/compaction-safeguard.ts`

This is a **Pi Agent Core extension** that hooks into the `session_before_compact` event and adds quality validation.

#### Required Summary Sections

```typescript
const REQUIRED_SUMMARY_SECTIONS = [
  "## Decisions",
  "## Open TODOs",
  "## Constraints/Rules",
  "## Pending user asks",
  "## Exact identifiers",
];
```

If compaction produces a summary missing any section, it retries (up to 3 attempts).

#### Identifier Preservation

**Opaque Identifier Extraction:**
- Hex IDs (8+ chars): `A1B2C3D4E5F6`
- URLs: `https://example.com/path`
- File paths: `/home/user/file.txt`, `C:\Windows\System32`
- Network endpoints: `localhost:3000`
- Large numbers: `123456`

**Verification:**
```typescript
const missingIdentifiers = identifiers.filter(
  (id) => !summaryIncludesIdentifier(summary, id)
);
if (missingIdentifiers.length > 0) {
  reasons.push(`missing_identifiers:${missingIdentifiers.join(",")}`);
}
```

If identifiers are missing from the summary, compaction is retried with feedback:
> "Previous summary failed quality checks (missing_identifiers:abc123,xyz789). Fix all issues and include every required section with exact identifiers preserved."

#### User Ask Overlap Check

Ensures the **latest user question** is reflected in the summary:
```typescript
function hasAskOverlap(summary: string, latestAsk: string | null): boolean {
  const askTokens = tokenizeAskOverlapText(latestAsk);  // extract keywords
  const summaryTokens = tokenizeAskOverlapText(summary);
  // Require at least 1-2 keyword matches
  return overlapCount >= requiredMatches;
}
```

If the user's question isn't reflected, compaction is retried.

#### Quality Guard Retry Flow

1. **Attempt 1:** Summarize with standard instructions
2. **Quality Check:** Verify sections, identifiers, user ask
3. **If Failed:**
   - Generate quality feedback (`"missing_section:## Decisions"`)
   - Retry with augmented instructions
4. **Max Retries:** 3 attempts (`qualityGuardMaxRetries`)
5. **Fallback:** Use last successful summary, or cancel compaction

---

### 4. Post-Compaction Context Injection

**Location:** `src/auto-reply/reply/post-compaction-context.ts`

After compaction completes, OpenClaw **re-injects critical workspace context** from `AGENTS.md`:

```typescript
export async function readPostCompactionContext(
  workspaceDir: string
): Promise<string | null> {
  const agentsPath = path.join(workspaceDir, "AGENTS.md");
  const sections = extractSections(content, ["Session Startup", "Red Lines"]);

  return (
    "[Post-compaction context refresh]\n\n" +
    "Session was just compacted. The conversation summary above is a hint, " +
    "NOT a substitute for your startup sequence. " +
    "Run your Session Startup sequence — read the required files before responding."
  );
}
```

**Sections Extracted:**
- `## Session Startup` — instructions for what to do after compaction
- `## Red Lines` — absolute rules that must not be violated

**Date Substitution:**
- Replaces `YYYY-MM-DD` placeholders with real date
- Ensures agents read **current** daily memory files, not training-cutoff dates

**Truncation:**
- Max 3000 chars (`MAX_CONTEXT_CHARS`)
- Prevents context bloat from large AGENTS.md files

---

### 5. Session Forking/Branching

**Location:** `src/auto-reply/reply/session-fork.ts`

OpenClaw supports **branching sessions** from a parent:

```typescript
export function forkSessionFromParent(params: {
  parentEntry: SessionEntry;
  agentId: string;
  sessionsDir: string;
}): { sessionId: string; sessionFile: string } | null {
  const manager = SessionManager.open(parentSessionFile);
  const leafId = manager.getLeafId();
  if (leafId) {
    // Use SDK's native branching
    const sessionFile = manager.createBranchedSession(leafId) ?? manager.getSessionFile();
    return { sessionId: manager.getSessionId(), sessionFile };
  }
  // Fallback: create new session with parentSession reference
  const header = {
    type: "session",
    id: sessionId,
    timestamp,
    cwd: manager.getCwd(),
    parentSession: parentSessionFile,  // ← link to parent
  };
  fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, "utf-8");
  return { sessionId, sessionFile };
}
```

**Use Cases:**
- Thread branching (explore alternative approaches)
- Experimentation (try different prompts without affecting main session)
- Rollback (fork from known-good state)

**Limitations:**
- `parentForkMaxTokens` (default 100k) — skip forking if parent is too large
- Prevents new sessions from inheriting near-full context

---

## Ellie's Current State

### Working Memory System (ELLIE-538/539)

**Database:** `ellie-forest/working_memory` table
**API:** `http://localhost:3001/api/working-memory/*`

**7 Sections (all optional strings):**
1. `session_identity` — agent name, ticket ID, channel
2. `task_stack` — ordered todo list with active task highlighted
3. `conversation_thread` — narrative summary (not transcript)
4. `investigation_state` — hypotheses, files read, current exploration
5. **`decision_log`** — choices made this session with reasoning
6. **`context_anchors`** — specific details that must survive (errors, line numbers, values)
7. `resumption_prompt` — agent-written continuation note for future self

**✅ Already Has:** `context_anchors` and `decision_log` sections
**❌ Missing:** Rollback mechanism, pre-compaction snapshot, safeguard verification

### Forest Knowledge Store

**Database:** `ellie-forest` Elasticsearch + Postgres
**API:** `http://localhost:3001/api/bridge/*`

**Capabilities:**
- Write structured knowledge entries (decisions, findings, facts, hypotheses)
- Semantic search across entries
- Scope-based organization (`2/1` = ellie-dev, `2/2` = ellie-forest, etc.)
- Confidence scoring, metadata tagging

**Branch Concept:**
Forest uses **tree/branch/leaf** metaphor:
- **Tree:** High-level knowledge structure (conversation tree, project tree, calendar tree)
- **Branch:** Topic within a tree
- **Leaf:** Individual facts/observations

**Current Use:**
- Persistent knowledge across sessions
- Post-work write-backs (decisions, findings)
- Pre-work briefing searches

**Not Currently Used For:**
- Session state snapshots
- Rollback/recovery

---

## Adoption Strategy for Ellie

### Goal

Add OpenClaw-style compaction safeguards to Ellie:
1. Snapshot working memory **before** compaction
2. Verify `context_anchors` and `decision_log` survive **after** compaction
3. Restore from snapshot if critical sections are lost

### Implementation Plan

#### Phase 1: Pre-Compaction Snapshot to Forest

**When:** Before any agent prompt that might trigger compaction

**What to Snapshot:**
- Full working memory record (all 7 sections)
- Session ID, agent name, turn number
- Timestamp

**Where to Store:**
Forest branch record with type `"working_memory_snapshot"`

**API Call:**
```typescript
const snapshot = await readWorkingMemory({ session_id, agent });

await writeMemory({
  content: JSON.stringify(snapshot.sections),
  type: "finding",  // or new type: "snapshot"
  scope_path: "2/1",  // ellie-dev
  confidence: 1.0,  // exact snapshot, not interpretation
  metadata: {
    source: "pre_compaction_snapshot",
    session_id: snapshot.session_id,
    agent: snapshot.agent,
    turn_number: snapshot.turn_number,
    snapshot_timestamp: new Date().toISOString(),
  },
  tags: ["working_memory_snapshot", `session:${session_id}`, `agent:${agent}`],
});
```

**Trigger Point:**
In `src/prompt-builder.ts` or agent dispatch, **before** sending prompt to LLM:
```typescript
// Check if context is near compaction threshold (heuristic)
const estimatedTokens = estimatePromptTokens(prompt);
const contextWindow = getModelContextWindow(model);
if (estimatedTokens > contextWindow * 0.7) {
  // Likely to trigger compaction — snapshot first
  await snapshotWorkingMemoryToForest({ session_id, agent });
}
```

---

#### Phase 2: Post-Compaction Safeguard Check

**When:** After agent response completes

**What to Verify:**
1. `context_anchors` still populated (if it was before)
2. `decision_log` still populated (if it was before)
3. Critical identifiers preserved (ticket IDs, file paths, error messages)

**Verification Logic:**
```typescript
const preSnapshot = await readForestSnapshot({ session_id, agent });
const postMemory = await readWorkingMemory({ session_id, agent });

// Check 1: context_anchors survived
if (preSnapshot.context_anchors && !postMemory.sections.context_anchors) {
  logger.warn("context_anchors lost during compaction", { session_id, agent });
  return { lost_sections: ["context_anchors"] };
}

// Check 2: decision_log survived
if (preSnapshot.decision_log && !postMemory.sections.decision_log) {
  logger.warn("decision_log lost during compaction", { session_id, agent });
  return { lost_sections: ["decision_log"] };
}

// Check 3: critical identifiers preserved
const preCriticalIds = extractCriticalIdentifiers(preSnapshot.context_anchors);
const postCriticalIds = extractCriticalIdentifiers(postMemory.sections.context_anchors);
const missingIds = preCriticalIds.filter(id => !postCriticalIds.includes(id));
if (missingIds.length > 0) {
  logger.warn("critical identifiers lost during compaction", {
    session_id, agent, missingIds
  });
  return { lost_identifiers: missingIds };
}

return { ok: true };
```

**Identifier Extraction:**
Use OpenClaw's regex patterns:
- Hex IDs: `/[A-Fa-f0-9]{8,}/`
- URLs: `/https?:\/\/\S+/`
- File paths: `/\/[\w.-]{2,}(?:\/[\w.-]+)+/` (Unix), `/[A-Za-z]:\\[\w\\.-]+/` (Windows)
- Ticket IDs: `/ELLIE-\d+/`
- Ports: `/:\d{1,5}/`
- Error codes: `/\b\d{3,}\b/`

---

#### Phase 3: Rollback Mechanism

**When:** Post-compaction check detects lost sections

**Rollback Flow:**
```typescript
async function rollbackWorkingMemoryFromSnapshot(opts: {
  session_id: string;
  agent: string;
}): Promise<void> {
  // 1. Fetch latest snapshot from Forest
  const snapshot = await searchForestSnapshots({
    session_id: opts.session_id,
    agent: opts.agent,
    limit: 1,
    orderBy: "created_at DESC",
  });

  if (!snapshot) {
    throw new Error("No snapshot found for rollback");
  }

  // 2. Restore sections to working memory
  const sections = JSON.parse(snapshot.content);
  await updateWorkingMemory({
    session_id: opts.session_id,
    agent: opts.agent,
    sections,
  });

  // 3. Log rollback event
  logger.warn("Rolled back working memory from snapshot", {
    session_id: opts.session_id,
    agent: opts.agent,
    snapshot_id: snapshot.id,
    snapshot_timestamp: snapshot.metadata.snapshot_timestamp,
  });

  // 4. Write rollback fact to Forest (for debugging)
  await writeMemory({
    content: `Working memory rolled back due to compaction safeguard failure. ` +
             `Restored from snapshot ${snapshot.id}.`,
    type: "fact",
    scope_path: "2/1",
    confidence: 1.0,
    metadata: {
      source: "compaction_safeguard_rollback",
      session_id: opts.session_id,
      agent: opts.agent,
      snapshot_id: snapshot.id,
    },
    tags: ["compaction_safeguard", "rollback"],
  });
}
```

**User Notification:**
When rollback occurs, send a message to the user:
> "⚠️ Context compression detected critical information loss. Restored from backup snapshot. This is automatic — no action needed."

---

#### Phase 4: Forest Branch Record Integration

**Long-term Evolution:**

OpenClaw stores snapshots **in-memory** (lost on session end). Ellie stores them **in Forest** (persists forever).

**Advantages:**
- Enables **cross-session rollback** (resume from snapshot days later)
- Supports **session branching** (fork from snapshot to explore alternatives)
- Provides **audit trail** (see all snapshots, when they were taken, what changed)

**Forest Schema Addition:**

Create a new `tree_type` for session state snapshots:

```sql
-- migrations/forest/XXX-session-snapshots.sql
INSERT INTO tree_types (name, description) VALUES (
  'session_snapshot',
  'Working memory snapshots for compaction safeguarding and rollback'
);

-- Create a tree for each agent
INSERT INTO trees (tree_type_id, scope_id, name, metadata) VALUES (
  (SELECT id FROM tree_types WHERE name = 'session_snapshot'),
  (SELECT id FROM scopes WHERE path = '2/1'),  -- ellie-dev
  'session_snapshots_dev',
  '{"agent": "dev"}'::jsonb
);
```

**Branch per Session:**
```sql
-- Each session gets its own branch
INSERT INTO branches (tree_id, name, metadata) VALUES (
  (SELECT id FROM trees WHERE name = 'session_snapshots_dev'),
  'ELLIE-914',  -- or session UUID
  '{"session_id": "ELLIE-914", "created_at": "2026-03-19T15:00:00Z"}'::jsonb
);
```

**Snapshot Commits:**
Each pre-compaction snapshot becomes a **commit** on the session branch:
```sql
-- Snapshot #1 (turn 5, before first compaction)
INSERT INTO commits (branch_id, content, metadata) VALUES (
  (SELECT id FROM branches WHERE name = 'ELLIE-914'),
  '{"context_anchors": "...", "decision_log": "..."}'::jsonb,
  '{"turn_number": 5, "snapshot_reason": "pre_compaction", "timestamp": "..."}'::jsonb
);

-- Snapshot #2 (turn 12, before second compaction)
INSERT INTO commits (branch_id, content, metadata) VALUES (
  (SELECT id FROM branches WHERE name = 'ELLIE-914'),
  '{"context_anchors": "...", "decision_log": "..."}'::jsonb,
  '{"turn_number": 12, "snapshot_reason": "pre_compaction", "timestamp": "..."}'::jsonb
);
```

**Rollback to Any Snapshot:**
```typescript
// Rollback to turn 5 snapshot
const snapshots = await getSessionSnapshots({ session_id: "ELLIE-914" });
const targetSnapshot = snapshots.find(s => s.metadata.turn_number === 5);
await rollbackWorkingMemoryFromSnapshot({ snapshot_id: targetSnapshot.id });
```

---

## Comparison: OpenClaw vs. Ellie

| Feature | OpenClaw | Ellie (Current) | Ellie (After Adoption) |
|---------|----------|-----------------|------------------------|
| **Pre-compaction snapshot** | ✅ In-memory | ❌ None | ✅ Persisted to Forest |
| **Timeout recovery** | ✅ 60s timeout | ❌ None | ✅ Same (via snapshot) |
| **Safeguard sections** | ✅ 5 required sections | ✅ 7 sections | ✅ Verify 2 critical sections |
| **Identifier preservation** | ✅ Extract + verify | ❌ None | ✅ Same pattern |
| **Quality retries** | ✅ 3 attempts | ❌ None | 🔶 Optional (Phase 2+) |
| **Post-compaction injection** | ✅ AGENTS.md sections | 🔶 Partial (working memory) | ✅ Same + working memory |
| **Rollback mechanism** | ❌ Discard on timeout | ❌ None | ✅ Restore from Forest |
| **Session forking** | ✅ Via SDK | ❌ None | 🔶 Via Forest branches (Phase 4) |
| **Cross-session recovery** | ❌ Memory-only | ❌ None | ✅ Forest persistence |
| **Audit trail** | ❌ None | ❌ None | ✅ Forest commit history |

**Key Differences:**
- **OpenClaw:** Optimized for in-session recovery (timeout protection)
- **Ellie:** Optimized for cross-session persistence (Forest integration)

---

## Code Locations for Adoption

### Files to Create

1. **`src/compaction-safeguard.ts`** — Core safeguard logic
   - `snapshotWorkingMemoryToForest()` — Pre-compaction snapshot
   - `verifyWorkingMemorySurvived()` — Post-compaction check
   - `extractCriticalIdentifiers()` — Identifier extraction
   - `rollbackWorkingMemoryFromSnapshot()` — Restore from Forest

2. **`tests/compaction-safeguard.test.ts`** — Test suite
   - Snapshot creation
   - Safeguard verification (sections + identifiers)
   - Rollback recovery
   - Race condition handling

3. **`migrations/forest/XXX-session-snapshots.sql`** — Forest schema
   - `tree_type: session_snapshot`
   - Trees per agent
   - Branches per session

### Files to Modify

1. **`src/prompt-builder.ts`**
   - Add pre-compaction snapshot trigger (before prompt sent)
   - Check estimated tokens vs. context window threshold

2. **`src/agent-router.ts` or dispatch layer**
   - Add post-response safeguard check
   - Trigger rollback if verification fails

3. **`src/working-memory.ts`**
   - Add `getWorkingMemoryDiff()` helper (compare pre/post snapshots)

4. **`src/api/bridge.ts` (Forest Bridge)**
   - Add `readForestSnapshot()` helper
   - Add `searchForestSnapshots()` helper

---

## Next Steps

### Immediate (MVP — Addresses Dave's Request)

1. ✅ **Research complete** (this document)
2. **Spike: Pre-compaction snapshot** (2 hours)
   - Write working memory to Forest before compaction threshold
   - Test snapshot creation + retrieval
3. **Spike: Safeguard check** (2 hours)
   - Verify `context_anchors` and `decision_log` survived
   - Extract + verify critical identifiers
4. **Spike: Rollback** (2 hours)
   - Restore working memory from Forest snapshot
   - Test recovery flow

**Total Estimate:** 6 hours (1 work session)

### Follow-up (Hardening)

5. **Quality retries** (OpenClaw-style)
   - Retry prompt if safeguard fails (before rollback)
   - Max 3 attempts with feedback
6. **Session branching**
   - Fork working memory to explore alternatives
   - Merge snapshots back to main branch
7. **Audit dashboard**
   - View snapshot history per session
   - Manual rollback UI

**Total Estimate:** 12 hours (2 work sessions)

---

## Open Questions

1. **When to snapshot?**
   - Before every prompt? (heavy)
   - Only when near context limit? (heuristic)
   - User-triggered via `/snapshot`? (manual)

2. **Snapshot retention?**
   - Keep last N snapshots per session?
   - TTL-based pruning (e.g., 7 days)?
   - Archive when session completes?

3. **Rollback notification?**
   - Silent (log only)?
   - User notification (Telegram/chat)?
   - Block response until user confirms?

4. **Verification strictness?**
   - Block on ANY missing identifier?
   - Only block on missing `context_anchors` / `decision_log`?
   - Configurable per agent?

---

## References

**OpenClaw Files Analyzed:**
- `src/agents/pi-extensions/compaction-safeguard.ts` (1033 lines)
- `src/agents/pi-embedded-runner/run/attempt.ts` (lines 2610-2710)
- `src/agents/pi-embedded-runner/run/compaction-timeout.ts` (73 lines)
- `src/auto-reply/reply/post-compaction-context.ts` (234 lines)
- `src/auto-reply/reply/session-fork.ts` (64 lines)
- `docs/concepts/compaction.md`

**Ellie Files Analyzed:**
- `src/working-memory.ts`
- `src/api/working-memory.ts`
- `migrations/forest/20260304_working_memory.sql`

**Key OpenClaw Concepts:**
- Pi Agent Core extension system (`session_before_compact` event)
- Compaction retry with quality feedback
- Workspace context injection from AGENTS.md
- Session branching via `SessionManager.createBranchedSession()`

---

## Conclusion

OpenClaw's compaction safeguard is **production-ready** and directly applicable to Ellie. The core pattern is simple:

1. **Before compaction:** Snapshot to Forest
2. **After compaction:** Verify critical sections survived
3. **If failed:** Restore from snapshot

Ellie's existing working memory system (`context_anchors`, `decision_log`) maps perfectly to the safeguard requirements. The main work is:
- **Plumbing:** Wire snapshot writes before compaction threshold
- **Verification:** Extract identifiers + check section survival
- **Recovery:** Restore from Forest on failure

**Recommended Next Action:**
Create ticket **ELLIE-XXX: Session Branching + Compaction Safeguards** with 3 sub-tickets:
- ELLIE-XXX-1: Pre-compaction snapshot to Forest
- ELLIE-XXX-2: Post-compaction safeguard verification
- ELLIE-XXX-3: Rollback mechanism

Estimated effort: 6 hours (MVP), 12 hours (full implementation).
