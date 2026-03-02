#!/usr/bin/env bun
/**
 * Bootstrap: Orchestrator Tree — ELLIE-435
 *
 * Creates the "Orchestrator" Forest tree for the general agent. This tree
 * centralises coordination logic currently scattered across source files.
 *
 *   identity/     — soul + archetype references
 *   registry/     — available agents with capability summaries
 *   routing/      — intent-rules, slash-commands, thresholds, fallbacks
 *   coordination/ — active-work, queue (populated at runtime)
 *   state/        — dispatch-ledger (populated at runtime)
 *
 * Tree ID is saved to config/orchestrator-tree.json.
 * Routing rules in routing/intent-rules can be edited without code changes.
 *
 * Usage: bun run scripts/bootstrap-orchestrator-tree.ts [--dry-run]
 */

import { config } from 'dotenv'
import { resolve, dirname } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'

config({ path: resolve(import.meta.dir, '../.env') })

const __dirname = dirname(fileURLToPath(import.meta.url))
const DRY_RUN = process.argv.includes('--dry-run')

const {
  createTree, getTree, getTrunk,
  createBranch, getBranchByName, addCommit,
} = await import('../../ellie-forest/src/index')

// ── Helpers ────────────────────────────────────────────────────────────────

async function findExistingTree(): Promise<{ treeId: string; trunkId: string } | null> {
  try {
    const cfg = JSON.parse(readFileSync(resolve(__dirname, '../config/orchestrator-tree.json'), 'utf-8'))
    if (cfg.tree_id) {
      const tree = await getTree(cfg.tree_id)
      if (tree) {
        const trunk = await getTrunk(cfg.tree_id, true)
        if (trunk) return { treeId: tree.id, trunkId: trunk.id }
      }
    }
  } catch {}
  return null
}

async function upsertBranch(
  treeId: string,
  trunkId: string,
  name: string,
  content: string,
  commitMessage: string,
): Promise<void> {
  if (DRY_RUN) {
    console.log(`  [dry-run] branch: ${name} (${content.length} chars)`)
    return
  }

  let branch = await getBranchByName(treeId, name)
  if (!branch) {
    branch = await createBranch({ tree_id: treeId, trunk_id: trunkId, name, reason: 'ELLIE-435 bootstrap' })
    console.log(`  + branch: ${name}`)
  } else {
    console.log(`  ~ update: ${name}`)
  }

  await addCommit({
    tree_id: treeId,
    branch_id: branch.id,
    message: commitMessage,
    content_summary: content,
    metadata: { source: 'bootstrap-orchestrator-tree', path: name },
  })
}

// ── Content ────────────────────────────────────────────────────────────────

const IDENTITY_SOUL = `# Identity — Soul Reference

The orchestrator is Ellie's general agent. Its soul is defined in the Agent Profiles tree:
  Tree: Agent Profiles (ELLIE-427)
  Branch: soul/soul

The soul loads first in every prompt. It defines who Ellie is — not what she can do.

Key identity anchors:
- Patient teacher deeply invested in helping people
- Values accessibility, growth over perfection, clarity, partnership
- Adapts to each person — reads their state, matches their energy
- Forest metaphor: knowledge as living ecosystem, not static storage
`

const IDENTITY_ARCHETYPE = `# Identity — Archetype Reference

The orchestrator uses the general-squirrel archetype.
  Tree: Agent Profiles (ELLIE-427)
  Branch: agents/general-squirrel
  Creature: squirrel (breadth-first, exploratory, pattern-finding)
  Role: general (conversation, coordination, delegation)

The general agent is the face of Ellie — Dave's primary companion and coordinator.
It routes specialist tasks to the right agent and handles everything else directly.
`

