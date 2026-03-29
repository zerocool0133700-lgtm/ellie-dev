/**
 * Relay Utilities — Pure functions extracted from relay.ts for testability.
 *
 * relay.ts has module-level side effects (HTTP server, bot startup) which
 * make it impossible to import for unit testing. These pure functions are
 * extracted here so they can be tested independently.
 */

import { log } from "./logger.ts";
import { encodingForModel } from "js-tiktoken";
import { compressSection, type CompressedSection } from "./section-compressor.ts";

const logger = log.child("relay-utils");

// Initialize tokenizer once — cl100k_base is close to Claude's tokenizer (~5% variance)
let _encoder: ReturnType<typeof encodingForModel> | null = null;
function getEncoder() {
  if (!_encoder) _encoder = encodingForModel("gpt-4o");
  return _encoder;
}

/**
 * Enforce a combined character budget across search sources.
 * Sources are in priority order — earlier sources get preference.
 */
export function trimSearchContext(
  sources: string[],
  maxChars: number = 3000
): string {
  let remaining = maxChars;
  const parts: string[] = [];
  for (const content of sources) {
    if (!content || remaining <= 0) continue;
    if (content.length <= remaining) {
      parts.push(content);
      remaining -= content.length;
    } else {
      const truncated = content.slice(0, remaining);
      const lastNewline = truncated.lastIndexOf('\n');
      if (lastNewline > 0) parts.push(truncated.slice(0, lastNewline));
      remaining = 0;
    }
  }
  return parts.join('\n');
}

/** Quick contextual ack when handing off to a specialist agent. */
export function getSpecialistAck(agentName: string): string {
  const acks: Record<string, string> = {
    dev: "On it — sending that to the dev specialist.",
    research: "Let me look into that for you.",
    finance: "Checking on that with the finance specialist.",
    content: "I'll draft that up for you.",
    strategy: "Let me think through that strategically.",
  };
  return acks[agentName] || `Working on that — I've dispatched the ${agentName} specialist.`;
}

