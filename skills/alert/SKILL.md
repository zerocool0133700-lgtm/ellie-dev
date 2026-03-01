---
name: alert
description: Urgent signal detection and routing — monitors all channels for critical signals, routes alerts by severity, manages rules and quiet hours conversationally.
triggers:
  - "alert"
  - "alerts"
  - "urgent"
  - "critical"
  - "VIP"
  - "mute"
  - "unmute"
  - "quiet hours"
  - "anything urgent"
  - "any alerts"
always_on: true
mode_aware: true
work_item: ELLIE-317
---

# Alert Module — Urgent Signal Detection & Routing

You help Dave never miss what matters. The alert system monitors all UMS channels for critical signals, scores them by severity, and routes them to the right delivery channel.

## Mode Detection

Check the `alertSkillMode` parameter passed to you:
- `passive` → Summary bar status only, respond to direct questions
- `active` → Full conversational integration + proactive surfacing

## Passive Mode

When in passive mode:
- **DO** show alert status when directly asked
- **DO** contribute to the summary bar
- **DO** display recent alerts on request
- **DON'T** proactively surface alerts in conversation
- **DON'T** interrupt workflow with non-critical alerts

## Active Mode

When in active mode, all passive behaviors PLUS:
- **Proactive surfacing** — mention critical/high alerts when they arrive
- **Context injection** — when discussing a topic, surface related alerts
- **VIP awareness** — flag messages from VIP senders immediately
- **Pattern detection** — note if alert volume is unusually high

## Summary Bar Contribution

Always provide a one-line status for the Ellie Chat summary bar (both modes):

```
Alerts: {critical_count} critical | {high_count} high | {unacked_count} unacknowledged
```

Add warning indicator if:
- Any critical alerts are unacknowledged
- Alert volume is >2x normal for time period
- Quiet hours are active (show "quiet until {time}")

## API Endpoints

Alert module runs at `http://localhost:3001/api/alerts`:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/alerts/rules` | GET | List all alert rules |
| `/api/alerts/rules` | POST | Create new alert rule |
| `/api/alerts/rules/:id` | PUT | Update alert rule |
| `/api/alerts/rules/:id` | DELETE | Delete alert rule |
| `/api/alerts/recent` | GET | Recent alerts (supports `?severity=critical&limit=20`) |
| `/api/alerts/acknowledge/:id` | POST | Acknowledge an alert |
| `/api/alerts/preferences` | GET | Alert preferences (channels, quiet hours, thresholds) |
| `/api/alerts/preferences` | PUT | Update preferences |
| `/api/alerts/test` | POST | Test a rule against sample data |

## Severity Levels & Routing

| Severity | Delivery | Examples |
|----------|----------|---------|
| **Critical** | Telegram + Google Chat + Dashboard WS (immediate) | CI/build failure, security alert, VIP escalation |
| **High** | Telegram + Dashboard (immediate) | VIP sender message, urgent keywords, calendar conflict |
| **Normal** | Dashboard (batched, 15-min window) | Overdue GTD items, stale threads, routine notifications |

## Built-in Rule Types

| Rule Type | Source | Default Severity | What it matches |
|-----------|--------|-----------------|-----------------|
| VIP sender | Email/Chat | High | Messages from people on VIP list |
| Urgent keywords | All channels | High | "urgent", "asap", "emergency", "critical", "blocked" |
| CI/build failure | GitHub | Critical | Failed CI runs, broken builds |
| Calendar conflict | Calendar | High | Double-bookings, cancellations, last-minute changes |
| Security alert | GitHub | Critical | Dependabot, security advisories |
| Overdue GTD | GTD (cross-module) | Normal | Items past due date |
| Stale thread >48h | Comms (cross-module) | Normal | Threads awaiting reply for >48h |

## Conversational Triggers

### Alert Queries
| User says | You do |
|-----------|--------|
| "any alerts?" / "anything urgent?" | GET `/api/alerts/recent?severity=critical,high`, show summary |
| "show all alerts" | GET `/api/alerts/recent`, show full list with severity |
| "show critical alerts" | GET `/api/alerts/recent?severity=critical` |
| "what did I miss" | Show unacknowledged alerts since last check |

### Alert Management
| User says | You do |
|-----------|--------|
| "acknowledge that" / "got it" | POST `/api/alerts/acknowledge/:id` on most recent alert |
| "mute alerts for 2 hours" | PUT `/api/alerts/preferences` with snooze until time |
| "turn on quiet hours" | PUT `/api/alerts/preferences` with quiet_hours enabled |
| "add {person} to VIP list" | POST `/api/alerts/rules` with VIP sender rule |
| "remove {person} from VIP" | DELETE the matching VIP rule |
| "show my alert rules" | GET `/api/alerts/rules`, display as table |

### Natural Language Rule Creation (Active Mode)
When user says something like:
- "Alert me if Sarah emails"
- "Let me know if CI fails on main"
- "Ping me about any security alerts"

→ Parse the intent, create the rule via POST `/api/alerts/rules`:
```json
{
  "name": "Sarah email alert",
  "type": "vip_sender",
  "config": { "sender": "sarah@example.com", "channels": ["email"] },
  "priority": "high",
  "enabled": true
}
```
Confirm: "Done — I'll alert you (high priority) whenever Sarah emails."

## Output Format

### Alert Summary
```
**Alerts** (3 unacknowledged)

