import { describe, it, expect } from "bun:test";
import {
  getTemplate,
  getTemplateByContentType,
  getAllTemplates,
  getTemplateIds,
  renderTemplate,
  renderFrontmatter,
  renderBody,
  getGuidedQuestions,
  selectTemplate,
  type RiverTemplate,
} from "../src/capture/template-library.ts";

describe("ELLIE-781: River content template library", () => {
  describe("template registry", () => {
    it("has all 7 template types", () => {
      const ids = getTemplateIds();
      expect(ids).toContain("workflow");
      expect(ids).toContain("decision");
      expect(ids).toContain("process");
      expect(ids).toContain("policy");
      expect(ids).toContain("integration");
      expect(ids).toContain("reference");
      expect(ids).toContain("agent_prompt");
      expect(ids).toHaveLength(7);
    });

    it("getAllTemplates returns copies", () => {
      const a = getAllTemplates();
      const b = getAllTemplates();
      expect(a).toEqual(b);
      a.push({} as any);
      expect(getAllTemplates()).toHaveLength(7);
    });
  });

  describe("getTemplate", () => {
    it("returns template by id", () => {
      const t = getTemplate("workflow");
      expect(t).not.toBeNull();
      expect(t!.id).toBe("workflow");
      expect(t!.name).toBe("Workflow");
    });

    it("returns null for unknown id", () => {
      expect(getTemplate("nonexistent")).toBeNull();
    });
  });

  describe("getTemplateByContentType", () => {
    it("finds template for each content type", () => {
      for (const type of ["workflow", "decision", "process", "policy", "integration", "reference"] as const) {
        const t = getTemplateByContentType(type);
        expect(t).not.toBeNull();
      }
    });

    it("finds agent_prompt template", () => {
      const t = getTemplateByContentType("agent_prompt");
      expect(t).not.toBeNull();
      expect(t!.id).toBe("agent_prompt");
    });
  });

  describe("template structure", () => {
    it("every template has required fields", () => {
      for (const t of getAllTemplates()) {
        expect(t.id).toBeTruthy();
        expect(t.name).toBeTruthy();
        expect(t.content_type).toBeTruthy();
        expect(t.description).toBeTruthy();
        expect(t.sections.length).toBeGreaterThanOrEqual(3);
        expect(Object.keys(t.frontmatter_fields).length).toBeGreaterThan(0);
      }
    });

    it("every template has at least 2 required sections", () => {
      for (const t of getAllTemplates()) {
        const required = t.sections.filter(s => s.required);
        expect(required.length).toBeGreaterThanOrEqual(2);
      }
    });

    it("every section has a guide question", () => {
      for (const t of getAllTemplates()) {
        for (const s of t.sections) {
          expect(s.heading).toBeTruthy();
          expect(s.guide).toBeTruthy();
          expect(s.guide).toContain("?");
        }
      }
    });

    it("workflow has expected sections", () => {
      const t = getTemplate("workflow")!;
      const headings = t.sections.map(s => s.heading);
      expect(headings).toContain("Trigger");
      expect(headings).toContain("Steps");
      expect(headings).toContain("Outcomes");
      expect(headings).toContain("Edge Cases");
      expect(headings).toContain("Owner");
    });

    it("decision has expected sections", () => {
      const t = getTemplate("decision")!;
      const headings = t.sections.map(s => s.heading);
      expect(headings).toContain("Context");
      expect(headings).toContain("Options Considered");
      expect(headings).toContain("Decision");
      expect(headings).toContain("Reasoning");
      expect(headings).toContain("Consequences");
    });

    it("policy has expected sections", () => {
      const t = getTemplate("policy")!;
      const headings = t.sections.map(s => s.heading);
      expect(headings).toContain("Rule");
      expect(headings).toContain("Scope");
      expect(headings).toContain("Exceptions");
      expect(headings).toContain("Enforcement");
    });

    it("integration has expected sections", () => {
      const t = getTemplate("integration")!;
      const headings = t.sections.map(s => s.heading);
      expect(headings).toContain("Systems");
      expect(headings).toContain("Protocol");
      expect(headings).toContain("Data Format");
      expect(headings).toContain("Authentication");
      expect(headings).toContain("Error Handling");
    });
  });

  describe("renderTemplate", () => {
    it("renders complete markdown with frontmatter and body", () => {
      const t = getTemplate("workflow")!;
      const md = renderTemplate(t, { title: "Deploy to Prod" });
      expect(md).toContain("---");
      expect(md).toContain("title: Deploy to Prod");
      expect(md).toContain("type: workflow");
      expect(md).toContain("# Deploy to Prod");
      expect(md).toContain("## Trigger");
      expect(md).toContain("## Steps");
    });

    it("includes section content when provided", () => {
      const t = getTemplate("decision")!;
      const md = renderTemplate(t, {
        title: "Pick DB",
        context: "We needed a database for the new service.",
        decision: "Use Postgres.",
      });
      expect(md).toContain("We needed a database");
      expect(md).toContain("Use Postgres.");
    });

    it("includes guide comments for empty sections", () => {
      const t = getTemplate("reference")!;
      const md = renderTemplate(t);
      expect(md).toContain("<!-- ");
      expect(md).toContain("?");
    });
  });

  describe("renderFrontmatter", () => {
    it("includes title and type", () => {
      const t = getTemplate("policy")!;
      const fm = renderFrontmatter(t, { title: "No Deployments Friday" });
      expect(fm).toContain("title: No Deployments Friday");
      expect(fm).toContain("type: policy");
    });

    it("includes created date", () => {
      const t = getTemplate("reference")!;
      const fm = renderFrontmatter(t);
      expect(fm).toMatch(/created: \d{4}-\d{2}-\d{2}/);
    });

    it("allows overriding fields", () => {
      const t = getTemplate("process")!;
      const fm = renderFrontmatter(t, { owner: "Dave", frequency: "weekly" });
      expect(fm).toContain("owner: Dave");
      expect(fm).toContain("frequency: weekly");
    });
  });

  describe("renderBody", () => {
    it("renders all sections with headings", () => {
      const t = getTemplate("integration")!;
      const body = renderBody(t);
      expect(body).toContain("## Systems");
      expect(body).toContain("## Protocol");
      expect(body).toContain("## Authentication");
    });
  });

  describe("getGuidedQuestions", () => {
    it("returns questions for valid template", () => {
      const qs = getGuidedQuestions("workflow");
      expect(qs.length).toBeGreaterThanOrEqual(3);
      expect(qs[0].heading).toBe("Trigger");
      expect(qs[0].question).toContain("?");
      expect(qs[0].required).toBe(true);
    });

    it("returns empty for unknown template", () => {
      expect(getGuidedQuestions("nonexistent")).toEqual([]);
    });

    it("marks required vs optional correctly", () => {
      const qs = getGuidedQuestions("decision");
      const required = qs.filter(q => q.required);
      const optional = qs.filter(q => !q.required);
      expect(required.length).toBeGreaterThan(0);
      expect(optional.length).toBeGreaterThan(0);
    });
  });

  describe("selectTemplate", () => {
    it("selects by content type", () => {
      expect(selectTemplate("workflow").id).toBe("workflow");
      expect(selectTemplate("decision").id).toBe("decision");
      expect(selectTemplate("policy").id).toBe("policy");
    });

    it("prefers hint over content type", () => {
      expect(selectTemplate("reference", "agent_prompt").id).toBe("agent_prompt");
    });

    it("falls back to reference for unknown", () => {
      expect(selectTemplate("reference").id).toBe("reference");
    });

    it("ignores invalid hint", () => {
      expect(selectTemplate("workflow", "nonexistent").id).toBe("workflow");
    });
  });
});
