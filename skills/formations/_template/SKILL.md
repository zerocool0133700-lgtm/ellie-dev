---
name: formation-name
description: Brief description of what this formation accomplishes
agents:
  [
    {
      "agent": "dev",
      "role": "lead",
      "responsibility": "Write implementation code",
      "canInitiate": true
    },
    {
      "agent": "critic",
      "role": "reviewer",
      "responsibility": "Review and critique proposals",
      "canInitiate": false
    }
  ]
protocol:
  {
    "pattern": "coordinator",
    "maxTurns": 10,
    "coordinator": "dev",
    "requiresApproval": false,
    "conflictResolution": "coordinator-decides"
  }
triggers: ["review code", "code review"]
minAgents: 2
timeoutSeconds: 300
---

## Objective

Describe the formation's goal — what it produces or decides.

## Agent Roles

- **dev** (lead): Writes implementation code and proposes approaches
- **critic** (reviewer): Reviews proposals, identifies issues, suggests improvements

## Interaction Flow

1. Lead proposes an approach or implementation
2. Reviewer critiques the proposal
3. Lead addresses feedback and iterates
4. Coordinator decides when the output is ready

## Completion Criteria

- All agents have contributed at least once
- No unresolved critical issues raised by reviewer
- Lead confirms final output is ready

## Escalation

If agents cannot reach agreement within maxTurns:
- Coordinator summarizes the disagreement
- Escalate to human for final decision
