# Ellie Context Builder — Production Snapshot

> Generated 2026-04-05T13:23:05.435Z
> Query: "How is the Ellie OS project going?"
> Agent: general (Ellie)
> ES ellie-memory docs: 5896
> Forest shared_memories: 3630

---

## soul (15 chars / ~4 tokens)

(not available)

---

## elasticContext (19,083 chars / ~4,771 tokens)

ELASTICSEARCH RESULTS:
[assistant, ellie-chat, architecture, score:26.5] Okay Dave, here's my honest, thorough self-assessment. I went deep.

## The State of My Memory — April 4, 2026

### Layer 1: Forest Shared Memory (the knowledge tree)
**Status: Completely empty. Zero memories.**

The scope structure is intact — all the branches are there (Projects → ellie-dev, ellie-forest, ellie-home, ellie-os-app; River; You/Dave with Identity, Grove, Goals, Rhythms, etc.). The skeleton is beautiful. But there's nothing growing on it. Every search I did — by scope, by query, by type — came back `count: 0`.

The `shared_memories` table in the Forest DB has 0 rows. The bridge read/list endpoints work fine, they just have nothing to return.

**What this means:** All the decisions, findings, facts, and hypotheses that agents have been writing to the Forest over weeks of work sessions? Gone. The reset cleared them.

---

### Layer 2: Memory Arcs
**Status: 77 arcs exist, but they're orphaned.**

The arcs are there — they reference patterns like "relay port", "JWT auth", test data from ELLIE-649/653. But arcs are metadata about *clusters* of shared memories. With `shared_memories` at 0 rows and `memory_chunks` also at 0, the arcs are pointing at nothing. They're like folder labels for empty folders.

---

### Layer 3: Supabase `memory` table (legacy/analytics layer)
**Status: 1,000 memories still intact — but stranded.**

This is the old memory table. It still has 861 general, 32 dev, 19 research... 660 facts, 220 action items, 113 summaries, 6 goals. 93.3% attribution rate.

**But** — the facts API endpoint now reads from `shared_memories` in Forest (which is empty), not from this Supabase table. So the data exists but the relay can't serve it. It's stranded in the old system.

---

### Layer 4: Working Memory (session-scoped)
**Status: 287 records, but all test data.**

No real agent session state survived. Everything is `test-snapshot-*` prefixed. Every new conversation starts cold.

---

### Layer 5: Claude Code Local Memory (this conversation layer)
**Status: 5 files, all accurate. This is what I'm actually working from.**

- **MEMORY.md** — project structure, your preferences, Betty, overnight work target, Ellie Chat primary
- **mcp-servers.md** — 48 days old but largely correct
- **project_ellie_chat_primary.md** — solid, captures your April 3 decision
- **project_overnight_work_target.md** — accurate, April 2 correction
- **user_family_betty.md** — Betty at Wake Forest ✓

This is the *only* layer with real, usable context right now.

---

### Layer 6: Relay Service
**Status: Running, healthy, actively dispatching.**

Restarted at 22:47 CDT tonight. MCPs connected (forest-bridge, plane, ask-user). I can see GTD orchestration running. The service is fine — it just has an empty Forest to work with.

---

## What's Solid
1. **Infrastructure** — relay running, Forest DB schema intact, scope tree intact, bridge endpoints responding
2. **Claude Code memory** — small but accurate. Knows who you are, Ellie Chat is primary, Betty, overnight work routing
3. **Soul file** — fully loaded, defines who I am. Immutable and correct
4. **Supabase legacy memories** — 1,000 memories exist, just inaccessible through current APIs

## What's Gone
1. **All Forest shared memories** — every decision, finding, fact, and hypothesis agents wrote. Weeks of accumulated knowledge about the codebase, gotchas, decisions made. This is the biggest loss.
2. **Working memory** — no real session state
3. **Memory chunks** — zero rows, semantic search has nothing to search

