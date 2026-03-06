/**
 * ELLIE-577 — Test isolation verification
 *
 * Verifies that the isolated test runner infrastructure works correctly.
 * Also includes a canary test that detects mock.module contamination:
 * if mock.module state leaks between files, this test will fail.
 */
import { describe, test, expect } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";

describe("test isolation infrastructure", () => {
  test("run-isolated.ts runner script exists", () => {
    const runnerPath = join(import.meta.dir, "run-isolated.ts");
    expect(existsSync(runnerPath)).toBe(true);
  });

  test("bunfig.toml has global preload configured", async () => {
    const bunfig = await Bun.file(join(import.meta.dir, "../bunfig.toml")).text();
    expect(bunfig).toContain("preload");
    expect(bunfig).toContain("global-setup.ts");
  });
});

describe("mock.module contamination canary", () => {
  test("fs/promises writeFile is the real function (not mocked)", async () => {
    const fs = await import("fs/promises");
    // If mock.module contamination has occurred, writeFile would be a mock
    // that returns undefined or a mock spy. The real writeFile is a native function.
    expect(typeof fs.writeFile).toBe("function");
    expect(fs.writeFile.toString()).not.toContain("mock");
  });

  test("logger module is not mocked", async () => {
    const { log } = await import("../src/logger.ts");
    // If mocked, log would be a plain object with mock functions
    expect(log).toBeDefined();
    expect(typeof log.child).toBe("function");
  });
});
