/**
 * Relay Utilities — Pure functions extracted from relay.ts for testability.
 *
 * relay.ts has module-level side effects (HTTP server, bot startup) which
 * make it impossible to import for unit testing. These pure functions are
 * extracted here so they can be tested independently.
 */

import { log } from "./logger.ts";

const logger = log.child("relay-utils");

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

/** Format forest metrics for chat display (ELLIE-113). */
export function formatForestMetrics(m: {
  creaturesByEntity: Record<string, number>;
  eventsByKind: Record<string, number>;
  treesByType: Record<string, number>;
  creaturesByState: Record<string, number>;
  failureRate: number;
  totalEvents: number;
  totalCreatures: number;
  totalTrees: number;
}): string {
  const lines = ["Forest Metrics (last 7 days)\n"];

  lines.push(`Events: ${m.totalEvents} | Creatures: ${m.totalCreatures} | Trees: ${m.totalTrees}`);
  lines.push(`Failure rate: ${(m.failureRate * 100).toFixed(1)}%`);

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

/** Estimate token count from character length (~4 chars/token for English). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
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
  // Fast path: if under budget, just join
  let totalChars = sections.reduce((sum, s) => sum + s.content.length, 0);
  const totalTokens = estimateTokens(totalChars.toString().length > 0 ? sections.map(s => s.content).join('\n') : '');

  if (totalTokens <= maxTokens) {
    return sections.map(s => s.content).join('\n');
  }

  // Over budget — need to trim
  const overBy = totalTokens - maxTokens;
  const overChars = overBy * 4; // convert back to chars for trimming
  logger.warn(
    `Prompt exceeds budget — trimming lower-priority sections`,
    { totalTokens, maxTokens, overBy }
  );

  // Sort trimmable sections: highest priority number first, then largest first
  const trimmable = sections
    .map((s, i) => ({ ...s, index: i }))
    .filter(s => s.priority > 1)
    .sort((a, b) => b.priority - a.priority || b.content.length - a.content.length);

  let charsToTrim = overChars;
  const trimmed = new Set<number>();
  const truncatedContent = new Map<number, string>();

  for (const section of trimmable) {
    if (charsToTrim <= 0) break;

    if (section.content.length <= charsToTrim) {
      // Remove this section entirely
      trimmed.add(section.index);
      charsToTrim -= section.content.length;
      logger.warn("Dropped section", { label: section.label, tokens: estimateTokens(section.content) });
    } else {
      // Truncate this section to fit
      const keepChars = section.content.length - charsToTrim;
      const truncatedText = section.content.slice(0, keepChars);
      // Cut at last newline to avoid mid-sentence breaks
      const lastNewline = truncatedText.lastIndexOf('\n');
      const cleanCut = lastNewline > keepChars * 0.5 ? truncatedText.slice(0, lastNewline) : truncatedText;
      truncatedContent.set(section.index, cleanCut + `\n[...truncated — ${section.label}]`);
      logger.warn("Truncated section", { label: section.label, originalChars: section.content.length, truncatedChars: cleanCut.length });
      charsToTrim = 0;
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
  logger.warn("Final prompt after trimming", { tokens: finalTokens });

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
