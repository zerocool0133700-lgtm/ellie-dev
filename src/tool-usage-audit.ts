/**
 * Tool Usage Audit Logger
 *
 * Tracks all agent tool/MCP invocations for compliance, debugging,
 * and behavioral verification.
 *
 * ELLIE-970: Usage audit logging
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "./logger.ts";

const logger = log.child("tool-audit");

export interface ToolUsageLogEntry {
  agent_name: string;
  agent_type: string;
  tool_name: string;
  tool_category?: string;
  operation?: string;
  session_id?: string;
  user_id?: string;
  channel?: string;
  success: boolean;
  error_message?: string;
  parameters?: Record<string, unknown>;
  result_summary?: string;
  duration_ms?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Redact sensitive values from tool parameters before logging.
 *
 * Removes API keys, tokens, passwords, email content, etc.
 */
function sanitizeParameters(params: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  const sensitiveKeys = [
    "token",
    "api_key",
    "apiKey",
    "password",
    "secret",
    "authorization",
    "auth",
    "content",  // Email/message content
    "body",     // Request bodies
    "message",  // Message content
  ];

  for (const [key, value] of Object.entries(params)) {
    const lowerKey = key.toLowerCase();
    if (sensitiveKeys.some(s => lowerKey.includes(s))) {
      sanitized[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      sanitized[key] = sanitizeParameters(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Log a tool usage event to the audit table.
 *
 * Fire-and-forget — failures are logged but don't block execution.
 */
export async function logToolUsage(
  supabase: SupabaseClient | null,
  entry: ToolUsageLogEntry
): Promise<void> {
  if (!supabase) {
    logger.debug("Supabase not available, skipping tool usage log");
    return;
  }

  try {
    const sanitizedParams = entry.parameters ? sanitizeParameters(entry.parameters) : undefined;

    const { error } = await supabase.from("agent_tool_usage").insert({
      agent_name: entry.agent_name,
      agent_type: entry.agent_type,
      tool_name: entry.tool_name,
      tool_category: entry.tool_category,
      operation: entry.operation,
      session_id: entry.session_id,
      user_id: entry.user_id,
      channel: entry.channel,
      success: entry.success,
      error_message: entry.error_message,
      parameters: sanitizedParams,
      result_summary: entry.result_summary,
      duration_ms: entry.duration_ms,
      metadata: entry.metadata,
    });

    if (error) {
      logger.error("Failed to log tool usage", { error: error.message, tool: entry.tool_name });
    } else {
      logger.debug(`Logged tool usage: ${entry.agent_name} → ${entry.tool_name}`, {
        success: entry.success,
        duration: entry.duration_ms,
      });
    }
  } catch (err) {
    logger.error("Tool usage logging exception", err);
  }
}

/**
 * Query tool usage logs for a specific agent.
 */
export async function getAgentToolUsage(
  supabase: SupabaseClient,
  agentName: string,
  options?: {
    limit?: number;
    since?: Date;
    toolName?: string;
  }
): Promise<ToolUsageLogEntry[]> {
  let query = supabase
    .from("agent_tool_usage")
    .select("*")
    .eq("agent_name", agentName)
    .order("timestamp", { ascending: false });

  if (options?.limit) {
    query = query.limit(options.limit);
  }

  if (options?.since) {
    query = query.gte("timestamp", options.since.toISOString());
  }

  if (options?.toolName) {
    query = query.eq("tool_name", options.toolName);
  }

  const { data, error } = await query;

  if (error) {
    logger.error("Failed to query tool usage", { error: error.message });
    return [];
  }

  return (data || []) as ToolUsageLogEntry[];
}

/**
 * Get tool usage statistics for an agent.
 */
export async function getToolUsageStats(
  supabase: SupabaseClient,
  agentName: string,
  since?: Date
): Promise<{
  total_calls: number;
  success_rate: number;
  tools_used: Record<string, number>;
  avg_duration_ms: number;
}> {
  let query = supabase
    .from("agent_tool_usage")
    .select("tool_name, success, duration_ms")
    .eq("agent_name", agentName);

  if (since) {
    query = query.gte("timestamp", since.toISOString());
  }

  const { data, error } = await query;

  if (error || !data) {
    logger.error("Failed to query tool usage stats", { error: error?.message });
    return { total_calls: 0, success_rate: 0, tools_used: {}, avg_duration_ms: 0 };
  }

  const totalCalls = data.length;
  const successCount = data.filter(d => d.success).length;
  const successRate = totalCalls > 0 ? successCount / totalCalls : 0;

  const toolsUsed: Record<string, number> = {};
  let totalDuration = 0;
  let durationCount = 0;

  for (const row of data) {
    toolsUsed[row.tool_name] = (toolsUsed[row.tool_name] || 0) + 1;
    if (row.duration_ms) {
      totalDuration += row.duration_ms;
      durationCount++;
    }
  }

  const avgDuration = durationCount > 0 ? totalDuration / durationCount : 0;

  return {
    total_calls: totalCalls,
    success_rate: successRate,
    tools_used: toolsUsed,
    avg_duration_ms: Math.round(avgDuration),
  };
}

/**
 * Detect anomalous tool usage patterns.
 *
 * Flags agents using tools they shouldn't have access to,
 * or unusual usage patterns (excessive failures, high latency).
 */
export async function detectAnomalies(
  supabase: SupabaseClient,
  agentName: string,
  allowedTools: string[],
  since?: Date
): Promise<{
  unauthorized_tools: string[];
  high_failure_rate: boolean;
  excessive_latency: boolean;
}> {
  const recentUsage = await getAgentToolUsage(supabase, agentName, {
    limit: 100,
    since,
  });

  const unauthorizedTools = new Set<string>();
  let failureCount = 0;
  let highLatencyCount = 0;

  for (const entry of recentUsage) {
    if (!allowedTools.includes(entry.tool_name)) {
      unauthorizedTools.add(entry.tool_name);
    }
    if (!entry.success) {
      failureCount++;
    }
    if (entry.duration_ms && entry.duration_ms > 30000) {
      highLatencyCount++;
    }
  }

  const failureRate = recentUsage.length > 0 ? failureCount / recentUsage.length : 0;

  return {
    unauthorized_tools: Array.from(unauthorizedTools),
    high_failure_rate: failureRate > 0.5,  // > 50% failure rate
    excessive_latency: highLatencyCount > 10,  // > 10 high-latency calls
  };
}
