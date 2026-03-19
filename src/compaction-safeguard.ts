/**
 * Compaction Safeguard — ELLIE-922 Phases 2 & 3
 *
 * Adopts OpenClaw's session branching and compaction safeguard patterns
 * to prevent critical context loss during conversation compression.
 *
 * Phase 2: Verification Logic
 *   - Post-compaction checks for context_anchors and decision_log survival
 *   - Extract and verify critical identifiers (ticket IDs, file paths, errors)
 *
 * Phase 3: Rollback Mechanism
 *   - Restore working memory from Forest snapshot if verification fails
 *   - Log rollback events for debugging and audit trail
 */

import { readWorkingMemory, updateWorkingMemory, type WorkingMemoryRecord } from "./working-memory.ts";
import { writeMemory } from "../../ellie-forest/src/index.ts";
import { log } from "./logger.ts";

const logger = log.child("compaction-safeguard");

// ── Types ────────────────────────────────────────────────────────────────────

export interface SafeguardVerificationResult {
  ok: boolean;
  lost_sections?: string[];
  lost_identifiers?: string[];
  pre_snapshot?: WorkingMemorySnapshot;
}

export interface WorkingMemorySnapshot {
  memory_id: string;
  session_id: string;
  agent: string;
  turn_number: number;
  sections: {
    context_anchors?: string;
    decision_log?: string;
    [key: string]: string | undefined;
  };
  snapshot_timestamp: string;
}

// ── Critical Identifier Extraction (OpenClaw Pattern) ───────────────────────

/**
 * Extract critical identifiers from text that must survive compaction.
 *
 * Patterns (from OpenClaw compaction-safeguard.ts):
 * - Hex IDs (8+ chars): A1B2C3D4E5F6
 * - URLs: https://example.com/path
 * - File paths: /home/user/file.txt, C:\Windows\System32
 * - Ticket IDs: ELLIE-123, JIRA-456
 * - Error codes: 404, 500, ERR_CONNECTION_REFUSED
 * - Ports: :3000, :8080
 */
export function extractCriticalIdentifiers(text: string | undefined): string[] {
  if (!text) return [];

  const identifiers = new Set<string>();

  // Ticket IDs (ELLIE-123, JIRA-456, etc.)
  const ticketIds = text.match(/\b[A-Z]+-\d+\b/g);
  if (ticketIds) {
    ticketIds.forEach((id) => identifiers.add(id));
  }

  // Hex IDs (8+ chars) - use lookahead/lookbehind to handle boundaries better
  const hexIds = text.match(/(?:^|[^A-Za-z0-9])([A-Fa-f0-9]{8,})(?=[^A-Fa-f0-9]|$)/g);
  if (hexIds) {
    hexIds.forEach((match) => {
      // Extract just the hex part (remove any leading non-hex character)
      const id = match.replace(/^[^A-Fa-f0-9]+/, "");
      if (id.length >= 8) {
        identifiers.add(id);
      }
    });
  }

  // URLs
  const urls = text.match(/https?:\/\/\S+/g);
  if (urls) {
    urls.forEach((url) => identifiers.add(url));
  }

  // File paths (Unix)
  const unixPaths = text.match(/\/[\w.-]{2,}(?:\/[\w.-]+)+/g);
  if (unixPaths) {
    unixPaths.forEach((path) => identifiers.add(path));
  }

  // File paths (Windows)
  const winPaths = text.match(/[A-Za-z]:\\[\w\\.-]+/g);
  if (winPaths) {
    winPaths.forEach((path) => identifiers.add(path));
  }

  // Network endpoints (localhost:3000, 127.0.0.1:8080)
  const endpoints = text.match(/(?:localhost|[\d.]+):\d{1,5}/g);
  if (endpoints) {
    endpoints.forEach((ep) => identifiers.add(ep));
  }

  // Error codes (3+ digits)
  const errorCodes = text.match(/\b\d{3,}\b/g);
  if (errorCodes) {
    errorCodes.forEach((code) => identifiers.add(code));
  }

  return Array.from(identifiers);
}

