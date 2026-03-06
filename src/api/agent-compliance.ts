/**
 * Agent Compliance API — ELLIE-624
 *
 * GET /api/agents/compliance — per-agent archetype compliance overview
 *
 * Returns each agent's identity binding (archetype + role) and growth metric
 * summaries.  Data populates as upstream tickets land:
 *   - ELLIE-615 wires identity bindings at startup
 *   - ELLIE-622 wires metric collection to work sessions
 *
 * Until those are live the endpoint still returns the default binding table
 * with empty metric arrays — enough for the dashboard to render structure.
 */

import type { ApiRequest, ApiResponse } from "./types.ts";
import {
  listBindings,
  DEFAULT_BINDINGS,
  type AgentBinding,
} from "../agent-identity-binding.ts";
import {
  buildAgentReport,
  type AgentMetricsReport,
} from "../growth-metrics-collector.ts";
import { log } from "../logger.ts";

const logger = log.child("agent-compliance");

export interface ComplianceAgent {
  agentName: string;
  archetype: string;
  role: string;
  metrics: AgentMetricsReport | null;
}

export interface ComplianceResponse {
  success: boolean;
  agents: ComplianceAgent[];
  bindingsSource: "runtime" | "defaults";
}

export async function agentComplianceEndpoint(
  _req: ApiRequest,
  res: ApiResponse,
): Promise<void> {
  try {
    // Prefer runtime bindings; fall back to defaults if identity system
    // hasn't been wired yet (ELLIE-615).
    let bindings: AgentBinding[] = listBindings();
    let source: "runtime" | "defaults" = "runtime";

    if (bindings.length === 0) {
      bindings = DEFAULT_BINDINGS;
      source = "defaults";
    }

    const agents: ComplianceAgent[] = await Promise.all(
      bindings.map(async (b) => {
        let metrics: AgentMetricsReport | null = null;
        try {
          metrics = await buildAgentReport(b.agentName);
          // Omit raw data points for the list view — keep payload small.
          // The full report is available per-agent if needed later.
          if (metrics && metrics.dataPoints.length > 50) {
            metrics = { ...metrics, dataPoints: metrics.dataPoints.slice(-50) };
          }
        } catch (err) {
          logger.warn(`Metrics unavailable for ${b.agentName}`, err);
        }
        return {
          agentName: b.agentName,
          archetype: b.archetype,
          role: b.role,
          metrics,
        };
      }),
    );

    return res.json({ success: true, agents, bindingsSource: source });
  } catch (err) {
    logger.error("Compliance endpoint failed", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
