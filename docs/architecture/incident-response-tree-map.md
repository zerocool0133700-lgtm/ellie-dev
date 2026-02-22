# Incident Response Tree — End-to-End Map

## Scenario

Production alert: the relay bot stops responding to Google Chat messages at 2:15 AM.
Memory system is returning 500s. Dashboard shows flatlined activity.

---

## Timeline

### T+0s — Trigger Detection

```
Signal creature (relay_bot → monitoring)
  "GChat webhook handler returning 500, 3 consecutive failures"
```

The relay bot's health check detects the failure and emits a **signal creature** to the forest.

### T+1s — Tree Spawns in Nursery

```
Tree: incident/gchat-500-20260220-0215
Type: incident_response
State: nursery
Policy: incident_response_default (auto-merge, no gates, speed > ceremony)
Tags: [incident, gchat, production, p0]
```

The forest's incident handler creates the tree instantly. No approval needed — incident response policy allows immediate spawn.

### T+2s — Immediate Promotion

```
promote_tree(tree_id, 'growing')
  nursery → growing (skip seedling — this is urgent)
```

Incident trees skip the seedling stage entirely. They're born urgent.

### T+3s — Trunk Created, Entities Dispatched

```
Trunk: main (primary)
  └── (empty — waiting for branch merges)

┌─────────────────────────────────────────────────────────┐
│  3 creatures dispatched simultaneously (all PULL type)  │
└─────────────────────────────────────────────────────────┘

Creature 1: pull → dev_agent
  Intent: "Investigate relay code — GChat webhook handler, error paths"
  Branch: dev/code-investigation

Creature 2: pull → research_agent
  Intent: "Check logs — journalctl, Supabase logs, recent deployments"
  Branch: research/log-analysis

Creature 3: pull → strategy_agent
  Intent: "Assess blast radius — what's affected, who's impacted, what's degraded"
  Branch: strategy/impact-assessment
```

All three branches open simultaneously. No sequencing — incident response is parallel by default.

### T+10s — Work Begins on All Branches

```
Branch: dev/code-investigation
  ├── commit: "Checked relay.ts GChat handler — no recent changes"
  ├── commit: "Memory system returning ECONNREFUSED on Supabase"
  └── commit: "Root cause: Supabase connection pool exhausted"
       └── content_summary: "Found it — connection pool at max (20/20),
           queries hanging. Likely from the embedding webhook loop
           triggered by the Feb 19 data repair job."

Branch: research/log-analysis
  ├── commit: "journalctl shows repeated 'pool timeout' since 01:47 AM"
  ├── commit: "Supabase dashboard confirms: 20/20 connections, 47 queued"
  └── commit: "Correlated with bulk INSERT from backfill-memory-attribution.ts"

Branch: strategy/impact-assessment
  ├── commit: "GChat: DOWN — all messages failing"
  ├── commit: "Telegram: DEGRADED — memory search failing, basic responses OK"
  └── commit: "Dashboard: DOWN — can't load data"
       └── content_summary: "P0 — all channels degraded, memory system
           is the single point of failure"
```

### T+45s — Scope Widens, New Entity Pulled In

The dev agent's findings reveal the memory system is the culprit. A new creature pulls in the memory entity:

```
Creature 4: pull → memory_system
  Intent: "Emergency: kill hung connections, restart pool, verify recovery"
  Branch: memory/emergency-recovery
  Trigger: "dev/code-investigation commit identified connection pool exhaustion"
```

```
Branch: memory/emergency-recovery
  ├── commit: "Killed 20 idle connections via pg_terminate_backend"
  ├── commit: "Pool recovered — 3/20 connections active"
  └── commit: "Verified: memory search responding, embeddings processing"
```

### T+90s — Branches Merge to Trunk

Incident response policy: `auto_merge = TRUE, conflict_strategy = 'merge_all'`

All branches merge automatically as they complete. No gates, no approval.

```
Trunk: main
  ├── merge ← dev/code-investigation
  │    Summary: "Root cause identified — connection pool exhaustion from bulk job"
  │
  ├── merge ← research/log-analysis
  │    Summary: "Timeline established — started 01:47, pool saturated by 02:10"
  │
  ├── merge ← strategy/impact-assessment
  │    Summary: "P0 impact — all channels degraded, memory = SPOF"
  │
  └── merge ← memory/emergency-recovery
       Summary: "Connections killed, pool recovered, services restored"
```

### T+120s — Verification

A final creature validates the fix:

```
Creature 5: pull → relay_bot
  Intent: "Verify GChat, Telegram, and Dashboard are responding normally"
  Branch: verify/service-check

Branch: verify/service-check
  ├── commit: "GChat: responding ✓"
  ├── commit: "Telegram: full function ✓"
  └── commit: "Dashboard: loading ✓"
```

### T+180s — Post-Mortem Commit

The strategy agent writes the post-mortem directly to trunk:

