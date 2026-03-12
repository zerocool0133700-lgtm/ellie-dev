/**
 * Email Batch Processor — ELLIE-672
 *
 * Scans Mountain email records, groups by sender, filters newsletters,
 * flags urgent items, groups threads, and generates summary reports
 * for GTD inbox creation.
 *
 * Scheduled 3x daily: 8:00 AM, 12:30 PM, 5:00 PM CST.
 * All external dependencies are injectable for testability.
 */

import { log } from "../logger.ts";

const logger = log.child("email-batch");

// ── Types ────────────────────────────────────────────────────

export interface MountainEmailRecord {
  id: string;
  external_id: string;
  payload: {
    subject?: string;
    from?: string;
    content?: string;
    threadId?: string;
    snippet?: string;
    type?: string;
    [key: string]: unknown;
  };
  summary: string | null;
  source_timestamp: Date | null;
  created_at: Date;
}

export interface ProcessedEmail {
  recordId: string;
  externalId: string;
  subject: string;
  from: string;
  senderEmail: string;
  senderName: string;
  snippet: string;
  threadId: string | null;
  receivedAt: Date;
  isUrgent: boolean;
}

export interface EmailGroup {
  sender: string;
  senderEmail: string;
  emails: ProcessedEmail[];
  isUrgent: boolean;
  threadCount: number;
  proposedAction: string;
}

export interface BatchResult {
  processedCount: number;
  groupCount: number;
  skippedNewsletters: number;
  urgentCount: number;
  threadsMerged: number;
  report: string;
  groups: EmailGroup[];
}

export interface GtdInboxItem {
  content: string;
  priority: "high" | "medium" | "low" | null;
  tags: string[];
  source_type: string;
  source_ref: string;
}

export interface BatchProcessorDeps {
  /** Fetch email records from mountain_records since a given date. */
  fetchEmailRecords: EmailRecordFetcher;
  /** Get/set the last processed timestamp. */
  stateStore: BatchStateStore;
}

export type EmailRecordFetcher = (
  since: Date,
  limit?: number,
) => Promise<MountainEmailRecord[]>;

export interface BatchStateStore {
  getLastProcessedAt(): Promise<Date | null>;
  setLastProcessedAt(at: Date): Promise<void>;
}

// ── Constants ────────────────────────────────────────────────

/** Sender patterns that indicate newsletters/automated mail. */
export const NEWSLETTER_SENDER_PATTERNS: RegExp[] = [
  /noreply@/i,
  /no-reply@/i,
  /no\.reply@/i,
  /newsletter@/i,
  /updates@/i,
  /notifications?@/i,
  /digest@/i,
  /mailer-daemon@/i,
  /postmaster@/i,
  /donotreply@/i,
  /automated@/i,
  /marketing@/i,
  /promo@/i,
];

/** Subject patterns that indicate newsletters. */
export const NEWSLETTER_SUBJECT_PATTERNS: RegExp[] = [
  /unsubscribe/i,
  /weekly digest/i,
  /daily digest/i,
  /newsletter/i,
  /subscription/i,
];

/** Keywords in subject/content that suggest urgency. */
export const URGENT_KEYWORDS: string[] = [
  "urgent",
  "asap",
  "immediately",
  "time-sensitive",
  "action required",
  "critical",
  "deadline",
  "overdue",
  "past due",
];

// ── Utility Functions ────────────────────────────────────────

/**
 * Parse a "From" header into name and email parts.
 * Handles: "Alice Smith <alice@example.com>", "alice@example.com",
 * "<alice@example.com>", "alice@example.com (Alice Smith)"
 */
export function parseSender(from: string): { name: string; email: string } {
  if (!from) return { name: "", email: "" };

  // "Name <email>" format
  const angleMatch = from.match(/^(.+?)\s*<([^>]+)>/);
  if (angleMatch) {
    return { name: angleMatch[1].trim().replace(/^"|"$/g, ""), email: angleMatch[2].trim().toLowerCase() };
  }

  // "<email>" format
  const bareAngleMatch = from.match(/^<([^>]+)>/);
  if (bareAngleMatch) {
    return { name: "", email: bareAngleMatch[1].trim().toLowerCase() };
  }

  // "email (Name)" format
  const parenMatch = from.match(/^([^\s(]+)\s*\(([^)]+)\)/);
  if (parenMatch) {
    return { name: parenMatch[2].trim(), email: parenMatch[1].trim().toLowerCase() };
  }

  // Plain email
  return { name: "", email: from.trim().toLowerCase() };
}

/**
 * Detect if a sender is a newsletter/automated source.
 */
export function isNewsletter(
  senderEmail: string,
  subject: string,
): boolean {
  for (const pattern of NEWSLETTER_SENDER_PATTERNS) {
    if (pattern.test(senderEmail)) return true;
  }
  for (const pattern of NEWSLETTER_SUBJECT_PATTERNS) {
    if (pattern.test(subject)) return true;
  }
  return false;
}

/**
 * Detect if an email is urgent based on subject and content.
 */
