/**
 * Tests for Prompt Identity Injector — ELLIE-608
 *
 * Covers: archetype section building, role section building,
 * identity injection, graceful degradation, priority placement.
 */

import { describe, it, expect, beforeEach } from "bun:test";

import {
  buildArchetypeSections,
  buildRoleSections,
  buildIdentitySections,
  getIdentityPromptSections,
  ARCHETYPE_PRIORITY,
  ROLE_PRIORITY,
} from "../src/prompt-identity-injector";

import {
  registerBinding,
  _resetBindingsForTesting,
} from "../src/agent-identity-binding";

import {
  _resetLoaderForTesting as _resetArchetypeLoaderForTesting,
  _injectArchetypeForTesting,
  type ArchetypeConfig,
} from "../src/archetype-loader";

import {
  _resetRoleLoaderForTesting,
  _injectRoleForTesting,
  type RoleConfig,
} from "../src/role-loader";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeArchetypeConfig(species: string, sections?: Array<{ heading: string; content: string }>): ArchetypeConfig {
  return {
    species,
    schema: {
      frontmatter: { species, cognitive_style: "depth-first" as const },
      sections: sections ?? [
        { heading: "Working Pattern", content: "Focus on one task at a time.\nComplete before moving on." },
        { heading: "Communication Style", content: "Show code diffs, not prose." },
        { heading: "Anti-Patterns", content: "Never context-switch mid-task." },
        { heading: "Growth Metrics", content: "Task completion rate." },
      ],
      body: "",
    },
    validation: { valid: true, errors: [] },
    filePath: `config/archetypes/${species}.md`,
    loadedAt: new Date().toISOString(),
  };
}

function makeRoleConfig(role: string, purpose?: string, sections?: Array<{ heading: string; content: string }>): RoleConfig {
  return {
    role,
    schema: {
      frontmatter: { role, purpose: purpose ?? `${role} agent purpose` },
      sections: sections ?? [
        { heading: "Capabilities", content: "- Implement features\n- Fix bugs\n- Write tests" },
        { heading: "Context Requirements", content: "- Work item from Plane\n- Codebase access" },
        { heading: "Tool Categories", content: "- File operations\n- Execution" },
        { heading: "Communication Contract", content: "Show code diffs, not prose." },
        { heading: "Anti-Patterns", content: "Never refactor outside ticket scope." },
      ],
      body: "",
    },
    validation: { valid: true, errors: [] },
    filePath: `config/roles/${role}.md`,
    loadedAt: new Date().toISOString(),
  };
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  _resetBindingsForTesting();
  _resetArchetypeLoaderForTesting();
  _resetRoleLoaderForTesting();
});

// ── buildArchetypeSections ──────────────────────────────────────────────────

describe("buildArchetypeSections", () => {
  it("includes species name in header", () => {
    const config = makeArchetypeConfig("ant");
    const result = buildArchetypeSections(config);
    expect(result).toContain("# Behavioral Archetype: ant");
  });

  it("includes cognitive style", () => {
    const config = makeArchetypeConfig("ant");
    const result = buildArchetypeSections(config);
    expect(result).toContain("Cognitive style: depth-first");
  });

  it("includes all sections with headings", () => {
    const config = makeArchetypeConfig("ant");
    const result = buildArchetypeSections(config);
    expect(result).toContain("## Working Pattern");
    expect(result).toContain("## Communication Style");
    expect(result).toContain("## Anti-Patterns");
    expect(result).toContain("## Growth Metrics");
  });

  it("includes section content", () => {
    const config = makeArchetypeConfig("ant");
    const result = buildArchetypeSections(config);
    expect(result).toContain("Focus on one task at a time.");
    expect(result).toContain("Never context-switch mid-task.");
  });

  it("handles config with no sections", () => {
    const config = makeArchetypeConfig("ant", []);
    const result = buildArchetypeSections(config);
    expect(result).toContain("# Behavioral Archetype: ant");
    expect(result).toContain("Cognitive style: depth-first");
    expect(result).not.toContain("##");
  });

  it("handles section with empty content", () => {
    const config = makeArchetypeConfig("owl", [
      { heading: "Working Pattern", content: "" },
    ]);
    const result = buildArchetypeSections(config);
    expect(result).toContain("## Working Pattern");
  });
});

// ── buildRoleSections ───────────────────────────────────────────────────────

