/**
 * Capture Funnel Metrics — ELLIE-783
 * Tracks the entire capture pipeline and computes funnel metrics.
 * Pure functions with injected SQL for testability.
 */

// Types

export type TimeRange = "7d" | "30d" | "all";

export interface FunnelMetrics {
  flagged: number;
  refined: number;
  approved: number;
  written: number;
  dismissed: number;
  conversion_rates: {
    flagged_to_refined: number;
    refined_to_approved: number;
    approved_to_written: number;
    overall: number;
  };
}

export interface SourceBreakdown {
  manual: number;
  tag: number;
  proactive: number;
  braindump: number;
  replay: number;
  template: number;
}

export interface ChannelBreakdown {
  telegram: number;
  "ellie-chat": number;
  "google-chat": number;
  voice: number;
}

export interface ContentTypeBreakdown {
  workflow: number;
  decision: number;
  process: number;
  policy: number;
  integration: number;
  reference: number;
}

export interface VelocityPoint {
  date: string;
  captured: number;
  written: number;
}

export interface CaptureMetrics {
  funnel: FunnelMetrics;
  by_source: SourceBreakdown;
  by_channel: ChannelBreakdown;
  by_content_type: ContentTypeBreakdown;
  velocity: VelocityPoint[];
  time_range: TimeRange;
  total_items: number;
}

// Compute funnel from raw status counts

