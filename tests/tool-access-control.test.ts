/**
 * Tool Access Control Tests
 * ELLIE-970: Per-agent tool filtering
 */

import { describe, it, expect } from "bun:test";
import { getAllowedMCPs, isToolAllowed, formatAllowedToolsFlag, getAllowedToolsForCLI } from "../src/tool-access-control.ts";

describe("Tool Access Control", () => {
  describe("getAllowedMCPs", () => {
    it("should return default tools when tools_enabled is empty", () => {
      const mcps = getAllowedMCPs([], "test-agent");
      expect(mcps).toContain("forest-bridge");
      expect(mcps).toContain("qmd");
      expect(mcps).toContain("memory");
      // Plane is universal — all agents get Plane access (reverted ELLIE-1110)
      expect(mcps).toContain("plane");
    });

    it("should map google_workspace category to google-workspace MCP", () => {
      const mcps = getAllowedMCPs(["google_workspace"], "general");
      expect(mcps).toContain("google-workspace");
    });

    it("should map brave_search categories to brave-search MCP", () => {
      const mcps = getAllowedMCPs(["brave_search"], "research");
      expect(mcps).toContain("brave-search");
    });

    it("should map file operation categories to filesystem MCPs", () => {
      const mcps = getAllowedMCPs(["read", "write", "edit"], "dev");
      expect(mcps).toContain("filesystem-read");
      expect(mcps).toContain("filesystem-write");
      expect(mcps).toContain("filesystem-edit");
    });

    it("should always include default tools in addition to specified ones", () => {
      const mcps = getAllowedMCPs(["github_mcp"], "dev");
      expect(mcps).toContain("github");
      expect(mcps).toContain("forest-bridge");
      expect(mcps).toContain("qmd");
      expect(mcps).toContain("memory");
      // Plane is universal (reverted ELLIE-1110)
      expect(mcps).toContain("plane");
    });

    it("should deduplicate MCPs when multiple categories map to the same MCP", () => {
      const mcps = getAllowedMCPs(["brave_search", "brave_web_search", "web_search"], "research");
      const braveCount = mcps.filter(m => m === "brave-search").length;
      expect(braveCount).toBe(1);
    });

    it("should handle dev agent tools correctly", () => {
      const devTools = [
        "read",
        "write",
        "edit",
        "glob",
        "grep",
        "bash_builds",
        "bash_tests",
        "systemctl",
        "plane_mcp",
        "forest_bridge_read",
        "forest_bridge_write",
        "git",
        "supabase_mcp",
        "psql_forest",
      ];
      const mcps = getAllowedMCPs(devTools, "dev");
      expect(mcps).toContain("filesystem-read");
      expect(mcps).toContain("filesystem-write");
      expect(mcps).toContain("filesystem-edit");
      expect(mcps).toContain("bash");
      expect(mcps).toContain("git");
      expect(mcps).toContain("supabase");
      expect(mcps).toContain("postgres");
    });

    it("should handle general agent tools correctly", () => {
      const generalTools = [
        "forest_bridge",
        "plane_lookup",
        "google_workspace",
        "web_search",
        "memory_extraction",
        "agent_router",
      ];
      const mcps = getAllowedMCPs(generalTools, "general");
      expect(mcps).toContain("google-workspace");
      expect(mcps).toContain("brave-search");
      expect(mcps).toContain("agent-router");
    });

    it("should handle critic agent tools correctly", () => {
      const criticTools = [
        "read",
        "glob",
        "grep",
        "forest_bridge_read",
        "forest_bridge_write",
        "plane_mcp",
        "bash_tests",
        "bash_type_checks",
      ];
      const mcps = getAllowedMCPs(criticTools, "critic");
      expect(mcps).toContain("filesystem-read");
      expect(mcps).toContain("bash");
      expect(mcps).not.toContain("github");  // Critic doesn't have GitHub write access
      expect(mcps).not.toContain("google-workspace");  // Critic doesn't have Google Workspace
    });
  });

  describe("isToolAllowed", () => {
    it("should return true for allowed tools", () => {
      const tools = ["google_workspace", "brave_search"];
      expect(isToolAllowed(tools, "general", "google-workspace")).toBe(true);
      expect(isToolAllowed(tools, "general", "brave-search")).toBe(true);
    });

    it("should return false for disallowed tools", () => {
      const tools = ["google_workspace"];
      expect(isToolAllowed(tools, "general", "github")).toBe(false);
    });

    it("should always allow default tools", () => {
      const tools = ["google_workspace"];
      expect(isToolAllowed(tools, "general", "forest-bridge")).toBe(true);
      expect(isToolAllowed(tools, "general", "qmd")).toBe(true);
      expect(isToolAllowed(tools, "general", "memory")).toBe(true);
      // Plane is universal (reverted ELLIE-1110)
      expect(isToolAllowed(tools, "general", "plane")).toBe(true);
    });
  });

  describe("formatAllowedToolsFlag", () => {
    it("should format MCPs as comma-separated list", () => {
      const tools = ["read", "write", "git"];
      const flag = formatAllowedToolsFlag(tools, "dev");
      expect(flag).toBeString();
      expect(flag).toContain("filesystem-read");
      expect(flag).toContain("filesystem-write");
      expect(flag).toContain("git");
      expect(flag?.split(",").length).toBeGreaterThan(3); // Should include default tools too
    });

    it("should return undefined for empty tools list", () => {
      const flag = formatAllowedToolsFlag([], "test");
      expect(flag).toBeUndefined();
    });

    it("should return undefined for null tools list", () => {
      const flag = formatAllowedToolsFlag(null, "test");
      expect(flag).toBeUndefined();
    });
  });

  describe("Agent-specific access matrix", () => {
    it("should enforce Brian (critic) restrictions", () => {
      const brianTools = [
        "read",
        "glob",
        "grep",
        "forest_bridge_read",
        "forest_bridge_write",
        "plane_mcp",
        "bash_tests",
        "bash_type_checks",
      ];
      const mcps = getAllowedMCPs(brianTools, "critic");
      expect(mcps).not.toContain("brave-search");  // Brian doesn't have web search
      expect(mcps).not.toContain("google-workspace");  // Brian doesn't have Google Workspace
      expect(mcps).not.toContain("sequential-thinking");  // Brian DOES have sequential thinking (per matrix)
    });

    it("should enforce Kate (research) access", () => {
      const kateTools = [
        "brave_search",
        "forest_bridge",
        "qmd_search",
        "google_workspace",
        "grep_glob_codebase",
        "memory_extraction",
      ];
      const mcps = getAllowedMCPs(kateTools, "research");
      expect(mcps).toContain("brave-search");  // Kate has web search
      expect(mcps).toContain("google-workspace");  // Kate has Google Workspace (limited)
      expect(mcps).not.toContain("github");  // Kate doesn't have GitHub
    });

    it("should enforce James (dev) full access", () => {
      const jamesTools = [
        "read",
        "write",
        "edit",
        "glob",
        "grep",
        "bash_builds",
        "bash_tests",
        "systemctl",
        "plane_mcp",
        "forest_bridge_read",
        "forest_bridge_write",
        "git",
        "supabase_mcp",
        "psql_forest",
      ];
      const mcps = getAllowedMCPs(jamesTools, "dev");
      expect(mcps).toContain("filesystem-read");
      expect(mcps).toContain("filesystem-write");
      expect(mcps).toContain("filesystem-edit");
      expect(mcps).toContain("git");
      expect(mcps).toContain("bash");
      expect(mcps).toContain("supabase");
      expect(mcps).toContain("postgres");
    });

    it("should enforce Marcus (finance) restrictions", () => {
      const marcusTools = [
        "plane_mcp",
        "forest_bridge_read",
        "forest_bridge_write",
        "memory_extraction",
        "transaction_import",
        "receipt_parsing",
      ];
      const mcps = getAllowedMCPs(marcusTools, "finance");
      expect(mcps).toContain("finance");
      expect(mcps).not.toContain("brave-search");  // Marcus doesn't have web search
      expect(mcps).not.toContain("google-workspace");  // Marcus doesn't have Google Workspace (yet)
      expect(mcps).not.toContain("github");  // Marcus doesn't have GitHub
    });
  });

  // ELLIE-1110: Verify dangerous built-in tools are gated by agent config
  describe("Built-in tool gating (ELLIE-1110)", () => {
    it("research agent should NOT get Edit, Write, or Bash", () => {
      const kateTools = [
        "brave_search", "forest_bridge", "qmd_search",
        "google_workspace", "grep_glob_codebase", "memory_extraction",
      ];
      const cliTools = getAllowedToolsForCLI(kateTools, "research");
      expect(cliTools).toContain("Read");
      expect(cliTools).toContain("Glob");
      expect(cliTools).toContain("Grep");
      expect(cliTools).toContain("WebSearch");
      expect(cliTools).toContain("WebFetch");
      // Dangerous tools should NOT be present
      expect(cliTools).not.toContain("Edit");
      expect(cliTools).not.toContain("Write");
      expect(cliTools).not.toContain("Bash");
    });

    it("dev agent should get Edit, Write, and Bash", () => {
      const jamesTools = [
        "read", "write", "edit", "glob", "grep",
        "bash_builds", "bash_tests", "systemctl",
        "plane_mcp", "forest_bridge_read", "forest_bridge_write",
        "git", "supabase_mcp", "psql_forest",
      ];
      const cliTools = getAllowedToolsForCLI(jamesTools, "dev");
      expect(cliTools).toContain("Read");
      expect(cliTools).toContain("Edit");
      expect(cliTools).toContain("Write");
      expect(cliTools).toContain("Bash");
      expect(cliTools).toContain("Glob");
      expect(cliTools).toContain("Grep");
    });

    it("critic agent should get Bash (for tests) but NOT Edit or Write", () => {
      const brianTools = [
        "read", "glob", "grep",
        "forest_bridge_read", "forest_bridge_write",
        "plane_mcp", "bash_tests", "bash_type_checks",
      ];
      const cliTools = getAllowedToolsForCLI(brianTools, "critic");
      expect(cliTools).toContain("Read");
      expect(cliTools).toContain("Glob");
      expect(cliTools).toContain("Grep");
      expect(cliTools).toContain("Bash");
      // Critic has read + bash_tests but NOT write/edit categories
      expect(cliTools).not.toContain("Edit");
      expect(cliTools).not.toContain("Write");
      expect(cliTools).not.toContain("WebSearch");
    });

    it("finance agent should NOT get Edit, Write, or Bash", () => {
      const marcusTools = [
        "plane_mcp", "forest_bridge_read", "forest_bridge_write",
        "memory_extraction", "transaction_import", "receipt_parsing",
      ];
      const cliTools = getAllowedToolsForCLI(marcusTools, "finance");
      expect(cliTools).toContain("Read");
      expect(cliTools).toContain("Glob");
      expect(cliTools).toContain("Grep");
      expect(cliTools).not.toContain("Edit");
      expect(cliTools).not.toContain("Write");
      expect(cliTools).not.toContain("Bash");
    });

    it("plane MCP should be in always-allowed tools (universal access)", () => {
      const cliTools = getAllowedToolsForCLI([], "test-agent");
      // Plane is universal — all agents get it (reverted ELLIE-1110)
      expect(cliTools).toContain("mcp__plane__*");
      expect(cliTools).toContain("mcp__forest-bridge__*");
      expect(cliTools).toContain("mcp__qmd__*");
      expect(cliTools).toContain("mcp__memory__*");
    });

    it("agent with plane_mcp category should still get plane access", () => {
      const cliTools = getAllowedToolsForCLI(["plane_mcp"], "test-agent");
      expect(cliTools).toContain("mcp__plane__*");
    });
  });
});
