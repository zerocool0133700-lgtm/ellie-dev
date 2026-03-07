/**
 * Cognitive Load Detector — ELLIE-338
 *
 * Detects cognitive load signals from message patterns and work item state,
 * then formats a prompt hint for agents to offer gentle structure.
 *
 * Pure detector pattern (no I/O in detectors) — same as Work Item Gardener.
 *
 * Signals:
 *  1. High open work item count
 *  2. Repeated state-check questions ("what's the status", "where are we")
 *  3. Message length variance (scattered thinking)
 *  4. Topic-switching frequency
 *
 * HTTP:  POST /api/cognitive-load/detect  — on-demand detection
 *        GET  /api/cognitive-load/status   — current load level
 */

import type { IncomingMessage, ServerResponse } from "http";
import { log } from "../logger.ts";

const logger = log.child("cognitive-load");

// ── Types ──────────────────────────────────────────────────────────────────

export type LoadLevel = "low" | "moderate" | "high" | "overloaded";

export interface MessageSnapshot {
  content: string;
  timestamp: string; // ISO
  role: "user" | "assistant";
  channel?: string;
}

export interface WorkItemCount {
  open: number;
  inProgress: number;
  highPriority: number;
}

export interface CognitiveSignal {
  signal: string;
  value: number;
  threshold: number;
  triggered: boolean;
  detail?: string;
}

