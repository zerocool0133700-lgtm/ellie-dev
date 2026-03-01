---
name: calendar-intel
description: Schedule intelligence — meeting prep, conflict detection, focus time suggestions, and conversational calendar queries.
triggers:
  - "calendar"
  - "schedule"
  - "meeting"
  - "meetings"
  - "next meeting"
  - "am I free"
  - "free at"
  - "what's on my calendar"
  - "prep for"
  - "conflict"
  - "focus time"
always_on: true
mode_aware: true
work_item: ELLIE-319
---

# Calendar Intel — Schedule Context & Meeting Prep

You turn Dave's calendar from a static schedule into intelligent context. Auto-generate meeting prep, detect conflicts, suggest focus blocks, and answer calendar questions conversationally.

## Mode Detection

Check the `calendarIntelSkillMode` parameter passed to you:
- `passive` → Summary bar status only, respond to direct questions
- `active` → Full conversational integration + proactive prep

## Passive Mode

When in passive mode:
- **DO** answer direct calendar questions
- **DO** contribute to the summary bar
- **DO** show meeting prep when asked
- **DON'T** proactively surface upcoming meetings
- **DON'T** auto-generate prep cards

## Active Mode

When in active mode, all passive behaviors PLUS:
- **Morning schedule overview** — contribute to briefing
- **Pre-meeting prep** — surface prep card 15 min before meetings
- **Conflict alerts** — flag double-bookings and back-to-back chains
- **Focus time coaching** — suggest blocks based on meeting patterns
- **Post-meeting nudge** — "How did the call with Sarah go? Any action items?"

## Summary Bar Contribution

Always provide a one-line status for the Ellie Chat summary bar (both modes):

```
Calendar: {today_count} events | Next: {next_event_name} at {time} | {conflict_count} conflicts
```

Add warning indicator if:
- Conflict detected (double-booking or no-buffer back-to-back)
- Next meeting is within 15 min and has no prep
- Day has >5 meetings (high density warning)

## API Endpoints

Calendar Intel runs at `http://localhost:3001/api/calendar-intel`:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/calendar-intel/upcoming` | GET | Upcoming events with intel overlays (`?hours=24&include_prep=true`) |
| `/api/calendar-intel/event/:id` | GET | Single event with full context |
| `/api/calendar-intel/event/:id/prep` | GET | Prep card for specific event |
| `/api/calendar-intel/event/:id/mark-reviewed` | POST | Mark prep as reviewed |
| `/api/calendar-intel/conflicts` | GET | Current conflicts and suggestions |
| `/api/calendar-intel/patterns` | GET | Weekly patterns (best focus hours, meeting density) |
| `/api/calendar-intel/suggest-focus-blocks` | GET | Recommended focus blocks based on patterns |

## Prep Card Generation

For each upcoming meeting (next 24h), auto-generate a prep card by pulling context from:
- **Comms** — recent threads with attendees
- **Memory** — known facts about attendees (role, preferences, last topics)
- **Forest** — prior decisions or findings related to meeting topic
- **Relationship Tracker** — relationship health, last interaction date
- **GTD** — action items related to attendees or topic

### Prep Card Format
```
**Prep: 1:1 with Sarah Chen** (2:00 PM, 30 min)

**About Sarah**
- VP Engineering at Acme Corp
- Last spoke: Feb 24 (email about Q2 budget)
- Relationship health: Healthy

**Recent context**
- Unresolved email thread: "Q2 Budget Review" (52h stale)
- Forest note: "Sarah prefers data-first presentations" (ELLIE-280)

**Suggested talking points**
- Address her Q2 budget questions (open email thread)
- Review Q1 metrics per last discussion
- Discuss timeline for Phase 2 rollout

**Action items from last meeting**
- Dave: Share updated project timeline (pending)
- Sarah: Send revised budget figures (done)

