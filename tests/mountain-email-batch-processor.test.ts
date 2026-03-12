/**
 * Email Batch Processor Tests — ELLIE-672
 *
 * Tests sender parsing, newsletter detection, urgency detection,
 * thread collapsing, grouping, report formatting, GTD item building,
 * and the full EmailBatchProcessor pipeline.
 */

import { describe, test, expect } from "bun:test";
import {
  parseSender,
  isNewsletter,
  isUrgentEmail,
  processEmailRecord,
  groupBySender,
  collapseThreads,
  proposeAction,
  formatBatchReport,
  buildGtdItem,
  EmailBatchProcessor,
  InMemoryBatchStateStore,
  _makeMockEmailRecord,
  _makeMockFetcher as _makeMockEmailFetcher,
  _makeMockStateStore,
  type EmailGroup,
  type ProcessedEmail,
  type MountainEmailRecord,
} from "../src/mountain/email-batch-processor.ts";

// ── parseSender ──────────────────────────────────────────────

describe("parseSender", () => {
  test("parses 'Name <email>' format", () => {
    const result = parseSender("Alice Smith <alice@example.com>");
    expect(result.name).toBe("Alice Smith");
    expect(result.email).toBe("alice@example.com");
  });

  test("parses quoted name format", () => {
    const result = parseSender('"Bob Jones" <bob@test.com>');
    expect(result.name).toBe("Bob Jones");
    expect(result.email).toBe("bob@test.com");
  });

  test("parses bare angle bracket format", () => {
    const result = parseSender("<charlie@test.com>");
    expect(result.name).toBe("");
    expect(result.email).toBe("charlie@test.com");
  });

  test("parses 'email (Name)' format", () => {
    const result = parseSender("dave@test.com (Dave Wilson)");
    expect(result.name).toBe("Dave Wilson");
    expect(result.email).toBe("dave@test.com");
  });

  test("parses plain email", () => {
    const result = parseSender("plain@example.com");
    expect(result.name).toBe("");
    expect(result.email).toBe("plain@example.com");
  });

  test("lowercases email", () => {
    const result = parseSender("Alice <ALICE@EXAMPLE.COM>");
    expect(result.email).toBe("alice@example.com");
  });

  test("handles empty string", () => {
    const result = parseSender("");
    expect(result.name).toBe("");
    expect(result.email).toBe("");
  });
});

// ── isNewsletter ─────────────────────────────────────────────

describe("isNewsletter", () => {
  test("detects noreply sender", () => {
    expect(isNewsletter("noreply@github.com", "Your weekly report")).toBe(true);
  });

  test("detects no-reply sender", () => {
    expect(isNewsletter("no-reply@service.com", "Update")).toBe(true);
  });

  test("detects newsletter sender", () => {
    expect(isNewsletter("newsletter@company.com", "March edition")).toBe(true);
  });

  test("detects notifications sender", () => {
    expect(isNewsletter("notifications@slack.com", "New message")).toBe(true);
  });

  test("detects marketing sender", () => {
    expect(isNewsletter("marketing@brand.com", "Sale")).toBe(true);
  });

  test("detects unsubscribe in subject", () => {
    expect(isNewsletter("info@legit.com", "News — click to unsubscribe")).toBe(true);
  });

  test("detects weekly digest subject", () => {
    expect(isNewsletter("team@company.com", "Your Weekly Digest")).toBe(true);
  });

  test("does NOT flag normal senders", () => {
    expect(isNewsletter("alice@company.com", "Project update")).toBe(false);
  });

  test("does NOT flag personal emails", () => {
    expect(isNewsletter("dave@gmail.com", "Hey, lunch tomorrow?")).toBe(false);
  });
});

// ── isUrgentEmail ────────────────────────────────────────────

