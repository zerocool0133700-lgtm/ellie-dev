/**
 * Formation Marketplace — ELLIE-734
 *
 * Backend logic for browsing, previewing, installing, and managing
 * formation templates. The 'app store' for agent teams.
 *
 * Builds on ELLIE-733 (registry) and ELLIE-732 (export/import).
 * Pure module — types, view models, install orchestration logic.
 */

import type { TemplateMetadata, TemplateCategory, TemplateSource } from "./formation-registry";
import type { ExportedAgent, ExportedProtocol, AgentCollision, CollisionStrategy } from "./formation-export";
import { detectCollisions, resolveCollisions, generateUniqueName } from "./formation-export";

// ── View Models (for dashboard rendering) ───────────────────

/** Card data for the marketplace grid. */
export interface TemplateCard {
  slug: string;
  name: string;
  description: string;
  categories: TemplateCategory[];
  agent_count: number;
  author: string;
  source: TemplateSource;
  version: string;
  is_installed: boolean;
}

/** Full detail view for a template. */
export interface TemplateDetailView {
  slug: string;
  name: string;
  description: string;
  categories: TemplateCategory[];
  source: TemplateSource;
  author: string;
  version: string;
  path: string;
  agents: AgentPreview[];
  protocol: ProtocolOverview;
  is_installed: boolean;
  install_status: InstallStatus | null;
}

export interface AgentPreview {
  name: string;
  type: string;
  role: string;
  responsibility: string;
}

export interface ProtocolOverview {
  pattern: string;
  maxTurns: number;
  coordinator: string | null;
  requiresApproval: boolean;
}

/** Installation status for a formation. */
export type InstallStatus = "available" | "installed" | "update_available" | "installing";

/** An installed formation record. */
export interface InstalledFormation {
  slug: string;
  name: string;
  version: string;
  installed_at: string;
  source: TemplateSource;
  status: "active" | "paused";
  agent_count: number;
}

/** Result of an install attempt. */
export interface InstallResult {
  success: boolean;
  slug: string;
  agents_created: string[];
  agents_skipped: string[];
  agents_renamed: Record<string, string>;
  errors: string[];
}

/** Install options with collision resolution. */
export interface InstallOptions {
  collisions: Record<string, CollisionStrategy>;
  rename_map: Record<string, string>;
}

// ── Card Builder ────────────────────────────────────────────

/**
 * Build template cards for the marketplace grid.
 * Pure function — marks installed status based on the installed set.
 */
export function buildTemplateCards(
  templates: TemplateMetadata[],
  installedSlugs: Set<string>,
): TemplateCard[] {
  return templates.map(t => ({
    slug: t.slug,
    name: t.name,
    description: t.description,
    categories: t.categories,
    agent_count: t.agent_count,
    author: t.author,
    source: t.source,
    version: t.version,
    is_installed: installedSlugs.has(t.slug),
  }));
}

// ── Detail View Builder ─────────────────────────────────────

/**
 * Build a template detail view from metadata and agent/protocol info.
 */
export function buildDetailView(
  meta: TemplateMetadata,
  agents: ExportedAgent[],
  protocol: ExportedProtocol,
  installedSlugs: Set<string>,
  installedVersions?: Map<string, string>,
): TemplateDetailView {
  let installStatus: InstallStatus = "available";
  if (installedSlugs.has(meta.slug)) {
    const installedVer = installedVersions?.get(meta.slug);
    installStatus = installedVer && installedVer !== meta.version
      ? "update_available"
      : "installed";
  }

  return {
    slug: meta.slug,
    name: meta.name,
    description: meta.description,
    categories: meta.categories,
    source: meta.source,
    author: meta.author,
    version: meta.version,
    path: meta.path,
    agents: agents.map(a => ({
      name: a.name,
      type: a.type,
      role: a.role,
      responsibility: a.responsibility,
    })),
    protocol: {
      pattern: protocol.pattern,
      maxTurns: protocol.maxTurns,
      coordinator: protocol.coordinator,
      requiresApproval: protocol.requiresApproval,
    },
    is_installed: installedSlugs.has(meta.slug),
    install_status: installStatus,
  };
}

// ── Install Orchestration ───────────────────────────────────

/**
 * Plan an installation: detect collisions and prepare the install.
 * Returns collisions that need resolution before proceeding.
 */
export function planInstall(
  agents: ExportedAgent[],
  existingAgentNames: Set<string>,
): AgentCollision[] {
  return detectCollisions(agents, existingAgentNames);
}

/**
 * Execute an installation with resolved collisions.
 * Returns the final agent list after applying collision resolutions.
 *
 * Pure function — caller handles actual DB provisioning.
 */
export function executeInstall(
  slug: string,
  agents: ExportedAgent[],
  existingAgentNames: Set<string>,
  options: InstallOptions,
): InstallResult {
  const errors: string[] = [];
  const agentsCreated: string[] = [];
  const agentsSkipped: string[] = [];
  const agentsRenamed: Record<string, string> = {};

  // Build collision list from options
  const collisions: AgentCollision[] = agents
    .filter(a => existingAgentNames.has(a.name))
    .map(a => {
      const strategy = options.collisions[a.name] ?? "skip";
      let renamedTo: string | null = null;

      if (strategy === "rename") {
        renamedTo = options.rename_map[a.name]
          ?? generateUniqueName(a.name, existingAgentNames);
      }

      return {
        imported_name: a.name,
        existing_name: a.name,
        strategy,
        renamed_to: renamedTo,
      };
    });

  // Resolve
  const resolved = resolveCollisions(agents, collisions);

  // Track what happened
  for (const agent of agents) {
    const collision = collisions.find(c => c.imported_name === agent.name);
    if (!collision) {
      agentsCreated.push(agent.name);
    } else if (collision.strategy === "skip") {
      agentsSkipped.push(agent.name);
    } else if (collision.strategy === "rename" && collision.renamed_to) {
      agentsRenamed[agent.name] = collision.renamed_to;
      agentsCreated.push(collision.renamed_to);
    } else if (collision.strategy === "overwrite") {
      agentsCreated.push(agent.name);
    }
  }

  return {
    success: errors.length === 0,
    slug,
    agents_created: agentsCreated,
    agents_skipped: agentsSkipped,
    agents_renamed: agentsRenamed,
    errors,
  };
}

// ── Installed Formations ────────────────────────────────────

/**
 * Build the "My Formations" list from installed records.
 * Pure function — caller provides the data.
 */
export function buildInstalledList(
  formations: InstalledFormation[],
  filter?: { status?: "active" | "paused" },
): InstalledFormation[] {
  let result = [...formations];

  if (filter?.status) {
    result = result.filter(f => f.status === filter.status);
  }

  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Compute install statistics for the dashboard.
 */
export function computeInstallStats(formations: InstalledFormation[]): {
  total: number;
  active: number;
  paused: number;
  by_source: Record<TemplateSource, number>;
} {
  const bySource: Record<TemplateSource, number> = { bundled: 0, marketplace: 0, custom: 0 };

  for (const f of formations) {
    bySource[f.source] = (bySource[f.source] || 0) + 1;
  }

  return {
    total: formations.length,
    active: formations.filter(f => f.status === "active").length,
    paused: formations.filter(f => f.status === "paused").length,
    by_source: bySource,
  };
}
