---
name: boardroom
description: Full-team debate producing a decision record with dissenting opinions
agents:
  [
    {
      "agent": "research",
      "role": "analyst",
      "responsibility": "Present data and evidence to ground the discussion",
      "canInitiate": true
    },
    {
      "agent": "strategy",
      "role": "facilitator",
      "responsibility": "Moderate the debate, synthesize positions, and draft the decision record",
      "canInitiate": true
    },
    {
      "agent": "critic",
      "role": "opposition",
      "responsibility": "Challenge proposals, argue counter-positions, ensure rigorous deliberation",
      "canInitiate": true
    },
    {
      "agent": "finance",
      "role": "treasurer",
      "responsibility": "Evaluate financial implications, ROI, and resource constraints",
      "canInitiate": true
    },
    {
      "agent": "content",
      "role": "communicator",
      "responsibility": "Consider messaging, user impact, and communication strategy",
      "canInitiate": true
    },
    {
      "agent": "dev",
      "role": "engineer",
      "responsibility": "Assess technical feasibility, implementation complexity, and engineering trade-offs",
      "canInitiate": true
    }
  ]
protocol:
  {
    "pattern": "debate",
    "maxTurns": 12,
    "coordinator": "strategy",
    "requiresApproval": false,
    "conflictResolution": "majority-vote"
  }
triggers: ["boardroom", "board meeting", "full team debate", "decision record"]
minAgents: 4
timeoutSeconds: 600
---

## Objective

Conduct a structured multi-round debate on a significant decision. Produce a formal decision record that captures the majority position, dissenting opinions, and the rationale behind the final call.

## Agent Roles

- **research** (analyst): Grounds the debate in evidence. Presents data, benchmarks, and prior examples relevant to the decision.
- **strategy** (facilitator): Moderates the debate. Ensures each perspective is heard, manages round progression, and drafts the final decision record.
- **critic** (opposition): Actively challenges proposals. Argues the strongest counter-position to stress-test the group's reasoning.
- **finance** (treasurer): Evaluates every option through a financial lens — cost, ROI, runway impact, resource allocation.
- **content** (communicator): Considers how the decision affects users, public perception, and internal communications.
- **dev** (engineer): Assesses technical feasibility, estimates implementation effort, and flags engineering risks or dependencies.

## Interaction Flow

1. Strategy frames the decision and opens the floor
2. Each specialist presents their initial position (round 1)
3. Agents respond to each other's positions, challenging and refining (round 2)
4. Critic delivers a structured rebuttal of the leading proposal
5. Final round: each agent states their updated position
6. Strategy synthesizes into a decision record with dissent noted

## Completion Criteria

- All 6 agents have contributed at least one substantive position
- At least 2 rounds of debate have occurred
- A clear decision is recorded with supporting rationale
- Any dissenting opinions are documented with their reasoning
- Financial and technical feasibility are explicitly addressed

## Escalation

If the debate reaches maxTurns without convergence:
- Strategy drafts a split-decision record showing the two strongest positions
- Both positions are presented to the human for a tiebreaker
- The dissent record is preserved regardless of the final decision