describe("isUrgentEmail", () => {
  test("detects urgent in subject", () => {
    expect(isUrgentEmail("URGENT: Server down", "")).toBe(true);
  });

  test("detects asap in subject", () => {
    expect(isUrgentEmail("Need this ASAP", "")).toBe(true);
  });

  test("detects action required in subject", () => {
    expect(isUrgentEmail("Action Required: Review PR", "")).toBe(true);
  });

  test("detects urgent keywords in snippet", () => {
    expect(isUrgentEmail("Update", "This is time-sensitive, please review")).toBe(true);
  });

  test("detects deadline in snippet", () => {
    expect(isUrgentEmail("Report", "The deadline is tomorrow")).toBe(true);
  });

  test("does NOT flag normal emails", () => {
    expect(isUrgentEmail("Weekly sync notes", "Here are the notes from today")).toBe(false);
  });

  test("case insensitive", () => {
    expect(isUrgentEmail("this is CRITICAL", "")).toBe(true);
  });
});

// ── processEmailRecord ───────────────────────────────────────

describe("processEmailRecord", () => {
  test("processes a full email record", () => {
    const record = _makeMockEmailRecord({
      payload: {
        subject: "Meeting tomorrow",
        from: "Bob <bob@test.com>",
        snippet: "Let's discuss the project",
        threadId: "thread-abc",
        type: "gmail",
      },
    });

    const result = processEmailRecord(record);
    expect(result.subject).toBe("Meeting tomorrow");
    expect(result.senderName).toBe("Bob");
    expect(result.senderEmail).toBe("bob@test.com");
    expect(result.snippet).toBe("Let's discuss the project");
    expect(result.threadId).toBe("thread-abc");
    expect(result.isUrgent).toBe(false);
  });

  test("flags urgent emails", () => {
    const record = _makeMockEmailRecord({
      payload: {
        subject: "URGENT: Production issue",
        from: "ops@company.com",
        snippet: "Server is down",
        type: "gmail",
      },
    });

    expect(processEmailRecord(record).isUrgent).toBe(true);
  });

  test("handles missing fields gracefully", () => {
    const record = _makeMockEmailRecord({
      payload: { type: "gmail" },
      summary: null,
    });

    const result = processEmailRecord(record);
    expect(result.subject).toBe("(no subject)");
    expect(result.senderEmail).toBe("");
    expect(result.snippet).toBe("");
    expect(result.threadId).toBeNull();
  });

  test("truncates long snippets", () => {
    const record = _makeMockEmailRecord({
      payload: {
        subject: "Long email",
        from: "a@b.com",
        snippet: "X".repeat(500),
        type: "gmail",
      },
    });

    expect(processEmailRecord(record).snippet.length).toBeLessThanOrEqual(300);
  });
});

// ── groupBySender ────────────────────────────────────────────

describe("groupBySender", () => {
  function makeProcessed(email: string, subject = "Test"): ProcessedEmail {
    return {
      recordId: crypto.randomUUID(),
      externalId: `gmail:${crypto.randomUUID().slice(0, 8)}`,
      subject,
      from: `${email}`,
      senderEmail: email,
      senderName: "",
      snippet: "Test",
      threadId: null,
      receivedAt: new Date(),
      isUrgent: false,
    };
  }

  test("groups emails from same sender", () => {
    const emails = [
      makeProcessed("alice@test.com", "Subject 1"),
      makeProcessed("alice@test.com", "Subject 2"),
      makeProcessed("bob@test.com", "Subject 3"),
    ];

    const groups = groupBySender(emails);
    expect(groups.size).toBe(2);
    expect(groups.get("alice@test.com")).toHaveLength(2);
    expect(groups.get("bob@test.com")).toHaveLength(1);
  });

  test("handles empty input", () => {
    expect(groupBySender([]).size).toBe(0);
  });

  test("single email per sender", () => {
    const emails = [
      makeProcessed("a@test.com"),
      makeProcessed("b@test.com"),
      makeProcessed("c@test.com"),
    ];

    const groups = groupBySender(emails);
    expect(groups.size).toBe(3);
  });
});

// ── collapseThreads ──────────────────────────────────────────

