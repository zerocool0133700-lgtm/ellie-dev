import { describe, it, expect, beforeEach } from "bun:test";
import {
  detectPatterns,
  scanMessage,
  mergeConfig,
  DEFAULT_CONFIG,
  _clearCooldowns,
  _getPatternRules,
  type DetectorConfig,
} from "../src/capture/pattern-detector.ts";

beforeEach(() => _clearCooldowns());

function createMockSql(returnValue: any = [{ id: "cap-1" }]) {
  const calls: any[] = [];
  const fn: any = function (...args: any[]) {
    calls.push(args);
    return Promise.resolve(returnValue);
  };
  fn.calls = calls;
  return fn;
}

const LOW_THRESHOLD: DetectorConfig = { confidence_threshold: 0.5, min_message_length: 10, cooldown_seconds: 0 };

describe("ELLIE-777: Proactive pattern detection", () => {
  describe("detectPatterns — workflow", () => {
    it("detects step sequences", () => {
      const r = detectPatterns("First we build the image, then push to registry, next deploy to staging", LOW_THRESHOLD);
      expect(r.detected).toBe(true);
      expect(r.content_type).toBe("workflow");
      expect(r.confidence).toBeGreaterThan(0.5);
    });

    it("detects 'here's how X works'", () => {
      const r = detectPatterns("Heres how the deployment works in our system with multiple stages", LOW_THRESHOLD);
      expect(r.detected).toBe(true);
      expect(r.content_type).toBe("workflow");
    });

    it("detects 'the process is'", () => {
      const r = detectPatterns("The process goes like this: check out the code, run tests, then merge", LOW_THRESHOLD);
      expect(r.detected).toBe(true);
      expect(r.content_type).toBe("workflow");
    });
  });

  describe("detectPatterns — decision", () => {
    it("detects 'we decided'", () => {
      const r = detectPatterns("We decided to use Postgres because it has better JSON support than MySQL", LOW_THRESHOLD);
      expect(r.detected).toBe(true);
      expect(r.content_type).toBe("decision");
    });

    it("detects 'going with X because'", () => {
      const r = detectPatterns("Going with Redis because it has better performance over Memcached for our use case", LOW_THRESHOLD);
      expect(r.detected).toBe(true);
      expect(r.content_type).toBe("decision");
    });

    it("detects 'chose X over Y'", () => {
      const r = detectPatterns("We chose TypeScript over plain JavaScript for better type safety in the project", LOW_THRESHOLD);
      expect(r.detected).toBe(true);
      expect(r.content_type).toBe("decision");
    });
  });

  describe("detectPatterns — policy", () => {
    it("detects 'the rule is'", () => {
      const r = detectPatterns("The rule is that all PRs must be reviewed by at least two people before merging", LOW_THRESHOLD);
      expect(r.detected).toBe(true);
      expect(r.content_type).toBe("policy");
    });

    it("detects 'always/never' patterns", () => {
      const r = detectPatterns("Always make sure to run the full test suite before deploying any code to production", LOW_THRESHOLD);
      expect(r.detected).toBe(true);
      expect(r.content_type).toBe("policy");
    });

    it("detects 'required/mandatory'", () => {
      const r = detectPatterns("Code review is mandatory for all changes and required before any merge to main branch", LOW_THRESHOLD);
      expect(r.detected).toBe(true);
      expect(r.content_type).toBe("policy");
    });
  });

  describe("detectPatterns — process", () => {
    it("detects recurring patterns", () => {
      const r = detectPatterns("Every morning we run the standup meeting and check the dashboard for alerts", LOW_THRESHOLD);
      expect(r.detected).toBe(true);
      expect(r.content_type).toBe("process");
    });

    it("detects 'how to' patterns", () => {
      const r = detectPatterns("Here are the steps to onboard a new developer to the project and get them set up", LOW_THRESHOLD);
      expect(r.detected).toBe(true);
    });

    it("detects 'when X happens, do Y'", () => {
      const r = detectPatterns("When an alert fires, we check the monitoring dashboard and run diagnostics immediately", LOW_THRESHOLD);
      expect(r.detected).toBe(true);
    });
  });

  describe("detectPatterns — integration", () => {
    it("detects 'X connects to Y'", () => {
      const r = detectPatterns("Our billing system connects to Stripe via their REST API for payment processing", LOW_THRESHOLD);
      expect(r.detected).toBe(true);
      expect(r.content_type).toBe("integration");
    });

    it("detects API specs", () => {
      const r = detectPatterns("The API expects a JSON body with auth token and returns the user profile data", LOW_THRESHOLD);
      expect(r.detected).toBe(true);
      expect(r.content_type).toBe("integration");
    });

    it("detects webhook/endpoint mentions", () => {
      const r = detectPatterns("The webhook endpoint is at /api/hooks and the auth token for authentication is in env vars", LOW_THRESHOLD);
      expect(r.detected).toBe(true);
      expect(r.content_type).toBe("integration");
    });
  });

  describe("detectPatterns — non-detection", () => {
    it("ignores short messages", () => {
      const r = detectPatterns("ok sure", DEFAULT_CONFIG);
      expect(r.detected).toBe(false);
    });

    it("ignores casual conversation", () => {
      const r = detectPatterns("Hey, how are you doing today? I had a good lunch.", DEFAULT_CONFIG);
      expect(r.detected).toBe(false);
    });

    it("ignores generic questions", () => {
      const r = detectPatterns("What time is the meeting tomorrow? I need to prepare some slides.", DEFAULT_CONFIG);
      expect(r.detected).toBe(false);
    });

    it("respects confidence threshold", () => {
      const highThreshold: DetectorConfig = { ...DEFAULT_CONFIG, confidence_threshold: 0.99 };
      const r = detectPatterns("The process is to check first then deploy", highThreshold);
      expect(r.detected).toBe(false);
    });
  });

  describe("detectPatterns — confidence", () => {
    it("confidence is between 0 and 1", () => {
      const texts = [
        "First we do X, then Y, next Z, after that W — the full pipeline sequence flow",
        "We decided to go with Postgres because of the trade-off over MongoDB",
        "Hello world",
      ];
      for (const text of texts) {
        const r = detectPatterns(text, { ...LOW_THRESHOLD, min_message_length: 5 });
        expect(r.confidence).toBeGreaterThanOrEqual(0);
        expect(r.confidence).toBeLessThanOrEqual(1);
      }
    });

    it("multiple pattern matches increase confidence", () => {
      const single = detectPatterns("We decided to use Redis for our caching layer in production", LOW_THRESHOLD);
      const multi = detectPatterns("We decided to go with Redis because it's faster, chose it over Memcached, picking it over the alternative", LOW_THRESHOLD);
      expect(multi.confidence).toBeGreaterThanOrEqual(single.confidence);
    });
  });

  describe("scanMessage", () => {
    it("queues detected patterns", async () => {
      const mockSql = createMockSql();
      const r = await scanMessage(
        mockSql,
        "We decided to use Postgres because it handles JSON better than the alternatives we considered",
        "telegram",
        "user-1",
        "msg-123",
        LOW_THRESHOLD,
      );
      expect(r.detected).toBe(true);
      expect(r.queued).toBe(true);
      expect(r.capture_id).toBe("cap-1");
    });

    it("does not queue non-detections", async () => {
      const mockSql = createMockSql();
      const r = await scanMessage(mockSql, "Hey how are you doing today friend", "telegram", "user-1", undefined, LOW_THRESHOLD);
      expect(r.detected).toBe(false);
      expect(r.queued).toBe(false);
      expect(mockSql.calls).toHaveLength(0);
    });

    it("respects cooldown", async () => {
      const config: DetectorConfig = { ...LOW_THRESHOLD, cooldown_seconds: 300 };
      const mockSql = createMockSql();

      const r1 = await scanMessage(mockSql, "We decided to use Postgres because it's better for our JSON-heavy workload", "telegram", "user-1", undefined, config);
      expect(r1.queued).toBe(true);

      const r2 = await scanMessage(mockSql, "We decided to go with Redis because it handles caching better than the alternatives", "telegram", "user-1", undefined, config);
      expect(r2.detected).toBe(true);
      expect(r2.queued).toBe(false); // cooled down
    });

    it("handles SQL errors gracefully", async () => {
      const mockSql: any = function () {
        return Promise.reject(new Error("DB down"));
      };
      const r = await scanMessage(mockSql, "We decided to use Postgres because it's the best choice for this workload", "telegram", "user-1", undefined, LOW_THRESHOLD);
      expect(r.detected).toBe(true);
      expect(r.queued).toBe(false);
    });
  });

  describe("mergeConfig", () => {
    it("overrides specific fields", () => {
      const c = mergeConfig({ confidence_threshold: 0.9 });
      expect(c.confidence_threshold).toBe(0.9);
      expect(c.min_message_length).toBe(DEFAULT_CONFIG.min_message_length);
      expect(c.cooldown_seconds).toBe(DEFAULT_CONFIG.cooldown_seconds);
    });

    it("returns defaults when no overrides", () => {
      const c = mergeConfig({});
      expect(c).toEqual(DEFAULT_CONFIG);
    });
  });

  describe("pattern coverage", () => {
    it("has rules for all 5 content types", () => {
      const rules = _getPatternRules();
      const types = new Set(rules.map(r => r.content_type));
      expect(types.has("workflow")).toBe(true);
      expect(types.has("decision")).toBe(true);
      expect(types.has("policy")).toBe(true);
      expect(types.has("process")).toBe(true);
      expect(types.has("integration")).toBe(true);
    });

    it("each rule has at least 3 patterns", () => {
      const rules = _getPatternRules();
      for (const rule of rules) {
        expect(rule.patterns.length).toBeGreaterThanOrEqual(3);
      }
    });
  });
});
