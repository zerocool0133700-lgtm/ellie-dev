/**
 * ELLIE-478 — Runbook validator tests
 *
 * Tests for:
 *  - parseFrontmatter: YAML frontmatter extraction
 *  - validateRunbook: structural validation of runbook documents
 *  - validateRunbooks: batch validation
 *  - Actual runbook file validation (reads from disk)
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import {
  parseFrontmatter,
  validateRunbook,
  validateRunbooks,
} from "../src/runbook-validator.ts";

// ── parseFrontmatter ──────────────────────────────────────────────────────────

describe("parseFrontmatter", () => {
  test("parses valid frontmatter", () => {
    const content = `---
type: runbook
scope_path: 2/1
tags: [ops, relay]
---

# Title

Body content.`;

    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter!.type).toBe("runbook");
    expect(frontmatter!.scope_path).toBe("2/1");
    expect(frontmatter!.tags).toEqual(["ops", "relay"]);
    expect(body).toContain("# Title");
  });

  test("returns null frontmatter when missing", () => {
    const { frontmatter, body } = parseFrontmatter("# Just a title\n\nNo frontmatter.");
    expect(frontmatter).toBeNull();
    expect(body).toContain("Just a title");
  });

  test("handles empty tags array", () => {
    const content = `---
type: runbook
tags: []
---

# Title`;

    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter!.tags).toEqual([""]);
  });

  test("handles string values with colons", () => {
    const content = `---
type: runbook
scope_path: 2/1
tags: [test]
created: 2026-03-07
---

# Title`;

    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter!.created).toBe("2026-03-07");
  });

  test("preserves body content after frontmatter", () => {
    const content = `---
type: runbook
---

# Title

## Section 1

Content here.

## Section 2

More content.`;

    const { body } = parseFrontmatter(content);
    expect(body).toContain("## Section 1");
    expect(body).toContain("## Section 2");
    expect(body).toContain("More content.");
  });
});

// ── validateRunbook ───────────────────────────────────────────────────────────

describe("validateRunbook", () => {
  const VALID_RUNBOOK = `---
type: runbook
scope_path: 2/1
tags: [ops, relay, recovery]
created: 2026-03-07
updated: 2026-03-07
---

# Incident Response Runbook

Procedures for diagnosing and recovering from relay crashes.

## Triage

Check relay status first. Look at logs. Determine severity.

## Recovery

Restart the relay. Verify health endpoint. Send test message.

## Escalation

If the above doesn't work, check disk space and memory.
Full log dump for post-mortem analysis.`;

  test("accepts valid runbook", () => {
    const result = validateRunbook(VALID_RUNBOOK);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("extracts title from H1", () => {
    const result = validateRunbook(VALID_RUNBOOK);
    expect(result.metadata.title).toBe("Incident Response Runbook");
  });

  test("counts H2 sections", () => {
    const result = validateRunbook(VALID_RUNBOOK);
    expect(result.metadata.sectionCount).toBe(3);
  });

  test("extracts frontmatter metadata", () => {
    const result = validateRunbook(VALID_RUNBOOK);
    expect(result.metadata.type).toBe("runbook");
    expect(result.metadata.scopePath).toBe("2/1");
    expect(result.metadata.tags).toEqual(["ops", "relay", "recovery"]);
  });

  test("counts words (excluding code blocks)", () => {
    const result = validateRunbook(VALID_RUNBOOK);
    expect(result.metadata.wordCount).toBeGreaterThan(20);
  });

  test("errors on missing frontmatter", () => {
    const result = validateRunbook("# Title\n\n## Section\n\nContent.");
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Missing YAML frontmatter (--- delimiters)");
  });

  test("errors on missing required frontmatter fields", () => {
    const content = `---
type: runbook
---

# Title

## Section

Content here with enough words to pass the minimum.
Some more content to make sure we hit the word count.`;

    const result = validateRunbook(content);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("scope_path"))).toBe(true);
    expect(result.errors.some(e => e.includes("tags"))).toBe(true);
  });

  test("errors on missing H1 title", () => {
    const content = `---
type: runbook
scope_path: 2/1
tags: [test]
---

## Section Only

No H1 title in this document, just sections and content that goes on and on to meet the minimum word count requirement.`;

    const result = validateRunbook(content);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("H1 title"))).toBe(true);
  });

  test("errors on missing H2 sections", () => {
    const content = `---
type: runbook
scope_path: 2/1
tags: [test]
---

# Title

Just prose without any sections at all, going on long enough to pass the word count check easily.`;

    const result = validateRunbook(content);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("No H2 sections"))).toBe(true);
  });

  test("warns on non-runbook type", () => {
    const content = `---
type: guide
scope_path: 2/1
tags: [test]
---

# Title

## Section

Content goes here with enough words to be useful.`;

    const result = validateRunbook(content);
    expect(result.valid).toBe(true); // warning, not error
    expect(result.warnings.some(w => w.includes('expected "runbook"'))).toBe(true);
  });

  test("warns on short content", () => {
    const content = `---
type: runbook
scope_path: 2/1
tags: [test]
---

# Title

## Section

Short.`;

    const result = validateRunbook(content);
    expect(result.warnings.some(w => w.includes("seems short"))).toBe(true);
  });

  test("includes filename in error messages", () => {
    const result = validateRunbook("No frontmatter", "test.md");
    expect(result.errors[0]).toContain("test.md:");
  });

  test("warns on missing created date", () => {
    const content = `---
type: runbook
scope_path: 2/1
tags: [test]
---

# Title

## Section

Content with enough words to pass the check.`;

    const result = validateRunbook(content);
    expect(result.warnings.some(w => w.includes("created"))).toBe(true);
  });
});

// ── validateRunbooks (batch) ──────────────────────────────────────────────────

describe("validateRunbooks", () => {
  test("validates multiple runbooks", () => {
    const result = validateRunbooks([
      {
        filename: "good.md",
        content: `---
type: runbook
scope_path: 2/1
tags: [test]
created: 2026-03-07
---

# Good Runbook

## Section

Content with enough words to pass the minimum word count requirement check here.`,
      },
      {
        filename: "bad.md",
        content: "# No frontmatter\n\n## Section\n\nContent.",
      },
    ]);

    expect(result.valid).toBe(false); // one bad file
    expect(result.results).toHaveLength(2);
    expect(result.results[0].valid).toBe(true);
    expect(result.results[1].valid).toBe(false);
  });

  test("returns valid=true when all pass", () => {
    const good = `---
type: runbook
scope_path: 2/1
tags: [test]
created: 2026-03-07
---

# Good

## Section

Content with enough words to pass the minimum word count. More words here.`;

    const result = validateRunbooks([
      { filename: "a.md", content: good },
      { filename: "b.md", content: good },
    ]);

    expect(result.valid).toBe(true);
  });

  test("handles empty array", () => {
    const result = validateRunbooks([]);
    expect(result.valid).toBe(true);
    expect(result.results).toHaveLength(0);
  });
});

// ── Actual Runbook Files ──────────────────────────────────────────────────────

describe("actual runbook files in vault", () => {
  const RUNBOOKS_DIR = "/home/ellie/ellie-river/vault/runbooks";
  const REQUIRED_RUNBOOKS = [
    "incident-response.md",
    "debugging-playbook.md",
    "operations-checklist.md",
  ];

  test("runbooks directory exists and has files", () => {
    const files = readdirSync(RUNBOOKS_DIR).filter(f => f.endsWith(".md"));
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  for (const filename of REQUIRED_RUNBOOKS) {
    test(`${filename} exists and is valid`, () => {
      const content = readFileSync(join(RUNBOOKS_DIR, filename), "utf-8");
      const result = validateRunbook(content, filename);

      // Must have no errors
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);

      // Must have proper metadata
      expect(result.metadata.type).toBe("runbook");
      expect(result.metadata.scopePath).toBe("2/1");
      expect(result.metadata.tags).toBeDefined();
      expect(result.metadata.tags!.length).toBeGreaterThan(0);
      expect(result.metadata.title).toBeTruthy();
      expect(result.metadata.sectionCount).toBeGreaterThanOrEqual(2);
    });
  }

  test("incident-response.md covers key topics", () => {
    const content = readFileSync(join(RUNBOOKS_DIR, "incident-response.md"), "utf-8");
    expect(content).toContain("Relay Crash");
    expect(content).toContain("Telegram");
    expect(content).toContain("systemctl");
    expect(content).toContain("Escalation");
  });

  test("debugging-playbook.md covers key topics", () => {
    const content = readFileSync(join(RUNBOOKS_DIR, "debugging-playbook.md"), "utf-8");
    expect(content).toContain("journalctl");
    expect(content).toContain("Agent Router");
    expect(content).toContain("circuit");
    expect(content).toContain("WebSocket");
  });

  test("operations-checklist.md covers key topics", () => {
    const content = readFileSync(join(RUNBOOKS_DIR, "operations-checklist.md"), "utf-8");
    expect(content).toContain("Deploy");
    expect(content).toContain("Rollback");
    expect(content).toContain("Health Check");
    expect(content).toContain("bun run build");
  });

  test("all runbooks have incident/ops/debug tags", () => {
    const allTags = new Set<string>();
    for (const filename of REQUIRED_RUNBOOKS) {
      const content = readFileSync(join(RUNBOOKS_DIR, filename), "utf-8");
      const result = validateRunbook(content, filename);
      for (const tag of result.metadata.tags ?? []) {
        allTags.add(tag);
      }
    }
    expect(allTags.has("incident")).toBe(true);
    expect(allTags.has("debugging")).toBe(true);
    expect(allTags.has("operations")).toBe(true);
  });
});