export function isUrgentEmail(subject: string, snippet: string): boolean {
  const text = `${subject} ${snippet}`.toLowerCase();
  return URGENT_KEYWORDS.some((kw) => text.includes(kw));
}

/**
 * Process a raw Mountain email record into a ProcessedEmail.
 */
export function processEmailRecord(record: MountainEmailRecord): ProcessedEmail {
  const from = record.payload.from ?? "";
  const subject = record.payload.subject ?? "(no subject)";
  const snippet = record.payload.snippet ?? record.payload.content ?? record.summary ?? "";
  const { name, email } = parseSender(from);

  return {
    recordId: record.id,
    externalId: record.external_id,
    subject,
    from,
    senderEmail: email,
    senderName: name,
    snippet: typeof snippet === "string" ? snippet.slice(0, 300) : "",
    threadId: (record.payload.threadId as string) ?? null,
    receivedAt: record.source_timestamp ?? record.created_at,
    isUrgent: isUrgentEmail(subject, typeof snippet === "string" ? snippet : ""),
  };
}

/**
 * Group processed emails by sender email.
 */
export function groupBySender(emails: ProcessedEmail[]): Map<string, ProcessedEmail[]> {
  const groups = new Map<string, ProcessedEmail[]>();
  for (const email of emails) {
    const key = email.senderEmail || email.from;
    const list = groups.get(key) ?? [];
    list.push(email);
    groups.set(key, list);
  }
  return groups;
}

/**
 * Collapse threads within a sender group — keep only the latest
 * message per threadId and count how many were merged.
 */
export function collapseThreads(
  emails: ProcessedEmail[],
): { collapsed: ProcessedEmail[]; merged: number } {
  const byThread = new Map<string, ProcessedEmail>();
  const noThread: ProcessedEmail[] = [];
  let merged = 0;

  for (const email of emails) {
    if (!email.threadId) {
      noThread.push(email);
      continue;
    }

    const existing = byThread.get(email.threadId);
    if (existing) {
      // Keep the more recent one
      if (email.receivedAt > existing.receivedAt) {
        byThread.set(email.threadId, email);
      }
      merged++;
    } else {
      byThread.set(email.threadId, email);
    }
  }

  return {
    collapsed: [...noThread, ...byThread.values()],
    merged,
  };
}

/**
 * Propose a GTD action for an email group.
 */
export function proposeAction(group: EmailGroup): string {
  if (group.isUrgent) {
    return "Reply/act today";
  }
  if (group.emails.length > 3) {
    return "Review thread and decide";
  }
  if (group.emails.length === 1 && group.emails[0].snippet.length < 50) {
    return "Quick reply or archive";
  }
  return "Review and respond";
}

// ── Report Formatting ────────────────────────────────────────

/**
 * Format a batch result into a human-readable report.
 */
export function formatBatchReport(result: BatchResult): string {
  const lines: string[] = [];
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", { timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit" });

  lines.push(`Email Batch Report — ${timeStr} CST`);
  lines.push(`${result.processedCount} emails processed, ${result.groupCount} senders, ${result.skippedNewsletters} newsletters skipped`);

  if (result.urgentCount > 0) {
    lines.push(`\nURGENT (${result.urgentCount}):`);
    for (const group of result.groups.filter((g) => g.isUrgent)) {
      lines.push(formatGroupLine(group));
    }
  }

  const normalGroups = result.groups.filter((g) => !g.isUrgent);
  if (normalGroups.length > 0) {
    lines.push(`\nTo Review (${normalGroups.length}):`);
    for (const group of normalGroups) {
      lines.push(formatGroupLine(group));
    }
  }

  if (result.threadsMerged > 0) {
    lines.push(`\n(${result.threadsMerged} thread messages collapsed)`);
  }

  return lines.join("\n");
}

function formatGroupLine(group: EmailGroup): string {
  const name = group.sender || group.senderEmail;
  const count = group.emails.length;
  const subjects = group.emails
    .slice(0, 3)
    .map((e) => e.subject)
    .join("; ");
  const threadNote = group.threadCount > 1 ? ` (${group.threadCount} threads)` : "";
  const urgentTag = group.isUrgent ? " [URGENT]" : "";

  return `  ${name} (${count})${threadNote}${urgentTag}: ${subjects} — ${group.proposedAction}`;
}

// ── GTD Item Builder ─────────────────────────────────────────

/**
 * Build a GTD inbox item from an email group.
 */
export function buildGtdItem(group: EmailGroup): GtdInboxItem {
  const subjects = group.emails.map((e) => e.subject).join("; ");
  const name = group.sender || group.senderEmail;
  const count = group.emails.length;
  const content = count === 1
    ? `Email from ${name}: ${subjects}`
    : `${count} emails from ${name}: ${subjects}`;

  const tags = ["@email"];
  if (group.isUrgent) tags.push("@urgent");

  return {
    content: content.slice(0, 2000),
    priority: group.isUrgent ? "high" : null,
    tags,
    source_type: "email",
    source_ref: `mountain:${group.emails[0].recordId}`,
  };
}

