/**
 * Tests for Bindings Config File Loading — ELLIE-620
 *
 * Covers: loadBindingsFromFile(), startBindingsWatcher(), stopBindingsWatcher(),
 * identity-startup integration with file-based bindings.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  loadBindingsFromFile,
  loadDefaultBindings,
  startBindingsWatcher,
  stopBindingsWatcher,
  getBinding,
  listBindings,
  DEFAULT_BINDINGS,
  DEFAULT_BINDINGS_PATH,
  _resetBindingsForTesting,
} from "../src/agent-identity-binding";

// ── Helpers ──────────────────────────────────────────────────────────────────

let tempDir: string;

function writeTempBindings(bindings: unknown): string {
  const path = join(tempDir, "bindings.json");
  writeFileSync(path, JSON.stringify(bindings, null, 2));
  return path;
}

beforeEach(() => {
  _resetBindingsForTesting();
  tempDir = mkdtempSync(join(tmpdir(), "ellie-bindings-test-"));
});

afterEach(() => {
  _resetBindingsForTesting();
  try {
    rmSync(tempDir, { recursive: true });
  } catch {
    // ignore cleanup errors
  }
});

// ── loadBindingsFromFile ─────────────────────────────────────────────────────

describe("loadBindingsFromFile", () => {
  it("loads valid bindings from a JSON file", () => {
    const bindings = [
      { agentName: "dev", archetype: "ant", role: "dev" },
      { agentName: "research", archetype: "owl", role: "researcher" },
    ];
    const path = writeTempBindings(bindings);

    const result = loadBindingsFromFile(path);
    expect(result.loaded).toBe(2);
    expect(result.error).toBeUndefined();

    expect(getBinding("dev")).not.toBeNull();
    expect(getBinding("dev")!.archetype).toBe("ant");
    expect(getBinding("research")).not.toBeNull();
    expect(getBinding("research")!.role).toBe("researcher");
  });

  it("returns error when file does not exist", () => {
    const result = loadBindingsFromFile("/tmp/nonexistent-bindings-9999.json");
    expect(result.loaded).toBe(0);
    expect(result.error).toContain("not found");
  });

  it("returns error for invalid JSON", () => {
    const path = join(tempDir, "bindings.json");
    writeFileSync(path, "{ not valid json ]");

    const result = loadBindingsFromFile(path);
    expect(result.loaded).toBe(0);
    expect(result.error).toContain("Invalid JSON");
  });

  it("returns error when JSON is not an array", () => {
    const path = writeTempBindings({ agentName: "dev", archetype: "ant", role: "dev" });

    const result = loadBindingsFromFile(path);
    expect(result.loaded).toBe(0);
    expect(result.error).toContain("JSON array");
  });

  it("skips entries with missing required fields", () => {
    const bindings = [
      { agentName: "dev", archetype: "ant", role: "dev" },
      { agentName: "bad-1", archetype: "ant" }, // missing role
      { agentName: "bad-2", role: "dev" },       // missing archetype
      { archetype: "ant", role: "dev" },          // missing agentName
      null,
      42,
      "string",
    ];
    const path = writeTempBindings(bindings);

    const result = loadBindingsFromFile(path);
    expect(result.loaded).toBe(1);
    expect(getBinding("dev")).not.toBeNull();
    expect(getBinding("bad-1")).toBeNull();
  });

  it("normalizes agent names to lowercase", () => {
    const path = writeTempBindings([
      { agentName: "Dev", archetype: "Ant", role: "Dev" },
    ]);

    loadBindingsFromFile(path);
    expect(getBinding("dev")).not.toBeNull();
    expect(getBinding("dev")!.archetype).toBe("ant");
  });

  it("loads all 8 default bindings from real config file", () => {
    const result = loadBindingsFromFile(DEFAULT_BINDINGS_PATH);
    expect(result.loaded).toBe(8);
    expect(result.error).toBeUndefined();

    // Verify all default agents are present
    for (const binding of DEFAULT_BINDINGS) {
      const loaded = getBinding(binding.agentName);
      expect(loaded).not.toBeNull();
      expect(loaded!.archetype).toBe(binding.archetype);
      expect(loaded!.role).toBe(binding.role);
    }
  });

  it("handles empty array", () => {
    const path = writeTempBindings([]);

    const result = loadBindingsFromFile(path);
    expect(result.loaded).toBe(0);
    expect(result.error).toBeUndefined();
    expect(listBindings()).toHaveLength(0);
  });

  it("overwrites existing bindings on reload", () => {
    // Load initial
    loadBindingsFromFile(writeTempBindings([
      { agentName: "dev", archetype: "ant", role: "dev" },
    ]));
    expect(getBinding("dev")!.archetype).toBe("ant");

    // Reload with different config
    _resetBindingsForTesting();
    loadBindingsFromFile(writeTempBindings([
      { agentName: "dev", archetype: "owl", role: "researcher" },
    ]));
    expect(getBinding("dev")!.archetype).toBe("owl");
    expect(getBinding("dev")!.role).toBe("researcher");
  });
});

// ── Watcher ──────────────────────────────────────────────────────────────────

describe("startBindingsWatcher / stopBindingsWatcher", () => {
  it("returns false when file does not exist", () => {
    const started = startBindingsWatcher("/tmp/nonexistent-9999.json");
    expect(started).toBe(false);
  });

  it("returns true when file exists", () => {
    const path = writeTempBindings([
      { agentName: "dev", archetype: "ant", role: "dev" },
    ]);

    const started = startBindingsWatcher(path);
    expect(started).toBe(true);
    stopBindingsWatcher();
  });

  it("returns false if already watching", () => {
    const path = writeTempBindings([
      { agentName: "dev", archetype: "ant", role: "dev" },
    ]);

    expect(startBindingsWatcher(path)).toBe(true);
    expect(startBindingsWatcher(path)).toBe(false);
    stopBindingsWatcher();
  });

  it("stopBindingsWatcher is safe to call when not watching", () => {
    // Should not throw
    stopBindingsWatcher();
  });
});

// ── Fallback behavior ────────────────────────────────────────────────────────

describe("file loading with fallback to defaults", () => {
  it("loadDefaultBindings fills in when file is missing", () => {
    const fileResult = loadBindingsFromFile("/tmp/nonexistent-9999.json");
    expect(fileResult.loaded).toBe(0);

    const defaultsLoaded = loadDefaultBindings();
    expect(defaultsLoaded).toBe(8);
    expect(listBindings()).toHaveLength(8);
  });

  it("file bindings take priority — loadDefaultBindings won't overwrite", () => {
    // Load from file with a custom archetype for dev
    loadBindingsFromFile(writeTempBindings([
      { agentName: "dev", archetype: "owl", role: "researcher" },
    ]));

    // loadDefaultBindings should NOT overwrite the file-loaded dev binding
    const defaultsLoaded = loadDefaultBindings();
    expect(getBinding("dev")!.archetype).toBe("owl");
    // But should add the other 7
    expect(defaultsLoaded).toBe(7);
    expect(listBindings()).toHaveLength(8);
  });
});

// ── DEFAULT_BINDINGS_PATH constant ───────────────────────────────────────────

describe("DEFAULT_BINDINGS_PATH", () => {
  it("points to config/bindings.json", () => {
    expect(DEFAULT_BINDINGS_PATH).toBe(join("config", "bindings.json"));
  });
});
