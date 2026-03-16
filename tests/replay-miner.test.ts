import { describe, it, expect } from "bun:test";
import {
  scanMessages,
  deduplicateFindingsFromData,
  buildReport,
  formatReportMessage,
  queueFindings,
  DEFAULT_MINER_CONFIG,
  type ConversationMessage,
  type MinerFinding,
  type MinerConfig,
} from "../src/capture/replay-miner.ts";

const LOW_THRESHOLD_CONFIG: MinerConfig = {
  ...DEFAULT_MINER_CONFIG,
  detector_config: { confidence_threshold: 0.5, min_message_length: 10, cooldown_seconds: 0 },
};

const MOCK_MESSAGES: ConversationMessage[] = [
  {
    id: "msg-1",
    text: "We decided to use Postgres because it handles JSON better than the other alternatives we tested",
    channel: "telegram",
    role: "user",
    created_at: "2026-03-15T10:00:00Z",
  },
  {
    id: "msg-2",
    text: "First we build the image, then push to registry, next deploy to staging environment",
    channel: "telegram",
    role: "user",
    created_at: "2026-03-15T11:00:00Z",
  },
  {
    id: "msg-3",
    text: "Hey how are you doing today",
    channel: "ellie-chat",
    role: "user",
    created_at: "2026-03-15T12:00:00Z",
  },
  {
    id: "msg-4",
    text: "The rule is that all deployments must go through staging first, it is mandatory",
    channel: "telegram",
    role: "user",
    created_at: "2026-03-15T13:00:00Z",
  },
  {
    id: "msg-5",
    text: "The webhook endpoint is at /api/hooks and the auth token for access is in the env vars",
    channel: "voice",
    role: "user",
    created_at: "2026-03-15T14:00:00Z",
  },
];

