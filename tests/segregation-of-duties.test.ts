import { describe, it, expect } from "bun:test";
import { checkSOD, getAllowedRoles, canPerformRole, CONFLICT_MATRIX, ARCHETYPE_ROLES } from "../src/segregation-of-duties.ts";

describe("ELLIE-1076: Segregation of duties", () => {
  describe("checkSOD", () => {
    it("allows different creatures for maker and reviewer", () => {
      const result = checkSOD({
        creature: "brian",
        role: "reviewer",
        workItemId: "ELLIE-100",
        priorActors: [{ creature: "james", role: "maker" }],
      });
      expect(result.allowed).toBe(true);
    });

    it("blocks same creature as maker and reviewer", () => {
      const result = checkSOD({
        creature: "james",
        role: "reviewer",
        workItemId: "ELLIE-100",
        priorActors: [{ creature: "james", role: "maker" }],
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("cannot be both");
    });

    it("blocks same creature as maker and approver", () => {
      const result = checkSOD({
        creature: "james",
        role: "approver",
        workItemId: "ELLIE-100",
        priorActors: [{ creature: "james", role: "maker" }],
      });
      expect(result.allowed).toBe(false);
    });

    it("allows when no prior actors", () => {
      const result = checkSOD({
        creature: "james",
        role: "maker",
        workItemId: "ELLIE-100",
        priorActors: [],
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe("getAllowedRoles", () => {
    it("dev is a maker", () => {
      expect(getAllowedRoles("dev")).toContain("maker");
    });

    it("critic is a reviewer", () => {
      expect(getAllowedRoles("critic")).toContain("reviewer");
    });

    it("general is an approver", () => {
      expect(getAllowedRoles("general")).toContain("approver");
    });
  });

  describe("canPerformRole", () => {
    it("dev can make but not review", () => {
      expect(canPerformRole("dev", "maker")).toBe(true);
      expect(canPerformRole("dev", "reviewer")).toBe(false);
    });

    it("critic can review but not make", () => {
      expect(canPerformRole("critic", "reviewer")).toBe(true);
      expect(canPerformRole("critic", "maker")).toBe(false);
    });
  });

  describe("conflict matrix", () => {
    it("has 4 conflict pairs", () => {
      expect(CONFLICT_MATRIX.length).toBe(4);
    });
  });
});
