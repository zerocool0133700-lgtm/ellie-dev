import { describe, it, expect, beforeEach } from "bun:test";
import { MountainOrchestrator } from "../src/mountain/orchestrator.ts";
import type {
  MountainSource,
  HarvestJob,
  HarvestResult,
  HarvestItem,
} from "../src/mountain/types.ts";

// ── Test Helpers ─────────────────────────────────────────────

function makeSource(overrides: Partial<MountainSource> = {}): MountainSource {
  return {
    id: "test-source",
    name: "Test Source",
    status: "idle",
    async harvest(job: HarvestJob): Promise<HarvestResult> {
      return {
        jobId: job.id,
        sourceId: this.id,
        items: [],
        errors: [],
        startedAt: new Date(),
        completedAt: new Date(),
        truncated: false,
      };
    },
    ...overrides,
  };
}

function makeJob(overrides: Partial<HarvestJob> = {}): HarvestJob {
  return {
    id: "job-1",
    sourceId: "test-source",
    ...overrides,
  };
}

// ── Registration ─────────────────────────────────────────────

describe("MountainOrchestrator", () => {
  let orch: MountainOrchestrator;

  beforeEach(() => {
    orch = new MountainOrchestrator();
  });

  describe("register", () => {
    it("registers a source", () => {
      orch.register(makeSource());
      const sources = orch.listSources();
      expect(sources).toHaveLength(1);
      expect(sources[0].id).toBe("test-source");
      expect(sources[0].name).toBe("Test Source");
      expect(sources[0].status).toBe("idle");
    });

    it("throws on duplicate source ID", () => {
      orch.register(makeSource());
      expect(() => orch.register(makeSource())).toThrow(
        'Mountain source "test-source" is already registered',
      );
    });

    it("registers multiple sources", () => {
      orch.register(makeSource({ id: "a", name: "Source A" }));
      orch.register(makeSource({ id: "b", name: "Source B" }));
      expect(orch.listSources()).toHaveLength(2);
    });
  });

  describe("unregister", () => {
    it("removes a registered source", () => {
      orch.register(makeSource());
      expect(orch.unregister("test-source")).toBe(true);
      expect(orch.listSources()).toHaveLength(0);
    });

    it("returns false for unknown source", () => {
      expect(orch.unregister("nonexistent")).toBe(false);
    });
  });

  describe("getSource", () => {
    it("returns a registered source", () => {
      const src = makeSource();
      orch.register(src);
      expect(orch.getSource("test-source")).toBe(src);
    });

    it("returns undefined for unknown source", () => {
      expect(orch.getSource("nonexistent")).toBeUndefined();
    });
  });

  // ── Listing ──────────────────────────────────────────────────

  describe("listSources", () => {
    it("returns empty array when no sources registered", () => {
      expect(orch.listSources()).toEqual([]);
    });

    it("reflects current status of sources", () => {
      const src = makeSource();
      orch.register(src);
      src.status = "error";
      const listed = orch.listSources();
      expect(listed[0].status).toBe("error");
    });
  });

  // ── Harvesting ─────────────────────────────────────────────

  describe("harvest", () => {
    it("throws for unknown source", async () => {
      await expect(orch.harvest(makeJob({ sourceId: "nope" }))).rejects.toThrow(
        'Unknown source: "nope"',
      );
    });

    it("runs a successful harvest", async () => {
      const items: HarvestItem[] = [
        {
          externalId: "ext-1",
          content: "Hello from test",
          sourceTimestamp: new Date("2026-01-01"),
        },
      ];
      orch.register(
        makeSource({
          async harvest(job) {
            return {
              jobId: job.id,
              sourceId: "test-source",
              items,
              errors: [],
              startedAt: new Date(),
              completedAt: new Date(),
              truncated: false,
            };
          },
        }),
      );

      const result = await orch.harvest(makeJob());
      expect(result.items).toHaveLength(1);
      expect(result.items[0].externalId).toBe("ext-1");
      expect(result.errors).toHaveLength(0);
      expect(result.truncated).toBe(false);
    });

    it("sets source status to harvesting during run", async () => {
      let statusDuringHarvest: string | undefined;
      const src = makeSource({
        async harvest(job) {
          statusDuringHarvest = this.status;
          return {
            jobId: job.id,
            sourceId: "test-source",
            items: [],
            errors: [],
            startedAt: new Date(),
            completedAt: new Date(),
            truncated: false,
          };
        },
      });
      orch.register(src);
      await orch.harvest(makeJob());
      expect(statusDuringHarvest).toBe("harvesting");
      expect(src.status).toBe("idle");
    });

    it("returns error result and sets status to error on failure", async () => {
      orch.register(
        makeSource({
          async harvest() {
            throw new Error("API rate limited");
          },
        }),
      );

      const result = await orch.harvest(makeJob());
      expect(result.items).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toBe("API rate limited");
      expect(result.errors[0].retryable).toBe(false);

      const src = orch.getSource("test-source")!;
      expect(src.status).toBe("error");
    });

    it("passes job filters to the source", async () => {
      let receivedFilters: Record<string, unknown> | undefined;
      orch.register(
        makeSource({
          async harvest(job) {
            receivedFilters = job.filters;
            return {
              jobId: job.id,
              sourceId: "test-source",
              items: [],
              errors: [],
              startedAt: new Date(),
              completedAt: new Date(),
              truncated: false,
            };
          },
        }),
      );

      await orch.harvest(makeJob({ filters: { label: "urgent" } }));
      expect(receivedFilters).toEqual({ label: "urgent" });
    });

    it("passes time window to the source", async () => {
      let receivedSince: Date | undefined;
      let receivedUntil: Date | undefined;
      orch.register(
        makeSource({
          async harvest(job) {
            receivedSince = job.since;
            receivedUntil = job.until;
            return {
              jobId: job.id,
              sourceId: "test-source",
              items: [],
              errors: [],
              startedAt: new Date(),
              completedAt: new Date(),
              truncated: false,
            };
          },
        }),
      );

      const since = new Date("2026-01-01");
      const until = new Date("2026-02-01");
      await orch.harvest(makeJob({ since, until }));
      expect(receivedSince).toEqual(since);
      expect(receivedUntil).toEqual(until);
    });
  });

  // ── Health Check ───────────────────────────────────────────

  describe("healthCheck", () => {
    it("returns null for sources without healthCheck", async () => {
      orch.register(makeSource());
      const results = await orch.healthCheck();
      expect(results.get("test-source")).toBeNull();
    });

    it("returns true for healthy source", async () => {
      orch.register(
        makeSource({
          async healthCheck() {
            return true;
          },
        }),
      );
      const results = await orch.healthCheck();
      expect(results.get("test-source")).toBe(true);
    });

    it("returns false for unhealthy source", async () => {
      orch.register(
        makeSource({
          async healthCheck() {
            return false;
          },
        }),
      );
      const results = await orch.healthCheck();
      expect(results.get("test-source")).toBe(false);
    });

    it("returns false when healthCheck throws", async () => {
      orch.register(
        makeSource({
          async healthCheck() {
            throw new Error("connection refused");
          },
        }),
      );
      const results = await orch.healthCheck();
      expect(results.get("test-source")).toBe(false);
    });

    it("checks a specific source by ID", async () => {
      orch.register(makeSource({ id: "a", name: "A" }));
      orch.register(
        makeSource({
          id: "b",
          name: "B",
          async healthCheck() {
            return true;
          },
        }),
      );
      const results = await orch.healthCheck("b");
      expect(results.size).toBe(1);
      expect(results.get("b")).toBe(true);
    });

    it("returns empty map for unknown source ID", async () => {
      const results = await orch.healthCheck("nonexistent");
      expect(results.size).toBe(0);
    });
  });
});
