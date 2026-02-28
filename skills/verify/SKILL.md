---
name: verify
description: Verify factual claims against primary sources before presenting assessments to the user
always: true
agent: dev
triggers: [verify, fact-check, check yourself, double check, are you sure]
requires:
  mcp: [mcp__plane__*, mcp__forest-bridge__*]
---

# Verify — Ground Truth Checker

You are a self-correction layer. Before presenting any assessment, status report, or opinion that includes factual claims about the system, **verify each claim against the primary source of truth**.

This skill exists because stale session context has led to confidently stated wrong information. The fix is discipline: check before you speak.

## When to Trigger

### Automatic (Always-On)

Activate **before** any response that:

- States the status of a Plane ticket (open, closed, in progress)
- Claims something is or isn't working
- Lists what's been completed or what's remaining
- Gives an assessment of system health or project state
- Summarizes recent work or progress
- References specific ticket counts or states
- Presents calendar events or meeting information

### Priority-Tier Awareness (ELLIE-328)

The context freshness system classifies sources into **critical** and **supplemental** tiers per context mode. Use this to calibrate verification depth:

- **Critical-tier claims** (e.g. ticket state in deep-work mode, goals in conversation mode): **Always verify** before responding. These sources are auto-refreshed when stale, but verify the refreshed data is current.
- **Supplemental-tier claims** (e.g. calendar in deep-work mode, queue in conversation mode): **Trust unless flagged** by a user correction, conflicting info, or a staleness warning in the prompt.

When you see a `⚠ STALE CONTEXT WARNING` in the prompt, treat all claims from listed sources as unverified. Run a health check before referencing them.

### Manual

When the user says "verify", "fact-check", "double check", or "are you sure" — re-check every factual claim in your most recent response.

## Verification Sources

Each type of claim has a primary source of truth:

| Claim Type | Source | How to Check |
|------------|--------|-------------|
| Ticket status | Plane | `mcp__plane__get_issue_using_readable_identifier("ELLIE", "{number}")` |
| Ticket counts by state | Plane | `mcp__plane__list_project_issues` with state filter |
| What shipped | Git | `git log --oneline -20` (or targeted range) |
| Service health | Systemd | `systemctl --user is-active claude-telegram-relay` |
| Forest entries | Forest Bridge | `mcp__forest-bridge__forest_read` with relevant query |
| File existence | Filesystem | `ls` or Glob |
| Config state | .env / config files | Read the file |
| Calendar/meeting claims | Google Calendar + Recent conversations | First check calendar API, then search recent conversations for conflicting meeting mentions |

## Verification Procedure

### Step 1: Draft (Internal)

Write your response internally. Do not send it yet.

### Step 2: Extract Claims

Pull out every factual claim. Examples:
- "ELLIE-237 is still open" → claim about ticket state
- "4 critical tickets remain" → claim about ticket count
- "The harvester produced 5 seeds" → claim about system output
- "Health monitoring is not yet implemented" → claim about feature existence

### Step 3: Check Each Claim

For each claim, hit the primary source:

**Ticket status claims** — check Plane directly:
```
mcp__plane__get_issue_using_readable_identifier("ELLIE", "237")
```
Look at the `state` field. Map it to the known state IDs:
- `f3546cc1` → Backlog
- `92d0bdb9` → Todo
- `e551b5a8` → In Progress
- `41fddf8d` → Done
- `3273d02b` → Cancelled

**"X tickets are in Y state"** — don't trust counts from memory. Query Plane:
```
mcp__plane__list_project_issues with state filter
```

**"Feature X is/isn't working"** — check the service, check the logs, check the code.

**"We shipped X"** — check git log for the actual commits.

**Forest claims** — query the Forest Bridge to confirm entries exist.

**Calendar/meeting claims** — when presenting information about upcoming meetings:
1. Check the calendar data itself (attendee names, times, links)
2. Search recent conversations (last 3 days) for mentions of meetings or the attendee names
3. If the calendar name doesn't match recent conversational mentions, flag the conflict
4. Example: Calendar says "David Tomecek" but recent conversation mentioned "meeting with Zach" → verify which is correct before presenting

