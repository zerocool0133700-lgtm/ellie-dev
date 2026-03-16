import { describe, it, expect } from "bun:test";
import {
  textSimilarity,
  detectContradiction,
  detectSupersession,
  classifyCapture,
  classifyBatch,
  buildDedupSummary,
  DEFAULT_DEDUP_CONFIG,
  type QmdClient,
  type QmdSearchResult,
  type DedupResult,
} from "../src/capture/dedup-detector.ts";

function mockQmd(results: QmdSearchResult[] = []): QmdClient {
  return { search: async () => results };
}

function failingQmd(): QmdClient {
  return { search: async () => { throw new Error("QMD down"); } };
}

describe("ELLIE-780: Deduplication & conflict detection", () => {
  describe("textSimilarity", () => {
    it("returns 1.0 for identical text", () => {
      expect(textSimilarity("hello world", "hello world")).toBe(1);
    });

    it("returns high score for near-identical", () => {
      const sim = textSimilarity(
        "We deploy to staging before production",
        "We deploy to staging before production always",
      );
      expect(sim).toBeGreaterThan(0.8);
    });

    it("returns low score for different text", () => {
      const sim = textSimilarity("cats are fluffy animals", "the database uses postgres");
      expect(sim).toBeLessThan(0.2);
    });

    it("is case insensitive", () => {
      expect(textSimilarity("Hello World", "hello world")).toBe(1);
    });

    it("ignores punctuation", () => {
      expect(textSimilarity("hello, world!", "hello world")).toBe(1);
    });

    it("handles empty strings", () => {
      expect(textSimilarity("", "")).toBe(1);
      expect(textSimilarity("hello", "")).toBe(0);
      expect(textSimilarity("", "hello")).toBe(0);
    });
  });

  describe("detectContradiction", () => {
    it("detects always vs never", () => {
      const r = detectContradiction("Always run tests before deploy", "Never run tests on Friday");
      expect(r.isConflict).toBe(true);
      expect(r.signals.length).toBeGreaterThan(0);
    });

    it("detects required vs optional", () => {
      const r = detectContradiction("Code review is required", "Code review is optional for hotfixes");
      expect(r.isConflict).toBe(true);
    });

    it("detects use vs don't use", () => {
      const r = detectContradiction("Use Redis for caching", "Don't use Redis in production");
      expect(r.isConflict).toBe(true);
    });

    it("returns false for non-contradicting content", () => {
      const r = detectContradiction("Deploy to staging first", "Run tests after deploy");
      expect(r.isConflict).toBe(false);
      expect(r.signals).toHaveLength(0);
    });
  });

  describe("detectSupersession", () => {
    it("detects when new content is longer with moderate similarity", () => {
      const existing = "Deploy process: push to staging, run tests";
      const newContent = "Deploy process: push to staging, run integration tests, run smoke tests, check monitoring, verify metrics, then promote to production";
      expect(detectSupersession(newContent, existing, 0.6)).toBe(true);
    });

    it("does not flag when similarity too high (duplicate)", () => {
      expect(detectSupersession("same content here", "same content here", 0.95)).toBe(false);
    });

    it("does not flag when similarity too low (unrelated)", () => {
      expect(detectSupersession("completely different", "nothing alike", 0.2)).toBe(false);
    });

    it("does not flag when new content is shorter", () => {
      expect(detectSupersession("short", "much longer existing content here", 0.6)).toBe(false);
    });
  });

  describe("classifyCapture", () => {
    it("classifies as unique when no similar docs", async () => {
      const r = await classifyCapture("Brand new workflow content", mockQmd([]));
      expect(r.classification).toBe("unique");
      expect(r.confidence).toBe(0.95);
      expect(r.suggestion).toContain("new document");
    });

    it("classifies as duplicate when exact match found", async () => {
      const qmd = mockQmd([{
        path: "workflows/deploy.md",
        title: "Deploy Process",
        content: "deploy to staging before production always check monitoring",
        score: 0.95,
      }]);
      const r = await classifyCapture("deploy to staging before production always check monitoring", qmd);
      expect(r.classification).toBe("duplicate");
      expect(r.matched_doc).toBeTruthy();
      expect(r.matched_doc!.path).toBe("workflows/deploy.md");
      expect(r.suggestion).toContain("Skip");
    });

    it("classifies as semantic_duplicate for high score non-exact match", async () => {
      const qmd = mockQmd([{
        path: "decisions/db-choice.md",
        title: "DB Choice",
        content: "We chose Postgres for its JSON support and ACID compliance",
        score: 0.90,
      }]);
      const r = await classifyCapture("Selected PostgreSQL because of excellent JSON handling and transaction guarantees", qmd);
      expect(r.classification).toBe("semantic_duplicate");
      expect(r.suggestion).toContain("merge");
    });

    it("classifies as conflict when contradiction detected", async () => {
      const qmd = mockQmd([{
        path: "policies/testing.md",
        title: "Testing Policy",
        content: "Code review is always required before merging any changes",
        score: 0.75,
      }]);
      const r = await classifyCapture("Code review is never required for hotfixes to production", qmd);
      expect(r.classification).toBe("conflict");
      expect(r.reason).toContain("contradiction");
      expect(r.suggestion).toContain("human review");
    });

    it("classifies as supersedes when content updates existing", async () => {
      const existing = "Deploy: push to staging, test";
      const qmd = mockQmd([{
        path: "processes/deploy.md",
        title: "Deploy",
        content: existing,
        score: 0.6,
      }]);
      const newContent = "Deploy: push to staging, run integration tests, smoke tests, check metrics, verify dashboards, then promote to production with gradual rollout";
      const r = await classifyCapture(newContent, qmd);
      expect(r.classification).toBe("supersedes");
      expect(r.suggestion).toContain("Update existing");
    });

    it("returns unique when QMD fails", async () => {
      const r = await classifyCapture("Some content", failingQmd());
      expect(r.classification).toBe("unique");
      expect(r.reason).toContain("unavailable");
    });

    it("returns unique for related-but-distinct content", async () => {
      const qmd = mockQmd([{
        path: "processes/deploy.md",
        title: "Deploy",
        content: "How to deploy to production with zero downtime",
        score: 0.72,
      }]);
      const r = await classifyCapture("How to set up monitoring dashboards for the team", qmd);
      expect(r.classification).toBe("unique");
    });
  });

  describe("classifyBatch", () => {
    it("classifies multiple items", async () => {
      const qmd = mockQmd([]);
      const items = [
        { id: "a", content: "New workflow" },
        { id: "b", content: "Another new thing" },
      ];
      const results = await classifyBatch(items, qmd);
      expect(results.size).toBe(2);
      expect(results.get("a")!.classification).toBe("unique");
      expect(results.get("b")!.classification).toBe("unique");
    });
  });

  describe("buildDedupSummary", () => {
    it("summarizes mixed results", () => {
      const results = new Map<string, DedupResult>([
        ["a", { classification: "unique", confidence: 0.95, reason: "", suggestion: "" }],
        ["b", { classification: "duplicate", confidence: 0.98, reason: "", suggestion: "" }],
        ["c", { classification: "conflict", confidence: 0.8, reason: "", suggestion: "" }],
        ["d", { classification: "unique", confidence: 0.9, reason: "", suggestion: "" }],
      ]);
      const summary = buildDedupSummary(results);
      expect(summary).toContain("2 unique");
      expect(summary).toContain("1 duplicate");
      expect(summary).toContain("1 conflict");
      expect(summary).toContain("4 total");
    });

    it("handles all-unique results", () => {
      const results = new Map<string, DedupResult>([
        ["a", { classification: "unique", confidence: 0.95, reason: "", suggestion: "" }],
      ]);
      const summary = buildDedupSummary(results);
      expect(summary).toContain("1 unique");
    });
  });
});
