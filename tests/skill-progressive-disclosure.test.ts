import { describe, it, expect } from "bun:test";
import {
  extractMetadata,
  formatMetadataSection,
  classifySkills,
  type SkillMetadata,
} from "../src/skills/metadata.ts";

describe("ELLIE-1078: Progressive skill disclosure", () => {
  const mockFrontmatter = {
    name: "github",
    description: "GitHub integration for PRs, issues, and code review",
    triggers: ["create pr", "list issues", "review"],
    always: false,
  };

  describe("extractMetadata", () => {
    it("extracts name and description", () => {
      const meta = extractMetadata(mockFrontmatter, "Full content here...");
      expect(meta.name).toBe("github");
      expect(meta.description).toContain("GitHub");
    });

    it("extracts triggers array", () => {
      const meta = extractMetadata(mockFrontmatter, "content");
      expect(meta.triggers).toContain("create pr");
    });

    it("tracks full content token count", () => {
      const meta = extractMetadata(mockFrontmatter, "word ".repeat(500));
      expect(meta.tokens).toBeGreaterThan(100);
    });

    it("handles missing fields gracefully", () => {
      const meta = extractMetadata({}, "content");
      expect(meta.name).toBe("unknown");
      expect(meta.description).toBe("");
      expect(meta.triggers).toEqual([]);
    });
  });

  describe("formatMetadataSection", () => {
    it("formats skills as compact list", () => {
      const skills: SkillMetadata[] = [
        { name: "github", description: "GitHub integration", triggers: ["create pr"], alwaysOn: false, tokens: 2000 },
        { name: "plane", description: "Plane project management", triggers: ["list issues"], alwaysOn: false, tokens: 1500 },
      ];
      const section = formatMetadataSection(skills);
      expect(section).toContain("Available skills");
      expect(section).toContain("github");
      expect(section).toContain("plane");
      expect(section).toContain("create pr");
    });

    it("returns empty string for no skills", () => {
      expect(formatMetadataSection([])).toBe("");
    });
  });

  describe("classifySkills", () => {
    const skills = [
      {
        metadata: { name: "briefing", description: "Daily briefing", triggers: ["briefing"], alwaysOn: true, tokens: 3000 },
        fullContent: "Full briefing skill content...",
      },
      {
        metadata: { name: "github", description: "GitHub", triggers: ["create pr", "github"], alwaysOn: false, tokens: 2000 },
        fullContent: "Full github skill content...",
      },
      {
        metadata: { name: "miro", description: "Miro boards", triggers: ["create board"], alwaysOn: false, tokens: 1500 },
        fullContent: "Full miro skill content...",
      },
    ];

    it("always-on skills get full content", () => {
      const result = classifySkills(skills);
      expect(result.fullContent.length).toBe(1); // briefing
      expect(result.metadataOnly.length).toBe(2); // github, miro
    });

    it("triggered skills get full content", () => {
      const result = classifySkills(skills, { message: "can you create pr for this" });
      expect(result.fullContent.length).toBe(2); // briefing + github
      expect(result.metadataOnly.length).toBe(1); // miro
    });

    it("explicitly invoked skills get full content", () => {
      const result = classifySkills(skills, { invokedSkillNames: ["miro"] });
      expect(result.fullContent.length).toBe(2); // briefing + miro
    });

    it("tracks tokens saved", () => {
      const result = classifySkills(skills);
      expect(result.tokensSaved).toBe(2000 + 1500); // github + miro not loaded
    });

    it("handles empty skills array", () => {
      const result = classifySkills([]);
      expect(result.metadataOnly).toEqual([]);
      expect(result.fullContent).toEqual([]);
      expect(result.tokensSaved).toBe(0);
    });
  });
});
