/**
 * ELLIE-570: Ticket status handler
 *
 * Thin handler that wires queryTicketStatus (ELLIE-568) into the HTTP API.
 * River is consulted first, then reconciled against Plane.
 */

import { queryTicketStatus, type StatusReport } from "../ticket-status-query.ts";
import { log } from "../logger.ts";

const logger = log.child("ticket-status-handler");

export interface TicketStatusResult {
  status: number;
  body: StatusReport | { error: string };
}

/**
 * Handle a ticket status query.
 * Pure-ish: returns { status, body } instead of writing to res directly.
 */
export async function handleTicketStatus(
  workItemId: string | null,
  queryFn: typeof queryTicketStatus = queryTicketStatus,
): Promise<TicketStatusResult> {
  if (!workItemId) {
    return {
      status: 400,
      body: { error: "Missing required query parameter: id (e.g. ?id=ELLIE-100)" },
    };
  }

  try {
    const report = await queryFn(workItemId);
    return { status: 200, body: report };
  } catch (err) {
    logger.error("Ticket status query error", err);
    return {
      status: 500,
      body: { error: err instanceof Error ? err.message : "Failed to query ticket status" },
    };
  }
}
