/**
 * Tests for Identity Observability Endpoints — ELLIE-621
 *
 * Covers: archetypesEndpoint, bindingsEndpoint, agentIdentityEndpoint.
 * Uses mock ApiRequest/ApiResponse objects (same pattern as agent-compliance tests).
 */

import { describe, it, expect, beforeEach } from "bun:test";

import {
  archetypesEndpoint,
  bindingsEndpoint,
  agentIdentityEndpoint,
  type ArchetypesResponse,
  type BindingsResponse,
  type AgentIdentityResponse,
} from "../src/api/identity-endpoints";

import {
  _resetLoaderForTesting as _resetArchetypeLoader,
  _injectArchetypeForTesting,
  type ArchetypeConfig,
} from "../src/archetype-loader";

import {
  _resetBindingsForTesting,
  registerBinding,
  loadDefaultBindings,
} from "../src/agent-identity-binding";

import {
  _resetRoleLoaderForTesting,
  _injectRoleForTesting,
} from "../src/role-loader";

import type { ApiRequest, ApiResponse } from "../src/api/types";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeArchetypeConfig(species: string, sections: string[] = []): ArchetypeConfig {
  return {
    species,
    schema: {
      frontmatter: {
        species,
        cognitive_style: `${species}-style`,
        token_budget: 10000,
      },
      sections: sections.map((h) => ({ heading: h, content: `${h} content` })),
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
      sections: [{ heading: "Responsibilities", content: "Do stuff" }],
      body: "",
    },
    validation: { valid: true, errors: [] },
    filePath: `config/roles/${role}.md`,
    loadedAt: new Date().toISOString(),
  };
}

function mockRes(): { res: ApiResponse; result: () => { status: number; data: unknown } } {
  let _status = 200;
  let _data: unknown = null;

  const res: ApiResponse = {
    status(code: number) {
      _status = code;
      return {
        json(data: unknown) {
          _data = data;
        },
      };
    },
    json(data: unknown) {
      _data = data;
    },
  };

  return { res, result: () => ({ status: _status, data: _data }) };
}

beforeEach(() => {
  _resetArchetypeLoader();
  _resetBindingsForTesting();
  _resetRoleLoaderForTesting();
});

// ── GET /api/archetypes ──────────────────────────────────────────────────────

describe("archetypesEndpoint", () => {
  it("returns empty list when no archetypes loaded", () => {
    const { res, result } = mockRes();
    archetypesEndpoint({}, res);

    const data = result().data as ArchetypesResponse;
    expect(data.success).toBe(true);
    expect(data.count).toBe(0);
    expect(data.archetypes).toEqual([]);
  });

  it("returns loaded archetypes with section info", () => {
    _injectArchetypeForTesting(
      makeArchetypeConfig("ant", ["Cognitive Style", "Communication", "Anti-Patterns"]),
    );
    _injectArchetypeForTesting(
      makeArchetypeConfig("owl", ["Cognitive Style", "Research Method"]),
    );

    const { res, result } = mockRes();
    archetypesEndpoint({}, res);

    const data = result().data as ArchetypesResponse;
    expect(data.success).toBe(true);
    expect(data.count).toBe(2);

    const ant = data.archetypes.find((a) => a.species === "ant")!;
    expect(ant.cognitiveStyle).toBe("ant-style");
    expect(ant.sectionCount).toBe(3);
    expect(ant.sections).toEqual(["Cognitive Style", "Communication", "Anti-Patterns"]);
    expect(ant.tokenBudget).toBe(10000);
    expect(ant.valid).toBe(true);
    expect(ant.errorCount).toBe(0);
  });

  it("reports validation errors", () => {
    const config = makeArchetypeConfig("broken", []);
    config.validation = {
      valid: false,
      errors: [{ field: "sections.Cognitive Style", message: "Required section missing" }],
    };
    _injectArchetypeForTesting(config);

    const { res, result } = mockRes();
    archetypesEndpoint({}, res);

    const data = result().data as ArchetypesResponse;
    const broken = data.archetypes[0];
    expect(broken.valid).toBe(false);
    expect(broken.errorCount).toBe(1);
  });
});

// ── GET /api/agents/bindings ─────────────────────────────────────────────────

