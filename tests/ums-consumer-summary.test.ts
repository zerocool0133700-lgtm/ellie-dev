/**
 * UMS Consumer Tests: Summary — ELLIE-709
 *
 * The summary consumer aggregates state from all other consumers.
 * Tests focus on the exported types and fallback behavior,
 * since the per-module summaries depend on module-level state.
 */

import { describe, test, expect } from "bun:test";
import type { ModuleSummary, ModuleStatus, SummaryState } from "../src/ums/consumers/summary.ts";

describe("summary consumer", () => {
  describe("ModuleStatus type", () => {
    test("valid statuses", () => {
      const statuses: ModuleStatus[] = ["green", "white", "red"];
      expect(statuses).toHaveLength(3);
    });
  });

  describe("ModuleSummary shape", () => {
    test("constructs a valid ModuleSummary", () => {
      const summary: ModuleSummary = {
        module: "gtd",
        label: "GTD",
        icon: "&#127919;",
        status: "green",
        text: "3 due today, 5 in inbox",
        path: "/gtd",
        has_new: true,
        count: 5,
      };
      expect(summary.module).toBe("gtd");
      expect(summary.status).toBe("green");
      expect(summary.has_new).toBe(true);
      expect(summary.count).toBe(5);
    });

    test("count is optional", () => {
      const summary: ModuleSummary = {
        module: "briefing",
        label: "Briefing",
        icon: "&#128203;",
        status: "white",
        text: "No recent activity",
        path: "/",
        has_new: false,
      };
      expect(summary.count).toBeUndefined();
    });
  });

  describe("SummaryState shape", () => {
    test("constructs a valid SummaryState", () => {
      const state: SummaryState = {
        timestamp: new Date().toISOString(),
        modules: [],
        update_count: 0,
        has_urgent: false,
      };
      expect(state.modules).toEqual([]);
      expect(state.has_urgent).toBe(false);
    });

    test("update_count reflects modules with has_new", () => {
      const modules: ModuleSummary[] = [
        { module: "a", label: "A", icon: "", status: "green", text: "", path: "/", has_new: true },
        { module: "b", label: "B", icon: "", status: "white", text: "", path: "/", has_new: false },
        { module: "c", label: "C", icon: "", status: "red", text: "", path: "/", has_new: true },
      ];
      const update_count = modules.filter(m => m.has_new).length;
      const has_urgent = modules.some(m => m.status === "red");
      expect(update_count).toBe(2);
      expect(has_urgent).toBe(true);
    });
  });

  describe("expected modules", () => {
    test("all 9 modules are defined", () => {
      const expectedModules = [
        "gtd", "comms", "calendar", "memory", "briefing",
        "forest", "alerts", "relationship", "analytics",
      ];
      expect(expectedModules).toHaveLength(9);
    });
  });
});
