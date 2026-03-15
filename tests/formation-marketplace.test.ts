/**
 * Formation Marketplace Tests — ELLIE-734
 *
 * Tests for marketplace backend logic:
 * - Template card building
 * - Detail view building (with install status)
 * - Install planning (collision detection)
 * - Install execution (skip/rename/overwrite)
 * - Installed formations list and stats
 * - E2E: browse → preview → install → manage
 */

import { describe, test, expect } from "bun:test";
import {
  buildTemplateCards,
  buildDetailView,
  planInstall,
  executeInstall,
  buildInstalledList,
  computeInstallStats,
  type TemplateCard,
  type TemplateDetailView,
  type InstalledFormation,
  type InstallResult,
  type InstallOptions,
} from "../src/formation-marketplace.ts";
import type { TemplateMetadata } from "../src/formation-registry.ts";
import { buildTemplateMetadata, BUNDLED_TEMPLATES } from "../src/formation-registry.ts";
import type { ExportedAgent, ExportedProtocol } from "../src/formation-export.ts";

// ── Helpers ─────────────────────────────────────────────────

function makeMeta(overrides: Partial<TemplateMetadata> = {}): TemplateMetadata {
  return buildTemplateMetadata({
    name: overrides.name ?? "Test Formation",
    description: overrides.description ?? "A test formation",
    source: overrides.source ?? "bundled",
    categories: overrides.categories ?? ["operations"],
    agent_count: overrides.agent_count ?? 3,
    author: overrides.author ?? "ellie-os",
    path: overrides.path ?? "bundled/test/SKILL.md",
    version: overrides.version,
  });
}

function makeAgent(overrides: Partial<ExportedAgent> = {}): ExportedAgent {
  return {
    name: "dev",
    type: "dev",
    title: null,
    role: "lead",
    responsibility: "Write code",
    model: null,
    capabilities: [],
    skills: [],
    ...overrides,
  };
}

function makeProtocol(): ExportedProtocol {
  return {
    pattern: "coordinator",
    maxTurns: 10,
    coordinator: "dev",
    turnOrder: null,
    requiresApproval: false,
    conflictResolution: "coordinator-decides",
  };
}

function makeInstalled(overrides: Partial<InstalledFormation> = {}): InstalledFormation {
  return {
    slug: "test-formation",
    name: "Test Formation",
    version: "1.0.0",
    installed_at: new Date().toISOString(),
    source: "bundled",
    status: "active",
    agent_count: 3,
    ...overrides,
  };
}

// ── buildTemplateCards ──────────────────────────────────────

describe("buildTemplateCards", () => {
  test("builds cards from templates", () => {
    const templates = [makeMeta({ name: "Alpha" }), makeMeta({ name: "Beta" })];
    const cards = buildTemplateCards(templates, new Set());
    expect(cards).toHaveLength(2);
    expect(cards[0].name).toBe("Alpha");
    expect(cards[0].is_installed).toBe(false);
  });

  test("marks installed templates", () => {
    const templates = [makeMeta({ name: "Alpha" }), makeMeta({ name: "Beta" })];
    const cards = buildTemplateCards(templates, new Set(["alpha"]));
    expect(cards[0].is_installed).toBe(true);
    expect(cards[1].is_installed).toBe(false);
  });

  test("includes all card fields", () => {
    const card = buildTemplateCards([makeMeta()], new Set())[0];
    expect(card.slug).toBeTruthy();
    expect(card.name).toBeTruthy();
    expect(card.description).toBeTruthy();
    expect(card.categories).toBeInstanceOf(Array);
    expect(typeof card.agent_count).toBe("number");
    expect(card.author).toBeTruthy();
    expect(card.source).toBeTruthy();
    expect(card.version).toBeTruthy();
  });

  test("empty templates returns empty cards", () => {
    expect(buildTemplateCards([], new Set())).toHaveLength(0);
  });
});

// ── buildDetailView ─────────────────────────────────────────