describe("collapseThreads", () => {
  function makeThreadEmail(
    threadId: string | null,
    receivedAt: Date,
    subject = "Test",
  ): ProcessedEmail {
    return {
      recordId: crypto.randomUUID(),
      externalId: `gmail:${crypto.randomUUID().slice(0, 8)}`,
      subject,
      from: "test@test.com",
      senderEmail: "test@test.com",
      senderName: "Test",
      snippet: "Test snippet",
      threadId,
      receivedAt,
      isUrgent: false,
    };
  }

  test("collapses emails in the same thread", () => {
    const emails = [
      makeThreadEmail("thread-1", new Date("2026-03-10T10:00:00Z"), "First"),
      makeThreadEmail("thread-1", new Date("2026-03-10T12:00:00Z"), "Reply"),
      makeThreadEmail("thread-1", new Date("2026-03-10T11:00:00Z"), "Middle"),
    ];

    const { collapsed, merged } = collapseThreads(emails);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].subject).toBe("Reply"); // Most recent
    expect(merged).toBe(2);
  });

  test("keeps emails without threadId separate", () => {
    const emails = [
      makeThreadEmail(null, new Date("2026-03-10T10:00:00Z"), "Email A"),
      makeThreadEmail(null, new Date("2026-03-10T11:00:00Z"), "Email B"),
    ];

    const { collapsed, merged } = collapseThreads(emails);
    expect(collapsed).toHaveLength(2);
    expect(merged).toBe(0);
  });

  test("handles mixed threaded and unthreaded", () => {
    const emails = [
      makeThreadEmail("thread-1", new Date("2026-03-10T10:00:00Z")),
      makeThreadEmail("thread-1", new Date("2026-03-10T12:00:00Z")),
      makeThreadEmail(null, new Date("2026-03-10T11:00:00Z")),
      makeThreadEmail("thread-2", new Date("2026-03-10T09:00:00Z")),
    ];

    const { collapsed, merged } = collapseThreads(emails);
    expect(collapsed).toHaveLength(3); // 1 unthreaded + thread-1 + thread-2
    expect(merged).toBe(1);
  });

  test("handles empty input", () => {
    const { collapsed, merged } = collapseThreads([]);
    expect(collapsed).toHaveLength(0);
    expect(merged).toBe(0);
  });
});

// ── proposeAction ────────────────────────────────────────────

describe("proposeAction", () => {
  function makeGroup(overrides: Partial<EmailGroup> = {}): EmailGroup {
    return {
      sender: "Test",
      senderEmail: "test@test.com",
      emails: [{
        recordId: "1",
        externalId: "gmail:1",
        subject: "Test",
        from: "test@test.com",
        senderEmail: "test@test.com",
        senderName: "Test",
        snippet: "Test snippet content here",
        threadId: null,
        receivedAt: new Date(),
        isUrgent: false,
      }],
      isUrgent: false,
      threadCount: 1,
      proposedAction: "",
      ...overrides,
    };
  }

  test("urgent group gets 'Reply/act today'", () => {
    expect(proposeAction(makeGroup({ isUrgent: true }))).toBe("Reply/act today");
  });

  test("group with many emails gets 'Review thread and decide'", () => {
    const emails = Array.from({ length: 4 }, () => makeGroup().emails[0]);
    expect(proposeAction(makeGroup({ emails }))).toBe("Review thread and decide");
  });

  test("single short email gets 'Quick reply or archive'", () => {
    const emails = [{
      ...makeGroup().emails[0],
      snippet: "OK",
    }];
    expect(proposeAction(makeGroup({ emails }))).toBe("Quick reply or archive");
  });

  test("default is 'Review and respond'", () => {
    const emails = [{
      ...makeGroup().emails[0],
      snippet: "This is a longer snippet that exceeds fifty characters in length for proper testing of the default action",
    }];
    expect(proposeAction(makeGroup({ emails }))).toBe("Review and respond");
  });
});

// ── formatBatchReport ────────────────────────────────────────

