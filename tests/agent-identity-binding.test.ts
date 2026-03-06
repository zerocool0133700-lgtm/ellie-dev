/**
 * Tests for Agent Identity Binding — ELLIE-607
 *
 * Covers: registration, defaults, queries, validation, resolution, summary.
 */

import { describe, it, expect, beforeEach } from "bun:test";

import {
  registerBinding,
  registerBindings,
  loadDefaultBindings,
  removeBinding,
  getBinding,
  listBindings,
  getAgentsByArchetype,
  getAgentsByRole,
  validateBinding,
  validateAllBindings,
  resolveBinding,
  resolveAllBindings,
  buildBindingsSummary,
  DEFAULT_BINDINGS,
  _resetBindingsForTesting,
  type AgentBinding,
} from "../src/agent-identity-binding";

import { _resetLoaderForTesting as _resetArchetypeLoaderForTesting, _injectArchetypeForTesting } from "../src/archetype-loader";
import { _resetRoleLoaderForTesting, _injectRoleForTesting } from "../src/role-loader";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeArchetypeConfig(species: string) {
  return {
    species,
    schema: {
      frontmatter: { species, cognitive_style: "depth-first" as const },
      sections: [],
      body: "",
    },
    validation: { valid: true, errors: [] },
    filePath: `config/archetypes/${species}.md`,
    loadedAt: new Date().toISOString(),
  };
}

function makeRoleConfig(role: string) {
  return {
    role,
    schema: {
      frontmatter: { role, purpose: `${role} purpose` },
      sections: [],
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

// ── registerBinding ─────────────────────────────────────────────────────────

describe("registerBinding", () => {
  it("registers a binding and returns normalized version", () => {
    const result = registerBinding({ agentName: "Dev", archetype: "Ant", role: "Dev" });
    expect(result.agentName).toBe("dev");
    expect(result.archetype).toBe("ant");
    expect(result.role).toBe("dev");
  });

  it("overwrites existing binding for same agent", () => {
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });
    registerBinding({ agentName: "dev", archetype: "owl", role: "researcher" });
    const binding = getBinding("dev");
    expect(binding!.archetype).toBe("owl");
    expect(binding!.role).toBe("researcher");
  });

  it("normalizes to lowercase", () => {
    registerBinding({ agentName: "RESEARCH", archetype: "OWL", role: "RESEARCHER" });
    expect(getBinding("research")).not.toBeNull();
    expect(getBinding("RESEARCH")).not.toBeNull();
  });
});

// ── registerBindings ────────────────────────────────────────────────────────

describe("registerBindings", () => {
  it("registers multiple bindings at once", () => {
    registerBindings([
      { agentName: "dev", archetype: "ant", role: "dev" },
      { agentName: "research", archetype: "owl", role: "researcher" },
    ]);
    expect(listBindings()).toHaveLength(2);
  });
});

// ── loadDefaultBindings ─────────────────────────────────────────────────────

describe("loadDefaultBindings", () => {
  it("loads all default bindings", () => {
    const count = loadDefaultBindings();
    expect(count).toBe(DEFAULT_BINDINGS.length);
    expect(listBindings()).toHaveLength(DEFAULT_BINDINGS.length);
  });

  it("does not overwrite existing custom bindings", () => {
    registerBinding({ agentName: "dev", archetype: "owl", role: "researcher" });
    loadDefaultBindings();
    const binding = getBinding("dev");
    expect(binding!.archetype).toBe("owl"); // custom preserved
  });

  it("returns count of newly loaded bindings", () => {
    registerBinding({ agentName: "dev", archetype: "owl", role: "researcher" });
    const count = loadDefaultBindings();
    expect(count).toBe(DEFAULT_BINDINGS.length - 1); // dev already existed
  });

  it("is idempotent", () => {
    loadDefaultBindings();
    const count = loadDefaultBindings();
    expect(count).toBe(0);
  });
});

// ── removeBinding ───────────────────────────────────────────────────────────

describe("removeBinding", () => {
  it("removes an existing binding", () => {
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });
    expect(removeBinding("dev")).toBe(true);
    expect(getBinding("dev")).toBeNull();
  });

  it("returns false for non-existent binding", () => {
    expect(removeBinding("nonexistent")).toBe(false);
  });

  it("is case-insensitive", () => {
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });
    expect(removeBinding("DEV")).toBe(true);
    expect(getBinding("dev")).toBeNull();
  });
});

