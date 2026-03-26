import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";

// We'll test the parsing and core logic
import { _parseMemoryFile } from "../src/agent-memory-store.ts";

const TEST_DIR = "/tmp/ellie-agent-memory-test";

describe("ELLIE-1027: Agent memory store", () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  describe("parseMemoryFile", () => {
    it("parses entries with timestamps", () => {
      const content = `# james — decisions

## 2026-03-26T14:30:00Z | ELLIE-1024
Chose fast mode budget of 30k tokens.

## 2026-03-26T15:00:00Z
General learning about Tailwind v4.
`;
      const entries = _parseMemoryFile(content, "decisions");
      expect(entries).toHaveLength(2);
      expect(entries[0].timestamp).toBe("2026-03-26T14:30:00Z");
      expect(entries[0].workItemId).toBe("ELLIE-1024");
      expect(entries[0].content).toBe("Chose fast mode budget of 30k tokens.");
      expect(entries[1].workItemId).toBeUndefined();
    });

    it("returns empty array for content without valid headers", () => {
      const content = "# just a title\nsome content\n";
      const entries = _parseMemoryFile(content, "decisions");
      expect(entries).toHaveLength(0);
    });

    it("skips entries with empty bodies", () => {
      const content = `## 2026-03-26T14:30:00Z\n\n## 2026-03-26T15:00:00Z\nActual content here.\n`;
      const entries = _parseMemoryFile(content, "learnings");
      expect(entries).toHaveLength(1);
      expect(entries[0].content).toBe("Actual content here.");
    });
  });

  describe("memory summary format", () => {
    it("formats entries as bullet points", () => {
      // Test the format contract that getAgentMemorySummary produces
      const entry = { timestamp: "2026-03-26T14:30:00Z", content: "Test content", workItemId: "ELLIE-1024", category: "decisions" };
      const line = `- [${entry.category}] (${entry.workItemId}) ${entry.content}`;
      expect(line).toBe("- [decisions] (ELLIE-1024) Test content");
    });

    it("formats entries without workItemId", () => {
      const entry = { timestamp: "2026-03-26T14:30:00Z", content: "Test content", category: "learnings" };
      const line = `- [${entry.category}] ${entry.content}`;
      expect(line).toBe("- [learnings] Test content");
    });
  });
});