describe("buildRoleSections", () => {
  it("includes role name in header", () => {
    const config = makeRoleConfig("dev");
    const result = buildRoleSections(config);
    expect(result).toContain("# Agent Role: dev");
  });

  it("includes purpose", () => {
    const config = makeRoleConfig("dev", "Build, fix, and maintain code");
    const result = buildRoleSections(config);
    expect(result).toContain("Purpose: Build, fix, and maintain code");
  });

  it("includes all sections", () => {
    const config = makeRoleConfig("dev");
    const result = buildRoleSections(config);
    expect(result).toContain("## Capabilities");
    expect(result).toContain("## Context Requirements");
    expect(result).toContain("## Tool Categories");
    expect(result).toContain("## Communication Contract");
    expect(result).toContain("## Anti-Patterns");
  });

  it("includes section content", () => {
    const config = makeRoleConfig("dev");
    const result = buildRoleSections(config);
    expect(result).toContain("- Implement features");
    expect(result).toContain("Never refactor outside ticket scope.");
  });

  it("handles config with no sections", () => {
    const config = makeRoleConfig("dev", "Build code", []);
    const result = buildRoleSections(config);
    expect(result).toContain("# Agent Role: dev");
    expect(result).not.toContain("##");
  });

  it("handles empty purpose", () => {
    const config = makeRoleConfig("dev", "");
    const result = buildRoleSections(config);
    expect(result).toContain("# Agent Role: dev");
    expect(result).not.toContain("Purpose:");
  });
});

// ── buildIdentitySections ───────────────────────────────────────────────────