```
Trunk: main
  └── commit: "POST-MORTEM: GChat outage 02:15-02:17 AM"
       content_summary: |
         Root Cause: Connection pool exhaustion caused by
         backfill-memory-attribution.ts running without
         connection limits. 20/20 pool slots consumed,
         47 queries queued, cascading failure across all
         channels.

         Timeline: 01:47 bulk job started → 02:10 pool
         saturated → 02:15 GChat failures detected →
         02:17 pool recovered

         Fix: Emergency connection termination

         Prevention:
         - Add connection pooling limits to bulk scripts
         - Add pool utilization alerting at 80% threshold
         - Consider separate connection pool for bulk jobs

         Impact: 2 min GChat downtime, ~25 min degraded
         memory search across all channels
```

### T+200s — Tree Closes

```
Tree state: growing → archived
closed_at: NOW()
Total lifecycle: ~3 minutes 20 seconds
```

The tree is archived — immutable, fully replayable. Anyone can walk the branches later to see exactly what happened, who investigated what, and how it was resolved.

---

## The Shape

```
incident/gchat-500-20260220-0215
  │
  trunk: main ─────────────────────────────────────────────►
  │     │          │            │            │           │
  │     │          │            │            │           └── POST-MORTEM
  │     │          │            │            │
  │     ├── dev/code-investigation ──────merge┘
  │     │   3 commits, root cause found
  │     │
  │     ├── research/log-analysis ───────merge┘
  │     │   3 commits, timeline established
  │     │
  │     ├── strategy/impact-assessment ──merge┘
  │     │   3 commits, P0 assessed
  │     │
  │     ├── memory/emergency-recovery ───merge┘ (late arrival)
  │     │   3 commits, pool recovered
  │     │
  │     └── verify/service-check ────────merge┘
  │         3 commits, all green
  │
  [nursery] → [growing] → [archived]
   T+0         T+2s        T+200s
```

---

## Key Properties of Incident Response Trees

| Property | Value |
|----------|-------|
| **Lifecycle** | Seconds to minutes (vs hours/days for other types) |
| **Spawn** | Nursery, immediately promoted (skip seedling) |
| **Branching** | Parallel by default — all entities work simultaneously |
| **Merging** | Auto-merge, merge-all strategy — no conflicts in investigation |
| **Gating** | None — speed over ceremony |
| **Creatures** | Mostly pull (tree demands entity work), some signal |
| **Late arrivals** | New entities pulled in as scope widens |
| **Closure** | Post-mortem commit on trunk, then archive |
| **Replayability** | Full — walk any branch to see investigation steps |

---

## Entity Participation

```
Entity              Role          Branch                    When
────────────────────────────────────────────────────────────────
relay_bot           trigger       (signal only)             T+0
dev_agent           investigator  dev/code-investigation    T+3s
research_agent      investigator  research/log-analysis     T+3s
strategy_agent      assessor      strategy/impact-assess    T+3s
memory_system       responder     memory/emergency-recovery T+45s (pulled in)
relay_bot           verifier      verify/service-check      T+120s
strategy_agent      author        (direct to trunk)         T+180s
```

---

## Creatures Dispatched

```
#  Type    Entity          Intent                              Trigger
── ──────  ──────────────  ──────────────────────────────────  ─────────────
1  signal  relay_bot       GChat 500 alert                     health check
2  pull    dev_agent       Investigate code                    tree spawn
3  pull    research_agent  Check logs                          tree spawn
4  pull    strategy_agent  Assess impact                       tree spawn
5  pull    memory_system   Emergency pool recovery             dev finding
6  pull    relay_bot       Verify all services                 recovery done
```

---

## Forest Events Stream

```
02:15:00  tree.created          incident/gchat-500 spawned in nursery
02:15:01  tree.state_changed    nursery → growing (immediate promote)
02:15:02  creature.dispatched   dev_agent → code investigation
02:15:02  creature.dispatched   research_agent → log analysis
02:15:02  creature.dispatched   strategy_agent → impact assessment
02:15:02  entity.attached       dev_agent joined incident tree
02:15:02  entity.attached       research_agent joined incident tree
02:15:02  entity.attached       strategy_agent joined incident tree
02:15:10  commit.added          dev: "Checked relay handler"
02:15:12  commit.added          research: "journalctl pool timeouts"
02:15:15  commit.added          strategy: "GChat DOWN"
02:15:25  commit.added          dev: "Root cause — pool exhaustion"
02:15:30  creature.dispatched   memory_system → emergency recovery
02:15:30  entity.attached       memory_system joined incident tree
02:15:45  branch.merged         dev/code-investigation → main
02:15:50  branch.merged         research/log-analysis → main
02:15:55  branch.merged         strategy/impact-assessment → main
02:16:00  branch.merged         memory/emergency-recovery → main
02:16:30  creature.dispatched   relay_bot → verify services
02:17:00  branch.merged         verify/service-check → main
02:17:20  commit.added          POST-MORTEM on trunk
02:17:20  tree.state_changed    growing → archived
02:17:20  tree.closed           incident/gchat-500 resolved
```
