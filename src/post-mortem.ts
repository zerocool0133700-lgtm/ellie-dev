/**
 * Post-Mortem Meta-Learning — ELLIE-569
 *
 * Writes structured post-mortems to River after agent failures (timeout, crash,
 * wrong approach). Before dispatching retry agents, searches for relevant
 * post-mortems to adjust dispatch strategy.
 *
 * Two layers:
 *  - Pure: content builders + pattern extraction (zero deps, testable)
 *  - Effectful: River write + QMD search (non-fatal)
 */

import { writeFile, readFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { RIVER_ROOT, qmdReindex } from "./api/bridge-river.ts";
import { searchRiver } from "./api/bridge-river.ts";
import { log } from "./logger.ts";
import { AsyncMutex } from "./async-mutex.ts";
import { RELAY_BASE_URL } from "./relay-config.ts";

const logger = log.child("post-mortem");

/** Shared mutex for post-mortem write operations. */
const _postMortemLock = new AsyncMutex();

/** Exposed for testing — allows tests to verify lock state. */
export function _getPostMortemLockForTesting(): AsyncMutex {
  return _postMortemLock;
}

// ── Types ──────────────────────────────────────────────────────────────────────

export type FailureType = "timeout" | "crash" | "wrong_approach" | "blocked" | "unknown";

export interface PostMortemData {
  workItemId: string;
  title: string;
  agent?: string;
  failureType: FailureType;
  whatHappened: string;
  whyItFailed?: string;
  whatToDoNextTime?: string;
  filesInvolved?: string[];
  durationMinutes?: number;
  patternTags?: string[];
  timestamp?: string;
}

export interface DispatchAdvice {
  relevantPostMortems: PostMortemSummary[];
  adjustments: string[];
  patternsSeen: string[];
}

export interface PostMortemSummary {
  workItemId: string;
  failureType: string;
  whatHappened: string;
  whatToDoNextTime: string;
  patternTags: string[];
  file: string;
}

// ── Pure: Classify pause reason ───────────────────────────────────────────────

/** Keyword patterns for each failure type, checked in priority order. */
const TIMEOUT_PATTERNS = ["timeout", "timed out", "timed-out", "ran out of time", "took too long", "exceeded time"];
const CRASH_PATTERNS = ["crash", "oom", "out of memory", "killed", "segfault", "panic", "fatal", "aborted", "force-killed"];
const WRONG_APPROACH_PATTERNS = ["wrong approach", "wrong path", "went down the wrong", "bad strategy", "incorrect assumption"];
const BLOCKED_PATTERNS = ["blocked", "missing", "waiting on", "need access", "credential", "permission denied", "api key", "can't access"];

/**
 * Derive failureType and patternTags from a free-text pause reason.
 * Pure function — no side effects, fully testable.
 */
export function classifyPauseReason(reason: string): { failureType: FailureType; patternTags: string[] } {
  const lower = reason.toLowerCase();

  if (TIMEOUT_PATTERNS.some(p => lower.includes(p))) {
    return { failureType: "timeout", patternTags: ["timeout"] };
  }
  if (CRASH_PATTERNS.some(p => lower.includes(p))) {
    return { failureType: "crash", patternTags: ["crash"] };
  }
  if (WRONG_APPROACH_PATTERNS.some(p => lower.includes(p))) {
    return { failureType: "wrong_approach", patternTags: ["wrong-approach"] };
  }
  if (BLOCKED_PATTERNS.some(p => lower.includes(p))) {
    return { failureType: "blocked", patternTags: ["blocked"] };
  }

  return { failureType: "unknown", patternTags: ["unclassified"] };
}

// ── Pure: Path builder ─────────────────────────────────────────────────────────

/** Build the post-mortem file path. E.g. "post-mortems/ELLIE-567-2026-03-05.md" */
export function buildPostMortemPath(workItemId: string, date?: string): string {
  const d = date ?? new Date().toISOString().slice(0, 10);
  return `post-mortems/${workItemId}-${d}.md`;
}

// ── Pure: Content builder ──────────────────────────────────────────────────────

/** Build post-mortem markdown content. */
export function buildPostMortemContent(data: PostMortemData): string {
  const ts = data.timestamp ?? new Date().toISOString();
  const tags = data.patternTags ?? [];

  const lines = [
    "---",
    "type: post-mortem",
    `work_item_id: ${data.workItemId}`,
    `failure_type: ${data.failureType}`,
    `timestamp: ${ts}`,
    tags.length > 0 ? `pattern_tags: [${tags.join(", ")}]` : null,
    data.agent ? `agent: ${data.agent}` : null,
    data.durationMinutes !== undefined
      ? `duration_minutes: ${data.durationMinutes}`
      : null,
    "---",
    "",
    `# Post-Mortem: ${data.workItemId} — ${data.title}`,
    "",
    `> ${capitalize(data.failureType)} at ${ts.slice(0, 16)}`,
    "",
    "## What Happened",
    "",
    data.whatHappened,
    "",
  ];

  if (data.whyItFailed) {
    lines.push("## Why It Failed", "", data.whyItFailed, "");
  }

  if (data.whatToDoNextTime) {
    lines.push("## What To Do Next Time", "", data.whatToDoNextTime, "");
  }

  if (data.filesInvolved?.length) {
    lines.push("## Files Involved", "");
    for (const f of data.filesInvolved) {
      lines.push(`- \`${f}\``);
    }
    lines.push("");
  }

  if (tags.length > 0) {
    lines.push("## Pattern Tags", "");
    for (const tag of tags) {
      lines.push(`- \`${tag}\``);
    }
    lines.push("");
  }

  return lines.filter((l) => l !== null).join("\n");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
}

// ── Pure: Parse post-mortem from markdown ───────────────────────────────────────

/**
 * Extract a PostMortemSummary from a QMD search result snippet + file path.
 * Best-effort: returns what it can find.
 */
export function parsePostMortemSnippet(
  file: string,
  snippet: string,
): PostMortemSummary | null {
  const idMatch = snippet.match(/work_item_id:\s*(\S+)/) ||
    file.match(/post-mortems\/(\S+?)-\d{4}/);
  if (!idMatch) return null;

  const failureMatch = snippet.match(/failure_type:\s*(\S+)/);
  const whatMatch = snippet.match(/## What Happened\s*\n\s*([\s\S]*?)(?:\n##|$)/);
  const nextTimeMatch = snippet.match(/## What To Do Next Time\s*\n\s*([\s\S]*?)(?:\n##|$)/);
  const tagsMatch = snippet.match(/pattern_tags:\s*\[([^\]]*)\]/);

  const tags = tagsMatch
    ? tagsMatch[1].split(",").map((t) => t.trim()).filter(Boolean)
    : [];

  return {
    workItemId: idMatch[1],
    failureType: failureMatch?.[1] ?? "unknown",
    whatHappened: whatMatch?.[1]?.trim() ?? "",
    whatToDoNextTime: nextTimeMatch?.[1]?.trim() ?? "",
    patternTags: tags,
    file,
  };
}

// ── Pure: Build dispatch advice from post-mortems ──────────────────────────────

/**
 * Analyze relevant post-mortems and generate dispatch adjustments.
 */
export function buildDispatchAdvice(
  postMortems: PostMortemSummary[],
): DispatchAdvice {
  const adjustments: string[] = [];
  const patternsSeen: string[] = [];

  for (const pm of postMortems) {
    // Collect pattern tags
    for (const tag of pm.patternTags) {
      if (!patternsSeen.includes(tag)) {
        patternsSeen.push(tag);
      }
    }

    // Generate adjustments from "what to do next time"
    if (pm.whatToDoNextTime) {
      adjustments.push(pm.whatToDoNextTime);
    }
  }

  // Add pattern-based adjustments
  if (patternsSeen.includes("task-too-large")) {
    if (!adjustments.some((a) => a.includes("break"))) {
      adjustments.push("Break task into smaller phases — commit after each phase.");
    }
  }

  if (patternsSeen.includes("missing-context")) {
    if (!adjustments.some((a) => a.includes("context"))) {
      adjustments.push("Provide more context upfront — include relevant file paths and recent changes.");
    }
  }

  if (patternsSeen.includes("timeout")) {
    if (!adjustments.some((a) => a.includes("incremental"))) {
      adjustments.push("Commit incrementally — do not wait until the end to save progress.");
    }
  }

  return {
    relevantPostMortems: postMortems,
    adjustments,
    patternsSeen,
  };
}

// ── Pure: Format advice for prompt injection ───────────────────────────────────

/**
 * Format dispatch advice as markdown for injection into agent prompts.
 */
export function formatAdviceForPrompt(advice: DispatchAdvice): string {
  if (advice.relevantPostMortems.length === 0) return "";

  const lines = [
    "## Past Failure Patterns (from post-mortems)",
    "",
    `Found ${advice.relevantPostMortems.length} relevant post-mortem(s).`,
    "",
  ];

  if (advice.adjustments.length > 0) {
    lines.push("### Dispatch Adjustments", "");
    for (const adj of advice.adjustments) {
      lines.push(`- ${adj}`);
    }
    lines.push("");
  }

  if (advice.patternsSeen.length > 0) {
    lines.push(
      `**Patterns observed:** ${advice.patternsSeen.map((p) => `\`${p}\``).join(", ")}`,
    );
    lines.push("");
  }

  return lines.join("\n");
}

// ── Effectful: Find next available path (ELLIE-575) ─────────────────────────────

/**
 * Given a base path like "post-mortems/ELLIE-567-2026-03-05.md", check if the
 * file already exists. If so, try "-2.md", "-3.md", etc. up to maxSeq.
 * Returns the first available path (relative to RIVER_ROOT).
 */
export async function findNextAvailablePath(
  basePath: string,
  maxSeq: number = 99,
  existsFn: (path: string) => Promise<boolean> = async (p) => {
    try { await readFile(p); return true; } catch { return false; }
  },
): Promise<string> {
  const fullBase = join(RIVER_ROOT, basePath);
  if (!(await existsFn(fullBase))) return basePath;

  const ext = ".md";
  const stem = basePath.slice(0, -ext.length);
  for (let seq = 2; seq <= maxSeq; seq++) {
    const candidate = `${stem}-${seq}${ext}`;
    const fullCandidate = join(RIVER_ROOT, candidate);
    if (!(await existsFn(fullCandidate))) return candidate;
  }

  // Fallback: use maxSeq+1 (extremely unlikely)
  return `${stem}-${maxSeq + 1}${ext}`;
}

// ── Pure: Forest finding builder (ELLIE-584) ────────────────────────────────────

const BRIDGE_KEY = "bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a";

/**
 * Map failure type to confidence for the Forest finding.
 * More deterministic failures get higher confidence.
 */
export function confidenceForFailureType(failureType: FailureType): number {
  switch (failureType) {
    case "crash": return 0.8;
    case "wrong_approach": return 0.9;
    case "blocked": return 0.9;
    case "timeout": return 0.7;
    default: return 0.6;
  }
}

export interface ForestFinding {
  content: string;
  type: "finding";
  scope_path: string;
  confidence: number;
  metadata: {
    work_item_id: string;
    source: string;
    failure_type: string;
    agent?: string;
    pattern_tags?: string[];
  };
}

/**
 * Build a Forest finding from post-mortem data.
 * Pure function — extracts the actionable lesson for future agents.
 */
export function buildForestFinding(data: PostMortemData): ForestFinding {
  const parts: string[] = [
    `Post-mortem: ${data.workItemId} (${data.failureType})`,
  ];

  if (data.whyItFailed) {
    parts.push(`Root cause: ${data.whyItFailed}`);
  }

  if (data.whatToDoNextTime) {
    parts.push(`Lesson: ${data.whatToDoNextTime}`);
  }

  if (!data.whyItFailed && !data.whatToDoNextTime) {
    parts.push(`What happened: ${data.whatHappened}`);
  }

  return {
    content: parts.join(". "),
    type: "finding",
    scope_path: "2/1",
    confidence: confidenceForFailureType(data.failureType),
    metadata: {
      work_item_id: data.workItemId,
      source: "post-mortem",
      failure_type: data.failureType,
      agent: data.agent,
      pattern_tags: data.patternTags,
    },
  };
}

// ── Effectful: Write post-mortem finding to Forest (ELLIE-584) ──────────────────

/**
 * Write a post-mortem finding to the Forest via Bridge API.
 * Fire-and-forget: failures are logged but never block the River write.
 */
export async function writePostMortemToForest(
  data: PostMortemData,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const finding = buildForestFinding(data);
    const resp = await fetchFn(`${RELAY_BASE_URL}/api/bridge/write`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-key": BRIDGE_KEY,
      },
      body: JSON.stringify(finding),
    });

    if (!resp.ok) {
      logger.warn("writePostMortemToForest: Bridge write failed", {
        status: resp.status,
        workItemId: data.workItemId,
      });
      return false;
    }

    logger.info("Post-mortem finding written to Forest", {
      workItemId: data.workItemId,
      failureType: data.failureType,
    });
    return true;
  } catch (err) {
    logger.warn("writePostMortemToForest failed (non-fatal)", err);
    return false;
  }
}

// ── Effectful: Write post-mortem to River ───────────────────────────────────────

/**
 * Write a post-mortem document to River.
 * ELLIE-575: Uses sequence numbers to avoid overwriting same-day entries.
 * Non-fatal: catches all errors.
 */
export async function writePostMortem(data: PostMortemData): Promise<boolean> {
  try {
    return await _postMortemLock.withLock(async () => {
      const basePath = buildPostMortemPath(data.workItemId, data.timestamp?.slice(0, 10));
      const path = await findNextAvailablePath(basePath);
      const fullPath = join(RIVER_ROOT, path);

      await mkdir(dirname(fullPath), { recursive: true });
      const content = buildPostMortemContent(data);
      await writeFile(fullPath, content, "utf-8");

      logger.info("Post-mortem written", {
        workItemId: data.workItemId,
        failureType: data.failureType,
        path,
      });

      await qmdReindex();

      // ELLIE-584: Fire-and-forget Forest write — never blocks River write
      writePostMortemToForest(data).catch((err) => {
        logger.warn("writePostMortemToForest fire-and-forget failed", err);
      });

      return true;
    });
  } catch (err) {
    logger.warn("writePostMortem failed (non-fatal)", err);
    return false;
  }
}

// ── Effectful: Search for relevant post-mortems ────────────────────────────────

/**
 * Search River for relevant post-mortems before dispatching a retry agent.
 * Returns parsed post-mortem summaries.
 */
export async function searchPostMortems(
  query: string,
  searchFn: typeof searchRiver = searchRiver,
): Promise<PostMortemSummary[]> {
  try {
    const results = await searchFn(`post-mortem ${query}`, 10);

    const postMortems: PostMortemSummary[] = [];
    for (const r of results) {
      if (!r.file.startsWith("post-mortems/")) continue;
      const pm = parsePostMortemSnippet(r.file, r.snippet);
      if (pm) postMortems.push(pm);
    }

    return postMortems;
  } catch (err) {
    logger.warn("searchPostMortems failed (non-fatal)", err);
    return [];
  }
}

// ── Effectful: Get dispatch advice ─────────────────────────────────────────────

/**
 * Search for relevant post-mortems and generate dispatch advice.
 * Used before dispatching retry agents.
 */
export async function getDispatchAdvice(
  workItemId: string,
  searchFn?: typeof searchRiver,
): Promise<DispatchAdvice> {
  const postMortems = await searchPostMortems(workItemId, searchFn);
  return buildDispatchAdvice(postMortems);
}
