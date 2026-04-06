# ELLIE-922 Orchestration Postmortem

**Date:** March 19, 2026
**Work Item:** ELLIE-922 — Session Branching + Compaction Safeguards
**Orchestrator:** Ellie (general agent)
**Outcome:** Work completed successfully, but orchestration process had significant issues

---

## Executive Summary

ELLIE-922 was successfully completed with 2 commits and full test coverage (22 passing tests), but the orchestration process broke down at multiple points. The work ended up being completed manually by Dave rather than through the intended agent dispatch system. This postmortem identifies where the orchestration failed and provides actionable fixes.

---

## Timeline

### Initial Request (around 3:16 PM)
- Dave requested: "Orchestrate implementation of ELLIE-922 (Session Branching + Compaction Safeguards)"
- Expected: Ellie creates ticket, breaks into GTD tasks, dispatches to specialist agents
- Actual: Orchestration attempt began but hit multiple blockers

### Ticket Creation Issues
**Problem:** Initial attempt to create ELLIE-922 ticket in Plane had issues
- Root cause unknown (need to investigate logs/history)
- Likely: API error, missing fields, or incorrect project ID

### GTD Task Creation Issues
**Problem:** GTD tasks were created but never assigned to agents
- Tasks existed in system but had no `delegated_to` field set
- Agents never picked up the work because they weren't explicitly assigned
- No mechanism for agents to "pull" work from GTD without explicit assignment

### Dispatch Mechanism Issues
**Problem:** Orchestration used `/api/orchestration/dispatch` instead of Agent tool
- This isolated the work in a separate process
- Dave couldn't see agent progress in real-time
- Results came back detached from conversation
- Dave had no visibility into what was happening

### Manual Completion (4:13 PM - 5:15 PM)
- Dave completed the work directly in VS Code
- Commit 1 (4:13 PM): Initial implementation with verification and rollback
- Commit 2 (5:15 PM): Fixed 3 critical race conditions
- Work item successfully completed, but not through orchestration

---

## What Went Right ✅

1. **Work was completed successfully**
   - 939 lines of code added (safeguard.ts + tests)
   - 22/22 tests passing for initial implementation
   - All 3 critical race conditions fixed in follow-up commit
   - High-quality implementation with proper error handling

2. **Clear acceptance criteria**
   - Work item had well-defined phases and success criteria
   - Implementation followed OpenClaw patterns as specified

3. **Test coverage**
   - Comprehensive test suite covering all safeguard scenarios
   - Tests caught issues that were fixed in the second commit

---

## What Went Wrong ❌

### 1. Ticket Creation Failed or Was Delayed

**What happened:**
- Initial attempt to create ELLIE-922 ticket in Plane had issues
- Orchestration couldn't proceed without a valid work item ID

**Impact:**
- Delayed start of actual work
- Required manual intervention to create ticket or retry

**Root cause:**
- Unknown — need to investigate Plane MCP error logs
- Possibly: missing required fields, incorrect state ID, or API timeout

---

### 2. GTD Tasks Never Assigned to Agents

**What happened:**
- GTD tasks were created for ELLIE-922 sub-tasks
- Tasks existed in the system but had no `delegated_to` field
- Agents never received or picked up the work

**Impact:**
- Work didn't flow to specialist agents as intended
- Orchestration stalled — tasks existed but no one was working on them
- Dave had to step in and do the work manually

**Root cause:**
- **Missing assignment step:** Orchestrator created tasks but didn't set `delegated_to: 'dev'`
- **No agent pull mechanism:** Agents can't self-assign from GTD without explicit delegation
- **No monitoring:** Orchestrator didn't detect that tasks were sitting unassigned

---

### 3. Wrong Dispatch Mechanism Used

**What happened:**
- Orchestrator used `/api/orchestration/dispatch` to route work to agents
- This isolated agent work in a separate process
- Dave couldn't see progress in real-time

**Impact:**
- No visibility into agent activity
- Dave didn't know if agents were working, stuck, or done
- Felt like a "black box" — work disappeared and never came back

**Root cause:**
- **Outdated dispatch pattern:** `/api/orchestration/dispatch` was designed for background work
- **Missing Agent tool usage:** Should have used Agent tool (subagent bubbles in conversation)
- **Documentation mismatch:** CLAUDE.md didn't explicitly forbid `/api/orchestration/dispatch`

---

### 4. No Failure Detection or Recovery

**What happened:**
- When orchestration failed, no alerts or fallback mechanism kicked in
- Dave eventually noticed work wasn't progressing and took over manually

**Impact:**
- Silent failure — orchestration broke but didn't notify anyone
- Wasted time waiting for agents that were never dispatched
- Dave had to diagnose the orchestration failure himself

**Root cause:**
- **No monitoring layer:** Orchestrator didn't track task progress or detect stalls
- **No timeout logic:** No "if task unstarted after 5 minutes, escalate" mechanism
- **No heartbeat checks:** No way to verify agents were actually working

---

## Root Cause Analysis

