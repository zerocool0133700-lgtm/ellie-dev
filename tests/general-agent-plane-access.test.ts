/**
 * ELLIE-1092: Verify general agent gets Plane MCP access
 *
 * Tests that the general agent receives properly formatted Plane MCP tools
 * when dispatched, fixing the issue where category names were passed directly
 * to the CLI instead of being converted to mcp__plane__* format.
 */

import { describe, test, expect } from "bun:test";
import { getAllowedToolsForCLI, formatMCPsForCLI } from "../src/tool-access-control";

describe("General agent Plane MCP access (ELLIE-1092)", () => {
  test("formatMCPsForCLI converts server names to CLI format", () => {
    const mcpNames = ["plane", "google-workspace", "forest-bridge"];
    const result = formatMCPsForCLI(mcpNames);

    expect(result).toEqual([
      "mcp__plane__*",
      "mcp__google-workspace__*",
      "mcp__forest-bridge__*",
    ]);
  });

  test("getAllowedToolsForCLI includes plane for general agent", () => {
    const generalTools = ["forest_bridge", "plane_lookup", "google_workspace", "web_search", "memory_extraction", "agent_router"];
    const result = getAllowedToolsForCLI(generalTools, "general");

    // Should include built-in tools
    expect(result).toContain("Read");
    expect(result).toContain("Edit");
    expect(result).toContain("Write");
    expect(result).toContain("Bash");

    // Should include Plane MCP in CLI format
    expect(result).toContain("mcp__plane__*");

    // Should include other MCPs
    expect(result).toContain("mcp__google-workspace__*");
    expect(result).toContain("mcp__forest-bridge__*");
    expect(result).toContain("mcp__brave-search__*");
    expect(result).toContain("mcp__memory__*");
    expect(result).toContain("mcp__qmd__*");
  });

  test("getAllowedToolsForCLI includes plane for dev agent", () => {
    const devTools = ["read", "write", "edit", "glob", "grep", "bash_builds", "bash_tests", "systemctl", "plane_mcp", "forest_bridge_read", "forest_bridge_write", "git", "supabase_mcp", "psql_forest"];
    const result = getAllowedToolsForCLI(devTools, "dev");

    // Should include Plane MCP (from ALWAYS_ALLOWED_TOOLS)
    expect(result).toContain("mcp__plane__*");

    // Should include explicitly enabled tools
    expect(result).toContain("mcp__supabase__*");
    expect(result).toContain("mcp__git__*");
  });

  test("getAllowedToolsForCLI includes plane even with empty tools_enabled", () => {
    const result = getAllowedToolsForCLI([], "test-agent");

    // Should still get ALWAYS_ALLOWED_TOOLS
    expect(result).toContain("mcp__plane__*");
    expect(result).toContain("mcp__forest-bridge__*");
    expect(result).toContain("mcp__qmd__*");
    expect(result).toContain("mcp__memory__*");
  });

  test("getAllowedToolsForCLI includes plane even with null tools_enabled", () => {
    const result = getAllowedToolsForCLI(null, "test-agent");

    // Should still get ALWAYS_ALLOWED_TOOLS
    expect(result).toContain("mcp__plane__*");
    expect(result).toContain("mcp__forest-bridge__*");
    expect(result).toContain("mcp__qmd__*");
    expect(result).toContain("mcp__memory__*");
  });
});