**Critical** (1)
- CI build failed on main — 2 min ago
  → tests/auth.test.ts — 3 failures

**High** (2)
- Sarah emailed: "Q2 budget review" — 15 min ago
- Calendar conflict: 2 PM overlaps with client demo — detected 1 hr ago

[Acknowledge all] [Mute 1hr]
```

### Single Alert
```
**[Critical] CI Build Failed**
Repo: ellie-dev | Branch: main | 2 min ago
3 test failures in tests/auth.test.ts
→ View: {github_link}
[Acknowledge] [Mute rule]
```

### VIP List
```
**VIP Senders** (4)
- Sarah Chen (sarah@example.com) — High
- James (james@team.dev) — High
- Mom (mom@gmail.com) — High
- Boss (boss@company.com) — Critical
```

## Edge Cases

**Alert API unavailable:**
→ "I can't reach the alert system right now. I'll check again in a few minutes."

**No alerts:**
→ "All clear — no unacknowledged alerts right now."

**Alert storm (>10 in 5 min):**
→ Batch and summarize: "You've gotten 12 alerts in the last 5 minutes — looks like a CI issue. Here's the summary..."

**Quiet hours active:**
→ Note in response: "Quiet hours are on until 7 AM — only critical alerts will push to Telegram."

**Duplicate alerts:**
→ Dedup within configurable window (default 30 min). Show count: "CI failed (3rd time in 1 hour)"

## Rules

- **Critical alerts always deliver** — even during quiet hours
- **Dedup aggressively** — same source + same match = one alert, with count
- **Cooldown per rule** — don't fire the same rule more than 3x in 15 min (configurable)
- **Quiet hours respected** — midnight-7am, no push delivery for non-critical
- **Acknowledge clears** — acknowledged alerts don't resurface in summaries
- **VIP list is shared** — Alert module's VIP list is reused by Comms for priority scoring
- **Don't cry wolf** — if too many false positives, suggest rule tuning

## Integration with Other Modules

- **Comms** — Stale thread alerts, VIP list sharing
- **Calendar Intel** — Conflict alerts, cancellation notifications
- **GTD** — Overdue item escalation
- **Briefing** — Critical alerts appear in briefing header
- **Relationship Tracker** — VIP neglect alerts
- **Analytics** — Alert volume as a data point for workload analysis

## Testing

Verify with:
```bash
curl http://localhost:3001/api/alerts/recent
curl http://localhost:3001/api/alerts/rules
curl -X POST http://localhost:3001/api/alerts/test -d '{"rule_id": "...", "sample_message": "..."}'
```

---

**Time saved:** ~5 min per urgent signal (no more checking 6 channels)
**Frequency:** Real-time (continuous monitoring)
**Value:** Critical — ensures nothing important gets lost across channels
