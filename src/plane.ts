/**
 * Plane API Client
 *
 * REST client for interacting with the Plane project management API.
 * Used by work session endpoints to update work items on session start/complete.
 */

const PLANE_API_KEY = process.env.PLANE_API_KEY;
const PLANE_BASE_URL = (process.env.PLANE_BASE_URL || "https://plane.ellie-labs.dev").replace(/\/api\/v1\/?$/, "");
const PLANE_WORKSPACE_SLUG = process.env.PLANE_WORKSPACE_SLUG || process.env.PLANE_WORKSPACE || "evelife";

export function isPlaneConfigured(): boolean {
  return !!PLANE_API_KEY;
}

async function planeRequest(path: string, options?: RequestInit) {
  const res = await fetch(`${PLANE_BASE_URL}/api/v1/workspaces/${PLANE_WORKSPACE_SLUG}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": PLANE_API_KEY!,
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Plane API ${res.status}: ${body}`);
  }
  return res.json();
}

/** Parse "ELLIE-7" into { projectIdentifier: "ELLIE", sequenceId: 7 } */
function parseWorkItemId(workItemId: string) {
  const match = workItemId.match(/^([A-Z]+)-(\d+)$/);
  if (!match) return null;
  return { projectIdentifier: match[1], sequenceId: parseInt(match[2]) };
}

/** Find a project UUID by its short identifier (e.g. "ELLIE") */
async function getProjectByIdentifier(identifier: string): Promise<string | null> {
  const data = await planeRequest("/projects/");
  const project = data.results?.find((p: any) => p.identifier === identifier);
  return project?.id ?? null;
}

/** Find an issue by sequence number within a project (returns full issue data) */
async function getIssueBySequenceId(projectId: string, sequenceId: number): Promise<any | null> {
  const data = await planeRequest(`/projects/${projectId}/issues/?sequence_id=${sequenceId}`);
  return data.results?.find((i: any) => i.sequence_id === sequenceId) ?? null;
}

/** Get the state UUID for a given group (e.g. "started" for In Progress) */
async function getStateIdByGroup(projectId: string, group: string): Promise<string | null> {
  const data = await planeRequest(`/projects/${projectId}/states/`);
  const state = data.results?.find((s: any) => s.group === group);
  return state?.id ?? null;
}

/**
 * Resolve a readable work item ID (e.g. "ELLIE-7") to Plane UUIDs.
 * Returns { projectId, issueId } or null if not found.
 */
export async function resolveWorkItemId(workItemId: string) {
  const parsed = parseWorkItemId(workItemId);
  if (!parsed) return null;

  const projectId = await getProjectByIdentifier(parsed.projectIdentifier);
  if (!projectId) return null;

  const issue = await getIssueBySequenceId(projectId, parsed.sequenceId);
  if (!issue) return null;

  return { projectId, issueId: issue.id };
}

/** Update a Plane issue's state */
export async function updateIssueState(projectId: string, issueId: string, stateId: string) {
  return planeRequest(`/projects/${projectId}/issues/${issueId}/`, {
    method: "PATCH",
    body: JSON.stringify({ state: stateId }),
  });
}

/** Add a comment to a Plane issue */
export async function addIssueComment(projectId: string, issueId: string, commentHtml: string) {
  return planeRequest(`/projects/${projectId}/issues/${issueId}/comments/`, {
    method: "POST",
    body: JSON.stringify({ comment_html: commentHtml }),
  });
}

/**
 * High-level: update a Plane work item when a work session starts.
 * - Sets state to "In Progress"
 * - Adds a comment with the session ID
 *
 * Fails silently (logs warning) if Plane is not configured or the item can't be found.
 */
export async function updateWorkItemOnSessionStart(workItemId: string, sessionId: string) {
  if (!isPlaneConfigured()) {
    console.log("[plane] Skipping — PLANE_API_KEY not configured");
    return;
  }

  const resolved = await resolveWorkItemId(workItemId);
  if (!resolved) {
    console.warn(`[plane] Could not resolve work item: ${workItemId}`);
    return;
  }

  const { projectId, issueId } = resolved;

  // Move to "In Progress" (group: "started")
  const inProgressStateId = await getStateIdByGroup(projectId, "started");
  if (inProgressStateId) {
    await updateIssueState(projectId, issueId, inProgressStateId);
    console.log(`[plane] ${workItemId} → In Progress`);
  }

  // Add comment with session ID
  const comment = `<p>Work session started — <code>${sessionId}</code></p>`;
  await addIssueComment(projectId, issueId, comment);
  console.log(`[plane] Added session comment to ${workItemId}`);
}

