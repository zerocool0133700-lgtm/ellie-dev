# ELLIE-76 Investigation Report: Choppy Agent Workflow Patterns

**Date:** 2026-02-19
**Investigator:** Dev Agent
**Related Issues:** ELLIE-73 (SIGTERM crashes), ELLIE-74 (repetitive status checks), ELLIE-75 (missing dispatch confirmations)

---

## 1. Agent Lifecycle Map

The full agent message lifecycle, from user request to completion, involves these stages. Each stage is annotated with what feedback the user receives (or does not).

### 1.1 Single-Agent Path (Telegram)

```
User sends message
    |
    v
[1] withQueue() checks if busy ──────────────> YES: "I'm working on something — I'll get to this next. (Queue position: N)"
    |                                                  (User sees queue position, then silence until processed)
    NO
    |
    v
[2] ctx.replyWithChatAction("typing")         <-- User sees "typing..." bubble
    |
    v
[3] routeAndDispatch()                        <-- NO user feedback (200-400ms Haiku call + edge function dispatch)
    |   - classifyIntent() → route-message fallback
    |   - dispatchAgent() → creates/resumes agent session in Supabase
    |
    v
[4] Gather context (5 parallel fetches)       <-- NO user feedback (context docket, semantic search, ES, structured, recent)
    |
    v
[5] buildPrompt() + callClaudeWithTyping()    <-- User sees "typing..." every 4s
    |   - spawn claude CLI process
    |   - TIMEOUT: 420s (agent mode) / 60s (non-agent)
    |
    v
[6] processMemoryIntents()                    <-- NO user feedback
    |
    v
[7] Agent indicator (if new, non-general)     <-- User sees: "🤖 research agent" (only on NEW sessions, not resumed)
    |
    v
[8] sendWithApprovals() → ctx.reply()         <-- User sees response
    |
    v
[9] syncResponse() (fire-and-forget)          <-- NO user feedback (logs agent session stats)
    |
    v
[10] resetTelegramIdleTimer()                 <-- Invisible: 10 min timer for conversation close
```

### 1.2 Multi-Step Path (Telegram, ELLIE-58)

```
[1-4] Same as single-agent...
    |
    v
[5] Mode indicator                            <-- User sees: "🔄 Pipeline: research → strategy (3 steps)"
    |
    v
[6] executeOrchestrated()                     <-- User sees "typing..." every 4s via onHeartbeat
    |   - For each step: dispatchAgent → buildStepPrompt → callClaude/callLightSkill
    |   - Pipeline timeout: 120s total
    |   - Cost limit: $2.00 per execution
    |
    |   NO per-step progress indicators to user
    |
    v
[7] processMemoryIntents() + sendWithApprovals()  <-- User sees final response
    |
    v
[8] Console log only: "[orchestrator] pipeline: 3 steps in 45000ms, $0.0234"
```

### 1.3 Google Chat Path (async-first)

```
[1-3] Same routing/dispatch...
    |
    v
[4] Race Claude call vs 25s webhook timeout
    |
    ├── Claude finishes < 25s: Sync response inline     <-- User sees response
    |
    └── Claude takes > 25s: "Working on it..."          <-- User sees interim message
        |
        v
        Claude finishes eventually                       <-- User sees async response via REST API
        |
        OR
        Claude times out (420s) / exits 143              <-- User sees: "Error: Claude exited with code 143"
                                                              (raw error string, not user-friendly)
```

### 1.4 Work Session Path (Claude Code dev agent → relay)

```
Claude Code starts session
    |
    v
POST /api/work-session/start
    |
    v
"🚀 Work Session Started" on Telegram        <-- User sees start notification
    |
    v
POST /api/work-session/update (during work)
    |
    v
"📝 Progress Update" on Telegram              <-- User sees progress (IF agent posts updates)
    |
    v
POST /api/work-session/complete
    |
    v
"✅ Work Session Complete" on Telegram         <-- User sees completion with duration

*** BUT: If the agent crashes or SIGTERM kills it ***
*** No completion POST ever happens ***            <-- User left in dark; session stays "active" forever
*** Work session auto-expires after 4 hours ***    <-- No notification sent on auto-expire
```

---

## 2. Feedback Gaps

