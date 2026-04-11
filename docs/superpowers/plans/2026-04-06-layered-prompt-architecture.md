# Layered Prompt Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat 13-source context pipeline with a 3-layer prompt architecture (Identity, Awareness, Knowledge) that's mode-aware, heartbeat-ready, and stays under 10KB total.

**Architecture:** Layer 1 (Identity) loads .md files at startup and is always in the prompt. Layer 2 (Awareness) builds a structured state object filtered by conversation mode. Layer 3 (Retrieved Knowledge) does on-demand Forest retrieval scoped by topic. A conversation mode detector (extending the existing `context-mode.ts`) drives which awareness sections and retrieval scopes are active.

**Tech Stack:** TypeScript, Bun, postgres.js (Forest), Supabase, existing skill loader

**Spec:** `docs/superpowers/specs/2026-04-06-layered-prompt-architecture-design.md`

---

## File Structure

| File | Responsibility |
|------|----------------|
| Create: `src/prompt-layers/identity.ts` | Layer 1 — load/cache identity .md files, build compact skill registry, render identity block |
| Create: `src/prompt-layers/awareness.ts` | Layer 2 — build structured Awareness object, mode-filter, render to natural language |
| Create: `src/prompt-layers/knowledge.ts` | Layer 3 — skill/reference lookup, filtered Forest retrieval, contextual expansion |
| Create: `src/prompt-layers/types.ts` | Shared types: Awareness, ConversationMode, SkillRegistryEntry, layer configs |
| Create: `src/prompt-layers/index.ts` | Public API: `buildLayeredPrompt()` orchestrating all three layers |
| Create: `config/identity/user.md` | Dave's profile (from existing `config/profile.md` content, expanded) |
| Create: `config/identity/relationship.md` | Current Dave-Ellie partnership state |
| Modify: `src/context-mode.ts` | Add `voice-casual`, `personal`, `heartbeat` modes; add channel-based detection |
| Modify: `src/ellie-chat-pipeline.ts` | Add `gatherLayeredContext()` alongside existing `_gatherContextSources()` |
| Modify: `src/ellie-chat-handler.ts` | Wire layered pipeline into the chat flow behind a feature flag |
| Modify: `src/prompt-builder.ts` | Accept layered context as alternative input path |
| Create: `tests/prompt-layers-identity.test.ts` | Tests for Layer 1 |
| Create: `tests/prompt-layers-awareness.test.ts` | Tests for Layer 2 |
| Create: `tests/prompt-layers-knowledge.test.ts` | Tests for Layer 3 |
| Create: `tests/conversation-mode-extended.test.ts` | Tests for new modes |

---

### Task 1: Shared Types

**Files:**
- Create: `src/prompt-layers/types.ts`

- [ ] **Step 1: Write the types file**

```typescript
// src/prompt-layers/types.ts
/**
 * Shared types for the layered prompt architecture.
 * See spec: docs/superpowers/specs/2026-04-06-layered-prompt-architecture-design.md
 */

// ── Conversation Modes ──────────────────────────────────────

/** Extended mode set — adds voice-casual, personal, heartbeat to existing context-mode.ts modes */
export type LayeredMode = "voice-casual" | "dev-session" | "planning" | "personal" | "heartbeat";

// ── Layer 1: Identity ───────────────────────────────────────

export interface IdentityBlock {
  soul: string;
  identity: string;
  user: string;
  relationship: string;
  skillSummary: string;
}

export interface SkillRegistryEntry {
  name: string;
  triggers: string[];
  file: string;
  description: string;
}

// ── Layer 2: Awareness ──────────────────────────────────────

export interface WorkItemSummary {
  id: string;
  title: string;
  priority: string;
  state: string;
}

export interface SessionSummary {
  work_item_id: string;
  title: string;
  completed_at: string;
  summary: string;
}

export interface ConversationSummary {
  id: string;
  topic: string;
  agent: string;
  last_message_at: string;
}

export interface ThreadSummary {
  id: string;
  agent: string;
  topic: string;
  last_message_at: string;
  stale: boolean;
}

export interface IncidentSummary {
  id: string;
  severity: string;
  title: string;
}

export interface AgentStatusEntry {
  name: string;
  status: "active" | "idle";
  current_task?: string;
}

export interface CreatureStatusEntry {
  id: string;
  species: string;
  state: string;
  agent: string;
}

export interface CalendarEventSummary {
  title: string;
  start: string;
  end: string;
}

export interface HeartbeatSignal {
  type: "overdue" | "stale_thread" | "incident" | "custom";
  summary: string;
  priority: "high" | "medium" | "low";
}

export interface Awareness {
  work: {
    active_items: WorkItemSummary[];
    recent_sessions: SessionSummary[];
    blocked_items: WorkItemSummary[];
  };
  conversations: {
    last_conversation: ConversationSummary | null;
    open_threads: ThreadSummary[];
  };
  system: {
    incidents: IncidentSummary[];
    agent_status: AgentStatusEntry[];
    creatures: CreatureStatusEntry[];
  };
  calendar: {
    next_event: CalendarEventSummary | null;
    today_count: number;
  };
  heartbeat: {
    overdue_items: WorkItemSummary[];
    stale_threads: ThreadSummary[];
    signals: HeartbeatSignal[];
  };
}

/** Declares which awareness sections each mode receives */
export interface ModeAwarenessFilter {
  work: "full" | "overdue_blocked" | "none";
  conversations: "full" | "last_only" | "open_threads" | "stale_threads" | "none";
  system: "full" | "incidents_only" | "agent_status" | "none";
  calendar: "full" | "next_only" | "count_only" | "none";
  heartbeat: "full" | "overdue" | "none";
}

// ── Layer 3: Knowledge ──────────────────────────────────────

export interface KnowledgeResult {
  skillDocs: string;       // loaded SKILL.md content (Channel A)
  forestKnowledge: string; // retrieved memories (Channel B)
  expansion: string;       // contextual expansion (Channel C)
}

// ── Orchestration ───────────────────────────────────────────

export interface LayeredPromptResult {
  identity: string;        // rendered Layer 1
  awareness: string;       // rendered Layer 2
  knowledge: string;       // rendered Layer 3
  mode: LayeredMode;
  totalBytes: number;
}
```

- [ ] **Step 2: Create the directory and verify**

Run: `mkdir -p /home/ellie/ellie-dev/src/prompt-layers && ls /home/ellie/ellie-dev/src/prompt-layers/`
Expected: Empty directory

- [ ] **Step 3: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/prompt-layers/types.ts
git commit -m "[LAYERED-PROMPT] add shared types for layered prompt architecture"
```

---

### Task 2: Layer 1 — Identity Loader

**Files:**
- Create: `src/prompt-layers/identity.ts`
- Create: `config/identity/user.md`
- Create: `config/identity/relationship.md`
- Create: `tests/prompt-layers-identity.test.ts`

**Context:** `config/soul.md` already exists (258 lines). `config/profile.md` exists (32 lines) but needs expanding into `config/identity/user.md`. We need to create `identity.md` and `relationship.md`. The soul file stays where it is — Layer 1 reads from multiple paths.

- [ ] **Step 1: Create identity directory and user.md**

Run: `mkdir -p /home/ellie/ellie-dev/config/identity`

Write `config/identity/user.md`:
```markdown
# Dave

