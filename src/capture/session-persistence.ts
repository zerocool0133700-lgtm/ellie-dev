/**
 * Session Persistence for Captured Content — ELLIE-800
 * Ensures capture pipeline state survives context compression and session boundaries.
 * Uses the database as durable store; in-memory sessions are recoverable.
 */

// Types

export interface CaptureSessionState {
  session_id: string;
  agent: string;
  mode: "brain_dump" | "review" | "template" | "idle";
  started_at: string;
  items_in_flight: string[]; // capture queue IDs being processed
  current_index: number;
  metadata: Record<string, any>;
}

export interface RecoveryReport {
  recovered_sessions: number;
  orphaned_items: number;
  deduped: number;
  actions_taken: string[];
}

// DB operations

export async function saveCaptureSession(
  sql: any,
  state: CaptureSessionState,
): Promise<void> {
  await sql`
    INSERT INTO capture_session_state (
      session_id, agent, mode, started_at, items_in_flight, current_index, metadata
    ) VALUES (
      ${state.session_id},
      ${state.agent},
      ${state.mode},
      ${state.started_at},
      ${JSON.stringify(state.items_in_flight)},
      ${state.current_index},
      ${JSON.stringify(state.metadata)}
    )
    ON CONFLICT (session_id) DO UPDATE SET
      mode = EXCLUDED.mode,
      items_in_flight = EXCLUDED.items_in_flight,
      current_index = EXCLUDED.current_index,
      metadata = EXCLUDED.metadata,
      updated_at = NOW()
  `;
}

export async function loadCaptureSession(
  sql: any,
  sessionId: string,
): Promise<CaptureSessionState | null> {
  const rows = await sql`
    SELECT * FROM capture_session_state WHERE session_id = ${sessionId}
  `;
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    session_id: row.session_id,
    agent: row.agent,
    mode: row.mode,
    started_at: row.started_at,
    items_in_flight: typeof row.items_in_flight === "string"
      ? JSON.parse(row.items_in_flight)
      : row.items_in_flight ?? [],
    current_index: row.current_index ?? 0,
    metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata ?? {},
  };
}

export async function deleteCaptureSession(
  sql: any,
  sessionId: string,
): Promise<void> {
  await sql`DELETE FROM capture_session_state WHERE session_id = ${sessionId}`;
}

export async function listActiveSessions(
  sql: any,
): Promise<CaptureSessionState[]> {
  const rows = await sql`
    SELECT * FROM capture_session_state
    WHERE mode != 'idle'
    ORDER BY started_at DESC
  `;
  return rows.map((row: any) => ({
    session_id: row.session_id,
    agent: row.agent,
    mode: row.mode,
    started_at: row.started_at,
    items_in_flight: typeof row.items_in_flight === "string"
      ? JSON.parse(row.items_in_flight)
      : row.items_in_flight ?? [],
    current_index: row.current_index ?? 0,
    metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata ?? {},
  }));
}

// Orphan detection — find capture queue items stuck in non-terminal states

export async function findOrphanedItems(
  sql: any,
  staleMinutes: number = 60,
): Promise<string[]> {
  const rows = await sql`
    SELECT id FROM capture_queue
    WHERE status IN ('queued', 'refined')
    AND updated_at < NOW() - ${staleMinutes + ' minutes'}::interval
    AND id NOT IN (
      SELECT unnest(
        CASE
          WHEN jsonb_typeof(items_in_flight::jsonb) = 'array'
          THEN ARRAY(SELECT jsonb_array_elements_text(items_in_flight::jsonb))
          ELSE ARRAY[]::text[]
        END
      )::uuid
      FROM capture_session_state
      WHERE mode != 'idle'
    )
  `;
  return rows.map((r: any) => r.id);
}

// Pure version for testing
export function findOrphanedItemsPure(
  allItems: { id: string; status: string; updated_at: string }[],
  activeSessionItems: Set<string>,
  staleThreshold: Date,
): string[] {
  return allItems
    .filter(item =>
      (item.status === "queued" || item.status === "refined") &&
      new Date(item.updated_at) < staleThreshold &&
      !activeSessionItems.has(item.id)
    )
    .map(item => item.id);
}

// Deduplication — prevent duplicate captures for the same source message

export async function deduplicateInFlight(
  sql: any,
  sourceMessageIds: string[],
): Promise<{ unique: string[]; duplicates: string[] }> {
  if (sourceMessageIds.length === 0) return { unique: [], duplicates: [] };

  const existing = await sql`
    SELECT DISTINCT source_message_id FROM capture_queue
    WHERE source_message_id = ANY(${sourceMessageIds})
    AND status != 'dismissed'
  `;

  const existingSet = new Set(existing.map((r: any) => r.source_message_id));
  const unique = sourceMessageIds.filter(id => !existingSet.has(id));
  const duplicates = sourceMessageIds.filter(id => existingSet.has(id));

  return { unique, duplicates };
}

// Pure version
export function deduplicateInFlightPure(
  sourceMessageIds: string[],
  existingIds: Set<string>,
): { unique: string[]; duplicates: string[] } {
  const unique = sourceMessageIds.filter(id => !existingIds.has(id));
  const duplicates = sourceMessageIds.filter(id => existingIds.has(id));
  return { unique, duplicates };
}

// Recovery — run on session start to clean up from prior sessions

export async function recoverFromPriorSession(
  sql: any,
  currentSessionId: string,
  agent: string,
): Promise<RecoveryReport> {
  const actions: string[] = [];
  let recoveredSessions = 0;
  let orphanedItems = 0;
  let deduped = 0;

  // Find stale sessions for this agent (not the current one)
  const staleSessions = await sql`
    SELECT * FROM capture_session_state
    WHERE agent = ${agent}
    AND session_id != ${currentSessionId}
  `;

  for (const session of staleSessions) {
    const itemIds = typeof session.items_in_flight === "string"
      ? JSON.parse(session.items_in_flight)
      : session.items_in_flight ?? [];

    if (itemIds.length > 0) {
      actions.push(`Recovered ${itemIds.length} items from stale session ${session.session_id}`);
      orphanedItems += itemIds.length;
    }

    // Clean up the stale session
    await sql`DELETE FROM capture_session_state WHERE session_id = ${session.session_id}`;
    recoveredSessions++;
  }

  if (recoveredSessions > 0) {
    actions.push(`Cleaned up ${recoveredSessions} stale session(s)`);
  }

  return { recovered_sessions: recoveredSessions, orphaned_items: orphanedItems, deduped, actions_taken: actions };
}

// Build working memory anchor for active captures

export function buildCaptureAnchor(state: CaptureSessionState): string {
  if (state.mode === "idle") return "";
  const lines: string[] = [];
  lines.push(`Active capture session: ${state.mode} mode`);
  if (state.items_in_flight.length > 0) {
    lines.push(`In-flight items: ${state.items_in_flight.length}`);
    lines.push(`Progress: ${state.current_index}/${state.items_in_flight.length}`);
  }
  return lines.join("\n");
}

// Build resumption prompt for context compression

export function buildResumptionPrompt(state: CaptureSessionState): string {
  if (state.mode === "idle") return "";
  return `Resume capture ${state.mode} session. ${state.items_in_flight.length} items in queue, currently at index ${state.current_index}. Session started ${state.started_at}.`;
}