### GAP-1: No Dispatch Confirmation (ELLIE-75)
**Where:** Between steps [2] and [5] in the single-agent path.
**Duration:** 200-800ms (route + dispatch + context gathering).
**Impact:** The user sends a message and sees "typing..." but has no idea which agent was selected, or that routing even happened. For complex requests that trigger multi-step pipelines, there is a brief indicator, but for single-agent routes (the common case), the first feedback after "typing..." is the full response -- which can take 30-120 seconds.

### GAP-2: No Per-Step Progress in Pipelines
**Where:** Inside `executeOrchestrated()` during multi-step execution.
**Duration:** 30s-120s for full pipeline.
**Impact:** After seeing "Pipeline: research -> strategy (3 steps)", the user sees only "typing..." until the entire pipeline completes. There is no indication of which step is currently running, whether Step 1 finished, etc. The only progress visible is in console logs.

### GAP-3: Crash/SIGTERM Produces Raw Error String
**Where:** `callClaude()` error handling, line ~524-540 in relay.ts.
**Impact:** When Claude CLI exits with code 143 (SIGTERM from timeout), the user sees:
```
Error: Claude exited with code 143
```
This is a raw technical string. The user gets no explanation, no recovery suggestion, and no indication of what the agent was working on when it died. In Google Chat specifically, the log shows:
```
[gchat] Async reply (34 chars): Error: Claude exited with code 143...
```

### GAP-4: Work Session "Zombie" State
**Where:** `expireStaleWorkSessions()` in relay.ts, lines 401-418.
**Impact:** When a dev agent session crashes mid-work:
1. The `POST /api/work-session/complete` never fires
2. The session stays `state: active` in Supabase
3. The auto-expire runs every 5 minutes but only catches sessions >4 hours old
4. **No Telegram notification** is sent when a session auto-expires
5. Plane work item remains "In Progress" indefinitely
6. The user has to manually check or ask again

### GAP-5: Agent Session Stale After Crash
**Where:** `expireStaleAgentSessions()` in relay.ts, lines 420-437.
**Impact:** Agent sessions (from `agent_sessions` table) also go stale:
1. Auto-expire only catches sessions >2 hours inactive
2. No notification on expire
3. If user sends a new message before expire, `dispatchAgent()` may resume the stale session

### GAP-6: Queue Position is Static
**Where:** `withQueue()` in relay.ts, line 650.
**Impact:** When a message is queued, the user sees "Queue position: N" once. If another message arrives ahead (e.g., from Google Chat), the position changes but the user is not notified. There is no "now processing your message" notification when their queued item starts.

### GAP-7: No "Agent Finished" Signal for Resumed Sessions
**Where:** Lines 807-810 in relay.ts.
**Impact:** The agent indicator (`🤖 research agent`) only shows on **new** sessions. If a session is **resumed**, the user gets no agent indicator at all. Over multiple messages, the user loses track of which agent they're talking to.

### GAP-8: Google Chat `respondedSync` Crash
**Where:** Line 2039-2042 in relay.ts.
**Impact:** A `ReferenceError: Cannot access 'respondedSync' before initialization` crash was observed multiple times in logs (Feb 19: 12:59, 13:33). This is a JS temporal dead zone issue -- `sendSyncResponse` is called from the multi-step branch before the `let respondedSync` declaration in the single-agent path. When this crashes, the user gets **no response at all** and the service restarts. This is confirmed in the logs:
```
Feb 19 12:59:05 bun[2609918]: ReferenceError: Cannot access 'respondedSync' before initialization.
Feb 19 13:33:01 bun[2609918]: ReferenceError: Cannot access 'respondedSync' before initialization.
```

---

## 3. Crash Handling Analysis

### 3.1 Exit Code 143 (SIGTERM)

Exit code 143 = 128 + 15 (SIGTERM). This happens in two scenarios:

**Scenario A: Internal Timeout**
- `callClaude()` has a 420s (7 minute) timeout for agent mode
- After 420s, it calls `proc.kill()`, which sends SIGTERM to the Claude CLI process
- The relay handles this: logs the timeout, returns `Error: ...` string
- **User sees:** Raw error message. No retry. No explanation.