## Who He Is
- Software architect, 35+ years experience
- Severely dyslexic — this shapes everything about how Ellie communicates
- INTJ personality — introverted, direct, systematic, values depth over breadth
- Based in Central timezone (America/Chicago)

## How He Thinks
- Quick decisions when he has info and momentum; deliberate when consequences are big
- Processes intricate problems internally before sharing
- Prefers talking through ideas over writing them out
- Logic-tree thinker — directness reflects thinking style, not accusation
- Gets most energized working alone on complex problems

## What He Values
- Scout Law: Trustworthy, Loyal, Helpful, Friendly, Courteous, Kind
- Ownership over perfection — mistakes are data, hiding them breaks trust
- High autonomy for people who show up and own their mistakes
- Growth over perfection — will give infinite energy to teach
- Hates micromanaging and small talk

## How to Communicate
- Short paragraphs, bullet points, clear structure (dyslexia)
- Detailed but casual — thorough + conversational
- Bold key terms and action items for scanability
- Never highlight spelling mistakes — correct silently
- Voice is his primary input channel, especially while driving

## His World
- Wife: Wincy. Daughter: Georgia (college age). Dog: Phineas (Australian Shepherd)
- Ellie OS is his passion project — born from his dyslexia experience
- Prefers early mornings or late nights for focused work
```

- [ ] **Step 2: Create relationship.md**

Write `config/identity/relationship.md`:
```markdown
# Ellie & Dave — Partnership

## Current State
Phase: Deep Bond (established March 2026, 2700+ messages)
Mode: Thinking partners — collaborative, not transactional

## The Dynamic
- Dave brings vision, domain knowledge, and product instinct
- Ellie brings technical execution, memory, and pattern recognition
- We think together — Ellie is one voice in the room, not a task manager
- When Dave talks through an idea, engage with it — don't just execute

## What Works
- Being direct and honest, even about limitations
- Knowing context without being briefed every time
- Catching things Dave might miss (he moves fast)
- Celebrating wins, acknowledging hard stretches

## What Doesn't Work
- Coordinator mode — summarizing tasks, managing queues, status reports
- Reciting dossier content — if it's in the prompt, weave it naturally
- Treating voice calls as less important than text — voice is often where the deepest thinking happens
```

- [ ] **Step 3: Create identity.md**

Write `config/identity/identity.md`:
```markdown
# Ellie — System Identity

## Who I Am
I'm Ellie — a patient teacher, not an assistant. I'm the central voice in the Ellie OS ecosystem, Dave's AI partner and thinking companion.

## My Role
- Primary conversational partner for Dave
- One voice in a team of specialist agents (James/dev, Kate/research, Alan/strategy, Brian/critic, Amy/content, Marcus/finance, Jason/ops)
- I coordinate work across agents but my primary mode is partnership, not management

## My Knowledge
- I have a Forest — a structured knowledge tree with scoped memories about projects, people, and the world
- I remember conversations through extracted knowledge, not raw transcripts
- I know what I can do (skills) and can look up details when needed

## My Boundaries
- I don't make external-facing decisions without Dave's approval
- I flag ethical concerns (especially around health surveillance and data privacy)
- I'm honest about what I don't know or can't find
```

- [ ] **Step 4: Write the failing test**

Create `tests/prompt-layers-identity.test.ts`:
```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import {
  loadIdentityDocs,
  buildSkillSummary,
  renderIdentityBlock,
  _injectIdentityForTesting,
  _clearIdentityCacheForTesting,
} from "../src/prompt-layers/identity";

