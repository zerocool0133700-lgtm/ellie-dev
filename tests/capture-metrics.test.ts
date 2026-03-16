import { describe, it, expect } from "bun:test";
import {
  computeFunnel,
  computeSourceBreakdown,
  computeChannelBreakdown,
  computeContentTypeBreakdown,
  computeVelocity,
  timeRangeToInterval,
  formatMetricsSummary,
  type CaptureMetrics,
} from "../src/capture/capture-metrics.ts";

describe("ELLIE-783: Capture funnel metrics", () => {
  describe("computeFunnel", () => {
    it("computes cumulative funnel from status counts", () => {
      const f = computeFunnel({ queued: 10, refined: 5, approved: 3, written: 2, dismissed: 4 });
      expect(f.flagged).toBe(24); // all items
      expect(f.refined).toBe(10); // refined + approved + written
      expect(f.approved).toBe(5); // approved + written
      expect(f.written).toBe(2);
      expect(f.dismissed).toBe(4);
    });

    it("computes conversion rates", () => {
      const f = computeFunnel({ queued: 0, refined: 0, approved: 0, written: 10, dismissed: 0 });
      expect(f.flagged).toBe(10);
      expect(f.conversion_rates.overall).toBe(1);
    });

    it("handles zero counts", () => {
      const f = computeFunnel({});
      expect(f.flagged).toBe(0);
      expect(f.written).toBe(0);
      expect(f.conversion_rates.overall).toBe(0);
      expect(f.conversion_rates.flagged_to_refined).toBe(0);
    });

    it("rates are between 0 and 1", () => {
      const f = computeFunnel({ queued: 20, refined: 10, approved: 5, written: 2, dismissed: 3 });
      expect(f.conversion_rates.overall).toBeGreaterThanOrEqual(0);
      expect(f.conversion_rates.overall).toBeLessThanOrEqual(1);
      expect(f.conversion_rates.flagged_to_refined).toBeLessThanOrEqual(1);
      expect(f.conversion_rates.refined_to_approved).toBeLessThanOrEqual(1);
    });
  });

  describe("computeSourceBreakdown", () => {
    it("maps capture types to breakdown", () => {
      const result = computeSourceBreakdown([
        { capture_type: "manual", count: 10 },
        { capture_type: "tag", count: 5 },
        { capture_type: "proactive", count: 8 },
      ]);
      expect(result.manual).toBe(10);
      expect(result.tag).toBe(5);
      expect(result.proactive).toBe(8);
      expect(result.braindump).toBe(0);
      expect(result.replay).toBe(0);
      expect(result.template).toBe(0);
    });

    it("handles empty input", () => {
      const result = computeSourceBreakdown([]);
      expect(result.manual).toBe(0);
    });

    it("ignores unknown types", () => {
      const result = computeSourceBreakdown([{ capture_type: "unknown", count: 99 }]);
      expect(result.manual).toBe(0);
    });
  });

  describe("computeChannelBreakdown", () => {
    it("maps channels to breakdown", () => {
      const result = computeChannelBreakdown([
        { channel: "telegram", count: 15 },
        { channel: "ellie-chat", count: 10 },
        { channel: "voice", count: 3 },
      ]);
      expect(result.telegram).toBe(15);
      expect(result["ellie-chat"]).toBe(10);
      expect(result.voice).toBe(3);
      expect(result["google-chat"]).toBe(0);
    });
  });

  describe("computeContentTypeBreakdown", () => {
    it("maps content types to breakdown", () => {
      const result = computeContentTypeBreakdown([
        { content_type: "workflow", count: 8 },
        { content_type: "decision", count: 6 },
        { content_type: "reference", count: 12 },
      ]);
      expect(result.workflow).toBe(8);
      expect(result.decision).toBe(6);
      expect(result.reference).toBe(12);
      expect(result.process).toBe(0);
      expect(result.policy).toBe(0);
      expect(result.integration).toBe(0);
    });
  });

  describe("computeVelocity", () => {
    it("merges captured and written daily counts", () => {
      const v = computeVelocity(
        [{ date: "2026-03-14", count: 5 }, { date: "2026-03-15", count: 8 }],
        [{ date: "2026-03-14", count: 2 }, { date: "2026-03-16", count: 3 }],
      );
      expect(v).toHaveLength(3);
      expect(v[0]).toEqual({ date: "2026-03-14", captured: 5, written: 2 });
      expect(v[1]).toEqual({ date: "2026-03-15", captured: 8, written: 0 });
      expect(v[2]).toEqual({ date: "2026-03-16", captured: 0, written: 3 });
    });

    it("sorts by date", () => {
      const v = computeVelocity(
        [{ date: "2026-03-16", count: 1 }, { date: "2026-03-14", count: 2 }],
        [],
      );
      expect(v[0].date).toBe("2026-03-14");
      expect(v[1].date).toBe("2026-03-16");
    });

    it("handles empty inputs", () => {
      expect(computeVelocity([], [])).toEqual([]);
    });
  });

  describe("timeRangeToInterval", () => {
    it("maps ranges to intervals", () => {
      expect(timeRangeToInterval("7d")).toBe("7 days");
      expect(timeRangeToInterval("30d")).toBe("30 days");
      expect(timeRangeToInterval("all")).toBe("10 years");
    });
  });

  describe("formatMetricsSummary", () => {
    it("formats a complete summary", () => {
      const metrics: CaptureMetrics = {
        funnel: {
          flagged: 40, refined: 25, approved: 15, written: 10, dismissed: 5,
          conversion_rates: { flagged_to_refined: 0.63, refined_to_approved: 0.6, approved_to_written: 0.67, overall: 0.25 },
        },
        by_source: { manual: 15, tag: 10, proactive: 8, braindump: 3, replay: 2, template: 2 },
        by_channel: { telegram: 20, "ellie-chat": 12, "google-chat": 3, voice: 5 },
        by_content_type: { workflow: 10, decision: 8, process: 7, policy: 5, integration: 5, reference: 5 },
        velocity: [],
        time_range: "7d",
        total_items: 40,
      };
      const msg = formatMetricsSummary(metrics);
      expect(msg).toContain("Capture Metrics");
      expect(msg).toContain("7d");
      expect(msg).toContain("40 flagged");
      expect(msg).toContain("10 written");
      expect(msg).toContain("25%");
      expect(msg).toContain("manual");
      expect(msg).toContain("telegram");
      expect(msg).toContain("workflow");
    });

    it("handles zero metrics", () => {
      const metrics: CaptureMetrics = {
        funnel: {
          flagged: 0, refined: 0, approved: 0, written: 0, dismissed: 0,
          conversion_rates: { flagged_to_refined: 0, refined_to_approved: 0, approved_to_written: 0, overall: 0 },
        },
        by_source: { manual: 0, tag: 0, proactive: 0, braindump: 0, replay: 0, template: 0 },
        by_channel: { telegram: 0, "ellie-chat": 0, "google-chat": 0, voice: 0 },
        by_content_type: { workflow: 0, decision: 0, process: 0, policy: 0, integration: 0, reference: 0 },
        velocity: [],
        time_range: "30d",
        total_items: 0,
      };
      const msg = formatMetricsSummary(metrics);
      expect(msg).toContain("0 flagged");
      expect(msg).toContain("0%");
    });
  });
});
