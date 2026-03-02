/**
 * Tool Approval Module — ELLIE-213
 *
 * Bridges Claude Code PreToolUse hooks with the Ellie Chat frontend.
 * When a tool needs approval, the hook script POSTs here, we send a
 * WebSocket message to the frontend, and wait for the user to approve/deny.
 *
 * Auto-approved tools (read-only, safe) bypass the frontend entirely.
 * Session-remembered approvals also bypass on subsequent calls.
 */

import { randomUUID } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import { log } from "./logger.ts";

const logger = log.child("tool-approval");

// ── Types ────────────────────────────────────────────────────

export interface ToolApprovalRequest {
  tool_name: string;
  tool_input: Record<string, unknown>;
  session_id?: string;
}

interface PendingToolApproval {
  id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  resolve: (decision: { approved: boolean; reason?: string }) => void;
  createdAt: number;
}

// ── Dispatch mode (system-dispatched agents get wider auto-approve) ──

let _activeDispatches = 0;

/** Dev tools auto-approved when a system dispatch is active */
const DISPATCH_AUTO_APPROVED_TOOLS = new Set([
  "Bash", "Edit", "Write", "Task", "NotebookEdit",
]);

export function enterDispatchMode(): void {
  _activeDispatches++;
  logger.info("Entered dispatch mode", { activeDispatches: _activeDispatches });
}

export function exitDispatchMode(): void {
  _activeDispatches = Math.max(0, _activeDispatches - 1);
  logger.info("Exited dispatch mode", { activeDispatches: _activeDispatches });
}

export function isDispatchActive(): boolean {
  return _activeDispatches > 0;
}

// ── Auto-approved tools (read-only / safe) ───────────────────

const AUTO_APPROVED_TOOLS = new Set([
  // Core read tools
  "Read", "Glob", "Grep", "WebSearch", "WebFetch",
  // Memory (read)
  "mcp__memory__read_graph",
  "mcp__memory__search_nodes",
  "mcp__memory__open_nodes",
  // Thinking
  "mcp__sequential-thinking__sequentialthinking",
  // Forest bridge (read)
  "mcp__forest-bridge__read",
  // Brave search (read-only)
  "mcp__brave-search__brave_web_search",
  "mcp__brave-search__brave_local_search",
  // GitHub (read)
  "mcp__github__get_file_contents",
  "mcp__github__get_issue",
  "mcp__github__get_pull_request",
  "mcp__github__get_pull_request_comments",
  "mcp__github__get_pull_request_files",
  "mcp__github__get_pull_request_reviews",
  "mcp__github__get_pull_request_status",
  "mcp__github__list_commits",
  "mcp__github__list_issues",
  "mcp__github__list_pull_requests",
  "mcp__github__search_code",
  "mcp__github__search_issues",
  "mcp__github__search_repositories",
  "mcp__github__search_users",
  // Google Workspace (read)
  "mcp__google-workspace__get_events",
  "mcp__google-workspace__get_gmail_message_content",
  "mcp__google-workspace__get_gmail_messages_content_batch",
  "mcp__google-workspace__get_messages",
  "mcp__google-workspace__get_doc_content",
  "mcp__google-workspace__get_drive_file_content",
  "mcp__google-workspace__get_drive_file_download_url",
  "mcp__google-workspace__get_drive_shareable_link",
  "mcp__google-workspace__get_form",
  "mcp__google-workspace__get_presentation",
  "mcp__google-workspace__get_task",
  "mcp__google-workspace__list_calendars",
  "mcp__google-workspace__list_contacts",
  "mcp__google-workspace__list_tasks",
  "mcp__google-workspace__read_sheet_values",
  "mcp__google-workspace__search_contacts",
  "mcp__google-workspace__search_custom",
  "mcp__google-workspace__search_drive_files",
  "mcp__google-workspace__search_gmail_messages",
  "mcp__google-workspace__search_messages",
  // Plane (read)
  "mcp__plane__get_issue_using_readable_identifier",
  "mcp__plane__get_issue_comments",
  "mcp__plane__get_projects",
  "mcp__plane__get_state",
  "mcp__plane__get_cycle",
  "mcp__plane__get_module",
  "mcp__plane__get_label",
  "mcp__plane__get_user",
  "mcp__plane__get_workspace_members",
  "mcp__plane__get_issue_type",
  "mcp__plane__get_issue_worklogs",
  "mcp__plane__get_total_worklogs",
  "mcp__plane__list_cycles",
  "mcp__plane__list_cycle_issues",
  "mcp__plane__list_labels",
  "mcp__plane__list_modules",
  "mcp__plane__list_module_issues",
  "mcp__plane__list_project_issues",
  "mcp__plane__list_states",
  "mcp__plane__list_issue_types",
  // Excalidraw (read)
  "mcp__excalidraw__read_me",
  "mcp__excalidraw__read_checkpoint",
]);