describe("bindingsEndpoint", () => {
  it("returns empty bindings when none registered", () => {
    const { res, result } = mockRes();
    bindingsEndpoint({}, res);

    const data = result().data as BindingsResponse;
    expect(data.success).toBe(true);
    expect(data.count).toBe(0);
    expect(data.bindings).toEqual([]);
    expect(data.validation.valid).toBe(true);
  });

  it("returns bindings with validation warnings for missing archetypes/roles", () => {
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });
    // No archetypes or roles loaded — should produce warnings

    const { res, result } = mockRes();
    bindingsEndpoint({}, res);

    const data = result().data as BindingsResponse;
    expect(data.count).toBe(1);
    expect(data.bindings[0].agentName).toBe("dev");
    expect(data.validation.valid).toBe(false);
    expect(data.validation.warningCount).toBeGreaterThan(0);
  });

  it("returns clean validation when archetypes and roles exist", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    _injectRoleForTesting(makeRoleConfig("dev"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const { res, result } = mockRes();
    bindingsEndpoint({}, res);

    const data = result().data as BindingsResponse;
    expect(data.validation.valid).toBe(true);
    expect(data.validation.warningCount).toBe(0);
  });

  it("includes identity status counts", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    _injectArchetypeForTesting(makeArchetypeConfig("owl"));
    _injectRoleForTesting(makeRoleConfig("dev"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const { res, result } = mockRes();
    bindingsEndpoint({}, res);

    const data = result().data as BindingsResponse;
    expect(data.status.archetypes).toBe(2);
    expect(data.status.roles).toBe(1);
    expect(data.status.bindings).toBe(1);
  });

  it("returns all 8 default bindings", () => {
    loadDefaultBindings();

    const { res, result } = mockRes();
    bindingsEndpoint({}, res);

    const data = result().data as BindingsResponse;
    expect(data.count).toBe(8);
  });
});

// ── GET /api/agents/:name/identity ───────────────────────────────────────────

describe("agentIdentityEndpoint", () => {
  it("returns 400 when no agent name provided", () => {
    const { res, result } = mockRes();
    agentIdentityEndpoint({ params: {} }, res);

    expect(result().status).toBe(400);
    expect((result().data as { error: string }).error).toContain("required");
  });

  it("returns 404 for unknown agent", () => {
    const { res, result } = mockRes();
    agentIdentityEndpoint({ params: { name: "unknown" } }, res);

    expect(result().status).toBe(404);
    expect((result().data as { error: string }).error).toContain("unknown");
  });

  it("returns resolved identity with archetype and role", () => {
    _injectArchetypeForTesting(
      makeArchetypeConfig("ant", ["Cognitive Style", "Communication"]),
    );
    _injectRoleForTesting(makeRoleConfig("dev"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const { res, result } = mockRes();
    agentIdentityEndpoint({ params: { name: "dev" } }, res);

    const data = result().data as AgentIdentityResponse;
    expect(data.success).toBe(true);
    expect(data.agentName).toBe("dev");
    expect(data.archetype).not.toBeNull();
    expect(data.archetype!.species).toBe("ant");
    expect(data.archetype!.cognitiveStyle).toBe("ant-style");
    expect(data.archetype!.sectionCount).toBe(2);
    expect(data.archetype!.tokenBudget).toBe(10000);
    expect(data.role).not.toBeNull();
    expect(data.role!.role).toBe("dev");
    expect(data.role!.purpose).toBe("dev purpose");
    expect(data.warnings).toHaveLength(0);
  });

  it("returns null archetype with warning when not loaded", () => {
    _injectRoleForTesting(makeRoleConfig("dev"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const { res, result } = mockRes();
    agentIdentityEndpoint({ params: { name: "dev" } }, res);

    const data = result().data as AgentIdentityResponse;
    expect(data.success).toBe(true);
    expect(data.archetype).toBeNull();
    expect(data.role).not.toBeNull();
    expect(data.warnings.length).toBeGreaterThan(0);
    expect(data.warnings[0].field).toBe("archetype");
  });

  it("returns null role with warning when not loaded", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const { res, result } = mockRes();
    agentIdentityEndpoint({ params: { name: "dev" } }, res);

    const data = result().data as AgentIdentityResponse;
    expect(data.success).toBe(true);
    expect(data.archetype).not.toBeNull();
    expect(data.role).toBeNull();
    expect(data.warnings.length).toBeGreaterThan(0);
    expect(data.warnings[0].field).toBe("role");
  });

  it("is case-insensitive for agent name", () => {
    _injectArchetypeForTesting(makeArchetypeConfig("ant"));
    _injectRoleForTesting(makeRoleConfig("dev"));
    registerBinding({ agentName: "dev", archetype: "ant", role: "dev" });

    const { res, result } = mockRes();
    agentIdentityEndpoint({ params: { name: "Dev" } }, res);

    const data = result().data as AgentIdentityResponse;
    expect(data.success).toBe(true);
    expect(data.agentName).toBe("dev");
  });
});
