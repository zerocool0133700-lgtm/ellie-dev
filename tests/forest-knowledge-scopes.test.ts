/**
 * Forest Module Tests: Knowledge Scopes — ELLIE-712
 *
 * Tests pure path functions (getAncestorPaths, isAncestor) and scope interface.
 */

// Force test database for any DB operations
process.env.DB_NAME = "ellie-forest-test";

import { describe, test, expect } from "bun:test";
import {
  getAncestorPaths,
  isAncestor,
} from "../../ellie-forest/src/knowledge-scopes.ts";

describe("knowledge-scopes", () => {
  // ── getAncestorPaths ─────────────────────────────────────

  describe("getAncestorPaths", () => {
    test("returns single path for root level", () => {
      expect(getAncestorPaths("1")).toEqual(["1"]);
    });

    test("returns path chain for 2 levels", () => {
      expect(getAncestorPaths("1/2")).toEqual(["1", "1/2"]);
    });

    test("returns full chain for 3 levels", () => {
      expect(getAncestorPaths("1/2/3")).toEqual(["1", "1/2", "1/2/3"]);
    });

    test("returns full chain for deep path", () => {
      const result = getAncestorPaths("2/1/3/5/7");
      expect(result).toEqual(["2", "2/1", "2/1/3", "2/1/3/5", "2/1/3/5/7"]);
    });

    test("handles numeric segments correctly", () => {
      expect(getAncestorPaths("10/20/30")).toEqual(["10", "10/20", "10/20/30"]);
    });

    test("self is always the last element", () => {
      const paths = getAncestorPaths("2/1/3");
      expect(paths[paths.length - 1]).toBe("2/1/3");
    });

    test("length equals number of segments", () => {
      expect(getAncestorPaths("1/2/3/4/5")).toHaveLength(5);
    });
  });

  // ── isAncestor ───────────────────────────────────────────

  describe("isAncestor", () => {
    test("path is ancestor of itself", () => {
      expect(isAncestor("1", "1")).toBe(true);
      expect(isAncestor("2/1", "2/1")).toBe(true);
    });

    test("parent is ancestor of child", () => {
      expect(isAncestor("1", "1/2")).toBe(true);
      expect(isAncestor("2/1", "2/1/3")).toBe(true);
    });

    test("grandparent is ancestor of grandchild", () => {
      expect(isAncestor("1", "1/2/3")).toBe(true);
    });

    test("child is NOT ancestor of parent", () => {
      expect(isAncestor("1/2", "1")).toBe(false);
    });

    test("sibling is NOT ancestor", () => {
      expect(isAncestor("1/2", "1/3")).toBe(false);
    });

    test("partial prefix match is NOT ancestor", () => {
      // "1/2" should NOT be ancestor of "1/20" (different segment)
      expect(isAncestor("1/2", "1/20")).toBe(false);
    });

    test("unrelated paths are not ancestors", () => {
      expect(isAncestor("2/1", "3/1")).toBe(false);
    });

    test("handles root-level comparison", () => {
      expect(isAncestor("1", "2")).toBe(false);
    });
  });
});