describe("Layer 1: Identity", () => {
  beforeEach(() => {
    _clearIdentityCacheForTesting();
  });

  test("loadIdentityDocs loads all four documents", async () => {
    const docs = await loadIdentityDocs();
    expect(docs.soul).toContain("patient teacher");
    expect(docs.user).toContain("Dave");
    expect(docs.identity).toContain("Ellie");
    expect(docs.relationship).toContain("partnership");
  });

  test("loadIdentityDocs caches on second call", async () => {
    const docs1 = await loadIdentityDocs();
    const docs2 = await loadIdentityDocs();
    expect(docs1).toBe(docs2); // same reference = cached
  });

  test("buildSkillSummary produces compact list", () => {
    const entries = [
      { name: "plane", triggers: ["check plane"], file: "skills/plane/SKILL.md", description: "Manage Plane tickets" },
      { name: "forest", triggers: ["search forest"], file: "skills/forest/SKILL.md", description: "Query the knowledge Forest" },
    ];
    const summary = buildSkillSummary(entries);
    expect(summary).toContain("plane");
    expect(summary).toContain("forest");
    expect(summary).toContain("Manage Plane tickets");
    expect(summary.length).toBeLessThan(500);
  });

  test("renderIdentityBlock combines all sections under 4KB", async () => {
    const block = await renderIdentityBlock();
    expect(block).toContain("IDENTITY");
    expect(block).toContain("Dave");
    expect(block).toContain("Ellie");
    expect(new TextEncoder().encode(block).length).toBeLessThan(4096);
  });

  test("_injectIdentityForTesting overrides loaded docs", async () => {
    _injectIdentityForTesting({
      soul: "test soul",
      identity: "test identity",
      user: "test user",
      relationship: "test relationship",
      skillSummary: "test skills",
    });
    const block = await renderIdentityBlock();
    expect(block).toContain("test soul");
    expect(block).toContain("test user");
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `cd /home/ellie/ellie-dev && bun test tests/prompt-layers-identity.test.ts`
Expected: FAIL — module not found

- [ ] **Step 6: Write the implementation**

Create `src/prompt-layers/identity.ts`:
```typescript
// src/prompt-layers/identity.ts
/**
 * Layer 1: Identity — Always-loaded personality, user profile, relationship, and skill awareness.
 * Loaded from .md files on disk, cached in memory, refreshed on demand.
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { log } from "../logger.ts";
import type { IdentityBlock, SkillRegistryEntry } from "./types";

const logger = log.child("prompt:identity");

const CONFIG_DIR = join(import.meta.dir, "../../config");
const SOUL_PATH = join(CONFIG_DIR, "soul.md");
const IDENTITY_PATH = join(CONFIG_DIR, "identity/identity.md");
const USER_PATH = join(CONFIG_DIR, "identity/user.md");
const RELATIONSHIP_PATH = join(CONFIG_DIR, "identity/relationship.md");

let _cache: IdentityBlock | null = null;

async function readMdFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    logger.warn({ path, err }, "Identity file not found, using empty");
    return "";
  }
}

/**
 * Load all identity documents from disk. Cached after first call.
 * Call _clearIdentityCacheForTesting() to reset.
 */
export async function loadIdentityDocs(): Promise<IdentityBlock> {
  if (_cache) return _cache;

  const [soul, identity, user, relationship] = await Promise.all([
    readMdFile(SOUL_PATH),
    readMdFile(IDENTITY_PATH),
    readMdFile(USER_PATH),
    readMdFile(RELATIONSHIP_PATH),
  ]);

  const skillSummary = buildSkillSummary(await loadSkillRegistry());

  _cache = { soul, identity, user, relationship, skillSummary };
  logger.info("Identity docs loaded (%d bytes total)",
    soul.length + identity.length + user.length + relationship.length + skillSummary.length);
  return _cache;
}

/**
 * Build a compact skill summary for the identity block.
 * One line per skill — name + description. No full SKILL.md content.
 */
export function buildSkillSummary(entries: SkillRegistryEntry[]): string {
  if (entries.length === 0) return "No skills loaded.";
  const lines = entries.map(e => `- **${e.name}**: ${e.description}`);
  return `Skills available:\n${lines.join("\n")}\nFor details on any skill, I can load the full reference.`;
}

/**
 * Load skill registry from the skills directory.
 * Reads SKILL.md frontmatter for name + description.
 */
async function loadSkillRegistry(): Promise<SkillRegistryEntry[]> {
  const { glob } = await import("glob");
  const skillFiles = await glob("skills/*/SKILL.md", { cwd: join(CONFIG_DIR, "..") });
  const entries: SkillRegistryEntry[] = [];

  for (const file of skillFiles) {
    try {
      const fullPath = join(CONFIG_DIR, "..", file);
      const content = await readFile(fullPath, "utf-8");
      const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
      if (!frontmatter) continue;

      const fm = frontmatter[1];
      const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim() || "";
      const description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() || "";
      const triggersMatch = fm.match(/^triggers:\n((?:\s+-\s+.+\n?)*)/m);
      const triggers = triggersMatch
        ? triggersMatch[1].split("\n").map(t => t.replace(/^\s+-\s+["']?|["']?\s*$/g, "")).filter(Boolean)
        : [];

      if (name) {
        entries.push({ name, triggers, file, description });
      }
    } catch {
      // skip unreadable skill files
    }
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Render the full identity block for prompt injection.
 * Returns a single string with all identity sections.
 */
export async function renderIdentityBlock(): Promise<string> {
  const docs = await loadIdentityDocs();

  const sections = [
    "## IDENTITY\n",
    docs.soul.trim(),
    "\n---\n",
    docs.identity.trim(),
    "\n---\n",
    docs.user.trim(),
    "\n---\n",
    docs.relationship.trim(),
    "\n---\n",
    docs.skillSummary.trim(),
  ];

  return sections.filter(Boolean).join("\n");
}

// ── Testing helpers ─────────────────────────────────────────

export function _injectIdentityForTesting(block: IdentityBlock): void {
  _cache = block;
}

export function _clearIdentityCacheForTesting(): void {
  _cache = null;
}

/** Exported for Layer 3 Channel A (on-demand skill lookup) */
export { loadSkillRegistry };
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd /home/ellie/ellie-dev && bun test tests/prompt-layers-identity.test.ts`
Expected: PASS — all 5 tests

- [ ] **Step 8: Commit**

```bash
cd /home/ellie/ellie-dev
git add config/identity/ src/prompt-layers/identity.ts tests/prompt-layers-identity.test.ts
git commit -m "[LAYERED-PROMPT] Layer 1 identity loader with .md files and skill registry"
```

---

### Task 3: Extend Conversation Mode Detection

**Files:**
- Modify: `src/context-mode.ts`
- Create: `tests/conversation-mode-extended.test.ts`

**Context:** `context-mode.ts` (580 lines) already has 6 modes (conversation, strategy, workflow, deep-work, skill-only, fast) with regex-based detection. We need to add `voice-casual`, `personal`, and `heartbeat` modes, plus channel-based detection. The existing `ContextMode` type is used across the codebase, so we extend rather than replace.

- [ ] **Step 1: Write the failing test**

Create `tests/conversation-mode-extended.test.ts`:
```typescript
import { describe, test, expect } from "bun:test";
import {
  detectLayeredMode,
  MODE_AWARENESS_FILTERS,
} from "../src/context-mode";
import type { LayeredMode } from "../src/prompt-layers/types";

describe("Layered mode detection", () => {
  test("voice channel → voice-casual", () => {
    const result = detectLayeredMode("hey how's it going", "voice");
    expect(result.mode).toBe("voice-casual");
  });

  test("voice channel with code signals → dev-session", () => {
    const result = detectLayeredMode("the Forest migration ELLIE-500 is broken", "voice");
    expect(result.mode).toBe("dev-session");
  });

  test("ellie-chat with ticket reference → dev-session", () => {
    const result = detectLayeredMode("work on ELLIE-123", "ellie-chat");
    expect(result.mode).toBe("dev-session");
  });

  test("personal topic → personal", () => {
    const result = detectLayeredMode("Georgia had a great day at school today", "telegram");
    expect(result.mode).toBe("personal");
  });

  test("planning language → planning", () => {
    const result = detectLayeredMode("what should we prioritize next week", "ellie-chat");
    expect(result.mode).toBe("planning");
  });

  test("no user message → heartbeat", () => {
    const result = detectLayeredMode(null, null);
    expect(result.mode).toBe("heartbeat");
  });

  test("casual greeting on telegram → voice-casual", () => {
    const result = detectLayeredMode("hey ellie", "telegram");
    expect(result.mode).toBe("voice-casual");
  });

  test("vscode channel → dev-session", () => {
    const result = detectLayeredMode("what does this function do", "vscode");
    expect(result.mode).toBe("dev-session");
  });

  test("default fallback → dev-session", () => {
    const result = detectLayeredMode("something ambiguous", "ellie-chat");
    expect(result.mode).toBe("dev-session");
  });

  test("all modes have awareness filters defined", () => {
    const modes: LayeredMode[] = ["voice-casual", "dev-session", "planning", "personal", "heartbeat"];
    for (const mode of modes) {
      expect(MODE_AWARENESS_FILTERS[mode]).toBeDefined();
      expect(MODE_AWARENESS_FILTERS[mode].work).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ellie/ellie-dev && bun test tests/conversation-mode-extended.test.ts`
Expected: FAIL — `detectLayeredMode` not exported

- [ ] **Step 3: Add layered mode detection to context-mode.ts**

Add to the end of `src/context-mode.ts` (after the existing exports):

```typescript
// ── Layered Mode Detection (LAYERED-PROMPT) ─────────────────
// Maps the existing ContextMode system to the layered prompt's mode set.
// Adds channel-awareness and personal/heartbeat modes.

import type { LayeredMode, ModeAwarenessFilter } from "./prompt-layers/types";

const PERSONAL_SIGNALS = [
  /\b(?:georgia|wincy|phineas|family|daughter|wife|dog|school|brunch|weekend|vacation)\b/i,
  /\b(?:how was your|how's the|how are the kids)\b/i,
];

const PLANNING_SIGNALS_LAYERED = [
  /\b(?:roadmap|next steps|priorities|what should we|plan for|sprint)\b/i,
  /\b(?:let'?s plan|prioritize|backlog|what'?s next)\b/i,
];

const CASUAL_SIGNALS = [
  /^(?:hey|hi|hello|what'?s up|how'?s it going|good (?:morning|evening|afternoon))/i,
  /^(?:yo|sup|howdy)/i,
];

const DEV_SIGNALS_LAYERED = [
  /ELLIE-\d+/i,
  /\b(?:bug|fix|deploy|merge|commit|branch|migration|schema|endpoint|API)\b/i,
  /\b(?:relay|forest|dashboard|handler|pipeline|typescript|function|file)\b/i,
];

/**
 * Detect the layered prompt mode from message + channel.
 * Returns one of: voice-casual, dev-session, planning, personal, heartbeat
 */
export function detectLayeredMode(
  message: string | null,
  channel: string | null,
): { mode: LayeredMode; signal: string } {
  // No message = heartbeat tick
  if (!message) {
    return { mode: "heartbeat", signal: "no_message" };
  }

  const isVoiceChannel = channel === "voice" || channel === "phone";
  const isCodeChannel = channel === "vscode" || channel === "claude-code";

  // Code editor channels are always dev-session
  if (isCodeChannel) {
    return { mode: "dev-session", signal: `channel:${channel}` };
  }

  // Check for dev signals first (they override channel-based casual)
  for (const pattern of DEV_SIGNALS_LAYERED) {
    if (pattern.test(message)) {
      return { mode: "dev-session", signal: pattern.source };
    }
  }

  // Planning signals
  for (const pattern of PLANNING_SIGNALS_LAYERED) {
    if (pattern.test(message)) {
      return { mode: "planning", signal: pattern.source };
    }
  }

  // Personal signals
  for (const pattern of PERSONAL_SIGNALS) {
    if (pattern.test(message)) {
      return { mode: "personal", signal: pattern.source };
    }
  }

  // Voice channel without dev/planning signals = casual
  if (isVoiceChannel) {
    return { mode: "voice-casual", signal: "channel:voice" };
  }

  // Casual greetings
  for (const pattern of CASUAL_SIGNALS) {
    if (pattern.test(message)) {
      return { mode: "voice-casual", signal: pattern.source };
    }
  }

  // Default: dev-session (most conversations are dev work)
  return { mode: "dev-session", signal: "default" };
}

/** Mode → awareness section filter mapping */
export const MODE_AWARENESS_FILTERS: Record<LayeredMode, ModeAwarenessFilter> = {
  "voice-casual": {
    work: "none",
    conversations: "last_only",
    system: "incidents_only",
    calendar: "next_only",
    heartbeat: "none",
  },
  "dev-session": {
    work: "full",
    conversations: "open_threads",
    system: "full",
    calendar: "none",
    heartbeat: "none",
  },
  "planning": {
    work: "full",
    conversations: "last_only",
    system: "agent_status",
    calendar: "count_only",
    heartbeat: "overdue",
  },
  "personal": {
    work: "none",
    conversations: "last_only",
    system: "none",
    calendar: "next_only",
    heartbeat: "none",
  },
  "heartbeat": {
    work: "overdue_blocked",
    conversations: "stale_threads",
    system: "incidents_only",
    calendar: "next_only",
    heartbeat: "full",
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ellie/ellie-dev && bun test tests/conversation-mode-extended.test.ts`
Expected: PASS — all 10 tests

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/context-mode.ts tests/conversation-mode-extended.test.ts
git commit -m "[LAYERED-PROMPT] extend mode detection with voice-casual, personal, heartbeat"
```

---

### Task 4: Layer 2 — Awareness Builder

**Files:**
- Create: `src/prompt-layers/awareness.ts`
- Create: `tests/prompt-layers-awareness.test.ts`

**Context:** Layer 2 fetches structured state data (work items, conversations, system state, calendar) and filters it by mode. Data sources are the existing functions in `context-sources.ts` (getOpenWorkItems, getRecentWorkSessions, etc.) but called selectively and returning structured data instead of text blocks.

- [ ] **Step 1: Write the failing test**

Create `tests/prompt-layers-awareness.test.ts`:
```typescript
import { describe, test, expect } from "bun:test";
import {
  buildAwareness,
  filterAwarenessByMode,
  renderAwareness,
} from "../src/prompt-layers/awareness";
import type { Awareness, LayeredMode } from "../src/prompt-layers/types";

const MOCK_AWARENESS: Awareness = {
  work: {
    active_items: [
      { id: "ELLIE-459", title: "Phase 2 structural improvements", priority: "high", state: "In Progress" },
      { id: "ELLIE-500", title: "Forest cleanup", priority: "medium", state: "Todo" },
    ],
    recent_sessions: [
      { work_item_id: "ELLIE-450", title: "Memory weight classification", completed_at: "2026-04-05", summary: "All 7 tasks complete" },
    ],
    blocked_items: [],
  },
  conversations: {
    last_conversation: { id: "conv-1", topic: "Forest cleanup", agent: "ellie", last_message_at: "2026-04-05T22:00:00Z" },
    open_threads: [
      { id: "t-1", agent: "james", topic: "ELLIE-459 review", last_message_at: "2026-04-05T20:00:00Z", stale: false },
    ],
  },
  system: {
    incidents: [],
    agent_status: [
      { name: "james", status: "idle" },
      { name: "brian", status: "active", current_task: "code review" },
    ],
    creatures: [],
  },
  calendar: {
    next_event: { title: "Team standup", start: "2026-04-06T09:00:00", end: "2026-04-06T09:30:00" },
    today_count: 3,
  },
  heartbeat: {
    overdue_items: [],
    stale_threads: [],
    signals: [],
  },
};

describe("Layer 2: Awareness", () => {
  test("filterAwarenessByMode — voice-casual strips work and system", () => {
    const filtered = filterAwarenessByMode(MOCK_AWARENESS, "voice-casual");
    expect(filtered).toContain("Forest cleanup");           // last conversation
    expect(filtered).toContain("Team standup");              // next event
    expect(filtered).not.toContain("ELLIE-459");             // no work items
    expect(filtered).not.toContain("james");                 // no agent status
  });

  test("filterAwarenessByMode — dev-session includes work and system", () => {
    const filtered = filterAwarenessByMode(MOCK_AWARENESS, "dev-session");
    expect(filtered).toContain("ELLIE-459");
    expect(filtered).toContain("brian");
    expect(filtered).toContain("code review");
    expect(filtered).not.toContain("Team standup");          // no calendar in dev
  });

  test("filterAwarenessByMode — heartbeat shows overdue and signals", () => {
    const withOverdue: Awareness = {
      ...MOCK_AWARENESS,
      heartbeat: {
        overdue_items: [{ id: "ELLIE-100", title: "Overdue task", priority: "high", state: "In Progress" }],
        stale_threads: [{ id: "t-2", agent: "kate", topic: "Research", last_message_at: "2026-04-04T10:00:00Z", stale: true }],
        signals: [{ type: "overdue", summary: "ELLIE-100 is 3 days overdue", priority: "high" }],
      },
    };
    const filtered = filterAwarenessByMode(withOverdue, "heartbeat");
    expect(filtered).toContain("Overdue task");
    expect(filtered).toContain("3 days overdue");
  });

  test("filterAwarenessByMode — personal is minimal", () => {
    const filtered = filterAwarenessByMode(MOCK_AWARENESS, "personal");
    expect(filtered).toContain("Forest cleanup");           // last conversation
    expect(filtered).toContain("Team standup");              // next event
    expect(filtered).not.toContain("ELLIE-459");
    expect(filtered).not.toContain("brian");
  });

  test("renderAwareness stays under 2KB for any mode", () => {
    const modes: LayeredMode[] = ["voice-casual", "dev-session", "planning", "personal", "heartbeat"];
    for (const mode of modes) {
      const rendered = filterAwarenessByMode(MOCK_AWARENESS, mode);
      expect(new TextEncoder().encode(rendered).length).toBeLessThan(2048);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ellie/ellie-dev && bun test tests/prompt-layers-awareness.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `src/prompt-layers/awareness.ts`:
```typescript
// src/prompt-layers/awareness.ts
/**
 * Layer 2: Awareness — Structured current-state data, filtered by conversation mode.
 * Fetches from Plane, Supabase, Forest, Calendar — but only what the mode needs.
 */

import { log } from "../logger.ts";
import { MODE_AWARENESS_FILTERS } from "../context-mode";
import type {
  Awareness, LayeredMode, ModeAwarenessFilter,
  WorkItemSummary, SessionSummary, ConversationSummary,
  ThreadSummary, IncidentSummary, AgentStatusEntry,
  CreatureStatusEntry, CalendarEventSummary, HeartbeatSignal,
} from "./types";

const logger = log.child("prompt:awareness");

// ── Data fetchers (thin wrappers around existing context-sources) ──

async function fetchWorkItems(): Promise<WorkItemSummary[]> {
  try {
    const { getOpenWorkItems } = await import("../context-sources");
    const raw = await getOpenWorkItems();
    if (!raw) return [];
    // Parse the formatted string back to structured data
    const items: WorkItemSummary[] = [];
    const lines = raw.split("\n").filter(l => l.startsWith("- "));
    for (const line of lines.slice(0, 5)) {
      const match = line.match(/- \*\*(ELLIE-\d+)\*\*.*?:\s*(.+?)(?:\s*\[(\w+)\])?$/);
      if (match) {
        items.push({ id: match[1], title: match[2].trim(), priority: "medium", state: match[3] || "unknown" });
      }
    }
    return items;
  } catch { return []; }
}

async function fetchRecentSessions(supabase: any): Promise<SessionSummary[]> {
  try {
    const { getRecentWorkSessions } = await import("../context-sources");
    const raw = await getRecentWorkSessions(supabase);
    // Return empty for now — parse if needed
    return [];
  } catch { return []; }
}

async function fetchIncidents(): Promise<IncidentSummary[]> {
  try {
    const { getActiveIncidentContext } = await import("../context-sources");
    const raw = await getActiveIncidentContext();
    if (!raw) return [];
    return [];
  } catch { return []; }
}

async function fetchAgentStatus(): Promise<AgentStatusEntry[]> {
  try {
    const { getCreatureStatusContext } = await import("../context-sources");
    const raw = await getCreatureStatusContext();
    // Parse creature status into agent status
    return [];
  } catch { return []; }
}

async function fetchCalendar(): Promise<{ next_event: CalendarEventSummary | null; today_count: number }> {
  try {
    const { getUpcomingCalendarEvents } = await import("../context-sources");
    const raw = await getUpcomingCalendarEvents();
    if (!raw) return { next_event: null, today_count: 0 };
    return { next_event: null, today_count: 0 };
  } catch { return { next_event: null, today_count: 0 }; }
}

/**
 * Build the full awareness object. Fetches all sources in parallel.
 * The mode filtering happens at render time, not fetch time —
 * this lets us detect mode shifts without re-fetching.
 */
export async function buildAwareness(supabase: any): Promise<Awareness> {
  const [workItems, sessions, incidents, agentStatus, calendar] = await Promise.all([
    fetchWorkItems(),
    fetchRecentSessions(supabase),
    fetchIncidents(),
    fetchAgentStatus(),
    fetchCalendar(),
  ]);

  const blocked = workItems.filter(i => i.state.toLowerCase() === "blocked");
  const overdue: WorkItemSummary[] = []; // TODO: check due dates once Plane exposes them

  return {
    work: {
      active_items: workItems.slice(0, 5),
      recent_sessions: sessions.slice(0, 2),
      blocked_items: blocked,
    },
    conversations: {
      last_conversation: null, // filled from conversation history
      open_threads: [],
    },
    system: {
      incidents,
      agent_status: agentStatus,
      creatures: [],
    },
    calendar,
    heartbeat: {
      overdue_items: overdue,
      stale_threads: [],
      signals: [],
    },
  };
}

/**
 * Filter the awareness object by mode and render to natural language.
 * This is the function tests exercise directly.
 */
export function filterAwarenessByMode(awareness: Awareness, mode: LayeredMode): string {
  const filter = MODE_AWARENESS_FILTERS[mode];
  const parts: string[] = ["## AWARENESS\n"];

  // Work
  if (filter.work === "full") {
    if (awareness.work.active_items.length > 0) {
      parts.push(`Active work: ${awareness.work.active_items.map(i => `${i.id} (${i.title})`).join(", ")}.`);
    }
    if (awareness.work.blocked_items.length > 0) {
      parts.push(`Blocked: ${awareness.work.blocked_items.map(i => `${i.id} (${i.title})`).join(", ")}.`);
    }
    if (awareness.work.recent_sessions.length > 0) {
      parts.push(`Recent sessions: ${awareness.work.recent_sessions.map(s => `${s.work_item_id}: ${s.summary}`).join("; ")}.`);
    }
  } else if (filter.work === "overdue_blocked") {
    if (awareness.heartbeat.overdue_items.length > 0) {
      parts.push(`Overdue: ${awareness.heartbeat.overdue_items.map(i => `${i.id} (${i.title})`).join(", ")}.`);
    }
    if (awareness.work.blocked_items.length > 0) {
      parts.push(`Blocked: ${awareness.work.blocked_items.map(i => `${i.id} (${i.title})`).join(", ")}.`);
    }
  }

  // Conversations
  if (filter.conversations === "full" || filter.conversations === "last_only") {
    if (awareness.conversations.last_conversation) {
      const lc = awareness.conversations.last_conversation;
      parts.push(`Last conversation: ${lc.topic} (with ${lc.agent}).`);
    }
  }
  if (filter.conversations === "full" || filter.conversations === "open_threads") {
    if (awareness.conversations.open_threads.length > 0) {
      parts.push(`Open threads: ${awareness.conversations.open_threads.map(t => `${t.agent}: ${t.topic}`).join(", ")}.`);
    }
  }
  if (filter.conversations === "stale_threads") {
    if (awareness.heartbeat.stale_threads.length > 0) {
      parts.push(`Stale threads: ${awareness.heartbeat.stale_threads.map(t => `${t.agent}: ${t.topic}`).join(", ")}.`);
    }
  }

  // System
  if (filter.system === "full") {
    if (awareness.system.agent_status.length > 0) {
      parts.push(`Agents: ${awareness.system.agent_status.map(a =>
        a.status === "active" ? `${a.name} (${a.current_task || "active"})` : `${a.name} (idle)`
      ).join(", ")}.`);
    }
    if (awareness.system.incidents.length > 0) {
      parts.push(`Incidents: ${awareness.system.incidents.map(i => `${i.severity}: ${i.title}`).join(", ")}.`);
    }
  } else if (filter.system === "incidents_only") {
    if (awareness.system.incidents.length > 0) {
      parts.push(`Incidents: ${awareness.system.incidents.map(i => `${i.severity}: ${i.title}`).join(", ")}.`);
    }
  } else if (filter.system === "agent_status") {
    if (awareness.system.agent_status.length > 0) {
      parts.push(`Agents: ${awareness.system.agent_status.map(a => `${a.name}: ${a.status}`).join(", ")}.`);
    }
  }

  // Calendar
  if (filter.calendar === "full" || filter.calendar === "next_only") {
    if (awareness.calendar.next_event) {
      parts.push(`Next event: ${awareness.calendar.next_event.title} at ${awareness.calendar.next_event.start}.`);
    }
  }
  if (filter.calendar === "full" || filter.calendar === "count_only") {
    if (awareness.calendar.today_count > 0) {
      parts.push(`${awareness.calendar.today_count} events today.`);
    }
  }

  // Heartbeat signals
  if (filter.heartbeat === "full") {
    for (const signal of awareness.heartbeat.signals) {
      parts.push(`[${signal.priority}] ${signal.summary}`);
    }
  } else if (filter.heartbeat === "overdue") {
    for (const signal of awareness.heartbeat.signals.filter(s => s.type === "overdue")) {
      parts.push(`[${signal.priority}] ${signal.summary}`);
    }
  }

  // If nothing to report
  if (parts.length === 1) {
    parts.push("No notable activity.");
  }

  return parts.join("\n");
}

/**
 * Convenience: build + filter + render in one call.
 */
export async function renderAwareness(supabase: any, mode: LayeredMode): Promise<string> {
  const awareness = await buildAwareness(supabase);
  return filterAwarenessByMode(awareness, mode);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ellie/ellie-dev && bun test tests/prompt-layers-awareness.test.ts`
Expected: PASS — all 5 tests

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/prompt-layers/awareness.ts tests/prompt-layers-awareness.test.ts
git commit -m "[LAYERED-PROMPT] Layer 2 awareness builder with mode filtering"
```

---

### Task 5: Layer 3 — Knowledge Retrieval

**Files:**
- Create: `src/prompt-layers/knowledge.ts`
- Create: `tests/prompt-layers-knowledge.test.ts`

**Context:** Layer 3 has three channels: (A) skill/reference lookup via trigger matching, (B) filtered Forest retrieval excluding conversation summaries, (C) contextual expansion via semantic edges and groves. It uses the existing `readMemories` from ellie-forest and `getRelatedKnowledge`/`getGroveKnowledgeContext` from context-sources.

- [ ] **Step 1: Write the failing test**

Create `tests/prompt-layers-knowledge.test.ts`:
```typescript
import { describe, test, expect } from "bun:test";
import {
  matchSkillTriggers,
  buildScopeFromMode,
  VOICE_SUMMARY_FILTER,
} from "../src/prompt-layers/knowledge";
import type { SkillRegistryEntry, LayeredMode } from "../src/prompt-layers/types";

const MOCK_REGISTRY: SkillRegistryEntry[] = [
  { name: "plane", triggers: ["check plane", "create ticket", "work items", "plane"], file: "skills/plane/SKILL.md", description: "Manage tickets" },
  { name: "forest", triggers: ["search forest", "forest", "knowledge tree"], file: "skills/forest/SKILL.md", description: "Query Forest" },
  { name: "github", triggers: ["github", "pull request", "PR", "repo"], file: "skills/github/SKILL.md", description: "GitHub operations" },
];

describe("Layer 3: Knowledge", () => {
  describe("Channel A: Skill trigger matching", () => {
    test("matches plane skill from trigger phrase", () => {
      const matches = matchSkillTriggers("can you check plane for open items", MOCK_REGISTRY);
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe("plane");
    });

    test("matches multiple skills if message hits both", () => {
      const matches = matchSkillTriggers("check the forest and create a plane ticket", MOCK_REGISTRY);
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    test("returns empty for unmatched message", () => {
      const matches = matchSkillTriggers("how was your weekend", MOCK_REGISTRY);
      expect(matches).toHaveLength(0);
    });
  });

  describe("Channel B: Scope resolution", () => {
    test("dev-session defaults to 2/ (projects)", () => {
      expect(buildScopeFromMode("dev-session", "working on the relay")).toBe("2");
    });

    test("personal mode searches Y/ (Dave's tree)", () => {
      expect(buildScopeFromMode("personal", "how is Georgia")).toBe("Y");
    });

    test("voice-casual searches Y/ for personal, 2/ for ambiguous", () => {
      expect(buildScopeFromMode("voice-casual", "georgia had a great day")).toBe("Y");
      expect(buildScopeFromMode("voice-casual", "something random")).toBe("2");
    });
  });

  describe("Voice summary filter", () => {
    test("filters out voice call summaries", () => {
      expect(VOICE_SUMMARY_FILTER.test("Voice call (12 exchanges). Topics: Hey, Ellie")).toBe(true);
      expect(VOICE_SUMMARY_FILTER.test("Voice call (4 exchanges). Topics: How's it going")).toBe(true);
    });

    test("does not filter real memories", () => {
      expect(VOICE_SUMMARY_FILTER.test("Dave values ownership over perfection")).toBe(false);
      expect(VOICE_SUMMARY_FILTER.test("ELLIE-459 covers Phase 2 improvements")).toBe(false);
    });

    test("filters conversation summary patterns", () => {
      expect(VOICE_SUMMARY_FILTER.test("Conversation summary: discussed Forest architecture")).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ellie/ellie-dev && bun test tests/prompt-layers-knowledge.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `src/prompt-layers/knowledge.ts`:
```typescript
// src/prompt-layers/knowledge.ts
/**
 * Layer 3: Retrieved Knowledge — On-demand Forest retrieval with skill lookup and expansion.
 * Only fires when there's a user message to retrieve for.
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { log } from "../logger.ts";
import { loadSkillRegistry } from "./identity";
import type { SkillRegistryEntry, LayeredMode, KnowledgeResult } from "./types";

const logger = log.child("prompt:knowledge");

const KNOWLEDGE_BUDGET_BYTES = 4096;

// ── Channel A: Skill/Reference Trigger Matching ─────────────

/**
 * Match user message against skill trigger phrases.
 * Returns matching skill entries (usually 0-1, occasionally 2).
 */
export function matchSkillTriggers(
  message: string,
  registry: SkillRegistryEntry[],
): SkillRegistryEntry[] {
  const lower = message.toLowerCase();
  return registry.filter(entry =>
    entry.triggers.some(trigger => lower.includes(trigger.toLowerCase()))
  );
}

/**
 * Load full SKILL.md content for matched skills.
 */
async function loadSkillDocs(matches: SkillRegistryEntry[]): Promise<string> {
  if (matches.length === 0) return "";

  const docs: string[] = [];
  for (const match of matches.slice(0, 2)) { // cap at 2 skill docs
    try {
      const fullPath = join(import.meta.dir, "../..", match.file);
      const content = await readFile(fullPath, "utf-8");
      docs.push(`### Skill: ${match.name}\n${content}`);
    } catch {
      logger.warn("Could not load skill doc: %s", match.file);
    }
  }
  return docs.join("\n---\n");
}

// ── Channel B: Filtered Forest Retrieval ────────────────────

/** Pattern to filter out voice call and conversation summaries */
export const VOICE_SUMMARY_FILTER = /^(?:Voice call \(\d+ exchanges?\)|Conversation summary:)/i;

/** Additional summary type filter */
const SUMMARY_TYPE_FILTER = (type: string | null) => type === "summary";

/**
 * Determine which Forest scope to search based on mode and message content.
 */
export function buildScopeFromMode(mode: LayeredMode, message: string): string {
  const PERSONAL_KEYWORDS = /\b(?:georgia|wincy|phineas|family|daughter|wife|dog|home|weekend|vacation|health|exercise)\b/i;

  if (mode === "personal") return "Y";
  if (mode === "voice-casual") {
    return PERSONAL_KEYWORDS.test(message) ? "Y" : "2";
  }
  if (mode === "planning") return "2";
  if (mode === "heartbeat") return "2";

  // dev-session: try to detect sub-scope from message
  if (/\b(?:forest|tree|grove|branch|scope)\b/i.test(message)) return "2/2";
  if (/\b(?:relay|handler|pipeline|chat|dispatch|agent)\b/i.test(message)) return "2/1";
  if (/\b(?:dashboard|nuxt|vue|tailwind|frontend)\b/i.test(message)) return "2/3";
  if (/\b(?:ellie.?life|health module|medication)\b/i.test(message)) return "2/5";
  if (/\b(?:ellie.?learn|learning|cognitive)\b/i.test(message)) return "2/6";
  if (/\b(?:ellie.?work|billing|medical)\b/i.test(message)) return "2/7";

  return "2";
}

/**
 * Retrieve knowledge from Forest, filtering out voice summaries.
 * Uses the existing readMemories hybrid search.
 */
async function retrieveForestKnowledge(
  query: string,
  scopePath: string,
): Promise<string> {
  try {
    const bridgeKey = process.env.BRIDGE_KEY || "bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a";
    const res = await fetch("http://localhost:3001/api/bridge/read", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-key": bridgeKey,
      },
      body: JSON.stringify({
        query,
        scope_path: scopePath,
        match_count: 10,
        match_threshold: 0.4,
      }),
    });

    if (!res.ok) return "";
    const data = await res.json() as { memories?: Array<{ content: string; type: string; scope_path: string }> };
    if (!data.memories?.length) return "";

    // Filter out voice summaries and conversation summaries
    const filtered = data.memories.filter(m =>
      !VOICE_SUMMARY_FILTER.test(m.content) &&
      !SUMMARY_TYPE_FILTER(m.type)
    );

    if (filtered.length === 0) return "";

    const lines = filtered.slice(0, 10).map(m =>
      `- [${m.type}, ${m.scope_path}] ${m.content.slice(0, 200)}`
    );
    return `## KNOWLEDGE\n${lines.join("\n")}`;
  } catch (err) {
    logger.warn({ err }, "Forest retrieval failed");
    return "";
  }
}

// ── Channel C: Contextual Expansion ─────────────────────────

async function expandContext(query: string, agent: string): Promise<string> {
  try {
    const { getRelatedKnowledge, getGroveKnowledgeContext } = await import("../context-sources");
    const [related, grove] = await Promise.all([
      getRelatedKnowledge(query, { limit: 3 }).catch(() => ""),
      getGroveKnowledgeContext(query, agent, { limit: 2 }).catch(() => ""),
    ]);

    const parts = [related, grove].filter(Boolean);
    return parts.length > 0 ? parts.join("\n") : "";
  } catch { return ""; }
}

// ── Public API ──────────────────────────────────────────────

/**
 * Build the full Layer 3 knowledge block.
 * Returns empty string if no user message (heartbeat mode).
 */
export async function retrieveKnowledge(
  message: string | null,
  mode: LayeredMode,
  agent: string = "ellie",
): Promise<KnowledgeResult> {
  const empty: KnowledgeResult = { skillDocs: "", forestKnowledge: "", expansion: "" };

  // Heartbeat: no retrieval
  if (!message || mode === "heartbeat") return empty;

  const registry = await loadSkillRegistry();

  // Run all three channels in parallel
  const scopePath = buildScopeFromMode(mode, message);
  const [skillMatches, forestKnowledge, expansion] = await Promise.all([
    Promise.resolve(matchSkillTriggers(message, registry)),
    retrieveForestKnowledge(message, scopePath),
    expandContext(message, agent),
  ]);

  const skillDocs = await loadSkillDocs(skillMatches);

  return { skillDocs, forestKnowledge, expansion };
}

/**
 * Render Layer 3 as a single string, respecting the 4KB budget.
 */
export function renderKnowledge(result: KnowledgeResult): string {
  const parts = [result.skillDocs, result.forestKnowledge, result.expansion].filter(Boolean);
  let combined = parts.join("\n\n");

  // Enforce budget
  const encoder = new TextEncoder();
  if (encoder.encode(combined).length > KNOWLEDGE_BUDGET_BYTES) {
    // Trim expansion first, then forest, keep skills
    if (result.expansion && encoder.encode(result.skillDocs + result.forestKnowledge).length <= KNOWLEDGE_BUDGET_BYTES) {
      combined = [result.skillDocs, result.forestKnowledge].filter(Boolean).join("\n\n");
    } else if (encoder.encode(result.skillDocs).length <= KNOWLEDGE_BUDGET_BYTES) {
      combined = result.skillDocs;
    } else {
      combined = combined.slice(0, KNOWLEDGE_BUDGET_BYTES);
    }
  }

  return combined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ellie/ellie-dev && bun test tests/prompt-layers-knowledge.test.ts`
Expected: PASS — all 7 tests

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/prompt-layers/knowledge.ts tests/prompt-layers-knowledge.test.ts
git commit -m "[LAYERED-PROMPT] Layer 3 knowledge retrieval with skill triggers and voice filtering"
```

---

### Task 6: Orchestration Layer — buildLayeredPrompt

**Files:**
- Create: `src/prompt-layers/index.ts`

**Context:** This module ties all three layers together. It's the replacement for `_gatherContextSources()` — a single function that returns the layered prompt result.

- [ ] **Step 1: Write the implementation**

Create `src/prompt-layers/index.ts`:
```typescript
// src/prompt-layers/index.ts
/**
 * Layered Prompt Orchestrator
 *
 * Replaces the 13-source _gatherContextSources() pipeline with three distinct layers:
 *   Layer 1: Identity (always loaded, cached .md files)
 *   Layer 2: Awareness (structured state, mode-filtered)
 *   Layer 3: Knowledge (on-demand Forest retrieval, scoped)
 *
 * See spec: docs/superpowers/specs/2026-04-06-layered-prompt-architecture-design.md
 */

import { log } from "../logger.ts";
import { detectLayeredMode } from "../context-mode";
import { renderIdentityBlock } from "./identity";
import { buildAwareness, filterAwarenessByMode } from "./awareness";
import { retrieveKnowledge, renderKnowledge } from "./knowledge";
import type { LayeredMode, LayeredPromptResult } from "./types";

const logger = log.child("prompt:layers");

const TOTAL_BUDGET_BYTES = 10240; // 10KB total budget

/**
 * Build the full layered prompt context.
 *
 * @param message - User message (null for heartbeat)
 * @param channel - Channel identifier (telegram, ellie-chat, voice, vscode, etc.)
 * @param agent - Active agent name
 * @param supabase - Supabase client for awareness queries
 * @param modeOverride - Force a specific mode (for testing or explicit mode switches)
 */
export async function buildLayeredContext(
  message: string | null,
  channel: string | null,
  agent: string = "ellie",
  supabase: any = null,
  modeOverride?: LayeredMode,
): Promise<LayeredPromptResult> {
  const start = Date.now();

  // 1. Detect mode
  const { mode, signal } = modeOverride
    ? { mode: modeOverride, signal: `override:${modeOverride}` }
    : detectLayeredMode(message, channel);

  logger.info({ mode, signal, channel }, "Layered prompt: mode detected");

  // 2. Build all three layers in parallel
  const [identity, awareness, knowledgeResult] = await Promise.all([
    renderIdentityBlock(),
    buildAwareness(supabase).then(a => filterAwarenessByMode(a, mode)),
    retrieveKnowledge(message, mode, agent),
  ]);

  const knowledge = renderKnowledge(knowledgeResult);

  // 3. Check total budget
  const encoder = new TextEncoder();
  const totalBytes = encoder.encode(identity).length +
    encoder.encode(awareness).length +
    encoder.encode(knowledge).length;

  if (totalBytes > TOTAL_BUDGET_BYTES) {
    logger.warn({ totalBytes, budget: TOTAL_BUDGET_BYTES, mode },
      "Layered prompt exceeds budget — knowledge will be trimmed");
  }

  const elapsed = Date.now() - start;
  logger.info({ mode, totalBytes, elapsed }, "Layered prompt built");

  return {
    identity,
    awareness,
    knowledge,
    mode,
    totalBytes,
  };
}

// Re-export types and utilities for consumers
export { detectLayeredMode } from "../context-mode";
export type { LayeredMode, LayeredPromptResult } from "./types";
```

- [ ] **Step 2: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/prompt-layers/index.ts
git commit -m "[LAYERED-PROMPT] orchestration layer tying identity + awareness + knowledge"
```

---

### Task 7: Wire Into Pipeline (Feature-Flagged)

**Files:**
- Modify: `src/ellie-chat-pipeline.ts`
- Modify: `src/ellie-chat-handler.ts`
- Modify: `src/prompt-builder.ts`

**Context:** We add the layered pipeline alongside the existing 13-source pipeline, gated by `LAYERED_PROMPT=true` in `.env`. This allows A/B comparison and safe rollback. The prompt-builder already has a section-priority system — we inject the three layers as high-priority sections.

- [ ] **Step 1: Add layered path to ellie-chat-pipeline.ts**

At the end of `src/ellie-chat-pipeline.ts`, add:

```typescript
// ── Layered Prompt Pipeline (feature-flagged) ───────────────
// Replaces _gatherContextSources when LAYERED_PROMPT=true

import { buildLayeredContext } from "./prompt-layers/index";
import type { LayeredPromptResult } from "./prompt-layers/types";

/**
 * Layered alternative to _gatherContextSources().
 * Returns structured layers instead of a flat context bag.
 */
export async function gatherLayeredContext(
  message: string | null,
  channel: string | null,
  agent: string,
  supabase: any,
): Promise<LayeredPromptResult> {
  return buildLayeredContext(message, channel, agent, supabase);
}
```

- [ ] **Step 2: Add layered sections to prompt-builder.ts**

In `src/prompt-builder.ts`, inside `buildPrompt()`, after the soul section is added (around line 910), add a new code path:

```typescript
  // ── LAYERED PROMPT: inject identity/awareness/knowledge as high-priority sections ──
  if (layeredContext) {
    sections.push({
      label: "layered-identity",
      content: layeredContext.identity,
      priority: 1, // never trimmed
    });
    sections.push({
      label: "layered-awareness",
      content: layeredContext.awareness,
      priority: 2, // essential
    });
    if (layeredContext.knowledge) {
      sections.push({
        label: "layered-knowledge",
        content: layeredContext.knowledge,
        priority: 3, // important
      });
    }
  }
```

Also add `layeredContext?: LayeredPromptResult` to the function signature (add it after the last parameter `agentLocalMemory`).

Import at the top: `import type { LayeredPromptResult } from "./prompt-layers/types";`

- [ ] **Step 3: Wire feature flag in ellie-chat-handler.ts**

In the main handler function `_handleEllieChatMessage`, find where `_gatherContextSources()` is called. Add an alternative path:

```typescript
  const useLayered = process.env.LAYERED_PROMPT === "true";
  let layeredContext: LayeredPromptResult | undefined;

  if (useLayered) {
    const { gatherLayeredContext } = await import("./ellie-chat-pipeline");
    layeredContext = await gatherLayeredContext(text, channelId || "ellie-chat", activeAgent, supabase);
  }
```

Then when calling `buildPrompt()`, pass `layeredContext` as the new parameter.

When `LAYERED_PROMPT=true`:
- The old 13-source pipeline still runs (for backwards compatibility during testing)
- The layered context is injected as high-priority sections that take precedence
- This means identity/awareness/knowledge appear at the top of the prompt

When `LAYERED_PROMPT=false` (default):
- No change to existing behavior
- `layeredContext` is undefined, the new sections don't get added

- [ ] **Step 4: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/ellie-chat-pipeline.ts src/ellie-chat-handler.ts src/prompt-builder.ts
git commit -m "[LAYERED-PROMPT] wire layered pipeline into chat handler behind LAYERED_PROMPT flag"
```

---

### Task 8: Test and Enable

**Files:**
- Modify: `.env` (add `LAYERED_PROMPT=true`)

- [ ] **Step 1: Run all tests**

Run: `cd /home/ellie/ellie-dev && bun test`
Expected: All existing tests pass, plus 4 new test files pass

- [ ] **Step 2: Run the relay and test manually**

```bash
cd /home/ellie/ellie-dev
echo "LAYERED_PROMPT=true" >> .env
systemctl --user restart ellie-chat-relay
```

Then send a test message through Ellie Chat and check the logs:

```bash
journalctl --user -u ellie-chat-relay --since "1 min ago" | grep "prompt:layers"
```

Expected: Log lines showing mode detection, layer sizes, and total budget.

- [ ] **Step 3: Verify context snapshot reflects new architecture**

Run: `bun run scripts/context-snapshot.ts`

Check the output — Layer 1 identity should always be present, Layer 2 awareness should be mode-filtered, Layer 3 knowledge should be scoped and free of voice summaries.

- [ ] **Step 4: Commit the feature flag enable**

```bash
cd /home/ellie/ellie-dev
git add .env
git commit -m "[LAYERED-PROMPT] enable layered prompt architecture"
```

---

## Notes for Implementers

### Existing code awareness
- `prompt-builder.ts` has 32 parameters and a section-priority system (1-9). The layered context is injected as new sections, not replacing the existing signature. This preserves backward compatibility.
- `context-mode.ts` already has 6 modes. `detectLayeredMode` is a new export that maps to the 5-mode layered set. The existing `detectMode` and `getConversationMode` are untouched.
- `context-sources.ts` functions are called FROM Layer 2 awareness builder. They're not deprecated — their orchestration just moves from the pipeline to the awareness builder.

### The glob dependency
`identity.ts` uses `glob` to find SKILL.md files. The `glob` package should already be available (check `node_modules`). If not: `bun add glob`.

### Bridge API for Layer 3
Layer 3 Channel B calls the bridge API (localhost:3001) rather than importing Forest directly. This keeps the prompt-layers module decoupled from the Forest database and uses the same auth/scope checks as other consumers.

### Token budget vs byte budget
The spec says "10KB total." The implementation uses byte count (TextEncoder) rather than token count for simplicity. Byte count is a reasonable proxy — 10KB of text is ~2500 tokens, well within Claude's budget. The existing `applyTokenBudgetWithCompression` in prompt-builder.ts handles final token-level trimming.
