/**
 * Emoji Utilities Tests — ELLIE-638
 *
 * Tests emoji search, cursor insertion, detection, extraction,
 * and category structure.
 */

import { describe, test, expect } from "bun:test";
import {
  searchEmoji,
  insertAtCursor,
  containsEmoji,
  extractEmoji,
  countEmoji,
  EMOJI_CATEGORIES,
} from "../src/emoji-utils.ts";

// ── Emoji search ────────────────────────────────────────────

describe("searchEmoji", () => {
  test("empty query returns empty array", () => {
    expect(searchEmoji("")).toEqual([]);
    expect(searchEmoji("  ")).toEqual([]);
  });

  test("exact keyword match returns emoji", () => {
    const results = searchEmoji("thumbs up");
    expect(results).toContain("👍");
  });

  test("prefix match works", () => {
    const results = searchEmoji("laugh");
    expect(results).toContain("😂");
  });

  test("substring match works", () => {
    const results = searchEmoji("fire");
    expect(results).toContain("🔥");
  });

  test("case insensitive search", () => {
    expect(searchEmoji("HEART")).toContain("❤️");
    expect(searchEmoji("Heart")).toContain("❤️");
    expect(searchEmoji("heart")).toContain("❤️");
  });

  test("no results for unknown keyword", () => {
    expect(searchEmoji("xyznonexistent")).toEqual([]);
  });

  test("limit parameter caps results", () => {
    const results = searchEmoji("a", 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  test("multiple emoji can match same keyword", () => {
    const results = searchEmoji("celebrate");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  test("common work terms return relevant emoji", () => {
    expect(searchEmoji("deploy")).toContain("🚀");
    expect(searchEmoji("done")).toContain("✅");
    expect(searchEmoji("idea")).toContain("💡");
    expect(searchEmoji("warning")).toContain("⚠️");
    expect(searchEmoji("code")).toContain("💻");
    expect(searchEmoji("coffee")).toContain("☕");
  });

  test("exact match scores higher than prefix match", () => {
    const results = searchEmoji("fire");
    // "fire" is exact match for 🔥, should be first
    expect(results[0]).toBe("🔥");
  });
});

// ── Cursor insertion ────────────────────────────────────────

describe("insertAtCursor", () => {
  test("insert at beginning", () => {
    const { result, newCursor } = insertAtCursor("hello", "😀", 0);
    expect(result).toBe("😀hello");
    expect(newCursor).toBe(2); // emoji is 2 chars
  });

  test("insert at end", () => {
    const { result, newCursor } = insertAtCursor("hello", "😀", 5);
    expect(result).toBe("hello😀");
    expect(newCursor).toBe(7);
  });

  test("insert in middle", () => {
    const { result, newCursor } = insertAtCursor("helo", "l", 2);
    expect(result).toBe("hello");
    expect(newCursor).toBe(3);
  });

  test("insert replaces selection", () => {
    const { result, newCursor } = insertAtCursor("hello world", "😀", 5, 11);
    expect(result).toBe("hello😀");
    expect(newCursor).toBe(7);
  });

  test("empty text insertion", () => {
    const { result, newCursor } = insertAtCursor("hello", "", 3);
    expect(result).toBe("hello");
    expect(newCursor).toBe(3);
  });

  test("insert into empty string", () => {
    const { result, newCursor } = insertAtCursor("", "👍", 0);
    expect(result).toBe("👍");
    expect(newCursor).toBe(2);
  });

  test("multiple emoji insertion", () => {
    const { result } = insertAtCursor("hi ", "🎉🎊", 3);
    expect(result).toBe("hi 🎉🎊");
  });

  test("cursor position after emoji accounts for surrogate pairs", () => {
    const { result, newCursor } = insertAtCursor("abc", "🚀", 1);
    expect(result).toBe("a🚀bc");
    // "a" is 1 char, "🚀" is 2 chars (surrogate pair), cursor after emoji
    expect(newCursor).toBe(3);
  });

  test("replace all text (select all + insert)", () => {
    const { result, newCursor } = insertAtCursor("old text", "new", 0, 8);
    expect(result).toBe("new");
    expect(newCursor).toBe(3);
  });
});

// ── Emoji detection ─────────────────────────────────────────

describe("containsEmoji", () => {
  test("plain text has no emoji", () => {
    expect(containsEmoji("hello world")).toBe(false);
    expect(containsEmoji("12345")).toBe(false);
    expect(containsEmoji("")).toBe(false);
  });

  test("detects standard emoji", () => {
    expect(containsEmoji("hello 😀")).toBe(true);
    expect(containsEmoji("👍")).toBe(true);
    expect(containsEmoji("test 🚀 launch")).toBe(true);
  });

  test("detects emoji with modifiers", () => {
    expect(containsEmoji("🎉")).toBe(true);
    expect(containsEmoji("⭐")).toBe(true);
  });

  test("numbers and symbols are not emoji", () => {
    expect(containsEmoji("#1")).toBe(false);
    expect(containsEmoji("$100")).toBe(false);
    expect(containsEmoji("@user")).toBe(false);
  });
});

// ── Emoji extraction ────────────────────────────────────────

describe("extractEmoji", () => {
  test("no emoji returns empty array", () => {
    expect(extractEmoji("hello world")).toEqual([]);
  });

  test("extracts single emoji", () => {
    const result = extractEmoji("hello 😀 world");
    expect(result).toContain("😀");
  });

  test("extracts multiple emoji", () => {
    const result = extractEmoji("👍 great 🎉 work 🚀");
    expect(result.length).toBe(3);
    expect(result).toContain("👍");
    expect(result).toContain("🎉");
    expect(result).toContain("🚀");
  });

  test("extracts emoji from emoji-only string", () => {
    const result = extractEmoji("😀😂👍");
    expect(result.length).toBe(3);
  });

  test("empty string returns empty array", () => {
    expect(extractEmoji("")).toEqual([]);
  });
});

// ── Count emoji ─────────────────────────────────────────────

describe("countEmoji", () => {
  test("no emoji returns 0", () => {
    expect(countEmoji("hello")).toBe(0);
  });

  test("counts single emoji", () => {
    expect(countEmoji("hello 😀")).toBe(1);
  });

  test("counts multiple emoji", () => {
    expect(countEmoji("👍😂🎉")).toBe(3);
  });

  test("counts emoji mixed with text", () => {
    expect(countEmoji("hey 👍 nice 😂 work 🎉")).toBe(3);
  });
});

// ── Categories ──────────────────────────────────────────────

describe("EMOJI_CATEGORIES", () => {
  test("has expected category names", () => {
    const categories = Object.keys(EMOJI_CATEGORIES);
    expect(categories).toContain("Smileys");
    expect(categories).toContain("Gestures");
    expect(categories).toContain("Hearts");
    expect(categories).toContain("Objects");
    expect(categories).toContain("Nature");
    expect(categories).toContain("Food");
  });

  test("each category has at least 10 emoji", () => {
    for (const [name, emoji] of Object.entries(EMOJI_CATEGORIES)) {
      expect(emoji.length).toBeGreaterThanOrEqual(10);
    }
  });

  test("all category values are string arrays", () => {
    for (const emoji of Object.values(EMOJI_CATEGORIES)) {
      expect(Array.isArray(emoji)).toBe(true);
      for (const e of emoji) {
        expect(typeof e).toBe("string");
      }
    }
  });

  test("no duplicate emoji within a category", () => {
    for (const [name, emoji] of Object.entries(EMOJI_CATEGORIES)) {
      const unique = new Set(emoji);
      expect(unique.size).toBe(emoji.length);
    }
  });
});