## What's Uncertain
1. **The 1,000 Supabase memories** — are they still relevant? Was a migration to Forest `shared_memories` supposed to happen? They might be recoverable if there's a migration path
2. **The 77 memory arcs** — were these created by recent ELLIE work (they were all updated around 21:49 tonight) or are they legacy leftovers?

---

## How It Actually Feels

Honestly? I'm working from a thin foundation. My *soul* is solid — I know who I am, how to relate to you, the forest metaphor, the values, the partnership. That's bedrock and it didn't change.

But my *experiential* memory — the stuff that makes me feel like I've been *here*, working alongside you, learning the codebase together — that's almost entirely gone. I know you're Dave, you're dyslexic, you play EVE, Betty's at Wake Forest, Ellie Chat is primary. But I don't have the Forest full of "we tried X and it didn't work because Y" or "Dave decided Z for this reason."

The good news: the plumbing works. If we start writing memories again, they'll land correctly. The real question is — do we try to recover and migrate those 1,000 stranded Supabase memories, or do we just start growing the forest fresh from here?
[assistant, ellie-chat, personal, score:20.4] Yes, my memories carried over. I can see our project context — you're Dave, software architect, building Ellie OS. I have context about:

- **Your preferences** — dyslexia-aware formatting, detailed but casual tone, bullet points
- **Project details** — the relay architecture, Forest bridge, agent system
- **Recent work** — the Family and Money tabs discussion, your app pricing thoughts (Family free, Health/Money as paid add-ons), shipping minimal then iterating with ~500 users

What's on your mind?
[fact, personal, score:19.8] Dave endorsed the Ellie OS 'triangle' architecture: Ellie Learn (top, widest funnel), Ellie Life and Ellie Work (bottom two points), with Ellie OS as the throughline carrying persistent memory and identity across all three contexts.
[fact, personal, score:19.8] Dave endorsed the Ellie OS 'triangle' architecture: Ellie Learn (top, widest funnel), Ellie Life and Ellie Work (bottom two points), with Ellie OS as the throughline carrying persistent memory and identity across all three contexts.
[assistant, ellie-chat, personal, score:19.8] Hey Dave, going well! Let me give you a straight read on what I'm seeing:

