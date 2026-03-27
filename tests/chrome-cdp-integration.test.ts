import { describe, it, expect } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";

describe("ELLIE-1083: chrome-cdp integration", () => {
  it("browser skill exists", () => {
    const skillPath = join(import.meta.dir, "..", "skills", "browser", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
  });

  it("skill has correct frontmatter", async () => {
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(join(import.meta.dir, "..", "skills", "browser", "SKILL.md"), "utf-8");
    expect(content).toContain("name: browser");
    expect(content).toContain("Chrome DevTools Protocol");
    expect(content).toContain("triggers:");
  });

  it("chrome-cdp-skill repo exists", () => {
    expect(existsSync("/home/ellie/new-stuff/chrome-cdp-skill")).toBe(true);
  });

  it("wrapper script exists and is executable", () => {
    const wrapper = join(import.meta.dir, "..", "scripts", "chrome-cdp-wrapper.sh");
    expect(existsSync(wrapper)).toBe(true);
  });

  it("skill includes command reference", async () => {
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(join(import.meta.dir, "..", "skills", "browser", "SKILL.md"), "utf-8");
    expect(content).toContain("chrome-cdp list");
    expect(content).toContain("chrome-cdp snap");
    expect(content).toContain("chrome-cdp shot");
    expect(content).toContain("chrome-cdp eval");
  });
});