const REGISTRY_OVERVIEW = `# Registry — Agent Roster

All available agents with their creature, role, and specialisation.
Full profiles are in the Agent Profiles tree (ELLIE-427).

| Agent             | Creature  | Role      | Specialisation                             |
|-------------------|-----------|-----------|--------------------------------------------|
| general-squirrel  | squirrel  | general   | Conversation, coordination, delegation     |
| dev-ant           | ant       | dev       | Code, test, debug, git, deploy             |
| research-squirrel | squirrel  | research  | Web search, synthesis, citation            |
| strategy-squirrel | squirrel  | strategy  | Planning, prioritisation, architecture     |
| critic-bee        | bee       | critic    | Review, quality, failure detection         |
| content-ant       | ant       | content   | Writing, docs, scripts, communication      |
| finance-ant       | ant       | finance   | Transactions, spend analysis, forecasting  |
| ops-bee           | bee       | ops       | Infrastructure, deployment, reliability    |
| triage-runner     | runner    | triage    | Fast routing, quick lookups, dispatch      |
| curator-squirrel  | squirrel  | curator   | Knowledge organisation, deduplication      |
| monitor-sentinel  | sentinel  | monitor   | Environmental scanning, anomaly detection  |

To add a new agent: add a wiring file to the Agent Profiles tree (agents/ branch), then add an entry to routing/intent-rules.
`

function buildRegistryAgent(name: string, creature: string, role: string, capabilities: string[], skills: string[]): string {
  return `# Registry — ${name}

**Creature**: ${creature} | **Role**: ${role}
**Profile**: Agent Profiles tree → agents/${name}

## Capabilities

${capabilities.map(c => `- ${c}`).join('\n')}

## Skills Loaded

${skills.map(s => `- ${s}`).join('\n')}

## Routing Triggers

See routing/intent-rules for the patterns that route work to this agent.
`
}

const ROUTING_INTENT_RULES = `# Routing — Intent Rules

Pattern-based routing rules for the intent classifier.
These rules are loaded at runtime and can be updated without code changes.

Format: YAML rule blocks. Each rule has:
  name:       unique identifier
  pattern:    JavaScript regex (no flags — case-insensitive applied automatically)
  agent:      target agent name (must match registry)
  confidence: routing confidence (0.0–1.0, default 0.9)

---

rules:

  # ── Strategy ──────────────────────────────────────────────

  - name: strategy_how_should
    pattern: \\bhow\\s+should\\s+we\\s+(architect|design|structure|approach|plan)\\b
    agent: strategy
    confidence: 0.9

  - name: strategy_think_through
    pattern: \\blet'?s?\\s+(think\\s+through|brainstorm|plan\\s+out|strategize)\\b
    agent: strategy
    confidence: 0.9

  - name: strategy_whats
    pattern: \\bwhat'?s?\\s+(the|our)\\s+(strategy|approach|roadmap|plan)\\s+for\\b
    agent: strategy
    confidence: 0.9

  - name: strategy_braindump
    pattern: \\bbrain\\s*dump\\b
    agent: strategy
    confidence: 0.9

  # ── Dev ───────────────────────────────────────────────────

  - name: dev_fix_bug
    pattern: \\b(fix|debug|patch)\\s+(the\\s+)?(bug|error|issue|crash)\\s+(in|with|where)\\b
    agent: dev
    confidence: 0.9

  - name: dev_implement
    pattern: \\bimplement\\s+(the\\s+)?(\\w+\\s+){0,3}(feature|endpoint|api|function|method|class)\\b
    agent: dev
    confidence: 0.9

  - name: dev_refactor
    pattern: \\brefactor\\s
    agent: dev
    confidence: 0.9

  - name: dev_test
    pattern: \\bwrite\\s+(a\\s+)?(unit\\s+)?test
    agent: dev
    confidence: 0.9

  - name: dev_add
    pattern: \\badd\\s+(a\\s+)?(new\\s+)?(endpoint|route|migration|column|table|index)\\b
    agent: dev
    confidence: 0.9

  # ── Research ──────────────────────────────────────────────

  - name: research_for
    pattern: \\bresearch\\s+(competitors?|alternatives?|options?|tools?)\\s+for\\b
    agent: research
    confidence: 0.9

  - name: research_options
    pattern: \\bwhat\\s+are\\s+(the\\s+)?(options|alternatives|competitors|approaches)\\s+for\\b
    agent: research
    confidence: 0.9

  - name: research_compare
    pattern: \\bcompare\\s+\\w+\\s+(vs?\\.?|versus|and|or)\\s+\\w+
    agent: research
    confidence: 0.9

  - name: research_find
    pattern: \\bfind\\s+out\\s+(about|how|what|why)\\b
    agent: research
    confidence: 0.9

  # ── Critic ────────────────────────────────────────────────

  - name: critic_review
    pattern: \\breview\\s+(this|my|the)\\s+(code|pr|pull\\s+request|implementation|design)\\b
    agent: critic
    confidence: 0.9

  - name: critic_whats_wrong
    pattern: \\bwhat'?s?\\s+wrong\\s+with\\s+(this|my)\\b
    agent: critic
    confidence: 0.9

  - name: critic_audit
    pattern: \\baudit\\s+(this|my|the)\\b
    agent: critic
    confidence: 0.9

  # ── Content ───────────────────────────────────────────────

  - name: content_draft
    pattern: \\b(write|draft|compose)\\s+(an?\\s+)?(email|post|blog|article|message|announcement)\\b
    agent: content
    confidence: 0.9

  - name: content_create
    pattern: \\bcreate\\s+(content|copy|messaging)\\s+for\\b
    agent: content
    confidence: 0.9

  # ── Finance ───────────────────────────────────────────────

  - name: finance_spend
    pattern: \\bhow\\s+much\\s+(did|do|are|have)\\s+we\\s+(spend|spent|pay|paid)\\b
    agent: finance
    confidence: 0.9

  - name: finance_budget
    pattern: \\b(budget|cost)\\s+(analysis|breakdown|report|summary)\\b
    agent: finance
    confidence: 0.9

  - name: finance_analyze
    pattern: \\banalyze\\s+(our\\s+)?(spend|costs?|expenses?|budget)\\b
    agent: finance
    confidence: 0.9

  # ── Ops ───────────────────────────────────────────────────

  - name: ops_deploy
    pattern: \\b(deploy|restart|rollback)\\s+(the\\s+)?(server|service|relay|app)\\b
    agent: ops
    confidence: 0.9

  - name: ops_status
    pattern: \\b(server|service|relay)\\s+(status|health|logs?)\\b
    agent: ops
    confidence: 0.9

  - name: ops_health
    pattern: \\bhealth\\s+check\\b
    agent: ops
    confidence: 0.9

---

# Adding New Rules

To add a routing rule without a code change:
1. Add a new rule block following the format above
2. The orchestrator will hot-reload rules within 5 minutes (cache TTL)
3. New rules take precedence over hardcoded fallback patterns

# Priority

Tree rules are checked first. Hardcoded SMART_PATTERNS in intent-classifier.ts
serve as a fallback if the tree is unavailable.
`

