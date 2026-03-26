import { describe, it, expect } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const CREATURES_DIR = join(import.meta.dir, "..", "creatures");

/** Simple YAML frontmatter parser — extracts key-value pairs without requiring the yaml package */
function parseFrontmatter(content: string): Record<string, any> {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch && content.includes("---")) {
    // Handle ellie.md which has content before frontmatter
    const altMatch = content.match(/---\n([\s\S]*?)\n---/);
    if (altMatch) return parseYamlBlock(altMatch[1]);
  }
  if (!fmMatch) return {};
  return parseYamlBlock(fmMatch[1]);
}

function parseYamlBlock(block: string): Record<string, any> {
  const result: Record<string, any> = {};
  const lines = block.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.match(/^memory_categories:/)) {
      result.memory_categories = {};
      // Look ahead for primary and secondary
      for (let j = i + 1; j < lines.length; j++) {
        const subLine = lines[j];
        const primaryMatch = subLine.match(/^\s+primary:\s*\[([^\]]*)\]/);
        const secondaryMatch = subLine.match(/^\s+secondary:\s*\[([^\]]*)\]/);
        if (primaryMatch) {
          result.memory_categories.primary = primaryMatch[1].split(",").map((s: string) => s.trim());
        }
        if (secondaryMatch) {
          result.memory_categories.secondary = secondaryMatch[1].split(",").map((s: string) => s.trim());
        }
        if (subLine.match(/^\S/) && j > i + 1) break;
      }
    }

    if (line.match(/^memory_write_triggers:/)) {
      result.memory_write_triggers = [];
      for (let j = i + 1; j < lines.length; j++) {
        const subLine = lines[j];
        const itemMatch = subLine.match(/^\s+-\s+(.*)/);
        if (itemMatch) {
          result.memory_write_triggers.push(itemMatch[1]);
        } else if (subLine.match(/^\S/)) {
          break;
        }
      }
    }

    if (line.match(/^memory_budget_tokens:/)) {
      const match = line.match(/^memory_budget_tokens:\s*(\d+)/);
      if (match) result.memory_budget_tokens = parseInt(match[1]);
    }
  }

  return result;
}

describe("ELLIE-1029: Agent archetype memory training", () => {
  it("all creature files have memory_categories in frontmatter", async () => {
    const files = await readdir(CREATURES_DIR);
    const mdFiles = files.filter(f => f.endsWith(".md"));
    expect(mdFiles.length).toBeGreaterThanOrEqual(9);

    for (const file of mdFiles) {
      const content = await readFile(join(CREATURES_DIR, file), "utf-8");
      const fm = parseFrontmatter(content);
      expect(fm.memory_categories).toBeDefined();
      expect(fm.memory_categories.primary).toBeInstanceOf(Array);
      expect(fm.memory_categories.primary.length).toBeGreaterThan(0);
    }
  });

  it("all creature files have memory_write_triggers", async () => {
    const files = await readdir(CREATURES_DIR);
    const mdFiles = files.filter(f => f.endsWith(".md"));

    for (const file of mdFiles) {
      const content = await readFile(join(CREATURES_DIR, file), "utf-8");
      const fm = parseFrontmatter(content);
      expect(fm.memory_write_triggers).toBeInstanceOf(Array);
      expect(fm.memory_write_triggers.length).toBeGreaterThan(0);
    }
  });

  it("all creature files have Memory Protocol section", async () => {
    const files = await readdir(CREATURES_DIR);
    const mdFiles = files.filter(f => f.endsWith(".md"));

    for (const file of mdFiles) {
      const content = await readFile(join(CREATURES_DIR, file), "utf-8");
      expect(content).toContain("## Memory Protocol");
    }
  });

  it("agent-memory skill exists", async () => {
    const skillPath = join(import.meta.dir, "..", "skills", "agent-memory", "SKILL.md");
    const content = await readFile(skillPath, "utf-8");
    expect(content).toContain("name: agent-memory");
    expect(content).toContain("always_on: true");
  });
});
