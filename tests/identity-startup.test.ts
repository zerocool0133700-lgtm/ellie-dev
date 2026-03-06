/**
 * Tests for ELLIE-615: Identity system startup wiring
 *
 * Covers: initIdentitySystem, shutdownIdentitySystem, getIdentityStatus
 * using real config/archetypes/ and config/roles/ directories.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  initIdentitySystem,
  shutdownIdentitySystem,
  getIdentityStatus,
} from "../src/identity-startup.ts";
import { _resetLoaderForTesting } from "../src/archetype-loader.ts";
import { _resetRoleLoaderForTesting } from "../src/role-loader.ts";
import { _resetBindingsForTesting } from "../src/agent-identity-binding.ts";

// ── Setup / Teardown ────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
  _resetLoaderForTesting();
  _resetRoleLoaderForTesting();
  _resetBindingsForTesting();
  tempDir = mkdtempSync(join(tmpdir(), "ellie-identity-test-"));
});

afterEach(() => {
  shutdownIdentitySystem();
  try { rmSync(tempDir, { recursive: true }); } catch {}
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function writeArchetype(dir: string, species: string) {
  const content = [
    "---",
    `species: ${species}`,
    "token_budget: 20000",
    "allowed_skills: [memory]",
    "section_priorities:",
    "  archetype: 1",
    "---",
    "",
    `# ${species}`,
    "",
    "## Identity",
    `You are the ${species} archetype.`,
  ].join("\n");
  writeFileSync(join(dir, `${species}.md`), content);
}

function writeRole(dir: string, role: string) {
  const content = [
    "---",
    `role: ${role}`,
    `purpose: "Test role for ${role}"`,
    "---",
    "",
    `# ${role}`,
    "",
    "## Core Responsibilities",
    `Handle ${role} tasks.`,
  ].join("\n");
  writeFileSync(join(dir, `${role}.md`), content);
}

// ── initIdentitySystem ──────────────────────────────────────────────────────

describe("initIdentitySystem", () => {
  it("loads archetypes and roles from provided directories", () => {
    const arcDir = join(tempDir, "archetypes");
    const roleDir = join(tempDir, "roles");
    mkdirSync(arcDir);
    mkdirSync(roleDir);

    writeArchetype(arcDir, "ant");
    writeArchetype(arcDir, "owl");
    writeRole(roleDir, "dev");
    writeRole(roleDir, "researcher");

    const result = initIdentitySystem({
      archetypesDir: arcDir,
      rolesDir: roleDir,
      skipWatchers: true,
    });

    expect(result.archetypes.loaded).toBe(2);
    expect(result.archetypes.failed).toBe(0);
    expect(result.roles.loaded).toBe(2);
    expect(result.roles.failed).toBe(0);
  });

  it("registers default bindings", () => {
    const arcDir = join(tempDir, "archetypes");
    const roleDir = join(tempDir, "roles");
    mkdirSync(arcDir);
    mkdirSync(roleDir);

    const result = initIdentitySystem({
      archetypesDir: arcDir,
      rolesDir: roleDir,
      skipWatchers: true,
    });

    // Should register all 8 default bindings
    expect(result.bindingsLoaded).toBe(8);
  });

  it("reports binding validation warnings for missing archetypes/roles", () => {
    const arcDir = join(tempDir, "archetypes");
    const roleDir = join(tempDir, "roles");
    mkdirSync(arcDir);
    mkdirSync(roleDir);

    // Load no archetypes or roles — all bindings should warn
    const result = initIdentitySystem({
      archetypesDir: arcDir,
      rolesDir: roleDir,
      skipWatchers: true,
    });

    expect(result.bindingValidation.valid).toBe(false);
    expect(result.bindingValidation.warnings.length).toBeGreaterThan(0);

    // Should have warnings for missing archetype and role files
    const arcWarnings = result.bindingValidation.warnings.filter(w => w.field === "archetype");
    const roleWarnings = result.bindingValidation.warnings.filter(w => w.field === "role");
    expect(arcWarnings.length).toBeGreaterThan(0);
    expect(roleWarnings.length).toBeGreaterThan(0);
  });

  it("reports valid when all referenced files exist", () => {
    const arcDir = join(tempDir, "archetypes");
    const roleDir = join(tempDir, "roles");
    mkdirSync(arcDir);
    mkdirSync(roleDir);

    // Write all archetypes and roles referenced by DEFAULT_BINDINGS
    writeArchetype(arcDir, "ant");
    writeArchetype(arcDir, "owl");
    writeArchetype(arcDir, "bee");
    writeRole(roleDir, "dev");
    writeRole(roleDir, "general");
    writeRole(roleDir, "researcher");
    writeRole(roleDir, "strategy");
    writeRole(roleDir, "critic");
    writeRole(roleDir, "content");
    writeRole(roleDir, "finance");
    writeRole(roleDir, "ops");

    const result = initIdentitySystem({
      archetypesDir: arcDir,
      rolesDir: roleDir,
      skipWatchers: true,
    });

    expect(result.bindingValidation.valid).toBe(true);
    expect(result.bindingValidation.warnings).toHaveLength(0);
  });

  it("handles missing directories gracefully", () => {
    const result = initIdentitySystem({
      archetypesDir: join(tempDir, "nonexistent-archetypes"),
      rolesDir: join(tempDir, "nonexistent-roles"),
      skipWatchers: true,
    });

    expect(result.archetypes.loaded).toBe(0);
    expect(result.roles.loaded).toBe(0);
    // Should still register default bindings
    expect(result.bindingsLoaded).toBe(8);
  });

  it("reports load errors for malformed files", () => {
    const arcDir = join(tempDir, "archetypes");
    const roleDir = join(tempDir, "roles");
    mkdirSync(arcDir);
    mkdirSync(roleDir);

    // Write an invalid archetype (no frontmatter)
    writeFileSync(join(arcDir, "broken.md"), "This is not a valid archetype file.");
    writeArchetype(arcDir, "ant");

    const result = initIdentitySystem({
      archetypesDir: arcDir,
      rolesDir: roleDir,
      skipWatchers: true,
    });

    expect(result.archetypes.loaded).toBe(1);
    expect(result.archetypes.failed).toBe(1);
    expect(result.archetypes.errors).toHaveLength(1);
    expect(result.archetypes.errors[0].file).toBe("broken.md");
  });

  it("starts watchers when not skipped", () => {
    const arcDir = join(tempDir, "archetypes");
    const roleDir = join(tempDir, "roles");
    mkdirSync(arcDir);
    mkdirSync(roleDir);

    const result = initIdentitySystem({
      archetypesDir: arcDir,
      rolesDir: roleDir,
      skipWatchers: false,
    });

    expect(result.watchersStarted.archetypes).toBe(true);
    expect(result.watchersStarted.roles).toBe(true);
  });

  it("skips watchers when requested", () => {
    const arcDir = join(tempDir, "archetypes");
    const roleDir = join(tempDir, "roles");
    mkdirSync(arcDir);
    mkdirSync(roleDir);

    const result = initIdentitySystem({
      archetypesDir: arcDir,
      rolesDir: roleDir,
      skipWatchers: true,
    });

    expect(result.watchersStarted.archetypes).toBe(false);
    expect(result.watchersStarted.roles).toBe(false);
  });
});

// ── initIdentitySystem with real config ─────────────────────────────────────

describe("initIdentitySystem — real config", () => {
  it("loads roles from actual config/roles/", () => {
    const projectRoot = join(__dirname, "..");
    const result = initIdentitySystem({
      archetypesDir: join(projectRoot, "config/archetypes"),
      rolesDir: join(projectRoot, "config/roles"),
      skipWatchers: true,
    });

    // Real roles use ODS format (role: in frontmatter) — should load
    expect(result.roles.loaded).toBeGreaterThan(0);
    // Real archetypes use legacy format — species inferred from filename/H1 heading
    expect(result.archetypes.loaded).toBeGreaterThan(0);
    expect(result.bindingsLoaded).toBe(8);
  });
});

// ── getIdentityStatus ────────────────────────────────────────────────────────

describe("getIdentityStatus", () => {
  it("returns zero counts before init", () => {
    const status = getIdentityStatus();
    expect(status.archetypes).toBe(0);
    expect(status.roles).toBe(0);
    expect(status.bindings).toBe(0);
  });

  it("returns correct counts after init", () => {
    const arcDir = join(tempDir, "archetypes");
    const roleDir = join(tempDir, "roles");
    mkdirSync(arcDir);
    mkdirSync(roleDir);

    writeArchetype(arcDir, "ant");
    writeRole(roleDir, "dev");

    initIdentitySystem({
      archetypesDir: arcDir,
      rolesDir: roleDir,
      skipWatchers: true,
    });

    const status = getIdentityStatus();
    expect(status.archetypes).toBe(1);
    expect(status.roles).toBe(1);
    expect(status.bindings).toBe(8); // default bindings
  });
});

// ── shutdownIdentitySystem ──────────────────────────────────────────────────

describe("shutdownIdentitySystem", () => {
  it("can be called without error even if not initialized", () => {
    // Should not throw
    shutdownIdentitySystem();
  });

  it("stops watchers after init", () => {
    const arcDir = join(tempDir, "archetypes");
    const roleDir = join(tempDir, "roles");
    mkdirSync(arcDir);
    mkdirSync(roleDir);

    initIdentitySystem({
      archetypesDir: arcDir,
      rolesDir: roleDir,
      skipWatchers: false,
    });

    // Should not throw
    shutdownIdentitySystem();

    // Verify watchers stopped by checking we can start them again
    const { isWatching } = require("../src/archetype-loader.ts");
    expect(isWatching()).toBe(false);
  });
});
