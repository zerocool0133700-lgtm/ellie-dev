/**
 * Agent-Initiated Capture Suggestions — ELLIE-778
 * Manages when and how the agent suggests capturing River-worthy content.
 * Integrates with pattern detector, enforces frequency caps, and handles user responses.
 */

import { detectPatterns, type DetectorConfig, DEFAULT_CONFIG } from "./pattern-detector.ts";
import type { CaptureContentType, Channel } from "../capture-queue.ts";

// Types

export interface SuggestionState {
  conversation_id: string;
  suggestions_this_turn: number;
  last_suggestion_at: number;
  total_suggestions: number;
  declined_count: number;
  active_suggestion: ActiveSuggestion | null;
}

export interface ActiveSuggestion {
  capture_id: string;
  content_type: CaptureContentType;
  raw_content: string;
  confidence: number;
  suggested_at: number;
}

export interface SuggestionConfig {
  max_per_turn: number;
  max_per_conversation: number;
  min_turns_between: number;
  decline_backoff_multiplier: number;
  suppressed_modes: string[];
}

export const DEFAULT_SUGGESTION_CONFIG: SuggestionConfig = {
  max_per_turn: 1,
  max_per_conversation: 5,
  min_turns_between: 3,
  decline_backoff_multiplier: 2,
  suppressed_modes: ["brain_dump", "review", "planning"],
};

// State management (per conversation)

const states = new Map<string, SuggestionState>();
const turnCounters = new Map<string, number>();

export function getOrCreateState(conversationId: string): SuggestionState {
  let state = states.get(conversationId);
  if (!state) {
    state = {
      conversation_id: conversationId,
      suggestions_this_turn: 0,
      last_suggestion_at: 0,
      total_suggestions: 0,
      declined_count: 0,
      active_suggestion: null,
    };
    states.set(conversationId, state);
  }
  return state;
}

export function advanceTurn(conversationId: string): void {
  const current = turnCounters.get(conversationId) ?? 0;
  turnCounters.set(conversationId, current + 1);
  const state = states.get(conversationId);
  if (state) state.suggestions_this_turn = 0;
}

export function getCurrentTurn(conversationId: string): number {
  return turnCounters.get(conversationId) ?? 0;
}

// Should we suggest?

export function shouldSuggest(
  conversationId: string,
  activeMode: string | null,
  config: SuggestionConfig = DEFAULT_SUGGESTION_CONFIG,
): { allowed: boolean; reason?: string } {
  // Suppress in certain modes
  if (activeMode && config.suppressed_modes.includes(activeMode)) {
    return { allowed: false, reason: `Suppressed in ${activeMode} mode` };
  }

  const state = getOrCreateState(conversationId);
  const turn = getCurrentTurn(conversationId);

  // Per-turn cap
  if (state.suggestions_this_turn >= config.max_per_turn) {
    return { allowed: false, reason: "Turn cap reached" };
  }

  // Per-conversation cap
  if (state.total_suggestions >= config.max_per_conversation) {
    return { allowed: false, reason: "Conversation cap reached" };
  }

  // Min turns between suggestions (with decline backoff)
  const effectiveGap = config.min_turns_between + (state.declined_count * config.decline_backoff_multiplier);
  if (state.last_suggestion_at > 0 && (turn - state.last_suggestion_at) < effectiveGap) {
    return { allowed: false, reason: "Too soon since last suggestion" };
  }

  // Active suggestion pending response
  if (state.active_suggestion) {
    return { allowed: false, reason: "Pending suggestion awaiting response" };
  }

  return { allowed: true };
}

// Generate suggestion message

const SUGGESTION_TEMPLATES: Record<CaptureContentType, string[]> = {
  workflow: [
    "That sounds like a workflow worth capturing. Want me to draft it for the River?",
    "This process description could be useful in the River. Should I capture it?",
  ],
  decision: [
    "That's a decision worth recording. Want me to add it to the River?",
    "Sounds like an important decision. Should I capture the reasoning?",
  ],
  policy: [
    "That sounds like a rule worth documenting. Want me to save it to the River?",
    "This policy should probably live in the River. Shall I draft it?",
  ],
  process: [
    "That routine sounds worth capturing. Want me to document it in the River?",
    "This process could be useful to reference later. Should I capture it?",
  ],
  integration: [
    "Those integration details should probably be documented. Want me to capture them?",
    "That API spec sounds River-worthy. Should I draft a doc?",
  ],
  reference: [
    "That looks like useful reference material. Want me to save it to the River?",
    "Should I capture that for the River?",
  ],
};

