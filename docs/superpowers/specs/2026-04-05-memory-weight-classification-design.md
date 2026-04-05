# Memory Weight & Classification System — Design Spec

> **Date:** April 5, 2026
> **Problem:** 97.9% of Forest memories have identical confidence (0.7), 94.2% have identical weight (0.255). "Dave rejects the framing of learning disability" is indistinguishable from "port 3001 serves HTTP" to the retrieval engine.
> **Solution:** A content classifier that assigns meaningful confidence and emotional_intensity at write time, with LLM-assisted deep classification for ambiguous content, plus a one-time catch-up reclassification of all existing memories.

---

## Current State

| Metric | Value | Problem |
|--------|-------|---------|
| Memories with confidence 0.7 | 3,645 / 3,724 (97.9%) | No differentiation between foundational identity and ephemeral trivia |
| Memories with weight 0.255 | ~3,509 (94.2%) | Weight formula is correct but all inputs are flat |
| emotional_intensity | NULL on 100% | 25% of weight formula is zeroed out |
| Category "general" | 3,636 (97.6%) | Category classifier exists but isn't applied |
| Cognitive type "factual" | 3,693 (99.2%) | Same — classifier exists, not applied |
| ELLIE-653 test artifacts | 68 | Synthetic clutter in search results |
| Pre-March never-accessed | 1,510 | Stale memories consuming search bandwidth |

**Root cause:** Every write path passes `confidence: 0.7` or nothing. Nobody inspects content to determine if a memory is foundational vs ephemeral. The weight formula (`computeWeight()`) has the right shape but receives flat inputs.

---

## Design

### Memory Tiers

Every memory gets classified into one of four tiers. The tier drives confidence and emotional_intensity, which feed the existing `computeWeight()` formula. No formula changes needed — just better inputs.

| Tier | What it holds | Confidence Range | Emotional Intensity | Weight at creation | Weight after decay |
|------|--------------|-----------------|--------------------|--------------------|-------------------|
| **Foundational** | Identity, values, relationships, vision, who people are, what matters to them, what Ellie is | 0.90 - 0.95 | 0.6 - 0.8 | ~0.56 | ~0.46 |
| **Strategic** | Decisions, preferences, working style, architectural choices, the "why" behind things | 0.80 - 0.85 | 0.3 - 0.5 | ~0.50 | ~0.38 |
| **Operational** | Technical facts, system behavior, configs, integrations, how things work | 0.60 - 0.70 | 0.0 - 0.1 | ~0.43 | ~0.26 |
| **Ephemeral** | Bug details, error messages, one-time incidents, transient state, test artifacts | 0.30 - 0.50 | 0.0 | ~0.39 | ~0.19 |

**Weight separation:** 2.4x between foundational (~0.46) and ephemeral (~0.19) after temporal decay. Foundational memories remain prominent. Ephemeral memories naturally sink.

**Examples of each tier:**

- **Foundational:** "Dave rejects the framing of learning disability — he sees it as people who think differently." / "Dave's family: Wincy (wife), Georgia (daughter), Bette (daughter)." / "Ellie OS is a system of love. It has to be right."
- **Strategic:** "Chose PostgreSQL for Forest because tree metaphor maps to relational hierarchy." / "Desktop is the primary platform for learning disability users." / "Dave prefers bundled PRs for refactors."
- **Operational:** "Relay runs on port 3001, dashboard on port 3000." / "writeMemory() returns { memory, contradictions }." / "Cloudflare tunnel config at /etc/cloudflared/config.yml."
- **Ephemeral:** "Relay crash-looped 15,336 times due to stale bun process." / "PostgREST filter .not() returns 0 rows because NULL != true." / "ELLIE-653 tag test fact."

---

### The Classifier Module

A standalone module in ellie-forest: `src/memory-classifier.ts`. Two modes: fast and deep.

#### Fast Classifier (Rule-Based, <1ms)

Pattern matching on content. Returns `{ tier, confidence, emotional_intensity, category, cognitive_type, needs_deep }`.

**Signal groups:**

| Signal Group | Patterns | Tier |
|-------------|----------|------|
| **Identity** | Family names (Dave, Wincy, Betty/Bette, Georgia), "dyslexic", "values", "believes", "personality", "who I am", "my wife", "my daughter", "my brother" | Foundational |
| **Relationship** | "Ellie is", "Ellie should", "trust", "companion", "guiding hand", "system of love" | Foundational |
| **Vision** | "product vision", "mission", "selling", "consumers", "Kickstarter", "audio-first", "forest metaphor", "learning disability" (in product context) | Foundational |
| **Decision** | "chose X over Y", "decided", "approach", "architecture decision", "design philosophy", "trade-off" | Strategic |
| **Preference** | "Dave prefers", "don't do X", "always do Y", "corrected", "working style", "rejects", "insists" | Strategic |
| **Technical** | Port numbers (`\d{4}`), file paths (`/`-separated), function/method names (camelCase/snake_case), SQL keywords, "migration", "endpoint", "config", "schema" | Operational |
| **Incident** | "crash", "error", "bug", "failed", "broke", "fix", "hotfix", stack traces, "crash-loop" | Ephemeral |
| **Test/Synthetic** | "ELLIE-653", "canary", "test memory", "PHASE3_TEST", "test artifact" | Ephemeral |

**Scoring:** Each signal group has a score. If a signal fires, its tier gets points. Highest-scoring tier wins. If no signals fire, or if the margin between top two tiers is < 2 points, the classifier returns `needs_deep: true` and defaults to `tier: 'operational'`.