describe("formatBatchReport", () => {
  test("formats empty result", () => {
    const report = formatBatchReport({
      processedCount: 0,
      groupCount: 0,
      skippedNewsletters: 0,
      urgentCount: 0,
      threadsMerged: 0,
      report: "",
      groups: [],
    });

    expect(report).toContain("Email Batch Report");
    expect(report).toContain("0 emails processed");
  });

  test("includes urgent section", () => {
    const urgentGroup: EmailGroup = {
      sender: "Boss",
      senderEmail: "boss@company.com",
      emails: [{
        recordId: "1",
        externalId: "gmail:1",
        subject: "URGENT: Deploy now",
        from: "boss@company.com",
        senderEmail: "boss@company.com",
        senderName: "Boss",
        snippet: "Deploy ASAP",
        threadId: null,
        receivedAt: new Date(),
        isUrgent: true,
      }],
      isUrgent: true,
      threadCount: 1,
      proposedAction: "Reply/act today",
    };

    const report = formatBatchReport({
      processedCount: 1,
      groupCount: 1,
      skippedNewsletters: 0,
      urgentCount: 1,
      threadsMerged: 0,
      report: "",
      groups: [urgentGroup],
    });

    expect(report).toContain("URGENT (1)");
    expect(report).toContain("[URGENT]");
    expect(report).toContain("Boss");
  });

  test("includes thread merge note", () => {
    const report = formatBatchReport({
      processedCount: 5,
      groupCount: 2,
      skippedNewsletters: 1,
      urgentCount: 0,
      threadsMerged: 3,
      report: "",
      groups: [],
    });

    expect(report).toContain("3 thread messages collapsed");
  });

  test("shows newsletter skip count", () => {
    const report = formatBatchReport({
      processedCount: 10,
      groupCount: 3,
      skippedNewsletters: 7,
      urgentCount: 0,
      threadsMerged: 0,
      report: "",
      groups: [],
    });

    expect(report).toContain("7 newsletters skipped");
  });
});

// ── buildGtdItem ─────────────────────────────────────────────

describe("buildGtdItem", () => {
  test("builds item for single email", () => {
    const group: EmailGroup = {
      sender: "Alice",
      senderEmail: "alice@test.com",
      emails: [{
        recordId: "rec-123",
        externalId: "gmail:msg-abc",
        subject: "Project update",
        from: "Alice <alice@test.com>",
        senderEmail: "alice@test.com",
        senderName: "Alice",
        snippet: "Here's the update",
        threadId: null,
        receivedAt: new Date(),
        isUrgent: false,
      }],
      isUrgent: false,
      threadCount: 1,
      proposedAction: "Review and respond",
    };

    const item = buildGtdItem(group);
    expect(item.content).toContain("Email from Alice");
    expect(item.content).toContain("Project update");
    expect(item.source_type).toBe("email");
    expect(item.source_ref).toBe("mountain:rec-123");
    expect(item.tags).toContain("@email");
    expect(item.priority).toBeNull();
  });

  test("builds item for multiple emails", () => {
    const group: EmailGroup = {
      sender: "Bob",
      senderEmail: "bob@test.com",
      emails: [
        {
          recordId: "rec-1",
          externalId: "gmail:1",
          subject: "First",
          from: "bob@test.com",
          senderEmail: "bob@test.com",
          senderName: "Bob",
          snippet: "",
          threadId: null,
          receivedAt: new Date(),
          isUrgent: false,
        },
        {
          recordId: "rec-2",
          externalId: "gmail:2",
          subject: "Second",
          from: "bob@test.com",
          senderEmail: "bob@test.com",
          senderName: "Bob",
          snippet: "",
          threadId: null,
          receivedAt: new Date(),
          isUrgent: false,
        },
      ],
      isUrgent: false,
      threadCount: 2,
      proposedAction: "Review and respond",
    };

    const item = buildGtdItem(group);
    expect(item.content).toContain("2 emails from Bob");
    expect(item.content).toContain("First; Second");
  });

  test("adds urgent tag and high priority for urgent groups", () => {
    const group: EmailGroup = {
      sender: "Ops",
      senderEmail: "ops@company.com",
      emails: [{
        recordId: "rec-urgent",
        externalId: "gmail:urgent",
        subject: "Server down",
        from: "ops@company.com",
        senderEmail: "ops@company.com",
        senderName: "Ops",
        snippet: "",
        threadId: null,
        receivedAt: new Date(),
        isUrgent: true,
      }],
      isUrgent: true,
      threadCount: 1,
      proposedAction: "Reply/act today",
    };

    const item = buildGtdItem(group);
    expect(item.priority).toBe("high");
    expect(item.tags).toContain("@urgent");
    expect(item.tags).toContain("@email");
  });

  test("truncates long content to 2000 chars", () => {
    const group: EmailGroup = {
      sender: "Verbose",
      senderEmail: "verbose@test.com",
      emails: Array.from({ length: 50 }, (_, i) => ({
        recordId: `rec-${i}`,
        externalId: `gmail:${i}`,
        subject: `Subject number ${i} with a very long title that goes on and on`,
        from: "verbose@test.com",
        senderEmail: "verbose@test.com",
        senderName: "Verbose",
        snippet: "",
        threadId: null,
        receivedAt: new Date(),
        isUrgent: false,
      })),
      isUrgent: false,
      threadCount: 50,
      proposedAction: "Review thread and decide",
    };

    const item = buildGtdItem(group);
    expect(item.content.length).toBeLessThanOrEqual(2000);
  });
});

