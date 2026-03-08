/**
 * ELLIE-636 — Nightly maintenance with brain health score
 *
 * Tests the 5-metric brain health scoring system (1-5 each),
 * composite scoring, storage in forest_health_logs, and query functions.
 */

import { describe, test, expect, afterAll } from "bun:test";
import {
  computeBrainHealth, runNightlyMaintenance,
  getLatestHealthLog, getHealthTrend,
  scoreCoreExtendedRatio, scoreStaleDetection,
  scoreEmbeddingCoverage, scoreDedupQuality, scoreJunkDetection,
} from "../../ellie-forest/src/index";
import type { BrainHealthResult, HealthLog } from "../../ellie-forest/src/index";
import sql from "../../ellie-forest/src/db";

// Track health logs we create so we can clean up
const createdLogIds: string[] = [];

afterAll(async () => {
  if (createdLogIds.length > 0) {
    await sql`DELETE FROM forest_health_logs WHERE id = ANY(${createdLogIds})`;
  }
});

// ── Individual metric functions ──────────────────────────────

describe("scoreCoreExtendedRatio", () => {
  test("returns a score between 1 and 5", async () => {
    const result = await scoreCoreExtendedRatio();
    expect(result.score).toBeGreaterThanOrEqual(1);
    expect(result.score).toBeLessThanOrEqual(5);
  });

  test("returns counts for core, extended, and goals", async () => {
    const result = await scoreCoreExtendedRatio();
    expect(typeof result.coreCount).toBe("number");
    expect(typeof result.extendedCount).toBe("number");
    expect(typeof result.goalsCount).toBe("number");
    expect(result.coreCount).toBeGreaterThanOrEqual(0);
    expect(result.extendedCount).toBeGreaterThanOrEqual(0);
    expect(result.goalsCount).toBeGreaterThanOrEqual(0);
  });
});

describe("scoreStaleDetection", () => {
  test("returns a score between 1 and 5", async () => {
    const result = await scoreStaleDetection();
    expect(result.score).toBeGreaterThanOrEqual(1);
    expect(result.score).toBeLessThanOrEqual(5);
  });

  test("returns stale count and percentage", async () => {
    const result = await scoreStaleDetection();
    expect(typeof result.staleCount).toBe("number");
    expect(typeof result.totalActive).toBe("number");
    expect(typeof result.stalePercent).toBe("number");
    expect(result.stalePercent).toBeGreaterThanOrEqual(0);
    expect(result.stalePercent).toBeLessThanOrEqual(100);
  });
});

describe("scoreEmbeddingCoverage", () => {
  test("returns a score between 1 and 5", async () => {
    const result = await scoreEmbeddingCoverage();
    expect(result.score).toBeGreaterThanOrEqual(1);
    expect(result.score).toBeLessThanOrEqual(5);
  });

  test("embedding count does not exceed total", async () => {
    const result = await scoreEmbeddingCoverage();
    expect(result.embeddingCount).toBeLessThanOrEqual(result.totalActive);
  });

  test("percentage is consistent with counts", async () => {
    const result = await scoreEmbeddingCoverage();
    if (result.totalActive > 0) {
      const expected = (result.embeddingCount / result.totalActive) * 100;
      expect(result.embeddingPercent).toBeCloseTo(expected, 5);
    } else {
      expect(result.embeddingPercent).toBe(0);
    }
  });
});

describe("scoreDedupQuality", () => {
  test("returns a score between 1 and 5", async () => {
    const result = await scoreDedupQuality();
    expect(result.score).toBeGreaterThanOrEqual(1);
    expect(result.score).toBeLessThanOrEqual(5);
  });

  test("duplicate cluster count is non-negative", async () => {
    const result = await scoreDedupQuality();
    expect(result.duplicateClusterCount).toBeGreaterThanOrEqual(0);
  });
});

describe("scoreJunkDetection", () => {
  test("returns a score between 1 and 5", async () => {
    const result = await scoreJunkDetection();
    expect(result.score).toBeGreaterThanOrEqual(1);
    expect(result.score).toBeLessThanOrEqual(5);
  });

  test("junk percentage is between 0 and 100", async () => {
    const result = await scoreJunkDetection();
    expect(result.junkPercent).toBeGreaterThanOrEqual(0);
    expect(result.junkPercent).toBeLessThanOrEqual(100);
  });
});

// ── Composite brain health ──────────────────────────────────