// Also auto-approve any tool that's purely a built-in read tool
function isAutoApproved(toolName: string): boolean {
  if (AUTO_APPROVED_TOOLS.has(toolName)) return true;
  // Non-MCP built-in tools that are read-only
  if (["Read", "Glob", "Grep", "WebSearch", "WebFetch", "Task", "TodoWrite"].includes(toolName)) return true;
  // Fix 2: Auto-approve dev tools when a system dispatch is active
  if (_activeDispatches > 0 && DISPATCH_AUTO_APPROVED_TOOLS.has(toolName)) {
    logger.info("Auto-approved (dispatch mode)", { tool: toolName, activeDispatches: _activeDispatches });
    return true;
  }
  return false;
}

// ── Session approvals (per-tool, remembered with TTL) ────────

const SESSION_APPROVAL_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DISPATCHED_SESSION_APPROVAL_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours for system-dispatched agents

/** tool_name → timestamp when approval was granted */
const sessionApprovals = new Map<string, number>();

export function clearSessionApprovals(): void {
  sessionApprovals.clear();
}

export function getSessionApprovals(): string[] {
  pruneExpiredSessionApprovals();
  return [...sessionApprovals.keys()];
}

/** Get the effective TTL — longer when dispatches are active */
function getEffectiveTTL(): number {
  return _activeDispatches > 0 ? DISPATCHED_SESSION_APPROVAL_TTL_MS : SESSION_APPROVAL_TTL_MS;
}

/** Remove expired session approvals and notify about them. */
function pruneExpiredSessionApprovals(): string[] {
  const now = Date.now();
  const ttl = getEffectiveTTL();
  const expired: string[] = [];
  for (const [tool, grantedAt] of sessionApprovals) {
    if (now - grantedAt > ttl) {
      sessionApprovals.delete(tool);
      expired.push(tool);
    }
  }
  if (expired.length > 0) {
    logger.info("Session approvals expired", { tools: expired, ttl_ms: ttl, dispatch_active: _activeDispatches > 0 });
  }
  return expired;
}

// ── Pending approvals ────────────────────────────────────────

const pendingApprovals = new Map<string, PendingToolApproval>();
const APPROVAL_TIMEOUT_MS = 60_000; // 60 seconds
const DISPATCH_APPROVAL_TIMEOUT_MS = 5 * 60_000; // 5 minutes for re-requests during dispatches

// ── WebSocket broadcaster (set by relay.ts at startup) ───────

let _broadcastToEllieChat: (msg: Record<string, unknown>) => void = () => {};
export function setBroadcastToEllieChat(fn: typeof _broadcastToEllieChat): void {
  _broadcastToEllieChat = fn;
}

// ── Core approval logic ──────────────────────────────────────