// ── Mock Helpers ─────────────────────────────────────────────

describe("mock helpers", () => {
  test("_makeMockEmailRecord creates valid record", () => {
    const record = _makeMockEmailRecord();
    expect(record.id).toBeDefined();
    expect(record.external_id).toMatch(/^gmail:msg-/);
    expect(record.payload.subject).toBe("Test email subject");
    expect(record.payload.from).toBe("Alice Smith <alice@example.com>");
  });

  test("_makeMockEmailRecord accepts overrides", () => {
    const record = _makeMockEmailRecord({
      payload: {
        subject: "Custom subject",
        from: "bob@test.com",
        type: "gmail",
      },
    });
    expect(record.payload.subject).toBe("Custom subject");
  });

  test("_makeMockEmailFetcher returns provided records", async () => {
    const records = [_makeMockEmailRecord(), _makeMockEmailRecord()];
    const fetcher = _makeMockEmailFetcher(records);
    const result = await fetcher(new Date());
    expect(result).toHaveLength(2);
  });

  test("_makeMockStateStore tracks state", async () => {
    const store = _makeMockStateStore(null);
    expect(await store.getLastProcessedAt()).toBeNull();

    const now = new Date();
    await store.setLastProcessedAt(now);
    expect(await store.getLastProcessedAt()).toBe(now);
    expect(store.stored).toBe(now);
  });
});

// ── InMemoryBatchStateStore ──────────────────────────────────

describe("InMemoryBatchStateStore", () => {
  test("starts with null", async () => {
    const store = new InMemoryBatchStateStore();
    expect(await store.getLastProcessedAt()).toBeNull();
  });

  test("stores and retrieves date", async () => {
    const store = new InMemoryBatchStateStore();
    const date = new Date("2026-03-12T08:00:00Z");
    await store.setLastProcessedAt(date);
    expect(await store.getLastProcessedAt()).toEqual(date);
  });
});

// ── EmailBatchProcessor ──────────────────────────────────────

