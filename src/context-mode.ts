/**
 * Context Mode — Message-Level Mode Detection
 *
 * ELLIE-325: Detects the interaction mode from user messages and remaps
 * prompt section priorities accordingly. Layered on top of the agent-level
 * ContextStrategy (ELLIE-261) — strategy controls WHICH sources to fetch,
 * mode controls HOW sections are prioritized in the final prompt.
 *
 * Modes: conversation, strategy, workflow, deep-work
 * Default: conversation (light, fast, responsive)
 */

import { log } from "./logger.ts";

const logger = log.child("context:mode");

// ── Types ────────────────────────────────────────────────────

export type ContextMode = "conversation" | "strategy" | "workflow" | "deep-work";

export interface ModeDetectionResult {
  mode: ContextMode;
  confidence: "high" | "medium";
  signal: string;          // the pattern that triggered detection
  workItemId?: string;     // extracted ELLIE-XXX if present
}

// ── Per-conversation mode state ─────────────────────────────

const conversationModes: Map<string, ContextMode> = new Map();

/** Get the current mode for a conversation. Defaults to conversation. */
export function getConversationMode(conversationId: string): ContextMode {
  return conversationModes.get(conversationId) || "conversation";
}

/** Set the mode for a conversation (manual override or detection). */
export function setConversationMode(conversationId: string, mode: ContextMode): void {
  conversationModes.set(conversationId, mode);
}

/** Clear mode state for a conversation (on session end). */
export function clearConversationMode(conversationId: string): void {
  conversationModes.delete(conversationId);
}

// ── Signal patterns ─────────────────────────────────────────

// Order matters — first match wins within each mode

