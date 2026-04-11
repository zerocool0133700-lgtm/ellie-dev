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

  test("getAllowedToolsForCLI includes plane for general agent via plane_lookup", () => {
    const generalTools = ["forest_bridge", "plane_lookup", "google_workspace", "web_search", "memory_extraction", "agent_router"];
    const result = getAllowedToolsForCLI(generalTools, "general");

    // Only safe built-ins + gated ones matching config
    expect(result).toContain("Read");
    expect(result).toContain("Glob");
    expect(result).toContain("Grep");
    expect(result).toContain("WebSearch");
    expect(result).toContain("WebFetch");
    // General agent has no write/edit/bash categories
    expect(result).not.toContain("Edit");
    expect(result).not.toContain("Write");
    expect(result).not.toContain("Bash");

    // Should include Plane MCP via plane_lookup category
    expect(result).toContain("mcp__plane__*");

    // Should include other MCPs
    expect(result).toContain("mcp__google-workspace__*");
    expect(result).toContain("mcp__forest-bridge__*");
    expect(result).toContain("mcp__brave-search__*");
    expect(result).toContain("mcp__memory__*");
    expect(result).toContain("mcp__qmd__*");
  });

  test("getAllowedToolsForCLI includes plane for dev agent via plane_mcp", () => {
    const devTools = ["read", "write", "edit", "glob", "grep", "bash_builds", "bash_tests", "systemctl", "plane_mcp", "forest_bridge_read", "forest_bridge_write", "git", "supabase_mcp", "psql_forest"];
    const result = getAllowedToolsForCLI(devTools, "dev");

    // Plane MCP comes from both ALWAYS_ALLOWED and plane_mcp category
    expect(result).toContain("mcp__plane__*");

    // Should include explicitly enabled tools
    expect(result).toContain("mcp__supabase__*");
    expect(result).toContain("mcp__git__*");

    // Dev agent has write/edit/bash categories
    expect(result).toContain("Edit");
    expect(result).toContain("Write");
    expect(result).toContain("Bash");
  });

  test("getAllowedToolsForCLI returns safe defaults with empty tools_enabled", () => {
    const result = getAllowedToolsForCLI([], "test-agent");

    // Plane is universal — all agents get it (reverted ELLIE-1110)
    expect(result).toContain("mcp__plane__*");
    // Core coordination MCPs still present
    expect(result).toContain("mcp__forest-bridge__*");
    expect(result).toContain("mcp__qmd__*");
    expect(result).toContain("mcp__memory__*");
    // Only safe built-ins
    expect(result).toContain("Read");
    expect(result).toContain("Glob");
    expect(result).toContain("Grep");
    expect(result).not.toContain("Edit");
    expect(result).not.toContain("Write");
    expect(result).not.toContain("Bash");
  });

  test("getAllowedToolsForCLI returns safe defaults with null tools_enabled", () => {
    const result = getAllowedToolsForCLI(null, "test-agent");

    // Plane is universal — all agents get it (reverted ELLIE-1110)
    expect(result).toContain("mcp__plane__*");
    // Core coordination MCPs still present
    expect(result).toContain("mcp__forest-bridge__*");
    expect(result).toContain("mcp__qmd__*");
    expect(result).toContain("mcp__memory__*");
  });

  // ELLIE-1104: Double conversion bug
  test("getAllowedToolsForCLI is idempotent — calling twice preserves all tools", () => {
    const rawCategories = ["forest_bridge", "plane_lookup", "google_workspace", "web_search"];
    const firstPass = getAllowedToolsForCLI(rawCategories, "general");
    const secondPass = getAllowedToolsForCLI(firstPass, "general");

    // Second pass should produce identical output — no tools lost
    expect(secondPass).toEqual(firstPass);
  });

  test("getAllowedToolsForCLI preserves agent-specific MCP tools on double conversion", () => {
    const devTools = ["read", "write", "edit", "bash_builds", "git", "supabase_mcp"];
    const firstPass = getAllowedToolsForCLI(devTools, "dev");

    // First pass should include agent-specific MCPs
    expect(firstPass).toContain("mcp__supabase__*");
    expect(firstPass).toContain("mcp__git__*");

    // Second pass must NOT strip agent-specific MCPs
    const secondPass = getAllowedToolsForCLI(firstPass, "dev");
    expect(secondPass).toContain("mcp__supabase__*");
    expect(secondPass).toContain("mcp__git__*");
    expect(secondPass).toContain("Read");
    // These are preserved from first pass (already CLI-formatted)
    expect(secondPass).toContain("Bash");
    expect(secondPass).toContain("Edit");
    expect(secondPass).toContain("Write");
  });
});
