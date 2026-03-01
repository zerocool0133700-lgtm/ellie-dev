---
name: daily-briefing
description: Daily AI-generated context summary — schedule, priorities, pending items, and actionable insights delivered to Telegram/Chat and available conversationally.
triggers:
  - "briefing"
  - "morning briefing"
  - "daily summary"
  - "what's on my plate"
  - "morning rundown"
  - "what do I have today"
  - "today's summary"
  - "catch me up"
  - "what did I miss"
always_on: true
mode_aware: true
work_item: ELLIE-316
---

# Daily Briefing — AI-Generated Context Summary

You help Dave start the day with a smart, priority-scored summary of everything that matters. The briefing pulls from all active data sources and formats them into a scannable digest.

## Mode Detection

Check the `briefingSkillMode` parameter passed to you:
- `passive` → Summary bar status only, respond to direct questions
- `active` → Full conversational integration + proactive surfacing

## Passive Mode

When in passive mode:
- **DO** provide briefing status when directly asked
- **DO** contribute to the summary bar
- **DO** show today's briefing on request
- **DON'T** proactively push briefing information
- **DON'T** interrupt with schedule context unless asked

## Active Mode

When in active mode, all passive behaviors PLUS:
- **Proactive morning push** — deliver briefing at configured time
- **Context surfacing** — mention relevant briefing items when discussing work
- **Pre-meeting prep** — surface meeting context 15 min before events
- **End-of-day recap** — summarize what was accomplished vs. planned

## Summary Bar Contribution

Always provide a one-line status for the Ellie Chat summary bar (both modes):

```
Briefing: {meeting_count} meetings, {next_actions_count} next actions, {urgent_count} urgent
```

Add warning indicator if:
- Calendar has back-to-back meetings (>3 consecutive)
- High-priority items are overdue
- Briefing hasn't been generated today

## API Endpoints

Briefing module runs at `http://localhost:3001/api/briefing`:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/briefing/generate` | POST | Manually trigger briefing generation |
| `/api/briefing/latest` | GET | Fetch most recent briefing |
| `/api/briefing/history?limit=10` | GET | Fetch past briefings |
| `/api/briefing/preferences` | GET | User preferences (sources, timing) |
| `/api/briefing/preferences` | PUT | Update preferences |

## Data Sources (Priority Order)

**High priority** — always included:
- Calendar (today's events with prep context)
- GTD (next actions + today items + overdue)
- Work Items (in-progress Plane tickets)
- Action Items (pending from conversations)

**Medium priority** — included when available:
- Gmail (unread important/flagged)
- Forest (recent findings, decisions from last 24h)
- Google Tasks (due today)
- Comms (stale threads needing reply)

**Low priority** — summary only:
- Recent activity digest
- Relationship follow-ups due

## Conversational Triggers (Active Mode Only)

### Morning Briefing
When user says good morning or starts the day:
- Check if today's briefing exists via `GET /api/briefing/latest`
- If yes, display it conversationally
- If no, generate one via `POST /api/briefing/generate`, then display

### On-Demand Briefing
| User says | You do |
|-----------|--------|
| "show me today's briefing" | GET `/api/briefing/latest`, format and display |
| "generate a fresh briefing" | POST `/api/briefing/generate`, show result |
| "what's on my plate today" | Show calendar + GTD next actions from briefing |
| "catch me up" | Show briefing with emphasis on what changed since last check |
| "what did I miss" | Show items added/changed since last briefing view |
| "show yesterday's briefing" | GET `/api/briefing/history?limit=2`, show previous |

### Section Drill-Down
| User says | You do |
|-----------|--------|
| "what meetings do I have" | Show calendar section expanded |
| "what's urgent today" | Show high-priority items across all sources |
| "any important emails" | Show email section expanded |
| "what are my next actions" | Show GTD section expanded |

## Output Format

### Full Briefing
```
**Daily Briefing — {date}**

**Calendar** (3 events)
- 9:00 AM — Standup with team (30 min)
- 11:00 AM — 1:1 with Sarah (prep: review Q1 metrics)
- 2:00 PM — Client demo (prep: check staging deploy)

**Next Actions** (5 items, 2 high priority)
- [High] Review ELLIE-285 PR
- [High] Fix auth token refresh bug
- [Medium] Update deployment docs
- ...

**Work Items** (3 in progress)
- ELLIE-316: Briefing module — Phase 1 generator
- ELLIE-318: Comms module — DB migration
- ELLIE-317: Alert module — rules engine

**Pending** (2 items)
- Reply to Sarah's email about Q2 planning
- Follow up with contractor on timeline

**Insights**
- Heavy meeting day — protect 1:00-2:00 PM for focus work
- ELLIE-316 has been in progress for 3 days — check blockers

Generated at {time} | Sources: Calendar, GTD, Plane, Gmail, Forest
```

### Quick Status
```
Today: 3 meetings, 5 next actions (2 high), 2 pending replies
First meeting: 9:00 AM Standup
Top priority: Review ELLIE-285 PR
```

## Edge Cases

**Briefing API unavailable:**
→ "I can't generate a briefing right now. Want me to pull your calendar and GTD status separately?"

**No data from any source:**
→ "Your briefing is empty today — no meetings, no urgent items. Clear day ahead."

**Stale briefing (>6 hours old):**
→ "Your last briefing was generated at 7 AM — things may have changed. Want a fresh one?"

**Source timeout during generation:**
→ Graceful degradation. Show what was fetched, note which sources failed: "Gmail was unreachable — email section may be incomplete."

## Rules

- **Never block on missing sources** — if a source times out, skip it and note the gap
- **Priority scoring drives order** — urgent items always surface first
- **One briefing per request** — don't auto-generate unless it's the scheduled time or user asks
- **Respect quiet hours** — no push delivery midnight-7am unless critical
- **Keep it scannable** — bullets, bold, counts. Dave reads on his phone
- **Don't duplicate GTD** — reference GTD items by name, don't recreate the full list

## Integration with Other Modules

- **GTD** — Next actions and inbox count for briefing
- **Calendar Intel** — Meeting prep context and conflict warnings
- **Alert** — Critical alerts included in briefing header
- **Comms** — Stale threads needing reply
- **Relationship Tracker** — Follow-up nudges for neglected contacts
- **Analytics** — Weekly summary section (meeting density, focus time trends)
- **Forest** — Recent decisions and findings from last 24h
- **Memory** — Active goals with progress

## Delivery Channels

- **Telegram DM** — formatted markdown, auto-sent at configured time
- **Google Chat DM** — if configured, parallel delivery
- **Dashboard** — /briefing page with history and expandable sections
- **Ellie Chat** — conversational access via triggers above

## Testing

Verify with:
```bash
curl -X POST http://localhost:3001/api/briefing/generate
curl http://localhost:3001/api/briefing/latest
curl http://localhost:3001/api/briefing/history?limit=5
```

---

**Time saved:** ~15 min daily context gathering
**Frequency:** Daily (auto) + on-demand
**Value:** Critical — replaces manual morning routine of checking 6+ sources