// ── Verification Logic (Phase 2) ─────────────────────────────────────────────

/**
 * Verify that critical working memory sections survived compaction.
 *
 * Checks:
 * 1. context_anchors section exists if it existed before compaction
 * 2. decision_log section exists if it existed before compaction
 * 3. Critical identifiers from context_anchors are preserved
 *
 * Returns verification result with details of any lost sections/identifiers.
 */
export async function verifyWorkingMemorySurvived(opts: {
  session_id: string;
  agent: string;
  pre_snapshot_memory_id?: string;
}): Promise<SafeguardVerificationResult> {
  const { session_id, agent, pre_snapshot_memory_id } = opts;

  // Fetch the pre-compaction snapshot from Forest
  const preSnapshot = await getLatestSnapshot({
    session_id,
    agent,
    memory_id: pre_snapshot_memory_id,
  });

  if (!preSnapshot) {
    logger.warn("No pre-compaction snapshot found — skipping verification", {
      session_id,
      agent,
    });
    return { ok: true }; // Can't verify without a snapshot
  }

  // Fetch current working memory state
  const postMemory = await readWorkingMemory({ session_id, agent });

  if (!postMemory) {
    logger.error("Working memory lost completely after compaction", {
      session_id,
      agent,
      pre_snapshot_memory_id: preSnapshot.memory_id,
    });
    return {
      ok: false,
      lost_sections: ["all"],
      pre_snapshot: preSnapshot,
    };
  }

  const lostSections: string[] = [];
  const lostIdentifiers: string[] = [];

  // Check 1: context_anchors survived
  if (preSnapshot.sections.context_anchors && !postMemory.sections.context_anchors) {
    lostSections.push("context_anchors");
  }

  // Check 2: decision_log survived
  if (preSnapshot.sections.decision_log && !postMemory.sections.decision_log) {
    lostSections.push("decision_log");
  }

  // Check 3: critical identifiers preserved in context_anchors
  if (preSnapshot.sections.context_anchors) {
    const preIdentifiers = extractCriticalIdentifiers(preSnapshot.sections.context_anchors);
    const postIdentifiers = extractCriticalIdentifiers(
      postMemory.sections.context_anchors ?? "",
    );

    const missing = preIdentifiers.filter((id) => !postIdentifiers.includes(id));
    if (missing.length > 0) {
      lostIdentifiers.push(...missing);
    }
  }

  const ok = lostSections.length === 0 && lostIdentifiers.length === 0;

  if (!ok) {
    logger.warn("Compaction safeguard verification failed", {
      session_id,
      agent,
      lost_sections: lostSections,
      lost_identifiers: lostIdentifiers,
    });
  }

  return {
    ok,
    lost_sections: lostSections.length > 0 ? lostSections : undefined,
    lost_identifiers: lostIdentifiers.length > 0 ? lostIdentifiers : undefined,
    pre_snapshot: preSnapshot,
  };
}

// ── Rollback Mechanism (Phase 3) ─────────────────────────────────────────────

/**
 * Restore working memory from the latest Forest snapshot.
 *
 * Called when post-compaction verification detects lost sections or identifiers.
 * Parses the snapshot content back into working memory sections and updates the DB.
 *
 * Returns true if rollback succeeded, false if no snapshot found.
 */