**Scenario B: systemd Service Restart**
- When `systemctl --user restart claude-telegram-relay` is issued (during deployments, config changes)
- systemd sends SIGTERM to the bun process (KillSignal=15)
- The relay has SIGTERM handler (line 309-312): `releaseLock()` then `process.exit(0)`
- But: any in-flight Claude CLI processes (child spawns) also get SIGTERM
- The child processes die with exit 143
- **No cleanup of in-flight requests**: if a message was being processed, the user never gets a response
- **No cleanup of active work sessions**: the work session stays "active" in Supabase
- `Restart=on-failure` means systemd only restarts if exit code is non-zero; `process.exit(0)` from SIGTERM means **no automatic restart**

Actual log pattern from Feb 19:
```
13:17:09  [claude] Exit code 143 (timed out) — no stderr
13:17:09  [gchat] Async reply (34 chars): Error: Claude exited with code 143...
13:23:46  [claude] Exit code 143 (timed out) — no stderr
13:23:46  [gchat] Async reply (34 chars): Error: Claude exited with code 143...
```
Two Claude CLI processes timed out within 6 minutes of each other, both producing user-facing error messages.

### 3.2 Service Restart Frequency

Between Feb 17-19, the service was restarted approximately **20+ times**. Each restart creates a window where:
1. In-flight requests are lost silently
2. Active sessions go zombie
3. Queue items are dropped with no notification
4. Context cache is cleared (next request is slower)

### 3.3 `respondedSync` Crash (most critical)

The `respondedSync` variable is declared at line 2039 inside the single-agent Google Chat path, but `sendSyncResponse()` (which references it at line 2042) is called from the **multi-step branch** at line 1966 -- before the declaration is reached. This is a scoping bug: `sendSyncResponse` is a function defined later in the same scope using `function` declaration (hoisted), but it references `respondedSync` which is a `let` (not hoisted).

This crash:
1. Kills the entire Google Chat webhook handler
2. Returns no response to Google Chat
3. The service may continue running but the in-flight request is lost
4. Observed 3 times on Feb 19 alone

---

## 4. Concurrent Agent UX

### 4.1 Queue System

The relay uses a **single-threaded** concurrency model:
- One `busy` flag guards all Claude invocations
- `messageQueue` holds pending tasks from all channels (Telegram + Google Chat)
- `currentItem` tracks what's processing (channel, preview, start time)

**Exposed via `/queue-status` endpoint:**
```json
{
  "busy": true,
  "queueLength": 1,
  "current": {
    "channel": "telegram",
    "preview": "analyze this code...",
    "durationMs": 45000
  },
  "queued": [
    { "position": 1, "channel": "google-chat", "preview": "(message)", "waitingMs": 12000 }
  ]
}
```

This endpoint exists but is **never surfaced to the user**. It is only accessible via direct HTTP call. The user has no way to see what the bot is currently working on from Telegram or Google Chat.

### 4.2 Cross-Channel Interaction

When a Telegram message is processing and a Google Chat message arrives:
- The Google Chat message hits the webhook timeout (25s) and sends "Working on it..."
- The message gets queued
- When the Telegram task finishes, the Google Chat task starts
- But there is no notification to the Telegram user that a Google Chat message bumped their queue position

### 4.3 Work Sessions vs Agent Sessions

Two separate tracking systems exist:
- **`work_sessions`** table: Tracks Claude Code dev agent work items (ELLIE-N)
- **`agent_sessions`** table: Tracks relay-side agent sessions (general, research, dev, etc.)

These are **not linked**. A work session (ELLIE-76) creates a `work_sessions` record, but the relay-side agent routing creates separate `agent_sessions` records. There is no unified view of "what is the bot doing right now?"

---

## 5. Proposed Unified Status System

### 5.1 Agent Status Model

```
AgentStatus {
  id: string
  channel: "telegram" | "google-chat" | "voice"
  agent_name: string
  skill_name?: string
  execution_mode: "single" | "pipeline" | "fan-out" | "critic-loop"
  state: "routing" | "dispatched" | "executing" | "step_N_of_M" | "completing" | "completed" | "failed" | "timed_out"
  message_preview: string
  started_at: timestamp
  updated_at: timestamp
  step_detail?: string  // "Step 2/3: strategy agent analyzing..."
  error?: string
  duration_ms?: number
}
```

### 5.2 User-Facing Status Messages

| State | User Message |
|-------|-------------|
| routing | (none -- too fast to show) |
| dispatched | "research agent is on it" |
| executing (single) | (typing indicator, existing behavior) |
| step_N_of_M | "Step 2/3: strategy agent is working..." |
| completed | (response delivered) |
| failed | "I ran into a problem processing your request. [error summary]. Want me to try again?" |
| timed_out | "This is taking longer than expected. I'll keep working and notify you when done." |