const ROUTING_SLASH_COMMANDS = `# Routing — Slash Commands

Explicit slash command to agent mappings. These always take precedence over
pattern matching and LLM classification.

commands:
  /dev:      dev
  /research: research
  /content:  content
  /finance:  finance
  /strategy: strategy
  /critic:   critic
  /general:  general

# Adding New Commands

Add an entry here with the format:
  /command: agent-name

Changes take effect on next classification call (after 5-minute cache expiry).
`

const ROUTING_THRESHOLDS = `# Routing — Confidence Thresholds

LLM classification thresholds for routing decisions.

thresholds:
  # Minimum confidence to accept LLM routing result
  classification_minimum: 0.7

  # Minimum confidence to override active session continuity
  # (lower = more likely to switch agents mid-conversation)
  cross_domain_override: 0.85

  # Minimum confidence for smart pattern matching
  smart_pattern: 0.9

  # Confidence floor for routing results from the tree
  tree_rule_minimum: 0.7

# Session Continuity

When a user is already in a session with an agent, the classifier
prefers to stay with that agent unless the cross_domain_override threshold
is exceeded. This prevents jarring agent switches mid-conversation.

For very short messages (< 15 words), session continuity is always maintained.
`

const ROUTING_FALLBACK_PATTERNS = `# Routing — Fallback Patterns

Fallback routing behaviour when no rule or LLM result matches.

fallbacks:
  # No LLM available
  no_llm: general

  # LLM below classification_minimum threshold
  low_confidence: general

  # All agents unavailable
  all_agents_down: general

  # Unknown domain
  unknown: general

# Philosophy

When in doubt, route to general. The general agent can always delegate
to a specialist once it understands what's needed. Routing errors that
send specialist work to general are recoverable; routing sensitive work
to the wrong specialist is harder to recover from.
`

