/**
 * Agent Memory Store — ELLIE-1027
 * Filesystem-based persistent memory per creature.
 * Append-only markdown files organized by agent and category.
 */

import { log } from "./logger.ts";
import { mkdir, readdir, readFile, appendFile, stat } from "node:fs/promises";
import { join } from "node:path";

const logger = log.child("agent-memory");

const MEMORY_ROOT = join(import.meta.dir, "..", "agent-memory");

const VALID_CATEGORIES = ["decisions", "learnings", "preferences", "session-notes"] as const;
type MemoryCategory = typeof VALID_CATEGORIES[number];

export interface AgentMemoryEntry {
  timestamp: string;
  content: string;
  workItemId?: string;
  category: string;
}

export interface WriteMemoryOpts {
  agent: string;
  category: MemoryCategory;
  content: string;
  workItemId?: string;
}

/** Initialize directory structure for an agent */
export async function initAgentMemoryDir(agent: string): Promise<void> {
  const agentDir = join(MEMORY_ROOT, agent);
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(agentDir, "session-notes"), { recursive: true });

  // Create empty category files if they don't exist
  for (const cat of ["decisions", "learnings", "preferences"]) {
    const filePath = join(agentDir, `${cat}.md`);
    try {
      await stat(filePath);
    } catch {
      await appendFile(filePath, `# ${agent} — ${cat}\n\n`);
    }
  }
}

/** Append a memory entry to the appropriate file */
export async function writeAgentMemory(opts: WriteMemoryOpts): Promise<void> {
  const { agent, category, content, workItemId } = opts;

  if (!VALID_CATEGORIES.includes(category)) {
    throw new Error(`Invalid category: ${category}. Must be one of: ${VALID_CATEGORIES.join(", ")}`);
  }

  // Ensure directory exists
  await initAgentMemoryDir(agent);

  const timestamp = new Date().toISOString();
  const header = workItemId
    ? `## ${timestamp} | ${workItemId}`
    : `## ${timestamp}`;

  let filePath: string;
  if (category === "session-notes") {
    const date = new Date().toISOString().split("T")[0];
    filePath = join(MEMORY_ROOT, agent, "session-notes", `${date}.md`);
  } else {
    filePath = join(MEMORY_ROOT, agent, `${category}.md`);
  }

  const entry = `\n${header}\n${content.trim()}\n`;
  await appendFile(filePath, entry);

  logger.info("Wrote agent memory", { agent, category, workItemId, chars: content.length });
}

/** Read all memories for an agent, optionally filtered by category */
export async function readAgentMemory(agent: string, opts?: {
  category?: MemoryCategory;
  since?: Date;
  limit?: number;
}): Promise<AgentMemoryEntry[]> {
  const agentDir = join(MEMORY_ROOT, agent);
  const entries: AgentMemoryEntry[] = [];

  try {
    await stat(agentDir);
  } catch {
    return []; // Agent has no memory directory yet
  }

  const categoriesToRead = opts?.category ? [opts.category] : [...VALID_CATEGORIES];

  for (const cat of categoriesToRead) {
    let filePaths: string[] = [];

    if (cat === "session-notes") {
      const notesDir = join(agentDir, "session-notes");
      try {
        const files = await readdir(notesDir);
        filePaths = files.filter(f => f.endsWith(".md")).map(f => join(notesDir, f));
      } catch {
        continue;
      }
    } else {
      filePaths = [join(agentDir, `${cat}.md`)];
    }

    for (const fp of filePaths) {
      try {
        const content = await readFile(fp, "utf-8");
        const parsed = parseMemoryFile(content, cat);
        entries.push(...parsed);
      } catch {
        continue; // File doesn't exist yet
      }
    }
  }

  // Filter by date if specified
  let filtered = entries;
  if (opts?.since) {
    const sinceMs = opts.since.getTime();
    filtered = entries.filter(e => new Date(e.timestamp).getTime() >= sinceMs);
  }

  // Sort by timestamp descending (most recent first)
  filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  // Limit
  if (opts?.limit && opts.limit > 0) {
    filtered = filtered.slice(0, opts.limit);
  }

  return filtered;
}

/** Parse a memory markdown file into structured entries */
function parseMemoryFile(content: string, category: string): AgentMemoryEntry[] {
  const entries: AgentMemoryEntry[] = [];
  const sections = content.split(/^## /m).filter(s => s.trim());

  for (const section of sections) {
    const lines = section.split("\n");
    const headerLine = lines[0]?.trim();

    // Parse header: "2026-03-26T14:30:00Z | ELLIE-1024" or "2026-03-26T14:30:00Z"
    const headerMatch = headerLine?.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)(?:\s*\|\s*(ELLIE-\d+))?/);
    if (!headerMatch) continue;

    const timestamp = headerMatch[1];
    const workItemId = headerMatch[2];
    const body = lines.slice(1).join("\n").trim();
    if (!body) continue;

    entries.push({ timestamp, content: body, workItemId, category });
  }

  return entries;
}

/** List all agents that have memory directories */
export async function listAgentMemoryDirs(): Promise<string[]> {
  try {
    const dirs = await readdir(MEMORY_ROOT);
    const agents: string[] = [];
    for (const d of dirs) {
      const s = await stat(join(MEMORY_ROOT, d));
      if (s.isDirectory()) agents.push(d);
    }
    return agents.sort();
  } catch {
    return [];
  }
}

/** Get a compact summary for prompt injection (token-budgeted) */
export async function getAgentMemorySummary(agent: string, maxTokens: number = 2000): Promise<string> {
  const entries = await readAgentMemory(agent, { limit: 20 });
  if (entries.length === 0) return "";

  // Rough token estimate: 1 token ≈ 4 characters
  const maxChars = maxTokens * 4;
  let result = "";
  let chars = 0;

  for (const entry of entries) {
    const line = `- [${entry.category}] ${entry.workItemId ? `(${entry.workItemId}) ` : ""}${entry.content}\n`;
    if (chars + line.length > maxChars) break;
    result += line;
    chars += line.length;
  }

  return result.trim();
}

// Export for testing
export { MEMORY_ROOT, VALID_CATEGORIES, parseMemoryFile as _parseMemoryFile };