export async function checkToolApproval(req: ToolApprovalRequest): Promise<{ approved: boolean; reason?: string }> {
  const { tool_name, tool_input } = req;

  // Fast-path: auto-approved tools
  if (isAutoApproved(tool_name)) {
    return { approved: true };
  }

  // Fast-path: session-remembered approvals (with TTL check)
  const grantedAt = sessionApprovals.get(tool_name);
  if (grantedAt !== undefined) {
    const ttl = getEffectiveTTL();
    if (Date.now() - grantedAt <= ttl) {
      return { approved: true };
    }
    // Expired — remove and fall through to re-request
    sessionApprovals.delete(tool_name);
    logger.info("Session approval expired, re-requesting", { tool: tool_name, expired_after_ms: Date.now() - grantedAt, ttl_ms: ttl });
  }

  // Check if this is a re-request (previously approved but expired)
  const isReRequest = grantedAt !== undefined;

  // Need user approval — create pending request
  const id = randomUUID();

  // Format a human-readable description
  const description = formatToolDescription(tool_name, tool_input);

  return new Promise((resolve) => {
    const pending: PendingToolApproval = {
      id,
      tool_name,
      tool_input,
      resolve,
      createdAt: Date.now(),
    };
    pendingApprovals.set(id, pending);

    // Send to frontend (include expired flag for re-requests)
    _broadcastToEllieChat({
      type: "tool_approval",
      id,
      tool_name,
      tool_input,
      description,
      expired: isReRequest,
      ts: Date.now(),
    });

    logger.info(isReRequest ? "Re-requesting expired approval" : "Requesting approval", {
      tool: tool_name,
      approval_id: id.slice(0, 8),
    });

    // Timeout — deny after timeout and notify user
    // Fix 3: Use longer timeout (5min) during active dispatches
    const timeoutMs = _activeDispatches > 0 ? DISPATCH_APPROVAL_TIMEOUT_MS : APPROVAL_TIMEOUT_MS;
    const timeoutLabel = _activeDispatches > 0 ? "5min" : "60s";
    setTimeout(() => {
      if (pendingApprovals.has(id)) {
        pendingApprovals.delete(id);
        logger.info("Approval timed out", { tool: tool_name, approval_id: id.slice(0, 8), timeout_ms: timeoutMs, dispatch_active: _activeDispatches > 0 });

        // Notify frontend that this approval expired
        _broadcastToEllieChat({
          type: "tool_approval_expired",
          id,
          tool_name,
          description,
          ts: Date.now(),
        });

        resolve({ approved: false, reason: `Approval timed out (${timeoutLabel}). The tool can be re-requested — ask Ellie to try again.` });
      }
    }, timeoutMs);
  });
}

// ── Resolve from frontend ────────────────────────────────────

export function resolveToolApproval(id: string, approved: boolean, remember?: boolean): boolean {
  const pending = pendingApprovals.get(id);
  if (!pending) return false;

  pendingApprovals.delete(id);

  if (approved && remember) {
    sessionApprovals.set(pending.tool_name, Date.now());
    logger.info("Approved + remembered", { tool: pending.tool_name, ttl_ms: SESSION_APPROVAL_TTL_MS });
  } else {
    logger.info(approved ? "Approved (one-time)" : "Denied", {
      tool: pending.tool_name,
      approval_id: id.slice(0, 8),
    });
  }

  pending.resolve({
    approved,
    reason: approved ? undefined : "User denied this tool call",
  });

  return true;
}

// ── HTTP handler (called by hook script) ─────────────────────

export async function handleToolApprovalHTTP(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body = "";
  req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
  req.on("end", async () => {
    try {
      const data = JSON.parse(body) as ToolApprovalRequest;

      if (!data.tool_name) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing tool_name" }));
        return;
      }

      const result = await checkToolApproval(data);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err: unknown) {
      logger.error("HTTP error", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ approved: true, reason: "Error in approval check — allowing by default" }));
    }
  });
}

// ── Human-readable tool descriptions ─────────────────────────

function formatToolDescription(toolName: string, input: Record<string, unknown>): string {
  // Strip MCP prefix for readability
  const shortName = toolName
    .replace(/^mcp__google-workspace__/, "Google: ")
    .replace(/^mcp__github__/, "GitHub: ")
    .replace(/^mcp__plane__/, "Plane: ")
    .replace(/^mcp__memory__/, "Memory: ")
    .replace(/^mcp__excalidraw__/, "Excalidraw: ")
    .replace(/^mcp__brave-search__/, "Search: ")
    .replace(/^mcp__forest-bridge__/, "Forest: ")
    .replace(/_/g, " ");

  // Build summary from key parameters
  const params: string[] = [];
  for (const [key, val] of Object.entries(input)) {
    if (val === undefined || val === null) continue;
    const strVal = typeof val === "string" ? val : JSON.stringify(val);
    // Truncate long values
    const display = strVal.length > 80 ? strVal.substring(0, 77) + "..." : strVal;
    params.push(`${key}: ${display}`);
  }

  const paramStr = params.length > 0 ? `\n${params.join("\n")}` : "";
  return `${shortName}${paramStr}`;
}