### Primary Root Cause: Incomplete GTD Orchestration Implementation

The orchestration system had the pieces (GTD tasks, agent router, work sessions) but they weren't wired together correctly:

1. **Task creation ≠ task assignment**
   - Creating a GTD task doesn't automatically assign it to an agent
   - Missing: explicit `delegated_to` field population

2. **No agent-side "check GTD for work" logic**
   - Agents don't poll GTD for unassigned tasks
   - Missing: agent boot protocol that checks GTD on startup

3. **No orchestrator monitoring loop**
   - Orchestrator creates tasks then... nothing
   - Missing: periodic check to see if tasks are progressing

### Secondary Root Cause: Wrong Dispatch Abstraction

The `/api/orchestration/dispatch` endpoint was designed for fire-and-forget background work, not interactive orchestration:

- No real-time output streaming
- No conversation context integration
- No progress visibility for the user

The **Agent tool** solves all of these problems but wasn't used.

---

## Action Items

### Immediate Fixes (Critical)

1. **Fix GTD task assignment in orchestration**
   - When creating GTD tasks for orchestration, always set `delegated_to: <agent>`
   - Verify field is populated before moving on
   - Add validation: throw error if task created without assignment

2. **Update orchestration to use Agent tool exclusively**
   - Remove all references to `/api/orchestration/dispatch` in orchestration code
   - Update multi-agent orchestration playbook to make Agent tool usage explicit
   - Add anti-pattern warning: "Never use `/api/orchestration/dispatch` for orchestration"

3. **Add orchestration monitoring**
   - After creating tasks, periodically check their status
   - If task unstarted after 5 minutes → escalate to Dave
   - If task in-progress but no updates for 10 minutes → check in with agent

4. **Document the "GTD as agent inbox" pattern**
   - Agents should check GTD on boot for tasks assigned to them
   - Similar to a boot file pattern: "check for work before asking user what to do"
   - Update agent boot protocol to include GTD check

### Short-Term Improvements (High Priority)

5. **Add Plane ticket creation retry logic**
   - Wrap ticket creation in try/catch with 3 retries
   - Log specific error messages for debugging
   - If all retries fail → notify Dave and abort orchestration

6. **Create orchestration health dashboard**
   - Show active orchestrations, task states, agent assignments
   - Accessible via `/api/orchestration/status` or dashboard UI
   - Helps Dave see what's happening when orchestration runs

7. **Add orchestration test suite**
   - Test: create tasks → assign to agents → verify assignment
   - Test: dispatch via Agent tool → verify output appears in conversation
   - Test: failure scenarios (Plane down, agent unavailable, task timeout)

### Long-Term Enhancements (Medium Priority)

8. **Build agent-side GTD polling**
   - Agents check GTD on boot: "any tasks assigned to me?"
   - Agents check GTD periodically: "any new work?"
   - Enables proactive work pickup without explicit dispatch

9. **Add orchestration playbook execution tracking**
   - Log each step of orchestration: ticket creation → task breakdown → assignment → dispatch
   - Store execution trace in Forest or work session metadata
   - Enables post-mortem analysis of failed orchestrations

10. **Create orchestration smoke test command**
    - `/orchestrate test` → runs end-to-end orchestration with a dummy ticket
    - Verifies: ticket creation, GTD tasks, agent dispatch, result integration
    - Run before deploying orchestration changes

---

## Lessons Learned

1. **Orchestration is integration, not just dispatch**
   - Creating tasks ≠ assigning tasks ≠ dispatching work
   - Each step needs validation and error handling

2. **Visibility is critical**
   - Dave needs to see what agents are doing in real-time
   - Agent tool provides this, isolated APIs don't

3. **Silent failures are the worst failures**
   - If orchestration breaks, scream loudly
   - Better to abort noisily than fail silently

4. **Test the full loop, not just the pieces**
   - Individual components (GTD, agent router, Plane MCP) all work
   - But the integration between them had gaps

---

## Success Criteria for Next Orchestration

The next time Dave says "orchestrate ELLIE-XXX", this should happen:

1. ✅ Ticket created in Plane (or clear error if it fails)
2. ✅ GTD tasks created with `delegated_to` field set
3. ✅ Agents dispatched via Agent tool (Dave sees progress in real-time)
4. ✅ Work completed and results integrated back into conversation
5. ✅ Work session logged, Plane ticket updated to Done
6. ✅ Dave receives completion notification on Telegram/Google Chat

**If any step fails:**
- Alert Dave immediately with specific error
- Don't proceed to next step
- Log failure details for postmortem

---

## Next Steps

1. Create Plane tickets for all 10 action items above
2. Prioritize immediate fixes (1-4) for next sprint
3. Test orchestration flow with a small ticket before attempting large work items
4. Update CLAUDE.md and commitment framework docs with lessons learned

---

**Postmortem completed:** 2026-03-19
**Action items created:** 10 (4 critical, 3 high priority, 3 medium priority)
**Follow-up:** Schedule orchestration smoke test after fixes deployed