/**
 * High-level: update a Plane work item when a work session completes.
 * - Sets state to "Done" (or "Cancelled" if failed)
 * - Adds a comment with the session summary
 *
 * Fails silently (logs warning) if Plane is not configured or the item can't be found.
 */
export async function updateWorkItemOnSessionComplete(
  workItemId: string,
  summary: string,
  status: "completed" | "blocked" | "paused" = "completed",
) {
  if (!isPlaneConfigured()) {
    console.log("[plane] Skipping — PLANE_API_KEY not configured");
    return;
  }

  const resolved = await resolveWorkItemId(workItemId);
  if (!resolved) {
    console.warn(`[plane] Could not resolve work item: ${workItemId}`);
    return;
  }

  const { projectId, issueId } = resolved;

  // Map session status to Plane state group
  const stateGroup = status === "completed" ? "completed" : "started";
  const stateId = await getStateIdByGroup(projectId, stateGroup);
  if (stateId) {
    await updateIssueState(projectId, issueId, stateId);
    console.log(`[plane] ${workItemId} → ${status === "completed" ? "Done" : "In Progress (blocked/paused)"}`);
  }

  // Add completion comment
  const label = status === "completed" ? "completed" : status;
  const comment = `<p>Work session ${label}</p><p>${summary}</p>`;
  await addIssueComment(projectId, issueId, comment);
  console.log(`[plane] Added completion comment to ${workItemId}`);
}

// ============================================================
// WORK ITEM QUERIES
// ============================================================

export interface WorkItemDetails {
  id: string;
  name: string;
  description: string;
  priority: string;
  state: string;
  sequenceId: number;
  projectIdentifier: string;
}

/** Strip HTML tags to plain text */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fetch full details for a work item (e.g. "ELLIE-5").
 * Returns null if not found or Plane is not configured.
 */
export async function fetchWorkItemDetails(workItemId: string): Promise<WorkItemDetails | null> {
  if (!isPlaneConfigured()) return null;

  const parsed = parseWorkItemId(workItemId);
  if (!parsed) return null;

  try {
    const projectId = await getProjectByIdentifier(parsed.projectIdentifier);
    if (!projectId) return null;

    const issue = await getIssueBySequenceId(projectId, parsed.sequenceId);
    if (!issue) return null;

    return {
      id: issue.id,
      name: issue.name,
      description: stripHtml(issue.description_html || ""),
      priority: issue.priority || "none",
      state: issue.state,
      sequenceId: issue.sequence_id,
      projectIdentifier: parsed.projectIdentifier,
    };
  } catch (error) {
    console.warn(`[plane] Failed to fetch work item ${workItemId}:`, error);
    return null;
  }
}

export interface WorkItemSummary {
  sequenceId: number;
  name: string;
  priority: string;
}

/**
 * List open (non-completed, non-cancelled) issues for a project.
 */
export async function listOpenIssues(projectIdentifier: string, limit: number = 20): Promise<WorkItemSummary[]> {
  if (!isPlaneConfigured()) return [];

  try {
    const projectId = await getProjectByIdentifier(projectIdentifier);
    if (!projectId) return [];

    const data = await planeRequest(`/projects/${projectId}/issues/`);
    const issues = (data.results || [])
      .filter((i: any) => !["completed", "cancelled"].includes(i.state_detail?.group || ""))
      .slice(0, limit)
      .map((i: any) => ({
        sequenceId: i.sequence_id,
        name: i.name,
        priority: i.priority || "none",
      }));

    return issues;
  } catch (error) {
    console.warn(`[plane] Failed to list issues for ${projectIdentifier}:`, error);
    return [];
  }
}

/**
 * Create a new issue in a Plane project.
 * Returns the created issue's ID and sequence number, or null on failure.
 */
export async function createPlaneIssue(
  projectIdentifier: string,
  name: string,
  description?: string,
  priority?: string,
): Promise<{ id: string; sequenceId: number; identifier: string } | null> {
  if (!isPlaneConfigured()) return null;

  try {
    const projectId = await getProjectByIdentifier(projectIdentifier);
    if (!projectId) return null;

    const body: Record<string, string> = { name };
    if (description) body.description_html = `<p>${description}</p>`;
    if (priority) body.priority = priority;

    const issue = await planeRequest(`/projects/${projectId}/issues/`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    const identifier = `${projectIdentifier}-${issue.sequence_id}`;
    console.log(`[plane] Created issue: ${identifier} — ${name}`);
    return { id: issue.id, sequenceId: issue.sequence_id, identifier };
  } catch (error) {
    console.warn(`[plane] Failed to create issue in ${projectIdentifier}:`, error);
    return null;
  }
}
