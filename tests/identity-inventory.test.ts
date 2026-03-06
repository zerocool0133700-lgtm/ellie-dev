/**
 * Tests for Identity Inventory Validation — ELLIE-623
 *
 * Covers: validateInventory() — cross-referencing loaded archetypes/roles
 * against registered bindings to detect unused and missing files.
 */

import { describe, it, expect, beforeEach } from "bun:test";

import {
  validateInventory,
  type InventoryValidation,
} from "../src/identity-startup";

import {
  _resetLoaderForTesting as _resetArchetypeLoader,
  _injectArchetypeForTesting,
  type ArchetypeConfig,
} from "../src/archetype-loader";

import {
  _resetBindingsForTesting,
  registerBinding,
} from "../src/agent-identity-binding";

import {
  _resetRoleLoaderForTesting,
  _injectRoleForTesting,
} from "../src/role-loader";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeArchetypeConfig(species: string): ArchetypeConfig {
  return {
    species,
    schema: {
      frontmatter: {
        species,
        cognitive_style: `${species}-style`,
        token_budget: 10000,
      },
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

beforeEach(() => {
  _resetArchetypeLoader();
  _resetBindingsForTesting();
  _resetRoleLoaderForTesting();
});

// ── validateInventory ───────────────────────────────────────────────────────

describe("validateInventory", () => {
  it("returns valid when no archetypes, roles, or bindings exist", () => {
    const result = validateInventory();
    expect(result.valid).toBe(true);
    expect(result.unusedArchetypes).toEqual([]);
    expect(result.missingArchetypes).toEqual([]);
    expect(result.unusedRoles).toEqual([]);
    expect(result.missingRoles).toEqual([]);
  });

  it("returns valid when all loaded archetypes and roles are bound", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    _injectArchetypeForTesting(makeArchetypeConfig("owl"));
    _injectRoleForTesting(makeRoleConfig("dev"));
    _injectRoleForTesting(makeRoleConfig("researcher"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });
    registerBinding({ agentName: "research", archetype: "owl", role: "researcher" });

    const result = validateInventory();
    expect(result.valid).toBe(true);
    expect(result.unusedArchetypes).toEqual([]);
    expect(result.missingArchetypes).toEqual([]);
    expect(result.unusedRoles).toEqual([]);
    expect(result.missingRoles).toEqual([]);
  });

  it("detects unused archetypes (loaded but not bound)", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    _injectArchetypeForTesting(makeArchetypeConfig("owl"));
    _injectArchetypeForTesting(makeArchetypeConfig("chipmunk"));
    _injectArchetypeForTesting(makeArchetypeConfig("deer"));
    _injectRoleForTesting(makeRoleConfig("dev"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const result = validateInventory();
    expect(result.valid).toBe(false);
    expect(result.unusedArchetypes).toEqual(["chipmunk", "deer", "owl"]);
    expect(result.missingArchetypes).toEqual([]);
  });

  it("detects missing archetypes (bound but not loaded)", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    _injectRoleForTesting(makeRoleConfig("dev"));
    _injectRoleForTesting(makeRoleConfig("researcher"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });
    registerBinding({ agentName: "research", archetype: "owl", role: "researcher" });

    const result = validateInventory();
    expect(result.valid).toBe(false);
    expect(result.missingArchetypes).toEqual(["owl"]);
  });

  it("detects unused roles (loaded but not bound)", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    _injectRoleForTesting(makeRoleConfig("dev"));
    _injectRoleForTesting(makeRoleConfig("researcher"));
    _injectRoleForTesting(makeRoleConfig("content"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const result = validateInventory();
    expect(result.valid).toBe(false);
    expect(result.unusedRoles).toEqual(["content", "researcher"]);
    expect(result.missingRoles).toEqual([]);
  });

  it("detects missing roles (bound but not loaded)", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    _injectRoleForTesting(makeRoleConfig("dev"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });
    registerBinding({ agentName: "ops", archetype: "ant", role: "ops" });

    const result = validateInventory();
    expect(result.valid).toBe(false);
    expect(result.missingRoles).toEqual(["ops"]);
  });

  it("detects both unused and missing simultaneously", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    _injectArchetypeForTesting(makeArchetypeConfig("chipmunk"));
    _injectRoleForTesting(makeRoleConfig("dev"));
    _injectRoleForTesting(makeRoleConfig("content"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });
    registerBinding({ agentName: "research", archetype: "owl", role: "researcher" });

    const result = validateInventory();
    expect(result.valid).toBe(false);
    expect(result.unusedArchetypes).toEqual(["chipmunk"]);
    expect(result.missingArchetypes).toEqual(["owl"]);
    expect(result.unusedRoles).toEqual(["content"]);
    expect(result.missingRoles).toEqual(["researcher"]);
  });

  it("handles duplicate archetype references in bindings", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    _injectRoleForTesting(makeRoleConfig("dev"));
    _injectRoleForTesting(makeRoleConfig("ops"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });
    registerBinding({ agentName: "ops", archetype: "ant", role: "ops" });

    const result = validateInventory();
    expect(result.valid).toBe(true);
    expect(result.unusedArchetypes).toEqual([]);
  });

  it("sorts unused and missing lists alphabetically", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("zebra"));
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    _injectArchetypeForTesting(makeArchetypeConfig("mole"));
    // No bindings — all are unused

    const result = validateInventory();
    expect(result.unusedArchetypes).toEqual(["ant", "mole", "zebra"]);
  });

  it("reflects real-world scenario with 12 archetypes and 3 bound", () => {
    const allSpecies = [
      "ant", "owl", "bee", "chipmunk", "deer", "fox",
      "hawk", "mole", "otter", "parrot", "road-runner", "wolf",
    ];
    for (const species of allSpecies) {
      _injectArchetypeForTesting(makeArchetypeConfig(species));
    }
    _injectRoleForTesting(makeRoleConfig("dev"));
    _injectRoleForTesting(makeRoleConfig("researcher"));
    _injectRoleForTesting(makeRoleConfig("content"));

    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });
    registerBinding({ agentName: "research", archetype: "owl", role: "researcher" });
    registerBinding({ agentName: "content", archetype: "bee", role: "content" });

    const result = validateInventory();
    expect(result.valid).toBe(false);
    expect(result.unusedArchetypes).toHaveLength(9);
    expect(result.unusedArchetypes).toContain("chipmunk");
    expect(result.unusedArchetypes).toContain("deer");
    expect(result.unusedArchetypes).toContain("road-runner");
    expect(result.missingArchetypes).toEqual([]);
    expect(result.unusedRoles).toEqual([]);
    expect(result.missingRoles).toEqual([]);
  });

  it("detects typo in binding archetype name", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    _injectRoleForTesting(makeRoleConfig("dev"));
    registerBinding({ agentName: "dev", archetype: "antt", role: "dev" });

    const result = validateInventory();
    expect(result.valid).toBe(false);
    expect(result.unusedArchetypes).toEqual(["ant"]);
    expect(result.missingArchetypes).toEqual(["antt"]);
  });
});
