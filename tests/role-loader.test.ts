/**
 * Tests for Role Loader — ELLIE-606
 *
 * Covers: loading from directory, single file loading, queries,
 * cache management, hot-reload, malformed file handling.
 *
 * Uses a temp directory with test .md files.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  loadRoles,
  loadSingleFile,
  reloadRole,
  reloadFromPath,
  removeByPath,
  getRole,
  listRoles,
  listRoleConfigs,
  roleCount,
  hasRole,
  startWatcher,
  stopWatcher,
  isWatching,
  _resetRoleLoaderForTesting,
  _injectRoleForTesting,
  type RoleConfig,
} from "../src/role-loader";

// ── Test fixtures ────────────────────────────────────────────────────────────

const VALID_DEV = `---
role: dev
purpose: "Build, fix, and maintain code"
---

## Capabilities

- Implement features
- Fix bugs

## Context Requirements

- Work item from Plane

## Tool Categories

- File operations
- Execution

## Communication Contract

Show code diffs.

## Anti-Patterns

Never refactor outside scope.
`;

const VALID_RESEARCHER = `---
role: researcher
purpose: "Investigate topics and produce findings"
---

## Capabilities

Research and analysis.

## Context Requirements

Topic and scope.

## Tool Categories

Web search.

## Communication Contract

Structured summaries.

## Anti-Patterns

Never present speculation as fact.
`;

const MALFORMED_NO_ROLE = `---
purpose: "some purpose"
---

## Capabilities

Content.
`;

const MALFORMED_NO_FRONTMATTER = `# Just a heading

Some content.
`;

// ── Setup ────────────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
  _resetRoleLoaderForTesting();
  tempDir = mkdtempSync(join(tmpdir(), "role-test-"));
});

afterEach(() => {
  _resetRoleLoaderForTesting();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

// ── loadRoles ────────────────────────────────────────────────────────────────

describe("loadRoles", () => {
  it("loads valid role files from directory", () => {
    writeFileSync(join(tempDir, "dev.md"), VALID_DEV);
    writeFileSync(join(tempDir, "researcher.md"), VALID_RESEARCHER);

    const result = loadRoles(tempDir);
    expect(result.loaded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("counts malformed files as failed", () => {
    writeFileSync(join(tempDir, "dev.md"), VALID_DEV);
    writeFileSync(join(tempDir, "bad.md"), MALFORMED_NO_ROLE);

    const result = loadRoles(tempDir);
    expect(result.loaded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors[0].file).toBe("bad.md");
  });

  it("handles non-existent directory", () => {
    const result = loadRoles("/nonexistent/path");
    expect(result.loaded).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("skips non-.md files", () => {
    writeFileSync(join(tempDir, "dev.md"), VALID_DEV);
    writeFileSync(join(tempDir, "readme.txt"), "Not a role");

    const result = loadRoles(tempDir);
    expect(result.loaded).toBe(1);
  });

  it("handles empty directory", () => {
    const result = loadRoles(tempDir);
    expect(result.loaded).toBe(0);
  });

  it("handles file without frontmatter", () => {
    writeFileSync(join(tempDir, "plain.md"), MALFORMED_NO_FRONTMATTER);

    const result = loadRoles(tempDir);
    expect(result.failed).toBe(1);
  });
});

// ── loadSingleFile ───────────────────────────────────────────────────────────

describe("loadSingleFile", () => {
  it("loads and caches a valid role file", () => {
    const filePath = join(tempDir, "dev.md");
    writeFileSync(filePath, VALID_DEV);

    const config = loadSingleFile(filePath);
    expect(config).not.toBeNull();
    expect(config!.role).toBe("dev");
    expect(config!.schema.frontmatter.purpose).toBe("Build, fix, and maintain code");
    expect(config!.filePath).toBe(filePath);
    expect(getRole("dev")).not.toBeNull();
  });

  it("returns null for non-existent file", () => {
    expect(loadSingleFile("/nonexistent/file.md")).toBeNull();
  });

  it("returns null for malformed file", () => {
    const filePath = join(tempDir, "bad.md");
    writeFileSync(filePath, MALFORMED_NO_ROLE);
    expect(loadSingleFile(filePath)).toBeNull();
  });

  it("includes validation results", () => {
    const filePath = join(tempDir, "dev.md");
    writeFileSync(filePath, VALID_DEV);

    const config = loadSingleFile(filePath);
    expect(config!.validation.valid).toBe(true);
    expect(config!.validation.errors).toEqual([]);
  });

  it("loads file with validation errors (missing sections)", () => {
    const raw = `---
role: incomplete
purpose: "partial role"
---

## Capabilities

Content.
`;
    const filePath = join(tempDir, "incomplete.md");
    writeFileSync(filePath, raw);

    const config = loadSingleFile(filePath);
    expect(config).not.toBeNull();
    expect(config!.role).toBe("incomplete");
    expect(config!.validation.valid).toBe(false);
  });
});

// ── getRole ──────────────────────────────────────────────────────────────────

describe("getRole", () => {
  it("returns null for unknown role", () => {
    expect(getRole("unknown")).toBeNull();
  });

  it("is case-insensitive", () => {
    writeFileSync(join(tempDir, "dev.md"), VALID_DEV);
    loadRoles(tempDir);

    expect(getRole("dev")).not.toBeNull();
    expect(getRole("DEV")).not.toBeNull();
    expect(getRole("Dev")).not.toBeNull();
  });
});

// ── listRoles ────────────────────────────────────────────────────────────────

describe("listRoles", () => {
  it("returns empty when nothing loaded", () => {
    expect(listRoles()).toEqual([]);
  });

  it("returns all loaded role names", () => {
    writeFileSync(join(tempDir, "dev.md"), VALID_DEV);
    writeFileSync(join(tempDir, "researcher.md"), VALID_RESEARCHER);
    loadRoles(tempDir);

    const roles = listRoles();
    expect(roles).toHaveLength(2);
    expect(roles).toContain("dev");
    expect(roles).toContain("researcher");
  });
});

// ── listRoleConfigs ──────────────────────────────────────────────────────────

describe("listRoleConfigs", () => {
  it("returns full config objects", () => {
    writeFileSync(join(tempDir, "dev.md"), VALID_DEV);
    loadRoles(tempDir);

    const configs = listRoleConfigs();
    expect(configs).toHaveLength(1);
    expect(configs[0].role).toBe("dev");
    expect(configs[0].schema).toBeDefined();
  });
});

// ── roleCount / hasRole ──────────────────────────────────────────────────────

describe("roleCount", () => {
  it("returns 0 when empty", () => {
    expect(roleCount()).toBe(0);
  });

  it("returns correct count", () => {
    writeFileSync(join(tempDir, "dev.md"), VALID_DEV);
    writeFileSync(join(tempDir, "researcher.md"), VALID_RESEARCHER);
    loadRoles(tempDir);
    expect(roleCount()).toBe(2);
  });
});

describe("hasRole", () => {
  it("returns false for unknown", () => {
    expect(hasRole("dev")).toBe(false);
  });

  it("returns true for loaded (case-insensitive)", () => {
    writeFileSync(join(tempDir, "dev.md"), VALID_DEV);
    loadRoles(tempDir);
    expect(hasRole("dev")).toBe(true);
    expect(hasRole("DEV")).toBe(true);
  });
});

// ── reloadRole ───────────────────────────────────────────────────────────────

describe("reloadRole", () => {
  it("reloads an existing role", () => {
    const filePath = join(tempDir, "dev.md");
    writeFileSync(filePath, VALID_DEV);
    loadRoles(tempDir);

    const updated = VALID_DEV.replace("Build, fix, and maintain code", "Updated purpose");
    writeFileSync(filePath, updated);

    const reloaded = reloadRole("dev");
    expect(reloaded).not.toBeNull();
    expect(reloaded!.schema.frontmatter.purpose).toBe("Updated purpose");
  });

  it("returns null for unknown role", () => {
    expect(reloadRole("unknown")).toBeNull();
  });
});

// ── reloadFromPath ───────────────────────────────────────────────────────────

describe("reloadFromPath", () => {
  it("loads a new file by path", () => {
    const filePath = join(tempDir, "researcher.md");
    writeFileSync(filePath, VALID_RESEARCHER);

    const config = reloadFromPath(filePath);
    expect(config).not.toBeNull();
    expect(config!.role).toBe("researcher");
    expect(getRole("researcher")).not.toBeNull();
  });

  it("replaces existing entry", () => {
    const filePath = join(tempDir, "dev.md");
    writeFileSync(filePath, VALID_DEV);
    loadRoles(tempDir);

    const updated = VALID_DEV.replace("Build, fix, and maintain code", "New purpose");
    writeFileSync(filePath, updated);

    const config = reloadFromPath(filePath);
    expect(config!.schema.frontmatter.purpose).toBe("New purpose");
  });

  it("returns null for unparseable file", () => {
    const filePath = join(tempDir, "bad.md");
    writeFileSync(filePath, MALFORMED_NO_FRONTMATTER);
    expect(reloadFromPath(filePath)).toBeNull();
  });
});

// ── removeByPath ─────────────────────────────────────────────────────────────

describe("removeByPath", () => {
  it("removes a role by file path", () => {
    const filePath = join(tempDir, "dev.md");
    writeFileSync(filePath, VALID_DEV);
    loadRoles(tempDir);

    expect(hasRole("dev")).toBe(true);
    const removed = removeByPath(filePath);
    expect(removed).toBe("dev");
    expect(hasRole("dev")).toBe(false);
  });

  it("returns null for unknown path", () => {
    expect(removeByPath("/unknown/path.md")).toBeNull();
  });
});

// ── _injectRoleForTesting ────────────────────────────────────────────────────

describe("_injectRoleForTesting", () => {
  it("injects role into cache", () => {
    const config: RoleConfig = {
      role: "test-role",
      schema: {
        frontmatter: { role: "test-role", purpose: "test" },
        sections: [
          { heading: "Capabilities", content: "Test" },
          { heading: "Context Requirements", content: "Test" },
          { heading: "Tool Categories", content: "Test" },
          { heading: "Communication Contract", content: "Test" },
          { heading: "Anti-Patterns", content: "Test" },
        ],
        body: "test body",
      },
      validation: { valid: true, errors: [] },
      filePath: "/test/path.md",
      loadedAt: new Date().toISOString(),
    };

    _injectRoleForTesting(config);
    expect(getRole("test-role")).not.toBeNull();
    expect(getRole("test-role")!.role).toBe("test-role");
  });
});

// ── Watcher ──────────────────────────────────────────────────────────────────

describe("watcher", () => {
  it("starts and stops", () => {
    expect(isWatching()).toBe(false);
    expect(startWatcher(tempDir)).toBe(true);
    expect(isWatching()).toBe(true);
    stopWatcher();
    expect(isWatching()).toBe(false);
  });

  it("returns false for non-existent directory", () => {
    expect(startWatcher("/nonexistent")).toBe(false);
  });

  it("returns false if already watching", () => {
    startWatcher(tempDir);
    expect(startWatcher(tempDir)).toBe(false);
    stopWatcher();
  });

  it("stopWatcher is safe when not watching", () => {
    stopWatcher();
    expect(isWatching()).toBe(false);
  });
});

// ── Full scenarios ───────────────────────────────────────────────────────────

describe("full scenarios", () => {
  it("load all -> query -> reload -> remove", () => {
    writeFileSync(join(tempDir, "dev.md"), VALID_DEV);
    writeFileSync(join(tempDir, "researcher.md"), VALID_RESEARCHER);

    const loadResult = loadRoles(tempDir);
    expect(loadResult.loaded).toBe(2);
    expect(roleCount()).toBe(2);

    const dev = getRole("dev");
    expect(dev).not.toBeNull();
    expect(dev!.schema.frontmatter.role).toBe("dev");

    // Reload with changes
    const updated = VALID_DEV.replace("Build, fix, and maintain code", "Revised purpose");
    writeFileSync(join(tempDir, "dev.md"), updated);
    const reloaded = reloadRole("dev");
    expect(reloaded!.schema.frontmatter.purpose).toBe("Revised purpose");

    // Remove
    const removed = removeByPath(join(tempDir, "researcher.md"));
    expect(removed).toBe("researcher");
    expect(roleCount()).toBe(1);
    expect(hasRole("researcher")).toBe(false);
    expect(hasRole("dev")).toBe(true);
  });

  it("mixed valid and invalid files", () => {
    writeFileSync(join(tempDir, "dev.md"), VALID_DEV);
    writeFileSync(join(tempDir, "bad1.md"), MALFORMED_NO_ROLE);
    writeFileSync(join(tempDir, "bad2.md"), MALFORMED_NO_FRONTMATTER);
    writeFileSync(join(tempDir, "researcher.md"), VALID_RESEARCHER);

    const result = loadRoles(tempDir);
    expect(result.loaded).toBe(2);
    expect(result.failed).toBe(2);
    expect(roleCount()).toBe(2);
    expect(listRoles()).toContain("dev");
    expect(listRoles()).toContain("researcher");
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("loading same directory twice overwrites cache", () => {
    writeFileSync(join(tempDir, "dev.md"), VALID_DEV);
    loadRoles(tempDir);
    loadRoles(tempDir);
    expect(roleCount()).toBe(1);
  });

  it("role name from frontmatter takes precedence over filename", () => {
    writeFileSync(join(tempDir, "custom.md"), VALID_DEV);
    loadRoles(tempDir);
    expect(hasRole("dev")).toBe(true);
    expect(hasRole("custom")).toBe(false);
  });

  it("watcher callback fires on reloadFromPath", () => {
    const events: Array<{ event: string; role: string }> = [];
    const filePath = join(tempDir, "dev.md");
    writeFileSync(filePath, VALID_DEV);

    startWatcher(tempDir, (event, role) => {
      events.push({ event, role });
    });

    reloadFromPath(filePath);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ event: "loaded", role: "dev" });

    stopWatcher();
  });

  it("watcher callback fires on removeByPath", () => {
    const events: Array<{ event: string; role: string }> = [];
    const filePath = join(tempDir, "dev.md");
    writeFileSync(filePath, VALID_DEV);
    loadRoles(tempDir);

    startWatcher(tempDir, (event, role) => {
      events.push({ event, role });
    });

    removeByPath(filePath);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ event: "removed", role: "dev" });

    stopWatcher();
  });
});
