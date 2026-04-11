# Memory Weight & Classification System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify memories by content tier (foundational/strategic/operational/ephemeral) so the weight formula produces meaningful differentiation instead of flat 0.255 for everything.

**Architecture:** A standalone classifier module in ellie-forest with two modes: fast (regex, <1ms, runs at write time) and deep (Haiku LLM, runs async). `writeMemory()` calls the fast classifier automatically. A periodic task handles ambiguous memories via LLM. A one-time catch-up script reclassifies all 3,700+ existing memories.

**Tech Stack:** TypeScript, postgres.js, Anthropic SDK (Haiku), Bun test runner

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `ellie-dev/migrations/forest/20260405_content_tier_column.sql` | **Create** | Add `content_tier` and `needs_deep_classification` columns |
| `ellie-forest/src/memory-classifier.ts` | **Create** | Fast rule-based tier classifier |
| `ellie-forest/tests/memory-classifier.test.ts` | **Create** | Tests for fast classifier |
| `ellie-forest/src/shared-memory.ts` | **Modify** | Wire classifier into `writeMemory()` and `refreshWeights()` |
| `ellie-forest/src/types.ts` | **Modify** | Add `ContentTier` type |
| `ellie-forest/src/index.ts` | **Modify** | Export classifier |
| `ellie-dev/src/deep-classifier.ts` | **Create** | LLM-assisted tier classifier (Haiku) |
| `ellie-dev/tests/deep-classifier.test.ts` | **Create** | Tests for deep classifier |
| `ellie-dev/src/periodic-tasks.ts` | **Modify** | Add deep classification periodic task |
| `ellie-dev/scripts/reclassify-memory-tiers.ts` | **Create** | One-time catch-up reclassification |

---

### Task 1: Database Migration — Add content_tier and needs_deep_classification