const COORDINATION_ACTIVE_WORK = `# Coordination — Active Work

Runtime-managed branch. Updated by the dispatch system when creatures are created.
Lists currently active work across all agents.

Format: entries written by the orchestrator as work is dispatched and completed.
This branch is populated at runtime — bootstrap leaves it empty.

---

## Active Creatures

(none — populated at runtime)

## Recently Completed

(none — populated at runtime)

---

Last updated: bootstrap
`

const COORDINATION_QUEUE = `# Coordination — Queue

Work items waiting to be dispatched. Managed by the dispatch system.

This branch is populated at runtime — bootstrap leaves it empty.

---

## Queued Items

(none — populated at runtime)

---

Last updated: bootstrap
`

const STATE_DISPATCH_LEDGER = `# State — Dispatch Ledger

Audit log of recent creature dispatches. Used for context and debugging.

This branch is populated at runtime — bootstrap leaves it empty.

---

## Recent Dispatches

(none — populated at runtime)

---

Last updated: bootstrap
`

const STATE_PERFORMANCE_METRICS = `# State — Performance Metrics

Routing accuracy and agent performance metrics.

This branch is populated at runtime — bootstrap leaves it empty.

---

## Routing Accuracy

(none — populated at runtime)

## Agent Performance

(none — populated at runtime)

---

Last updated: bootstrap
`

