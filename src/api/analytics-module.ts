/**
 * Analytics Module API — ELLIE-321
 *
 * Endpoints:
 *   GET /api/analytics/summary            — today/date summary with category breakdown
 *   GET /api/analytics/time-distribution   — time by category for a range
 *   GET /api/analytics/timeline            — activity timeline (filterable)
 *   GET /api/analytics/patterns            — weekly patterns from 30-day window
 *   GET /api/analytics/insights            — scored productivity recommendations
 *   GET /api/analytics/focus-blocks        — focus block analysis
 *   GET /api/analytics/activity            — raw activity log (paginated)
 *   GET /api/analytics/metrics/:date       — daily metrics rollup
 *   GET /api/analytics/compare             — period comparison
 *   GET /api/analytics/module-stats        — live consumer stats
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiRequest, ApiResponse } from "./types.ts";

// ── Summary ─────────────────────────────────────────────────

export async function getSummary(
  req: ApiRequest, res: ApiResponse, supabase: SupabaseClient,
): Promise<void> {
  const date = req.query?.date;
  const range = req.query?.range || "day"; // day, week, month

  try {
    const { getDailySummary, getTimeDistribution } =
      await import("../ums/consumers/analytics.ts");

    if (range === "day") {
      const summary = await getDailySummary(supabase, date);
      res.json({ success: true, ...summary });
      return;
    }

    // Week or month — aggregate from productivity_metrics
    const days = range === "week" ? 7 : 30;
    const distribution = await getTimeDistribution(supabase, days);
    res.json({ success: true, range, ...distribution });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Summary failed" });
  }
}

// ── Time Distribution ───────────────────────────────────────

export async function getTimeDistributionEndpoint(
  req: ApiRequest, res: ApiResponse, supabase: SupabaseClient,
): Promise<void> {
  const days = Math.min(Number(req.query?.days) || 7, 90);

  try {
    const { getTimeDistribution } = await import("../ums/consumers/analytics.ts");
    const distribution = await getTimeDistribution(supabase, days);
    res.json({ success: true, ...distribution });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Time distribution failed" });
  }
}

// ── Timeline ────────────────────────────────────────────────

export async function getTimeline(
  req: ApiRequest, res: ApiResponse, supabase: SupabaseClient,
): Promise<void> {
  const limit = Math.min(Number(req.query?.limit) || 50, 200);
  const offset = Number(req.query?.offset) || 0;
  const category = req.query?.category; // comma-separated
  const source = req.query?.source;
  const date = req.query?.date;

  try {
    let query = supabase
      .from("activity_log")
      .select("*", { count: "exact" })
      .order("started_at", { ascending: false });

    if (category) {
      const categories = category.split(",").map(c => c.trim());
      query = query.in("category", categories);
    }
    if (source) {
      query = query.eq("source", source);
    }
    if (date) {
      const nextDay = new Date(new Date(date).getTime() + 24 * 60 * 60 * 1000)
        .toISOString().split("T")[0];
      query = query.gte("started_at", date).lt("started_at", nextDay);
    }

    query = query.range(offset, offset + limit - 1);

    const { data, count, error } = await query;
    if (error) throw error;

    res.json({ success: true, activities: data, total: count ?? 0, limit, offset });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Timeline failed" });
  }
}

// ── Patterns ────────────────────────────────────────────────

export async function getPatternsEndpoint(
  req: ApiRequest, res: ApiResponse, supabase: SupabaseClient,
): Promise<void> {
  try {
    const { getPatterns } = await import("../ums/consumers/analytics.ts");
    const patterns = await getPatterns(supabase);
    res.json({ success: true, patterns, days_analyzed: 30 });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Patterns failed" });
  }
}

// ── Insights ────────────────────────────────────────────────

export async function getInsights(
  req: ApiRequest, res: ApiResponse, supabase: SupabaseClient,
): Promise<void> {
  try {
    const { getDailySummary, getPatterns, getTimeDistribution, getTrends, assessBurnoutRisk, getBestFocusWindows } =
      await import("../ums/consumers/analytics.ts");

    const [today, patterns, weekDist, trends, burnout, focusWindows] = await Promise.all([
      getDailySummary(supabase),
      getPatterns(supabase),
      getTimeDistribution(supabase, 7),
      getTrends(supabase, 14),
      assessBurnoutRisk(supabase),
      getBestFocusWindows(supabase),
    ]);

    const insights: Array<{
      type: string;
      severity: "info" | "warning";
      title: string;
      detail: string;
      score: number;
    }> = [];

    // Meeting density
    if (weekDist.total_minutes > 0) {
      const meetingPct = weekDist.categories.meetings.percentage;
      if (meetingPct > 50) {
        insights.push({
          type: "meeting_density",
          severity: "warning",
          title: "High meeting density",
          detail: `${meetingPct}% of tracked time is in meetings this week`,
          score: meetingPct / 100,
        });
      }
    }

    // Focus quality
    if (today.total_minutes > 60 && today.longest_focus_min < 30) {
      insights.push({
        type: "focus_quality",
        severity: "warning",
        title: "No deep focus blocks today",
        detail: `Longest uninterrupted block: ${Math.round(today.longest_focus_min)} min`,
        score: 0.8,
      });
    }

    // Context switching
    if (today.context_switches > 20) {
      insights.push({
        type: "context_switching",
        severity: "warning",
        title: "High context switching",
        detail: `${today.context_switches} category switches today`,
        score: Math.min(1, today.context_switches / 30),
      });
    }

    // Work-life balance — late work
    if (today.last_activity) {
      const lastHour = new Date(today.last_activity).getHours();
      if (lastHour >= 18) {
        insights.push({
          type: "work_life_balance",
          severity: "warning",
          title: "Working late",
          detail: `Last activity at ${lastHour}:00 — consider wrapping up`,
          score: Math.min(1, (lastHour - 18) / 4),
        });
      }
    }

    // Best focus day pattern
    if (patterns.length > 0) {
      const bestFocusDay = patterns.reduce((best, p) =>
        p.avg_focus_min > best.avg_focus_min ? p : best, patterns[0]);
      if (bestFocusDay.avg_focus_min > 0) {
        insights.push({
          type: "energy_optimization",
          severity: "info",
          title: "Best focus day",
          detail: `${bestFocusDay.day_name} averages ${bestFocusDay.avg_focus_min} min of deep work`,
          score: 0.5,
        });
      }
    }

    // Time allocation
    if (weekDist.total_minutes > 0 && weekDist.categories.deep_work.percentage < 20) {
      insights.push({
        type: "time_allocation",
        severity: "warning",
        title: "Low deep work ratio",
        detail: `Only ${weekDist.categories.deep_work.percentage}% deep work this week`,
        score: 0.7,
      });
    }

    // ── Phase 2: Trend-based insights ──

    // Meeting creep
    const meetingTrend = trends.find(t => t.metric === "meetings");
    if (meetingTrend && meetingTrend.direction === "up" && meetingTrend.change_pct > 15) {
      insights.push({
        type: "meeting_creep",
        severity: "warning",
        title: "Meeting time trending up",
        detail: `Meetings up ${meetingTrend.change_pct}% over 2 weeks (${meetingTrend.slope > 0 ? "+" : ""}${meetingTrend.slope} min/day)`,
        score: Math.min(1, meetingTrend.change_pct / 50),
      });
    }

    // Focus decline
    const focusTrend = trends.find(t => t.metric === "deep_work");
    if (focusTrend && focusTrend.direction === "down" && focusTrend.change_pct < -15) {
      insights.push({
        type: "focus_decline",
        severity: "warning",
        title: "Deep work time declining",
        detail: `Focus time down ${Math.abs(focusTrend.change_pct)}% over 2 weeks`,
        score: Math.min(1, Math.abs(focusTrend.change_pct) / 40),
      });
    }

    // Context switch trend
    const switchTrend = trends.find(t => t.metric === "context_switches");
    if (switchTrend && switchTrend.direction === "up" && switchTrend.change_pct > 20) {
      insights.push({
        type: "switch_trend",
        severity: "info",
        title: "Context switching increasing",
        detail: `Switches up ${switchTrend.change_pct}% — fragmented days becoming more common`,
        score: 0.6,
      });
    }

    // Burnout risk
    if (burnout.risk_level !== "low") {
      insights.push({
        type: "burnout_risk",
        severity: "warning",
        title: `Burnout risk: ${burnout.risk_level}`,
        detail: burnout.signals.slice(0, 3).join("; "),
        score: burnout.score,
      });
    }

    // Best focus window recommendation
    if (focusWindows.length > 0) {
      const best = focusWindows[0];
      insights.push({
        type: "focus_window",
        severity: "info",
        title: "Best focus window",
        detail: `${best.start_hour}:00-${best.end_hour}:00 has ${Math.round(best.quality_score * 100)}% deep work ratio — protect this time`,
        score: 0.4,
      });
    }

    // Sort by score descending
    insights.sort((a, b) => b.score - a.score);

    res.json({ success: true, insights, count: insights.length, burnout });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Insights failed" });
  }
}

// ── Focus Blocks ────────────────────────────────────────────

export async function getFocusBlocksEndpoint(
  req: ApiRequest, res: ApiResponse, supabase: SupabaseClient,
): Promise<void> {
  const date = req.query?.date;

  try {
    const { getFocusBlocks, getDailySummary } =
      await import("../ums/consumers/analytics.ts");

    const [blocks, summary] = await Promise.all([
      getFocusBlocks(supabase, date),
      getDailySummary(supabase, date),
    ]);

    res.json({
      success: true,
      date: summary.date,
      blocks,
      count: blocks.length,
      total_focus_min: summary.categories.deep_work,
      longest_block_min: summary.longest_focus_min,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Focus blocks failed" });
  }
}

// ── Activity Log ────────────────────────────────────────────

export async function getActivity(
  req: ApiRequest, res: ApiResponse, supabase: SupabaseClient,
): Promise<void> {
  const limit = Math.min(Number(req.query?.limit) || 50, 200);
  const offset = Number(req.query?.offset) || 0;
  const category = req.query?.category;
  const activityType = req.query?.activity_type;
  const source = req.query?.source;
  const since = req.query?.since;
  const before = req.query?.before;

  try {
    let query = supabase
      .from("activity_log")
      .select("*", { count: "exact" })
      .order("started_at", { ascending: false });

    if (category) {
      const categories = category.split(",").map(c => c.trim());
      query = query.in("category", categories);
    }
    if (activityType) {
      query = query.eq("activity_type", activityType);
    }
    if (source) {
      query = query.eq("source", source);
    }
    if (since) {
      query = query.gte("started_at", since);
    }
    if (before) {
      query = query.lt("started_at", before);
    }

    query = query.range(offset, offset + limit - 1);

    const { data, count, error } = await query;
    if (error) throw error;

    res.json({ success: true, activities: data, total: count ?? 0, limit, offset });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Activity query failed" });
  }
}

// ── Daily Metrics ───────────────────────────────────────────

export async function getMetrics(
  req: ApiRequest, res: ApiResponse, supabase: SupabaseClient,
): Promise<void> {
  const date = req.params?.date;
  if (!date) {
    res.status(400).json({ error: "Date parameter required (YYYY-MM-DD)" });
    return;
  }

  try {
    const { data, error } = await supabase
      .from("productivity_metrics")
      .select("*")
      .eq("metric_date", date)
      .single();

    if (error && error.code === "PGRST116") {
      // Not found — try live rollup for today
      const today = new Date().toISOString().split("T")[0];
      if (date === today) {
        const { getDailySummary } = await import("../ums/consumers/analytics.ts");
        const summary = await getDailySummary(supabase, date);
        res.json({ success: true, source: "live", ...summary });
        return;
      }
      res.status(404).json({ error: "No metrics for this date" });
      return;
    }
    if (error) throw error;

    res.json({ success: true, source: "rollup", metrics: data });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Metrics query failed" });
  }
}

// ── Period Compare ──────────────────────────────────────────

export async function getCompare(
  req: ApiRequest, res: ApiResponse, supabase: SupabaseClient,
): Promise<void> {
  const period1 = req.query?.period1; // YYYY-Wnn or YYYY-MM-DD
  const period2 = req.query?.period2;

  if (!period1 || !period2) {
    res.status(400).json({ error: "period1 and period2 required (YYYY-Wnn or YYYY-MM-DD)" });
    return;
  }

  try {
    const range1 = parsePeriod(period1);
    const range2 = parsePeriod(period2);

    const [metrics1, metrics2] = await Promise.all([
      getMetricsForRange(supabase, range1.start, range1.end),
      getMetricsForRange(supabase, range2.start, range2.end),
    ]);

    const agg1 = aggregateMetrics(metrics1);
    const agg2 = aggregateMetrics(metrics2);

    const changes: Record<string, { period1: number; period2: number; change_pct: number }> = {};
    for (const key of ["total_min", "deep_work_min", "meetings_min", "communication_min", "focus_blocks", "context_switches"] as const) {
      const v1 = agg1[key] ?? 0;
      const v2 = agg2[key] ?? 0;
      changes[key] = {
        period1: v1,
        period2: v2,
        change_pct: v2 > 0 ? Math.round(((v1 - v2) / v2) * 100) : 0,
      };
    }

    res.json({
      success: true,
      period1: { label: period1, ...range1, days: metrics1.length, ...agg1 },
      period2: { label: period2, ...range2, days: metrics2.length, ...agg2 },
      changes,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Compare failed" });
  }
}

// ── Module Stats ────────────────────────────────────────────

export async function getModuleStats(
  _req: ApiRequest, res: ApiResponse,
): Promise<void> {
  try {
    const { getAnalyticsStats } = await import("../ums/consumers/analytics.ts");
    const stats = getAnalyticsStats();
    res.json({ success: true, ...stats });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Module stats failed" });
  }
}

// ── Phase 2: Trends ─────────────────────────────────────────

export async function getTrendsEndpoint(
  req: ApiRequest, res: ApiResponse, supabase: SupabaseClient,
): Promise<void> {
  const days = Math.min(Number(req.query?.days) || 14, 90);

  try {
    const { getTrends } = await import("../ums/consumers/analytics.ts");
    const trends = await getTrends(supabase, days);
    res.json({ success: true, days, trends });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Trends failed" });
  }
}

// ── Phase 2: Anomalies ──────────────────────────────────────

export async function getAnomaliesEndpoint(
  req: ApiRequest, res: ApiResponse, supabase: SupabaseClient,
): Promise<void> {
  const days = Math.min(Number(req.query?.days) || 30, 90);

  try {
    const { detectAnomalies } = await import("../ums/consumers/analytics.ts");
    const anomalies = await detectAnomalies(supabase, days);
    res.json({ success: true, days, anomalies, count: anomalies.length });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Anomalies failed" });
  }
}

// ── Phase 2: Energy Curve ───────────────────────────────────

export async function getEnergyCurveEndpoint(
  req: ApiRequest, res: ApiResponse, supabase: SupabaseClient,
): Promise<void> {
  const days = Math.min(Number(req.query?.days) || 14, 90);

  try {
    const { getEnergyCurve, getBestFocusWindows } =
      await import("../ums/consumers/analytics.ts");

    const [curve, windows] = await Promise.all([
      getEnergyCurve(supabase, days),
      getBestFocusWindows(supabase),
    ]);

    res.json({ success: true, days, curve, best_focus_windows: windows });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Energy curve failed" });
  }
}

// ── Phase 2: Burnout Risk ───────────────────────────────────

export async function getBurnoutRiskEndpoint(
  _req: ApiRequest, res: ApiResponse, supabase: SupabaseClient,
): Promise<void> {
  try {
    const { assessBurnoutRisk } = await import("../ums/consumers/analytics.ts");
    const risk = await assessBurnoutRisk(supabase);
    res.json({ success: true, ...risk });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Burnout risk failed" });
  }
}

// ── Helpers ─────────────────────────────────────────────────

function parsePeriod(period: string): { start: string; end: string } {
  // ISO week: 2026-W08
  const weekMatch = period.match(/^(\d{4})-W(\d{2})$/);
  if (weekMatch) {
    const year = Number(weekMatch[1]);
    const week = Number(weekMatch[2]);
    const jan4 = new Date(year, 0, 4);
    const startOfWeek = new Date(jan4.getTime() - (jan4.getDay() - 1) * 86400000 + (week - 1) * 7 * 86400000);
    const endOfWeek = new Date(startOfWeek.getTime() + 7 * 86400000);
    return {
      start: startOfWeek.toISOString().split("T")[0],
      end: endOfWeek.toISOString().split("T")[0],
    };
  }

  // Single date: treat as that day
  return { start: period, end: new Date(new Date(period).getTime() + 86400000).toISOString().split("T")[0] };
}

async function getMetricsForRange(
  supabase: SupabaseClient, start: string, end: string,
): Promise<Array<Record<string, number>>> {
  const { data } = await supabase
    .from("productivity_metrics")
    .select("*")
    .gte("metric_date", start)
    .lt("metric_date", end)
    .order("metric_date", { ascending: true });

  return (data || []) as Array<Record<string, number>>;
}

function aggregateMetrics(metrics: Array<Record<string, number>>): Record<string, number> {
  if (metrics.length === 0) {
    return {
      total_min: 0, deep_work_min: 0, meetings_min: 0,
      communication_min: 0, admin_min: 0, personal_min: 0,
      focus_blocks: 0, context_switches: 0,
      avg_focus_score: 0, avg_balance_score: 0,
    };
  }

  let total = 0, dw = 0, mtg = 0, comm = 0, adm = 0, pers = 0;
  let fb = 0, cs = 0, fs = 0, bs = 0;

  for (const m of metrics) {
    total += m.total_min || 0;
    dw += m.deep_work_min || 0;
    mtg += m.meetings_min || 0;
    comm += m.communication_min || 0;
    adm += m.admin_min || 0;
    pers += m.personal_min || 0;
    fb += m.focus_blocks || 0;
    cs += m.context_switches || 0;
    fs += m.focus_score || 0;
    bs += m.balance_score || 0;
  }

  return {
    total_min: Math.round(total),
    deep_work_min: Math.round(dw),
    meetings_min: Math.round(mtg),
    communication_min: Math.round(comm),
    admin_min: Math.round(adm),
    personal_min: Math.round(pers),
    focus_blocks: fb,
    context_switches: cs,
    avg_focus_score: Math.round((fs / metrics.length) * 100) / 100,
    avg_balance_score: Math.round((bs / metrics.length) * 100) / 100,
  };
}
