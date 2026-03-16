/**
 * Conversation Replay Mining — ELLIE-779
 * Periodic scanner that reviews recent conversations for uncaptured River-worthy content.
 * Pure functions with injected SQL for testability.
 */

import { detectPatterns, type DetectorConfig, DEFAULT_CONFIG } from "./pattern-detector.ts";
import type { CaptureContentType, Channel } from "../capture-queue.ts";

// Types

export interface MinerConfig {
  days_back: number;
  min_message_length: number;
  batch_size: number;
  detector_config: DetectorConfig;
}

export const DEFAULT_MINER_CONFIG: MinerConfig = {
  days_back: 7,
  min_message_length: 40,
  batch_size: 100,
  detector_config: { ...DEFAULT_CONFIG, confidence_threshold: 0.7 },
};

export interface ConversationMessage {
  id: string;
  text: string;
  channel: string;
  role: string;
  created_at: string;
  conversation_id?: string;
}

export interface MinerFinding {
  message_id: string;
  content_type: CaptureContentType;
  confidence: number;
  raw_content: string;
  channel: string;
  matched_patterns: string[];
  created_at: string;
}

export interface MinerReport {
  scanned_messages: number;
  findings: MinerFinding[];
  duplicates_filtered: number;
  queued: number;
  scan_duration_ms: number;
  period_start: string;
  period_end: string;
}

// Fetch recent messages

export async function fetchRecentMessages(
  sql: any,
  config: MinerConfig = DEFAULT_MINER_CONFIG,
): Promise<ConversationMessage[]> {
  const rows = await sql`
    SELECT id, text, channel, role, created_at, conversation_id
    FROM messages
    WHERE created_at >= NOW() - ${config.days_back + ' days'}::interval
    AND role = 'user'
    AND LENGTH(text) >= ${config.min_message_length}
    ORDER BY created_at ASC
    LIMIT ${config.batch_size}
  `;
  return rows;
}

// Scan messages for patterns

export function scanMessages(
  messages: ConversationMessage[],
  config: MinerConfig = DEFAULT_MINER_CONFIG,
): MinerFinding[] {
  const findings: MinerFinding[] = [];

  for (const msg of messages) {
    const result = detectPatterns(msg.text, config.detector_config);
    if (result.detected) {
      findings.push({
        message_id: msg.id,
        content_type: result.content_type,
        confidence: result.confidence,
        raw_content: msg.text,
        channel: msg.channel,
        matched_patterns: result.matched_patterns,
        created_at: msg.created_at,
      });
    }
  }

  return findings;
}

// Deduplicate against existing capture queue and River docs

export async function deduplicateFindings(
  sql: any,
  findings: MinerFinding[],
): Promise<{ unique: MinerFinding[]; duplicateCount: number }> {
  if (findings.length === 0) return { unique: [], duplicateCount: 0 };

  const messageIds = findings.map(f => f.message_id);

  // Check which message IDs are already in capture queue
  const existing = await sql`
    SELECT source_message_id FROM capture_queue
    WHERE source_message_id = ANY(${messageIds})
    AND status != 'dismissed'
  `;

  const existingIds = new Set(existing.map((r: any) => r.source_message_id));
  const unique = findings.filter(f => !existingIds.has(f.message_id));

  return {
    unique,
    duplicateCount: findings.length - unique.length,
  };
}

// Pure version for testing without SQL array syntax
export function deduplicateFindingsFromData(
  findings: MinerFinding[],
  existingMessageIds: Set<string>,
): { unique: MinerFinding[]; duplicateCount: number } {
  const unique = findings.filter(f => !existingMessageIds.has(f.message_id));
  return {
    unique,
    duplicateCount: findings.length - unique.length,
  };
}

// Queue findings into capture queue

export async function queueFindings(
  sql: any,
  findings: MinerFinding[],
): Promise<number> {
  let queued = 0;

  for (const finding of findings) {
    try {
      await sql`
        INSERT INTO capture_queue (
          channel, raw_content, capture_type, content_type,
          confidence, source_message_id, status
        ) VALUES (
          ${finding.channel},
          ${finding.raw_content},
          'replay',
          ${finding.content_type},
          ${finding.confidence},
          ${finding.message_id},
          'queued'
        )
      `;
      queued++;
    } catch {
      // Skip on conflict (e.g., duplicate source_message_id)
    }
  }

  return queued;
}

// Build report summary

export function buildReport(
  scanned: number,
  findings: MinerFinding[],
  duplicatesFiltered: number,
  queued: number,
  durationMs: number,
  periodStart: string,
  periodEnd: string,
): MinerReport {
  return {
    scanned_messages: scanned,
    findings,
    duplicates_filtered: duplicatesFiltered,
    queued,
    scan_duration_ms: durationMs,
    period_start: periodStart,
    period_end: periodEnd,
  };
}

// Format report as notification message

export function formatReportMessage(report: MinerReport): string {
  if (report.findings.length === 0) {
    return `**Replay Scan Complete** — Scanned ${report.scanned_messages} messages from the past week. No new River-worthy content found.`;
  }

  const typeCounts: Record<string, number> = {};
  for (const f of report.findings) {
    typeCounts[f.content_type] = (typeCounts[f.content_type] ?? 0) + 1;
  }

  const typeList = Object.entries(typeCounts)
    .map(([type, count]) => `${count} ${type}${count > 1 ? "s" : ""}`)
    .join(", ");

  const lines: string[] = [
    `**Replay Scan Complete**`,
    `Scanned ${report.scanned_messages} messages (${report.period_start.slice(0, 10)} → ${report.period_end.slice(0, 10)})`,
    `Found ${report.findings.length} items: ${typeList}`,
    `Duplicates filtered: ${report.duplicates_filtered}`,
    `Queued for review: ${report.queued}`,
    ``,
    `Check the capture queue to review.`,
  ];

  return lines.join("\n");
}

// Full pipeline

export async function runReplayMine(
  sql: any,
  config: MinerConfig = DEFAULT_MINER_CONFIG,
): Promise<MinerReport> {
  const startTime = Date.now();
  const periodEnd = new Date().toISOString();
  const periodStart = new Date(Date.now() - config.days_back * 86400000).toISOString();

  // Fetch messages
  const messages = await fetchRecentMessages(sql, config);

  // Scan for patterns
  const findings = scanMessages(messages, config);

  // Deduplicate
  const { unique, duplicateCount } = await deduplicateFindings(sql, findings);

  // Queue
  const queued = await queueFindings(sql, unique);

  const durationMs = Date.now() - startTime;

  return buildReport(
    messages.length,
    unique,
    duplicateCount,
    queued,
    durationMs,
    periodStart,
    periodEnd,
  );
}
