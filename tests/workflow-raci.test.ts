/**
 * ELLIE-835: RAPID-RACI role matrix tests
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  parseRaciMatrix,
  getAgentRole,
  getDecider,
  getPerformers,
  getRecommender,
  getEscalationTarget,
  validateMatrix,
  _injectMatrixForTesting,
  type RaciMatrix,
} from "../src/workflow-raci.ts";

const SAMPLE_CONFIG = `
# Test RACI Matrix
workflow: research
  research: R, P
  strategy: A
  critic: I
  Dave: D

workflow: code_review
  dev: P
  critic: R, P
  Dave: D
`;

describe("ELLIE-835: RAPID-RACI role matrix", () => {

  describe("parseRaciMatrix", () => {
    it("parses workflow definitions", () => {
      const matrix = parseRaciMatrix(SAMPLE_CONFIG);
      expect(matrix.workflows.length).toBe(2);
      expect(matrix.workflows[0].workflow).toBe("research");
      expect(matrix.workflows[1].workflow).toBe("code_review");
    });

    it("parses multi-role assignments (R, P)", () => {
      const matrix = parseRaciMatrix(SAMPLE_CONFIG);
      const researchRoles = matrix.workflows[0].roles.filter(r => r.agent === "research");
      expect(researchRoles.length).toBe(2);
      expect(researchRoles.map(r => r.role)).toContain("R");
      expect(researchRoles.map(r => r.role)).toContain("P");
    });

    it("handles empty input", () => {
      const matrix = parseRaciMatrix("");
      expect(matrix.workflows.length).toBe(0);
    });

    it("ignores comments", () => {
      const matrix = parseRaciMatrix("# comment\nworkflow: test\n  dev: P\n  Dave: D");
      expect(matrix.workflows.length).toBe(1);
    });
  });

  describe("getAgentRole", () => {
    const matrix = parseRaciMatrix(SAMPLE_CONFIG);

    it("returns roles for a known agent in a known workflow", () => {
      const roles = getAgentRole(matrix, "research", "research");
      expect(roles).toContain("R");
      expect(roles).toContain("P");
    });

    it("returns empty array for unknown agent", () => {
      expect(getAgentRole(matrix, "research", "unknown")).toEqual([]);
    });

    it("returns empty array for unknown workflow", () => {
      expect(getAgentRole(matrix, "unknown_wf", "dev")).toEqual([]);
    });
  });

  describe("getDecider", () => {
    const matrix = parseRaciMatrix(SAMPLE_CONFIG);

    it("returns Dave as decider", () => {
      expect(getDecider(matrix, "research")).toBe("Dave");
      expect(getDecider(matrix, "code_review")).toBe("Dave");
    });

    it("returns null for unknown workflow", () => {
      expect(getDecider(matrix, "nonexistent")).toBeNull();
    });
  });

  describe("getPerformers", () => {
    const matrix = parseRaciMatrix(SAMPLE_CONFIG);

    it("returns performers for research workflow", () => {
      expect(getPerformers(matrix, "research")).toEqual(["research"]);
    });

    it("returns multiple performers for code_review", () => {
      const performers = getPerformers(matrix, "code_review");
      expect(performers).toContain("dev");
      expect(performers).toContain("critic");
    });
  });

  describe("getRecommender", () => {
    const matrix = parseRaciMatrix(SAMPLE_CONFIG);

    it("returns recommender for research workflow", () => {
      expect(getRecommender(matrix, "research")).toBe("research");
    });

    it("returns recommender for code_review", () => {
      expect(getRecommender(matrix, "code_review")).toBe("critic");
    });
  });

  describe("getEscalationTarget", () => {
    const matrix = parseRaciMatrix(SAMPLE_CONFIG);

    it("returns decider as escalation target", () => {
      expect(getEscalationTarget(matrix, "research")).toBe("Dave");
    });

    it("defaults to Dave for unknown workflow", () => {
      expect(getEscalationTarget(matrix, "nonexistent")).toBe("Dave");
    });
  });

  describe("validateMatrix", () => {
    it("validates a correct matrix", () => {
      const matrix = parseRaciMatrix(SAMPLE_CONFIG);
      const result = validateMatrix(matrix);
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    it("detects missing decider", () => {
      const matrix: RaciMatrix = {
        workflows: [{ workflow: "test", roles: [{ agent: "dev", role: "P" }] }],
      };
      const result = validateMatrix(matrix);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("no Decider"))).toBe(true);
    });

    it("detects missing performer", () => {
      const matrix: RaciMatrix = {
        workflows: [{ workflow: "test", roles: [{ agent: "Dave", role: "D" }] }],
      };
      const result = validateMatrix(matrix);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("no Performer"))).toBe(true);
    });

    it("detects multiple deciders", () => {
      const matrix: RaciMatrix = {
        workflows: [{
          workflow: "test",
          roles: [
            { agent: "Dave", role: "D" },
            { agent: "Ellie", role: "D" },
            { agent: "dev", role: "P" },
          ],
        }],
      };
      const result = validateMatrix(matrix);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("multiple Deciders"))).toBe(true);
    });
  });
});