**Why default to operational:** False-high (marking ephemeral as foundational) is worse than false-low (marking foundational as operational). The LLM deep pass corrects false-lows. False-highs pollute the top of search results.

#### Deep Classifier (LLM-Assisted, ~500ms)

For memories where `needs_deep_classification = true`. Uses Haiku for cost efficiency.

**Prompt:**

```
Classify this memory for a personal AI assistant named Ellie.
Ellie's owner is Dave, a dyslexic enterprise architect building Ellie OS as a personal AI companion and future product for people with learning disabilities.

Memory: "{content}"

Which tier best describes this memory?
- foundational: Identity, values, relationships, vision, who people are, what matters to them
- strategic: Decisions, preferences, working style, architectural choices, the "why" behind things
- operational: Technical facts, system behavior, configs, how things work
- ephemeral: Bug details, errors, one-time incidents, transient state

Return JSON only: {"tier": "foundational|strategic|operational|ephemeral", "confidence": 0.0-1.0, "emotional_intensity": 0.0-1.0, "reasoning": "one sentence"}
```

**Model:** Haiku (claude-haiku-4-5-20251001). ~$0.002 per memory. For ~550 ambiguous memories: ~$1.10 total.

**Runs as a periodic task:** Every 30 minutes, picks up 50 memories with `needs_deep_classification = true`, classifies them, updates confidence/emotional_intensity/category/cognitive_type, clears the flag. The existing hourly weight refresh recalculates weights on next pass.

**Override protection:** If a memory was written with an explicit confidence value that differs from 0.7 (the default), the classifier does not downgrade it. It only upgrades or fills in defaults. This respects trusted sources like explicit bridge writes with `confidence: 0.9`.

---

### Write Path Integration

`writeMemory()` in `ellie-forest/src/shared-memory.ts` gets a classification step after INSERT. No signature changes. No caller changes.

```
writeMemory(opts) →
  1. INSERT as today (with caller's confidence if provided)
  2. IF caller confidence is 0.7 (the "nobody thought about it" default) OR not provided:
       → Run fast classifier on content
       → UPDATE confidence, emotional_intensity, category, cognitive_type
       → IF ambiguous: SET needs_deep_classification = true
  3. Compute weight with updated values (existing computeWeight)
  4. Return memory as today
```

**What this means for the 19 write paths:** Zero changes to callers. They keep passing `confidence: 0.7` or nothing. The classifier inside `writeMemory()` replaces the default with a meaningful value. Over time, callers could be updated to pass more accurate values, but it's not required.

**New DB columns on `shared_memories`:**
- `needs_deep_classification BOOLEAN DEFAULT false` — flag for async LLM pass
- `memory_tier TEXT` — the assigned tier (foundational/strategic/operational/ephemeral). Stored for querying and the stale sweep. Set by the classifier alongside confidence/emotional_intensity.

---

### Catch-Up Reclassification

One-time script to bring all existing memories up to the new standard. Three phases:

**Phase 1: Archive clutter**
- Archive 68 ELLIE-653 test artifacts: `UPDATE shared_memories SET status = 'archived' WHERE content LIKE '%ELLIE-653%' AND status = 'active'`
- Memories are recoverable (archived, not deleted)

**Phase 2: Fast pass**
- Run fast classifier on every remaining active memory (~3,656)
- Update confidence, emotional_intensity, category, cognitive_type
- Flag ambiguous ones with `needs_deep_classification = true`
- Expected: ~3,100 classified immediately, ~550 flagged for LLM

**Phase 3: Deep pass**
- Send ~550 flagged memories through Haiku
- Update fields, clear flags
- Trigger full weight refresh (`refreshWeights` on all active memories)

**Phase 4: Stale memory sweep**
- After reclassification, sweep pre-March never-accessed memories:
  - `WHERE tier = 'ephemeral' AND last_accessed_at IS NULL AND created_at < '2026-03-01'` → archive
  - Everything else stays active with its new weight

**Expected outcome:**

| Metric | Before | After |
|--------|--------|-------|
| Confidence distribution | 97.9% at 0.7 | Spread: 0.3-0.5 (ephemeral), 0.6-0.7 (operational), 0.8-0.85 (strategic), 0.9-0.95 (foundational) |
| Weight distribution | 94.2% at 0.255 | Spread: 0.19-0.56 |
| Category "general" | 97.6% | ~60% (many reclassified to work, family, identity, learning, etc.) |
| emotional_intensity NULL | 100% | ~15-20% have values > 0 (foundational + strategic) |
| Test artifacts in search | 68 | 0 (archived) |

---

### What This Does NOT Change

- **The weight formula** (`computeWeight()`) — it's correct, just underfed. No changes needed.
- **The `type` field** (fact/finding/decision/hypothesis) — tier is about *importance*, type is about *what kind of knowledge*. A fact can be foundational or ephemeral.
- **The retrieval path** — `readMemories()`, `readMemoriesByPath()`, temporal decay, MMR — all stay the same. They already sort by weight. Better weights = better results automatically.
- **The scope system** — Phase 1-3 work on scope routing is orthogonal. Tier classification is about weight within a scope.

---

## Success Criteria

1. After catch-up, "Dave rejects the framing of learning disability" has weight > 0.40 and "relay crash-looped on port 3001" has weight < 0.25
2. New memories written via any path get classified automatically — no caller changes needed
3. Ambiguous memories get LLM-classified within 30 minutes of creation
4. Zero test artifacts appear in search results
5. The dashboard scope tree shows weight differentiation within scopes (not flat 0.255 everywhere)