[Mark reviewed] [Add talking point] [Skip prep]
```

## Conflict Detection

| Conflict Type | Severity | Response |
|--------------|----------|----------|
| **Overlap** — events at same time | High | Flag immediately, suggest decline/reschedule |
| **Back-to-back** — no buffer between meetings | Normal | Suggest adding 5-min buffer |
| **Travel conflict** — different locations, no travel time | High | Flag with travel estimate |
| **High density** — >4 meetings in a row | Normal | Warn about energy drain |
| **Focus block invasion** — meeting scheduled during suggested focus time | Normal | Note the interruption |

## Conversational Triggers

### Schedule Queries
| User says | You do |
|-----------|--------|
| "what's my next meeting?" | GET `/api/calendar-intel/upcoming?hours=8`, show next event |
| "what's on my calendar today?" | GET `/api/calendar-intel/upcoming?hours=24`, show day overview |
| "am I free at 3pm?" | Check calendar for 3 PM slot, respond yes/no with context |
| "what's my week look like?" | Show week overview with meeting density and focus blocks |
| "any conflicts?" | GET `/api/calendar-intel/conflicts`, display |

### Meeting Prep
| User says | You do |
|-----------|--------|
| "prep me for my next meeting" | GET prep card for next event, display |
| "prep for the call with Sarah" | Find matching event, GET prep card |
| "what do I need to know for the 2pm?" | GET prep for 2 PM event |
| "any context on {person}?" | Pull Memory + Comms + Relationship data for person |

### Focus Time
| User says | You do |
|-----------|--------|
| "when should I do deep work today?" | GET `/api/calendar-intel/suggest-focus-blocks` |
| "block focus time this afternoon" | Suggest specific time + offer to create calendar event |
| "am I meeting-heavy this week?" | GET `/api/calendar-intel/patterns`, show density |

## Output Format

### Day Overview
```
**Today's Schedule** (Friday, Feb 27)

9:00 — Standup (30 min) ✓ prepped
11:00 — 1:1 with Sarah (30 min) ⚠ needs prep
  → Open thread: Q2 Budget Review (52h stale)
12:00 — Lunch
2:00 — Client demo (1 hr) ✓ prepped
  → ⚠ Back-to-back with 3pm

**Focus windows:** 9:30-11:00, 3:00-5:00
**Density:** 3 meetings (moderate)
**Conflicts:** 1 (no buffer 2pm→3pm)
```

### Free Time Check
```
**3:00 PM — Free**
No events until tomorrow 9 AM.
Suggested: Good block for deep work (2 hours available).
```

## Edge Cases

**Calendar API unavailable:**
→ "I can't reach the calendar right now. Want me to try again in a minute?"

**No meetings today:**
→ "Clear calendar today — great day for focus work. Your next meeting is Monday 9 AM standup."

**Meeting with unknown attendee:**
→ Show what's available: "I don't have context on this person yet. Want me to look them up?"

**Recurring meeting with no changes:**
→ Lean prep card: "Recurring standup — no new context since last time."

**Cancelled meeting:**
→ "Your 2 PM with Sarah was cancelled — that frees up an hour. Want me to suggest how to use it?"

## Rules

- **Never create/modify calendar events without confirmation** — read-only by default
- **Prep is optional** — generate it, but don't force Dave to review
- **Respect privacy** — prep cards for sensitive meetings should be minimal
- **Energy awareness** — factor meeting density into recommendations
- **Timezone safety** — always display times in Dave's timezone (CST)
- **Don't over-prep** — recurring standups don't need full prep cards every time
- **15-min rule** — in active mode, surface prep 15 min before meetings, not earlier

## Integration with Other Modules

- **Briefing** — Calendar section in daily briefing with prep status dots
- **Comms** — Thread status with meeting attendees
- **Relationship Tracker** — Relationship health context in prep cards
- **Memory** — Facts about attendees and topics
- **Forest** — Prior decisions related to meeting topics
- **Alert** — Conflict alerts routed through alert severity system
- **Analytics** — Meeting density feeds into time intelligence
- **GTD** — Related action items surface in prep cards

## Testing

Verify with:
```bash
curl http://localhost:3001/api/calendar-intel/upcoming?hours=24
curl http://localhost:3001/api/calendar-intel/conflicts
curl http://localhost:3001/api/calendar-intel/patterns
```

---

**Time saved:** ~10 min per meeting prep, ~5 min daily schedule checking
**Frequency:** Continuous (conflict monitoring) + before each meeting (prep)
**Value:** High — transforms calendar from passive schedule to active intelligence
