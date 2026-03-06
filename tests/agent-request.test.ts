/**
 * Agent Request Tests — ELLIE-600
 *
 * Validates:
 *  - validateAgentRequest() catches missing/invalid fields
 *  - submitAgentRequest() creates request + event
 *  - approveAgentRequest() creates sub-commitment + routing info
 *  - denyAgentRequest() returns rejection with reason
 *  - completeAgentRequest() marks approved request as completed
 *  - timeoutPendingRequests() times out stale requests
 *  - listPendingRequests() returns pending for coordinator
 *  - buildPendingRequestsSection() formats prompt injection
 *  - Progress events tracked per request
 *  - Full lifecycle: submit → approve → complete
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  validateAgentRequest,
  submitAgentRequest,
  approveAgentRequest,
  denyAgentRequest,
  completeAgentRequest,
  timeoutPendingRequests,
  getAgentRequest,
  listAgentRequests,
  listPendingRequests,
  getRequestEvents,
  buildPendingRequestsSection,
  _resetAgentRequestsForTesting,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from "../src/agent-request.ts";
import {
  createCommitment,
  _resetLedgerForTesting,
} from "../src/commitment-ledger.ts";
import {
  registerAgent,
  startAgentSession,
  _resetRegistryForTesting,
} from "../src/agent-registry.ts";

beforeEach(() => {
  _resetAgentRequestsForTesting();
  _resetLedgerForTesting();
  _resetRegistryForTesting();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function setupScenario() {
  // Register agents
  registerAgent({
    agentName: "dev",
    agentType: "specialist",
    capabilities: [{ name: "coding" }],
  });
  registerAgent({
    agentName: "critic",
    agentType: "specialist",
    capabilities: [{ name: "code-review" }],
  });

  // Create a parent commitment
  const parent = createCommitment({
    sessionId: "sess-1",
    description: "Implement auth module",
    source: "dispatch",
    turnCreated: 1,
    workItemId: "ELLIE-100",
  });

  return { parent };
}

// ── validateAgentRequest ─────────────────────────────────────────────────────

describe("validateAgentRequest", () => {
  it("passes with valid input", () => {
    const result = validateAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: "abc",
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Need code review",
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("fails with empty sessionId", () => {
    const result = validateAgentRequest({
      sessionId: "",
      parentCommitmentId: "abc",
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Need review",
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("sessionId is required");
  });

  it("fails with empty reason", () => {
    const result = validateAgentRequest({
      sessionId: "s",
      parentCommitmentId: "abc",
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "",
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("reason is required");
  });

  it("fails when requesting and target agent are the same", () => {
    const result = validateAgentRequest({
      sessionId: "s",
      parentCommitmentId: "abc",
      requestingAgent: "dev",
      targetAgent: "dev",
      reason: "Self-review",
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("requestingAgent and targetAgent must be different");
  });

  it("collects multiple errors", () => {
    const result = validateAgentRequest({
      sessionId: "",
      parentCommitmentId: "",
      requestingAgent: "",
      targetAgent: "",
      reason: "",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });
});

// ── submitAgentRequest ───────────────────────────────────────────────────────

describe("submitAgentRequest", () => {
  it("creates a pending request", () => {
    const { parent } = setupScenario();
    const result = submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Need code review on auth module",
    });

    expect("request" in result).toBe(true);
    if ("request" in result) {
      expect(result.request.status).toBe("pending");
      expect(result.request.requestingAgent).toBe("dev");
      expect(result.request.targetAgent).toBe("critic");
      expect(result.request.id).toBeTruthy();
    }
  });

  it("records agent-request-sent event", () => {
    const { parent } = setupScenario();
    const result = submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review",
    });

    expect("event" in result).toBe(true);
    if ("event" in result) {
      expect(result.event.event).toBe("agent-request-sent");
    }
  });

  it("stores estimated duration", () => {
    const { parent } = setupScenario();
    const result = submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review",
      estimatedDuration: 15,
    });

    if ("request" in result) {
      expect(result.request.estimatedDuration).toBe(15);
    }
  });

  it("stores required capability", () => {
    const { parent } = setupScenario();
    const result = submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review",
      requiredCapability: "code-review",
    });

    if ("request" in result) {
      expect(result.request.requiredCapability).toBe("code-review");
    }
  });

  it("returns error for invalid input", () => {
    const result = submitAgentRequest({
      sessionId: "",
      parentCommitmentId: "",
      requestingAgent: "",
      targetAgent: "",
      reason: "",
    });

    expect("error" in result).toBe(true);
  });

  it("is retrievable after submission", () => {
    const { parent } = setupScenario();
    const result = submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review",
    });

    if ("request" in result) {
      const found = getAgentRequest(result.request.id);
      expect(found).not.toBeNull();
      expect(found!.status).toBe("pending");
    }
  });
});

// ── approveAgentRequest ──────────────────────────────────────────────────────

describe("approveAgentRequest", () => {
  it("approves and creates sub-commitment", () => {
    const { parent } = setupScenario();
    const submit = submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review auth module",
      estimatedDuration: 15,
    });
    if (!("request" in submit)) throw new Error("submit failed");

    const result = approveAgentRequest(submit.request.id, 3);

    expect("approved" in result).toBe(true);
    if ("approved" in result && result.approved) {
      expect(result.request.status).toBe("approved");
      expect(result.subCommitment).toBeTruthy();
      expect(result.subCommitment.targetAgent).toBe("critic");
      expect(result.subCommitment.parentCommitmentId).toBe(parent.id);
      expect(result.routeInfo.agentName).toBe("critic");
      expect(result.event).toBe("agent-request-approved");
    }
  });

  it("sets subCommitmentId on request", () => {
    const { parent } = setupScenario();
    const submit = submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review",
    });
    if (!("request" in submit)) throw new Error("submit failed");

    const result = approveAgentRequest(submit.request.id, 3);
    if ("approved" in result && result.approved) {
      expect(result.request.subCommitmentId).toBe(result.subCommitment.id);
    }
  });

  it("fails if target agent is busy", () => {
    const { parent } = setupScenario();
    startAgentSession("critic", "other-sess");

    const submit = submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review",
    });
    if (!("request" in submit)) throw new Error("submit failed");

    const result = approveAgentRequest(submit.request.id, 3);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("busy");
    }
  });

  it("fails if target agent lacks required capability", () => {
    const { parent } = setupScenario();
    const submit = submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Security audit",
      requiredCapability: "security-audit",
    });
    if (!("request" in submit)) throw new Error("submit failed");

    const result = approveAgentRequest(submit.request.id, 3);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("does not have capability");
    }
  });

  it("fails for nonexistent request", () => {
    const result = approveAgentRequest("fake-id", 3);
    expect("error" in result).toBe(true);
  });

  it("fails for already-approved request", () => {
    const { parent } = setupScenario();
    const submit = submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review",
    });
    if (!("request" in submit)) throw new Error("submit failed");

    approveAgentRequest(submit.request.id, 3);
    const second = approveAgentRequest(submit.request.id, 4);
    expect("error" in second).toBe(true);
  });

  it("fails if parent commitment not found", () => {
    setupScenario();
    const submit = submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: "nonexistent-parent",
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review",
    });
    if (!("request" in submit)) throw new Error("submit failed");

    const result = approveAgentRequest(submit.request.id, 3);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("sub-commitment");
    }
  });
});

// ── denyAgentRequest ─────────────────────────────────────────────────────────

describe("denyAgentRequest", () => {
  it("denies with reason", () => {
    const { parent } = setupScenario();
    const submit = submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review",
    });
    if (!("request" in submit)) throw new Error("submit failed");

    const result = denyAgentRequest(submit.request.id, "Critic is overloaded, try later");

    expect("approved" in result).toBe(true);
    if ("approved" in result && !result.approved) {
      expect(result.request.status).toBe("denied");
      expect(result.reason).toBe("Critic is overloaded, try later");
      expect(result.request.denialReason).toBe("Critic is overloaded, try later");
      expect(result.event).toBe("agent-request-denied");
    }
  });

  it("fails for nonexistent request", () => {
    const result = denyAgentRequest("fake-id", "No reason");
    expect("error" in result).toBe(true);
  });

  it("fails for already-denied request", () => {
    const { parent } = setupScenario();
    const submit = submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review",
    });
    if (!("request" in submit)) throw new Error("submit failed");

    denyAgentRequest(submit.request.id, "First denial");
    const second = denyAgentRequest(submit.request.id, "Second denial");
    expect("error" in second).toBe(true);
  });
});

// ── completeAgentRequest ─────────────────────────────────────────────────────

describe("completeAgentRequest", () => {
  it("completes an approved request", () => {
    const { parent } = setupScenario();
    const submit = submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review",
    });
    if (!("request" in submit)) throw new Error("submit failed");

    approveAgentRequest(submit.request.id, 3);
    const result = completeAgentRequest(submit.request.id);

    expect("request" in result).toBe(true);
    if ("request" in result) {
      expect(result.request.status).toBe("completed");
      expect(result.event).toBe("agent-request-completed");
    }
  });

  it("fails for pending request (not yet approved)", () => {
    const { parent } = setupScenario();
    const submit = submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review",
    });
    if (!("request" in submit)) throw new Error("submit failed");

    const result = completeAgentRequest(submit.request.id);
    expect("error" in result).toBe(true);
  });

  it("fails for denied request", () => {
    const { parent } = setupScenario();
    const submit = submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review",
    });
    if (!("request" in submit)) throw new Error("submit failed");

    denyAgentRequest(submit.request.id, "No");
    const result = completeAgentRequest(submit.request.id);
    expect("error" in result).toBe(true);
  });

  it("fails for nonexistent request", () => {
    const result = completeAgentRequest("fake-id");
    expect("error" in result).toBe(true);
  });
});

// ── timeoutPendingRequests ───────────────────────────────────────────────────

describe("timeoutPendingRequests", () => {
  it("times out stale pending requests", () => {
    const { parent } = setupScenario();
    submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review",
    });

    // Timeout with 0ms threshold
    const count = timeoutPendingRequests(0);
    expect(count).toBe(1);
  });

  it("does not time out recent requests", () => {
    const { parent } = setupScenario();
    submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review",
    });

    const count = timeoutPendingRequests(60 * 60 * 1000);
    expect(count).toBe(0);
  });

  it("does not time out already-approved requests", () => {
    const { parent } = setupScenario();
    const submit = submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review",
    });
    if ("request" in submit) {
      approveAgentRequest(submit.request.id, 3);
    }

    const count = timeoutPendingRequests(0);
    expect(count).toBe(0);
  });

  it("sets status to timed_out", () => {
    const { parent } = setupScenario();
    const submit = submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review",
    });

    timeoutPendingRequests(0);

    if ("request" in submit) {
      const req = getAgentRequest(submit.request.id);
      expect(req!.status).toBe("timed_out");
    }
  });

  it("records agent-request-timed-out event", () => {
    const { parent } = setupScenario();
    const submit = submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review",
    });

    timeoutPendingRequests(0);

    if ("request" in submit) {
      const events = getRequestEvents(submit.request.id);
      expect(events.some(e => e.event === "agent-request-timed-out")).toBe(true);
    }
  });
});

// ── listAgentRequests / listPendingRequests ──────────────────────────────────

describe("listAgentRequests", () => {
  it("lists all requests", () => {
    const { parent } = setupScenario();
    submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review 1",
    });
    submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review 2",
    });

    expect(listAgentRequests()).toHaveLength(2);
  });

  it("filters by status", () => {
    const { parent } = setupScenario();
    const sub1 = submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review 1",
    });
    submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review 2",
    });

    if ("request" in sub1) {
      approveAgentRequest(sub1.request.id, 3);
    }

    expect(listAgentRequests({ status: "pending" })).toHaveLength(1);
    expect(listAgentRequests({ status: "approved" })).toHaveLength(1);
  });

  it("filters by sessionId", () => {
    const { parent } = setupScenario();
    const parent2 = createCommitment({
      sessionId: "sess-2",
      description: "Other task",
      source: "dispatch",
      turnCreated: 1,
    });

    submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review 1",
    });
    submitAgentRequest({
      sessionId: "sess-2",
      parentCommitmentId: parent2.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review 2",
    });

    expect(listAgentRequests({ sessionId: "sess-1" })).toHaveLength(1);
    expect(listAgentRequests({ sessionId: "sess-2" })).toHaveLength(1);
  });
});

describe("listPendingRequests", () => {
  it("returns only pending requests", () => {
    const { parent } = setupScenario();
    const sub1 = submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review 1",
    });
    submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review 2",
    });

    if ("request" in sub1) {
      denyAgentRequest(sub1.request.id, "No");
    }

    expect(listPendingRequests()).toHaveLength(1);
  });

  it("filters by session", () => {
    const { parent } = setupScenario();
    submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review",
    });

    expect(listPendingRequests("sess-1")).toHaveLength(1);
    expect(listPendingRequests("sess-2")).toHaveLength(0);
  });
});

// ── getRequestEvents ─────────────────────────────────────────────────────────

describe("getRequestEvents", () => {
  it("tracks events for a request lifecycle", () => {
    const { parent } = setupScenario();
    const submit = submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review",
    });
    if (!("request" in submit)) throw new Error("submit failed");

    approveAgentRequest(submit.request.id, 3);
    completeAgentRequest(submit.request.id);

    const events = getRequestEvents(submit.request.id);
    expect(events).toHaveLength(3);
    expect(events[0].event).toBe("agent-request-sent");
    expect(events[1].event).toBe("agent-request-approved");
    expect(events[2].event).toBe("agent-request-completed");
  });

  it("returns empty for unknown request", () => {
    expect(getRequestEvents("fake")).toHaveLength(0);
  });
});

// ── buildPendingRequestsSection ──────────────────────────────────────────────

describe("buildPendingRequestsSection", () => {
  it("returns null for empty list", () => {
    expect(buildPendingRequestsSection([])).toBeNull();
  });

  it("formats pending requests", () => {
    const { parent } = setupScenario();
    submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review auth module",
      estimatedDuration: 15,
    });

    const pending = listPendingRequests();
    const section = buildPendingRequestsSection(pending);

    expect(section).not.toBeNull();
    expect(section).toContain("PENDING AGENT REQUESTS (1)");
    expect(section).toContain("dev → critic");
    expect(section).toContain("Review auth module");
    expect(section).toContain("~15m");
    expect(section).toContain("Approve or deny");
  });

  it("lists multiple requests", () => {
    const { parent } = setupScenario();
    registerAgent({
      agentName: "security",
      agentType: "specialist",
      capabilities: [{ name: "security-audit" }],
    });

    submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Code review",
    });
    submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "security",
      reason: "Security audit",
    });

    const section = buildPendingRequestsSection(listPendingRequests());
    expect(section).toContain("PENDING AGENT REQUESTS (2)");
    expect(section).toContain("dev → critic");
    expect(section).toContain("dev → security");
  });

  it("omits duration when not provided", () => {
    const { parent } = setupScenario();
    submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Quick check",
    });

    const section = buildPendingRequestsSection(listPendingRequests());
    expect(section).not.toContain("~");
  });
});

// ── Full lifecycle scenario ──────────────────────────────────────────────────

describe("full lifecycle: submit → approve → complete", () => {
  it("runs the complete happy path", () => {
    const { parent } = setupScenario();

    // 1. Dev submits request to critic
    const submit = submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review auth module implementation",
      estimatedDuration: 15,
      requiredCapability: "code-review",
    });
    expect("request" in submit).toBe(true);
    if (!("request" in submit)) return;
    expect(submit.request.status).toBe("pending");

    // 2. Coordinator sees pending request
    const pending = listPendingRequests("sess-1");
    expect(pending).toHaveLength(1);
    const section = buildPendingRequestsSection(pending);
    expect(section).toContain("dev → critic");

    // 3. Coordinator approves
    const approval = approveAgentRequest(submit.request.id, 5);
    expect("approved" in approval).toBe(true);
    if (!("approved" in approval) || !approval.approved) return;

    expect(approval.subCommitment.targetAgent).toBe("critic");
    expect(approval.subCommitment.workItemId).toBe("ELLIE-100");
    expect(approval.routeInfo.agentName).toBe("critic");

    // Pending list now empty
    expect(listPendingRequests("sess-1")).toHaveLength(0);

    // 4. Critic completes the work
    const completion = completeAgentRequest(submit.request.id);
    expect("request" in completion).toBe(true);
    if ("request" in completion) {
      expect(completion.request.status).toBe("completed");
    }

    // 5. Full event trail
    const events = getRequestEvents(submit.request.id);
    expect(events).toHaveLength(3);
    expect(events.map(e => e.event)).toEqual([
      "agent-request-sent",
      "agent-request-approved",
      "agent-request-completed",
    ]);
  });

  it("runs the denial path", () => {
    const { parent } = setupScenario();

    const submit = submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review",
    });
    if (!("request" in submit)) return;

    // Coordinator denies
    const denial = denyAgentRequest(submit.request.id, "Handle it yourself — critic is overloaded");
    expect("approved" in denial).toBe(true);
    if ("approved" in denial) {
      expect(denial.approved).toBe(false);
      expect(denial.reason).toContain("overloaded");
    }

    // Request is denied, not pending
    expect(listPendingRequests()).toHaveLength(0);
    expect(getAgentRequest(submit.request.id)!.status).toBe("denied");

    // Event trail
    const events = getRequestEvents(submit.request.id);
    expect(events).toHaveLength(2);
    expect(events[1].event).toBe("agent-request-denied");
  });

  it("runs the timeout path", () => {
    const { parent } = setupScenario();

    submitAgentRequest({
      sessionId: "sess-1",
      parentCommitmentId: parent.id,
      requestingAgent: "dev",
      targetAgent: "critic",
      reason: "Review",
    });

    // Timeout with 0ms threshold
    const count = timeoutPendingRequests(0);
    expect(count).toBe(1);
    expect(listPendingRequests()).toHaveLength(0);
  });
});