/** Format forest metrics for chat display (ELLIE-113, ELLIE-629). */
export function formatForestMetrics(m: {
  creaturesByEntity: Record<string, number>;
  eventsByKind: Record<string, number>;
  treesByType: Record<string, number>;
  creaturesByState: Record<string, number>;
  memoriesByType?: Record<string, number>;
  failureRate: number;
  totalEvents: number;
  totalCreatures: number;
  totalTrees: number;
  totalMemories?: number;
}): string {
  const lines = ["Forest Metrics (last 7 days)\n"];

  lines.push(`Events: ${m.totalEvents} | Creatures: ${m.totalCreatures} | Trees: ${m.totalTrees}`);
  if (m.totalMemories) {
    lines.push(`Shared memories: ${m.totalMemories}`);
  }
  lines.push(`Failure rate: ${(m.failureRate * 100).toFixed(1)}%`);

  if (m.memoriesByType && Object.keys(m.memoriesByType).length) {
    lines.push("\nMemories by type:");
    for (const [type, count] of Object.entries(m.memoriesByType).sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${type}: ${count}`);
    }
  }

  if (Object.keys(m.creaturesByEntity).length) {
    lines.push("\nCreatures by entity:");
    for (const [entity, count] of Object.entries(m.creaturesByEntity).sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${entity}: ${count}`);
    }
  }

  if (Object.keys(m.eventsByKind).length) {
    lines.push("\nEvents by kind:");
    for (const [kind, count] of Object.entries(m.eventsByKind).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      lines.push(`  ${kind}: ${count}`);
    }
  }

  if (Object.keys(m.creaturesByState).length) {
    lines.push("\nCreatures by state:");
    for (const [state, count] of Object.entries(m.creaturesByState).sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${state}: ${count}`);
    }
  }

  return lines.join("\n");
}

// ── Token Budget Guard (ELLIE-185) ──────────────────────────

/**
 * Count tokens using a proper tokenizer (ELLIE-245, unified ELLIE-495).
 *
 * Uses cl100k_base encoding via js-tiktoken (~5% variance from Claude's tokenizer).
 * The optional `model` parameter is accepted for call-site clarity and future
 * differentiation, but all models currently share the same cl100k_base encoder
 * since js-tiktoken has no Claude-specific encoding.
 * Falls back to character heuristic (~4 chars/token) if tokenizer fails.
 */
export function estimateTokens(text: string, _model?: string): number {
  if (!text) return 0;
  try {
    const enc = getEncoder();
    return enc.encode(text).length;
  } catch {
    // Fallback: ~4 chars/token for English
    return Math.ceil(text.length / 4);
  }
}

/**
 * A labeled prompt section with a priority for budget trimming.
 * Lower priority number = higher importance (trimmed last).
 */
export interface PromptSection {
  label: string;
  content: string;
  priority: number; // 1 = never trim, 2 = trim last, ... 9 = trim first
}

/**
 * Apply a token budget across prompt sections.
 * If total exceeds maxTokens, trims sections from highest priority number (least important) first.
 * Within same priority, trims the largest section first.
 * Sections with priority 1 are never trimmed.
 *
 * Returns the joined prompt string and logs warnings.
 */
export function applyTokenBudget(
  sections: PromptSection[],
  maxTokens: number = 150_000,
): string {
  // Apply 10% buffer margin to account for system prompt overhead (ELLIE-245)
  const effectiveMax = Math.floor(maxTokens * 0.9);

  // Fast path: if under budget, just join
  const joined = sections.map(s => s.content).join('\n');
  const totalTokens = estimateTokens(joined);

  if (totalTokens <= effectiveMax) {
    return joined;
  }

  // Over budget — need to trim by removing/truncating sections
  logger.warn(
    `Prompt exceeds budget — trimming lower-priority sections`,
    { totalTokens, effectiveMax, overBy: totalTokens - effectiveMax }
  );

  // Pre-compute token counts per section
  const sectionTokens = sections.map(s => estimateTokens(s.content));
  let tokensToTrim = totalTokens - effectiveMax;

  // Sort trimmable sections: highest priority number first, then largest first
  const trimmable = sections
    .map((s, i) => ({ ...s, index: i, tokens: sectionTokens[i] }))
    .filter(s => s.priority > 1)
    .sort((a, b) => b.priority - a.priority || b.tokens - a.tokens);

  const trimmed = new Set<number>();
  const truncatedContent = new Map<number, string>();

  for (const section of trimmable) {
    if (tokensToTrim <= 0) break;

    if (section.tokens <= tokensToTrim) {
      // Remove this section entirely
      trimmed.add(section.index);
      tokensToTrim -= section.tokens;
      logger.warn("Dropped section", { label: section.label, tokens: section.tokens });
    } else {
      // Truncate this section — estimate how much text to keep
      // Use ratio of tokens to trim vs section tokens to determine cut point
      const keepRatio = 1 - (tokensToTrim / section.tokens);
      const keepChars = Math.floor(section.content.length * keepRatio);
      const truncatedText = section.content.slice(0, keepChars);
      // Cut at last newline to avoid mid-sentence breaks
      const lastNewline = truncatedText.lastIndexOf('\n');
      const cleanCut = lastNewline > keepChars * 0.5 ? truncatedText.slice(0, lastNewline) : truncatedText;
      truncatedContent.set(section.index, cleanCut + `\n[...truncated — ${section.label}]`);
      logger.warn("Truncated section", { label: section.label, originalTokens: section.tokens, keptChars: cleanCut.length });
      tokensToTrim = 0;
    }
  }

  // Reassemble with trimmed/truncated sections
  const result: string[] = [];
  for (let i = 0; i < sections.length; i++) {
    if (trimmed.has(i)) continue;
    if (truncatedContent.has(i)) {
      result.push(truncatedContent.get(i)!);
    } else {
      result.push(sections[i].content);
    }
  }

  const finalTokens = estimateTokens(result.join('\n'));
  logger.warn("Final prompt after trimming", { tokens: finalTokens, targetMax: effectiveMax });

  return result.join('\n');
}

/**
 * Async version of applyTokenBudget that tries compression before dropping.
 * Priority tiers:
 *   1-5: Include (never trimmed)
 *   6-8: Try compression via section-compressor before dropping
 *   9+:  Suppress entirely (no compression attempt)
 *
 * The original sync applyTokenBudget is preserved unchanged.
 */
export async function applyTokenBudgetWithCompression(
  sections: PromptSection[],
  maxTokens: number = 150_000,
): Promise<string> {
  // Apply 10% buffer margin to account for system prompt overhead (ELLIE-245)
  const effectiveMax = Math.floor(maxTokens * 0.9);

  // Fast path: if under budget, just join
  const joined = sections.map(s => s.content).join('\n');
  const totalTokens = estimateTokens(joined);

  if (totalTokens <= effectiveMax) {
    return joined;
  }

  // Over budget — need to trim by removing/truncating sections
  logger.warn(
    `Prompt exceeds budget — trimming with compression`,
    { totalTokens, effectiveMax, overBy: totalTokens - effectiveMax }
  );

  // Pre-compute token counts per section
  const sectionTokens = sections.map(s => estimateTokens(s.content));
  let tokensToTrim = totalTokens - effectiveMax;

  // Sort trimmable sections: highest priority number first, then largest first
  const trimmable = sections
    .map((s, i) => ({ ...s, index: i, tokens: sectionTokens[i] }))
    .filter(s => s.priority > 1)
    .sort((a, b) => b.priority - a.priority || b.tokens - a.tokens);

  const trimmed = new Set<number>();
  const truncatedContent = new Map<number, string>();

  for (const section of trimmable) {
    if (tokensToTrim <= 0) break;

    // Priority 9+: suppress entirely (no compression attempt)
    if (section.priority >= 9) {
      trimmed.add(section.index);
      tokensToTrim -= section.tokens;
      logger.warn("Suppressed section", { label: section.label, tokens: section.tokens });
      continue;
    }

    // Priority 6-8: try compression before dropping
    if (section.priority >= 6 && section.tokens >= 100) {
      try {
        const compressed = await compressSection(section.label, section.content, section.priority);
        if (compressed.compressed && compressed.shadowId) {
          const savedTokens = section.tokens - estimateTokens(compressed.content);
          if (savedTokens > 0) {
            truncatedContent.set(section.index, compressed.content);
            tokensToTrim -= savedTokens;
            logger.info("Compressed section", { label: section.label, saved: savedTokens, shadowId: compressed.shadowId });
            continue;
          }
        }
      } catch {
        // Compression failed — fall through to drop
      }
    }

    // Fallback: drop or truncate (same logic as sync version)
    if (section.tokens <= tokensToTrim) {
      trimmed.add(section.index);
      tokensToTrim -= section.tokens;
      logger.warn("Dropped section", { label: section.label, tokens: section.tokens });
    } else {
      // Truncate this section — estimate how much text to keep
      const keepRatio = 1 - (tokensToTrim / section.tokens);
      const keepChars = Math.floor(section.content.length * keepRatio);
      const truncatedText = section.content.slice(0, keepChars);
      const lastNewline = truncatedText.lastIndexOf('\n');
      const cleanCut = lastNewline > keepChars * 0.5 ? truncatedText.slice(0, lastNewline) : truncatedText;
      truncatedContent.set(section.index, cleanCut + `\n[...truncated — ${section.label}]`);
      logger.warn("Truncated section", { label: section.label, originalTokens: section.tokens, keptChars: cleanCut.length });
      tokensToTrim = 0;
    }
  }

  // Reassemble with trimmed/truncated sections
  const result: string[] = [];
  for (let i = 0; i < sections.length; i++) {
    if (trimmed.has(i)) continue;
    if (truncatedContent.has(i)) {
      result.push(truncatedContent.get(i)!);
    } else {
      result.push(sections[i].content);
    }
  }

  const finalTokens = estimateTokens(result.join('\n'));
  logger.warn("Final prompt after compression+trimming", { tokens: finalTokens, targetMax: effectiveMax });

  return result.join('\n');
}

/** Map HealthCategory → MemoryCategory for memory writes. */
export function mapHealthToMemoryCategory(hc: string): string {
  switch (hc) {
    case 'condition': case 'medication': case 'symptom': case 'doctor_visit':
    case 'barrier': case 'sleep':
      return 'health'
    case 'fitness': case 'nutrition':
      return 'fitness'
    case 'mental_health': case 'anxiety': case 'depression_sign': case 'grief':
    case 'stress_load': case 'mood_shift': case 'overwhelm':
      return 'mental_health'
    case 'focus': case 'organization': case 'time_mgmt': case 'follow_through':
    case 'career_change':
      return 'work'
    case 'relationship': case 'loneliness': case 'conflict':
    case 'social_seeking': case 'relationship_milestone':
      return 'relationships'
    case 'caregiving':
      return 'family'
    case 'financial_stress': case 'income': case 'cost_barrier': case 'financial_goal':
      return 'financial'
    case 'dyslexia_esl': case 'tech_literacy': case 'learning_style': case 'communication_need':
      return 'learning'
    case 'relocation': case 'life_role_change': case 'identity':
      return 'identity'
    default:
      return 'general'
  }
}
