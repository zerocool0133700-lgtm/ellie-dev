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

/** Maps short mode names to their Forest profile names. */
const AGENT_PROFILE_MAP: Record<string, string> = {
  general: "general-squirrel",
  dev: "dev-ant",
  research: "research-squirrel",
  strategy: "strategy-squirrel",
};

/**
 * Resolve an archetype profile for the given mode.
 * Priority: Forest wiring (token_budget, context_mode) → file-based → defaults.
 */
export async function resolveArchetypeProfile(mode: string): Promise<ChannelContextProfile> {
  const normalizedMode = (mode || "general").toLowerCase().replace(/[^a-z0-9-]/g, "");
  const contextMode: ContextMode = MODE_CONTEXT_MAP[normalizedMode] ?? "conversation";
  const defaultBudget = getModeTokenBudget(contextMode);

  // ELLIE-413-416: Try Forest wiring first for token_budget and context_mode
  const forestProfileName = AGENT_PROFILE_MAP[normalizedMode];
  if (forestProfileName) {
    try {
      const { getAgentWiring } = await import("../agent-profile-builder.ts");
      const wiring = await getAgentWiring(forestProfileName);
      if (wiring) {
        return {
          channelName: MODE_LABELS[normalizedMode] ?? normalizedMode,
          channelSlug: normalizedMode,
          contextMode: (wiring.context_mode as ContextMode) ?? contextMode,
          tokenBudget: wiring.token_budget ?? defaultBudget,
          contextPriority: null,
          criticalSources: [],
          suppressedSections: [],
          workItemId: null,
        };
      }
    } catch {
      // Forest unavailable — fall through to file-based
    }
  }

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