// ── Batch Processor ──────────────────────────────────────────

export class EmailBatchProcessor {
  private deps: BatchProcessorDeps;

  constructor(deps: BatchProcessorDeps) {
    this.deps = deps;
  }

  /**
   * Run a batch scan: fetch new emails, group, filter, format report.
   */
  async run(limit = 200): Promise<BatchResult> {
    const lastProcessed = await this.deps.stateStore.getLastProcessedAt();
    const since = lastProcessed ?? new Date(Date.now() - 8 * 3600_000); // Default: last 8 hours

    logger.info("Batch run starting", { since: since.toISOString(), limit });

    const records = await this.deps.fetchEmailRecords(since, limit);
    logger.info("Fetched email records", { count: records.length });

    if (records.length === 0) {
      const emptyResult: BatchResult = {
        processedCount: 0,
        groupCount: 0,
        skippedNewsletters: 0,
        urgentCount: 0,
        threadsMerged: 0,
        report: "No new emails since last batch.",
        groups: [],
      };
      await this.deps.stateStore.setLastProcessedAt(new Date());
      return emptyResult;
    }

    // Process all records
    const processed = records.map(processEmailRecord);

    // Filter newsletters
    let skippedNewsletters = 0;
    const filtered = processed.filter((email) => {
      if (isNewsletter(email.senderEmail, email.subject)) {
        skippedNewsletters++;
        return false;
      }
      return true;
    });

    // Group by sender
    const senderMap = groupBySender(filtered);

    // Build email groups with thread collapsing
    let totalThreadsMerged = 0;
    const groups: EmailGroup[] = [];

    for (const [senderEmail, emails] of senderMap) {
      const { collapsed, merged } = collapseThreads(emails);
      totalThreadsMerged += merged;

      const anyUrgent = collapsed.some((e) => e.isUrgent);
      const uniqueThreads = new Set(collapsed.map((e) => e.threadId).filter(Boolean));

      const group: EmailGroup = {
        sender: collapsed[0]?.senderName || "",
        senderEmail,
        emails: collapsed.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime()),
        isUrgent: anyUrgent,
        threadCount: uniqueThreads.size || collapsed.length,
        proposedAction: "",
      };
      group.proposedAction = proposeAction(group);
      groups.push(group);
    }

    // Sort: urgent first, then by email count descending
    groups.sort((a, b) => {
      if (a.isUrgent !== b.isUrgent) return a.isUrgent ? -1 : 1;
      return b.emails.length - a.emails.length;
    });

    const urgentCount = groups.filter((g) => g.isUrgent).length;

    const result: BatchResult = {
      processedCount: records.length,
      groupCount: groups.length,
      skippedNewsletters,
      urgentCount,
      threadsMerged: totalThreadsMerged,
      report: "",
      groups,
    };

    result.report = formatBatchReport(result);

    // Update state
    await this.deps.stateStore.setLastProcessedAt(new Date());

    logger.info("Batch run complete", {
      processed: records.length,
      groups: groups.length,
      newsletters: skippedNewsletters,
      urgent: urgentCount,
      merged: totalThreadsMerged,
    });

    return result;
  }

  /**
   * Build GTD inbox items from approved groups.
   * Returns items ready for the GTD inbox API.
   */
  buildGtdItems(groups: EmailGroup[]): GtdInboxItem[] {
    return groups.map(buildGtdItem);
  }
}

// ── In-Memory State Store (default) ──────────────────────────

export class InMemoryBatchStateStore implements BatchStateStore {
  private lastProcessedAt: Date | null = null;

  async getLastProcessedAt(): Promise<Date | null> {
    return this.lastProcessedAt;
  }

  async setLastProcessedAt(at: Date): Promise<void> {
    this.lastProcessedAt = at;
  }
}

// ── Testing Helpers ──────────────────────────────────────────

export function _makeMockEmailRecord(
  overrides: Partial<MountainEmailRecord> = {},
): MountainEmailRecord {
  return {
    id: crypto.randomUUID(),
    external_id: `gmail:msg-${crypto.randomUUID().slice(0, 8)}`,
    payload: {
      subject: "Test email subject",
      from: "Alice Smith <alice@example.com>",
      content: "This is a test email body",
      snippet: "This is a test email body",
      threadId: `thread-${crypto.randomUUID().slice(0, 8)}`,
      type: "gmail",
    },
    summary: "Test email subject",
    source_timestamp: new Date(),
    created_at: new Date(),
    ...overrides,
  };
}

export function _makeMockFetcher(
  records: MountainEmailRecord[],
): EmailRecordFetcher {
  return async (_since: Date, _limit?: number) => records;
}

export function _makeMockStateStore(
  lastProcessedAt: Date | null = null,
): BatchStateStore & { stored: Date | null } {
  const store = {
    stored: lastProcessedAt,
    async getLastProcessedAt() {
      return store.stored;
    },
    async setLastProcessedAt(at: Date) {
      store.stored = at;
    },
  };
  return store;
}
