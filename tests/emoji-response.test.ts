/**
 * Contextual Emoji Response Tests — ELLIE-639
 *
 * Tests emoji guidance builder, emoji stripping post-processor,
 * preference management, and prompt injection.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  buildEmojiGuidance,
  stripEmoji,
  postProcessEmojiResponse,
  DEFAULT_EMOJI_PREFS,
  _makeMockEmojiPrefsDeps,
  type EmojiPreferences,
  type EmojiStyle,
  type EmojiPrefsDeps,
} from "../src/emoji-response.ts";
import {
  _injectEmojiGuidanceForTesting,
  getEmojiGuidanceCache,
} from "../src/prompt-builder.ts";

// ── Emoji Guidance Builder ──────────────────────────────────

describe("buildEmojiGuidance", () => {
  test("returns null when disabled", () => {
    expect(buildEmojiGuidance({ enabled: false, style: "minimal" })).toBeNull();
  });

  test("returns null for style 'none'", () => {
    expect(buildEmojiGuidance({ enabled: true, style: "none" })).toBeNull();
  });

  test("returns guidance for 'minimal' style", () => {
    const result = buildEmojiGuidance({ enabled: true, style: "minimal" });
    expect(result).not.toBeNull();
    expect(result).toContain("EMOJI IN RESPONSES");
    expect(result).toContain("sparingly");
    expect(result).toContain("at most 1 per message");
  });

  test("returns guidance for 'balanced' style", () => {
    const result = buildEmojiGuidance({ enabled: true, style: "balanced" });
    expect(result).not.toBeNull();
    expect(result).toContain("up to 2 per message");
    expect(result).toContain("personality");
  });

  test("returns guidance for 'expressive' style", () => {
    const result = buildEmojiGuidance({ enabled: true, style: "expressive" });
    expect(result).not.toBeNull();
    expect(result).toContain("up to 3-4 per message");
    expect(result).toContain("generously");
  });

  test("all non-none styles include emoji examples", () => {
    for (const style of ["minimal", "balanced", "expressive"] as EmojiStyle[]) {
      const result = buildEmojiGuidance({ enabled: true, style });
      expect(result).toContain("🎉");
      expect(result).toContain("⚠️");
    }
  });
});

// ── Emoji Stripping ─────────────────────────────────────────

describe("stripEmoji", () => {
  test("plain text unchanged", () => {
    expect(stripEmoji("Hello world")).toBe("Hello world");
  });

  test("removes simple emoji", () => {
    const result = stripEmoji("Hello 😀 world");
    expect(result).toBe("Hello world");
  });

  test("removes multiple emoji", () => {
    const result = stripEmoji("Great 🎉 job 🚀 team 💪");
    expect(result).toBe("Great job team");
  });

  test("removes emoji at start of text", () => {
    const result = stripEmoji("🎉 Congratulations!");
    expect(result).toBe("Congratulations!");
  });

  test("removes emoji at end of text", () => {
    const result = stripEmoji("Well done! 🎉");
    expect(result).toBe("Well done!");
  });

  test("preserves structural emoji (checkmarks, crosses)", () => {
    const result = stripEmoji("✅ Done\n❌ Failed");
    expect(result).toContain("✅");
    expect(result).toContain("❌");
  });

  test("preserves warning emoji", () => {
    const result = stripEmoji("⚠️ Caution needed");
    expect(result).toContain("⚠️");
  });

  test("handles empty string", () => {
    expect(stripEmoji("")).toBe("");
  });

  test("handles string with only emoji", () => {
    const result = stripEmoji("😀😂🎉");
    expect(result).toBe("");
  });

  test("cleans up double spaces after removal", () => {
    const result = stripEmoji("Hello  😀  world");
    expect(result).not.toContain("  ");
  });

  test("preserves newlines", () => {
    const result = stripEmoji("Line 1 🎉\nLine 2 🚀\nLine 3");
    expect(result).toContain("Line 1");
    expect(result).toContain("\n");
    expect(result).toContain("Line 3");
  });

  test("handles mixed content with markdown", () => {
    const result = stripEmoji("## Summary 🎯\n\n- Item 1 ✅\n- Item 2 🚀");
    expect(result).toContain("## Summary");
    expect(result).toContain("✅");
    expect(result).not.toContain("🎯");
  });
});

// ── Post-Process Response ───────────────────────────────────

describe("postProcessEmojiResponse", () => {
  const textWithEmoji = "Great work! 🎉 The deployment was successful 🚀";

  test("passes through text when emoji enabled (minimal)", () => {
    const result = postProcessEmojiResponse(textWithEmoji, { enabled: true, style: "minimal" });
    expect(result).toBe(textWithEmoji);
  });

  test("passes through text when emoji enabled (balanced)", () => {
    const result = postProcessEmojiResponse(textWithEmoji, { enabled: true, style: "balanced" });
    expect(result).toBe(textWithEmoji);
  });

  test("passes through text when emoji enabled (expressive)", () => {
    const result = postProcessEmojiResponse(textWithEmoji, { enabled: true, style: "expressive" });
    expect(result).toBe(textWithEmoji);
  });

  test("strips emoji when disabled", () => {
    const result = postProcessEmojiResponse(textWithEmoji, { enabled: false, style: "minimal" });
    expect(result).not.toContain("🎉");
    expect(result).not.toContain("🚀");
    expect(result).toContain("Great work!");
    expect(result).toContain("deployment was successful");
  });

  test("strips emoji when style is 'none'", () => {
    const result = postProcessEmojiResponse(textWithEmoji, { enabled: true, style: "none" });
    expect(result).not.toContain("🎉");
    expect(result).not.toContain("🚀");
  });

  test("preserves structural emoji even when disabled", () => {
    const text = "✅ Task complete\n❌ Test failed\n⚠️ Warning";
    const result = postProcessEmojiResponse(text, { enabled: false, style: "none" });
    expect(result).toContain("✅");
    expect(result).toContain("❌");
    expect(result).toContain("⚠️");
  });
});

// ── Preference Management ───────────────────────────────────

describe("emoji preference deps", () => {
  let deps: EmojiPrefsDeps;

  beforeEach(() => {
    const mock = _makeMockEmojiPrefsDeps();
    deps = mock.deps;
  });

  test("getPrefs returns defaults", async () => {
    const prefs = await deps.getPrefs();
    expect(prefs.enabled).toBe(true);
    expect(prefs.style).toBe("minimal");
  });

  test("setPrefs updates enabled", async () => {
    const result = await deps.setPrefs({ enabled: false });
    expect(result.enabled).toBe(false);
    expect(result.style).toBe("minimal"); // unchanged

    const prefs = await deps.getPrefs();
    expect(prefs.enabled).toBe(false);
  });

  test("setPrefs updates style", async () => {
    const result = await deps.setPrefs({ style: "expressive" });
    expect(result.style).toBe("expressive");
    expect(result.enabled).toBe(true); // unchanged
  });

  test("setPrefs updates both", async () => {
    const result = await deps.setPrefs({ enabled: false, style: "none" });
    expect(result.enabled).toBe(false);
    expect(result.style).toBe("none");
  });

  test("custom initial prefs work", () => {
    const { deps: customDeps } = _makeMockEmojiPrefsDeps({ enabled: false, style: "expressive" });
    customDeps.getPrefs().then(prefs => {
      expect(prefs.enabled).toBe(false);
      expect(prefs.style).toBe("expressive");
    });
  });
});

// ── Default Preferences ─────────────────────────────────────

describe("DEFAULT_EMOJI_PREFS", () => {
  test("defaults to enabled with minimal style", () => {
    expect(DEFAULT_EMOJI_PREFS.enabled).toBe(true);
    expect(DEFAULT_EMOJI_PREFS.style).toBe("minimal");
  });
});

// ── Prompt Builder Integration ──────────────────────────────

describe("prompt builder emoji cache", () => {
  test("cache starts null", () => {
    _injectEmojiGuidanceForTesting(null);
    expect(getEmojiGuidanceCache()).toBeNull();
  });

  test("can set and get guidance", () => {
    const guidance = "Use emoji sparingly";
    _injectEmojiGuidanceForTesting(guidance);
    expect(getEmojiGuidanceCache()).toBe(guidance);

    // Clean up
    _injectEmojiGuidanceForTesting(null);
  });

  test("can clear guidance by setting null", () => {
    _injectEmojiGuidanceForTesting("some guidance");
    _injectEmojiGuidanceForTesting(null);
    expect(getEmojiGuidanceCache()).toBeNull();
  });

  test("buildEmojiGuidance output is suitable for cache", () => {
    const guidance = buildEmojiGuidance({ enabled: true, style: "minimal" });
    expect(guidance).not.toBeNull();
    _injectEmojiGuidanceForTesting(guidance);
    expect(getEmojiGuidanceCache()).toBe(guidance);

    // Clean up
    _injectEmojiGuidanceForTesting(null);
  });
});

// ── Style Completeness ──────────────────────────────────────

describe("emoji styles", () => {
  const allStyles: EmojiStyle[] = ["none", "minimal", "balanced", "expressive"];

  test("all styles produce valid guidance or null", () => {
    for (const style of allStyles) {
      const result = buildEmojiGuidance({ enabled: true, style });
      if (style === "none") {
        expect(result).toBeNull();
      } else {
        expect(typeof result).toBe("string");
        expect(result!.length).toBeGreaterThan(0);
      }
    }
  });

  test("guidance length increases with expressiveness", () => {
    const minimal = buildEmojiGuidance({ enabled: true, style: "minimal" })!;
    const balanced = buildEmojiGuidance({ enabled: true, style: "balanced" })!;
    const expressive = buildEmojiGuidance({ enabled: true, style: "expressive" })!;

    expect(balanced.length).toBeGreaterThan(minimal.length);
    expect(expressive.length).toBeGreaterThan(balanced.length);
  });
});
