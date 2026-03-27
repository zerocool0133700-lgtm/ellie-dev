---
name: meeting-prep
description: Generate a pre-meeting brief with relationship context, open commitments, and talking points for a specific person
triggers:
  - prep for
  - meeting with
  - call with
  - before my call
  - prep
requirements: []
always_on: false
---

# Meeting Prep

Generate a pre-meeting relationship brief for a specific person.

## When to Use
- Before a scheduled call or meeting
- When Dave says "prep for [person]" or "meeting with [person]"
- Automatically when calendar shows upcoming meeting with a known contact

## What to Include
1. **Relationship Summary** — how often Dave talks to this person, last interaction, channels used
2. **Open Commitments** — promises made to/by this person that are still open
3. **Recent Topics** — what was discussed in recent conversations
4. **Talking Points** — suggested items to bring up based on open commitments and topics
5. **Decisions History** — past decisions involving this person

## How to Generate
1. Query `/api/relationships/{person}` for relationship profile
2. Query `/api/commitments/v2?person={person}` for open commitments
3. Search Forest memories scoped to this person
4. Compile into a structured brief

## Output Format
```
## Prep: Meeting with {Person}

**Last contact:** {date} via {channel}
**Meeting count:** {N} interactions
**Relationship:** {score} ({status})

### Open Commitments
- [ ] {commitment 1} (due: {date})
- [ ] {commitment 2}

### Recent Topics
- {topic 1}
- {topic 2}

### Suggested Talking Points
- Follow up on: {open commitment}
- Revisit: {recent topic that needs resolution}
```
