/**
 * Contextual Emoji in Agent Responses — ELLIE-639
 *
 * Provides:
 * 1. Emoji guidance prompt section for agent prompt injection
 * 2. Emoji stripping post-processor for when emoji is disabled
 * 3. Preference management (enable/disable per user)
 */

import { log } from "./logger.ts";
import { containsEmoji } from "./emoji-utils.ts";

const logger = log.child("emoji-response");

// ============================================================
// TYPES
// ============================================================

export type EmojiStyle = "none" | "minimal" | "balanced" | "expressive";

export interface EmojiPreferences {
  enabled: boolean;
  style: EmojiStyle;
}

export const DEFAULT_EMOJI_PREFS: EmojiPreferences = {
  enabled: true,
  style: "minimal",
};

// ============================================================
// EMOJI GUIDANCE — Prompt Injection
// ============================================================

const STYLE_GUIDANCE: Record<EmojiStyle, string> = {
  none: "",
  minimal: `Use emoji sparingly in your responses — at most 1 per message, and only when it genuinely adds meaning.
Good uses: a single emoji to celebrate a win (🎉), signal a warning (⚠️), or acknowledge completion (✅).
Bad uses: multiple emoji in one message, emoji that repeat the meaning of adjacent text, emoji at the start of every sentence.
When in doubt, leave it out. Plain text is always fine.`,

  balanced: `You may use emoji naturally in your responses — up to 2 per message.
Use them to add personality, warmth, and visual cues that make messages easier to scan:
- Celebrate wins and milestones: 🎉 🏆 ✅
- Signal warnings, blockers, or concerns: ⚠️ 🚨 ❌
- Show progress and momentum: 🚀 📈 💪
- Add warmth and acknowledgment: 👍 ❤️ 🙌
- Indicate thinking, analysis, or discovery: 🤔 💡 🔍
Keep it natural — emoji should complement your text, not replace it. Place them at the end of a thought, not the beginning.`,

  expressive: `Feel free to use emoji generously in your responses — up to 3-4 per message.
Use them to bring personality, energy, and emotional warmth to every interaction:
- Wins, celebrations, and milestones: 🎉 🏆 ✅ 🥳
- Greetings, warmth, and encouragement: 👋 ❤️ 😊 🙌
- Emphasis, excitement, and momentum: 🔥 💯 🚀 ⭐
- Warnings, concerns, and blockers: ⚠️ 🚨 ❌ 😬
- Analysis, thinking, and discovery: 🤔 💡 🔍 🧐
- Humor and playfulness: 😄 🤷 🎭 🫡
Let your personality shine through your emoji choices! Emoji make messages feel alive and human — use them to create a warm, engaging experience. Place them naturally throughout your message wherever they add feeling or emphasis.`,
};

/**
 * Build the emoji guidance prompt section for injection into agent prompts.
 * Returns null if emoji is disabled (no section needed).
 */
export function buildEmojiGuidance(prefs: EmojiPreferences): string | null {
  if (!prefs.enabled || prefs.style === "none") return null;

  const guidance = STYLE_GUIDANCE[prefs.style];
  if (!guidance) return null;

  return `EMOJI IN RESPONSES:\n${guidance}`;
}

// ============================================================
// EMOJI STRIPPING — Post-Processor
// ============================================================

/**
 * Regex matching most emoji (simplified, covers common emoji ranges).
 * Uses Unicode property escapes for broad coverage.
 */
const EMOJI_STRIP_REGEX = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE0F}\u{200D}]/gu;

/**
 * Common text-based emoji that should NOT be stripped (they have semantic meaning in code/text).
 * e.g. ✅ ❌ ⚠️ are often used in structured output.
 */
const PRESERVE_EMOJI = new Set(["✅", "❌", "⚠️", "✓", "✗", "→", "←", "↑", "↓", "•"]);

/**
 * Strip emoji from a response text. Preserves structural emoji (checkmarks, arrows, bullets).
 * Cleans up leftover whitespace from removal.
 */
export function stripEmoji(text: string): string {
  if (!containsEmoji(text)) return text;

  // Use Intl.Segmenter for accurate grapheme-level processing
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
    const segments = segmenter.segment(text);
    let result = "";
    for (const { segment } of segments) {
      if (PRESERVE_EMOJI.has(segment)) {
        result += segment;
      } else if (new RegExp(EMOJI_STRIP_REGEX.source, "u").test(segment)) {
        // Skip emoji — but add a space if needed to avoid word merging
        if (result.length > 0 && !result.endsWith(" ") && !result.endsWith("\n")) {
          result += " ";
        }
      } else {
        result += segment;
      }
    }
    // Clean up double spaces
    return result.replace(/  +/g, " ").replace(/ +\n/g, "\n").trim();
  }

  // Fallback: regex-based stripping
  return text
    .replace(EMOJI_STRIP_REGEX, " ")
    .replace(/  +/g, " ")
    .replace(/ +\n/g, "\n")
    .trim();
}

/**
 * Post-process an agent response based on emoji preferences.
 * If emoji is disabled, strips emoji from the response.
 */
export function postProcessEmojiResponse(
  text: string,
  prefs: EmojiPreferences
): string {
  if (prefs.enabled && prefs.style !== "none") return text;
  return stripEmoji(text);
}

// ============================================================
// PREFERENCE MANAGEMENT
// ============================================================

export interface EmojiPrefsDeps {
  getPrefs: () => Promise<EmojiPreferences>;
  setPrefs: (prefs: Partial<EmojiPreferences>) => Promise<EmojiPreferences>;
}

/**
 * Create Supabase-backed emoji preference deps.
 */
export function makeEmojiPrefsDeps(supabase: {
  from: (table: string) => any;
}): EmojiPrefsDeps {
  return {
    async getPrefs() {
      try {
        const { data } = await supabase
          .from("agent_preferences")
          .select("key, value")
          .in("key", ["emoji_enabled", "emoji_style"]);

        if (!data || data.length === 0) return { ...DEFAULT_EMOJI_PREFS };

        const prefs = { ...DEFAULT_EMOJI_PREFS };
        for (const row of data) {
          if (row.key === "emoji_enabled") prefs.enabled = row.value === true || row.value === "true";
          if (row.key === "emoji_style") prefs.style = row.value as EmojiStyle;
        }
        return prefs;
      } catch {
        return { ...DEFAULT_EMOJI_PREFS };
      }
    },

    async setPrefs(updates) {
      const current = await this.getPrefs();
      const merged = { ...current, ...updates };

      await supabase.from("agent_preferences").upsert([
        { key: "emoji_enabled", value: merged.enabled, updated_at: new Date().toISOString() },
        { key: "emoji_style", value: merged.style, updated_at: new Date().toISOString() },
      ], { onConflict: "key" });

      return merged;
    },
  };
}

// ============================================================
// MOCK HELPERS (for testing)
// ============================================================

export function _makeMockEmojiPrefsDeps(
  initial?: Partial<EmojiPreferences>
): { deps: EmojiPrefsDeps; store: { prefs: EmojiPreferences } } {
  const store = {
    prefs: { ...DEFAULT_EMOJI_PREFS, ...initial },
  };

  const deps: EmojiPrefsDeps = {
    async getPrefs() {
      return { ...store.prefs };
    },
    async setPrefs(updates) {
      store.prefs = { ...store.prefs, ...updates };
      return { ...store.prefs };
    },
  };

  return { deps, store };
}