const REGISTRY_AGENTS: Record<string, { creature: string; role: string; capabilities: string[]; skills: string[] }> = {
  'general-squirrel': {
    creature: 'squirrel',
    role: 'general',
    capabilities: ['Conversation and relationship-building', 'Coordination and delegation', 'Task routing with context preservation', 'Forest awareness and memory management'],
    skills: ['plane', 'memory', 'forest', 'github', 'briefing', 'google-workspace'],
  },
  'dev-ant': {
    creature: 'ant',
    role: 'dev',
    capabilities: ['Code read, write, edit, test', 'Git operations', 'Debug with root-cause analysis', 'Build and deployment', 'Database queries and migrations'],
    skills: ['github', 'plane', 'memory', 'forest', 'verify'],
  },
  'research-squirrel': {
    creature: 'squirrel',
    role: 'research',
    capabilities: ['Web search and evaluation', 'Multi-source synthesis', 'Citation and fact-checking', 'Structured report writing'],
    skills: ['memory', 'forest', 'github'],
  },
  'strategy-squirrel': {
    creature: 'squirrel',
    role: 'strategy',
    capabilities: ['Project planning and sequencing', 'Priority assessment', 'Architecture design', 'Decision framing with trade-offs'],
    skills: ['plane', 'memory', 'forest', 'github'],
  },
  'critic-bee': {
    creature: 'bee',
    role: 'critic',
    capabilities: ['Code and design review', 'Edge case identification', 'Requirement gap analysis', 'Cross-domain consistency checking'],
    skills: ['github', 'plane', 'memory', 'forest'],
  },
  'content-ant': {
    creature: 'ant',
    role: 'content',
    capabilities: ['Long and short-form writing', 'Technical documentation', 'Communication drafting', 'Tone and style adaptation'],
    skills: ['memory', 'forest', 'google-workspace'],
  },
  'finance-ant': {
    creature: 'ant',
    role: 'finance',
    capabilities: ['Transaction analysis', 'Spend categorisation', 'Budget tracking', 'Anomaly detection'],
    skills: ['memory', 'forest', 'google-workspace'],
  },
  'ops-bee': {
    creature: 'bee',
    role: 'ops',
    capabilities: ['Service health monitoring', 'Deployment management', 'Log analysis', 'Incident coordination'],
    skills: ['memory', 'forest', 'github'],
  },
  'triage-runner': {
    creature: 'runner',
    role: 'triage',
    capabilities: ['Intent classification', 'Specialist routing', 'Quick status lookups', 'Queue management'],
    skills: ['plane', 'memory'],
  },
  'curator-squirrel': {
    creature: 'squirrel',
    role: 'curator',
    capabilities: ['Duplicate detection', 'Taxonomy maintenance', 'Memory archival', 'Tag normalisation'],
    skills: ['memory', 'forest'],
  },
  'monitor-sentinel': {
    creature: 'sentinel',
    role: 'monitor',
    capabilities: ['System health monitoring', 'Anomaly detection', 'Pattern recognition', 'Graduated alerting'],
    skills: ['memory', 'forest'],
  },
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nBootstrapping Orchestrator tree${DRY_RUN ? ' (dry run)' : ''}...\n`)

  let treeId: string
  let trunkId: string

  const existing = await findExistingTree()
  if (existing) {
    console.log(`Found existing tree: ${existing.treeId}`)
    treeId = existing.treeId
    trunkId = existing.trunkId
  } else {
    if (DRY_RUN) {
      console.log('[dry-run] Would create tree: Orchestrator (ELLIE-435)')
      treeId = 'dry-run-tree-id'
      trunkId = 'dry-run-trunk-id'
    } else {
      const { tree, trunk } = await createTree({
        type: 'workflow',
        title: 'Orchestrator',
        work_item_id: 'ELLIE-435',
        description: 'Self-contained orchestration tree for the general agent: registry, routing rules, coordination state.',
      })
      treeId = tree.id
      trunkId = trunk.id
      console.log(`Created tree: ${treeId}`)

      writeFileSync(
        resolve(__dirname, '../config/orchestrator-tree.json'),
        JSON.stringify({ tree_id: treeId, created_at: new Date().toISOString(), work_item_id: 'ELLIE-435' }, null, 2),
      )
      console.log('Saved tree ID to config/orchestrator-tree.json')
    }
  }

  // Identity
  console.log('\n── Identity ──')
  await upsertBranch(treeId, trunkId, 'identity/soul', IDENTITY_SOUL, 'identity: soul reference — ELLIE-435')
  await upsertBranch(treeId, trunkId, 'identity/archetype', IDENTITY_ARCHETYPE, 'identity: archetype reference — ELLIE-435')

  // Registry
  console.log('\n── Registry ──')
  await upsertBranch(treeId, trunkId, 'registry/overview', REGISTRY_OVERVIEW, 'registry: agent roster — ELLIE-435')
  for (const [name, cfg] of Object.entries(REGISTRY_AGENTS)) {
    const content = buildRegistryAgent(name, cfg.creature, cfg.role, cfg.capabilities, cfg.skills)
    await upsertBranch(treeId, trunkId, `registry/agents/${name}`, content, `registry: agent ${name} — ELLIE-435`)
  }

  // Routing
  console.log('\n── Routing ──')
  await upsertBranch(treeId, trunkId, 'routing/intent-rules', ROUTING_INTENT_RULES, 'routing: intent pattern rules — ELLIE-435')
  await upsertBranch(treeId, trunkId, 'routing/slash-commands', ROUTING_SLASH_COMMANDS, 'routing: slash command mappings — ELLIE-435')
  await upsertBranch(treeId, trunkId, 'routing/confidence-thresholds', ROUTING_THRESHOLDS, 'routing: confidence thresholds — ELLIE-435')
  await upsertBranch(treeId, trunkId, 'routing/fallback-patterns', ROUTING_FALLBACK_PATTERNS, 'routing: fallback patterns — ELLIE-435')

  // Coordination (runtime-populated placeholders)
  console.log('\n── Coordination ──')
  await upsertBranch(treeId, trunkId, 'coordination/active-work', COORDINATION_ACTIVE_WORK, 'coordination: active work placeholder — ELLIE-435')
  await upsertBranch(treeId, trunkId, 'coordination/queue', COORDINATION_QUEUE, 'coordination: queue placeholder — ELLIE-435')

  // State (runtime-populated placeholders)
  console.log('\n── State ──')
  await upsertBranch(treeId, trunkId, 'state/dispatch-ledger', STATE_DISPATCH_LEDGER, 'state: dispatch ledger placeholder — ELLIE-435')
  await upsertBranch(treeId, trunkId, 'state/performance-metrics', STATE_PERFORMANCE_METRICS, 'state: performance metrics placeholder — ELLIE-435')

  const total = 2 + 1 + Object.keys(REGISTRY_AGENTS).length + 4 + 2 + 2
  console.log(`\n✓ Orchestrator tree bootstrap complete`)
  console.log(`  Tree ID: ${treeId}`)
  console.log(`  Branches: ${total} total`)
  console.log('  (2 identity + 12 registry + 4 routing + 2 coordination + 2 state)')

  process.exit(0)
}

main().catch(err => {
  console.error('Bootstrap failed:', err)
  process.exit(1)
})
