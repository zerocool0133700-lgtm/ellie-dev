/**
 * ELLIE-570 — Ticket Status Handler Tests
 *
 * Tests the HTTP handler that wires queryTicketStatus into the API.
 * Uses injected queryFn to avoid mocking QMD/Plane/fs.
 */

import { describe, test, expect, mock } from "bun:test";

// ── Mock logger ─────────────────────────────────────────────────────────────

mock.module("../src/logger.ts", () => ({
  log: {
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
    }),
  },
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import { handleTicketStatus } from "../src/api/ticket-status-handler";
import type { StatusReport } from "../src/ticket-status-query";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeReport(workItemId: string): StatusReport {
  return {
    workItemId,
    river: {
      workTrails: [{ file: `work-trails/${workItemId}/trail.md`, title: "WT", snippet: "status: done", score: 5 }],
      verificationLogs: [],
      journalEntries: [],
      contextCard: null,
    },
    plane: {
      stateGroup: "completed",
      stateName: "Done",
      title: "Test ticket",
      priority: "medium",
      updatedAt: "2026-03-05T12:00:00Z",
    },
    discrepancies: [],
    lastVerifiedAt: null,
    summary: `## Status: ${workItemId}\n\n*No discrepancies detected*\n`,
  };
}

// ── handleTicketStatus ──────────────────────────────────────────────────────

describe("handleTicketStatus", () => {
  test("returns 400 when id is null", async () => {
    const result = await handleTicketStatus(null);

    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toContain("Missing required query parameter");
  });

  test("returns 200 with status report on success", async () => {
    const mockQuery = mock(async (id: string) => makeReport(id));

    const result = await handleTicketStatus("ELLIE-100", mockQuery);

    expect(result.status).toBe(200);
    const body = result.body as StatusReport;
    expect(body.workItemId).toBe("ELLIE-100");
    expect(body.plane.stateGroup).toBe("completed");
    expect(body.river.workTrails).toHaveLength(1);
    expect(body.discrepancies).toHaveLength(0);
  });

  test("passes work item ID to queryFn", async () => {
    const mockQuery = mock(async (id: string) => makeReport(id));

    await handleTicketStatus("ELLIE-567", mockQuery);

    expect(mockQuery).toHaveBeenCalledWith("ELLIE-567");
  });

  test("returns 500 when queryFn throws", async () => {
    const mockQuery = mock(async () => {
      throw new Error("QMD connection failed");
    });

    const result = await handleTicketStatus("ELLIE-100", mockQuery);

    expect(result.status).toBe(500);
    expect((result.body as { error: string }).error).toBe("QMD connection failed");
  });

  test("returns generic error when queryFn throws non-Error", async () => {
    const mockQuery = mock(async () => {
      throw "something went wrong";
    });

    const result = await handleTicketStatus("ELLIE-100", mockQuery);

    expect(result.status).toBe(500);
    expect((result.body as { error: string }).error).toBe("Failed to query ticket status");
  });

  test("returns report with discrepancies", async () => {
    const report = makeReport("ELLIE-200");
    report.plane.stateGroup = "started";
    report.plane.stateName = "In Progress";
    report.discrepancies = [{
      field: "state",
      riverSays: "completed (expected Plane: Done)",
      planeSays: "In Progress",
      severity: "critical",
    }];
    report.summary = "## Status: ELLIE-200\n\n### Discrepancies\n";

    const mockQuery = mock(async () => report);
    const result = await handleTicketStatus("ELLIE-200", mockQuery);

    expect(result.status).toBe(200);
    const body = result.body as StatusReport;
    expect(body.discrepancies).toHaveLength(1);
    expect(body.discrepancies[0].severity).toBe("critical");
  });

  test("returns report with River evidence categories", async () => {
    const report = makeReport("ELLIE-300");
    report.river.journalEntries = [{ file: "dispatch-journal/2026-03-05.md", title: "DJ", snippet: "**Outcome:** completed", score: 4 }];
    report.river.verificationLogs = [{ file: "verification/ELLIE-300.md", title: "VL", snippet: "Verified at 2026-03-05T14:00:00Z", score: 3 }];
    report.lastVerifiedAt = "2026-03-05T14:00:00";

    const mockQuery = mock(async () => report);
    const result = await handleTicketStatus("ELLIE-300", mockQuery);

    expect(result.status).toBe(200);
    const body = result.body as StatusReport;
    expect(body.river.workTrails).toHaveLength(1);
    expect(body.river.journalEntries).toHaveLength(1);
    expect(body.river.verificationLogs).toHaveLength(1);
    expect(body.lastVerifiedAt).toBe("2026-03-05T14:00:00");
  });

  test("returns report with empty River evidence", async () => {
    const report: StatusReport = {
      workItemId: "ELLIE-999",
      river: { workTrails: [], verificationLogs: [], journalEntries: [], contextCard: null },
      plane: { stateGroup: null, stateName: null, title: null, priority: null, updatedAt: null },
      discrepancies: [],
      lastVerifiedAt: null,
      summary: "## Status: ELLIE-999\n\n*Unable to query status*\n",
    };

    const mockQuery = mock(async () => report);
    const result = await handleTicketStatus("ELLIE-999", mockQuery);

    expect(result.status).toBe(200);
    const body = result.body as StatusReport;
    expect(body.river.workTrails).toHaveLength(0);
    expect(body.plane.stateGroup).toBeNull();
    expect(body.summary).toContain("Unable to query status");
  });
});
