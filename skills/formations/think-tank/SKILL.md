---
name: think-tank
description: Multi-perspective analysis producing an options matrix with trade-offs
agents:
  [
    {
      "agent": "research",
      "role": "researcher",
      "responsibility": "Gather facts, data points, and prior art relevant to the question",
      "canInitiate": true
    },
    {
      "agent": "strategy",
      "role": "facilitator",
      "responsibility": "Frame the problem, synthesize perspectives into an options matrix",
      "canInitiate": true
    },
    {
      "agent": "critic",
      "role": "challenger",
      "responsibility": "Stress-test assumptions, identify risks and blind spots",
      "canInitiate": true
    }
  ]
protocol:
  {
    "pattern": "coordinator",
    "maxTurns": 6,
    "coordinator": "strategy",
    "requiresApproval": false,
    "conflictResolution": "coordinator-decides"
  }
triggers: ["think tank", "options matrix", "analyze options", "trade-off analysis"]
minAgents: 3
timeoutSeconds: 300
---

## Objective

Produce a structured options matrix for a given question or decision. Each option should include trade-offs, risks, effort estimates, and a recommendation from the facilitator.

## Agent Roles

- **research** (researcher): Gathers evidence, benchmarks, and prior art. Provides the factual foundation that other agents build on.
- **strategy** (facilitator): Frames the problem space, defines evaluation criteria, and synthesizes all input into a final options matrix with a ranked recommendation.
- **critic** (challenger): Pressure-tests each option for hidden risks, second-order effects, and overlooked alternatives. Ensures the matrix is honest, not just optimistic.

## Interaction Flow

1. Strategy frames the question and defines evaluation criteria
2. Research and Critic respond in parallel with findings and concerns
3. Strategy synthesizes into an options matrix
4. Critic reviews the matrix for gaps
5. Strategy produces the final output

## Completion Criteria

- At least 3 distinct options are identified and compared
- Each option has documented trade-offs and risk assessment
- A clear recommendation is provided with reasoning
- Critic has reviewed and signed off (or dissent is recorded)

## Escalation

If agents cannot converge on evaluation criteria or the option space is too ambiguous:
- Strategy summarizes the disagreement and open questions
- Escalate to the human with a focused clarifying question