// ── getBinding ──────────────────────────────────────────────────────────────

describe("getBinding", () => {
  it("returns binding by name", () => {
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });
    const binding = getBinding("dev");
    expect(binding).not.toBeNull();
    expect(binding!.agentName).toBe("dev");
  });

  it("returns null for unknown agent", () => {
    expect(getBinding("unknown")).toBeNull();
  });

  it("is case-insensitive", () => {
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });
    expect(getBinding("DEV")).not.toBeNull();
    expect(getBinding("Dev")).not.toBeNull();
  });
});

// ── listBindings ────────────────────────────────────────────────────────────

describe("listBindings", () => {
  it("returns empty array when no bindings", () => {
    expect(listBindings()).toEqual([]);
  });

  it("returns all registered bindings", () => {
    loadDefaultBindings();
    expect(listBindings()).toHaveLength(DEFAULT_BINDINGS.length);
  });
});

// ── getAgentsByArchetype ────────────────────────────────────────────────────

describe("getAgentsByArchetype", () => {
  it("returns agents using a specific archetype", () => {
    loadDefaultBindings();
    const antAgents = getAgentsByArchetype("ant");
    expect(antAgents).toContain("dev");
    expect(antAgents).toContain("general");
    expect(antAgents).toContain("critic");
    expect(antAgents).not.toContain("research");
  });

  it("returns empty array for unknown archetype", () => {
    loadDefaultBindings();
    expect(getAgentsByArchetype("dragon")).toEqual([]);
  });

  it("is case-insensitive", () => {
    loadDefaultBindings();
    expect(getAgentsByArchetype("ANT").length).toBeGreaterThan(0);
    expect(getAgentsByArchetype("Owl").length).toBeGreaterThan(0);
  });
});

// ── getAgentsByRole ─────────────────────────────────────────────────────────

describe("getAgentsByRole", () => {
  it("returns agents using a specific role", () => {
    loadDefaultBindings();
    const devAgents = getAgentsByRole("dev");
    expect(devAgents).toContain("dev");
    expect(devAgents).toHaveLength(1);
  });

  it("returns empty array for unknown role", () => {
    loadDefaultBindings();
    expect(getAgentsByRole("wizard")).toEqual([]);
  });

  it("is case-insensitive", () => {
    loadDefaultBindings();
    expect(getAgentsByRole("DEV")).toHaveLength(1);
  });
});

// ── validateBinding ─────────────────────────────────────────────────────────

describe("validateBinding", () => {
  it("returns no warnings when archetype and role are loaded", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    _injectRoleForTesting(makeRoleConfig("dev"));

    const warnings = validateBinding({ agentName: "dev", archetype: "ant", role: "dev" });
    expect(warnings).toEqual([]);
  });

  it("warns when archetype is not loaded", () => {
    _injectRoleForTesting(makeRoleConfig("dev"));

    const warnings = validateBinding({ agentName: "dev", archetype: "ant", role: "dev" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].field).toBe("archetype");
    expect(warnings[0].agentName).toBe("dev");
  });

  it("warns when role is not loaded", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));

    const warnings = validateBinding({ agentName: "dev", archetype: "ant", role: "dev" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].field).toBe("role");
  });

  it("warns for both missing archetype and role", () => {
    const warnings = validateBinding({ agentName: "dev", archetype: "ant", role: "dev" });
    expect(warnings).toHaveLength(2);
    expect(warnings.map(w => w.field)).toContain("archetype");
    expect(warnings.map(w => w.field)).toContain("role");
  });
});

