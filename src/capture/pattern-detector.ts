/**
 * Proactive Pattern Detection — ELLIE-777
 * Monitors conversations for River-worthy content patterns.
 * Lightweight regex-based classification layer with configurable threshold.
 */

import type { CaptureContentType, Channel } from "../capture-queue.ts";

// Types

export interface DetectionResult {
  detected: boolean;
  content_type: CaptureContentType;
  confidence: number;
  matched_patterns: string[];
  trigger_text: string;
}

export interface DetectorConfig {
  confidence_threshold: number;
  min_message_length: number;
  cooldown_seconds: number;
}

export const DEFAULT_CONFIG: DetectorConfig = {
  confidence_threshold: 0.8,
  min_message_length: 30,
  cooldown_seconds: 60,
};

// Pattern definitions

interface PatternRule {
  name: string;
  content_type: CaptureContentType;
  patterns: RegExp[];
  weight: number;
}

const PATTERN_RULES: PatternRule[] = [
  {
    name: "workflow_sequence",
    content_type: "workflow",
    patterns: [
      /\b(first|step\s+1)[\s,].*(then|next|after that|step\s+2)/is,
      /\bthe\s+(process|flow|pipeline|sequence)\s+(is|goes|works)/i,
      /\bhere'?s?\s+how\s+.{1,30}\s+works/i,
      /\bwhen\s+\w+.*,?\s+(then|we|you)\s+/i,
    ],
    weight: 0.25,
  },
  {
    name: "decision_made",
    content_type: "decision",
    patterns: [
      /\b(i|we)\s+(decided|chose|picked|went\s+with|settled\s+on)/i,
      /\b(going|went)\s+with\s+\w+\s+(because|since|over)/i,
      /\blet'?s?\s+use\s+\w+/i,
      /\b(the\s+decision|we'?ll?\s+go)\s+(is|with)/i,
      /\b(chose|picking|choosing)\s+\w+\s+(over|instead\s+of)/i,
    ],
    weight: 0.2,
  },
  {
    name: "policy_rule",
    content_type: "policy",
    patterns: [
      /\b(the\s+rule\s+is|policy\s+is)\b/i,
      /\b(always|never)\s+(make\s+sure|do|check|run|ensure)/i,
      /\bmust\s+(always|never|be)\b/i,
      /\b(required|mandatory|forbidden|prohibited)\b/i,
      /\bunder\s+no\s+circumstances\b/i,
    ],
    weight: 0.2,
  },
  {
    name: "process_routine",
    content_type: "process",
    patterns: [
      /\bevery\s+(morning|day|week|time|monday|sprint)/i,
      /\bwhen\s+\w+\s+happens?,?\s+(we|you|i)\s+(do|run|check|call)/i,
      /\b(how\s+to|procedure\s+for|steps?\s+to)\b/i,
      /\bthe\s+way\s+(we|i)\s+(do|handle|manage)/i,
      /\b(routine|checklist|sop)\s+(is|for)\b/i,
    ],
    weight: 0.2,
  },
  {
    name: "integration_spec",
    content_type: "integration",
    patterns: [
      /\b\w+\s+(connects?\s+to|integrates?\s+with|syncs?\s+with)\s+\w+/i,
      /\bthe\s+api\s+(expects?|requires?|accepts?|returns?)/i,
      /\b(webhook|endpoint|auth\s+token|api\s+key)\s+(is|at|for)\b/i,
      /\b(send|post|get|put)\s+(to|from)\s+(the\s+)?\w+\s+(api|endpoint|service)/i,
    ],
    weight: 0.25,
  },
];

// Cooldown tracking (per channel+user to avoid spam)

const lastDetection = new Map<string, number>();

function isCooledDown(key: string, cooldownMs: number): boolean {
  const last = lastDetection.get(key);
  if (!last) return true;
  return Date.now() - last >= cooldownMs;
}

function recordDetection(key: string): void {
  lastDetection.set(key, Date.now());
}

// Main detection

export function detectPatterns(
  text: string,
  config: DetectorConfig = DEFAULT_CONFIG,
): DetectionResult {
  const empty: DetectionResult = {
    detected: false,
    content_type: "reference",
    confidence: 0,
    matched_patterns: [],
    trigger_text: "",
  };

  if (text.length < config.min_message_length) return empty;

  let bestType: CaptureContentType = "reference";
  let bestConfidence = 0;
  const allMatches: string[] = [];

  for (const rule of PATTERN_RULES) {
    let matchCount = 0;
    for (const pattern of rule.patterns) {
      if (pattern.test(text)) {
        matchCount++;
        allMatches.push(rule.name);
      }
    }

    if (matchCount > 0) {
      const confidence = Math.min(matchCount * rule.weight + 0.4, 0.95);
      if (confidence > bestConfidence) {
        bestConfidence = confidence;
        bestType = rule.content_type;
      }
    }
  }

  // Round to 2 decimal places
  bestConfidence = Math.round(bestConfidence * 100) / 100;

  if (bestConfidence < config.confidence_threshold) return empty;

  return {
    detected: true,
    content_type: bestType,
    confidence: bestConfidence,
    matched_patterns: [...new Set(allMatches)],
    trigger_text: text.substring(0, 200),
  };
}

// Full pipeline: detect + cooldown + queue insertion

export async function scanMessage(
  sql: any,
  text: string,
  channel: Channel,
  cooldownKey: string,
  sourceMessageId?: string,
  config: DetectorConfig = DEFAULT_CONFIG,
): Promise<DetectionResult & { queued: boolean; capture_id?: string }> {
  const result = detectPatterns(text, config);

  if (!result.detected) {
    return { ...result, queued: false };
  }

  if (!isCooledDown(cooldownKey, config.cooldown_seconds * 1000)) {
    return { ...result, queued: false };
  }

  try {
    const rows = await sql`
      INSERT INTO capture_queue (
        channel, raw_content, capture_type, content_type, confidence, source_message_id, status
      ) VALUES (
        ${channel},
        ${text},
        'proactive',
        ${result.content_type},
        ${result.confidence},
        ${sourceMessageId ?? null},
        'queued'
      )
      RETURNING id
    `;

    recordDetection(cooldownKey);

    return {
      ...result,
      queued: true,
      capture_id: rows[0]?.id,
    };
  } catch {
    return { ...result, queued: false };
  }
}

// Update config at runtime

export function mergeConfig(overrides: Partial<DetectorConfig>): DetectorConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

// For testing
export function _clearCooldowns(): void {
  lastDetection.clear();
}

export function _getPatternRules(): PatternRule[] {
  return PATTERN_RULES;
}