export async function rollbackWorkingMemoryFromSnapshot(opts: {
  session_id: string;
  agent: string;
  pre_snapshot?: WorkingMemorySnapshot;
}): Promise<boolean> {
  const { session_id, agent, pre_snapshot } = opts;

  // Use provided snapshot or fetch latest from Forest
  const snapshot =
    pre_snapshot ??
    (await getLatestSnapshot({
      session_id,
      agent,
    }));

  if (!snapshot) {
    logger.error("Rollback failed — no snapshot found", { session_id, agent });
    return false;
  }

  // Restore sections to working memory
  const restored = await updateWorkingMemory({
    session_id,
    agent,
    sections: snapshot.sections,
  });

  if (!restored) {
    logger.error("Rollback failed — working memory record not found", {
      session_id,
      agent,
    });
    return false;
  }

  logger.warn("Working memory rolled back from snapshot", {
    session_id,
    agent,
    snapshot_id: snapshot.memory_id,
    snapshot_turn: snapshot.turn_number,
    snapshot_timestamp: snapshot.snapshot_timestamp,
  });

  // Write rollback event to Forest for audit trail
  await writeMemory({
    content:
      `Working memory rolled back due to compaction safeguard failure.\n\n` +
      `Session: ${session_id}\n` +
      `Agent: ${agent}\n` +
      `Snapshot ID: ${snapshot.memory_id}\n` +
      `Snapshot Turn: ${snapshot.turn_number}\n` +
      `Restored at: ${new Date().toISOString()}\n\n` +
      `This rollback was triggered automatically to preserve critical context.`,
    type: "fact",
    scope_path: "2/1",
    confidence: 1.0,
    tags: ["compaction_safeguard", "rollback", `agent:${agent}`],
    metadata: {
      source: "compaction_safeguard_rollback",
      session_id,
      agent,
      snapshot_id: snapshot.memory_id,
      snapshot_turn: snapshot.turn_number,
    },
  });

  return true;
}

// ── Helper: Fetch Latest Snapshot ────────────────────────────────────────────

/**
 * Fetch the latest working memory snapshot for a session from Forest.
 *
 * Searches for memories tagged with working_memory_snapshot and matching
 * the session_id + agent. Returns the most recent snapshot.
 */
async function getLatestSnapshot(opts: {
  session_id: string;
  agent: string;
  memory_id?: string;
}): Promise<WorkingMemorySnapshot | null> {
  const { session_id, agent } = opts;

  // Import sql to query Forest database directly
  const { default: sql } = await import("../../ellie-forest/src/db.ts");

  // Search for snapshots directly via SQL for performance
  const snapshots = await sql`
    SELECT id, content, metadata, created_at, tags
    FROM shared_memories
    WHERE tags @> ARRAY['working_memory_snapshot']::text[]
      AND metadata->>'session_id' = ${session_id}
      AND metadata->>'agent' = ${agent}
      AND status = 'active'
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (snapshots.length === 0) {
    return null;
  }

  const latest = snapshots[0];

  // Parse the snapshot content to extract sections
  const sections = parseSnapshotContent(latest.content as string);

  const metadata = latest.metadata as Record<string, unknown>;

  return {
    memory_id: latest.id as string,
    session_id: metadata.session_id as string,
    agent: metadata.agent as string,
    turn_number: (metadata.turn_number as number) ?? 0,
    sections,
    snapshot_timestamp: (metadata.snapshot_timestamp as string) ?? (latest.created_at as string),
  };
}

/**
 * Parse snapshot content (markdown-formatted sections) back into sections object.
 *
 * Expected format:
 * ## Session Identity
 * content here
 *
 * ## Decision Log
 * content here
 */
function parseSnapshotContent(content: string): WorkingMemorySnapshot["sections"] {
  const sections: WorkingMemorySnapshot["sections"] = {};

  // Split by ## headings
  const sectionRegex = /## (.+?)\n([\s\S]*?)(?=\n## |$)/g;
  let match;

  while ((match = sectionRegex.exec(content)) !== null) {
    const [, heading, body] = match;
    const normalizedHeading = heading.trim();
    const normalizedBody = body.trim();

    // Map heading to section key
    if (normalizedHeading === "Session Identity") {
      sections.session_identity = normalizedBody;
    } else if (normalizedHeading === "Task Stack") {
      sections.task_stack = normalizedBody;
    } else if (normalizedHeading === "Conversation Thread") {
      sections.conversation_thread = normalizedBody;
    } else if (normalizedHeading === "Investigation State") {
      sections.investigation_state = normalizedBody;
    } else if (normalizedHeading === "Decision Log") {
      sections.decision_log = normalizedBody;
    } else if (normalizedHeading === "Context Anchors") {
      sections.context_anchors = normalizedBody;
    } else if (normalizedHeading === "Resumption Prompt") {
      sections.resumption_prompt = normalizedBody;
    }
  }

  return sections;
}