export function buildSuggestionMessage(contentType: CaptureContentType): string {
  const templates = SUGGESTION_TEMPLATES[contentType] ?? SUGGESTION_TEMPLATES.reference;
  return templates[Math.floor(Math.random() * templates.length)];
}

// Deterministic version for testing
export function buildSuggestionMessageDeterministic(contentType: CaptureContentType): string {
  const templates = SUGGESTION_TEMPLATES[contentType] ?? SUGGESTION_TEMPLATES.reference;
  return templates[0];
}

// Process a detected pattern into a suggestion

export function createSuggestion(
  conversationId: string,
  captureId: string,
  contentType: CaptureContentType,
  rawContent: string,
  confidence: number,
): ActiveSuggestion {
  const state = getOrCreateState(conversationId);
  const turn = getCurrentTurn(conversationId);

  const suggestion: ActiveSuggestion = {
    capture_id: captureId,
    content_type: contentType,
    raw_content: rawContent,
    confidence,
    suggested_at: Date.now(),
  };

  state.active_suggestion = suggestion;
  state.suggestions_this_turn++;
  state.total_suggestions++;
  state.last_suggestion_at = turn;

  return suggestion;
}

// Handle user response to suggestion

export type SuggestionResponse = "accept" | "decline" | "ignore";

export function parseUserResponse(text: string): SuggestionResponse | null {
  const lower = text.toLowerCase().trim();

  // Accept
  if (["yes", "y", "sure", "yeah", "yep", "ok", "okay", "please", "do it", "go ahead", "draft it", "capture it", "save it"].includes(lower)) {
    return "accept";
  }

  // Decline
  if (["no", "n", "nah", "nope", "not now", "skip", "later", "no thanks", "not yet"].includes(lower)) {
    return "decline";
  }

  return null; // Treat as ignore — user continued talking about something else
}

export function handleResponse(
  conversationId: string,
  response: SuggestionResponse,
): { suggestion: ActiveSuggestion | null; action: "refine" | "queue_silent" | "none" } {
  const state = getOrCreateState(conversationId);
  const suggestion = state.active_suggestion;

  if (!suggestion) {
    return { suggestion: null, action: "none" };
  }

  state.active_suggestion = null;

  switch (response) {
    case "accept":
      return { suggestion, action: "refine" };
    case "decline":
      state.declined_count++;
      return { suggestion, action: "queue_silent" };
    case "ignore":
      return { suggestion, action: "queue_silent" };
  }
}

// Full pipeline: detect → check caps → suggest

export async function evaluateForSuggestion(
  sql: any,
  text: string,
  channel: Channel,
  conversationId: string,
  activeMode: string | null,
  detectorConfig?: DetectorConfig,
  suggestionConfig?: SuggestionConfig,
): Promise<{ suggest: boolean; message?: string; capture_id?: string }> {
  const { allowed, reason } = shouldSuggest(conversationId, activeMode, suggestionConfig);
  if (!allowed) return { suggest: false };

  const detection = detectPatterns(text, detectorConfig ?? DEFAULT_CONFIG);
  if (!detection.detected) return { suggest: false };

  // Insert into queue
  try {
    const rows = await sql`
      INSERT INTO capture_queue (
        channel, raw_content, capture_type, content_type, confidence, status
      ) VALUES (
        ${channel}, ${text}, 'proactive', ${detection.content_type},
        ${detection.confidence}, 'queued'
      ) RETURNING id
    `;

    const captureId = rows[0]?.id;
    createSuggestion(conversationId, captureId, detection.content_type, text, detection.confidence);
    const message = buildSuggestionMessageDeterministic(detection.content_type);

    return { suggest: true, message, capture_id: captureId };
  } catch {
    return { suggest: false };
  }
}

// For testing
export function _clearState(): void {
  states.clear();
  turnCounters.clear();
}