describe("buildDetailView", () => {
  const meta = makeMeta();
  const agents = [makeAgent(), makeAgent({ name: "critic", role: "reviewer" })];
  const protocol = makeProtocol();

  test("builds full detail view", () => {
    const view = buildDetailView(meta, agents, protocol, new Set());
    expect(view.name).toBe("Test Formation");
    expect(view.agents).toHaveLength(2);
    expect(view.protocol.pattern).toBe("coordinator");
    expect(view.is_installed).toBe(false);
    expect(view.install_status).toBe("available");
  });

  test("shows installed status", () => {
    const view = buildDetailView(meta, agents, protocol, new Set(["test-formation"]));
    expect(view.is_installed).toBe(true);
    expect(view.install_status).toBe("installed");
  });

  test("shows update_available when version differs", () => {
    const versions = new Map([["test-formation", "0.9.0"]]);
    const view = buildDetailView(meta, agents, protocol, new Set(["test-formation"]), versions);
    expect(view.install_status).toBe("update_available");
  });

  test("shows installed when version matches", () => {
    const versions = new Map([["test-formation", "1.0.0"]]);
    const view = buildDetailView(meta, agents, protocol, new Set(["test-formation"]), versions);
    expect(view.install_status).toBe("installed");
  });

  test("agents are previewed with name, type, role, responsibility", () => {
    const view = buildDetailView(meta, agents, protocol, new Set());
    expect(view.agents[0].name).toBe("dev");
    expect(view.agents[0].role).toBe("lead");
    expect(view.agents[1].name).toBe("critic");
  });

  test("protocol overview includes key fields", () => {
    const view = buildDetailView(meta, agents, protocol, new Set());
    expect(view.protocol.maxTurns).toBe(10);
    expect(view.protocol.coordinator).toBe("dev");
    expect(view.protocol.requiresApproval).toBe(false);
  });
});

// ── planInstall ─────────────────────────────────────────────

describe("planInstall", () => {
  test("returns collisions with existing agents", () => {
    const agents = [makeAgent({ name: "dev" }), makeAgent({ name: "critic" })];
    const collisions = planInstall(agents, new Set(["dev"]));
    expect(collisions).toHaveLength(1);
    expect(collisions[0].imported_name).toBe("dev");
  });

  test("no collisions when all names are unique", () => {
    const agents = [makeAgent({ name: "new-agent" })];
    expect(planInstall(agents, new Set(["dev"]))).toHaveLength(0);
  });

  test("empty existing set means no collisions", () => {
    const agents = [makeAgent()];
    expect(planInstall(agents, new Set())).toHaveLength(0);
  });
});

// ── executeInstall ──────────────────────────────────────────

