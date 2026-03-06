/**
 * Identity System Observability Endpoints — ELLIE-621
 *
 * GET /api/archetypes          — list loaded archetypes with section counts
 * GET /api/agents/bindings     — all bindings with validation warnings
 * GET /api/agents/:name/identity — resolved identity for a specific agent
 */

import type { ApiRequest, ApiResponse } from "./types.ts";
import {
  listArchetypeConfigs,
  type ArchetypeConfig,
} from "../archetype-loader.ts";
import {
  listBindings,
  validateAllBindings,
  resolveBinding,
} from "../agent-identity-binding.ts";
import { getIdentityStatus } from "../identity-startup.ts";

// ── GET /api/archetypes ──────────────────────────────────────────────────────

export interface ArchetypeListItem {
  species: string;
  cognitiveStyle: string;
  sectionCount: number;
  sections: string[];
  tokenBudget?: number;
  valid: boolean;
  errorCount: number;
}

export interface ArchetypesResponse {
  success: boolean;
  count: number;
  archetypes: ArchetypeListItem[];
}

export function archetypesEndpoint(_req: ApiRequest, res: ApiResponse): void {
  const configs = listArchetypeConfigs();

  const archetypes: ArchetypeListItem[] = configs.map((c: ArchetypeConfig) => ({
    species: c.species,
    cognitiveStyle: c.schema.frontmatter.cognitive_style,
    sectionCount: c.schema.sections.length,
    sections: c.schema.sections.map((s) => s.heading),
    tokenBudget: c.schema.frontmatter.token_budget,
    valid: c.validation.valid,
    errorCount: c.validation.errors.length,
  }));

  res.json({ success: true, count: archetypes.length, archetypes });
}

// ── GET /api/agents/bindings ─────────────────────────────────────────────────

export interface BindingsResponse {
  success: boolean;
  count: number;
  bindings: Array<{
    agentName: string;
    archetype: string;
    role: string;
  }>;
  validation: {
    valid: boolean;
    warningCount: number;
    warnings: Array<{
      agentName: string;
      field: string;
      message: string;
    }>;
  };
  status: {
    archetypes: number;
    roles: number;
    bindings: number;
  };
}

export function bindingsEndpoint(_req: ApiRequest, res: ApiResponse): void {
  const bindings = listBindings();
  const validation = validateAllBindings();
  const status = getIdentityStatus();

  res.json({
    success: true,
    count: bindings.length,
    bindings,
    validation: {
      valid: validation.valid,
      warningCount: validation.warnings.length,
      warnings: validation.warnings,
    },
    status,
  });
}

// ── GET /api/agents/:name/identity ───────────────────────────────────────────

export interface AgentIdentityResponse {
  success: boolean;
  agentName: string;
  archetype: {
    species: string;
    cognitiveStyle: string;
    sectionCount: number;
    sections: string[];
    tokenBudget?: number;
  } | null;
  role: {
    role: string;
    purpose: string;
    sectionCount: number;
  } | null;
  warnings: Array<{
    agentName: string;
    field: string;
    message: string;
  }>;
}

export function agentIdentityEndpoint(req: ApiRequest, res: ApiResponse): void {
  const agentName = req.params?.name;
  if (!agentName) {
    res.status(400).json({ success: false, error: "Agent name is required" });
    return;
  }

  const resolved = resolveBinding(agentName);
  if (!resolved) {
    res.status(404).json({
      success: false,
      error: `No binding found for agent "${agentName}"`,
    });
    return;
  }

  const response: AgentIdentityResponse = {
    success: true,
    agentName: resolved.agentName,
    archetype: resolved.archetype
      ? {
          species: resolved.archetype.species,
          cognitiveStyle: resolved.archetype.schema.frontmatter.cognitive_style,
          sectionCount: resolved.archetype.schema.sections.length,
          sections: resolved.archetype.schema.sections.map((s) => s.heading),
          tokenBudget: resolved.archetype.schema.frontmatter.token_budget,
        }
      : null,
    role: resolved.role
      ? {
          role: resolved.role.role,
          purpose: resolved.role.schema.frontmatter.purpose,
          sectionCount: resolved.role.schema.sections.length,
        }
      : null,
    warnings: resolved.warnings,
  };

  res.json(response);
}