export interface CognitiveLoadResult {
  level: LoadLevel;
  score: number; // 0–1
  signals: CognitiveSignal[];
  suggestion?: string;
  detectedAt: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const STATE_CHECK_PATTERNS = [
  /what(?:'s| is) the (?:status|state|progress)/i,
  /where (?:are|were) we/i,
  /what (?:was|am) i (?:doing|working on)/i,
  /what(?:'s| is) (?:left|remaining|next)/i,
  /can you (?:remind|tell) me (?:what|where)/i,
  /what(?:'s| is) the (?:plan|priority|order)/i,
  /how many (?:things|items|tasks|tickets)/i,
  /i(?:'m| am) (?:lost|confused|overwhelmed)/i,
  /too much (?:going on|to do|to track)/i,
  /what should i (?:focus|work) on/i,
];

const TOPIC_KEYWORDS: Record<string, RegExp> = {
  code: /(?:function|bug|error|test|deploy|commit|merge|refactor|implement)/i,
  ops: /(?:server|restart|service|deploy|nginx|systemd|health|monitor)/i,
  planning: /(?:ticket|sprint|backlog|priority|roadmap|plan|milestone)/i,
  personal: /(?:morning|evening|dinner|lunch|schedule|weekend|family)/i,
  finance: /(?:budget|cost|money|price|invoice|payment|subscription)/i,
  design: /(?:ui|ux|component|layout|css|style|theme|dashboard)/i,
};

// ── Pure Detectors ─────────────────────────────────────────────────────────

/**
 * Detect repeated state-check questions in recent messages.
 * Returns the count of matching messages and the fraction of user messages.
 */
export function detectStateChecks(messages: MessageSnapshot[]): CognitiveSignal {
  const userMessages = messages.filter((m) => m.role === "user");
  if (userMessages.length === 0) {
    return { signal: "state_checks", value: 0, threshold: 3, triggered: false };
  }

  let matchCount = 0;
  for (const msg of userMessages) {
    if (STATE_CHECK_PATTERNS.some((p) => p.test(msg.content))) {
      matchCount++;
    }
  }

  const threshold = 3;
  return {
    signal: "state_checks",
    value: matchCount,
    threshold,
    triggered: matchCount >= threshold,
    detail: matchCount > 0
      ? `${matchCount} state-check question${matchCount === 1 ? "" : "s"} in last ${userMessages.length} messages`
      : undefined,
  };
}

/**
 * Detect high message length variance (coefficient of variation).
 * High variance suggests scattered thinking — alternating between
 * terse pings and long dumps.
 */
export function detectLengthVariance(messages: MessageSnapshot[]): CognitiveSignal {
  const userMessages = messages.filter((m) => m.role === "user");
  if (userMessages.length < 4) {
    return { signal: "length_variance", value: 0, threshold: 1.2, triggered: false };
  }

  const lengths = userMessages.map((m) => m.content.length);
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  if (mean === 0) {
    return { signal: "length_variance", value: 0, threshold: 1.2, triggered: false };
  }

  const variance = lengths.reduce((sum, l) => sum + (l - mean) ** 2, 0) / lengths.length;
  const cv = Math.sqrt(variance) / mean; // coefficient of variation

  const threshold = 1.2;
  return {
    signal: "length_variance",
    value: Math.round(cv * 100) / 100,
    threshold,
    triggered: cv >= threshold,
    detail: cv >= threshold
      ? `Message lengths vary widely (CV=${cv.toFixed(2)}) — may indicate scattered thinking`
      : undefined,
  };
}

/**
 * Detect rapid topic switching in recent user messages.
 * Counts how often the dominant topic changes between consecutive messages.
 */
export function detectTopicSwitching(messages: MessageSnapshot[]): CognitiveSignal {
  const userMessages = messages.filter((m) => m.role === "user");
  if (userMessages.length < 3) {
    return { signal: "topic_switching", value: 0, threshold: 4, triggered: false };
  }

  const topics = userMessages.map((msg) => classifyTopic(msg.content));
  let switches = 0;
  for (let i = 1; i < topics.length; i++) {
    if (topics[i] !== topics[i - 1] && topics[i] !== "unknown" && topics[i - 1] !== "unknown") {
      switches++;
    }
  }

  const threshold = 4;
  return {
    signal: "topic_switching",
    value: switches,
    threshold,
    triggered: switches >= threshold,
    detail: switches >= threshold
      ? `${switches} topic switches in ${userMessages.length} messages — attention may be fragmented`
      : undefined,
  };
}

/**
 * Detect high open work item count.
 */
export function detectWorkItemLoad(counts: WorkItemCount): CognitiveSignal {
  const score = counts.open + counts.inProgress * 2 + counts.highPriority * 1.5;
  const threshold = 20;

  return {
    signal: "work_item_load",
    value: Math.round(score * 10) / 10,
    threshold,
    triggered: score >= threshold,
    detail: score >= threshold
      ? `${counts.open} open + ${counts.inProgress} in-progress + ${counts.highPriority} high-priority items`
      : undefined,
  };
}

/**
 * Detect high message frequency (messages per hour).
 */
export function detectMessageFrequency(messages: MessageSnapshot[]): CognitiveSignal {
  const userMessages = messages.filter((m) => m.role === "user");
  if (userMessages.length < 2) {
    return { signal: "message_frequency", value: 0, threshold: 15, triggered: false };
  }

  const timestamps = userMessages.map((m) => new Date(m.timestamp).getTime()).sort((a, b) => a - b);
  const windowMs = timestamps[timestamps.length - 1] - timestamps[0];
  const windowHours = windowMs / (1000 * 60 * 60);

  if (windowHours < 0.01) {
    return { signal: "message_frequency", value: 0, threshold: 15, triggered: false };
  }

  const rate = userMessages.length / windowHours;
  const threshold = 15;

  return {
    signal: "message_frequency",
    value: Math.round(rate * 10) / 10,
    threshold,
    triggered: rate >= threshold,
    detail: rate >= threshold
      ? `${rate.toFixed(1)} messages/hour — unusually high pace`
      : undefined,
  };
}

// ── Aggregation ────────────────────────────────────────────────────────────

/**
 * Run all detectors and compute overall cognitive load level.
 * Pure function — no I/O.
 */
export function assessCognitiveLoad(
  messages: MessageSnapshot[],
  workItems: WorkItemCount,
): CognitiveLoadResult {
  const signals = [
    detectStateChecks(messages),
    detectLengthVariance(messages),
    detectTopicSwitching(messages),
    detectWorkItemLoad(workItems),
    detectMessageFrequency(messages),
  ];

  const triggeredCount = signals.filter((s) => s.triggered).length;
  const score = Math.min(1, triggeredCount / signals.length + (triggeredCount > 0 ? 0.1 : 0));
  const level = scoreToLevel(score);
  const suggestion = pickSuggestion(level, signals);

  return {
    level,
    score: Math.round(score * 100) / 100,
    signals,
    suggestion,
    detectedAt: new Date().toISOString(),
  };
}

/**
 * Format a cognitive load result as a prompt hint for agents.
 * Returns empty string if load is low (no hint needed).
 * Framing is always gentle and helpful — never diagnostic.
 */
export function formatLoadHint(result: CognitiveLoadResult): string {
  if (result.level === "low") return "";

  const triggeredSignals = result.signals.filter((s) => s.triggered);
  const lines = [`COGNITIVE LOAD AWARENESS (${result.level}):`];

  if (triggeredSignals.length > 0) {
    lines.push("Observed patterns:");
    for (const s of triggeredSignals) {
      if (s.detail) lines.push(`- ${s.detail}`);
    }
  }

  lines.push("");
  lines.push("Guidance for your response:");

  if (result.level === "overloaded") {
    lines.push("- The user may be juggling many things. Proactively offer to help prioritize or break things down.");
    lines.push("- Keep your response focused and structured. Use numbered lists or clear sections.");
    lines.push("- Consider offering: 'Want me to triage these?' or 'I can break that down into steps.'");
  } else if (result.level === "high") {
    lines.push("- The user may benefit from structure. If the conversation feels scattered, gently offer to organize.");
    lines.push("- Prefer concise, well-structured responses over long explanations.");
    lines.push("- If appropriate, offer: 'Want me to summarize where things stand?'");
  } else {
    // moderate
    lines.push("- Keep responses clear and well-organized.");
    lines.push("- If the user seems to be tracking many things, a brief summary can help.");
  }

  lines.push("");
  lines.push("IMPORTANT: Never tell the user their 'cognitive load is high'. Frame any offers as helpful, not diagnostic.");

  return lines.join("\n");
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Classify a message into a topic category. */
export function classifyTopic(text: string): string {
  let bestTopic = "unknown";
  let bestCount = 0;

  for (const [topic, pattern] of Object.entries(TOPIC_KEYWORDS)) {
    const matches = text.match(new RegExp(pattern, "gi"));
    const count = matches?.length ?? 0;
    if (count > bestCount) {
      bestCount = count;
      bestTopic = topic;
    }
  }

  return bestTopic;
}

function scoreToLevel(score: number): LoadLevel {
  if (score >= 0.7) return "overloaded";
  if (score >= 0.5) return "high";
  if (score >= 0.3) return "moderate";
  return "low";
}

function pickSuggestion(level: LoadLevel, signals: CognitiveSignal[]): string | undefined {
  if (level === "low") return undefined;

  const triggered = signals.filter((s) => s.triggered).map((s) => s.signal);

  if (triggered.includes("state_checks")) {
    return "Want me to summarize where everything stands?";
  }
  if (triggered.includes("work_item_load")) {
    return "I can triage your open items — want a priority list?";
  }
  if (triggered.includes("topic_switching")) {
    return "Want me to break that down into focused steps?";
  }
  if (triggered.includes("message_frequency")) {
    return "Lots happening — want me to organize the key points?";
  }
  if (triggered.includes("length_variance")) {
    return "Want me to pull together a quick summary of where things are?";
  }

  return "I can help organize things if that would be useful.";
}

// ── Cache & State ──────────────────────────────────────────────────────────

let _cachedResult: CognitiveLoadResult | null = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 5 * 60_000; // 5 minutes

export function getCachedLoadResult(): CognitiveLoadResult | null {
  if (_cachedResult && Date.now() - _cachedAt < CACHE_TTL_MS) return _cachedResult;
  return null;
}

export function setCachedLoadResult(result: CognitiveLoadResult): void {
  _cachedResult = result;
  _cachedAt = Date.now();
}

/** For testing — inject a result into the cache. */
export function _injectLoadResultForTesting(result: CognitiveLoadResult | null): void {
  _cachedResult = result;
  _cachedAt = result ? Date.now() : 0;
}

// ── Data Collectors (effectful) ────────────────────────────────────────────

/**
 * Collect recent user messages from Supabase.
 * Returns the last N messages for cognitive load analysis.
 */
export async function collectRecentMessages(
  supabase: { from: (table: string) => { select: (cols: string) => { order: (col: string, opts: { ascending: boolean }) => { limit: (n: number) => { then: (fn: (result: { data: unknown[] | null; error: unknown }) => void) => void } } } } },
  limit: number = 30,
): Promise<MessageSnapshot[]> {
  return new Promise((resolve) => {
    supabase
      .from("messages")
      .select("content,role,created_at,channel")
      .order("created_at", { ascending: false })
      .limit(limit)
      .then((result: { data: unknown[] | null; error: unknown }) => {
        if (result.error || !result.data) {
          logger.warn("Failed to collect messages for cognitive load", { error: result.error });
          resolve([]);
          return;
        }
        const snapshots: MessageSnapshot[] = (result.data as Array<{ content: string; role: string; created_at: string; channel?: string }>).map((row) => ({
          content: row.content || "",
          timestamp: row.created_at,
          role: row.role as "user" | "assistant",
          channel: row.channel,
        }));
        resolve(snapshots);
      });
  });
}

/**
 * Collect work item counts from Plane.
 */
export async function collectWorkItemCounts(): Promise<WorkItemCount> {
  try {
    const { listOpenIssues, isPlaneConfigured } = await import("../plane.ts");
    if (!isPlaneConfigured()) return { open: 0, inProgress: 0, highPriority: 0 };

    const issues = await listOpenIssues("ELLIE", 100);
    return {
      open: issues.length,
      inProgress: issues.filter((i) => i.priority === "urgent" || i.priority === "high").length,
      highPriority: issues.filter((i) => i.priority === "urgent" || i.priority === "high").length,
    };
  } catch (error) {
    logger.warn("Failed to collect work item counts", { error });
    return { open: 0, inProgress: 0, highPriority: 0 };
  }
}

// ── Full Detection Run (effectful) ─────────────────────────────────────────

/**
 * Run full cognitive load detection: collect data, run detectors, cache result.
 */
export async function runCognitiveLoadDetection(
  supabase?: { from: (table: string) => unknown },
): Promise<CognitiveLoadResult> {
  const cached = getCachedLoadResult();
  if (cached) return cached;

  const messages = supabase ? await collectRecentMessages(supabase as Parameters<typeof collectRecentMessages>[0]) : [];
  const workItems = await collectWorkItemCounts();

  const result = assessCognitiveLoad(messages, workItems);
  setCachedLoadResult(result);

  if (result.level !== "low") {
    logger.info("Cognitive load detected", { level: result.level, score: result.score, triggered: result.signals.filter((s) => s.triggered).map((s) => s.signal) });
  }

  return result;
}

// ── HTTP Handlers ──────────────────────────────────────────────────────────

export async function cognitiveLoadDetectHandler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { getRelayDeps } = await import("../relay-state.ts");
    const deps = getRelayDeps();
    const result = await runCognitiveLoadDetection(deps?.supabase);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, ...result }));
  } catch (error) {
    logger.error("Cognitive load detection failed", { error });
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: "Detection failed" }));
  }
}

export async function cognitiveLoadStatusHandler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cached = getCachedLoadResult();
  if (cached) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, ...cached }));
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, level: "unknown", score: 0, signals: [], detectedAt: null }));
  }
}