describe("executeInstall", () => {
  test("installs agents with no collisions", () => {
    const agents = [makeAgent({ name: "new-dev" }), makeAgent({ name: "new-critic" })];
    const result = executeInstall("my-formation", agents, new Set(), {
      collisions: {},
      rename_map: {},
    });

    expect(result.success).toBe(true);
    expect(result.agents_created).toEqual(["new-dev", "new-critic"]);
    expect(result.agents_skipped).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  test("skips colliding agents", () => {
    const agents = [makeAgent({ name: "dev" }), makeAgent({ name: "new-agent" })];
    const result = executeInstall("my-formation", agents, new Set(["dev"]), {
      collisions: { dev: "skip" },
      rename_map: {},
    });

    expect(result.success).toBe(true);
    expect(result.agents_created).toEqual(["new-agent"]);
    expect(result.agents_skipped).toEqual(["dev"]);
  });

  test("renames colliding agents", () => {
    const agents = [makeAgent({ name: "dev" })];
    const result = executeInstall("my-formation", agents, new Set(["dev"]), {
      collisions: { dev: "rename" },
      rename_map: { dev: "dev-2" },
    });

    expect(result.success).toBe(true);
    expect(result.agents_renamed).toEqual({ dev: "dev-2" });
    expect(result.agents_created).toContain("dev-2");
  });

  test("auto-generates rename when not in rename_map", () => {
    const agents = [makeAgent({ name: "dev" })];
    const result = executeInstall("my-formation", agents, new Set(["dev"]), {
      collisions: { dev: "rename" },
      rename_map: {},
    });

    expect(result.agents_renamed.dev).toBe("dev-2");
  });

  test("overwrites colliding agents", () => {
    const agents = [makeAgent({ name: "dev" })];
    const result = executeInstall("my-formation", agents, new Set(["dev"]), {
      collisions: { dev: "overwrite" },
      rename_map: {},
    });

    expect(result.agents_created).toEqual(["dev"]);
    expect(result.agents_skipped).toHaveLength(0);
  });

  test("mixed collision strategies", () => {
    const agents = [
      makeAgent({ name: "dev" }),
      makeAgent({ name: "critic" }),
      makeAgent({ name: "new-agent" }),
    ];
    const result = executeInstall("my-formation", agents, new Set(["dev", "critic"]), {
      collisions: { dev: "skip", critic: "rename" },
      rename_map: { critic: "critic-imported" },
    });

    expect(result.agents_skipped).toEqual(["dev"]);
    expect(result.agents_renamed).toEqual({ critic: "critic-imported" });
    expect(result.agents_created).toContain("critic-imported");
    expect(result.agents_created).toContain("new-agent");
  });

  test("defaults to skip for unspecified collisions", () => {
    const agents = [makeAgent({ name: "dev" })];
    const result = executeInstall("my-formation", agents, new Set(["dev"]), {
      collisions: {},
      rename_map: {},
    });

    expect(result.agents_skipped).toEqual(["dev"]);
  });
});

// ── buildInstalledList ──────────────────────────────────────

describe("buildInstalledList", () => {
  test("returns all formations sorted by name", () => {
    const formations = [
      makeInstalled({ name: "Zulu", slug: "zulu" }),
      makeInstalled({ name: "Alpha", slug: "alpha" }),
    ];
    const list = buildInstalledList(formations);
    expect(list[0].name).toBe("Alpha");
    expect(list[1].name).toBe("Zulu");
  });

  test("filters by active status", () => {
    const formations = [
      makeInstalled({ slug: "a", status: "active" }),
      makeInstalled({ slug: "b", status: "paused" }),
    ];
    const list = buildInstalledList(formations, { status: "active" });
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe("active");
  });

  test("filters by paused status", () => {
    const formations = [
      makeInstalled({ slug: "a", status: "active" }),
      makeInstalled({ slug: "b", status: "paused" }),
    ];
    expect(buildInstalledList(formations, { status: "paused" })).toHaveLength(1);
  });

  test("returns empty for empty input", () => {
    expect(buildInstalledList([])).toHaveLength(0);
  });
});

// ── computeInstallStats ─────────────────────────────────────

describe("computeInstallStats", () => {
  test("computes all statistics", () => {
    const formations = [
      makeInstalled({ slug: "a", source: "bundled", status: "active" }),
      makeInstalled({ slug: "b", source: "bundled", status: "active" }),
      makeInstalled({ slug: "c", source: "custom", status: "paused" }),
      makeInstalled({ slug: "d", source: "marketplace", status: "active" }),
    ];

    const stats = computeInstallStats(formations);
    expect(stats.total).toBe(4);
    expect(stats.active).toBe(3);
    expect(stats.paused).toBe(1);
    expect(stats.by_source.bundled).toBe(2);
    expect(stats.by_source.custom).toBe(1);
    expect(stats.by_source.marketplace).toBe(1);
  });

  test("handles empty list", () => {
    const stats = computeInstallStats([]);
    expect(stats.total).toBe(0);
    expect(stats.active).toBe(0);
    expect(stats.paused).toBe(0);
  });
});

// ── E2E: Browse → Preview → Install → Manage ───────────────

describe("E2E: marketplace lifecycle", () => {
  test("browse → preview → plan → install → manage", () => {
    // Step 1: Browse — build cards from bundled templates
    const cards = buildTemplateCards(BUNDLED_TEMPLATES, new Set());
    expect(cards.length).toBe(3);
    expect(cards.every(c => !c.is_installed)).toBe(true);

    // Step 2: Preview — get detail view for boardroom
    const boardroom = BUNDLED_TEMPLATES.find(t => t.slug === "boardroom")!;
    const agents = [
      makeAgent({ name: "strategy", role: "CEO" }),
      makeAgent({ name: "finance", role: "VP" }),
      makeAgent({ name: "research", role: "VP" }),
    ];
    const detail = buildDetailView(boardroom, agents, makeProtocol(), new Set());
    expect(detail.install_status).toBe("available");
    expect(detail.agents).toHaveLength(3);

    // Step 3: Plan install — check for collisions
    const existing = new Set(["strategy"]); // One collision
    const collisions = planInstall(agents, existing);
    expect(collisions).toHaveLength(1);
    expect(collisions[0].imported_name).toBe("strategy");

    // Step 4: Execute install with rename
    const result = executeInstall("boardroom", agents, existing, {
      collisions: { strategy: "rename" },
      rename_map: { strategy: "strategy-boardroom" },
    });
    expect(result.success).toBe(true);
    expect(result.agents_renamed).toEqual({ strategy: "strategy-boardroom" });
    expect(result.agents_created).toContain("strategy-boardroom");
    expect(result.agents_created).toContain("finance");
    expect(result.agents_created).toContain("research");

    // Step 5: Manage — view installed formations
    const installed = [
      makeInstalled({ slug: "boardroom", name: "Boardroom", source: "bundled", status: "active", agent_count: 3 }),
    ];
    const myFormations = buildInstalledList(installed);
    expect(myFormations).toHaveLength(1);
    expect(myFormations[0].slug).toBe("boardroom");

    // Step 6: Stats
    const stats = computeInstallStats(installed);
    expect(stats.total).toBe(1);
    expect(stats.by_source.bundled).toBe(1);

    // Step 7: Cards now show installed
    const updatedCards = buildTemplateCards(BUNDLED_TEMPLATES, new Set(["boardroom"]));
    const boardroomCard = updatedCards.find(c => c.slug === "boardroom")!;
    expect(boardroomCard.is_installed).toBe(true);
  });
});