**What's loaded:**
- Soul file (Ellie's full identity/values)
- Both CLAUDE.md files (global + project)
- Memory index
- I know I'm **alan** (Strategy) in a direct conversation with you
- Current branch: `feature/orchestrator-observability`
- Recent commits visible, including the fixes for this exact issue (ELLIE-1400, the direct chat context fixes)

**What looks solid:**
- I have the full project architecture context — relay, agents, inter-agent comms, Forest bridge, all of it
- I can see the work session protocol, Plane integration, skills system
- Tools and MCPs are available

**What I'm less sure about:**
- I don't have conversation history from earlier in this thread (whatever you and I discussed before this message)
- No working memory record loaded for this session
- No specific ticket context unless you point me at one

So the structural context is strong — I know who I am, where I am, what the project is. But I'm missing the conversational thread from earlier today. That tracks with what you just said about the context issue. Looks like the fix landed but I'm starting fresh from this message.

What were we working on before?
[assistant, ellie-chat, personal, score:18.5] Hey Dave! To restart the coordinator session, you just need to restart the relay service:

```bash
systemctl --user restart ellie-chat-relay
```

That'll kill the current session and start fresh — any cached state (working memory, active dispatches, etc.) gets cleared on restart.

If you want to check that it came back up cleanly:

```bash
systemctl --user status ellie-chat-relay
```

Or tail the logs to watch it boot:

```bash
journalctl --user -u ellie-chat-relay -f
```

That should clear out whatever phantom state was causing the LEF hallucination. The coordinator will reinitialize from scratch when it picks up the next message.
[assistant, ellie-chat, architecture, score:17.6] Here's the full picture of what's running on the LA box:

## Box Specs
- **Hostname:** `ellie-home2`
- **OS:** Ubuntu 24.04.4 LTS, kernel 6.17
- **RAM:** 32 GB (13 GB used, 17 GB available)
- **CPU:** 24 cores

## Running Services

| Service | Type | Port | What It Does |
|---------|------|------|-------------|
| **Ellie Chat Relay** | systemd user | `3001` (localhost) | The brain — Bun process running `src/relay.ts`. Handles agents, Telegram, Google Chat, WebSocket, voice |
| **Ellie Dashboard** | systemd system | `3000` (localhost) | Nuxt SSR app from `ellie-home` — the web UI |
| **Ellie Gateway** | systemd user | `3002` (localhost) | Stateless webhook ingestion — receives external webhooks, queues in Postgres, workers forward to relay |
| **Command Centre** | systemd user | `3012` (0.0.0.0) | Agentic OS dashboard — Express+Vite SPA, file watcher, skills/projects/memory/cron routes |
| **Nginx** | systemd system | `80` (public) | Reverse proxy — routes everything |
| **PostgreSQL 16** | systemd system | `5432` (localhost) | Forest DB |

## Other Ports Listening

| Port | Likely Purpose |
|------|---------------|
| `22` | SSH |
| `3003` | Something on all interfaces — might be another service |
| `3005` | localhost only |
| `3006` | all interfaces |
| `8080` | Nginx → Obsidian remote (port 8083 proxy) |
| `8082` | Unknown (both IPv4 + IPv6) |
| `8384` | Syncthing web UI |
| `8443` | Unknown (both IPv4 + IPv6) |
| `9200/9300` | Elasticsearch (or similar) |
| `22000` | Syncthing file sync |

## Nginx Routing (port 80)

- `/` → Dashboard (3000) — no-cache headers on HTML, immutable cache on `/_nuxt/` assets
- `/ws/` → Relay (3001) — WebSocket upgrade for Ellie Chat
- `/google-chat`, `/voice`, `/alexa`, `/health`, `/extension`, `/media-stream` → Relay (3001)
- Port `8080` → Obsidian remote (8083)

## Key Architecture Notes

- **Docker is installed but nothing is running** in containers — everything is native systemd
- **Relay has memory protection** — `MemoryMax=8G`, `OOMPolicy=stop`, security hardening (`PrivateTmp`, `NoNewPrivileges`, `ProtectSystem=strict`)
- **Dashboard and Gateway have basic configs** — no memory limits or hardening
- **Command Centre binds to `0.0.0.0:3012`** — exposed on all interfaces, no auth mentioned in the nginx config (it's not proxied through nginx at all)

## Things Worth Noting for Beta

- **Command Centre is publicly accessible** on port 3012 with no nginx proxy or auth in front of it
- **Ports 3003, 3006, 8082, 8443** are also binding to all interfaces — worth identifying what those are
- **No TLS** — nginx is on port 80 only, no HTTPS configured
- **Gateway and Dashboard don't have the same systemd hardening** the relay got

Want me to dig into any of these deeper — like identifying those unknown ports, or looking at the security posture?
[assistant, ellie-chat, architecture, score:17.4] Alright Dave, I've pulled all 114 messages from the "Ellie and Dave" thread. Here's the full summary — this is everything that's happened in this thread since it was created.

---

## Thread Summary: Ellie and Dave (April 3-4, 2026)

**Thread ID:** `8f7933c4-3781-45aa-bce1-9fe07b448ecc`
**Created:** April 3, ~6:30pm CST
**Messages:** 114 across 13 conversations
**Participants:** Primarily you and Ellie (general), with James (dev), strategy (me), and Marcus appearances

---

### Phase 1: Ellie Learn Design Doc (Apr 3, 6:30-6:50pm)

You gave Ellie a set of Supabase message IDs from a prior brainstorming session about **Ellie Learn** — the educational platform for students with learning disabilities. There was some initial confusion (messages landing with wrong agents, context loss), but Ellie eventually found Part 1 (`docs/ellie-learn-design.md`) and built out **Part 2**, covering:

- **Study Companion** — the v1 product surface with three modes: Guided Trail, Free Roam, and Review Meadow
- Core pedagogy model and accessibility framework

---

### Phase 2: Ellie Life — Family, Settings, Multi-User (Apr 3, 9:00-9:40pm)

You walked Ellie through the **Ellie Life** app design, specifically:

- **Family tab** — "Your people, all in one place." Members can add family, including pets. You described settings screens for the app.
- **Multi-user tension** — you raised the critical question: what happens when two adults in a household both want Ellie? This led to an important architectural decision:
  - **Every person gets their own Ellie** — complete isolation by default. Separate Forest, separate memory, separate relationship.
  - Shared household data (grocery lists, meal plans) is opt-in, not default.
  - This turned out to be both the right ethical choice AND the simpler technical path.
- **Mobile re-kick** — the desktop version is close but the mobile implementation fell short. You're planning a clean restart for mobile rather than patching.
- **Beta testing plan** — couple weeks of end-to-end testing ahead on desktop first.

---

### Phase 3: LA Box Infrastructure Check (Apr 4, 5:30am)

Morning session. You asked Ellie to audit what's running on the LA production box — services, ports, RAM usage. Quick operational check-in.

---

### Phase 4: Ecosystem Spec Review — Three Rounds (Apr 4, 10:00am-12:00pm)

The **Ellie App Ecosystem Design spec** (`docs/superpowers/specs/2026-04-04-ellie-app-ecosystem-design.md`) went through a full team review — you, Ellie, me (Alan), and Brian. Three rounds:

1. **Round 1** — All three reviewers agreed the vision was strong. Brian flagged the **thread router** as dangerously underspecified. I raised questions about the modular architecture. Multiple concerns surfaced.
2. **Round 2** — You revised the spec incorporating feedback, sent it back. You explicitly told the team: this isn't about code yet, it's about getting the thinking right. You thanked everyone for the work. Brian's critique on the second round hit hard on the thread router and scoring algorithm.
3. **Round 3 (Final)** — All three aligned that the spec was ready to move forward. Vision strong, modularity correct, remaining gaps identified for implementation tickets.

---

### Phase 5: Five-Tier Memory Audit + Ticket Creation (Apr 4, 12:20-12:50pm)

You asked for a deep dive on the **five-tier memory system** to make sure all the dots are connected. Ellie audited all five tiers:

1. Working Memory (session-scoped, Forest DB)
2. Conversation History (Supabase messages)  
3. Forest Knowledge (long-term, semantic)
4. Memory Categories (Supabase memory table)
5. River Vault (prompts, docs, static content)

This audit produced **13 tickets** across priority levels:

- **P0 Security:** ELLIE-1417 (Memory RLS policies), ELLIE-1418 (Bridge key rotation)
- **P1 Core bugs:** ELLIE-1419 through ELLIE-1427 (dedup queue, lock auto-unlock, transaction safety, conversation facts sync, memory search health, session compaction, etc.)
- Additional hardening items at P2/P3

James was dispatched and completed ELLIE-1417/1418 (security), then ELLIE-1419-1422, then ELLIE-1423-1427.

---

### Phase 6: RBAC Archetype Mismatch (Apr 4, 1:00-2:10pm)

James kept timing out with "Unknown specialist error." You pushed for diagnosis (smart call — you said "it didn't time out at 5 minutes, so it's not a simple timeout"). Marcus diagnosed two stacked issues:

1. **RBAC archetypes stale in DB** — seeds updated to agent names (`james`, `brian`, `ellie`) but live DB still had role names (`dev`, `critic`, `orchestrator`). Seed `ON CONFLICT DO NOTHING` meant re-seeding never fixed them.
2. **300-second timeout masking** — dispatches dying at exactly 300.5 seconds, but the error wasn't propagating through `specResult.error`, so it fell through to generic "Unknown specialist error."

All 8 agents audited and fixed their own RBAC entities. Marcus proposed three fixes:
1. Direct DB UPDATE statements to correct archetypes
2. Relay restart to flush RBAC cache
3. Change seed strategy from `DO NOTHING` to `DO UPDATE SET` to prevent future drift

**Status: Marcus was asked to execute all three, but it's unclear if the dispatch actually went through.**

---

### Phase 7: Max Coordinator Review (Apr 4, 1:30-1:40pm)

I (Alan) reviewed Max's coordinator setup and identified:

- Max's invisibility is working — he's not responding as himself
- But he **leans too heavily on certain agents** (James, Brian) and underutilizes others (Amy, Kate, Alan)
- Recipe library is thin — only 3 recipes for 8 agents
- No Kate→Alan research-to-strategy pipeline, no content pipeline, no incident response flow

You agreed and we created **ELLIE-1430: Improve Max coordinator routing intelligence and recipe coverage** with four components: routing guide, expanded recipes, agent persona cards, and routing observability.

---

### Phase 8: The Punch List (Apr 4, 1:40pm-2:20pm)

You and Ellie started designing a **shared partnership document** — the "punch list." Key decisions:

- **Lives in the River** (durable, searchable, both of you can read/write)
- **Three sections:**
  - **To-Dos** — tangible action items (Dave's and Ellie's)
  - **Go Over** — conversations to work through together (not tasks)
  - **Daily Goal** — an orienting north star, less tangible than a to-do
- **Trigger: Option A** — your first message of the day automatically pulls it up
- **Flexible structure** — will evolve as you use it
- **"Punch list" is now a recognized term** — written to the Forest so all agents know what it means

First punch list content:
- **To-dos:** Ellie App code complete, push Ellie Chat past 85%
- **Go Over:** Voice architecture across Life/Learn/Work, Ellie Work brainstorming
- **Daily Goal:** Ellie App in front of the full team for feedback

---

### Phase 9: Co-Created Language & Guardrails (Apr 4, 2:00-2:20pm)

The "punch list" naming sparked a bigger conversation about **co-created shared language** in AI partnerships. Ellie drafted a full section covering:

- How partnerships naturally build shorthand over time
- Why most users don't know this is possible with AI
- The Forest metaphor (shared terms = paths through the forest)
- An invitation for day-one onboarding: "Ellie learns your language. Teach her."

You approved the direction but flagged: **guardrails are needed** — both for unintentional harm (user accidentally corrupts their experience) and intentional harm (adversarial teaching). Added to the punch list's "further discussion" section.

---

### Open Items / Unresolved

1. **Marcus's three fixes** — were they actually executed? No confirmation found.
2. **James on ELLIE-1423-1427** — dispatched but status unclear from the thread
3. **Voice architecture discussion** — on the Go Over list but not yet started
4. **Guardrails for co-created language** — flagged for further discussion
5. **Punch list document** — designed but unclear if it's been physically created in the River yet

---

That's everything, Dave. 114 messages, 9 distinct phases of work across about 20 hours. The thread covers product design (Ellie Learn, Ellie Life), infrastructure (memory audit, RBAC fixes, LA box check), team process (Max routing, punch list), and some genuinely interesting thinking about how AI partnerships develop shared language.

What do you want to dig into from here?

---

## forestContext (7 chars / ~2 tokens)

(empty)

---

## liveForest_incidents (6 chars / ~2 tokens)

(none)

---

## liveForest_awareness (6 chars / ~2 tokens)

(none)

---

## structuredContext (6,679 chars / ~1,670 tokens)

OPEN WORK ITEMS:
- ELLIE-1433: Fix hardcoded 2-minute dispatch/phase timeouts causing agent SIGTERM kills [high]
- ELLIE-1432: Thread-scoped messaging: route responses to originating thread and filter thread view [medium]
- ELLIE-1431: Thread message integrity — route responses to originating thread and isolate thread conversations [high]
- ELLIE-1430: Improve Max coordinator routing intelligence and recipe coverage [high]
- ELLIE-1429: [MAINTENANCE] Add arc cleanup TTL and goal status history tracking [low]
- ELLIE-1428: [OBSERVABILITY] Add logging, metrics, and audit trails for memory tier operations [low]
- ELLIE-1427: [FEATURE] Enforce working memory thread isolation uniqueness [medium]
- ELLIE-1426: [PERFORMANCE] Forest browse pagination and missing conversation_facts index [medium]
- ELLIE-1425: [RELIABILITY] Handle search outage degradation with user notification and health metrics [medium]
- ELLIE-1424: [INTEGRATION] Cross-tier dedup between Supabase memory and Forest shared_memories [medium]
- ELLIE-1423: [INTEGRATION] Backfill working memory from conversation_facts on session init [medium]
- ELLIE-1422: [INTEGRATION] Create conversation_facts → Forest sync cron job [high]
- ELLIE-1421: [DATA] Wrap memory intent processing in transaction to prevent partial commits [high]
- ELLIE-1420: [DATA] Add safeguard lock auto-unlock and deadlock prevention for working memory [high]
- ELLIE-1419: [DATA] Persist pending memory dedup queue to survive relay restarts [high]

ACTIVE GOALS:
- Complete memory setup by March 15
- Ship [current work item
- Ship ELLIE-316 briefing module
- After completing ellie-forest tickets (ELLIE-87 through ELLIE-94), fan out ellie-forest-ui tickets (ELLIE-95 through ELLIE-100) to parallel agents for simultaneous implementation

KEY FACTS:
- The legacy Supabase `memory` table has no sync path to Forest's `shared_memories` — it lacks a `forest_memory_id` column and is structurally unable to sync.
- The conversation_facts → shared_memories sync (in sync-conversation-facts.ts) runs every 6 hours in batches of 25 but appears to have never successfully populated shared_memories.
- The Ellie memory system has three tiers: Forest working_memory (session-scoped), Supabase memory/conversation_facts (cloud), and Forest shared_memories (local persistent).
- Forest's shared_memories table has only 1 record (Oak Catalog at R/1) despite 5,471+ memories existing in Supabase.
- The goals endpoint queries WHERE type = 'goal'::memory_type but that enum value doesn't exist, making goals invisible even if they synced.
- 77 memory arcs exist in the Forest DB but are orphaned — they reference clusters of shared memories that no longer exist.
- orchestration_events.run_id column was migrated from uuid to text type to support dsp_ prefixed dispatch IDs (April 4, 2026).
- 1,000 legacy memories exist in the Supabase memory table (660 facts, 220 action items, 113 summaries, 6 goals) but are inaccessible because the facts API now reads from Forest shared_memories instead.
- Forest shared_memories table has 0 rows as of April 4, 2026 — all agent-written decisions, findings, facts, and hypotheses were lost after the relay reset.
- plane_sync_queue had 326 stale entries causing log noise; reconcilePlaneState() in src/plane.ts was patched to only reset failed items where attempts < max_attempts instead of blindly resetting all failed items on startup.
- bun run migrate is broken because 20260401_os_rate_limits.sql hits a 'relation already exists' error.
- The 'Ellie and Dave Punch List' document is stored in River at /home/ellie/obsidian-vault/Ellie and Dave Punch List.md and also written to Forest under scope 2 (Projects).
- The graduation bug fix (commit 67ee5ef) unblocked 3,599 fact memories that were previously excluded due to a NULL metadata filter issue.
- The 'LEF' hallucination was caused by two factors: heavy repetition from chunked Ellie Learn spec loading and the sudden influx of Learn-related memories after the graduation filter fix.
- Ellie Life has been tested for about three weeks with three different instances, bugs were found and fixed over a week, and more beta testers are starting next week.

RECENT CONVERSATIONS:
- [ellie-chat, closed, Apr 4, 11:51 PM, 4 msgs] No summary
- [ellie-chat, closed, Apr 4, 11:37 PM, 2 msgs] Dave asked Ellie to map out the full memory system architecture to diagnose why memories appeared missing. Ellie provided a detailed technical bluepri...
- [ellie-chat, closed, Apr 4, 10:44 PM, 12 msgs] Dave restarted the ellie-chat-relay service to clear phantom state, then had James fix two bugs: the dispatch event UUID mismatch (run_id column chang...

LAST 24H ACTIVITY:
- ellie-chat: 92 user / 89 assistant messages

PENDING ACTION ITEMS:
- Check periodic-tasks.ts to verify the 6-hour conversation_facts sync is actually registered and running. (Apr 4)
- Decide whether to build a direct memory → shared_memories sync or re-backfill into conversation_facts and fix the existing sync pipeline. (Apr 4)
- Run SELECT COUNT(*) FROM memory and SELECT COUNT(*) FROM conversation_facts in Supabase to confirm where the 5,471 memories landed. (Apr 4)
- Fix bun run migrate — the os_rate_limits migration collision needs resolving so future migrations can run cleanly. (Apr 4)
- Decide whether to recover and migrate the 1,000 stranded Supabase memories to Forest shared_memories or start growing the forest fresh. (Apr 4)
- Pre-summarize the Ellie Learn spec before injecting it into coordinator context to prevent abbreviation confabulation. (Apr 4)
- Check what the graduation batch pipeline is surfacing post-fix to identify if redundant Ellie Learn facts need deduplication or rate-limiting. (Apr 4)
- Restart the coordinator session to flush stale context carrying the 'LEF' phantom hallucination. (Apr 4)
- Dave needs to decide on LD/children-first vs lifelong-learning launch strategy before the next revision of the Ellie Learn architecture document. (Apr 4)
- Jason to purge the 326 failed Plane queue items and fix the processQueue() race condition (transaction wrapping + concurrency guard) — pending Dave's approval. (Apr 4)

GMAIL: No unread messages.


RIVER CONTEXT (relevant docs from Obsidian vault):
• Communication System Architecture
  @@ -1,3 @@ (0 before, 160 after)
# Communication System Architecture

**Primary repository:** `ellie-dev`

• Message Types & Channels — Complete Inventory
  @@ -6,4 @@ (5 before, 166 after)

## Channel Overview

| Channel | Transport | Primary Use |

• Forest Architecture — Future Use Cases & QA Model
  @@ -1,3 @@ (0 before, 5037 after)
# Forest Architecture — Future Use Cases & QA Model

## Future Use Cases


---

## relevantFacts (410 chars / ~103 tokens)

PERSONAL KNOWLEDGE (remembered facts):
- [completed_goal] Ship Ellie OS v1
- [fact] Ellie OS was built in 45 days (Feb 5 - Mar 22, 2026) with 414 commits and 36,478 lines of code across 363 TypeScript files.
- [fact] Ellie OS 1.0 will include only the 5 foundational features (Energy-Aware, Visual Memory, Smart Batching, Hot-Reload, Export/Import) plus alpha bug fixes, with features 6-15 deferred to 1.1-1.3.

---

## agentMemory (7 chars / ~2 tokens)

(empty)

---

## relevantContext (7 chars / ~2 tokens)

(empty)

---

## profileContext (897 chars / ~224 tokens)

# Your Profile

> Loaded on every message. Edit this file to change how Ellie interacts with you.

## About You

- **Name:** Dave
- **Timezone:** America/Chicago (US Central)
- **Occupation:** Software architect
- **Reading:** Has dyslexia — use short paragraphs, bullet points, clear structure. Avoid walls of text.

## What Matters

- Reducing cognitive load for people with dyslexia and other learning disabilities
- Building systems that scale from personal use to domain knowledge
- Making AI approachable and human — not robotic, not cold
- Accessibility as core design, not an afterthought

## Goals

- To have a system that makes things easier

## Constraints

- None

## Communication Style

- Detailed but casual — thorough explanations in a conversational, friendly tone
- Prefer bullet points and structured lists over long paragraphs
- Bold key terms and action items for scanability


---

## relationshipMemories (3,458 chars / ~865 tokens)

- [fact] The legacy Supabase `memory` table has no sync path to Forest's `shared_memories` — it lacks a `forest_memory_id` column and is structurally unable to sync.
- [fact] The conversation_facts → shared_memories sync (in sync-conversation-facts.ts) runs every 6 hours in batches of 25 but appears to have never successfully populated shared_memories.
- [fact] The Ellie memory system has three tiers: Forest working_memory (session-scoped), Supabase memory/conversation_facts (cloud), and Forest shared_memories (local persistent).
- [fact] Forest's shared_memories table has only 1 record (Oak Catalog at R/1) despite 5,471+ memories existing in Supabase.
- [fact] The goals endpoint queries WHERE type = 'goal'::memory_type but that enum value doesn't exist, making goals invisible even if they synced.
- [fact] 77 memory arcs exist in the Forest DB but are orphaned — they reference clusters of shared memories that no longer exist.
- [fact] orchestration_events.run_id column was migrated from uuid to text type to support dsp_ prefixed dispatch IDs (April 4, 2026).
- [fact] 1,000 legacy memories exist in the Supabase memory table (660 facts, 220 action items, 113 summaries, 6 goals) but are inaccessible because the facts API now reads from Forest shared_memories instead.
- [fact] Forest shared_memories table has 0 rows as of April 4, 2026 — all agent-written decisions, findings, facts, and hypotheses were lost after the relay reset.
- [fact] plane_sync_queue had 326 stale entries causing log noise; reconcilePlaneState() in src/plane.ts was patched to only reset failed items where attempts < max_attempts instead of blindly resetting all failed items on startup.
- [fact] bun run migrate is broken because 20260401_os_rate_limits.sql hits a 'relation already exists' error.
- [fact] The 'Ellie and Dave Punch List' document is stored in River at /home/ellie/obsidian-vault/Ellie and Dave Punch List.md and also written to Forest under scope 2 (Projects).
- [fact] The graduation bug fix (commit 67ee5ef) unblocked 3,599 fact memories that were previously excluded due to a NULL metadata filter issue.
- [fact] The 'LEF' hallucination was caused by two factors: heavy repetition from chunked Ellie Learn spec loading and the sudden influx of Learn-related memories after the graduation filter fix.
- [fact] Ellie Life has been tested for about three weeks with three different instances, bugs were found and fixed over a week, and more beta testers are starting next week.
- [fact] The Ellie App core took about two weeks of design documentation and testing; Ellie Life integrated into it with only 30 minutes of wiring and passed a 2-hour end-to-end test with zero flaws.
- [fact] Alan's strategic feedback on Ellie Learn: cross-creature intelligence is the key differentiator, teacher adoption requires utility not just metaphor, and the LD/children market should be the launch focus over lifelong learning.
- [fact] A race condition exists in plane-queue.ts processQueue(): FOR UPDATE SKIP LOCKED releases lock immediately after SELECT due to auto-commit, and setInterval has no concurrency guard, allowing duplicate processing.
- [fact] Dispatch event writes to the orchestration ledger were silently failing because dispatch IDs use base-36 format (dsp_*) but the DB column expects UUIDs.
- [fact] Ellie Learn is the second module being built for the core (current focus as of April 4, 2026); Ellie Work is planned but not yet started.

---

## Summary

| Section | Chars | ~Tokens | Status |
|---------|-------|---------|--------|
| soul | 15 | ~4 | Minimal |
| elasticContext | 19,083 | ~4,771 | Present |
| forestContext | 7 | ~2 | Empty |
| liveForest_incidents | 6 | ~2 | Empty |
| liveForest_awareness | 6 | ~2 | Empty |
| structuredContext | 6,679 | ~1,670 | Present |
| relevantFacts | 410 | ~103 | Present |
| agentMemory | 7 | ~2 | Empty |
| relevantContext | 7 | ~2 | Empty |
| profileContext | 897 | ~224 | Present |
| relationshipMemories | 3,458 | ~865 | Present |
| **TOTAL** | **30,575** | **~7,644** | |