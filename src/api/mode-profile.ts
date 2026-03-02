/**
 * Mode Profile — ELLIE-426
 *
 * Resolves an archetype profile from a mode string (general | dev | research | strategy).
 * Replaces the channel-based ChannelContextProfile resolution from ELLIE-334.
 *
 * The ChannelContextProfile type is defined here so dependents (ellie-chat-handler,
 * prompt-builder) can import from this module instead of the deleted chat-channels.ts.
 */

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { parseCreatureProfile } from "../creature-profile.ts";
import type { ContextMode } from "../context-mode.ts";
import { getModeTokenBudget } from "../context-mode.ts";

const PROJECT_ROOT = dirname(dirname(dirname(import.meta.path)));
const ARCHETYPES_DIR = join(PROJECT_ROOT, "config", "archetypes");

// ── Types ────────────────────────────────────────────────────

export interface ChannelContextProfile {
  channelName: string;
  channelSlug: string;
  contextMode: ContextMode;
  tokenBudget: number;
  contextPriority: number | null;
  criticalSources: string[];
  suppressedSections: string[];
  workItemId: string | null;
}

// Mode → ContextMode mapping
const MODE_CONTEXT_MAP: Record<string, ContextMode> = {
  general: "conversation",
  dev: "deep-work",
  research: "strategy",
  strategy: "strategy",
};

const MODE_LABELS: Record<string, string> = {
  general: "General",
  dev: "Dev",
  research: "Research",
  strategy: "Strategy",
};

/**
 * Resolve an archetype profile for the given mode.
 * Falls back to general defaults if the archetype file is not found.
 */
export async function resolveArchetypeProfile(mode: string): Promise<ChannelContextProfile> {
  const normalizedMode = (mode || "general").toLowerCase().replace(/[^a-z0-9-]/g, "");
  const contextMode: ContextMode = MODE_CONTEXT_MAP[normalizedMode] ?? "conversation";
  const defaultBudget = getModeTokenBudget(contextMode);

  try {
    const filePath = join(ARCHETYPES_DIR, `${normalizedMode}.md`);
    const raw = await readFile(filePath, "utf-8");
    const { profile } = parseCreatureProfile(raw);

    return {
      channelName: MODE_LABELS[normalizedMode] ?? normalizedMode,
      channelSlug: normalizedMode,
      contextMode,
      tokenBudget: profile?.token_budget ?? defaultBudget,
      contextPriority: null,
      criticalSources: [],
      suppressedSections: [],
      workItemId: null,
    };
  } catch {
    // Archetype file not found — return defaults for the context mode
    return {
      channelName: MODE_LABELS[normalizedMode] ?? normalizedMode,
      channelSlug: normalizedMode,
      contextMode,
      tokenBudget: defaultBudget,
      contextPriority: null,
      criticalSources: [],
      suppressedSections: [],
      workItemId: null,
    };
  }
}
