/**
 * Formation Template Registry Tests — ELLIE-733
 *
 * Tests for the formation template registry:
 * - Constants and types
 * - Template metadata building and validation
 * - Registry CRUD (register, get, unregister, clear)
 * - Version tracking
 * - Discovery queries (category, source, author, agent count, search)
 * - List by source
 * - Categories in use
 * - Bundled templates
 * - Default registry
 * - E2E lifecycle
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  FormationRegistry,
  buildTemplateMetadata,
  slugifyTemplate,
  validateTemplateMetadata,
  createDefaultRegistry,
  BUNDLED_TEMPLATES,
  VALID_TEMPLATE_CATEGORIES,
  VALID_TEMPLATE_SOURCES,
  type TemplateMetadata,
  type TemplateCategory,
  type TemplateSource,
  type RegistryQueryOptions,
} from "../src/formation-registry.ts";

// ── Helpers ─────────────────────────────────────────────────

function makeTemplate(overrides: Partial<TemplateMetadata> = {}): TemplateMetadata {
  return buildTemplateMetadata({
    name: overrides.name ?? "Test Formation",
    description: overrides.description ?? "A test formation for unit tests",
    source: overrides.source ?? "custom",
    categories: overrides.categories ?? ["operations"],
    agent_count: overrides.agent_count ?? 3,
    author: overrides.author ?? "test-author",
    path: overrides.path ?? "custom/test-formation/SKILL.md",
    ...overrides,
  });
}

let registry: InstanceType<typeof FormationRegistry>;

beforeEach(() => {
  registry = new FormationRegistry();
});

// ── Constants ───────────────────────────────────────────────

describe("constants", () => {
  test("VALID_TEMPLATE_CATEGORIES has all expected values", () => {
    expect(VALID_TEMPLATE_CATEGORIES).toContain("operations");
    expect(VALID_TEMPLATE_CATEGORIES).toContain("strategy");
    expect(VALID_TEMPLATE_CATEGORIES).toContain("billing");
    expect(VALID_TEMPLATE_CATEGORIES).toContain("content");
    expect(VALID_TEMPLATE_CATEGORIES).toContain("support");
    expect(VALID_TEMPLATE_CATEGORIES).toContain("engineering");
    expect(VALID_TEMPLATE_CATEGORIES).toContain("finance");
    expect(VALID_TEMPLATE_CATEGORIES).toContain("research");
    expect(VALID_TEMPLATE_CATEGORIES).toHaveLength(8);
  });

  test("VALID_TEMPLATE_SOURCES has 3 sources", () => {
    expect(VALID_TEMPLATE_SOURCES).toEqual(["bundled", "marketplace", "custom"]);
  });

  test("BUNDLED_TEMPLATES has the 3 shipped formations", () => {
    expect(BUNDLED_TEMPLATES).toHaveLength(3);
    const names = BUNDLED_TEMPLATES.map(t => t.slug);
    expect(names).toContain("boardroom");
    expect(names).toContain("think-tank");
    expect(names).toContain("software-development");
  });
});

// ── slugifyTemplate ─────────────────────────────────────────

describe("slugifyTemplate", () => {
  test("lowercases and hyphenates", () => {
    expect(slugifyTemplate("Think Tank")).toBe("think-tank");
  });

  test("handles special characters", () => {
    expect(slugifyTemplate("Software Development!")).toBe("software-development");
  });

  test("trims leading/trailing hyphens", () => {
    expect(slugifyTemplate("  --hello--  ")).toBe("hello");
  });
});

// ── buildTemplateMetadata ───────────────────────────────────

describe("buildTemplateMetadata", () => {
  test("builds metadata with all fields", () => {
    const meta = buildTemplateMetadata({
      name: "Billing Ops",
      description: "Process medical claims",
      source: "bundled",
      categories: ["billing", "operations"],
      agent_count: 4,
      author: "ellie-os",
      path: "bundled/billing-ops/SKILL.md",
    });

    expect(meta.name).toBe("Billing Ops");
    expect(meta.slug).toBe("billing-ops");
    expect(meta.source).toBe("bundled");
    expect(meta.categories).toEqual(["billing", "operations"]);
    expect(meta.agent_count).toBe(4);
    expect(meta.version).toBe("1.0.0");
    expect(meta.created_at).toBeTruthy();
  });

  test("accepts custom version", () => {
    const meta = buildTemplateMetadata({
      name: "Test",
      description: "Test",
      source: "custom",
      categories: ["operations"],
      agent_count: 2,
      author: "test",
      path: "custom/test/SKILL.md",
      version: "2.1.0",
    });
    expect(meta.version).toBe("2.1.0");
  });
});

// ── validateTemplateMetadata ────────────────────────────────

describe("validateTemplateMetadata", () => {
  test("valid metadata passes", () => {
    const errors = validateTemplateMetadata(makeTemplate());
    expect(errors).toHaveLength(0);
  });

  test("empty name fails", () => {
    const meta = makeTemplate();
    meta.name = "";
    expect(validateTemplateMetadata(meta).length).toBeGreaterThan(0);
  });

  test("empty description fails", () => {
    const meta = makeTemplate();
    meta.description = "";
    expect(validateTemplateMetadata(meta).length).toBeGreaterThan(0);
  });

  test("invalid source fails", () => {
    const meta = makeTemplate();
    (meta as any).source = "unknown";
    expect(validateTemplateMetadata(meta).some(e => e.includes("source"))).toBe(true);
  });

  test("empty categories fails", () => {
    const meta = makeTemplate();
    meta.categories = [];
    expect(validateTemplateMetadata(meta).length).toBeGreaterThan(0);
  });

  test("invalid category fails", () => {
    const meta = makeTemplate();
    (meta.categories as any) = ["invalid-cat"];
    expect(validateTemplateMetadata(meta).some(e => e.includes("invalid"))).toBe(true);
  });

  test("agent_count < 1 fails", () => {
    const meta = makeTemplate();
    meta.agent_count = 0;
    expect(validateTemplateMetadata(meta).length).toBeGreaterThan(0);
  });

  test("empty author fails", () => {
    const meta = makeTemplate();
    meta.author = "";
    expect(validateTemplateMetadata(meta).length).toBeGreaterThan(0);
  });

  test("empty path fails", () => {
    const meta = makeTemplate();
    meta.path = "";
    expect(validateTemplateMetadata(meta).length).toBeGreaterThan(0);
  });
});

// ── Registry CRUD ───────────────────────────────────────────

describe("FormationRegistry CRUD", () => {
  test("register and get", () => {
    const meta = makeTemplate();
    registry.register(meta);
    expect(registry.get(meta.slug)).not.toBeNull();
    expect(registry.get(meta.slug)!.name).toBe("Test Formation");
  });

  test("get returns null for unknown slug", () => {
    expect(registry.get("nonexistent")).toBeNull();
  });

  test("unregister removes template", () => {
    registry.register(makeTemplate());
    expect(registry.unregister("test-formation")).toBe(true);
    expect(registry.get("test-formation")).toBeNull();
  });

  test("unregister returns false for unknown slug", () => {
    expect(registry.unregister("nonexistent")).toBe(false);
  });

  test("size returns count", () => {
    expect(registry.size()).toBe(0);
    registry.register(makeTemplate());
    expect(registry.size()).toBe(1);
    registry.register(makeTemplate({ name: "Other" }));
    expect(registry.size()).toBe(2);
  });

  test("slugs returns all slugs", () => {
    registry.register(makeTemplate({ name: "Alpha" }));
    registry.register(makeTemplate({ name: "Beta" }));
    expect(registry.slugs().sort()).toEqual(["alpha", "beta"]);
  });

  test("clear removes all", () => {
    registry.register(makeTemplate());
    registry.register(makeTemplate({ name: "Other" }));
    registry.clear();
    expect(registry.size()).toBe(0);
  });
});

// ── Version Tracking ────────────────────────────────────────

describe("version tracking", () => {
  test("re-registering a slug updates version and preserves history", () => {
    const v1 = makeTemplate({ name: "My Formation" });
    v1.version = "1.0.0";
    registry.register(v1);

    const v2 = { ...makeTemplate({ name: "My Formation" }), version: "2.0.0" };
    registry.register(v2, "Added new agent");

    const versioned = registry.getVersioned("my-formation");
    expect(versioned).not.toBeNull();
    expect(versioned!.current.version).toBe("2.0.0");
    expect(versioned!.versions).toHaveLength(1);
    expect(versioned!.versions[0].version).toBe("1.0.0");
    expect(versioned!.versions[0].changelog).toBe("Added new agent");
  });

  test("first registration has empty version history", () => {
    registry.register(makeTemplate());
    const versioned = registry.getVersioned("test-formation");
    expect(versioned!.versions).toHaveLength(0);
  });

  test("multiple updates accumulate history", () => {
    for (let i = 1; i <= 3; i++) {
      const meta = makeTemplate();
      meta.version = `${i}.0.0`;
      registry.register(meta, `v${i} changes`);
    }

    const versioned = registry.getVersioned("test-formation")!;
    expect(versioned.current.version).toBe("3.0.0");
    expect(versioned.versions).toHaveLength(2);
    expect(versioned.versions[0].version).toBe("1.0.0");
    expect(versioned.versions[1].version).toBe("2.0.0");
  });
});

// ── Discovery Queries ───────────────────────────────────────

describe("registry.query", () => {
  beforeEach(() => {
    registry.register(makeTemplate({ name: "Billing Ops", categories: ["billing", "operations"] as any, agent_count: 4, source: "bundled", author: "ellie-os" }));
    registry.register(makeTemplate({ name: "Think Tank", categories: ["strategy", "research"] as any, agent_count: 4, source: "bundled", author: "ellie-os" }));
    registry.register(makeTemplate({ name: "Custom Flow", categories: ["operations"] as any, agent_count: 2, source: "custom", author: "dave" }));
  });

  test("no filters returns all sorted by name", () => {
    const results = registry.query();
    expect(results).toHaveLength(3);
    expect(results[0].name).toBe("Billing Ops");
    expect(results[2].name).toBe("Think Tank");
  });

  test("filter by category", () => {
    const results = registry.query({ category: "billing" });
    expect(results).toHaveLength(1);
    expect(results[0].slug).toBe("billing-ops");
  });

  test("filter by source", () => {
    const results = registry.query({ source: "bundled" });
    expect(results).toHaveLength(2);
  });

  test("filter by author", () => {
    const results = registry.query({ author: "dave" });
    expect(results).toHaveLength(1);
    expect(results[0].slug).toBe("custom-flow");
  });

  test("author filter is case-insensitive", () => {
    expect(registry.query({ author: "DAVE" })).toHaveLength(1);
  });

  test("filter by min_agents", () => {
    const results = registry.query({ min_agents: 3 });
    expect(results).toHaveLength(2);
  });

  test("filter by max_agents", () => {
    const results = registry.query({ max_agents: 3 });
    expect(results).toHaveLength(1);
    expect(results[0].slug).toBe("custom-flow");
  });

  test("filter by agent count range", () => {
    const results = registry.query({ min_agents: 2, max_agents: 4 });
    expect(results).toHaveLength(3);
  });

  test("search by name", () => {
    const results = registry.query({ search: "billing" });
    expect(results).toHaveLength(1);
  });

  test("search by description", () => {
    const results = registry.query({ search: "test" });
    expect(results).toHaveLength(3); // All have "test" in description
  });

  test("search is case-insensitive", () => {
    expect(registry.query({ search: "THINK" })).toHaveLength(1);
  });

  test("combined filters", () => {
    const results = registry.query({ source: "bundled", category: "strategy" });
    expect(results).toHaveLength(1);
    expect(results[0].slug).toBe("think-tank");
  });

  test("no matches returns empty array", () => {
    expect(registry.query({ category: "support" })).toHaveLength(0);
  });
});

// ── listBySource ────────────────────────────────────────────

describe("registry.listBySource", () => {
  test("groups templates by source", () => {
    registry.register(makeTemplate({ name: "Bundled One", source: "bundled" }));
    registry.register(makeTemplate({ name: "Custom One", source: "custom" }));

    const grouped = registry.listBySource();
    expect(grouped.bundled).toHaveLength(1);
    expect(grouped.custom).toHaveLength(1);
    expect(grouped.marketplace).toHaveLength(0);
  });

  test("sorts within each group", () => {
    registry.register(makeTemplate({ name: "Beta", source: "bundled" }));
    registry.register(makeTemplate({ name: "Alpha", source: "bundled" }));

    const grouped = registry.listBySource();
    expect(grouped.bundled[0].name).toBe("Alpha");
    expect(grouped.bundled[1].name).toBe("Beta");
  });
});

// ── categories ──────────────────────────────────────────────

describe("registry.categories", () => {
  test("returns unique categories in use", () => {
    registry.register(makeTemplate({ name: "A", categories: ["billing", "operations"] as any }));
    registry.register(makeTemplate({ name: "B", categories: ["operations", "strategy"] as any }));

    const cats = registry.categories();
    expect(cats).toEqual(["billing", "operations", "strategy"]);
  });

  test("returns empty for empty registry", () => {
    expect(registry.categories()).toHaveLength(0);
  });
});

// ── Bundled Templates ───────────────────────────────────────

describe("bundled templates", () => {
  test("boardroom has correct metadata", () => {
    const t = BUNDLED_TEMPLATES.find(t => t.slug === "boardroom")!;
    expect(t.source).toBe("bundled");
    expect(t.categories).toContain("strategy");
    expect(t.agent_count).toBe(6);
    expect(t.author).toBe("ellie-os");
  });

  test("think-tank has correct metadata", () => {
    const t = BUNDLED_TEMPLATES.find(t => t.slug === "think-tank")!;
    expect(t.categories).toContain("research");
    expect(t.agent_count).toBe(4);
  });

  test("software-development has correct metadata", () => {
    const t = BUNDLED_TEMPLATES.find(t => t.slug === "software-development")!;
    expect(t.categories).toContain("engineering");
    expect(t.agent_count).toBe(3);
  });

  test("all bundled templates pass validation", () => {
    for (const tmpl of BUNDLED_TEMPLATES) {
      const errors = validateTemplateMetadata(tmpl);
      expect(errors).toHaveLength(0);
    }
  });
});

// ── createDefaultRegistry ───────────────────────────────────

describe("createDefaultRegistry", () => {
  test("creates registry with all bundled templates", () => {
    const reg = createDefaultRegistry();
    expect(reg.size()).toBe(BUNDLED_TEMPLATES.length);
    expect(reg.get("boardroom")).not.toBeNull();
    expect(reg.get("think-tank")).not.toBeNull();
    expect(reg.get("software-development")).not.toBeNull();
  });
});

// ── E2E: Registry Lifecycle ─────────────────────────────────

describe("E2E: registry lifecycle", () => {
  test("startup → register custom → query → update → version history", () => {
    // Start with bundled
    const reg = createDefaultRegistry();
    expect(reg.size()).toBe(3);

    // Register a custom template
    const custom = makeTemplate({
      name: "Client Billing",
      description: "Custom billing formation for client",
      source: "custom",
      categories: ["billing"] as any,
      agent_count: 5,
      author: "dave",
      path: "custom/client-billing/SKILL.md",
    });
    reg.register(custom);
    expect(reg.size()).toBe(4);

    // Query billing formations
    const billing = reg.query({ category: "billing" });
    expect(billing).toHaveLength(1);
    expect(billing[0].author).toBe("dave");

    // Query all bundled
    const bundled = reg.query({ source: "bundled" });
    expect(bundled).toHaveLength(3);

    // Update the custom template
    const v2 = { ...custom, version: "2.0.0", agent_count: 6 };
    reg.register(v2, "Added claims reviewer agent");

    const versioned = reg.getVersioned("client-billing")!;
    expect(versioned.current.version).toBe("2.0.0");
    expect(versioned.current.agent_count).toBe(6);
    expect(versioned.versions).toHaveLength(1);
    expect(versioned.versions[0].changelog).toBe("Added claims reviewer agent");

    // Categories includes billing
    expect(reg.categories()).toContain("billing");

    // List by source
    const grouped = reg.listBySource();
    expect(grouped.bundled).toHaveLength(3);
    expect(grouped.custom).toHaveLength(1);
  });
});