describe("computeBrainHealth", () => {
  test("returns composite score between 1 and 5", async () => {
    const result = await computeBrainHealth();
    expect(result.compositeScore).toBeGreaterThanOrEqual(1);
    expect(result.compositeScore).toBeLessThanOrEqual(5);
  });

  test("returns all 5 metrics", async () => {
    const result = await computeBrainHealth();
    expect(typeof result.metrics.coreExtendedRatio).toBe("number");
    expect(typeof result.metrics.staleDetection).toBe("number");
    expect(typeof result.metrics.embeddingCoverage).toBe("number");
    expect(typeof result.metrics.dedupQuality).toBe("number");
    expect(typeof result.metrics.junkDetection).toBe("number");
  });

  test("all metrics are in 1-5 range", async () => {
    const result = await computeBrainHealth();
    for (const [, score] of Object.entries(result.metrics)) {
      expect(score).toBeGreaterThanOrEqual(1);
      expect(score).toBeLessThanOrEqual(5);
    }
  });

  test("composite is average of metrics", async () => {
    const result = await computeBrainHealth();
    const m = result.metrics;
    const avg = (m.coreExtendedRatio + m.staleDetection + m.embeddingCoverage +
      m.dedupQuality + m.junkDetection) / 5;
    // Composite is clamped 1-5 but for valid inputs, should match average
    expect(result.compositeScore).toBeCloseTo(Math.max(1, Math.min(5, avg)), 5);
  });

  test("details contains expected fields", async () => {
    const result = await computeBrainHealth();
    const d = result.details;
    expect(typeof d.totalMemories).toBe("number");
    expect(typeof d.coreCount).toBe("number");
    expect(typeof d.extendedCount).toBe("number");
    expect(typeof d.goalsCount).toBe("number");
    expect(typeof d.staleCount).toBe("number");
    expect(typeof d.stalePercent).toBe("number");
    expect(typeof d.embeddingCount).toBe("number");
    expect(typeof d.embeddingPercent).toBe("number");
    expect(typeof d.duplicateClusterCount).toBe("number");
    expect(typeof d.junkCount).toBe("number");
    expect(typeof d.junkPercent).toBe("number");
  });
});

// ── runNightlyMaintenance (stores to DB) ─────────────────────

describe("runNightlyMaintenance", () => {
  test("stores result in forest_health_logs and returns it", async () => {
    const result = await runNightlyMaintenance();

    // Should return a valid BrainHealthResult
    expect(result.compositeScore).toBeGreaterThanOrEqual(1);
    expect(result.compositeScore).toBeLessThanOrEqual(5);

    // Verify it was stored
    const [log] = await sql<{ id: string; composite_score: number }[]>`
      SELECT id, composite_score FROM forest_health_logs
      ORDER BY computed_at DESC LIMIT 1
    `;
    expect(log).toBeDefined();
    expect(log.composite_score).toBeCloseTo(result.compositeScore, 5);
    createdLogIds.push(log.id);
  });

  test("stores all individual metric scores", async () => {
    const result = await runNightlyMaintenance();

    const [log] = await sql<{
      id: string;
      core_extended_ratio_score: number;
      stale_detection_score: number;
      embedding_coverage_score: number;
      dedup_quality_score: number;
      junk_detection_score: number;
    }[]>`
      SELECT id, core_extended_ratio_score, stale_detection_score,
             embedding_coverage_score, dedup_quality_score, junk_detection_score
      FROM forest_health_logs
      ORDER BY computed_at DESC LIMIT 1
    `;
    createdLogIds.push(log.id);

    expect(log.core_extended_ratio_score).toBe(result.metrics.coreExtendedRatio);
    expect(log.stale_detection_score).toBe(result.metrics.staleDetection);
    expect(log.embedding_coverage_score).toBe(result.metrics.embeddingCoverage);
    expect(log.dedup_quality_score).toBe(result.metrics.dedupQuality);
    expect(log.junk_detection_score).toBe(result.metrics.junkDetection);
  });

  test("stores details as JSONB", async () => {
    const result = await runNightlyMaintenance();

    const [log] = await sql<{ id: string; details: Record<string, unknown> }[]>`
      SELECT id, details FROM forest_health_logs
      ORDER BY computed_at DESC LIMIT 1
    `;
    createdLogIds.push(log.id);

    expect(log.details).toBeDefined();
    expect(typeof log.details).toBe("object");
    expect((log.details as any).totalMemories).toBe(result.details.totalMemories);
  });
});

// ── Query functions ──────────────────────────────────────────

describe("getLatestHealthLog", () => {
  test("returns the most recent log", async () => {
    // Ensure at least one log exists
    await runNightlyMaintenance();
    const [latest] = await sql<{ id: string }[]>`
      SELECT id FROM forest_health_logs ORDER BY computed_at DESC LIMIT 1
    `;
    createdLogIds.push(latest.id);

    const log = await getLatestHealthLog();
    expect(log).not.toBeNull();
    expect(log!.id).toBe(latest.id);
    expect(typeof log!.composite_score).toBe("number");
    expect(log!.computed_at).toBeInstanceOf(Date);
  });
});

describe("getHealthTrend", () => {
  test("returns logs from last N days", async () => {
    // Create a log so there's at least one
    await runNightlyMaintenance();
    const [latest] = await sql<{ id: string }[]>`
      SELECT id FROM forest_health_logs ORDER BY computed_at DESC LIMIT 1
    `;
    createdLogIds.push(latest.id);

    const trend = await getHealthTrend(30);
    expect(Array.isArray(trend)).toBe(true);
    expect(trend.length).toBeGreaterThanOrEqual(1);
  });

  test("returns logs in ascending order by computed_at", async () => {
    const trend = await getHealthTrend(30);
    if (trend.length >= 2) {
      for (let i = 1; i < trend.length; i++) {
        expect(trend[i].computed_at.getTime()).toBeGreaterThanOrEqual(
          trend[i - 1].computed_at.getTime()
        );
      }
    }
  });

  test("default parameter is 30 days", async () => {
    const trend30 = await getHealthTrend();
    const trendExplicit = await getHealthTrend(30);
    // Both should return the same count (same time window)
    expect(trend30.length).toBe(trendExplicit.length);
  });
});