const DEEP_WORK_SIGNALS: Array<{ pattern: RegExp; confidence: "high" | "medium" }> = [
  { pattern: /\bwork\s+on\s+ELLIE-\d+/i, confidence: "high" },
  { pattern: /\bimplement\s+ELLIE-\d+/i, confidence: "high" },
  { pattern: /\bfix\s+ELLIE-\d+/i, confidence: "high" },
  { pattern: /\bbuild\s+ELLIE-\d+/i, confidence: "high" },
  { pattern: /\bdebug\s+ELLIE-\d+/i, confidence: "high" },
  { pattern: /\bplease\s+work\s+\d+/i, confidence: "high" },
  { pattern: /\bwork\s+\d{3,}/i, confidence: "high" },
  { pattern: /\bELLIE-\d+.*(implement|fix|build|code|debug|work)/i, confidence: "high" },
  { pattern: /\b(implement|fix|build|code|debug)\b.*\bELLIE-\d+/i, confidence: "high" },
  { pattern: /\blet'?s\s+(do|build|fix|implement|code)\b/i, confidence: "medium" },
];

const STRATEGY_SIGNALS: Array<{ pattern: RegExp; confidence: "high" | "medium" }> = [
  { pattern: /\bbrain\s*dump\b/i, confidence: "high" },
  { pattern: /\blet'?s\s+plan\b/i, confidence: "high" },
  { pattern: /\bstrategy\b/i, confidence: "high" },
  { pattern: /\broadmap\b/i, confidence: "high" },
  { pattern: /\bprioritize\b/i, confidence: "high" },
  { pattern: /\bthink\s+through\b/i, confidence: "high" },
  { pattern: /\bflush\s+out\b/i, confidence: "high" },
  { pattern: /\bwhat\s+should\s+we\b/i, confidence: "high" },
  { pattern: /\brework\b/i, confidence: "medium" },
  { pattern: /\bredesign\b/i, confidence: "medium" },
  { pattern: /\barchitectur/i, confidence: "medium" },
  { pattern: /\bI'?ve\s+been\s+thinking\b/i, confidence: "medium" },
];

const WORKFLOW_SIGNALS: Array<{ pattern: RegExp; confidence: "high" | "medium" }> = [
  { pattern: /\bdispatch\b/i, confidence: "high" },
  { pattern: /\bcreatures?\b.*\b(status|running|check)\b/i, confidence: "high" },
  { pattern: /\bwhat'?s\s+running\b/i, confidence: "high" },
  { pattern: /\bmanage\s+agents?\b/i, confidence: "high" },
  { pattern: /\bfan\s+out\b/i, confidence: "high" },
  { pattern: /\bcheck\s+on\b/i, confidence: "medium" },
  { pattern: /\bqueue\s+status\b/i, confidence: "high" },
  { pattern: /\breview\s+output\b/i, confidence: "medium" },
  { pattern: /\bclose\s+ticket\b/i, confidence: "medium" },
  { pattern: /\bassign\b/i, confidence: "medium" },
];

const CONVERSATION_SIGNALS: Array<{ pattern: RegExp; confidence: "high" | "medium" }> = [
  { pattern: /^(hey|hi|hello|good\s+morning|good\s+evening|good\s+afternoon|morning|howdy|yo|sup)\b/i, confidence: "high" },
  { pattern: /\bhow'?s?\s+it\s+going\b/i, confidence: "high" },
  { pattern: /\bwhat'?s?\s+up\b/i, confidence: "high" },
  { pattern: /\bhow\s+are\s+you\b/i, confidence: "high" },
  { pattern: /\bthanks?\b/i, confidence: "medium" },
  { pattern: /\bthank\s+you\b/i, confidence: "medium" },
];

// Manual override phrases — immediate, unconditional
const MANUAL_OVERRIDES: Array<{ pattern: RegExp; mode: ContextMode }> = [
  { pattern: /\bstrategy\s+mode\b/i, mode: "strategy" },
  { pattern: /\bplanning\s+mode\b/i, mode: "strategy" },
  { pattern: /\bworkflow\s+mode\b/i, mode: "workflow" },
  { pattern: /\bops\s+mode\b/i, mode: "workflow" },
  { pattern: /\bconversation\s+mode\b/i, mode: "conversation" },
  { pattern: /\blet'?s\s+just\s+talk\b/i, mode: "conversation" },
  { pattern: /\bdeep\s+work\b/i, mode: "deep-work" },
  { pattern: /\bfocus\s+mode\b/i, mode: "deep-work" },
  { pattern: /\bload\s+everything\b/i, mode: "conversation" },  // disable filtering
  { pattern: /\bfull\s+context\b/i, mode: "conversation" },
];

// Context refresh triggers
const REFRESH_SIGNALS: RegExp[] = [
  /\brefresh\s+context\b/i,
  /\breload\s+context\b/i,
  /\bupdate\s+memory\b/i,
  /\bpull\s+latest\b/i,
  /\bre-?check\s+sources\b/i,
];

// ── Detector ────────────────────────────────────────────────

/**
 * Detect the interaction mode from a user message.
 *
 * Priority: manual overrides > deep-work > strategy > workflow > conversation
 * Returns null if no clear signal detected (stay in current mode).
 */
export function detectMode(message: string): ModeDetectionResult | null {
  // 1. Manual overrides — immediate, unconditional
  for (const { pattern, mode } of MANUAL_OVERRIDES) {
    if (pattern.test(message)) {
      return { mode, confidence: "high", signal: `manual: ${pattern.source}` };
    }
  }

  // 2. Deep-work signals (highest priority — specific ticket + action verb)
  for (const { pattern, confidence } of DEEP_WORK_SIGNALS) {
    if (pattern.test(message)) {
      const ticketMatch = message.match(/ELLIE-(\d+)/i) || message.match(/\bwork\s+(\d{3,})/i);
      return {
        mode: "deep-work",
        confidence,
        signal: pattern.source,
        workItemId: ticketMatch ? `ELLIE-${ticketMatch[1]}` : undefined,
      };
    }
  }

  // 3. Strategy signals
  for (const { pattern, confidence } of STRATEGY_SIGNALS) {
    if (pattern.test(message)) {
      return { mode: "strategy", confidence, signal: pattern.source };
    }
  }

  // 4. Workflow signals
  for (const { pattern, confidence } of WORKFLOW_SIGNALS) {
    if (pattern.test(message)) {
      return { mode: "workflow", confidence, signal: pattern.source };
    }
  }

  // 5. Conversation signals (greetings, casual)
  for (const { pattern, confidence } of CONVERSATION_SIGNALS) {
    if (pattern.test(message)) {
      return { mode: "conversation", confidence, signal: pattern.source };
    }
  }

  // No clear signal — stay in current mode
  return null;
}

/**
 * Check if the message is a context refresh request.
 */
export function isContextRefresh(message: string): boolean {
  return REFRESH_SIGNALS.some(p => p.test(message));
}

// ── Mode-to-priority mapping ────────────────────────────────
// From context-strategy SKILL.md tables

const MODE_PRIORITIES: Record<ContextMode, Record<string, number>> = {
  conversation: {
    "soul": 2,
    "archetype": 2,
    "phase": 3,
    "profile": 3,
    "structured-context": 4,
    "conversation": 3,
    "agent-memory": 8,
    "forest-awareness": 8,
    "search": 9,
    "context-docket": 7,
    "work-item": 9,
    "playbook-commands": 9,
    "work-commands": 9,
    "queue": 8,
    "skills": 6,
  },
  strategy: {
    "soul": 5,
    "archetype": 7,
    "psy": 7,
    "phase": 8,
    "profile": 4,
    "structured-context": 3,
    "conversation": 5,
    "agent-memory": 5,
    "forest-awareness": 3,
    "search": 8,
    "context-docket": 3,
    "work-item": 9,
    "playbook-commands": 7,
    "work-commands": 7,
    "queue": 6,
    "skills": 5,
  },
  workflow: {
    "soul": 7,
    "archetype": 8,
    "psy": 8,
    "phase": 9,
    "profile": 7,
    "structured-context": 3,
    "conversation": 6,
    "agent-memory": 3,
    "forest-awareness": 5,
    "search": 7,
    "context-docket": 4,
    "work-item": 9,
    "playbook-commands": 2,
    "work-commands": 2,
    "queue": 2,
    "skills": 5,
  },
  "deep-work": {
    "soul": 7,
    "archetype": 8,
    "psy": 7,
    "phase": 9,
    "profile": 7,
    "structured-context": 7,
    "conversation": 5,
    "agent-memory": 4,
    "forest-awareness": 3,
    "search": 5,
    "context-docket": 8,
    "work-item": 2,
    "playbook-commands": 3,
    "work-commands": 3,
    "queue": 7,
    "skills": 5,
  },
};

const MODE_TOKEN_BUDGETS: Record<ContextMode, number> = {
  conversation: 80_000,    // ~30k active content after trimming
  strategy: 150_000,       // broad awareness
  workflow: 120_000,       // operational
  "deep-work": 190_000,    // room for codebase context
};

/** Get section priority overrides for a mode. */
export function getModeSectionPriorities(mode: ContextMode): Record<string, number> {
  return MODE_PRIORITIES[mode];
}

/** Get token budget for a mode. */
export function getModeTokenBudget(mode: ContextMode): number {
  return MODE_TOKEN_BUDGETS[mode];
}

// ── Transition handling ─────────────────────────────────────

/**
 * Process a user message for mode detection in a conversation.
 * Handles transitions with logging. Returns the active mode.
 */
export function processMessageMode(
  conversationId: string,
  userMessage: string,
): { mode: ContextMode; changed: boolean; detection: ModeDetectionResult | null } {
  const previousMode = getConversationMode(conversationId);
  const detection = detectMode(userMessage);

  if (!detection) {
    return { mode: previousMode, changed: false, detection: null };
  }

  // Only switch on high confidence, or if it's a manual override
  if (detection.confidence === "medium" && detection.mode !== previousMode) {
    logger.debug(`potential shift: ${previousMode} -> ${detection.mode} (medium confidence, staying)`, {
      signal: detection.signal,
    });
    return { mode: previousMode, changed: false, detection };
  }

  if (detection.mode !== previousMode) {
    logger.info(`transition: ${previousMode} -> ${detection.mode}`, {
      signal: detection.signal,
      confidence: detection.confidence,
      conversationId,
    });
    setConversationMode(conversationId, detection.mode);
    return { mode: detection.mode, changed: true, detection };
  }

  return { mode: previousMode, changed: false, detection };
}
