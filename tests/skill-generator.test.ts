import { describe, it, expect } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";

describe("ELLIE-1063: Skill generator", () => {
  it("script exists", () => {
    expect(existsSync(join(import.meta.dir, "..", "scripts", "generate-skills.ts"))).toBe(true);
  });

  it("skills directory exists", () => {
    expect(existsSync(join(import.meta.dir, "..", "skills"))).toBe(true);
  });

  it("has hand-written skills that should not be overwritten", () => {
    const handWritten = ["briefing", "forest", "github", "google-workspace", "memory", "plane"];
    for (const name of handWritten) {
      const path = join(import.meta.dir, "..", "skills", name, "SKILL.md");
      if (existsSync(path)) {
        const { readFileSync } = require("fs");
        const content = readFileSync(path, "utf-8");
        expect(content).not.toContain("AUTO-GENERATED");
      }
    }
  });
});