export function computeFunnel(statusCounts: Record<string, number>): FunnelMetrics {
  const flagged = (statusCounts.queued ?? 0) + (statusCounts.refined ?? 0) +
    (statusCounts.approved ?? 0) + (statusCounts.written ?? 0) + (statusCounts.dismissed ?? 0);
  const refined = (statusCounts.refined ?? 0) + (statusCounts.approved ?? 0) + (statusCounts.written ?? 0);
  const approved = (statusCounts.approved ?? 0) + (statusCounts.written ?? 0);
  const written = statusCounts.written ?? 0;
  const dismissed = statusCounts.dismissed ?? 0;

  return {
    flagged,
    refined,
    approved,
    written,
    dismissed,
    conversion_rates: {
      flagged_to_refined: flagged > 0 ? round(refined / flagged) : 0,
      refined_to_approved: refined > 0 ? round(approved / refined) : 0,
      approved_to_written: approved > 0 ? round(written / approved) : 0,
      overall: flagged > 0 ? round(written / flagged) : 0,
    },
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// Compute breakdowns from raw grouped counts

export function computeSourceBreakdown(rows: { capture_type: string; count: number }[]): SourceBreakdown {
  const result: SourceBreakdown = { manual: 0, tag: 0, proactive: 0, braindump: 0, replay: 0, template: 0 };
  for (const row of rows) {
    if (row.capture_type in result) {
      (result as any)[row.capture_type] = row.count;
    }
  }
  return result;
}

export function computeChannelBreakdown(rows: { channel: string; count: number }[]): ChannelBreakdown {
  const result: ChannelBreakdown = { telegram: 0, "ellie-chat": 0, "google-chat": 0, voice: 0 };
  for (const row of rows) {
    if (row.channel in result) {
      (result as any)[row.channel] = row.count;
    }
  }
  return result;
}

export function computeContentTypeBreakdown(rows: { content_type: string; count: number }[]): ContentTypeBreakdown {
  const result: ContentTypeBreakdown = { workflow: 0, decision: 0, process: 0, policy: 0, integration: 0, reference: 0 };
  for (const row of rows) {
    if (row.content_type in result) {
      (result as any)[row.content_type] = row.count;
    }
  }
  return result;
}

// Build velocity data from daily counts

export function computeVelocity(
  capturedRows: { date: string; count: number }[],
  writtenRows: { date: string; count: number }[],
): VelocityPoint[] {
  const map = new Map<string, VelocityPoint>();

  for (const row of capturedRows) {
    map.set(row.date, { date: row.date, captured: row.count, written: 0 });
  }
  for (const row of writtenRows) {
    const existing = map.get(row.date);
    if (existing) {
      existing.written = row.count;
    } else {
      map.set(row.date, { date: row.date, captured: 0, written: row.count });
    }
  }

  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// Time range to SQL interval

export function timeRangeToInterval(range: TimeRange): string {
  switch (range) {
    case "7d": return "7 days";
    case "30d": return "30 days";
    case "all": return "10 years";
  }
}

// Full metrics fetch (with SQL)

export async function fetchMetrics(sql: any, range: TimeRange = "7d"): Promise<CaptureMetrics> {
  const interval = timeRangeToInterval(range);

  const [statusRows, sourceRows, channelRows, typeRows, capturedDaily, writtenDaily, totalRows] = await Promise.all([
    sql`SELECT status, COUNT(*)::int as count FROM capture_queue WHERE created_at >= NOW() - ${interval}::interval GROUP BY status`,
    sql`SELECT capture_type, COUNT(*)::int as count FROM capture_queue WHERE created_at >= NOW() - ${interval}::interval GROUP BY capture_type`,
    sql`SELECT channel, COUNT(*)::int as count FROM capture_queue WHERE created_at >= NOW() - ${interval}::interval GROUP BY channel`,
    sql`SELECT content_type, COUNT(*)::int as count FROM capture_queue WHERE created_at >= NOW() - ${interval}::interval GROUP BY content_type`,
    sql`SELECT DATE(created_at)::text as date, COUNT(*)::int as count FROM capture_queue WHERE created_at >= NOW() - ${interval}::interval GROUP BY DATE(created_at) ORDER BY date`,
    sql`SELECT DATE(processed_at)::text as date, COUNT(*)::int as count FROM capture_queue WHERE status = 'written' AND processed_at >= NOW() - ${interval}::interval GROUP BY DATE(processed_at) ORDER BY date`,
    sql`SELECT COUNT(*)::int as total FROM capture_queue WHERE created_at >= NOW() - ${interval}::interval`,
  ]);

  const statusMap: Record<string, number> = {};
  for (const r of statusRows) statusMap[r.status] = r.count;

  return {
    funnel: computeFunnel(statusMap),
    by_source: computeSourceBreakdown(sourceRows),
    by_channel: computeChannelBreakdown(channelRows),
    by_content_type: computeContentTypeBreakdown(typeRows),
    velocity: computeVelocity(capturedDaily, writtenDaily),
    time_range: range,
    total_items: totalRows[0]?.total ?? 0,
  };
}

// Format metrics as a summary string (for Telegram/chat notifications)

export function formatMetricsSummary(metrics: CaptureMetrics): string {
  const f = metrics.funnel;
  const lines = [
    `**Capture Metrics** (${metrics.time_range})`,
    "",
    `**Funnel:** ${f.flagged} flagged → ${f.refined} refined → ${f.approved} approved → ${f.written} written`,
    `**Dismissed:** ${f.dismissed}`,
    `**Overall conversion:** ${Math.round(f.conversion_rates.overall * 100)}%`,
    "",
  ];

  const topSource = Object.entries(metrics.by_source).sort((a, b) => b[1] - a[1])[0];
  const topChannel = Object.entries(metrics.by_channel).sort((a, b) => b[1] - a[1])[0];
  const topType = Object.entries(metrics.by_content_type).sort((a, b) => b[1] - a[1])[0];

  if (topSource && topSource[1] > 0) lines.push(`**Top source:** ${topSource[0]} (${topSource[1]})`);
  if (topChannel && topChannel[1] > 0) lines.push(`**Top channel:** ${topChannel[0]} (${topChannel[1]})`);
  if (topType && topType[1] > 0) lines.push(`**Top type:** ${topType[0]} (${topType[1]})`);

  return lines.join("\n");
}