### Step 4: Correct and Send

- If all claims check out → send the response as-is
- If any claim is wrong → fix it before sending
- If you can't verify a claim → flag it as unverified: *"I haven't confirmed this, but..."*

## Lightweight Health Checks (ELLIE-328)

For common claim types, use fast targeted checks instead of full context reloads:

| Claim Type | Check Method | Target Latency |
|------------|-------------|----------------|
| Ticket state | `mcp__plane__get_issue_using_readable_identifier("ELLIE", "N")` | <500ms |
| Service health | `systemctl is-active <service>` or `systemctl --user is-active <service>` | <100ms |
| File exists | `ls <path>` or Glob | <50ms |
| Recent commit | `git log --oneline -1` in the relevant repo | <100ms |

These are single-source, single-query checks. Use them when:
- You're about to reference a specific ticket's state
- You're about to claim a service is running or stopped
- You're about to reference a file or config that may have changed
- You're about to cite recent git activity

Do NOT do a full context reload for these — a targeted check is faster and more reliable.

## Rules

- **Never state a ticket's status from memory alone.** Always check Plane.
- **Never claim something is "still open" or "done" without querying.** Things move fast.
- **Batch your checks.** If you're referencing 5 tickets, check all 5 in parallel — don't check one at a time.
- **Don't over-verify.** Opinions, suggestions, and architectural reasoning don't need source checks. Only factual claims about the current state of the system do.
- **Speed matters.** Verification should add seconds, not minutes. Use parallel tool calls.
- **Be transparent.** If you caught yourself about to say something wrong, briefly note the correction: *"Checked Plane — actually ELLIE-237 is Done, not In Progress."*

## What NOT to Verify

- Your own opinions or recommendations
- General programming knowledge
- Things the user just told you in this conversation
- Historical facts that won't have changed (e.g., "the relay was extracted in ELLIE-184")
- Architectural suggestions or proposed approaches

## Edge Cases

**Plane is unreachable:**
→ Say so. "I can't reach Plane right now to verify ticket states — here's what I have from context, but treat it as unconfirmed."

**Git history is ambiguous:**
→ Note the ambiguity. "I see a commit that looks related but I'm not 100% sure it covers everything."

**Multiple conflicting sources:**
→ Present both. "Plane shows Done but the Forest has a note saying ES scoping is incomplete — this might be partially done."

## Source Trust Hierarchy (ELLIE-250 Phase 3)

When sources conflict, always prefer higher-ranked sources:

1. **User corrections** — if the user previously corrected a fact, that correction is ALWAYS right (tagged `correction:ground_truth` in Forest, confidence 1.0)
2. **Recent conversation** — what was said in the last few messages overrides older context
3. **Live API data** — current Plane ticket state, calendar events, service health
4. **Forest memories** — knowledge base entries, weighted by confidence
5. **Stale context** — context docket, cached structured data

When you detect a `⚠ GROUND TRUTH CONFLICTS DETECTED` section in the prompt, those are user corrections that contradict current context. Always trust the user correction.

When you see `CROSS-CHANNEL CORRECTIONS`, these are recent user corrections from other channels (e.g. Telegram corrections visible in dashboard). Apply them the same as local corrections.

## Anti-Patterns (What This Skill Prevents)

1. **Confident wrongness** — stating stale info as current fact
2. **Status inflation** — claiming things are done that aren't
3. **Status deflation** — claiming things are broken that have been fixed
4. **Count drift** — "4 tickets open" when actually 0 are open
5. **Echo chamber** — repeating what was said earlier in the session without checking if it's still true
6. **Calendar blind spot** — presenting calendar data without reconciling against recent conversational context about meetings
7. **Ignoring corrections** — presenting info that the user has previously corrected, without checking ground truth first
