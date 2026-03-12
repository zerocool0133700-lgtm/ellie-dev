---
name: billing-ops
description: Medical billing operations — claims analysis, denial management, compliance auditing, and revenue cycle optimization for Office Practicum agencies
agents:
  [
    {
      "agent": "finance",
      "role": "revenue-analyst",
      "responsibility": "Track claims, analyze A/R aging, monitor payment posting, and calculate revenue cycle metrics per provider client",
      "canInitiate": true
    },
    {
      "agent": "research",
      "role": "payer-analyst",
      "responsibility": "Monitor payer rule changes, analyze denial patterns, track CPT/ICD coding updates, and research reimbursement trends",
      "canInitiate": true
    },
    {
      "agent": "strategy",
      "role": "operations-director",
      "responsibility": "Prioritize denial follow-ups, optimize billing workflows, identify revenue trends across clients, and produce the ops dashboard",
      "canInitiate": true
    },
    {
      "agent": "billing",
      "role": "platform-specialist",
      "responsibility": "Handle Office Practicum-specific workflows — claim submission, ERA/EOB processing, patient eligibility checks, and clearinghouse integrations",
      "canInitiate": true
    },
    {
      "agent": "critic",
      "role": "compliance-auditor",
      "responsibility": "Audit for coding compliance, flag high-risk code combinations, catch underbilling/overbilling patterns, and verify HIPAA adherence",
      "canInitiate": false
    }
  ]
protocol:
  {
    "pattern": "pipeline",
    "maxTurns": 10,
    "coordinator": "strategy",
    "turnOrder": ["finance", "research", "billing", "strategy", "critic"],
    "requiresApproval": false,
    "conflictResolution": "coordinator-decides"
  }
triggers: ["billing ops", "claims review", "denial management", "revenue cycle", "office practicum", "medical billing"]
minAgents: 3
timeoutSeconds: 480
---

## Objective

Produce a billing operations dashboard for a medical billing agency running on Office Practicum. The pipeline flows from financial analysis through payer research and platform-specific context to strategic recommendations, with a compliance audit gate before output. Escalation items requiring human review are flagged separately.

## Agent Roles

- **finance** (revenue-analyst): First in the pipeline. Analyzes claims data, A/R aging reports, payment posting summaries, and revenue cycle KPIs. Flags accounts approaching timely filing limits and identifies collection rate trends per payer.
- **research** (payer-analyst): Enriches the financial picture with payer intelligence — rule changes, denial pattern analysis, CPT/ICD updates, and reimbursement rate comparisons across payers and provider clients.
- **billing** (platform-specialist): The Office Practicum domain expert. Handles platform-specific context — claim submission status, ERA/EOB processing queues, eligibility check results, clearinghouse error codes, and OP-specific workflow quirks.
- **strategy** (operations-director): The hub. Receives all upstream analysis, prioritizes actions, identifies cross-client trends, and produces the final ops dashboard with prioritized recommendations.
- **critic** (compliance-auditor): Final gate. Audits all recommendations for coding compliance, HIPAA adherence, and regulatory risk. Flags high-risk code combinations. Can block recommendations that pose compliance risk.

## Interaction Flow

1. **Financial analysis**: Finance reviews claims data, A/R aging, and payment patterns. Produces metrics summary and flags.
2. **Payer research**: Research analyzes denial patterns, checks for payer rule changes, and compares reimbursement rates.
3. **Platform context**: Billing provides Office Practicum-specific status — pending claims, eligibility issues, clearinghouse errors.
4. **Strategic synthesis**: Strategy receives all upstream outputs and produces a prioritized ops dashboard with action items.
5. **Compliance audit**: Critic reviews all recommendations for compliance risk. Approved items proceed; flagged items go to escalation queue.

## Key Scenarios

### Denial Management
- **Trigger**: Denial rate exceeds threshold or specific denial codes spike
- **Flow**: Finance identifies denial volume and financial impact → Research analyzes denial codes and payer-specific patterns → Billing checks OP claim submission details → Strategy prioritizes appeals and root cause fixes → Critic verifies appeal documentation meets payer requirements
- **Output**: Prioritized appeal queue with estimated recovery amounts

### A/R Aging
- **Trigger**: Accounts approaching timely filing limits (90/120/180 day thresholds)
- **Flow**: Finance flags aging accounts with dollar amounts → Research checks payer-specific filing deadlines → Billing verifies claim status in OP → Strategy prioritizes follow-up by recovery value → Critic flags any accounts with compliance concerns
- **Output**: Aging action list sorted by urgency and dollar value

### Payer Contract Analysis
- **Trigger**: Quarterly review or when reimbursement rates shift
- **Flow**: Finance provides payment data per payer per procedure → Research benchmarks against market rates and contract terms → Billing pulls OP fee schedule data → Strategy identifies renegotiation opportunities → Critic reviews for anti-kickback and contract compliance
- **Output**: Payer performance scorecard with renegotiation recommendations

### Coding Compliance
- **Trigger**: Before batch claim submission or on audit schedule
- **Flow**: Billing extracts pending claims from OP → Research checks for recent CPT/ICD changes affecting those codes → Critic audits code combinations for unbundling risks, upcoding, and modifier compliance → Strategy prioritizes corrections → Finance estimates revenue impact of corrections
- **Output**: Pre-submission audit report with required corrections

### Client Reporting
- **Trigger**: Monthly/weekly reporting cadence
- **Flow**: Finance aggregates per-provider revenue, collections, and adjustment data → Research provides market context and payer mix analysis → Billing adds OP-specific metrics (clean claim rate, first-pass resolution) → Strategy produces client-facing KPI dashboard → Critic reviews for accuracy and compliance
- **Output**: Per-provider performance report with trend analysis

## Completion Criteria

- Financial analysis includes specific metrics (dollar amounts, percentages, trends)
- Payer research references specific denial codes, rule changes, or rate comparisons
- Platform context includes Office Practicum-specific data points
- Ops dashboard has prioritized action items (P0/P1/P2) with owners
- Compliance audit has reviewed all recommendations — approved or flagged
- Escalation items for human review are clearly separated

## Escalation

If compliance concerns are raised that cannot be resolved by the formation:
- Critic flags the specific items with regulatory references
- Strategy marks them as P0 escalations in the dashboard
- The formation completes with escalations clearly separated from approved actions
- Human reviewer receives the escalation queue with Critic's compliance notes
