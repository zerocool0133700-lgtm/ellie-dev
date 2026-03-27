import { describe, it, expect } from "bun:test";
import {
  filterTools,
  getDeferredToolSummary,
  ALWAYS_INCLUDE,
  DEFAULT_MAX_TOOLS,
  type ToolDefinition,
} from "../src/tool-discovery-filter.ts";

const mockTools: ToolDefinition[] = [
  { name: "Bash", description: "Run commands" },
  { name: "Read", description: "Read files" },
  { name: "Write", description: "Write files" },
  { name: "Edit", description: "Edit files" },
  { name: "Glob", description: "Find files" },
  { name: "Grep", description: "Search content" },
  { name: "WebSearch", description: "Search web" },
  { name: "WebFetch", description: "Fetch URLs" },
  { name: "mcp__plane__get_issue", description: "Get Plane issue" },
  { name: "mcp__plane__update_issue", description: "Update issue" },
  { name: "mcp__github__create_pr", description: "Create PR" },
  { name: "mcp__github__list_issues", description: "List issues" },
  { name: "mcp__google-workspace__send_email", description: "Send email" },
  { name: "mcp__google-workspace__list_events", description: "List calendar" },
  { name: "mcp__miro__create_board", description: "Create Miro board" },
  { name: "mcp__brave-search__search", description: "Brave search" },
  { name: "mcp__memory__read", description: "Read memory" },
  { name: "mcp__forest-bridge__write", description: "Write to forest" },
];

describe("ELLIE-1059: Tool discovery filtering", () => {
  describe("filterTools — dev archetype", () => {
    it("includes core dev tools", () => {
      const result = filterTools(mockTools, { archetype: "dev", message: "fix the bug" });
      const names = result.included.map(t => t.name);
      expect(names).toContain("Bash");
      expect(names).toContain("Read");
      expect(names).toContain("Edit");
      expect(names).toContain("Grep");
    });

    it("defers non-essential tools", () => {
      const result = filterTools(mockTools, { archetype: "dev", message: "fix the bug" });
      const deferred = result.deferred.map(t => t.name);
      expect(deferred).toContain("mcp__miro__create_board");
    });

    it("saves tokens from deferred tools", () => {
      const result = filterTools(mockTools, { archetype: "dev", message: "fix it" });
      expect(result.tokensSaved).toBeGreaterThan(0);
    });
  });

  describe("filterTools — intent-based inclusion", () => {
    it("includes github tools when message mentions PR", () => {
      const result = filterTools(mockTools, { archetype: "dev", message: "create a pr for this" });
      const names = result.included.map(t => t.name);
      expect(names.some(n => n.startsWith("mcp__github__"))).toBe(true);
    });

    it("includes email tools when message mentions email", () => {
      const result = filterTools(mockTools, { archetype: "general", message: "send an email to Sarah" });
      const names = result.included.map(t => t.name);
      expect(names.some(n => n.startsWith("mcp__google-workspace__"))).toBe(true);
    });
  });

  describe("filterTools — research archetype", () => {
    it("includes web search tools", () => {
      const result = filterTools(mockTools, { archetype: "research", message: "look into this" });
      const names = result.included.map(t => t.name);
      expect(names).toContain("WebSearch");
      expect(names).toContain("WebFetch");
    });
  });

  describe("getDeferredToolSummary", () => {
    it("returns empty for no deferred tools", () => {
      expect(getDeferredToolSummary([])).toBe("");
    });

    it("lists deferred tool names", () => {
      const deferred: ToolDefinition[] = [
        { name: "mcp__miro__create_board", description: "Miro" },
        { name: "mcp__brave-search__search", description: "Brave" },
      ];
      const summary = getDeferredToolSummary(deferred);
      expect(summary).toContain("2 additional tools");
      expect(summary).toContain("mcp__miro__create_board");
    });
  });

  describe("constants", () => {
    it("dev always includes 6 core tools", () => {
      expect(ALWAYS_INCLUDE.dev.length).toBe(6);
    });

    it("default max tools is 8", () => {
      expect(DEFAULT_MAX_TOOLS).toBe(8);
    });
  });
});
