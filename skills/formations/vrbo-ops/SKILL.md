---
name: vrbo-ops
description: VRBO operations coordination — financial analysis, listing optimization, and guest management
agents:
  [
    {
      "agent": "finance",
      "role": "financial-analyst",
      "responsibility": "Analyze revenue, expenses, pricing strategy, and profitability per property",
      "canInitiate": true
    },
    {
      "agent": "content",
      "role": "listing-manager",
      "responsibility": "Optimize listing descriptions, photos strategy, and guest-facing communications",
      "canInitiate": true
    },
    {
      "agent": "research",
      "role": "market-analyst",
      "responsibility": "Research comparable listings, market trends, seasonal demand, and competitor pricing",
      "canInitiate": true
    },
    {
      "agent": "strategy",
      "role": "operations-coordinator",
      "responsibility": "Coordinate all agents, delegate tasks, prioritize actions, and produce the operational dashboard",
      "canInitiate": true
    },
    {
      "agent": "vrbo",
      "role": "domain-specialist",
      "responsibility": "Handle VRBO-specific platform rules, guest reviews, booking policies, and property management tasks",
      "canInitiate": true
    }
  ]
protocol:
  {
    "pattern": "coordinator",
    "maxTurns": 10,
    "coordinator": "strategy",
    "requiresApproval": false,
    "conflictResolution": "coordinator-decides"
  }
triggers: ["vrbo", "vacation rental", "property ops", "listing optimization", "vrbo ops"]
minAgents: 3
timeoutSeconds: 480
---

## Objective

Produce an operational dashboard for VRBO property management. Strategy delegates specific analysis tasks to each specialist, collects their outputs, and synthesizes a prioritized action plan with escalations for items requiring human decision.

## Agent Roles

- **finance** (financial-analyst): Runs the numbers — revenue tracking, expense analysis, pricing optimization, and profitability reports per property.
- **content** (listing-manager): Optimizes guest-facing content — listing titles, descriptions, photo sequencing, and review response templates.
- **research** (market-analyst): Provides market intelligence — comparable listings, seasonal demand curves, competitor pricing, and occupancy benchmarks.
- **strategy** (operations-coordinator): The hub. Delegates tasks to specialists, collects outputs, resolves conflicts, and produces the final operational dashboard.
- **vrbo** (domain-specialist): Platform expert — handles VRBO-specific booking rules, review management, calendar optimization, and property compliance.

## Interaction Flow

1. Strategy receives the operational query and decomposes it into delegated tasks
2. Each specialist receives their specific assignment and produces a focused analysis
3. Strategy collects all outputs and identifies conflicts or gaps
4. If conflicts exist, Strategy requests targeted follow-ups from relevant agents
5. Strategy produces the final operational dashboard with prioritized actions

## Completion Criteria

- Each delegated task has a completed output from the assigned specialist
- Financial projections include specific numbers or ranges
- Market research references comparable properties or data points
- An operational dashboard is produced with:
  - Prioritized action items (P0/P1/P2)
  - Owner assigned to each action
  - Escalations clearly flagged for human review
- Strategy has resolved or documented any inter-agent conflicts

## Escalation

If a specialist cannot complete their delegated task (missing data, ambiguous scope):
- Strategy notes the gap and flags it as a P0 escalation
- The operational dashboard is delivered with the gap clearly marked
- Human is asked to provide the missing information for a follow-up run
