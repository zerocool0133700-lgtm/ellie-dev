/**
 * Prompt Identity Injector — ELLIE-608
 *
 * Builds prompt sections from an agent's archetype + role binding.
 * Archetype sections (HOW the agent behaves) are injected near soul at priority 3.
 * Role sections (WHAT the agent does) are injected near tools/context at priority 5.
 *
 * Graceful degradation: if archetype or role is missing, those sections
 * are simply omitted — the prompt still builds without them.
 *
 * Depends on:
 *   agent-identity-binding.ts (ELLIE-607) — binding lookup
 *   archetype-loader.ts (ELLIE-604) — archetype config
 *   role-loader.ts (ELLIE-606) — role config
 *
 * Pure module — no side effects, no I/O.
 */

import { resolveBinding, type ResolvedBinding } from "./agent-identity-binding";
import type { ArchetypeConfig } from "./archetype-loader";
import type { RoleConfig } from "./role-loader";
import type { ArchetypeSection } from "./archetype-schema";
import type { RoleSection } from "./role-schema";

// ── Types ────────────────────────────────────────────────────────────────────

/** A prompt section ready for injection into buildPrompt's sections array. */
export interface IdentityPromptSection {
  label: string;
  content: string;
  priority: number;
}

/** Result of building identity sections for an agent. */
export interface IdentityInjectionResult {
  agentName: string;
  sections: IdentityPromptSection[];
  hasArchetype: boolean;
  hasRole: boolean;
  warnings: string[];
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Priority for archetype sections — near soul, shapes behavioral DNA. */
export const ARCHETYPE_PRIORITY = 3;

/** Priority for role sections — near tools/context, shapes capabilities. */
export const ROLE_PRIORITY = 5;

// ── Section Builders ─────────────────────────────────────────────────────────

/**
 * Format archetype sections into a single prompt block.
 * Includes species, cognitive style, and all body sections.
 */
export function buildArchetypeSections(config: ArchetypeConfig): string {
  const lines: string[] = [];

  const { species, cognitive_style } = config.schema.frontmatter;
  lines.push(`# Behavioral Archetype: ${species}`);
  if (cognitive_style) {
    lines.push(`Cognitive style: ${cognitive_style}`);
  }
  lines.push("");

  for (const section of config.schema.sections) {
    lines.push(`## ${section.heading}`);
    if (section.content) {
      lines.push(section.content);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

/**
 * Format role sections into a single prompt block.
 * Includes role name, purpose, and all body sections.
 */
export function buildRoleSections(config: RoleConfig): string {
  const lines: string[] = [];

  const { role, purpose } = config.schema.frontmatter;
  lines.push(`# Agent Role: ${role}`);
  if (purpose) {
    lines.push(`Purpose: ${purpose}`);
  }
  lines.push("");

  for (const section of config.schema.sections) {
    lines.push(`## ${section.heading}`);
    if (section.content) {
      lines.push(section.content);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

// ── Main Injection ───────────────────────────────────────────────────────────

/**
 * Build identity prompt sections for an agent.
 *
 * Resolves the agent's binding and produces PromptSection entries for
 * its archetype (priority 3) and role (priority 5).
 *
 * Returns an empty sections array if the agent has no binding or
 * if both archetype and role are missing.
 */
export function buildIdentitySections(agentName: string): IdentityInjectionResult {
  const resolved = resolveBinding(agentName);

  if (!resolved) {
    return {
      agentName,
      sections: [],
      hasArchetype: false,
      hasRole: false,
      warnings: [`No identity binding found for agent "${agentName}"`],
    };
  }

  const sections: IdentityPromptSection[] = [];
  const warnings: string[] = resolved.warnings.map(w => w.message);

  if (resolved.archetype) {
    const content = buildArchetypeSections(resolved.archetype);
    if (content) {
      sections.push({
        label: "identity-archetype",
        content: `${content}\n---`,
        priority: ARCHETYPE_PRIORITY,
      });
    }
  }

  if (resolved.role) {
    const content = buildRoleSections(resolved.role);
    if (content) {
      sections.push({
        label: "identity-role",
        content: `${content}\n---`,
        priority: ROLE_PRIORITY,
      });
    }
  }

  return {
    agentName: resolved.agentName,
    sections,
    hasArchetype: resolved.archetype !== null,
    hasRole: resolved.role !== null,
    warnings,
  };
}

/**
 * Convenience: get just the PromptSection array for direct spreading
 * into the prompt builder's sections array.
 */
export function getIdentityPromptSections(agentName: string): IdentityPromptSection[] {
  return buildIdentitySections(agentName).sections;
}