Add two new columns to `shared_memories`. Note: `memory_tier` already exists with values `core/extended/goals` (different concept — that's about memory system tiers). Our new column is `content_tier` for importance classification.

**Files:**
- Create: `ellie-dev/migrations/forest/20260405_content_tier_column.sql`

- [ ] **Step 1: Write the migration**

```sql
-- ellie-dev/migrations/forest/20260405_content_tier_column.sql
-- ELLIE-1428: Add content tier classification for weight differentiation
-- content_tier: foundational (identity/values), strategic (decisions/preferences),
--               operational (technical facts), ephemeral (bugs/incidents)

ALTER TABLE shared_memories
  ADD COLUMN IF NOT EXISTS content_tier TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS needs_deep_classification BOOLEAN DEFAULT false;

-- Index for the periodic deep classification task
CREATE INDEX IF NOT EXISTS idx_shared_memories_needs_deep
  ON shared_memories (needs_deep_classification)
  WHERE needs_deep_classification = true;

COMMENT ON COLUMN shared_memories.content_tier IS 'Content importance tier: foundational, strategic, operational, ephemeral';
COMMENT ON COLUMN shared_memories.needs_deep_classification IS 'Flag for async LLM classification of ambiguous content';
```

- [ ] **Step 2: Apply the migration**

Run: `psql -U ellie -d ellie-forest -f migrations/forest/20260405_content_tier_column.sql`
Expected: ALTER TABLE, CREATE INDEX

- [ ] **Step 3: Verify columns exist**

Run: `psql -U ellie -d ellie-forest -c "\d shared_memories" | grep -E "content_tier|needs_deep"`
Expected: Both columns visible.

- [ ] **Step 4: Commit**

```bash
git add migrations/forest/20260405_content_tier_column.sql
git commit -m "[ELLIE-1428] feat: add content_tier and needs_deep_classification columns"
```

---

### Task 2: Fast Classifier Module

Create `memory-classifier.ts` in ellie-forest — a pure module that classifies memory content into tiers using pattern matching. No DB access, no async, fully testable.

**Files:**
- Create: `ellie-forest/src/memory-classifier.ts`
- Create: `ellie-forest/tests/memory-classifier.test.ts`
- Modify: `ellie-forest/src/types.ts`
- Modify: `ellie-forest/src/index.ts`

- [ ] **Step 1: Add ContentTier type**

In `ellie-forest/src/types.ts`, add after the `MemoryTier` type (line 313):

```typescript
export type ContentTier = 'foundational' | 'strategic' | 'operational' | 'ephemeral'
```

- [ ] **Step 2: Write the failing test**

```typescript
// ellie-forest/tests/memory-classifier.test.ts
import { describe, test, expect } from "bun:test";
import { classifyContentTier } from "../src/memory-classifier";

describe("classifyContentTier", () => {
  describe("foundational tier", () => {
    test("classifies identity content", () => {
      const result = classifyContentTier(
        "Dave rejects the framing of learning disability — he sees it as people who think differently."
      );
      expect(result.tier).toBe("foundational");
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
      expect(result.emotional_intensity).toBeGreaterThan(0);
      expect(result.needs_deep).toBe(false);
    });

    test("classifies family content", () => {
      const result = classifyContentTier(
        "Dave's family: Wincy (wife), Georgia (daughter), Bette (daughter)."
      );
      expect(result.tier).toBe("foundational");
    });

    test("classifies relationship/vision content", () => {
      const result = classifyContentTier(
        "Ellie OS is a system of love. It has to be right. This is what we're selling."
      );
      expect(result.tier).toBe("foundational");
    });
  });

  describe("strategic tier", () => {
    test("classifies decisions", () => {
      const result = classifyContentTier(
        "Chose PostgreSQL for Forest because the tree metaphor maps to relational hierarchy."
      );
      expect(result.tier).toBe("strategic");
      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    });

    test("classifies preferences", () => {
      const result = classifyContentTier(
        "Dave prefers bundled PRs for refactors rather than splitting into many small ones."
      );
      expect(result.tier).toBe("strategic");
    });
  });

  describe("operational tier", () => {
    test("classifies technical facts", () => {
      const result = classifyContentTier(
        "Relay runs on port 3001, dashboard on port 3000. Cloudflare tunnel config at /etc/cloudflared/config.yml."
      );
      expect(result.tier).toBe("operational");
      expect(result.confidence).toBeGreaterThanOrEqual(0.6);
      expect(result.emotional_intensity).toBe(0);
    });

    test("classifies code references", () => {
      const result = classifyContentTier(
        "writeMemory() returns { memory, contradictions }. The function lives in shared-memory.ts."
      );
      expect(result.tier).toBe("operational");
    });
  });

  describe("ephemeral tier", () => {
    test("classifies incidents", () => {
      const result = classifyContentTier(
        "Relay crash-looped 15,336 times due to a stale bun process squatting on port 3001."
      );
      expect(result.tier).toBe("ephemeral");
      expect(result.confidence).toBeLessThanOrEqual(0.5);
    });

    test("classifies test artifacts", () => {
      const result = classifyContentTier(
        "ELLIE-653 tag test fact: Relay uses port 3001 and serves Bridge API."
      );
      expect(result.tier).toBe("ephemeral");
    });
  });

  describe("ambiguous content", () => {
    test("flags ambiguous content for deep classification", () => {
      const result = classifyContentTier(
        "Dave changed the product model from triangle to circle."
      );
      expect(result.needs_deep).toBe(true);
      expect(result.tier).toBe("operational"); // safe default
    });

    test("short generic content defaults to operational with deep flag", () => {
      const result = classifyContentTier("Updated the system configuration.");
      expect(result.tier).toBe("operational");
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /home/ellie/ellie-forest && bun test tests/memory-classifier.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the fast classifier**

```typescript
// ellie-forest/src/memory-classifier.ts
/**
 * Memory Content Classifier — ELLIE-1428
 *
 * Classifies memory content into importance tiers for weight differentiation.
 * Fast mode: regex pattern matching (<1ms). Deep mode: LLM (handled externally).
 *
 * Tiers:
 *   foundational — identity, values, relationships, vision
 *   strategic    — decisions, preferences, working style, architecture
 *   operational  — technical facts, configs, system behavior
 *   ephemeral    — bugs, errors, incidents, test artifacts
 */

import type { ContentTier, MemoryCategory, CognitiveType } from "./types.ts";

export interface ClassificationResult {
  tier: ContentTier;
  confidence: number;
  emotional_intensity: number;
  needs_deep: boolean;
}

// ── Signal patterns ──────────────────────────────────────────

interface SignalGroup {
  tier: ContentTier;
  weight: number; // points per match
  patterns: RegExp[];
}

const SIGNAL_GROUPS: SignalGroup[] = [
  // Foundational — identity, family, values, vision, relationship
  {
    tier: "foundational",
    weight: 3,
    patterns: [
      /\b(dave|wincy|betty|bette|georgia)\b/i,
      /\b(dyslexic|dyslexia)\b/i,
      /\b(my\s+wife|my\s+daughter|my\s+brother|my\s+family|his\s+wife|his\s+daughter)\b/i,
      /\b(values|believes|identity|who\s+i\s+am|who\s+he\s+is|personality)\b/i,
      /\b(learning\s+disabilit)/i,
      /\bfamily\s+members?\b/i,
    ],
  },
  {
    tier: "foundational",
    weight: 2,
    patterns: [
      /\bellie\s+(is|should|was\s+designed|needs\s+to)\b/i,
      /\b(trust|companion|guiding\s+hand|system\s+of\s+love)\b/i,
      /\b(product\s+vision|mission|selling|consumers|kickstarter)\b/i,
      /\b(audio[- ]first|forest\s+metaphor|forest\s+ecosystem)\b/i,
      /\b(passion\s+project|retirement|full[- ]time\s+business)\b/i,
      /\b(target\s+audience|accessibility|accessible\s+tools)\b/i,
    ],
  },
  // Strategic — decisions, preferences, working style
  {
    tier: "strategic",
    weight: 2,
    patterns: [
      /\b(chose|decided|decision|approach|trade[- ]off)\b/i,
      /\b(architecture\s+decision|design\s+philosophy|design\s+principle)\b/i,
      /\b(dave\s+prefers?|don't\s+do|always\s+do|never\s+do)\b/i,
      /\b(working\s+style|working\s+preference|corrected|rejects|insists)\b/i,
      /\b(strategy|roadmap|milestone|phase\s+\d|priority)\b/i,
      /\b(primary\s+platform|primary\s+experience|core\s+principle)\b/i,
    ],
  },
  // Technical/Operational — ports, paths, functions, configs
  {
    tier: "operational",
    weight: 1,
    patterns: [
      /\bport\s+\d{4}\b/i,
      /\/(etc|home|src|var|usr)\//,
      /\b\w+\(\)\b/, // function calls like writeMemory()
      /\b(endpoint|config|schema|migration|sql|database|postgres|supabase)\b/i,
      /\b(systemctl|nginx|cloudflare|docker|bun\s+run)\b/i,
      /\b(\.ts|\.js|\.vue|\.sql|\.md)\b/,
      /\b(import|export|async|await|function|const|let)\b/,
    ],
  },
  // Ephemeral — incidents, errors, bugs, test artifacts
  {
    tier: "ephemeral",
    weight: 2,
    patterns: [
      /\b(crash[- ]?loop|crash[- ]?looped|segfault|oom|out\s+of\s+memory)\b/i,
      /\b(stack\s+trace|traceback|exception|threw|thrown)\b/i,
      /\bELLIE-653\b/,
      /\b(canary|test\s+memory|test\s+artifact|PHASE\d_TEST)\b/i,
      /\b(hotfix|workaround|quick\s+fix|band[- ]?aid)\b/i,
    ],
  },
  {
    tier: "ephemeral",
    weight: 1,
    patterns: [
      /\b(error|failed|broke|broken|bug)\b/i,
      /\b(fix|fixed|fixing|patched)\b/i,
    ],
  },
];

// ── Tier defaults ────────────────────────────────────────────

const TIER_DEFAULTS: Record<ContentTier, { confidence: number; emotional_intensity: number }> = {
  foundational: { confidence: 0.92, emotional_intensity: 0.7 },
  strategic:    { confidence: 0.82, emotional_intensity: 0.4 },
  operational:  { confidence: 0.65, emotional_intensity: 0.0 },
  ephemeral:    { confidence: 0.40, emotional_intensity: 0.0 },
};

// ── Classifier ───────────────────────────────────────────────

/**
 * Classify memory content into an importance tier.
 * Fast, synchronous, pure function. No DB or LLM calls.
 *
 * Returns the tier, confidence, emotional_intensity, and whether
 * the content needs LLM-assisted deep classification.
 */
export function classifyContentTier(content: string): ClassificationResult {
  const scores: Record<ContentTier, number> = {
    foundational: 0,
    strategic: 0,
    operational: 0,
    ephemeral: 0,
  };

  for (const group of SIGNAL_GROUPS) {
    for (const pattern of group.patterns) {
      if (pattern.test(content)) {
        scores[group.tier] += group.weight;
      }
    }
  }

  // Find the winning tier
  const entries = Object.entries(scores) as [ContentTier, number][];
  entries.sort((a, b) => b[1] - a[1]);

  const [topTier, topScore] = entries[0];
  const secondScore = entries[1][1];

  // If no signals fired, or margin is too thin, flag for deep classification
  if (topScore === 0 || (topScore > 0 && topScore - secondScore < 2)) {
    return {
      tier: "operational", // safe default — false-high is worse than false-low
      confidence: TIER_DEFAULTS.operational.confidence,
      emotional_intensity: TIER_DEFAULTS.operational.emotional_intensity,
      needs_deep: true,
    };
  }

  const defaults = TIER_DEFAULTS[topTier];
  return {
    tier: topTier,
    confidence: defaults.confidence,
    emotional_intensity: defaults.emotional_intensity,
    needs_deep: false,
  };
}
```

- [ ] **Step 5: Export from index.ts**

Add to `ellie-forest/src/index.ts`:

```typescript
export { classifyContentTier } from "./memory-classifier.ts";
export type { ClassificationResult } from "./memory-classifier.ts";
```

- [ ] **Step 6: Run tests**

Run: `cd /home/ellie/ellie-forest && bun test tests/memory-classifier.test.ts`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
cd /home/ellie/ellie-forest
git add src/memory-classifier.ts src/types.ts src/index.ts tests/memory-classifier.test.ts
git commit -m "[ELLIE-1428] feat: fast content tier classifier for memory weight differentiation"
```

---

### Task 3: Wire Fast Classifier Into writeMemory()

Modify `writeMemory()` in ellie-forest to call the fast classifier when the caller passes the default confidence (0.7) or no explicit confidence.

**Files:**
- Modify: `ellie-forest/src/shared-memory.ts:270-335`

- [ ] **Step 1: Add import**

At the top of `ellie-forest/src/shared-memory.ts`, add:

```typescript
import { classifyContentTier } from "./memory-classifier.ts";
```

- [ ] **Step 2: Add classification step after category/cognitive type resolution**

In `writeMemory()`, after line 274 (the `resolvedCognitiveType` line) and before line 276 (the `generateEmbedding` call), add:

```typescript
  // ELLIE-1428: Classify content tier for weight differentiation
  // Only classify if caller used the default confidence (0.7 or not provided)
  const callerConfidence = opts.confidence ?? 0.5;
  const isDefaultConfidence = callerConfidence === 0.7 || callerConfidence === 0.5;
  let resolvedConfidence = callerConfidence;
  let resolvedEmotionalIntensity = opts.emotional_intensity ?? null;
  let contentTier: string | null = null;
  let needsDeepClassification = false;

  if (isDefaultConfidence) {
    const classification = classifyContentTier(opts.content);
    contentTier = classification.tier;
    resolvedConfidence = classification.confidence;
    resolvedEmotionalIntensity = classification.emotional_intensity;
    needsDeepClassification = classification.needs_deep;
  }
```

- [ ] **Step 3: Update the INSERT to use resolved values**

In the INSERT statement (line 293-338), replace the relevant values:

- `${opts.confidence ?? 0.5}` → `${resolvedConfidence}`
- `${opts.emotional_intensity ?? null}` → `${resolvedEmotionalIntensity}`

And add the new columns to the INSERT:

In the column list, add after `importance_score`:
```sql
, content_tier, needs_deep_classification
```

In the VALUES, add after the `importance_score` value:
```sql
, ${contentTier}, ${needsDeepClassification}
```

- [ ] **Step 4: Update computeWeight call to use resolved values**

Change the `computeWeight` call (line 279-285) to use the resolved values:

```typescript
  const initialWeight = computeWeight({
    emotional_intensity: resolvedEmotionalIntensity ?? 0,
    frequency: 0,
    recency: 1.0,
    relevance: resolvedConfidence,
    person_importance: 0.5,
  });
```

- [ ] **Step 5: Run tests**

Run: `cd /home/ellie/ellie-forest && bun test`
Expected: All tests pass, including the new classifier tests.

- [ ] **Step 6: Verify with a manual test**

```bash
# Write a foundational memory and check its weight
psql -U ellie -d ellie-forest -c "
  SELECT content_tier, confidence, emotional_intensity, weight, needs_deep_classification
  FROM shared_memories
  WHERE content LIKE '%TIER_TEST%'
  ORDER BY created_at DESC LIMIT 3;
"
```

- [ ] **Step 7: Commit**

```bash
cd /home/ellie/ellie-forest
git add src/shared-memory.ts
git commit -m "[ELLIE-1428] feat: wire fast content classifier into writeMemory()"
```

---

### Task 4: Deep Classifier Module (LLM-Assisted)

Create `deep-classifier.ts` in ellie-dev — uses the Anthropic SDK (Haiku) to classify ambiguous memories. Follows the exact same pattern as `entailment-classifier.ts`.

**Files:**
- Create: `ellie-dev/src/deep-classifier.ts`
- Create: `ellie-dev/tests/deep-classifier.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// ellie-dev/tests/deep-classifier.test.ts
import { describe, test, expect } from "bun:test";
import { parseDeepClassification, buildClassificationPrompt } from "../src/deep-classifier";

describe("parseDeepClassification", () => {
  test("parses valid JSON response", () => {
    const result = parseDeepClassification(
      '{"tier": "foundational", "confidence": 0.92, "emotional_intensity": 0.7, "reasoning": "Contains identity information"}'
    );
    expect(result.tier).toBe("foundational");
    expect(result.confidence).toBe(0.92);
    expect(result.emotional_intensity).toBe(0.7);
  });

  test("handles markdown-wrapped JSON", () => {
    const result = parseDeepClassification(
      '```json\n{"tier": "strategic", "confidence": 0.85, "emotional_intensity": 0.3, "reasoning": "Decision"}\n```'
    );
    expect(result.tier).toBe("strategic");
  });

  test("returns operational default for invalid JSON", () => {
    const result = parseDeepClassification("this is not json");
    expect(result.tier).toBe("operational");
    expect(result.confidence).toBe(0.65);
  });

  test("rejects invalid tier values", () => {
    const result = parseDeepClassification(
      '{"tier": "cosmic", "confidence": 0.9, "emotional_intensity": 0.5, "reasoning": "test"}'
    );
    expect(result.tier).toBe("operational");
  });
});

describe("buildClassificationPrompt", () => {
  test("includes the memory content", () => {
    const prompt = buildClassificationPrompt("Dave loves coffee in the morning");
    expect(prompt).toContain("Dave loves coffee in the morning");
    expect(prompt).toContain("foundational");
    expect(prompt).toContain("strategic");
    expect(prompt).toContain("operational");
    expect(prompt).toContain("ephemeral");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ellie/ellie-dev && bun test tests/deep-classifier.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the deep classifier**

```typescript
// ellie-dev/src/deep-classifier.ts
/**
 * Deep Content Classifier — ELLIE-1428
 *
 * LLM-assisted tier classification for ambiguous memories.
 * Uses Haiku for fast, cheap classification (~$0.002/call).
 * Follows the same pattern as entailment-classifier.ts.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { log } from "./logger.ts";

const logger = log.child("deep-classifier");

type ContentTier = "foundational" | "strategic" | "operational" | "ephemeral";

export interface DeepClassificationResult {
  tier: ContentTier;
  confidence: number;
  emotional_intensity: number;
  reasoning: string;
}

const VALID_TIERS: ContentTier[] = ["foundational", "strategic", "operational", "ephemeral"];

const DEFAULTS: DeepClassificationResult = {
  tier: "operational",
  confidence: 0.65,
  emotional_intensity: 0,
  reasoning: "Classification failed — defaulting to operational",
};

let _anthropic: Anthropic | null = null;

export function initDeepClassifier(anthropic: Anthropic): void {
  _anthropic = anthropic;
  logger.info("Initialized");
}

export function buildClassificationPrompt(content: string): string {
  return `Classify this memory for a personal AI assistant named Ellie.
Ellie's owner is Dave, a dyslexic enterprise architect building Ellie OS as a personal AI companion and future product for people with learning disabilities.

Memory: "${content}"

Which tier best describes this memory?
- foundational: Identity, values, relationships, vision, who people are, what matters to them
- strategic: Decisions, preferences, working style, architectural choices, the "why" behind things
- operational: Technical facts, system behavior, configs, how things work
- ephemeral: Bug details, errors, one-time incidents, transient state

Return JSON only: {"tier": "foundational|strategic|operational|ephemeral", "confidence": 0.0-1.0, "emotional_intensity": 0.0-1.0, "reasoning": "one sentence"}`;
}

export function parseDeepClassification(text: string): DeepClassificationResult {
  try {
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```\s*$/m, "");

    const parsed = JSON.parse(cleaned);
    const tier = VALID_TIERS.includes(parsed.tier) ? parsed.tier : "operational";

    return {
      tier,
      confidence: typeof parsed.confidence === "number"
        ? Math.max(0, Math.min(1, parsed.confidence))
        : DEFAULTS.confidence,
      emotional_intensity: typeof parsed.emotional_intensity === "number"
        ? Math.max(0, Math.min(1, parsed.emotional_intensity))
        : DEFAULTS.emotional_intensity,
      reasoning: parsed.reasoning || "",
    };
  } catch {
    return DEFAULTS;
  }
}

export async function classifyDeep(content: string): Promise<DeepClassificationResult> {
  if (!_anthropic) {
    return { ...DEFAULTS, reasoning: "No LLM available" };
  }

  try {
    const response = await _anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      messages: [{ role: "user", content: buildClassificationPrompt(content) }],
    });

    const text = response.content
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { type: string; text: string }) => b.text)
      .join("");

    return parseDeepClassification(text);
  } catch (err) {
    logger.error("Deep classification failed", err);
    return DEFAULTS;
  }
}

/**
 * Process a batch of memories that need deep classification.
 * Called by the periodic task. Returns count of classified memories.
 */
export async function processDeepClassificationBatch(opts?: {
  limit?: number;
}): Promise<number> {
  const limit = opts?.limit ?? 50;

  const forestSql = (await import("../../ellie-forest/src/db.ts")).default;

  const memories = await forestSql`
    SELECT id, content, confidence
    FROM shared_memories
    WHERE needs_deep_classification = true
      AND status = 'active'
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;

  if (memories.length === 0) return 0;

  let classified = 0;
  for (const mem of memories) {
    const result = await classifyDeep(mem.content);

    // Override protection: don't downgrade explicit confidence
    const newConfidence = mem.confidence > 0.7
      ? Math.max(mem.confidence, result.confidence)
      : result.confidence;

    await forestSql`
      UPDATE shared_memories
      SET content_tier = ${result.tier},
          confidence = ${newConfidence},
          emotional_intensity = ${result.emotional_intensity},
          needs_deep_classification = false,
          updated_at = NOW()
      WHERE id = ${mem.id}
    `;
    classified++;
  }

  if (classified > 0) {
    logger.info("Deep classification batch complete", { classified, total: memories.length });
  }

  return classified;
}
```

- [ ] **Step 4: Run tests**

Run: `cd /home/ellie/ellie-dev && bun test tests/deep-classifier.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/deep-classifier.ts tests/deep-classifier.test.ts
git commit -m "[ELLIE-1428] feat: LLM-assisted deep content classifier using Haiku"
```

---

### Task 5: Periodic Task for Deep Classification

Wire the deep classifier into the periodic task system so ambiguous memories get LLM-classified every 30 minutes.

**Files:**
- Modify: `ellie-dev/src/periodic-tasks.ts:264` (after weight-refresh task)
- Modify: `ellie-dev/src/relay.ts` or wherever Anthropic client is initialized — call `initDeepClassifier()`

- [ ] **Step 1: Add the periodic task**

In `ellie-dev/src/periodic-tasks.ts`, after the weight-refresh task (line 264), add:

```typescript
  // ELLIE-1428: Deep classify ambiguous memories (every 30 minutes)
  periodicTask(async () => {
    const { processDeepClassificationBatch } = await import("./deep-classifier.ts");
    const classified = await processDeepClassificationBatch({ limit: 50 });
    if (classified > 0) logger.info(`Deep-classified ${classified} memories`);
  }, 30 * 60_000, "deep-classification");
```

- [ ] **Step 2: Initialize the deep classifier with Anthropic client**

Find where `initEntailmentClassifier` is called (this is where the Anthropic client is created). Add `initDeepClassifier` alongside it:

```typescript
import { initDeepClassifier } from "./deep-classifier.ts";
// ... where initEntailmentClassifier(anthropic) is called:
initDeepClassifier(anthropic);
```

Search for the initialization site:
Run: `grep -rn "initEntailmentClassifier" src/`

- [ ] **Step 3: Run tests**

Run: `cd /home/ellie/ellie-dev && bun test`
Expected: No regressions.

- [ ] **Step 4: Commit**

```bash
git add src/periodic-tasks.ts src/relay.ts
git commit -m "[ELLIE-1428] feat: periodic deep classification task (every 30min)"
```

---

### Task 6: Catch-Up Reclassification Script

One-time script that archives clutter, runs the fast classifier on all memories, sends ambiguous ones through the LLM, and sweeps stale ephemeral content.

**Files:**
- Create: `ellie-dev/scripts/reclassify-memory-tiers.ts`

- [ ] **Step 1: Write the script**

```typescript
// ellie-dev/scripts/reclassify-memory-tiers.ts
/**
 * One-time catch-up: Reclassify all shared_memories with content tiers.
 *
 * Phase 1: Archive ELLIE-653 test artifacts
 * Phase 2: Fast-classify all active memories
 * Phase 3: Deep-classify ambiguous memories (LLM)
 * Phase 4: Sweep stale ephemeral never-accessed pre-March memories
 * Phase 5: Full weight refresh
 *
 * Usage:
 *   bun run scripts/reclassify-memory-tiers.ts [--phase N] [--dry-run]
 *
 * Run phases individually with --phase, or all in sequence without it.
 */

import forestSql from "../../ellie-forest/src/db.ts";
import { classifyContentTier } from "../../ellie-forest/src/memory-classifier.ts";
import { computeWeight } from "../../ellie-forest/src/shared-memory.ts";

const dryRun = process.argv.includes("--dry-run");
const phaseArg = process.argv.find(a => a.startsWith("--phase="));
const targetPhase = phaseArg ? parseInt(phaseArg.split("=")[1]) : 0; // 0 = all

async function phase1_archiveClutter() {
  console.log("\n=== Phase 1: Archive ELLIE-653 test artifacts ===");

  const artifacts = await forestSql`
    SELECT id, content FROM shared_memories
    WHERE status = 'active' AND content LIKE '%ELLIE-653%'
  `;

  console.log(`Found ${artifacts.length} test artifacts`);

  if (!dryRun && artifacts.length > 0) {
    await forestSql`
      UPDATE shared_memories SET status = 'archived', updated_at = NOW()
      WHERE status = 'active' AND content LIKE '%ELLIE-653%'
    `;
    console.log(`Archived ${artifacts.length} test artifacts`);
  }
}

async function phase2_fastClassify() {
  console.log("\n=== Phase 2: Fast classify all active memories ===");

  const memories = await forestSql`
    SELECT id, content, confidence, emotional_intensity
    FROM shared_memories
    WHERE status = 'active'
    ORDER BY created_at ASC
  `;

  console.log(`Processing ${memories.length} memories`);

  const stats = { foundational: 0, strategic: 0, operational: 0, ephemeral: 0, needs_deep: 0 };
  let updated = 0;

  for (const mem of memories) {
    const result = classifyContentTier(mem.content);
    stats[result.tier]++;
    if (result.needs_deep) stats.needs_deep++;

    // Don't downgrade explicit confidence
    const newConfidence = (mem.confidence > 0.7 && !result.needs_deep)
      ? Math.max(mem.confidence, result.confidence)
      : result.confidence;

    if (!dryRun) {
      await forestSql`
        UPDATE shared_memories
        SET content_tier = ${result.tier},
            confidence = ${newConfidence},
            emotional_intensity = ${result.emotional_intensity},
            needs_deep_classification = ${result.needs_deep},
            updated_at = NOW()
        WHERE id = ${mem.id}
      `;
    }

    updated++;
    if (updated % 200 === 0) {
      console.log(`  ... ${updated}/${memories.length}`);
    }
  }

  console.log("\nDistribution:");
  console.log(`  Foundational: ${stats.foundational}`);
  console.log(`  Strategic:    ${stats.strategic}`);
  console.log(`  Operational:  ${stats.operational}`);
  console.log(`  Ephemeral:    ${stats.ephemeral}`);
  console.log(`  Needs deep:   ${stats.needs_deep}`);
}

async function phase3_deepClassify() {
  console.log("\n=== Phase 3: Deep classify ambiguous memories ===");

  // Initialize Anthropic client
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const anthropic = new Anthropic();
  const { initDeepClassifier, processDeepClassificationBatch } = await import("../src/deep-classifier.ts");
  initDeepClassifier(anthropic);

  let totalClassified = 0;
  let batch: number;

  do {
    batch = await processDeepClassificationBatch({ limit: 50 });
    totalClassified += batch;
    if (batch > 0) {
      console.log(`  Classified batch of ${batch} (total: ${totalClassified})`);
    }
  } while (batch > 0);

  console.log(`Deep classification complete: ${totalClassified} memories classified`);
}

async function phase4_sweepStale() {
  console.log("\n=== Phase 4: Sweep stale ephemeral never-accessed pre-March memories ===");

  const stale = await forestSql`
    SELECT id, content FROM shared_memories
    WHERE status = 'active'
      AND content_tier = 'ephemeral'
      AND last_accessed_at IS NULL
      AND created_at < '2026-03-01'
  `;

  console.log(`Found ${stale.length} stale ephemeral memories to archive`);

  if (!dryRun && stale.length > 0) {
    await forestSql`
      UPDATE shared_memories SET status = 'archived', updated_at = NOW()
      WHERE status = 'active'
        AND content_tier = 'ephemeral'
        AND last_accessed_at IS NULL
        AND created_at < '2026-03-01'
    `;
    console.log(`Archived ${stale.length} stale memories`);
  }
}

async function phase5_refreshWeights() {
  console.log("\n=== Phase 5: Full weight refresh ===");

  const { refreshWeights } = await import("../../ellie-forest/src/shared-memory.ts");

  let total = 0;
  let batch: number;
  do {
    batch = await refreshWeights({ limit: 500 });
    total += batch;
    if (batch > 0) console.log(`  Refreshed ${total} weights...`);
  } while (batch >= 500);

  console.log(`Weight refresh complete: ${total} memories updated`);
}

async function main() {
  console.log(`Memory Tier Reclassification ${dryRun ? "(DRY RUN)" : ""}`);

  if (targetPhase === 0 || targetPhase === 1) await phase1_archiveClutter();
  if (targetPhase === 0 || targetPhase === 2) await phase2_fastClassify();
  if (targetPhase === 0 || targetPhase === 3) await phase3_deepClassify();
  if (targetPhase === 0 || targetPhase === 4) await phase4_sweepStale();
  if (targetPhase === 0 || targetPhase === 5) await phase5_refreshWeights();

  // Show final stats
  console.log("\n=== Final Distribution ===");
  const stats = await forestSql`
    SELECT
      content_tier,
      count(*) as cnt,
      round(avg(confidence)::numeric, 2) as avg_conf,
      round(avg(weight)::numeric, 3) as avg_weight,
      round(avg(emotional_intensity)::numeric, 2) as avg_ei
    FROM shared_memories WHERE status = 'active'
    GROUP BY content_tier
    ORDER BY avg_weight DESC
  `;
  console.table(stats);

  process.exit(0);
}

main().catch(err => {
  console.error("Reclassification failed:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Run Phase 1 and 2 as dry-run**

Run: `cd /home/ellie/ellie-dev && bun run scripts/reclassify-memory-tiers.ts --dry-run`
Expected: Shows distribution counts without modifying data.

- [ ] **Step 3: Commit**

```bash
git add scripts/reclassify-memory-tiers.ts
git commit -m "[ELLIE-1428] feat: one-time memory tier reclassification script"
```

---

### Task 7: Integration Test

Deploy, run the catch-up, and verify the weight distribution has shifted.

**Files:**
- No new files — integration testing

- [ ] **Step 1: Apply the migration**

Run: `psql -U ellie -d ellie-forest -f migrations/forest/20260405_content_tier_column.sql`

- [ ] **Step 2: Restart relay to pick up new code**

Run: `systemctl --user restart ellie-chat-relay && sleep 3 && systemctl --user status ellie-chat-relay | head -3`

- [ ] **Step 3: Run the catch-up — Phase 1 (archive clutter)**

Run: `cd /home/ellie/ellie-dev && bun run scripts/reclassify-memory-tiers.ts --phase=1`
Expected: Archives 68 ELLIE-653 test artifacts.

- [ ] **Step 4: Run Phase 2 (fast classify)**

Run: `cd /home/ellie/ellie-dev && bun run scripts/reclassify-memory-tiers.ts --phase=2`
Expected: Shows distribution with foundational/strategic/operational/ephemeral counts.

- [ ] **Step 5: Run Phase 3 (deep classify)**

Run: `cd /home/ellie/ellie-dev && bun run scripts/reclassify-memory-tiers.ts --phase=3`
Expected: Classifies ~500-600 ambiguous memories via Haiku.

- [ ] **Step 6: Run Phase 4 (sweep stale)**

Run: `cd /home/ellie/ellie-dev && bun run scripts/reclassify-memory-tiers.ts --phase=4`
Expected: Archives stale ephemeral never-accessed pre-March memories.

- [ ] **Step 7: Run Phase 5 (weight refresh)**

Run: `cd /home/ellie/ellie-dev && bun run scripts/reclassify-memory-tiers.ts --phase=5`
Expected: All weights recalculated.

- [ ] **Step 8: Verify success criteria**

```bash
# Check the key identity memory has high weight
psql -U ellie -d ellie-forest -c "
  SELECT content_tier, confidence, emotional_intensity, weight
  FROM shared_memories
  WHERE content ILIKE '%rejects the framing of learning disability%'
  AND status = 'active';
"
# Expected: content_tier=foundational, confidence>=0.9, weight>=0.40

# Check ephemeral memory has low weight
psql -U ellie -d ellie-forest -c "
  SELECT content_tier, confidence, emotional_intensity, weight
  FROM shared_memories
  WHERE content ILIKE '%crash-looped 15,336%'
  AND status = 'active';
"
# Expected: content_tier=ephemeral, confidence<=0.5, weight<=0.25

# Check overall distribution
psql -U ellie -d ellie-forest -c "
  SELECT content_tier, count(*), round(avg(weight)::numeric, 3) as avg_weight
  FROM shared_memories WHERE status = 'active'
  GROUP BY content_tier ORDER BY avg_weight DESC;
"
# Expected: 4 tiers with differentiated weights
```

- [ ] **Step 9: Write a new memory and verify auto-classification**

```bash
curl -s -X POST http://localhost:3001/api/bridge/write \
  -H "Content-Type: application/json" \
  -H "x-bridge-key: bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a" \
  -d '{
    "content": "Dave believes that technology should adapt to people, not the other way around. This is the core of everything Ellie does.",
    "type": "fact",
    "scope_path": "E/1"
  }'

# Check it was auto-classified as foundational
psql -U ellie -d ellie-forest -c "
  SELECT content_tier, confidence, emotional_intensity, weight
  FROM shared_memories
  WHERE content ILIKE '%technology should adapt to people%'
  AND status = 'active';
"
# Expected: content_tier=foundational, confidence>=0.9, weight>=0.50
```

- [ ] **Step 10: Clean up test memory and commit**

```bash
psql -U ellie -d ellie-forest -c "
  DELETE FROM shared_memories WHERE content ILIKE '%technology should adapt to people%';
"

git commit --allow-empty -m "[ELLIE-1428] chore: memory tier reclassification verified — integration complete"
```

---

## Summary

| Task | What it builds | Key files |
|------|---------------|-----------|
| 1 | DB columns for tier + deep flag | `migrations/forest/20260405_content_tier_column.sql` |
| 2 | Fast regex classifier | `ellie-forest/src/memory-classifier.ts` |
| 3 | Wire into writeMemory() | `ellie-forest/src/shared-memory.ts` |
| 4 | LLM deep classifier | `ellie-dev/src/deep-classifier.ts` |
| 5 | Periodic task for deep classification | `ellie-dev/src/periodic-tasks.ts` |
| 6 | Catch-up reclassification script | `ellie-dev/scripts/reclassify-memory-tiers.ts` |
| 7 | Integration test | Manual verification |