describe("EmailBatchProcessor", () => {
  test("returns empty result when no emails", async () => {
    const processor = new EmailBatchProcessor({
      fetchEmailRecords: _makeMockEmailFetcher([]),
      stateStore: _makeMockStateStore(null),
    });

    const result = await processor.run();
    expect(result.processedCount).toBe(0);
    expect(result.groupCount).toBe(0);
    expect(result.report).toBe("No new emails since last batch.");
  });

  test("processes emails and groups by sender", async () => {
    const records = [
      _makeMockEmailRecord({ payload: { subject: "Hello", from: "Alice <alice@test.com>", snippet: "Hi", type: "gmail" } }),
      _makeMockEmailRecord({ payload: { subject: "Follow up", from: "Alice <alice@test.com>", snippet: "Following up", type: "gmail" } }),
      _makeMockEmailRecord({ payload: { subject: "Invoice", from: "Bob <bob@test.com>", snippet: "Attached", type: "gmail" } }),
    ];

    const processor = new EmailBatchProcessor({
      fetchEmailRecords: _makeMockEmailFetcher(records),
      stateStore: _makeMockStateStore(null),
    });

    const result = await processor.run();
    expect(result.processedCount).toBe(3);
    expect(result.groupCount).toBe(2);
    expect(result.groups.find((g) => g.senderEmail === "alice@test.com")?.emails).toHaveLength(2);
    expect(result.groups.find((g) => g.senderEmail === "bob@test.com")?.emails).toHaveLength(1);
  });

  test("filters out newsletters", async () => {
    const records = [
      _makeMockEmailRecord({ payload: { subject: "Real email", from: "alice@test.com", snippet: "Hi", type: "gmail" } }),
      _makeMockEmailRecord({ payload: { subject: "Your digest", from: "noreply@github.com", snippet: "Updates", type: "gmail" } }),
      _makeMockEmailRecord({ payload: { subject: "Weekly Newsletter", from: "newsletter@brand.com", snippet: "Deals", type: "gmail" } }),
    ];

    const processor = new EmailBatchProcessor({
      fetchEmailRecords: _makeMockEmailFetcher(records),
      stateStore: _makeMockStateStore(null),
    });

    const result = await processor.run();
    expect(result.processedCount).toBe(3);
    expect(result.skippedNewsletters).toBe(2);
    expect(result.groupCount).toBe(1);
  });

  test("flags urgent emails", async () => {
    const records = [
      _makeMockEmailRecord({ payload: { subject: "URGENT: Server down", from: "ops@company.com", snippet: "Fix now", type: "gmail" } }),
      _makeMockEmailRecord({ payload: { subject: "Lunch plans", from: "friend@gmail.com", snippet: "Thai?", type: "gmail" } }),
    ];

    const processor = new EmailBatchProcessor({
      fetchEmailRecords: _makeMockEmailFetcher(records),
      stateStore: _makeMockStateStore(null),
    });

    const result = await processor.run();
    expect(result.urgentCount).toBe(1);
    expect(result.groups[0].isUrgent).toBe(true); // Urgent sorted first
    expect(result.groups[0].senderEmail).toBe("ops@company.com");
  });

  test("collapses threads within sender groups", async () => {
    const threadId = "thread-shared";
    const records = [
      _makeMockEmailRecord({
        payload: { subject: "Thread msg 1", from: "alice@test.com", snippet: "First", threadId, type: "gmail" },
        source_timestamp: new Date("2026-03-10T10:00:00Z"),
      }),
      _makeMockEmailRecord({
        payload: { subject: "Thread msg 2", from: "alice@test.com", snippet: "Second", threadId, type: "gmail" },
        source_timestamp: new Date("2026-03-10T12:00:00Z"),
      }),
      _makeMockEmailRecord({
        payload: { subject: "Thread msg 3", from: "alice@test.com", snippet: "Third", threadId, type: "gmail" },
        source_timestamp: new Date("2026-03-10T11:00:00Z"),
      }),
    ];

    const processor = new EmailBatchProcessor({
      fetchEmailRecords: _makeMockEmailFetcher(records),
      stateStore: _makeMockStateStore(null),
    });

    const result = await processor.run();
    expect(result.threadsMerged).toBe(2);
    expect(result.groups[0].emails).toHaveLength(1);
    expect(result.groups[0].emails[0].subject).toBe("Thread msg 2"); // Most recent
  });

  test("sorts urgent groups first", async () => {
    const records = [
      _makeMockEmailRecord({ payload: { subject: "Normal email", from: "a@test.com", snippet: "Hi", type: "gmail" } }),
      _makeMockEmailRecord({ payload: { subject: "Also normal", from: "a@test.com", snippet: "Ho", type: "gmail" } }),
      _makeMockEmailRecord({ payload: { subject: "URGENT fix", from: "b@test.com", snippet: "Now", type: "gmail" } }),
    ];

    const processor = new EmailBatchProcessor({
      fetchEmailRecords: _makeMockEmailFetcher(records),
      stateStore: _makeMockStateStore(null),
    });

    const result = await processor.run();
    expect(result.groups[0].isUrgent).toBe(true);
    expect(result.groups[0].senderEmail).toBe("b@test.com");
  });

  test("updates state store after run", async () => {
    const store = _makeMockStateStore(null);
    const processor = new EmailBatchProcessor({
      fetchEmailRecords: _makeMockEmailFetcher([]),
      stateStore: store,
    });

    await processor.run();
    expect(store.stored).not.toBeNull();
    expect(store.stored!.getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  test("uses lastProcessedAt for fetching", async () => {
    const lastRun = new Date("2026-03-11T00:00:00Z");
    let capturedSince: Date | null = null;

    const processor = new EmailBatchProcessor({
      fetchEmailRecords: async (since) => {
        capturedSince = since;
        return [];
      },
      stateStore: _makeMockStateStore(lastRun),
    });

    await processor.run();
    expect(capturedSince).toEqual(lastRun);
  });

  test("defaults to 8 hours ago when no state", async () => {
    let capturedSince: Date | null = null;
    const beforeRun = Date.now();

    const processor = new EmailBatchProcessor({
      fetchEmailRecords: async (since) => {
        capturedSince = since;
        return [];
      },
      stateStore: _makeMockStateStore(null),
    });

    await processor.run();
    expect(capturedSince).not.toBeNull();
    const diff = beforeRun - capturedSince!.getTime();
    // Should be approximately 8 hours (within 1 second tolerance)
    expect(diff).toBeGreaterThan(7.99 * 3600_000);
    expect(diff).toBeLessThan(8.01 * 3600_000);
  });

  test("generates formatted report", async () => {
    const records = [
      _makeMockEmailRecord({ payload: { subject: "Project plan", from: "Alice <alice@test.com>", snippet: "Here it is", type: "gmail" } }),
    ];

    const processor = new EmailBatchProcessor({
      fetchEmailRecords: _makeMockEmailFetcher(records),
      stateStore: _makeMockStateStore(null),
    });

    const result = await processor.run();
    expect(result.report).toContain("Email Batch Report");
    expect(result.report).toContain("1 emails processed");
    expect(result.report).toContain("Alice");
    expect(result.report).toContain("Project plan");
  });

  test("buildGtdItems creates items for all groups", () => {
    const groups: EmailGroup[] = [
      {
        sender: "Alice",
        senderEmail: "alice@test.com",
        emails: [{
          recordId: "rec-1",
          externalId: "gmail:1",
          subject: "Task A",
          from: "alice@test.com",
          senderEmail: "alice@test.com",
          senderName: "Alice",
          snippet: "",
          threadId: null,
          receivedAt: new Date(),
          isUrgent: false,
        }],
        isUrgent: false,
        threadCount: 1,
        proposedAction: "Review",
      },
      {
        sender: "Bob",
        senderEmail: "bob@test.com",
        emails: [{
          recordId: "rec-2",
          externalId: "gmail:2",
          subject: "Task B",
          from: "bob@test.com",
          senderEmail: "bob@test.com",
          senderName: "Bob",
          snippet: "",
          threadId: null,
          receivedAt: new Date(),
          isUrgent: true,
        }],
        isUrgent: true,
        threadCount: 1,
        proposedAction: "Reply/act today",
      },
    ];

    const processor = new EmailBatchProcessor({
      fetchEmailRecords: _makeMockEmailFetcher([]),
      stateStore: _makeMockStateStore(null),
    });

    const items = processor.buildGtdItems(groups);
    expect(items).toHaveLength(2);
    expect(items[0].source_ref).toBe("mountain:rec-1");
    expect(items[1].priority).toBe("high");
  });
});

// ── E2E ──────────────────────────────────────────────────────

describe("E2E: full batch pipeline", () => {
  test("processes mixed emails: newsletters, urgent, threads, normal", async () => {
    const sharedThread = "thread-work";
    const records: MountainEmailRecord[] = [
      // Newsletter — should be skipped
      _makeMockEmailRecord({
        payload: { subject: "Weekly Digest", from: "noreply@service.com", snippet: "Your updates", type: "gmail" },
      }),
      // Urgent email
      _makeMockEmailRecord({
        payload: { subject: "URGENT: Client escalation", from: "Manager <mgr@company.com>", snippet: "Handle ASAP", type: "gmail" },
      }),
      // Thread: 3 messages from same sender, same thread
      _makeMockEmailRecord({
        payload: { subject: "Project plan", from: "Alice <alice@work.com>", snippet: "Draft attached", threadId: sharedThread, type: "gmail" },
        source_timestamp: new Date("2026-03-10T09:00:00Z"),
      }),
      _makeMockEmailRecord({
        payload: { subject: "Re: Project plan", from: "Alice <alice@work.com>", snippet: "Updated version", threadId: sharedThread, type: "gmail" },
        source_timestamp: new Date("2026-03-10T14:00:00Z"),
      }),
      _makeMockEmailRecord({
        payload: { subject: "Re: Re: Project plan", from: "Alice <alice@work.com>", snippet: "Final version", threadId: sharedThread, type: "gmail" },
        source_timestamp: new Date("2026-03-10T11:00:00Z"),
      }),
      // Normal single email
      _makeMockEmailRecord({
        payload: { subject: "Lunch tomorrow?", from: "Friend <friend@gmail.com>", snippet: "Thai place?", type: "gmail" },
      }),
      // Another newsletter
      _makeMockEmailRecord({
        payload: { subject: "Click to unsubscribe from updates", from: "marketing@brand.com", snippet: "Big sale", type: "gmail" },
      }),
    ];

    const store = _makeMockStateStore(null);
    const processor = new EmailBatchProcessor({
      fetchEmailRecords: _makeMockEmailFetcher(records),
      stateStore: store,
    });

    const result = await processor.run();

    // 7 total, 2 newsletters skipped
    expect(result.processedCount).toBe(7);
    expect(result.skippedNewsletters).toBe(2);

    // 3 sender groups: manager (urgent), alice (thread collapsed), friend
    expect(result.groupCount).toBe(3);

    // 1 urgent
    expect(result.urgentCount).toBe(1);

    // 2 thread messages collapsed (3 in thread → 1 kept)
    expect(result.threadsMerged).toBe(2);

    // Urgent first
    expect(result.groups[0].isUrgent).toBe(true);
    expect(result.groups[0].senderEmail).toBe("mgr@company.com");

    // Alice's thread collapsed to latest message
    const aliceGroup = result.groups.find((g) => g.senderEmail === "alice@work.com");
    expect(aliceGroup).toBeDefined();
    expect(aliceGroup!.emails).toHaveLength(1);
    expect(aliceGroup!.emails[0].subject).toBe("Re: Project plan"); // 14:00 is latest

    // Report has content
    expect(result.report).toContain("Email Batch Report");
    expect(result.report).toContain("URGENT");
    expect(result.report).toContain("2 thread messages collapsed");

    // State updated
    expect(store.stored).not.toBeNull();

    // GTD items build correctly
    const gtdItems = processor.buildGtdItems(result.groups);
    expect(gtdItems).toHaveLength(3);
    expect(gtdItems[0].priority).toBe("high"); // Urgent group
    expect(gtdItems[0].tags).toContain("@urgent");
    expect(gtdItems.every((i) => i.source_type === "email")).toBe(true);
    expect(gtdItems.every((i) => i.source_ref.startsWith("mountain:"))).toBe(true);
  });
});
