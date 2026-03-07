/**
 * Commitment Tracker — ELLIE-339
 *
 * Detects user commitments ("I will...", "I need to...", "I should..."),
 * stores them, and surfaces gentle follow-ups in future sessions.
 *
 * Pure extractor pattern — detection functions have no I/O.
 *
 * Key behaviors:
 *  - Extract commitments from user messages via pattern matching
 *  - Surface stale commitments gently: "still on your radar?"
 *  - Respect dismissal — snoozed commitments hidden for 7 days
 *  - Time-decay: commitments > 14 days without follow-up are deprioritized
 *
 * HTTP:  GET  /api/commitments          — list active commitments
 *        POST /api/commitments/dismiss   — dismiss/snooze a commitment
 */

import type { IncomingMessage, ServerResponse } from "http";
import { log } from "../logger.ts";

const logger = log.child("commitment-tracker");

// ── Types ──────────────────────────────────────────────────────────────────

export interface ExtractedCommitment {
  text: string;
  originalMessage: string;
  pattern: string;
  confidence: number;
}

export interface StoredCommitment {
  id: string;
  content: string;
  createdAt: string;
  status: "active" | "snoozed" | "completed" | "expired";
  snoozedUntil?: string;
  lastSurfacedAt?: string;
  surfaceCount: number;
  source: string; // channel
  metadata?: Record<string, unknown>;
}

