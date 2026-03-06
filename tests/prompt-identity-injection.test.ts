/**
 * Tests for ELLIE-616: Prompt identity injector integration into buildPrompt
 *
 * Covers: ODS identity sections injected via getIdentityPromptSections(),
 * graceful fallback when no binding exists, coexistence with legacy params,
 * and correct priorities.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { buildPrompt } from "../src/prompt-builder.ts";
import { _resetLoaderForTesting, _injectArchetypeForTesting, type ArchetypeConfig } from "../src/archetype-loader.ts";
import { _resetRoleLoaderForTesting, _injectRoleForTesting, type RoleConfig } from "../src/role-loader.ts";
import { _resetBindingsForTesting, registerBinding } from "../src/agent-identity-binding.ts";
import type { ArchetypeSchema } from "../src/archetype-schema.ts";
import type { RoleSchema } from "../src/role-schema.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeArchetypeConfig(species: string): ArchetypeConfig {
  const schema: ArchetypeSchema = {
    frontmatter: {
      species,
      cognitive_style: "methodical",
    },
    sections: [
      { heading: "Identity", content: `You are the ${species} archetype.` },
      { heading: "Behavioral Traits", content: "Precise and systematic." },
    ],
    body: `# ${species}\n\n## Identity\nYou are the ${species} archetype.\n\n## Behavioral Traits\nPrecise and systematic.`,
  };
  return {
    species,
    schema,
    validation: { valid: true, errors: [] },
    filePath: `/tmp/test/${species}.md`,
    loadedAt: new Date().toISOString(),
  };
}

function makeRoleConfig(role: string): RoleConfig {
  const schema: RoleSchema = {
    frontmatter: {
      role,
      purpose: `Handle ${role} tasks`,
    },
    sections: [
      { heading: "Core Responsibilities", content: `Handle ${role} work.` },
    ],
    body: `# ${role}\n\n## Core Responsibilities\nHandle ${role} work.`,
  };
  return {
    role,
    schema,
    validation: { valid: true, errors: [] },
    filePath: `/tmp/test/${role}.md`,
    loadedAt: new Date().toISOString(),
  };
}

// Minimal buildPrompt call — only user message required
function callBuildPrompt(opts: {
  agentName?: string;
  archetypeContext?: string;
  roleContext?: string;
}): string {
  return buildPrompt(
    "test message",           // userMessage
    undefined,                // contextDocket
    undefined,                // relevantContext
    undefined,                // elasticContext
    "telegram",               // channel
    opts.agentName ? { name: opts.agentName } : undefined, // agentConfig
    undefined,                // workItemContext
    undefined,                // structuredContext
    undefined,                // recentMessages
    undefined,                // skillContext
    undefined,                // forestContext
    undefined,                // agentMemoryContext
    undefined,                // sessionIds
    opts.archetypeContext,     // archetypeContext (param 14)
    opts.roleContext,          // roleContext (param 15)
  );
}

// ── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  _resetLoaderForTesting();
  _resetRoleLoaderForTesting();
  _resetBindingsForTesting();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("ELLIE-616: ODS identity injection in buildPrompt", () => {
  it("injects ODS archetype and role when no legacy params provided", () => {
    // Set up ODS identity system
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    _injectRoleForTesting(makeRoleConfig("dev"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const prompt = callBuildPrompt({ agentName: "dev" });

    // ODS archetype section (priority 3) should be present
    expect(prompt).toContain("Behavioral Archetype: ant");
    expect(prompt).toContain("Cognitive style: methodical");
    // ODS role section (priority 5) should be present
    expect(prompt).toContain("Agent Role: dev");
    expect(prompt).toContain("Handle dev tasks");
  });

  it("skips ODS archetype when legacy archetypeContext is provided", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("owl"));
    _injectRoleForTesting(makeRoleConfig("researcher"));
    registerBinding({ agentName: "research", archetype: "owl", role: "researcher" });

    const prompt = callBuildPrompt({
      agentName: "research",
      archetypeContext: "Legacy owl archetype content here",
    });

    // Legacy archetype should be present
    expect(prompt).toContain("Legacy owl archetype content here");
    // ODS archetype should NOT be present (legacy takes precedence)
    expect(prompt).not.toContain("Behavioral Archetype: owl");
    // ODS role SHOULD be present (no legacy roleContext)
    expect(prompt).toContain("Agent Role: researcher");
  });

  it("skips ODS role when legacy roleContext is provided", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    _injectRoleForTesting(makeRoleConfig("dev"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const prompt = callBuildPrompt({
      agentName: "dev",
      roleContext: "Legacy dev role content here",
    });

    // Legacy role should be present
    expect(prompt).toContain("Legacy dev role content here");
    // ODS role should NOT be present
    expect(prompt).not.toContain("Agent Role: dev");
    // ODS archetype SHOULD be present (no legacy archetypeContext)
    expect(prompt).toContain("Behavioral Archetype: ant");
  });

  it("skips all ODS injection when both legacy params provided", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    _injectRoleForTesting(makeRoleConfig("dev"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const prompt = callBuildPrompt({
      agentName: "dev",
      archetypeContext: "Legacy archetype",
      roleContext: "Legacy role",
    });

    // Legacy content present
    expect(prompt).toContain("Legacy archetype");
    expect(prompt).toContain("Legacy role");
    // ODS content absent
    expect(prompt).not.toContain("Behavioral Archetype: ant");
    expect(prompt).not.toContain("Agent Role: dev");
    expect(prompt).not.toContain("Handle dev tasks");
  });

  it("gracefully handles missing binding (no agent registered)", () => {
    // No binding registered for "unknown-agent"
    const prompt = callBuildPrompt({ agentName: "unknown-agent" });

    // Should still build a prompt without error
    expect(prompt).toContain("test message");
    // No ODS sections
    expect(prompt).not.toContain("Behavioral Archetype:");
    expect(prompt).not.toContain("Agent Role:");
  });

  it("handles binding with missing archetype file", () => {
    // Binding exists but archetype not loaded
    _injectRoleForTesting(makeRoleConfig("dev"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });
    // Note: ant archetype NOT injected

    const prompt = callBuildPrompt({ agentName: "dev" });

    // Role should still appear
    expect(prompt).toContain("Agent Role: dev");
    // Archetype absent (not loaded)
    expect(prompt).not.toContain("Behavioral Archetype: ant");
  });

  it("handles binding with missing role file", () => {
    // Binding exists but role not loaded
    _injectArchetypeForTesting(makeArchetypeConfig("owl"));
    registerBinding({ agentName: "research", archetype: "owl", role: "researcher" });
    // Note: researcher role NOT injected

    const prompt = callBuildPrompt({ agentName: "research" });

    // Archetype should appear
    expect(prompt).toContain("Behavioral Archetype: owl");
    // Role absent (not loaded)
    expect(prompt).not.toContain("Agent Role: researcher");
  });

  it("defaults to 'general' agent when no agentConfig name", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    _injectRoleForTesting(makeRoleConfig("general"));
    registerBinding({ agentName: "general", archetype: "ant", role: "general" });

    const prompt = callBuildPrompt({}); // no agentName

    expect(prompt).toContain("Behavioral Archetype: ant");
    expect(prompt).toContain("Agent Role: general");
  });

  it("includes archetype section content in the prompt", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("bee"));
    _injectRoleForTesting(makeRoleConfig("content"));
    registerBinding({ agentName: "content", archetype: "bee", role: "content" });

    const prompt = callBuildPrompt({ agentName: "content" });

    // Verify archetype body sections are included
    expect(prompt).toContain("You are the bee archetype.");
    expect(prompt).toContain("Precise and systematic.");
    // Verify role body sections are included
    expect(prompt).toContain("Handle content work.");
  });
});