describe("ELLIE-779: Conversation replay mining", () => {
  describe("scanMessages", () => {
    it("identifies River-worthy messages", () => {
      const findings = scanMessages(MOCK_MESSAGES, LOW_THRESHOLD_CONFIG);
      expect(findings.length).toBeGreaterThanOrEqual(3);
    });

    it("skips casual conversation", () => {
      const findings = scanMessages(MOCK_MESSAGES, LOW_THRESHOLD_CONFIG);
      const ids = findings.map(f => f.message_id);
      expect(ids).not.toContain("msg-3"); // "Hey how are you"
    });

    it("preserves message metadata in findings", () => {
      const findings = scanMessages(MOCK_MESSAGES, LOW_THRESHOLD_CONFIG);
      const first = findings[0];
      expect(first.message_id).toBeTruthy();
      expect(first.content_type).toBeTruthy();
      expect(first.confidence).toBeGreaterThan(0);
      expect(first.raw_content).toBeTruthy();
      expect(first.channel).toBeTruthy();
      expect(first.created_at).toBeTruthy();
    });

    it("classifies decisions correctly", () => {
      const findings = scanMessages(MOCK_MESSAGES, LOW_THRESHOLD_CONFIG);
      const decision = findings.find(f => f.message_id === "msg-1");
      expect(decision).toBeTruthy();
      expect(decision!.content_type).toBe("decision");
    });

    it("classifies workflows correctly", () => {
      const findings = scanMessages(MOCK_MESSAGES, LOW_THRESHOLD_CONFIG);
      const workflow = findings.find(f => f.message_id === "msg-2");
      expect(workflow).toBeTruthy();
      expect(workflow!.content_type).toBe("workflow");
    });

    it("returns empty for empty input", () => {
      expect(scanMessages([], LOW_THRESHOLD_CONFIG)).toEqual([]);
    });

    it("respects confidence threshold", () => {
      const highThreshold: MinerConfig = {
        ...DEFAULT_MINER_CONFIG,
        detector_config: { confidence_threshold: 0.99, min_message_length: 10, cooldown_seconds: 0 },
      };
      const findings = scanMessages(MOCK_MESSAGES, highThreshold);
      expect(findings.length).toBe(0);
    });
  });

  describe("deduplicateFindingsFromData", () => {
    const findings: MinerFinding[] = [
      { message_id: "msg-1", content_type: "decision", confidence: 0.85, raw_content: "test", channel: "telegram", matched_patterns: [], created_at: "2026-03-15T10:00:00Z" },
      { message_id: "msg-2", content_type: "workflow", confidence: 0.8, raw_content: "test", channel: "telegram", matched_patterns: [], created_at: "2026-03-15T11:00:00Z" },
      { message_id: "msg-4", content_type: "policy", confidence: 0.9, raw_content: "test", channel: "telegram", matched_patterns: [], created_at: "2026-03-15T13:00:00Z" },
    ];

    it("filters out already-captured messages", () => {
      const existing = new Set(["msg-1", "msg-4"]);
      const { unique, duplicateCount } = deduplicateFindingsFromData(findings, existing);
      expect(unique).toHaveLength(1);
      expect(unique[0].message_id).toBe("msg-2");
      expect(duplicateCount).toBe(2);
    });

    it("keeps all when no duplicates", () => {
      const { unique, duplicateCount } = deduplicateFindingsFromData(findings, new Set());
      expect(unique).toHaveLength(3);
      expect(duplicateCount).toBe(0);
    });

    it("handles empty findings", () => {
      const { unique, duplicateCount } = deduplicateFindingsFromData([], new Set(["msg-1"]));
      expect(unique).toHaveLength(0);
      expect(duplicateCount).toBe(0);
    });
  });

  describe("queueFindings", () => {
    it("inserts findings into capture queue", async () => {
      const calls: any[] = [];
      const mockSql: any = function (...args: any[]) {
        calls.push(args);
        return Promise.resolve([]);
      };

      const findings: MinerFinding[] = [
        { message_id: "msg-1", content_type: "decision", confidence: 0.85, raw_content: "test decision", channel: "telegram", matched_patterns: [], created_at: "2026-03-15T10:00:00Z" },
        { message_id: "msg-2", content_type: "workflow", confidence: 0.8, raw_content: "test workflow", channel: "ellie-chat", matched_patterns: [], created_at: "2026-03-15T11:00:00Z" },
      ];

      const queued = await queueFindings(mockSql, findings);
      expect(queued).toBe(2);
      expect(calls).toHaveLength(2);
    });

    it("handles insert failures gracefully", async () => {
      let callCount = 0;
      const mockSql: any = function () {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error("Duplicate"));
        return Promise.resolve([]);
      };

      const findings: MinerFinding[] = [
        { message_id: "msg-1", content_type: "decision", confidence: 0.85, raw_content: "dup", channel: "telegram", matched_patterns: [], created_at: "2026-03-15T10:00:00Z" },
        { message_id: "msg-2", content_type: "workflow", confidence: 0.8, raw_content: "ok", channel: "telegram", matched_patterns: [], created_at: "2026-03-15T11:00:00Z" },
      ];

      const queued = await queueFindings(mockSql, findings);
      expect(queued).toBe(1); // First failed, second succeeded
    });

    it("returns 0 for empty findings", async () => {
      const mockSql: any = function () { return Promise.resolve([]); };
      expect(await queueFindings(mockSql, [])).toBe(0);
    });
  });

  describe("buildReport", () => {
    it("assembles report with all fields", () => {
      const findings: MinerFinding[] = [
        { message_id: "msg-1", content_type: "decision", confidence: 0.85, raw_content: "test", channel: "telegram", matched_patterns: ["decision_made"], created_at: "2026-03-15T10:00:00Z" },
      ];

      const report = buildReport(50, findings, 3, 1, 1234, "2026-03-09T00:00:00Z", "2026-03-16T00:00:00Z");
      expect(report.scanned_messages).toBe(50);
      expect(report.findings).toHaveLength(1);
      expect(report.duplicates_filtered).toBe(3);
      expect(report.queued).toBe(1);
      expect(report.scan_duration_ms).toBe(1234);
      expect(report.period_start).toBe("2026-03-09T00:00:00Z");
      expect(report.period_end).toBe("2026-03-16T00:00:00Z");
    });
  });

  describe("formatReportMessage", () => {
    it("formats non-empty report", () => {
      const findings: MinerFinding[] = [
        { message_id: "msg-1", content_type: "decision", confidence: 0.85, raw_content: "t", channel: "telegram", matched_patterns: [], created_at: "2026-03-15T10:00:00Z" },
        { message_id: "msg-2", content_type: "decision", confidence: 0.8, raw_content: "t", channel: "telegram", matched_patterns: [], created_at: "2026-03-15T11:00:00Z" },
        { message_id: "msg-3", content_type: "workflow", confidence: 0.9, raw_content: "t", channel: "telegram", matched_patterns: [], created_at: "2026-03-15T12:00:00Z" },
      ];

      const report = buildReport(100, findings, 5, 3, 500, "2026-03-09T00:00:00Z", "2026-03-16T00:00:00Z");
      const msg = formatReportMessage(report);

      expect(msg).toContain("Replay Scan Complete");
      expect(msg).toContain("100 messages");
      expect(msg).toContain("3 items");
      expect(msg).toContain("2 decisions");
      expect(msg).toContain("1 workflow");
      expect(msg).toContain("Duplicates filtered: 5");
      expect(msg).toContain("Queued for review: 3");
    });

    it("formats empty report", () => {
      const report = buildReport(50, [], 0, 0, 200, "2026-03-09T00:00:00Z", "2026-03-16T00:00:00Z");
      const msg = formatReportMessage(report);
      expect(msg).toContain("No new River-worthy content");
      expect(msg).toContain("50 messages");
    });
  });
});
