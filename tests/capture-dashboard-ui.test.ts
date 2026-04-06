import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";

/**
 * ELLIE-799: Capture pipeline dashboard UI
 * Tests the UI components, composable, and integration points.
 */

const capturePageVue = readFileSync("/home/ellie/ellie-home/app/pages/capture.vue", "utf-8");
const layoutVue = readFileSync("/home/ellie/ellie-home/app/layouts/default.vue", "utf-8");
const composable = readFileSync("/home/ellie/ellie-home/app/composables/useCaptureStatus.ts", "utf-8");
const chatPageVue = readFileSync("/home/ellie/ellie-home/app/pages/ellie-chat.vue", "utf-8");

describe("ELLIE-799: Capture pipeline dashboard UI", () => {
  describe("capture status composable", () => {
    it("exports useCaptureStatus function", () => {
      expect(composable).toContain("export function useCaptureStatus");
    });

    it("tracks pending count (queued + refined)", () => {
      expect(composable).toContain("queued");
      expect(composable).toContain("refined");
      expect(composable).toContain("pending");
    });

    it("has hasPending computed", () => {
      expect(composable).toContain("hasPending");
    });

    it("has badgeText with 99+ cap", () => {
      expect(composable).toContain("badgeText");
      expect(composable).toContain("99+");
    });

    it("has stale-while-revalidate refresh", () => {
      expect(composable).toContain("STALE_MS");
      expect(composable).toContain("refresh");
    });

    it("fetches from /api/capture/stats", () => {
      expect(composable).toContain("/api/capture/stats");
    });
  });

  describe("nav badge", () => {
    it("layout uses useCaptureStatus", () => {
      expect(layoutVue).toContain("useCaptureStatus");
    });

    it("badge shows on /capture nav item", () => {
      expect(layoutVue).toContain("/capture");
      expect(layoutVue).toContain("captureStatus.hasPending");
      expect(layoutVue).toContain("captureStatus.badgeText");
    });

    it("badge has accessible styling", () => {
      expect(layoutVue).toContain("rounded-full");
      expect(layoutVue).toContain("bg-teal-500");
    });

    it("refreshes on mount", () => {
      expect(layoutVue).toContain("captureStatus.refresh");
    });
  });

  describe("capture page — review mode", () => {
    it("has review mode toggle", () => {
      expect(capturePageVue).toContain("reviewMode");
      expect(capturePageVue).toContain("startReview");
    });

    it("has Review All button", () => {
      expect(capturePageVue).toContain("Review All");
      expect(capturePageVue).toContain("startReview");
    });

    it("shows review progress (X of Y)", () => {
      expect(capturePageVue).toContain("reviewIndex + 1");
      expect(capturePageVue).toContain("reviewItems.length");
    });

    it("has approve/skip/dismiss actions in review", () => {
      expect(capturePageVue).toContain("reviewAction('approve')");
      expect(capturePageVue).toContain("reviewAction('skip')");
      expect(capturePageVue).toContain("reviewAction('dismiss')");
    });

    it("has Approve All shortcut", () => {
      expect(capturePageVue).toContain("reviewApproveAll");
      expect(capturePageVue).toContain("Approve All");
    });

    it("shows review summary when complete", () => {
      expect(capturePageVue).toContain("Review complete");
      expect(capturePageVue).toContain("reviewApproved");
      expect(capturePageVue).toContain("reviewDismissed");
      expect(capturePageVue).toContain("reviewSkipped");
    });

    it("has exit review button", () => {
      expect(capturePageVue).toContain("Exit Review");
    });

    it("tracks review counts", () => {
      expect(capturePageVue).toContain("reviewApproved");
      expect(capturePageVue).toContain("reviewDismissed");
      expect(capturePageVue).toContain("reviewSkipped");
    });
  });

  describe("accessibility", () => {
    it("stats bar has aria role", () => {
      expect(capturePageVue).toContain('role="group"');
      expect(capturePageVue).toContain('aria-label="Capture queue statistics"');
    });

    it("review actions have aria labels", () => {
      expect(capturePageVue).toContain('aria-label="Approve this capture"');
      expect(capturePageVue).toContain('aria-label="Skip to next capture"');
      expect(capturePageVue).toContain('aria-label="Dismiss this capture"');
    });

    it("review all button has aria label", () => {
      expect(capturePageVue).toContain('aria-label="Start guided review');
    });

    it("review action buttons have min-width for tap targets", () => {
      expect(capturePageVue).toContain("min-w-[80px]");
    });
  });

  describe("ellie-chat integration", () => {
    it("has River button on messages", () => {
      expect(chatPageVue).toContain("openRefineModal");
      expect(chatPageVue).toContain("River");
    });

    it("has refine modal", () => {
      expect(chatPageVue).toContain("refineModal");
      expect(chatPageVue).toContain("Refine to River");
    });

    it("shows captured status on messages", () => {
      expect(chatPageVue).toContain("refinedMessages");
      expect(chatPageVue).toContain("Captured");
    });
  });

  describe("capture page — existing features", () => {
    it("has status filter buttons", () => {
      expect(capturePageVue).toContain("statusFilters");
      expect(capturePageVue).toContain("activeStatus");
    });

    it("has channel and type filters", () => {
      expect(capturePageVue).toContain("activeChannel");
      expect(capturePageVue).toContain("activeType");
    });

    it("has batch select + approve/dismiss", () => {
      expect(capturePageVue).toContain("selectedIds");
      expect(capturePageVue).toContain("batchApprove");
      expect(capturePageVue).toContain("batchDismiss");
    });

    it("has expandable item detail with raw vs refined", () => {
      expect(capturePageVue).toContain("expandedId");
      expect(capturePageVue).toContain("Raw Content");
      expect(capturePageVue).toContain("Refined Content");
    });

    it("has pagination", () => {
      expect(capturePageVue).toContain("prevPage");
      expect(capturePageVue).toContain("nextPage");
    });
  });
});
