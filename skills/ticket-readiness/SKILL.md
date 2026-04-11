---
name: ticket-readiness
description: Check if a Plane work item is ready for dispatch — validates description, estimate, assignee, target date, and state
userInvocable: true
instant_commands: [help]
mcp: mcp__plane__*
requires:
  env: [PLANE_API_KEY]
triggers: [readiness, ready for dispatch, ticket ready, dispatch check, pre-dispatch]
---

Check whether a Plane work item passes all readiness criteria before dispatch.

## Endpoint

```
GET http://localhost:3001/api/ticket/readiness?id=ELLIE-123
GET http://localhost:3001/api/ticket/readiness?id=ELLIE-123&strict=true
```

### Parameters

| Param | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Work item identifier (e.g. `ELLIE-123`) |
| `strict` | No | `true` promotes warnings to blockers (for autonomous/overnight dispatch) |

### Response

```json
{
  "work_item_id": "ELLIE-123",
  "title": "Implement feature X",
  "ready": true,
  "blockers": [],
  "warnings": [
    { "rule": "no_assignee", "message": "No assignee — ownership is unclear" }
  ],
  "summary": "ELLIE-123 readiness warnings:\n  [WARNING] No assignee — ownership is unclear",
  "details": {
    "priority": "high",
    "state_group": "unstarted",
    "has_estimate": true,
    "has_assignee": false,
    "has_target_date": true,
    "description_length": 145
  }
}
```

### Status Codes

| Code | Meaning |
|------|---------|
| 200 | Check completed (see `ready` field for result) |
| 400 | Missing `id` parameter |
| 404 | Work item not found in Plane |
| 503 | Plane not configured |

## Readiness Rules

### Blockers (hard-gate dispatch)

| Rule | Condition |
|------|-----------|
| `state_terminal` | Ticket is completed or cancelled |
| `description_empty` | No description |
| `description_too_short` | Description < 20 chars |
| `description_matches_title` | Description is identical to title |
| `high_priority_no_estimate` | Urgent/high priority with no estimate |

### Warnings (informational; blockers in strict mode)

| Rule | Condition |
|------|-----------|
| `no_estimate` | No story point estimate |
| `no_assignee` | No assignee set |
| `target_date_past` | Target date is in the past |
| `stale_ticket` | Not updated in 30+ days |

## Usage

### From curl

```bash
curl -s "http://localhost:3001/api/ticket/readiness?id=ELLIE-123" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

### From agent code

```typescript
const res = await fetch("http://localhost:3001/api/ticket/readiness?id=ELLIE-123");
const { ready, blockers, warnings } = await res.json();
if (!ready) {
  console.log("Blocked:", blockers.map(b => b.message).join(", "));
}
```

### Batch check (shell)

```bash
for id in ELLIE-100 ELLIE-101 ELLIE-102; do
  echo "$id: $(curl -s "http://localhost:3001/api/ticket/readiness?id=$id" | jq -r '.ready')"
done
```

## Commands

- `/ticket-readiness help` — Show this help
- Ask naturally: "Is ELLIE-123 ready for dispatch?" or "Check readiness of ELLIE-500"
