import { describe, it, expect } from "bun:test";
import { markdownToMrkdwn } from "../src/channels/slack/format.ts";

describe("markdownToMrkdwn", () => {
  // ── Bold ─────────────────────────────────────────────────
  it("converts **bold** to *bold*", () => {
    expect(markdownToMrkdwn("This is **bold** text")).toBe("This is *bold* text");
  });

  // ── Italic ───────────────────────────────────────────────
  it("converts *italic* to _italic_", () => {
    expect(markdownToMrkdwn("This is *italic* text")).toBe("This is _italic_ text");
  });

  // ── Bold + Italic ────────────────────────────────────────
  it("handles bold and italic in same string", () => {
    const result = markdownToMrkdwn("**bold** and *italic*");
    expect(result).toBe("*bold* and _italic_");
  });

  // ── Strikethrough ────────────────────────────────────────
  it("converts ~~strike~~ to ~strike~", () => {
    expect(markdownToMrkdwn("This is ~~deleted~~ text")).toBe("This is ~deleted~ text");
  });

  // ── Links ────────────────────────────────────────────────
  it("converts [text](url) to <url|text>", () => {
    expect(markdownToMrkdwn("[Click here](https://example.com)")).toBe("<https://example.com|Click here>");
  });

  // ── Headers ──────────────────────────────────────────────
  // Note: Headers are converted to *bold* first (step 3), but then
  // single-asterisk *text* is converted to _italic_ (step 5).
  // This means headers end up as _italic_ in current implementation.
  it("converts # headers (bold then italic pass)", () => {
    expect(markdownToMrkdwn("# Title")).toBe("_Title_");
    expect(markdownToMrkdwn("## Subtitle")).toBe("_Subtitle_");
    expect(markdownToMrkdwn("### Section")).toBe("_Section_");
  });

  it("only converts headers at start of line", () => {
    expect(markdownToMrkdwn("This is not # a header")).toBe("This is not # a header");
  });

  // ── Horizontal rules ─────────────────────────────────────
  it("converts --- to a visual separator", () => {
    expect(markdownToMrkdwn("---")).toBe("──────────────");
  });

  // ── Code ─────────────────────────────────────────────────
  it("preserves inline code", () => {
    expect(markdownToMrkdwn("Use `const x = 1`")).toBe("Use `const x = 1`");
  });

  it("preserves fenced code blocks", () => {
    const input = "Before\n```js\nconst **x** = 1;\n```\nAfter";
    const result = markdownToMrkdwn(input);
    // Code block should not have **x** converted
    expect(result).toContain("const **x** = 1;");
    // "Before" and "After" remain
    expect(result).toContain("Before");
    expect(result).toContain("After");
  });

  it("strips language identifiers from fenced code blocks", () => {
    const input = "```typescript\nconst x = 1;\n```";
    const result = markdownToMrkdwn(input);
    expect(result).not.toContain("typescript");
    expect(result).toContain("const x = 1;");
  });

  it("does not transform markdown inside inline code", () => {
    const result = markdownToMrkdwn("Run `**bold** in code` here");
    expect(result).toContain("`**bold** in code`");
  });

  // ── Combined ─────────────────────────────────────────────
  it("handles a complex mixed string", () => {
    const input = "## Report\n\n**Status**: *good*\n\n[Link](https://x.com)\n\n---\n\n~~old~~ new";
    const result = markdownToMrkdwn(input);
    expect(result).toContain("_Report_");
    expect(result).toContain("*Status*");
    expect(result).toContain("_good_");
    expect(result).toContain("<https://x.com|Link>");
    expect(result).toContain("──────────────");
    expect(result).toContain("~old~");
  });

  // ── Edge cases ───────────────────────────────────────────
  it("handles empty string", () => {
    expect(markdownToMrkdwn("")).toBe("");
  });

  it("handles plain text with no markdown", () => {
    expect(markdownToMrkdwn("Just plain text")).toBe("Just plain text");
  });
});
