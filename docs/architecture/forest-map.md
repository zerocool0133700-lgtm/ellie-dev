# The Ellie Forest — Visual Map

> Text-based visualization of the forest architecture. Paste sections into Miro as needed.

**Multi-Tenant Architecture:** This system is designed for multiple users and workspaces. Every tree, entity, and creature is tenant-scoped. One Ellie instance serves many users with full data isolation via Postgres row-level security (RLS).

---

## Layer 1: The Forest (All Active Trees)

```
+===========================================================================+
|                          THE ELLIE FOREST                                  |
|                                                                            |
|   seedling       mature        growing       growing        nursery        |
|  +----------+  +-----------+  +----------+  +----------+  +-----------+   |
|  | Forest   |  | Ellie     |  | GChat    |  | Telegram |  | ELLIE-86  |   |
|  | Arch     |  | Platform  |  | Conv     |  | Conv     |  | Email     |   |
|  | PROJECT  |  | PROJECT   |  | CONVO    |  | CONVO    |  | WORK SESS |   |
|  +----------+  +-----------+  +----------+  +----------+  +-----------+   |
|                                                                            |
|   growing       growing        nursery       nursery       seedling        |
|  +----------+  +----------+  +-----------+  +----------+  +-----------+   |
|  | ELLIE-83 |  | ELLIE-73 |  | ELLIE-85  |  | ELLIE-84 |  | Memory    |   |
|  | GChat Fix|  | SIGTERM  |  | Data Fix  |  | Dispatch |  | Quality   |   |
|  | WORK SESS|  | WORK SESS|  | WORK SESS |  | WORK SESS|  | REVIEW    |   |
|  +----------+  +----------+  +-----------+  +----------+  +-----------+   |
|                                                                            |
|   nursery                                                                  |
|  +-----------+                                                             |
|  | Email     |                                                             |
|  | Unify     |                                                             |
|  | WORKFLOW  |                                                             |
|  +-----------+                                                             |
+===========================================================================+
```

---

## Layer 2: Tree Internals — Trunk & Branch Structure

### Single-Trunk Trees (most trees)

```
Conversation Tree (GChat)                 Work Session Tree (ELLIE-83)
==========================                ============================

        [main] <-- trunk                          [main] <-- trunk
           |                                         |
    msg msg msg msg                           commit commit commit
           |                                         |
     +-----+------+                            +-----+-----+
     |             |                            |           |
  [dev-agent]  [research]   <-- branches     [dev]      [critic]
     |             |                            |           |
  commits      commits                       commits    review
     |             |                            |           |
  merge back   merge back                   merge back  merge back
```

### Multi-Trunk Trees (projects)

```
Forest Architecture (PROJECT)                 Ellie Platform (PROJECT)
=================================             ================================

  [main]            [develop]                 [ellie-dev]      [ellie-home]
  (primary)         (active)                  (primary)        (frontend)
     |                  |                         |                 |
  stable            WIP work                  backend           frontend
  decisions         prototyping               relay, agents     dashboard, UI
     |                  |                     memory, voice     exec plans
     |            +-----+-----+                   |                 |
     |            |           |              +----+----+       +---+---+
     |         [research]  [dev]             |         |       |       |
     |            |           |           [dev]   [memory]  [dash]  [exec]
     |         analysis    impl              |         |       |       |
     |            |           |           commits   commits  commits commits
     |         merge       merge              |         |       |       |
     +<-----------+-----------+               +----+----+       +---+---+
                                                   |                 |
                                              merge to trunk    merge to trunk
```

---

## Layer 3: Entities — Who Works in the Forest

```
+------------------+-------------------+-------------------+-------------------+
|     AGENTS       |    SERVICES       |   INTEGRATIONS    |   STORES/UI       |
+------------------+-------------------+-------------------+-------------------+
|                  |                   |                   |                   |
| Dev Agent        | Relay Bot         | Calendar          | Memory System     |
| [one_tree]       | [all_trees]       | [many_trees]      | [all_trees]       |
| src/agents/dev   | src/relay.ts      | (ellie-home)      | src/memory.ts     |
|                  |                   |                   |                   |
| Research Agent   | Agent Router      | GitHub            | Dashboard UI      |
| [many_trees]     | [all_trees]       | [many_trees]      | [many_trees]      |
| src/agents/      | src/agent-        | (ellie-home)      | (ellie-home)      |
| research         | router.ts         |                   |                   |
|                  |                   |                   |                   |
| Finance Agent    | Voice System      | Gmail             | Execution Plans   |
| [one_tree]       | [many_trees]      | [many_trees]      | [many_trees]      |
| src/agents/      | src/              | (ellie-home)      | (ellie-home)      |
| finance          | transcribe.ts     |                   |                   |
|                  |                   +-------------------+-------------------+
| Strategy Agent   | Work Sessions     |
| [many_trees]     | [many_trees]      |   CONTRIBUTION PATTERNS:
| src/agents/      | src/api/          |   all_trees  = shared resource (memory, relay, router)
| strategy         | work-session.ts   |   many_trees = multi-tasker (research, strategy, voice)
|                  |                   |   one_tree   = specialist (dev, finance, content)
| Content Agent    +-------------------+
| [one_tree]       |
| src/agents/      |
| content          |
|                  |
| Critic Agent     |
| [many_trees]     |
| src/agents/      |
| critic           |
|                  |
| General Agent    |
| [all_trees]      |
| src/agents/      |
| general          |
+------------------+
```

