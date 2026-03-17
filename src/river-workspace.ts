/**
 * River Workspace — ELLIE-822, ELLIE-823, ELLIE-826, ELLIE-828
 *
 * Manages per-agent private workspaces (River) and publish-to-Grove workflow.
 * River is the agent's thinking space; Grove is shared, vetted knowledge.
 */

import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { sql } from "../../ellie-forest/src/index";
import { canAgentReadScope, canAgentWriteScope, resolveAgentEntityId } from "./forest-grove.ts";
import { canEntityDo, invalidateCache } from "./permissions.ts";
import { log } from "./logger.ts";

const logger = log.child("river-workspace");

// ── Constants ────────────────────────────────────────────────────

const RIVER_BASE = process.env.RIVER_BASE ?? "/home/ellie/obsidian-vault/ellie-river";

/** ELLIE-828: Role-specific River subdirectory templates. */
export const AGENT_TEMPLATES: Record<string, string[]> = {
  dev:       ["scratch", "investigation", "work-trails", "architecture-notes"],
  research:  ["drafts", "client-notes", "research", "scope-analysis"],
  critic:    ["analysis", "overruled-tracking", "scenario-modeling", "pattern-library"],
  content:   ["drafts", "outlines", "revisions", "published"],
  strategy:  ["analysis", "proposals", "market-research", "frameworks"],
  finance:   ["reports", "projections", "audit-notes", "models"],
  general:   ["notes", "coordination", "summaries"],
  ops:       ["runbooks", "incident-notes", "monitoring", "playbooks"],
};

// ── Types ────────────────────────────────────────────────────────

export interface RiverWorkspace {
  agent: string;
  basePath: string;
  directories: string[];
  exists: boolean;
}

export interface PublishResult {
  success: boolean;
  error?: string;
  sourcePath?: string;
  targetPath?: string;
  groveSpace?: string;
}

// ── ELLIE-822: Workspace provisioning ────────────────────────────

/**
 * Create a River workspace for an agent. Idempotent.
 * Creates the base directory + role-specific subdirectories.
 */
export function provisionWorkspace(agent: string, baseDir?: string): RiverWorkspace {
  const base = baseDir ?? RIVER_BASE;
  const agentDir = join(base, "river", agent);
  const template = AGENT_TEMPLATES[agent] ?? AGENT_TEMPLATES.general;

  const directories: string[] = [];

  // Create base directory
  if (!existsSync(agentDir)) {
    mkdirSync(agentDir, { recursive: true });
  }
  directories.push(agentDir);

  // Create subdirectories from template
  for (const sub of template) {
    const subDir = join(agentDir, sub);
    if (!existsSync(subDir)) {
      mkdirSync(subDir, { recursive: true });
    }
    directories.push(subDir);
  }

  // Create a README in the workspace
  const readmePath = join(agentDir, "README.md");
  if (!existsSync(readmePath)) {
    writeFileSync(readmePath, `# ${agent} River Workspace\n\nPrivate thinking space for the ${agent} agent.\nFiles here are not shared — publish to Grove when ready.\n`);
  }

  return {
    agent,
    basePath: agentDir,
    directories,
    exists: true,
  };
}

/**
 * Provision workspaces for all known agents.
 */
export function provisionAllWorkspaces(baseDir?: string): RiverWorkspace[] {
  return Object.keys(AGENT_TEMPLATES).map(agent => provisionWorkspace(agent, baseDir));
}

/**
 * Get workspace info for an agent (without creating).
 */
export function getWorkspace(agent: string, baseDir?: string): RiverWorkspace {
  const base = baseDir ?? RIVER_BASE;
  const agentDir = join(base, "river", agent);
  const template = AGENT_TEMPLATES[agent] ?? AGENT_TEMPLATES.general;
  const exists = existsSync(agentDir);

  return {
    agent,
    basePath: agentDir,
    directories: exists ? template.map(s => join(agentDir, s)).filter(existsSync) : [],
    exists,
  };
}

// ── ELLIE-823: River RBAC enforcement ────────────────────────────

/**
 * Check if an agent can access a River path.
 * Rules:
 *   - Owner always has full access to their own workspace
 *   - Dave (admin) has override access
 *   - No cross-agent access by default
 */
export async function canAccessRiverPath(
  callerAgent: string,
  targetPath: string,
): Promise<{ read: boolean; write: boolean }> {
  // Extract the workspace owner from the path: river/<owner>/...
  const match = targetPath.match(/river\/([^/]+)/);
  if (!match) return { read: false, write: false };
  const owner = match[1];

  // Owner always has full access
  if (callerAgent === owner) return { read: true, write: true };

  // Check RBAC for admin override (Dave/Ellie)
  const entityId = await resolveAgentEntityId(callerAgent);
  if (entityId) {
    const isAdmin = await canEntityDo(sql, entityId, "river", "admin_read");
    if (isAdmin) return { read: true, write: false }; // Admin can read but not write others' workspaces
  }

  // No cross-agent access
  return { read: false, write: false };
}

// ── ELLIE-826: Publish workflow (River → Grove) ──────────────────

/**
 * Publish a file from an agent's River workspace to a Grove space.
 * Checks RBAC: agent must have write access to the target Grove.
 */
export async function publishToGrove(
  agent: string,
  sourceFile: string,
  groveSpace: string,
  baseDir?: string,
): Promise<PublishResult> {
  const base = baseDir ?? RIVER_BASE;

  // 1. Verify source file exists in agent's River workspace
  const sourcePath = join(base, "river", agent, sourceFile);
  if (!existsSync(sourcePath)) {
    return { success: false, error: `Source file not found: ${sourceFile}` };
  }

  // 2. Check RBAC: agent must have write access to the target grove space
  const entityId = await resolveAgentEntityId(agent);
  if (!entityId) {
    return { success: false, error: `Agent "${agent}" not found in RBAC` };
  }

  // Map grove space to scope path
  const scopePath = `2/grove/${groveSpace}`;
  const hasWrite = await canAgentWriteScope(entityId, scopePath);
  if (!hasWrite) {
    return {
      success: false,
      error: `Agent "${agent}" lacks write access to grove space "${groveSpace}"`,
    };
  }

  // 3. Copy file to grove directory
  const targetDir = join(base, "grove", groveSpace);
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  const content = readFileSync(sourcePath, "utf-8");
  const fileName = sourceFile.split("/").pop()!;
  const targetPath = join(targetDir, fileName);

  // Add publish metadata
  const publishMeta = `---\nauthor: ${agent}\npublished_at: ${new Date().toISOString()}\nsource: river/${agent}/${sourceFile}\n---\n\n`;
  writeFileSync(targetPath, publishMeta + content);

  logger.info(`[publish] ${agent}: river/${agent}/${sourceFile} → grove/${groveSpace}/${fileName}`);

  return {
    success: true,
    sourcePath: `river/${agent}/${sourceFile}`,
    targetPath: `grove/${groveSpace}/${fileName}`,
    groveSpace,
  };
}

/**
 * List files in an agent's River workspace.
 */
export function listWorkspaceFiles(agent: string, subdir?: string, baseDir?: string): string[] {
  const base = baseDir ?? RIVER_BASE;
  const dir = subdir ? join(base, "river", agent, subdir) : join(base, "river", agent);
  if (!existsSync(dir)) return [];

  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isFile())
      .map(d => d.name);
  } catch {
    return [];
  }
}