describe("buildIdentitySections", () => {
  it("returns empty sections for unbound agent", () => {
    const result = buildIdentitySections("unknown");
    expect(result.sections).toEqual([]);
    expect(result.hasArchetype).toBe(false);
    expect(result.hasRole).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("unknown");
  });

  it("returns both sections when archetype and role are loaded", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    _injectRoleForTesting(makeRoleConfig("dev"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const result = buildIdentitySections("dev");
    expect(result.sections).toHaveLength(2);
    expect(result.hasArchetype).toBe(true);
    expect(result.hasRole).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("archetype section has correct priority", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    _injectRoleForTesting(makeRoleConfig("dev"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const result = buildIdentitySections("dev");
    const archetypeSection = result.sections.find(s => s.label === "identity-archetype");
    expect(archetypeSection).toBeDefined();
    expect(archetypeSection!.priority).toBe(ARCHETYPE_PRIORITY);
    expect(archetypeSection!.priority).toBe(3);
  });

  it("role section has correct priority", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    _injectRoleForTesting(makeRoleConfig("dev"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const result = buildIdentitySections("dev");
    const roleSection = result.sections.find(s => s.label === "identity-role");
    expect(roleSection).toBeDefined();
    expect(roleSection!.priority).toBe(ROLE_PRIORITY);
    expect(roleSection!.priority).toBe(5);
  });

  it("archetype section content includes behavioral directives", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const result = buildIdentitySections("dev");
    const section = result.sections.find(s => s.label === "identity-archetype");
    expect(section).toBeDefined();
    expect(section!.content).toContain("Behavioral Archetype: ant");
    expect(section!.content).toContain("Working Pattern");
    expect(section!.content).toContain("---");
  });

  it("role section content includes capability context", () => {
    _injectRoleForTesting(makeRoleConfig("dev", "Build and maintain code"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const result = buildIdentitySections("dev");
    const section = result.sections.find(s => s.label === "identity-role");
    expect(section).toBeDefined();
    expect(section!.content).toContain("Agent Role: dev");
    expect(section!.content).toContain("Build and maintain code");
    expect(section!.content).toContain("Capabilities");
    expect(section!.content).toContain("---");
  });

  it("gracefully handles missing archetype", () => {
    _injectRoleForTesting(makeRoleConfig("dev"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const result = buildIdentitySections("dev");
    expect(result.hasArchetype).toBe(false);
    expect(result.hasRole).toBe(true);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].label).toBe("identity-role");
    expect(result.warnings).toHaveLength(1);
  });

  it("gracefully handles missing role", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const result = buildIdentitySections("dev");
    expect(result.hasArchetype).toBe(true);
    expect(result.hasRole).toBe(false);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].label).toBe("identity-archetype");
    expect(result.warnings).toHaveLength(1);
  });

  it("gracefully handles both missing", () => {
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const result = buildIdentitySections("dev");
    expect(result.hasArchetype).toBe(false);
    expect(result.hasRole).toBe(false);
    expect(result.sections).toEqual([]);
    expect(result.warnings).toHaveLength(2);
  });

  it("is case-insensitive", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    _injectRoleForTesting(makeRoleConfig("dev"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const result = buildIdentitySections("DEV");
    expect(result.sections).toHaveLength(2);
  });
});

// ── getIdentityPromptSections ───────────────────────────────────────────────

describe("getIdentityPromptSections", () => {
  it("returns empty array for unknown agent", () => {
    expect(getIdentityPromptSections("unknown")).toEqual([]);
  });

  it("returns sections array directly", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    _injectRoleForTesting(makeRoleConfig("dev"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const sections = getIdentityPromptSections("dev");
    expect(sections).toHaveLength(2);
    expect(sections[0].label).toBe("identity-archetype");
    expect(sections[1].label).toBe("identity-role");
  });
});

// ── Priority constants ──────────────────────────────────────────────────────

describe("priority constants", () => {
  it("archetype priority is lower number (higher importance) than role", () => {
    expect(ARCHETYPE_PRIORITY).toBeLessThan(ROLE_PRIORITY);
  });

  it("archetype priority is 3 (near soul)", () => {
    expect(ARCHETYPE_PRIORITY).toBe(3);
  });

  it("role priority is 5 (near tools/context)", () => {
    expect(ROLE_PRIORITY).toBe(5);
  });
});

// ── Full scenario ───────────────────────────────────────────────────────────

describe("full scenario", () => {
  it("dev agent gets ant archetype + dev role sections", () => {
    const antConfig = makeArchetypeConfig("ant", [
      { heading: "Working Pattern", content: "Depth-first: one task, full completion." },
      { heading: "Communication Style", content: "Code over prose." },
      { heading: "Anti-Patterns", content: "Never context-switch." },
      { heading: "Growth Metrics", content: "Completion rate." },
    ]);
    const devConfig = makeRoleConfig("dev", "Build, fix, and maintain code", [
      { heading: "Capabilities", content: "- Implement features\n- Fix bugs" },
      { heading: "Context Requirements", content: "- Plane ticket\n- Codebase" },
      { heading: "Tool Categories", content: "- File ops\n- Git" },
      { heading: "Communication Contract", content: "Show diffs." },
      { heading: "Anti-Patterns", content: "Never refactor outside scope." },
    ]);

    _injectArchetypeForTesting(antConfig);
    _injectRoleForTesting(devConfig);
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const result = buildIdentitySections("dev");

    // Both present
    expect(result.hasArchetype).toBe(true);
    expect(result.hasRole).toBe(true);
    expect(result.warnings).toEqual([]);

    // Archetype content
    const archSection = result.sections.find(s => s.label === "identity-archetype")!;
    expect(archSection.content).toContain("Behavioral Archetype: ant");
    expect(archSection.content).toContain("Depth-first: one task, full completion.");
    expect(archSection.content).toContain("Never context-switch.");
    expect(archSection.priority).toBe(3);

    // Role content
    const roleSection = result.sections.find(s => s.label === "identity-role")!;
    expect(roleSection.content).toContain("Agent Role: dev");
    expect(roleSection.content).toContain("Build, fix, and maintain code");
    expect(roleSection.content).toContain("- Implement features");
    expect(roleSection.content).toContain("Never refactor outside scope.");
    expect(roleSection.priority).toBe(5);
  });

  it("research agent gets owl archetype + researcher role sections", () => {
    const owlConfig = makeArchetypeConfig("owl");
    owlConfig.schema.frontmatter.cognitive_style = "breadth-first" as any;
    const researchConfig = makeRoleConfig("researcher", "Investigate topics and produce findings");

    _injectArchetypeForTesting(owlConfig);
    _injectRoleForTesting(researchConfig);
    registerBinding({ agentName: "research", archetype: "owl", role: "researcher" });

    const result = buildIdentitySections("research");
    expect(result.sections).toHaveLength(2);

    const archSection = result.sections.find(s => s.label === "identity-archetype")!;
    expect(archSection.content).toContain("Behavioral Archetype: owl");
    expect(archSection.content).toContain("breadth-first");

    const roleSection = result.sections.find(s => s.label === "identity-role")!;
    expect(roleSection.content).toContain("Agent Role: researcher");
    expect(roleSection.content).toContain("Investigate topics");
  });

  it("prompt still builds when archetype file is missing", () => {
    _injectRoleForTesting(makeRoleConfig("dev"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const sections = getIdentityPromptSections("dev");
    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe("identity-role");
  });

  it("prompt still builds when role file is missing", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const sections = getIdentityPromptSections("dev");
    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe("identity-archetype");
  });

  it("prompt still builds when both are missing", () => {
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });
    const sections = getIdentityPromptSections("dev");
    expect(sections).toEqual([]);
  });

  it("prompt still builds when agent has no binding", () => {
    const sections = getIdentityPromptSections("unregistered");
    expect(sections).toEqual([]);
  });
});