// ── validateAllBindings ─────────────────────────────────────────────────────

describe("validateAllBindings", () => {
  it("returns valid when all bindings have loaded archetypes and roles", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    _injectRoleForTesting(makeRoleConfig("dev"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const result = validateAllBindings();
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("returns invalid with warnings for missing references", () => {
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });
    registerBinding({ agentName: "research", archetype: "owl", role: "researcher" });

    const result = validateAllBindings();
    expect(result.valid).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("returns valid when no bindings registered", () => {
    const result = validateAllBindings();
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});

// ── resolveBinding ──────────────────────────────────────────────────────────

describe("resolveBinding", () => {
  it("resolves binding with loaded archetype and role", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    _injectRoleForTesting(makeRoleConfig("dev"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const resolved = resolveBinding("dev");
    expect(resolved).not.toBeNull();
    expect(resolved!.agentName).toBe("dev");
    expect(resolved!.archetype).not.toBeNull();
    expect(resolved!.archetype!.species).toBe("ant");
    expect(resolved!.role).not.toBeNull();
    expect(resolved!.role!.role).toBe("dev");
    expect(resolved!.warnings).toEqual([]);
  });

  it("returns null for unregistered agent", () => {
    expect(resolveBinding("unknown")).toBeNull();
  });

  it("returns null configs with warnings for missing archetype/role", () => {
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const resolved = resolveBinding("dev");
    expect(resolved).not.toBeNull();
    expect(resolved!.archetype).toBeNull();
    expect(resolved!.role).toBeNull();
    expect(resolved!.warnings).toHaveLength(2);
  });

  it("partially resolves when only archetype is loaded", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const resolved = resolveBinding("dev");
    expect(resolved!.archetype).not.toBeNull();
    expect(resolved!.role).toBeNull();
    expect(resolved!.warnings).toHaveLength(1);
    expect(resolved!.warnings[0].field).toBe("role");
  });

  it("is case-insensitive", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    _injectRoleForTesting(makeRoleConfig("dev"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    expect(resolveBinding("DEV")).not.toBeNull();
  });
});

// ── resolveAllBindings ──────────────────────────────────────────────────────

describe("resolveAllBindings", () => {
  it("resolves all registered bindings", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    _injectArchetypeForTesting(makeArchetypeConfig("owl"));
    _injectRoleForTesting(makeRoleConfig("dev"));
    _injectRoleForTesting(makeRoleConfig("researcher"));

    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });
    registerBinding({ agentName: "research", archetype: "owl", role: "researcher" });

    const resolved = resolveAllBindings();
    expect(resolved).toHaveLength(2);
    expect(resolved.every(r => r.archetype !== null)).toBe(true);
    expect(resolved.every(r => r.role !== null)).toBe(true);
  });

  it("returns empty array when no bindings", () => {
    expect(resolveAllBindings()).toEqual([]);
  });
});

// ── buildBindingsSummary ────────────────────────────────────────────────────

describe("buildBindingsSummary", () => {
  it("returns message when no bindings", () => {
    expect(buildBindingsSummary()).toBe("No agent bindings registered.");
  });

  it("includes agent count in header", () => {
    loadDefaultBindings();
    const summary = buildBindingsSummary();
    expect(summary).toContain(`Agent Identity Bindings (${DEFAULT_BINDINGS.length}):`);
  });

  it("shows MISSING status when archetype/role not loaded", () => {
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });
    const summary = buildBindingsSummary();
    expect(summary).toContain("MISSING");
    expect(summary).toContain("dev");
    expect(summary).toContain("ant");
  });

  it("shows ok status when archetype and role are loaded", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    _injectRoleForTesting(makeRoleConfig("dev"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const summary = buildBindingsSummary();
    expect(summary).toContain("[ok]");
    expect(summary).not.toContain("MISSING");
  });

  it("shows mixed status when only archetype loaded", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const summary = buildBindingsSummary();
    expect(summary).toContain("archetype=ant [ok]");
    expect(summary).toContain("role=dev [MISSING]");
  });
});

// ── DEFAULT_BINDINGS ────────────────────────────────────────────────────────

describe("DEFAULT_BINDINGS", () => {
  it("has 8 default bindings", () => {
    expect(DEFAULT_BINDINGS).toHaveLength(8);
  });

  it("includes dev with ant archetype", () => {
    const dev = DEFAULT_BINDINGS.find(b => b.agentName === "dev");
    expect(dev).toBeDefined();
    expect(dev!.archetype).toBe("ant");
    expect(dev!.role).toBe("dev");
  });

  it("includes research with owl archetype", () => {
    const research = DEFAULT_BINDINGS.find(b => b.agentName === "research");
    expect(research).toBeDefined();
    expect(research!.archetype).toBe("owl");
    expect(research!.role).toBe("researcher");
  });

  it("includes content with bee archetype", () => {
    const content = DEFAULT_BINDINGS.find(b => b.agentName === "content");
    expect(content).toBeDefined();
    expect(content!.archetype).toBe("bee");
  });

  it("all bindings have required fields", () => {
    for (const binding of DEFAULT_BINDINGS) {
      expect(binding.agentName).toBeTruthy();
      expect(binding.archetype).toBeTruthy();
      expect(binding.role).toBeTruthy();
    }
  });
});

// ── Full scenario ───────────────────────────────────────────────────────────

describe("full scenario", () => {
  it("load defaults → inject configs → validate → resolve", () => {
    // Load defaults
    loadDefaultBindings();
    expect(listBindings()).toHaveLength(8);

    // Initially all invalid (nothing loaded)
    const preValidation = validateAllBindings();
    expect(preValidation.valid).toBe(false);

    // Inject some configs
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    _injectArchetypeForTesting(makeArchetypeConfig("owl"));
    _injectArchetypeForTesting(makeArchetypeConfig("bee"));
    _injectRoleForTesting(makeRoleConfig("dev"));
    _injectRoleForTesting(makeRoleConfig("general"));
    _injectRoleForTesting(makeRoleConfig("researcher"));
    _injectRoleForTesting(makeRoleConfig("strategy"));
    _injectRoleForTesting(makeRoleConfig("critic"));
    _injectRoleForTesting(makeRoleConfig("content"));
    _injectRoleForTesting(makeRoleConfig("finance"));
    _injectRoleForTesting(makeRoleConfig("ops"));

    // Now all valid
    const postValidation = validateAllBindings();
    expect(postValidation.valid).toBe(true);
    expect(postValidation.warnings).toEqual([]);

    // Resolve dev
    const devResolved = resolveBinding("dev");
    expect(devResolved!.archetype!.species).toBe("ant");
    expect(devResolved!.role!.role).toBe("dev");

    // Resolve all
    const all = resolveAllBindings();
    expect(all).toHaveLength(8);
    expect(all.every(r => r.warnings.length === 0)).toBe(true);

    // Summary shows all ok
    const summary = buildBindingsSummary();
    expect(summary).not.toContain("MISSING");
  });

  it("custom binding overrides default", () => {
    loadDefaultBindings();
    registerBinding({ agentName: "dev", archetype: "owl", role: "researcher" });

    const binding = getBinding("dev");
    expect(binding!.archetype).toBe("owl");
    expect(binding!.role).toBe("researcher");

    // dev now in owl agents, not ant
    expect(getAgentsByArchetype("owl")).toContain("dev");
  });
});

// ── _resetBindingsForTesting ────────────────────────────────────────────────

describe("_resetBindingsForTesting", () => {
  it("clears all bindings", () => {
    loadDefaultBindings();
    expect(listBindings().length).toBeGreaterThan(0);
    _resetBindingsForTesting();
    expect(listBindings()).toEqual([]);
  });
});
