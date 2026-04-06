/**
 * Workshop Debrief API — ELLIE-1454
 *
 * Receives structured debriefs from Claude Code sessions and posts them
 * to Ellie Chat as the "Workshop" entity. Ellie's memory extraction
 * pipeline picks up the message and plants knowledge in the Forest.
 *
 * POST /api/workshop/debrief — submit a session debrief
 * GET  /api/workshop/debriefs — list recent debriefs (future)
 */

import { log } from "../logger.ts";
import { saveMessage } from "../message-sender.ts";
import { broadcastToEllieChatClients } from "../relay-state.ts";

const logger = log.child("workshop");

// ── Types ───────────────────────────────────────────────────

export interface WorkshopDebrief {
  session: string;
  repo: string;
  branch: string;
  work_item_id?: string;
  decisions: string[];
  docs_created: string[];
  files_changed: string[];
  scopes: string[];
  summary: string;
  bridge_writes?: number;
  open_questions?: string[];
}

// ── Debrief formatting ──────────────────────────────────────

function formatDebrief(debrief: WorkshopDebrief): string {
  const lines: string[] = [
    `## Workshop Debrief: ${debrief.session}`,
    "",
    `**Repo:** ${debrief.repo} (branch: ${debrief.branch})`,
  ];

  if (debrief.work_item_id) {
    lines.push(`**Ticket:** ${debrief.work_item_id}`);
  }

  lines.push("", `**Summary:** ${debrief.summary}`);

  if (debrief.decisions.length > 0) {
    lines.push("", "**Decisions:**");
    for (const d of debrief.decisions) {
      lines.push(`- ${d}`);
    }
  }

  if (debrief.docs_created.length > 0) {
    lines.push("", "**Docs created/modified:**");
    for (const d of debrief.docs_created) {
      lines.push(`- ${d}`);
    }
  }

  if (debrief.files_changed.length > 0) {
    lines.push("", "**Files changed:**");
    for (const f of debrief.files_changed) {
      lines.push(`- ${f}`);
    }
  }

  if (debrief.scopes.length > 0) {
    lines.push("", `**Forest scopes touched:** ${debrief.scopes.join(", ")}`);
  }

  if (debrief.bridge_writes) {
    lines.push(`**Bridge writes during session:** ${debrief.bridge_writes}`);
  }

  if (debrief.open_questions && debrief.open_questions.length > 0) {
    lines.push("", "**Open questions:**");
    for (const q of debrief.open_questions) {
      lines.push(`- ${q}`);
    }
  }

  return lines.join("\n");
}

// ── Validation ──────────────────────────────────────────────

function validateDebrief(data: Record<string, unknown>): { valid: boolean; error?: string; debrief?: WorkshopDebrief } {
  if (!data.session || typeof data.session !== "string") {
    return { valid: false, error: "Missing required field: session" };
  }
  if (!data.repo || typeof data.repo !== "string") {
    return { valid: false, error: "Missing required field: repo" };
  }
  if (!data.branch || typeof data.branch !== "string") {
    return { valid: false, error: "Missing required field: branch" };
  }
  if (!data.summary || typeof data.summary !== "string") {
    return { valid: false, error: "Missing required field: summary" };
  }

  return {
    valid: true,
    debrief: {
      session: data.session as string,
      repo: data.repo as string,
      branch: data.branch as string,
      work_item_id: data.work_item_id as string | undefined,
      decisions: Array.isArray(data.decisions) ? data.decisions : [],
      docs_created: Array.isArray(data.docs_created) ? data.docs_created : [],
      files_changed: Array.isArray(data.files_changed) ? data.files_changed : [],
      scopes: Array.isArray(data.scopes) ? data.scopes : [],
      summary: data.summary as string,
      bridge_writes: typeof data.bridge_writes === "number" ? data.bridge_writes : undefined,
      open_questions: Array.isArray(data.open_questions) ? data.open_questions : undefined,
    },
  };
}

// ── Auth ─────────────────────────────────────────────────────

function validateBridgeKey(headers: Record<string, string | undefined>): boolean {
  const key = headers["x-bridge-key"];
  if (!key) return false;
  const expected = process.env.BRIDGE_KEY || "bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a";
  return key === expected;
}

// ── Handler ─────────────────────────────────────────────────

export async function handleDebrief(
  data: Record<string, unknown>,
  headers: Record<string, string | undefined>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  // Auth
  if (!validateBridgeKey(headers)) {
    return { status: 401, body: { error: "Missing or invalid x-bridge-key header" } };
  }

  // Validate
  const { valid, error, debrief } = validateDebrief(data);
  if (!valid || !debrief) {
    return { status: 400, body: { error: error || "Invalid debrief payload" } };
  }

  // Format the debrief as a readable message
  const formatted = formatDebrief(debrief);

  logger.info({
    session: debrief.session,
    repo: debrief.repo,
    branch: debrief.branch,
    work_item_id: debrief.work_item_id,
    decisions: debrief.decisions.length,
    docs: debrief.docs_created.length,
    files: debrief.files_changed.length,
  }, "Workshop debrief received");

  // Save to Supabase as a message from "workshop" agent
  const memoryId = await saveMessage(
    "assistant",
    formatted,
    {
      agent: "workshop",
      type: "debrief",
      work_item_id: debrief.work_item_id,
      scopes: debrief.scopes,
      docs_created: debrief.docs_created,
    },
    "ellie-chat",
  );

  if (!memoryId) {
    logger.error("Failed to save workshop debrief message");
    return { status: 500, body: { error: "Failed to save debrief message" } };
  }

  // Broadcast to connected Ellie Chat clients
  broadcastToEllieChatClients({
    type: "response",
    text: formatted,
    agent: "workshop",
    memoryId,
    ts: Date.now(),
  });

  logger.info({ memoryId }, "Workshop debrief posted to Ellie Chat");

  return {
    status: 200,
    body: {
      ok: true,
      memoryId,
      message: "Debrief posted to Ellie Chat",
    },
  };
}
