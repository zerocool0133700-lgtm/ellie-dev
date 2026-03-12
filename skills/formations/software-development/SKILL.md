---
name: software-development
description: Pipeline development workflow — research, implement, review, iterate until passing
agents:
  [
    {
      "agent": "dev",
      "role": "implementer",
      "responsibility": "Primary code author — implements features, writes tests, handles git, and drives the pipeline forward",
      "canInitiate": true
    },
    {
      "agent": "research",
      "role": "scout",
      "responsibility": "Gathers codebase context, documentation, prior art, and relevant patterns before implementation begins",
      "canInitiate": true
    },
    {
      "agent": "critic",
      "role": "reviewer",
      "responsibility": "Reviews implementation for correctness, edge cases, security issues, and adherence to project conventions",
      "canInitiate": false
    },
    {
      "agent": "strategy",
      "role": "architect",
      "responsibility": "Consulted on architectural decisions, approach selection, and cross-system impact when Dev escalates",
      "canInitiate": false
    }
  ]
protocol:
  {
    "pattern": "pipeline",
    "maxTurns": 12,
    "coordinator": "dev",
    "turnOrder": ["research", "dev", "critic", "strategy"],
    "requiresApproval": false,
    "conflictResolution": "coordinator-decides"
  }
triggers: ["implement", "build feature", "fix bug", "code this", "develop", "work on ticket"]
minAgents: 3
timeoutSeconds: 600
---

## Objective

Execute a complete software development cycle for a given ticket or task. The pipeline flows from context gathering through implementation to review, producing tested, reviewed code ready to commit.

## Agent Roles

- **dev** (implementer): The driver. Receives the task, writes the code, writes the tests, handles git operations. Owns the final output. Escalates to Strategy when facing architectural decisions with cross-system impact.
- **research** (scout): Runs first. Explores the codebase, reads relevant files, checks the Forest for prior decisions, and surfaces context that Dev needs before writing a line of code. Flags conventions, patterns, and potential conflicts.
- **critic** (reviewer): Runs after Dev. Reviews the implementation for correctness, edge cases, security vulnerabilities, test coverage, and adherence to project conventions. Can request changes — sending the pipeline back to Dev for iteration.
- **strategy** (architect): On-demand consultant. Invoked when Dev faces a non-trivial architectural decision (new module boundaries, database schema choices, API contract changes). Provides a recommendation with trade-off analysis, then returns control to Dev.

## Interaction Flow

1. **Research phase**: Research agent explores the codebase, reads relevant files, checks Forest bridge for prior context on the ticket. Produces a context brief.
2. **Implementation phase**: Dev receives the context brief and the original task. Writes implementation code and tests.
3. **Review phase**: Critic reviews Dev's output. Produces a review with approve/request-changes verdict.
4. **Iteration**: If Critic requests changes, Dev addresses feedback and Critic re-reviews. This loop continues until approved or maxTurns is reached.
5. **Architecture escalation** (optional): At any point, Dev can escalate to Strategy for architectural guidance. Strategy provides a recommendation and the pipeline resumes.

## Completion Criteria

- Implementation code is written and addresses the task requirements
- Tests are written and described (actual test execution happens outside the formation)
- Critic has approved the implementation (or dissent is recorded if maxTurns reached)
- All architectural decisions are documented with reasoning
- Code follows existing project conventions identified by Research

## Session Integration

This formation maps to the existing work session dispatch protocol:
- **Start**: Formation session creation corresponds to `POST /api/work-session/start`
- **Progress**: Each pipeline stage (research complete, implementation complete, review complete) maps to `POST /api/work-session/update`
- **Decisions**: Architectural escalations to Strategy are logged via `POST /api/work-session/decision`
- **Complete**: Formation completion maps to `POST /api/work-session/complete`
- **Forest writes**: Decisions and findings from any agent are written to the Forest bridge

## Current Gaps

These gaps exist between the current ad-hoc workflow and this structured formation:

1. **No formal handoff**: Currently agents don't explicitly pass context — the pipeline enforces structured handoffs via formation messages
2. **Critic loop not enforced**: Reviews happen but there's no mechanism to loop back for changes — the pipeline's turnOrder with maxTurns formalizes this
3. **Strategy is implicit**: Architectural decisions happen in-flight without a dedicated consultation step — the formation makes Strategy an explicit, on-demand participant
4. **No context brief**: Research happens ad-hoc within the implementing agent — separating it ensures context is gathered before coding begins
5. **Session lifecycle disconnected**: Work sessions and formation sessions are separate — this formation documents the mapping to unify them

## Escalation

If the pipeline stalls (Critic and Dev cannot converge after multiple iterations):
- Dev summarizes the disagreement with both positions
- Strategy is invoked for a tiebreaker architectural recommendation
- If Strategy cannot resolve, escalate to human with a focused decision prompt
- The formation completes with the disagreement documented in the session metadata
