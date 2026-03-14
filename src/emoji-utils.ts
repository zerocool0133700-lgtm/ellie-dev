/**
 * Emoji Utilities — ELLIE-638
 *
 * Shared emoji helpers for Ellie Chat input picker, reactions (ELLIE-637),
 * and contextual emoji in agent responses (ELLIE-639).
 */

// ============================================================
// EMOJI CATEGORIES
// ============================================================

export const EMOJI_CATEGORIES = {
  "Smileys": ["😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😂", "🙂", "🙃", "😉", "😊", "😇", "🥰", "😍", "🤩", "😘", "😗", "😚", "😙", "🥲", "😋", "😛", "😜", "🤪", "😝", "🤑", "🤗", "🤭", "🤫", "🤔", "🫡", "🤐", "🤨", "😐", "😑", "😶", "😏", "😒", "🙄", "😬", "🤥", "😌", "😔", "😪", "🤤", "😴", "😷", "🤒", "🤕", "🤢", "🤮", "🥵", "🥶", "🥴", "😵", "🤯", "🤠", "🥳", "🥸", "😎", "🤓", "🧐"],
  "Gestures": ["👍", "👎", "👊", "✊", "🤛", "🤜", "👏", "🙌", "👐", "🤲", "🤝", "🙏", "✌️", "🤞", "🤟", "🤘", "🤙", "👈", "👉", "👆", "👇", "☝️", "✋", "🤚", "🖐️", "🖖", "👋", "🤏", "✍️", "💪"],
  "Hearts": ["❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "🤎", "💔", "❤️‍🔥", "❤️‍🩹", "💕", "💞", "💓", "💗", "💖", "💘", "💝"],
  "Objects": ["🎉", "🎊", "🏆", "🥇", "🎯", "🔥", "⭐", "🌟", "💡", "💯", "✅", "❌", "⚠️", "🚀", "💻", "📱", "📧", "📅", "📋", "📝", "🔗", "🔒", "🔑", "⏰", "📊", "📈", "📉"],
  "Nature": ["🌸", "🌺", "🌻", "🌹", "🌷", "🌱", "🌿", "☘️", "🍀", "🌴", "🌳", "🌲", "⛅", "🌈", "⚡", "❄️", "🔆"],
  "Food": ["☕", "🍵", "🧃", "🥤", "🍺", "🍷", "🍰", "🎂", "🍕", "🍔", "🌮", "🥗", "🍎", "🍊", "🍋"],
} as const;

export type EmojiCategory = keyof typeof EMOJI_CATEGORIES;

// ============================================================
// EMOJI SEARCH
// ============================================================

/** Keyword → emoji mappings for search. */
const EMOJI_KEYWORDS: Record<string, string[]> = {
  "👍": ["thumbs up", "like", "yes", "agree", "good", "ok", "approve"],
  "👎": ["thumbs down", "dislike", "no", "disagree", "bad"],
  "❤️": ["heart", "love", "like"],
  "😂": ["laugh", "lol", "funny", "haha", "joy"],
  "😊": ["smile", "happy", "blush"],
  "😢": ["cry", "sad", "tear"],
  "😡": ["angry", "mad", "rage"],
  "🤔": ["think", "thinking", "hmm", "wonder"],
  "😎": ["cool", "sunglasses"],
  "🎉": ["party", "celebrate", "congrats", "tada"],
  "🔥": ["fire", "hot", "lit", "awesome"],
  "💯": ["hundred", "perfect", "100"],
  "✅": ["check", "done", "complete", "yes"],
  "❌": ["cross", "no", "wrong", "cancel", "delete"],
  "🚀": ["rocket", "launch", "ship", "deploy", "fast"],
  "💡": ["idea", "lightbulb", "insight"],
  "⭐": ["star", "favorite", "important"],
  "👀": ["eyes", "look", "watching", "see"],
  "🤝": ["handshake", "deal", "agree", "partner"],
  "🙏": ["pray", "please", "thanks", "grateful"],
  "💻": ["computer", "laptop", "code", "dev"],
  "📊": ["chart", "graph", "data", "stats"],
  "📅": ["calendar", "date", "schedule"],
  "⚠️": ["warning", "alert", "caution"],
  "🏆": ["trophy", "win", "champion"],
  "☕": ["coffee", "morning", "break"],
  "🎯": ["target", "goal", "bullseye", "aim"],
  "👏": ["clap", "applause", "bravo"],
  "🙌": ["hands", "celebration", "hooray", "yay"],
  "😴": ["sleep", "tired", "zzz", "bored"],
  "🤯": ["mind blown", "explode", "shocked", "amazing"],
  "🥳": ["party", "birthday", "celebrate"],
  "💪": ["muscle", "strong", "power", "flex"],
  "🤞": ["fingers crossed", "hope", "luck"],
  "📝": ["note", "memo", "write", "document"],
  "🔑": ["key", "important", "access", "secret"],
  "📈": ["up", "growth", "increase", "trending"],
  "📉": ["down", "decrease", "decline", "falling"],
  "🌟": ["sparkle", "star", "shine", "brilliant"],
};

/**
 * Search emoji by keyword. Returns matching emoji sorted by relevance.
 */
export function searchEmoji(query: string, limit = 20): string[] {
  if (!query.trim()) return [];

  const q = query.toLowerCase().trim();
  const results: Array<{ emoji: string; score: number }> = [];

  for (const [emoji, keywords] of Object.entries(EMOJI_KEYWORDS)) {
    for (const keyword of keywords) {
      if (keyword.startsWith(q)) {
        // Prefix match — higher score
        results.push({ emoji, score: keyword === q ? 3 : 2 });
        break;
      } else if (keyword.includes(q)) {
        // Substring match — lower score
        results.push({ emoji, score: 1 });
        break;
      }
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.emoji);
}

// ============================================================
// CURSOR INSERTION
// ============================================================

/**
 * Insert text at a cursor position within a string.
 * Returns the new string and the new cursor position.
 */
export function insertAtCursor(
  text: string,
  insertText: string,
  cursorStart: number,
  cursorEnd?: number
): { result: string; newCursor: number } {
  const end = cursorEnd ?? cursorStart;
  const before = text.slice(0, cursorStart);
  const after = text.slice(end);
  return {
    result: before + insertText + after,
    newCursor: cursorStart + insertText.length,
  };
}

// ============================================================
// EMOJI DETECTION
// ============================================================

/** Regex to match most common emoji (simplified — covers BMP emoji + modifiers). */
const EMOJI_REGEX = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2702}-\u{27B0}\u{24C2}-\u{1F251}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/u;

/**
 * Check if a string contains emoji.
 */
export function containsEmoji(text: string): boolean {
  return EMOJI_REGEX.test(text);
}

/**
 * Extract all emoji from a string.
 */
export function extractEmoji(text: string): string[] {
  // Use segmenter for accurate emoji extraction (handles compound emoji)
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
    const segments = segmenter.segment(text);
    const emoji: string[] = [];
    for (const { segment } of segments) {
      if (EMOJI_REGEX.test(segment)) {
        emoji.push(segment);
      }
    }
    return emoji;
  }

  // Fallback: simple regex match
  const matches = text.match(new RegExp(EMOJI_REGEX.source, "gu"));
  return matches || [];
}

/**
 * Count emoji in a string.
 */
export function countEmoji(text: string): number {
  return extractEmoji(text).length;
}
