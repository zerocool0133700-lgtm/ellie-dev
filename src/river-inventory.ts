/**
 * River Inventory — ELLIE-760
 *
 * Lists all River documents with wiring status, agent consumers,
 * token counts, and summary statistics. Powers the dashboard
 * River Control Panel.
 */

import { getCachedRiverDoc } from "./prompt-builder.ts";
import { estimateTokens } from "./relay-utils.ts";
import { buildObsidianUri } from "./prompt-preview.ts";
import { statSync } from "fs";
import { join } from "path";

// ── Types ────────────────────────────────────────────────────

export type RiverDocStatus = "wired" | "draft" | "missing" | "hardcoded";

export interface RiverDocEntry {
  key: string;
  path: string;
  status: RiverDocStatus;
  last_modified: string | null;
  used_by_agents: string[];
  tokens: number;
  edit_uri: string;
}

export interface RiverInventoryResult {
  total: number;
  docs: RiverDocEntry[];
  summary: {
    wired: number;
    draft: number;
    missing: number;
    hardcoded: number;
  };
}

// ── Registry ────────────────────────────────────────────────

/** All known River doc keys with their vault-relative paths. */
export const RIVER_DOC_REGISTRY: { key: string; path: string }[] = [
  { key: "soul", path: "soul/soul.md" },
  { key: "memory-protocol", path: "prompts/protocols/memory-management.md" },
  { key: "confirm-protocol", path: "prompts/protocols/action-confirmations.md" },
  { key: "forest-writes", path: "prompts/protocols/forest-writes.md" },
  { key: "dev-agent-template", path: "templates/dev-agent-base.md" },
  { key: "research-agent-template", path: "templates/research-agent-base.md" },
  { key: "strategy-agent-template", path: "templates/strategy-agent-base.md" },
  { key: "playbook-commands", path: "prompts/protocols/playbook-commands.md" },
  { key: "work-commands", path: "prompts/protocols/work-commands.md" },
  { key: "planning-mode", path: "prompts/protocols/planning-mode.md" },
  { key: "commitment-framework", path: "frameworks/commitment-framework.md" },
];

/** Which agents consume each River doc. */
export const DOC_AGENT_MAP: Record<string, string[]> = {
  "soul": ["general", "dev", "research", "strategy", "critic", "ops", "content", "finance"],
  "memory-protocol": ["general", "dev", "research", "strategy", "critic", "ops", "content", "finance"],
  "confirm-protocol": ["general", "dev", "research", "strategy", "critic", "ops", "content", "finance"],
  "forest-writes": ["general", "dev", "research", "strategy"],
  "dev-agent-template": ["dev"],
  "research-agent-template": ["research"],
  "strategy-agent-template": ["strategy"],
  "playbook-commands": ["general"],
  "work-commands": ["general", "dev"],
  "planning-mode": ["general", "dev", "research", "strategy"],
  "commitment-framework": ["general"],
};

// ── Inventory Builder ───────────────────────────────────────

/** Default vault path on the server. */
const DEFAULT_VAULT_PATH = "/home/ellie/obsidian-vault/ellie-river";

/**
 * Build the full River document inventory.
 * Checks cache state, filesystem, and agent mappings.
 */
export function buildInventory(vaultPath?: string): RiverInventoryResult {
  const vault = vaultPath ?? DEFAULT_VAULT_PATH;
  const docs: RiverDocEntry[] = [];

  for (const { key, path } of RIVER_DOC_REGISTRY) {
    const cached = getCachedRiverDoc(key);
    const fullPath = join(vault, path);
    const fileExists = fileExistsSync(fullPath);
    const lastMod = fileExists ? getLastModified(fullPath) : null;

    let status: RiverDocStatus;
    let tokens = 0;

    if (cached) {
      status = "wired";
      tokens = estimateTokens(cached);
    } else if (fileExists) {
      status = "draft"; // File exists but not loaded into cache
    } else {
      status = "missing";
    }

    const riverPath = `river/${path}`;
    docs.push({
      key,
      path: riverPath,
      status,
      last_modified: lastMod,
      used_by_agents: DOC_AGENT_MAP[key] ?? [],
      tokens,
      edit_uri: buildObsidianUri(riverPath),
    });
  }

  const summary = {
    wired: docs.filter(d => d.status === "wired").length,
    draft: docs.filter(d => d.status === "draft").length,
    missing: docs.filter(d => d.status === "missing").length,
    hardcoded: 0,
  };

  return { total: docs.length, docs, summary };
}

/**
 * Build inventory from pre-provided data (for testing without filesystem).
 * Pure function.
 */
export function buildInventoryFromData(
  cacheState: Record<string, string | null>,
  fileState: Record<string, boolean>,
): RiverInventoryResult {
  const docs: RiverDocEntry[] = [];

  for (const { key, path } of RIVER_DOC_REGISTRY) {
    const cached = cacheState[key] ?? null;
    const fileExists = fileState[key] ?? false;

    let status: RiverDocStatus;
    let tokens = 0;

    if (cached) {
      status = "wired";
      tokens = estimateTokens(cached);
    } else if (fileExists) {
      status = "draft";
    } else {
      status = "missing";
    }

    const riverPath = `river/${path}`;
    docs.push({
      key,
      path: riverPath,
      status,
      last_modified: null,
      used_by_agents: DOC_AGENT_MAP[key] ?? [],
      tokens,
      edit_uri: buildObsidianUri(riverPath),
    });
  }

  const summary = {
    wired: docs.filter(d => d.status === "wired").length,
    draft: docs.filter(d => d.status === "draft").length,
    missing: docs.filter(d => d.status === "missing").length,
    hardcoded: 0,
  };

  return { total: docs.length, docs, summary };
}

// ── Helpers ──────────────────────────────────────────────────

function fileExistsSync(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function getLastModified(path: string): string | null {
  try {
    const stat = statSync(path);
    return stat.mtime.toISOString();
  } catch {
    return null;
  }
}