### 5.3 Status Query Command

A `/status` Telegram command that returns:
```
Current: research agent processing "analyze the code..." (45s)
Queue: 1 message waiting (google-chat, 12s)
Work sessions: ELLIE-76 active (dev agent, 15 min)
```

---

## 6. Recommendations (Prioritized)

### P0 (Critical -- Causes User-Visible Failures)

1. **Fix `respondedSync` scoping bug** -- Move the `sendSyncResponse` function and `respondedSync` variable to before the multi-step branch so both code paths can access it. This is causing ~3 crashes per day on Google Chat.

2. **Humanize error messages for exit code 143** -- Replace raw `Error: Claude exited with code 143` with something like: "I got interrupted while working on this. Want me to try again?" Track whether the error was internal timeout vs external SIGTERM and tailor the message accordingly.

3. **Add graceful shutdown for in-flight requests** -- When the relay receives SIGTERM, instead of immediately calling `process.exit(0)`:
   - Set a "draining" flag to reject new messages with "I'm restarting, please try again in a moment"
   - Wait for in-flight Claude processes to finish (with a 30s grace period)
   - Post "work session interrupted" for any active work sessions
   - Then exit

### P1 (High -- Smooths Workflow Significantly)

4. **Send dispatch confirmation for single-agent routes** -- After `routeAndDispatch()` succeeds, immediately send a brief indicator: `"research agent is on it"` (for non-general agents). Currently only shows for new sessions; should show for all non-general agents.

5. **Add per-step progress messages for pipelines** -- In `executeOrchestrated()`, after each step completes, send a brief Telegram message: "Step 1/3 complete (research). Step 2/3: strategy agent working..."

6. **Notify on work session auto-expire** -- In `expireStaleWorkSessions()`, send a Telegram message: "Work session ELLIE-76 expired after 4 hours of inactivity (no completion received). The task may have been interrupted." Update Plane to "Backlog" or a custom "Interrupted" state.

7. **Notify on agent session auto-expire** -- Same for `expireStaleAgentSessions()`: log and optionally notify.

### P2 (Medium -- Improves UX for Power Users)

8. **Implement `/status` command** -- A Telegram command handler that queries:
   - `currentItem` for what's currently processing
   - `messageQueue` for queued items
   - `work_sessions` table for active work sessions
   - Returns a clean status summary

9. **Link work sessions to agent sessions** -- Add `work_item_id` column to `agent_sessions` table (or vice versa). When a relay-side agent processes a message about ELLIE-76, it should be visible in the work session timeline.

10. **Queue position updates** -- When a queued message starts processing, send "Now working on your message" to the user who was waiting. Track which user sent each queued message.

### P3 (Low -- Nice to Have)

11. **Change systemd Restart policy** -- Current: `Restart=on-failure`. Since SIGTERM handler calls `process.exit(0)`, the service does not auto-restart after a `systemctl restart`. Consider:
    - `Restart=always` with `RestartSec=5`
    - Or ensure SIGTERM handler exits with non-zero for unexpected SIGTERMs (distinguish "intentional restart" from "crash")

12. **Add timeout escalation** -- Instead of a hard 420s timeout that kills and shows an error:
    - At 120s: send user a message "This is taking a while, still working..."
    - At 300s: "Still working. This is complex -- I'll message you when done."
    - At 420s: kill, but notify user and save partial output if any

13. **Expose `/queue-status` in chat** -- The endpoint exists but is only accessible via HTTP. Surface it via a Telegram button or command.

---

## Summary

The choppy agent workflow pattern stems from three interconnected issues:

1. **Silent failures**: When agents crash (SIGTERM/143, timeout, JS errors), the user gets either a raw error string or nothing at all. There is no recovery path offered.

2. **Feedback deserts**: Between "typing..." and the final response, the user has no visibility into what's happening. For 30-120 second operations, this feels broken.

3. **Zombie state accumulation**: Crashed agent/work sessions stay "active" in the database for hours, with no notification sent. The user must manually re-request.

The `respondedSync` scoping bug (GAP-8) is the most critical immediate fix -- it causes hard crashes with zero user feedback on Google Chat. After that, adding dispatch confirmations and humanized error messages would address the most visible symptoms.