---

## Forest Creatures — Orchestration Patterns

```
PULL (Tree requests work)          PUSH (Entity discovers work)
=============================      ==============================

  Tree: "I need dev help"            Entity: "I have relevant data"
        |                                    |
        v                                    v
  +--[creature]--+                   +--[creature]--+
  | type: pull   |                   | type: push   |
  | intent: ...  |                   | intent: ...  |
  | state: ...   |                   | state: ...   |
  +------+-------+                   +------+-------+
         |                                  |
         v                                  v
  Entity works on branch             Entity contributes to tree
  Commits -> Merges back             Opens branch -> Commits -> Merges


SIGNAL (Notification only)         SYNC (Bidirectional)
=============================      ==============================

  "FYI: 100+ msgs today"            Entity <----> Tree
        |                              |            |
        v                           state        state
  +--[creature]--+                 synced       synced
  | type: signal |                 both ways    both ways
  | no work      |
  | just aware   |
  +------+-------+
         |
    (no branch created)
```

---

## Tree Lifecycle — The Growth Cycle

```
                    LIFECYCLE PROGRESSION
  ================================================================

  NURSERY          SEEDLING        GROWING         MATURE
  (ephemeral)      (persisted)     (active)        (stable)
  +--------+       +--------+      +--------+      +--------+
  | Ideas  |  -->  | Schema |  --> | Active |  --> | Stable |
  | Proto  |       | Saved  |      | Work   |      | Runs   |
  | Temp   |       | In DB  |      | Commits|      | Less   |
  +--------+       +--------+      +--------+      +--------+
       |                                                 |
       |                                                 v
       |                                            DORMANT
       |                                            +--------+
       |                                            | Paused |
       |                                            | May    |
       |                                            | Resume |
       |                                            +--------+
       |                                                 |
       v                                                 v
  COMPOSTED                                         ARCHIVED
  +--------+                                        +--------+
  | Soft   |                                        | Closed |
  | Delete |                                        | Read-  |
  | Purge  |                                        | Only   |
  +--------+                                        +--------+


  CURRENT FOREST STATE:
  ---------------------
  nursery:   ELLIE-86, ELLIE-85, ELLIE-84, Email Unify Workflow
  seedling:  Forest Architecture, Memory Quality Review
  growing:   GChat Conv, Telegram Conv, ELLIE-83, ELLIE-73
  mature:    Ellie Platform
```

---

## Contribution Policies — Rules of the Forest

```
+--------------------+---------+---------+----------+-----------+----------+
| Policy             | Convo   | WorkSess| Workflow | Project   | Review   |
+--------------------+---------+---------+----------+-----------+----------+
| Max branches/entity| 3       | 5       | 10       | 10        | 3        |
| Require approval   | No      | No      | No       | No        | No       |
| Auto-merge         | Yes     | Yes     | Yes      | NO        | Yes      |
| Conflict strategy  | Last    | Last    | Merge    | Manual    | Merge    |
|                    | Writer  | Writer  | All      |           | All      |
+--------------------+---------+---------+----------+-----------+----------+
```

---

## Entity-to-Tree Map — Who's Where

```
                    GChat  Tele-  Forest  Ellie   83   73   86   Mem   Email
                    Conv   gram   Arch    Plat    Fix  SIG  Mail Rev   Unify
                    -----  -----  ------  -----  ---- ---- ---- ----  -----
Memory System        *      *      *       *       *    *
Dev Agent            *      *      *       *       *    *    *
Research Agent       *      *      *              *     *
General Agent        *      *
Strategy Agent       *             *
Relay Bot            *      *              *       *
Agent Router         *      *              *
Voice System                *              *
Critic Agent                       o              o               *
Work Sessions                              *
Dashboard UI                       o       *
Execution Plans                            *
Calendar                                   *
GitHub                                     *
Gmail                                      *              *

  * = contributor    o = observer
```

---

## Data Model — Table Relationships

```
  +------------+       +----------+       +-----------+
  | entities   |       | trees    |       | policies  |
  | (17 total) |       | (11 now) |       | (6 rules) |
  +-----+------+       +----+-----+       +-----------+
        |                    |
        |    +---------------+---------------+
        |    |               |               |
        v    v               v               v
  +-------------+     +----------+     +----------+
  | tree_       |     | trunks   |     | forest_  |
  | entities    |     | (1-N per |     | events   |
  | (29 maps)   |     |  tree)   |     | (14 init)|
  +-------------+     +----+-----+     +----------+
                            |
                            v
                      +----------+
                      | branches |
                      | (entity  |
                      |  work)   |
                      +----+-----+
                           |
                           v
                      +----------+
                      | commits  |
                      | (work    |
                      |  steps)  |
                      +----------+

  Orchestration:
  +------------+
  | creatures  |     pull / push / signal / sync
  | (5 sample) |     coordinates entity <-> tree work
  +------------+
```