export interface CommitmentFollowUp {
  commitment: StoredCommitment;
  ageDays: number;
  priority: "fresh" | "due" | "stale" | "fading";
  suggestion: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const SNOOZE_DAYS = 7;
const DECAY_DAYS = 14;
const EXPIRE_DAYS = 30;
const MAX_SURFACE_PER_SESSION = 2;

// ── Commitment Extraction Patterns ─────────────────────────────────────────

const COMMITMENT_PATTERNS: Array<{ pattern: RegExp; label: string; confidence: number }> = [
  // Strong intent — "I will", "I'm going to"
  { pattern: /\bi(?:'ll| will)\s+(.{10,80})/i, label: "i_will", confidence: 0.85 },
  { pattern: /\bi(?:'m| am) going to\s+(.{10,80})/i, label: "going_to", confidence: 0.85 },
  { pattern: /\bi(?:'m| am) gonna\s+(.{10,80})/i, label: "gonna", confidence: 0.8 },

  // Need/should — softer but still trackable
  { pattern: /\bi (?:really )?need to\s+(.{10,80})/i, label: "need_to", confidence: 0.7 },
  { pattern: /\bi should (?:probably )?(.{10,80})/i, label: "should", confidence: 0.6 },
  { pattern: /\bi have to\s+(.{10,80})/i, label: "have_to", confidence: 0.75 },
  { pattern: /\bi(?:'ve| have) got to\s+(.{10,80})/i, label: "got_to", confidence: 0.75 },

  // Planning language
  { pattern: /\bi(?:'m| am) planning (?:to|on)\s+(.{10,80})/i, label: "planning", confidence: 0.8 },
  { pattern: /\blet me\s+(.{10,80})/i, label: "let_me", confidence: 0.5 },
  { pattern: /\bi want to\s+(.{10,80})/i, label: "want_to", confidence: 0.6 },

  // Explicit commitment
  { pattern: /\bremind me to\s+(.{10,80})/i, label: "remind_me", confidence: 0.95 },
  { pattern: /\bdon't let me forget (?:to )?(.{10,80})/i, label: "dont_forget", confidence: 0.95 },
];

const SUPPRESSION_PATTERNS: RegExp[] = [
  /\bif\b/i,           // conditional: "if I need to..."
  /\bwould\b/i,        // hypothetical: "I would need to..."
  /\bcould\b/i,        // tentative: "I could..."
  /\bmight\b/i,        // uncertain: "I might..."
  /\bmaybe\b/i,        // uncertain
  /\bwhat if\b/i,      // hypothetical
  /\bwhen .* then\b/i, // conditional
  /\?$/,               // questions: "should I...?"
  /\byou\b/i,          // addressing the bot, not self-commitment
];

// ── Pure Extractors ────────────────────────────────────────────────────────

/**
 * Extract commitments from a user message.
 * Pure function — no I/O.
 */
export function extractCommitments(message: string): ExtractedCommitment[] {
  const results: ExtractedCommitment[] = [];
  const trimmed = message.trim();

  if (trimmed.length < 15) return results;

  for (const { pattern, label, confidence } of COMMITMENT_PATTERNS) {
    const match = trimmed.match(pattern);
    if (!match || !match[1]) continue;

    const captured = match[1].trim();
    // Check the full matched segment for suppression
    const fullMatch = match[0];

    if (isSuppressed(fullMatch)) continue;
    if (captured.length < 8) continue;

    // Clean up trailing punctuation
    const cleaned = captured.replace(/[.!,;]+$/, "").trim();

    results.push({
      text: cleaned,
      originalMessage: trimmed,
      pattern: label,
      confidence,
    });
  }

  return deduplicateExtractions(results);
}

/**
 * Check if a commitment match is suppressed (conditional, hypothetical, etc.)
 */
export function isSuppressed(text: string): boolean {
  return SUPPRESSION_PATTERNS.some((p) => p.test(text));
}

/**
 * Deduplicate extracted commitments — keep highest confidence per unique text.
 */
function deduplicateExtractions(extractions: ExtractedCommitment[]): ExtractedCommitment[] {
  const seen = new Map<string, ExtractedCommitment>();
  for (const e of extractions) {
    const key = e.text.toLowerCase();
    const existing = seen.get(key);
    if (!existing || e.confidence > existing.confidence) {
      seen.set(key, e);
    }
  }
  return Array.from(seen.values());
}

// ── Follow-Up Logic ────────────────────────────────────────────────────────

/**
 * Given stored commitments, determine which should be surfaced
 * and how to phrase the follow-up. Pure function.
 */
export function selectFollowUps(
  commitments: StoredCommitment[],
  now: Date = new Date(),
): CommitmentFollowUp[] {
  const candidates: CommitmentFollowUp[] = [];

  for (const c of commitments) {
    if (c.status !== "active") continue;

    // Skip snoozed commitments
    if (c.snoozedUntil && new Date(c.snoozedUntil) > now) continue;

    const ageDays = daysBetween(new Date(c.createdAt), now);

    // Skip expired (>30 days, never surfaced)
    if (ageDays > EXPIRE_DAYS && c.surfaceCount === 0) continue;

    const priority = ageToPriority(ageDays);
    const suggestion = buildSuggestion(c, ageDays, priority);

    candidates.push({ commitment: c, ageDays, priority, suggestion });
  }

  // Sort: due > stale > fresh > fading, then by age descending
  const priorityOrder = { due: 0, stale: 1, fresh: 2, fading: 3 };
  candidates.sort((a, b) => {
    const pDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (pDiff !== 0) return pDiff;
    return b.ageDays - a.ageDays;
  });

  return candidates.slice(0, MAX_SURFACE_PER_SESSION);
}

/**
 * Format follow-ups as a prompt section for agent injection.
 * Returns empty string if nothing to surface.
 * Framing is always gentle and supportive.
 */
export function formatFollowUpPrompt(followUps: CommitmentFollowUp[]): string {
  if (followUps.length === 0) return "";

  const lines = [
    "COMMITMENT FOLLOW-UPS:",
    "The user mentioned these intentions in past conversations.",
    "Surface them naturally — never nag or shame. Frame as a gentle check-in.",
    "",
  ];

  for (const f of followUps) {
    const age = f.ageDays === 0 ? "today" : f.ageDays === 1 ? "yesterday" : `${f.ageDays} days ago`;
    lines.push(`- "${f.commitment.content}" (mentioned ${age})`);
    lines.push(`  Suggested phrasing: "${f.suggestion}"`);
  }

  lines.push("");
  lines.push("Rules:");
  lines.push("- Only mention if it fits the conversation naturally");
  lines.push("- Use 'still on your radar?' not 'you still haven't done X'");
  lines.push("- If the user dismisses it, respect that — don't push");
  lines.push("- Maximum one follow-up per conversation unless the user asks");

  return lines.join("\n");
}

/**
 * Build a snooze date from now.
 */
export function buildSnoozeUntil(now: Date = new Date()): string {
  const snooze = new Date(now);
  snooze.setDate(snooze.getDate() + SNOOZE_DAYS);
  return snooze.toISOString();
}

/**
 * Check if a commitment should be auto-expired.
 */
export function shouldExpire(commitment: StoredCommitment, now: Date = new Date()): boolean {
  const ageDays = daysBetween(new Date(commitment.createdAt), now);
  return ageDays > EXPIRE_DAYS;
}

/**
 * Check if a message indicates a commitment was completed.
 */
export function detectCompletion(message: string, commitmentText: string): boolean {
  const normalizedMsg = message.toLowerCase();
  const normalizedCommitment = commitmentText.toLowerCase();

  // Extract key words from commitment
  const keyWords = normalizedCommitment
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 5);

  if (keyWords.length === 0) return false;

  // Check for completion language + commitment keywords
  const completionPhrases = [
    /\bdone\b/i, /\bfinished\b/i, /\bcompleted\b/i,
    /\bdid (?:it|that)\b/i, /\btook care of\b/i,
    /\bhandled\b/i, /\bsorted\b/i, /\bwrapped up\b/i,
    /\bshipped\b/i, /\bdeployed\b/i, /\bfixed\b/i,
  ];

  const hasCompletionPhrase = completionPhrases.some((p) => p.test(normalizedMsg));
  const matchingKeyWords = keyWords.filter((w) => normalizedMsg.includes(w));
  const keyWordMatchRatio = matchingKeyWords.length / keyWords.length;

  return hasCompletionPhrase && keyWordMatchRatio >= 0.4;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function daysBetween(a: Date, b: Date): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.floor(Math.abs(b.getTime() - a.getTime()) / msPerDay);
}

function ageToPriority(ageDays: number): CommitmentFollowUp["priority"] {
  if (ageDays <= 2) return "fresh";
  if (ageDays <= 7) return "due";
  if (ageDays <= DECAY_DAYS) return "stale";
  return "fading";
}

function buildSuggestion(c: StoredCommitment, ageDays: number, priority: string): string {
  const topic = c.content.length > 50 ? c.content.slice(0, 47) + "..." : c.content;

  if (priority === "fresh") {
    return `Hey, you mentioned wanting to ${topic} — want to tackle that now?`;
  }
  if (priority === "due") {
    return `You mentioned ${topic} a few days ago — still on your radar?`;
  }
  if (priority === "stale") {
    return `A while back you said you wanted to ${topic} — is that still something you want to do?`;
  }
  // fading
  return `Just checking — you mentioned ${topic} a couple weeks ago. Want me to keep tracking that or drop it?`;
}

// ── Data Access (effectful) ────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseMinimal = any;

/**
 * Fetch active commitments from conversation_facts (type=goal, status=active).
 */
export async function fetchActiveCommitments(supabase: SupabaseMinimal): Promise<StoredCommitment[]> {
  try {
    const { data, error } = await supabase
      .from("conversation_facts")
      .select("id,content,created_at,status,metadata,tags")
      .in("status", ["active", "needs_review"])
      .gte("created_at", new Date(Date.now() - EXPIRE_DAYS * 24 * 60 * 60 * 1000).toISOString());

    if (error || !data) {
      logger.warn("Failed to fetch commitments", { error });
      return [];
    }

    return (data as Array<{
      id: string;
      content: string;
      created_at: string;
      status: string;
      metadata: Record<string, unknown> | null;
      tags: string[] | null;
    }>)
      .filter((row) => row.metadata?.commitment_tracker || (row.tags?.includes("commitment")))
      .map((row) => ({
        id: row.id,
        content: row.content,
        createdAt: row.created_at,
        status: (row.metadata?.snoozed_until && new Date(row.metadata.snoozed_until as string) > new Date())
          ? "snoozed" as const
          : "active" as const,
        snoozedUntil: row.metadata?.snoozed_until as string | undefined,
        lastSurfacedAt: row.metadata?.last_surfaced_at as string | undefined,
        surfaceCount: (row.metadata?.surface_count as number) || 0,
        source: (row.metadata?.source_channel as string) || "unknown",
        metadata: row.metadata || undefined,
      }));
  } catch (error) {
    logger.warn("Error fetching commitments", { error });
    return [];
  }
}

/**
 * Store a new commitment in conversation_facts.
 */
export async function storeCommitment(
  supabase: SupabaseMinimal,
  extraction: ExtractedCommitment,
  channel: string = "unknown",
): Promise<void> {
  try {
    await supabase.from("conversation_facts").insert({
      id: crypto.randomUUID(),
      content: extraction.text,
      type: "goal",
      category: "personal",
      confidence: extraction.confidence,
      source_channel: channel,
      extraction_method: "pattern",
      status: "active",
      tags: ["commitment"],
      metadata: {
        commitment_tracker: true,
        pattern: extraction.pattern,
        original_message: extraction.originalMessage.slice(0, 200),
        source_channel: channel,
        surface_count: 0,
      },
    }).select();
  } catch (error) {
    logger.warn("Failed to store commitment", { error });
  }
}

/**
 * Dismiss (snooze) a commitment.
 */
export async function dismissCommitment(
  supabase: SupabaseMinimal,
  commitmentId: string,
): Promise<void> {
  const snoozeUntil = buildSnoozeUntil();
  try {
    await supabase.from("conversation_facts").update({
      metadata: {
        commitment_tracker: true,
        snoozed_until: snoozeUntil,
      },
    }).eq("id", commitmentId);
  } catch (error) {
    logger.warn("Failed to dismiss commitment", { error });
  }
}

/**
 * Mark a commitment as completed.
 */
export async function completeCommitment(
  supabase: SupabaseMinimal,
  commitmentId: string,
): Promise<void> {
  try {
    await supabase.from("conversation_facts").update({
      type: "completed_goal",
      status: "archived",
      completed_at: new Date().toISOString(),
    }).eq("id", commitmentId);
  } catch (error) {
    logger.warn("Failed to complete commitment", { error });
  }
}

// ── Prompt Context Builder ─────────────────────────────────────────────────

let _commitmentPromptCache = "";
let _commitmentCacheAt = 0;
const COMMITMENT_CACHE_MS = 10 * 60_000;

/**
 * Get commitment follow-up context for prompt injection.
 */
export async function getCommitmentContext(supabase?: SupabaseMinimal): Promise<string> {
  const now = Date.now();
  if (_commitmentPromptCache && now - _commitmentCacheAt < COMMITMENT_CACHE_MS) {
    return _commitmentPromptCache;
  }

  if (!supabase) return "";

  try {
    const commitments = await fetchActiveCommitments(supabase);
    const followUps = selectFollowUps(commitments);
    _commitmentPromptCache = formatFollowUpPrompt(followUps);
    _commitmentCacheAt = now;
  } catch {
    // Non-critical — skip silently
  }

  return _commitmentPromptCache;
}

/** For testing — inject cache. */
export function _injectCommitmentCacheForTesting(prompt: string | null): void {
  _commitmentPromptCache = prompt || "";
  _commitmentCacheAt = prompt ? Date.now() : 0;
}

// ── HTTP Handlers ──────────────────────────────────────────────────────────

export async function commitmentsListHandler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { getRelayDeps } = await import("../relay-state.ts");
    const deps = getRelayDeps();
    if (!deps?.supabase) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, commitments: [] }));
      return;
    }
    const commitments = await fetchActiveCommitments(deps.supabase as unknown as SupabaseMinimal);
    const followUps = selectFollowUps(commitments);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, commitments, followUps }));
  } catch (error) {
    logger.error("Commitments list failed", { error });
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: "Failed to list commitments" }));
  }
}

export async function commitmentsDismissHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { getRelayDeps } = await import("../relay-state.ts");
    const deps = getRelayDeps();
    if (!deps?.supabase) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "No database connection" }));
      return;
    }

    let body = "";
    for await (const chunk of req) body += chunk;
    const { id } = JSON.parse(body);

    if (!id) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Missing commitment id" }));
      return;
    }

    await dismissCommitment(deps.supabase as unknown as SupabaseMinimal, id);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, snoozedUntil: buildSnoozeUntil() }));
  } catch (error) {
    logger.error("Commitment dismiss failed", { error });
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: "Failed to dismiss commitment" }));
  }
}
