import { describe, it, expect } from "bun:test";
import {
  fixListSpacing,
  fixHeadingSpacing,
  fixCodeBlockSpacing,
  collapseExcessiveBlankLines,
  fixMarkdown,
} from "../src/markdown-fixer.ts";

describe("ELLIE-787: Markdown list spacing fixer", () => {
  describe("fixListSpacing", () => {
    it("adds blank line before numbered list", () => {
      const input = "I need approval for:\n1. First item\n2. Second item";
      const result = fixListSpacing(input);
      expect(result).toBe("I need approval for:\n\n1. First item\n2. Second item");
    });

    it("adds blank line before bulleted list with dashes", () => {
      const input = "Here are the issues:\n- Bug in login\n- Slow performance";
      const result = fixListSpacing(input);
      expect(result).toBe("Here are the issues:\n\n- Bug in login\n- Slow performance");
    });

    it("adds blank line before bulleted list with asterisks", () => {
      const input = "Tasks:\n* Task one\n* Task two";
      const result = fixListSpacing(input);
      expect(result).toBe("Tasks:\n\n* Task one\n* Task two");
    });

    it("adds blank line before list with parenthesis numbers", () => {
      const input = "Steps:\n1) Do this\n2) Do that";
      const result = fixListSpacing(input);
      expect(result).toBe("Steps:\n\n1) Do this\n2) Do that");
    });

    it("does not add extra blank line when one already exists", () => {
      const input = "Some text:\n\n1. Already spaced\n2. Correctly";
      const result = fixListSpacing(input);
      expect(result).toBe(input);
    });

    it("does not modify list items within a list", () => {
      const input = "Text:\n\n1. First\n2. Second\n3. Third";
      const result = fixListSpacing(input);
      // Items after the first should stay as-is (they follow list items, not prose)
      expect(result).toBe(input);
    });

    it("handles multiple lists in one message", () => {
      const input = "First list:\n1. A\n2. B\n\nSecond list:\n- X\n- Y";
      const result = fixListSpacing(input);
      expect(result).toBe("First list:\n\n1. A\n2. B\n\nSecond list:\n\n- X\n- Y");
    });

    it("preserves text with no lists", () => {
      const input = "Just some regular text.\nAnother line.";
      expect(fixListSpacing(input)).toBe(input);
    });

    it("handles plus sign bullets", () => {
      const input = "Items:\n+ One\n+ Two";
      const result = fixListSpacing(input);
      expect(result).toBe("Items:\n\n+ One\n+ Two");
    });
  });

  describe("fixHeadingSpacing", () => {
    it("adds blank line before heading", () => {
      const input = "Some text.\n## Heading";
      expect(fixHeadingSpacing(input)).toBe("Some text.\n\n## Heading");
    });

    it("handles multiple heading levels", () => {
      expect(fixHeadingSpacing("Text\n# H1")).toBe("Text\n\n# H1");
      expect(fixHeadingSpacing("Text\n### H3")).toBe("Text\n\n### H3");
    });

    it("does not double-space already spaced headings", () => {
      const input = "Text\n\n## Already Spaced";
      expect(fixHeadingSpacing(input)).toBe(input);
    });
  });

  describe("fixCodeBlockSpacing", () => {
    it("adds blank line before code fence", () => {
      const input = "Here is the code:\n```\nconsole.log('hi')\n```";
      expect(fixCodeBlockSpacing(input)).toBe("Here is the code:\n\n```\nconsole.log('hi')\n```");
    });

    it("does not double-space already spaced code blocks", () => {
      const input = "Code:\n\n```\ntest\n```";
      expect(fixCodeBlockSpacing(input)).toBe(input);
    });
  });

  describe("collapseExcessiveBlankLines", () => {
    it("collapses 4+ newlines to 3", () => {
      expect(collapseExcessiveBlankLines("a\n\n\n\nb")).toBe("a\n\n\nb");
    });

    it("leaves double blank lines alone", () => {
      expect(collapseExcessiveBlankLines("a\n\n\nb")).toBe("a\n\n\nb");
    });

    it("collapses very large gaps", () => {
      expect(collapseExcessiveBlankLines("a\n\n\n\n\n\n\nb")).toBe("a\n\n\nb");
    });
  });

  describe("fixMarkdown (full pipeline)", () => {
    it("fixes a realistic agent response", () => {
      const input = [
        "I've reviewed the code and found these issues:",
        "1. Missing null check on line 42",
        "2. SQL injection vulnerability in the search endpoint",
        "3. No rate limiting on the API",
        "",
        "Here are my recommendations:",
        "- Add input validation",
        "- Implement rate limiting",
        "- Add integration tests",
      ].join("\n");

      const result = fixMarkdown(input);

      // Should have blank line before first numbered list
      expect(result).toContain("issues:\n\n1. Missing");
      // Should have blank line before bullet list
      expect(result).toContain("recommendations:\n\n- Add");
    });

    it("fixes inline list with heading", () => {
      const input = "Done. Here's what changed:\n## Summary\nText here\n1. Change A\n2. Change B";
      const result = fixMarkdown(input);
      expect(result).toContain("\n\n## Summary");
      expect(result).toContain("here\n\n1. Change A");
    });

    it("is idempotent", () => {
      const input = "Text:\n1. Item\n2. Item";
      const once = fixMarkdown(input);
      const twice = fixMarkdown(once);
      expect(twice).toBe(once);
    });

    it("handles empty string", () => {
      expect(fixMarkdown("")).toBe("");
    });

    it("handles string with no issues", () => {
      const input = "Just a simple response with no lists or headings.";
      expect(fixMarkdown(input)).toBe(input);
    });
  });
});
