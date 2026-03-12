/**
 * Formation Protocol Tests — ELLIE-674
 *
 * Tests for inter-agent communication primitives, message handling,
 * round management, vote aggregation, and protocol executors.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  postMessage,
  broadcast,
  directMessage,
  getSessionMessages,
  getRoundMessages,
  getAgentMessages,
  advanceRound,
  completeSession,
  failSession,
  parseVotes,
  aggregateVotes,
  collectAndAggregateVotes,
  executeFanOut,
  executeDebate,
  executeConsensus,
  executeDelegation,
  executePipeline,
  startSession,
  _makeMockDeps,
  _makeMockSession,
  _makeMockMessage,
  _resetIdCounter,
} from "../src/formations/protocol.ts";

// ── Setup ───────────────────────────────────────────────────────

beforeEach(() => {
  _resetIdCounter();
});

// ── postMessage ─────────────────────────────────────────────────

describe("postMessage", () => {
  test("posts a message to an active session", async () => {
    const session = _makeMockSession();
    const deps = _makeMockDeps(session);

    const msg = await postMessage(deps, session.id, "dev", "Hello from dev");

    expect(msg.from_agent).toBe("dev");
    expect(msg.content).toBe("Hello from dev");
    expect(msg.session_id).toBe(session.id);
    expect(msg.message_type).toBe("response");
    expect(msg.turn_number).toBe(0);
    expect(deps.messages).toHaveLength(1);
  });

  test("uses custom message type", async () => {
    const session = _makeMockSession();
    const deps = _makeMockDeps(session);

    const msg = await postMessage(deps, session.id, "dev", "Proposal", {
      messageType: "proposal",
    });
    expect(msg.message_type).toBe("proposal");
  });

  test("includes toAgent for directed messages", async () => {
    const session = _makeMockSession();
    const deps = _makeMockDeps(session);

    const msg = await postMessage(deps, session.id, "dev", "Hey critic", {
      toAgent: "critic",
    });
    expect(msg.to_agent).toBe("critic");
  });

  test("includes metadata", async () => {
    const session = _makeMockSession();
    const deps = _makeMockDeps(session);

    const msg = await postMessage(deps, session.id, "dev", "With meta", {
      metadata: { key: "value" },
    });
    expect(msg.metadata).toEqual({ key: "value" });
  });

  test("throws on non-existent session", async () => {
    const deps = _makeMockDeps();
    await expect(postMessage(deps, "nonexistent", "dev", "test")).rejects.toThrow("not found");
  });

  test("throws on non-active session", async () => {
    const session = _makeMockSession({ state: "completed" });
    const deps = _makeMockDeps(session);
    await expect(postMessage(deps, session.id, "dev", "test")).rejects.toThrow("not active");
  });
});

// ── broadcast ───────────────────────────────────────────────────

describe("broadcast", () => {
  test("sends message to all other agents", async () => {
    const session = _makeMockSession({ participating_agents: ["dev", "critic", "research"] });
    const deps = _makeMockDeps(session);

    const msgs = await broadcast(deps, session.id, "dev", "Attention everyone");

    expect(msgs).toHaveLength(2); // critic + research
    expect(msgs.map(m => m.to_agent).sort()).toEqual(["critic", "research"]);
    expect(msgs.every(m => m.from_agent === "dev")).toBe(true);
    expect(msgs.every(m => m.content === "Attention everyone")).toBe(true);
    expect(msgs.every(m => m.message_type === "proposal")).toBe(true);
  });

  test("returns empty array when only one agent", async () => {
    const session = _makeMockSession({ participating_agents: ["dev"] });
    const deps = _makeMockDeps(session);

    const msgs = await broadcast(deps, session.id, "dev", "No one to send to");
    expect(msgs).toHaveLength(0);
  });

  test("uses custom message type", async () => {
    const session = _makeMockSession({ participating_agents: ["dev", "critic"] });
    const deps = _makeMockDeps(session);

    const msgs = await broadcast(deps, session.id, "dev", "Decision!", {
      messageType: "decision",
    });
    expect(msgs[0].message_type).toBe("decision");
  });

  test("throws on non-active session", async () => {
    const session = _makeMockSession({ state: "paused" });
    const deps = _makeMockDeps(session);
    await expect(broadcast(deps, session.id, "dev", "test")).rejects.toThrow("not active");
  });
});

// ── directMessage ───────────────────────────────────────────────

describe("directMessage", () => {
  test("sends message to specific agent", async () => {
    const session = _makeMockSession();
    const deps = _makeMockDeps(session);

    const msg = await directMessage(deps, session.id, "dev", "critic", "Please review this");

    expect(msg.from_agent).toBe("dev");
    expect(msg.to_agent).toBe("critic");
    expect(msg.content).toBe("Please review this");
    expect(msg.message_type).toBe("response");
  });

  test("uses custom message type", async () => {
    const session = _makeMockSession();
    const deps = _makeMockDeps(session);

    const msg = await directMessage(deps, session.id, "dev", "critic", "Escalation", {
      messageType: "escalation",
    });
    expect(msg.message_type).toBe("escalation");
  });
});

// ── Message Retrieval ───────────────────────────────────────────

describe("message retrieval", () => {
  test("getSessionMessages returns all messages for session", async () => {
    const session = _makeMockSession();
    const deps = _makeMockDeps(session);

    await postMessage(deps, session.id, "dev", "First");
    await postMessage(deps, session.id, "critic", "Second");
    await postMessage(deps, session.id, "research", "Third");

    const msgs = await getSessionMessages(deps, session.id);
    expect(msgs).toHaveLength(3);
  });

  test("getRoundMessages returns only messages for that round", async () => {
    const session = _makeMockSession();
    const deps = _makeMockDeps(session);

    await postMessage(deps, session.id, "dev", "Round 0 message");
    await advanceRound(deps, session.id);
    await postMessage(deps, session.id, "critic", "Round 1 message");

    const round0 = await getRoundMessages(deps, session.id, 0);
    const round1 = await getRoundMessages(deps, session.id, 1);

    expect(round0).toHaveLength(1);
    expect(round0[0].content).toBe("Round 0 message");
    expect(round1).toHaveLength(1);
    expect(round1[0].content).toBe("Round 1 message");
  });

  test("getAgentMessages returns only messages from that agent", async () => {
    const session = _makeMockSession();
    const deps = _makeMockDeps(session);

    await postMessage(deps, session.id, "dev", "Dev message 1");
    await postMessage(deps, session.id, "critic", "Critic message");
    await postMessage(deps, session.id, "dev", "Dev message 2");

    const devMsgs = await getAgentMessages(deps, session.id, "dev");
    expect(devMsgs).toHaveLength(2);
    expect(devMsgs.every(m => m.from_agent === "dev")).toBe(true);
  });

  test("empty session returns empty array", async () => {
    const session = _makeMockSession();
    const deps = _makeMockDeps(session);

    const msgs = await getSessionMessages(deps, session.id);
    expect(msgs).toHaveLength(0);
  });
});

// ── Round Management ────────────────────────────────────────────

describe("advanceRound", () => {
  test("increments turn count", async () => {
    const session = _makeMockSession({ turn_count: 0 });
    const deps = _makeMockDeps(session);

    const newTurn = await advanceRound(deps, session.id);
    expect(newTurn).toBe(1);

    const updated = await deps.sessionStore.getSession(session.id);
    expect(updated!.turn_count).toBe(1);
  });

  test("auto-completes when max turns reached", async () => {
    const session = _makeMockSession({
      turn_count: 9,
      protocol: { pattern: "coordinator", maxTurns: 10, requiresApproval: false, coordinator: "dev" },
    });
    const deps = _makeMockDeps(session);

    const newTurn = await advanceRound(deps, session.id);
    expect(newTurn).toBe(10);

    const updated = await deps.sessionStore.getSession(session.id);
    expect(updated!.state).toBe("completed");
    expect(updated!.completed_at).not.toBeNull();
  });

  test("does not complete when maxTurns is 0 (unlimited)", async () => {
    const session = _makeMockSession({
      turn_count: 100,
      protocol: { pattern: "free-form", maxTurns: 0, requiresApproval: false },
    });
    const deps = _makeMockDeps(session);

    const newTurn = await advanceRound(deps, session.id);
    expect(newTurn).toBe(101);

    const updated = await deps.sessionStore.getSession(session.id);
    expect(updated!.state).toBe("active");
  });

  test("throws on non-active session", async () => {
    const session = _makeMockSession({ state: "failed" });
    const deps = _makeMockDeps(session);
    await expect(advanceRound(deps, session.id)).rejects.toThrow("not active");
  });
});

// ── completeSession ─────────────────────────────────────────────

describe("completeSession", () => {
  test("marks session as completed", async () => {
    const session = _makeMockSession();
    const deps = _makeMockDeps(session);

    const updated = await completeSession(deps, session.id);
    expect(updated.state).toBe("completed");
    expect(updated.completed_at).not.toBeNull();
  });

  test("adds summary to metadata", async () => {
    const session = _makeMockSession();
    const deps = _makeMockDeps(session);

    const updated = await completeSession(deps, session.id, { summary: "All done" });
    expect(updated.metadata.completion_summary).toBe("All done");
  });

  test("posts a system message", async () => {
    const session = _makeMockSession();
    const deps = _makeMockDeps(session);

    await completeSession(deps, session.id, { summary: "Completed!" });
    const systemMsgs = deps.messages.filter(m => m.message_type === "system");
    expect(systemMsgs).toHaveLength(1);
    expect(systemMsgs[0].content).toBe("Completed!");
  });

  test("throws on non-existent session", async () => {
    const deps = _makeMockDeps();
    await expect(completeSession(deps, "nonexistent")).rejects.toThrow("not found");
  });
});

// ── failSession ─────────────────────────────────────────────────

describe("failSession", () => {
  test("marks session as failed", async () => {
    const session = _makeMockSession();
    const deps = _makeMockDeps(session);

    const updated = await failSession(deps, session.id, "Agent timed out");
    expect(updated.state).toBe("failed");
    expect(updated.metadata.failure_reason).toBe("Agent timed out");
  });

  test("posts a system message with reason", async () => {
    const session = _makeMockSession();
    const deps = _makeMockDeps(session);

    await failSession(deps, session.id, "Conflict unresolved");
    const systemMsgs = deps.messages.filter(m => m.message_type === "system");
    expect(systemMsgs).toHaveLength(1);
    expect(systemMsgs[0].content).toContain("Conflict unresolved");
  });
});

// ── parseVotes ──────────────────────────────────────────────────

describe("parseVotes", () => {
  test("parses votes from message metadata", () => {
    const messages = [
      _makeMockMessage({ from_agent: "dev", metadata: { vote: "approve", confidence: 0.9 } }),
      _makeMockMessage({ from_agent: "critic", metadata: { vote: "reject", reasoning: "Needs work" } }),
      _makeMockMessage({ from_agent: "research", metadata: { vote: "approve" } }),
    ];

    const votes = parseVotes(messages);
    expect(votes).toHaveLength(3);
    expect(votes[0]).toEqual({ agent: "dev", choice: "approve", confidence: 0.9, reasoning: undefined });
    expect(votes[1]).toEqual({ agent: "critic", choice: "reject", confidence: undefined, reasoning: "Needs work" });
    expect(votes[2]).toEqual({ agent: "research", choice: "approve", confidence: undefined, reasoning: undefined });
  });

  test("skips messages without vote metadata", () => {
    const messages = [
      _makeMockMessage({ from_agent: "dev", metadata: { vote: "approve" } }),
      _makeMockMessage({ from_agent: "critic", metadata: {} }),
      _makeMockMessage({ from_agent: "research", metadata: { comment: "Just a comment" } }),
    ];

    const votes = parseVotes(messages);
    expect(votes).toHaveLength(1);
    expect(votes[0].agent).toBe("dev");
  });

  test("returns empty array for no votes", () => {
    expect(parseVotes([])).toHaveLength(0);
  });
});

// ── aggregateVotes ──────────────────────────────────────────────

describe("aggregateVotes", () => {
  test("determines winner by simple majority", () => {
    const votes = [
      { agent: "dev", choice: "approve" },
      { agent: "critic", choice: "reject" },
      { agent: "research", choice: "approve" },
    ];

    const result = aggregateVotes(votes);
    expect(result.winner).toBe("approve");
    expect(result.totalVotes).toBe(3);
    expect(result.scores.get("approve")).toBe(2);
    expect(result.scores.get("reject")).toBe(1);
    expect(result.consensusReached).toBe(true); // 2/3 > 0.5
    expect(result.consensusScore).toBeCloseTo(2 / 3, 5);
  });

  test("uses confidence as weight", () => {
    const votes = [
      { agent: "dev", choice: "approve", confidence: 0.9 },
      { agent: "critic", choice: "reject", confidence: 0.3 },
    ];

    const result = aggregateVotes(votes);
    expect(result.winner).toBe("approve");
    expect(result.scores.get("approve")).toBe(0.9);
    expect(result.scores.get("reject")).toBe(0.3);
    expect(result.consensusScore).toBeCloseTo(0.9 / 1.2, 5);
  });

  test("reports no consensus when below threshold", () => {
    const votes = [
      { agent: "dev", choice: "A" },
      { agent: "critic", choice: "B" },
      { agent: "research", choice: "C" },
    ];

    const result = aggregateVotes(votes, 0.5);
    expect(result.consensusReached).toBe(false);
    expect(result.consensusScore).toBeCloseTo(1 / 3, 5);
  });

  test("handles empty votes", () => {
    const result = aggregateVotes([]);
    expect(result.winner).toBeNull();
    expect(result.totalVotes).toBe(0);
    expect(result.consensusReached).toBe(false);
    expect(result.consensusScore).toBe(0);
  });

  test("handles unanimous vote", () => {
    const votes = [
      { agent: "dev", choice: "approve" },
      { agent: "critic", choice: "approve" },
      { agent: "research", choice: "approve" },
    ];

    const result = aggregateVotes(votes);
    expect(result.winner).toBe("approve");
    expect(result.consensusScore).toBe(1);
    expect(result.consensusReached).toBe(true);
  });

  test("custom threshold works", () => {
    const votes = [
      { agent: "dev", choice: "approve" },
      { agent: "critic", choice: "reject" },
      { agent: "research", choice: "approve" },
    ];

    // 2/3 ≈ 0.67, threshold 0.75 → no consensus
    const result = aggregateVotes(votes, 0.75);
    expect(result.consensusReached).toBe(false);
  });
});

// ── collectAndAggregateVotes ────────────────────────────────────

describe("collectAndAggregateVotes", () => {
  test("collects votes from a round and aggregates", async () => {
    const session = _makeMockSession();
    const deps = _makeMockDeps(session);

    // Post vote messages in round 0
    await postMessage(deps, session.id, "dev", "I vote approve", {
      metadata: { vote: "approve" },
    });
    await postMessage(deps, session.id, "critic", "I vote reject", {
      metadata: { vote: "reject" },
    });
    await postMessage(deps, session.id, "research", "I vote approve", {
      metadata: { vote: "approve" },
    });

    const result = await collectAndAggregateVotes(deps, session.id, 0);
    expect(result.winner).toBe("approve");
    expect(result.totalVotes).toBe(3);
    expect(result.consensusReached).toBe(true);
  });
});

// ── executeFanOut ───────────────────────────────────────────────

describe("executeFanOut", () => {
  test("posts proposal and advances round", async () => {
    const session = _makeMockSession();
    const deps = _makeMockDeps(session);

    const result = await executeFanOut(deps, session.id, "dev", "Here is my proposal");

    expect(result.sessionId).toBe(session.id);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].message_type).toBe("proposal");
    expect(result.messages[0].from_agent).toBe("dev");
    expect(result.isComplete).toBe(false);
    expect(result.roundNumber).toBe(1);
  });

  test("throws on non-existent session", async () => {
    const deps = _makeMockDeps();
    await expect(executeFanOut(deps, "bad-id", "dev", "test")).rejects.toThrow("not found");
  });
});

// ── executeDebate ───────────────────────────────────────────────

describe("executeDebate", () => {
  test("alternates between two agents", async () => {
    const session = _makeMockSession({ turn_count: 0 });
    const deps = _makeMockDeps(session);

    // Round 0 → agent A's turn (even)
    const r0 = await executeDebate(deps, session.id, "dev", "critic");
    expect(r0.nextAgent).toBe("dev");
    expect(r0.isComplete).toBe(false);

    // Advance and check round 1 → agent B's turn (odd)
    await advanceRound(deps, session.id);
    const r1 = await executeDebate(deps, session.id, "dev", "critic");
    expect(r1.nextAgent).toBe("critic");
  });

  test("marks complete when max turns reached", async () => {
    const session = _makeMockSession({
      turn_count: 9,
      protocol: { pattern: "debate", maxTurns: 10, requiresApproval: false },
    });
    const deps = _makeMockDeps(session);

    const result = await executeDebate(deps, session.id, "dev", "critic");
    expect(result.isComplete).toBe(true);
  });
});

// ── executeConsensus ────────────────────────────────────────────

describe("executeConsensus", () => {
  test("detects consensus and posts decision", async () => {
    const session = _makeMockSession();
    const deps = _makeMockDeps(session);

    // All agents vote approve
    await postMessage(deps, session.id, "dev", "Approve", { metadata: { vote: "approve" } });
    await postMessage(deps, session.id, "critic", "Approve", { metadata: { vote: "approve" } });
    await postMessage(deps, session.id, "research", "Approve", { metadata: { vote: "approve" } });

    const result = await executeConsensus(deps, session.id);
    expect(result.isComplete).toBe(true);
    expect(result.voteResult.winner).toBe("approve");
    expect(result.voteResult.consensusReached).toBe(true);

    // Should have posted a decision message
    const decisions = deps.messages.filter(m => m.message_type === "decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0].content).toContain("Consensus reached: approve");
  });

  test("reports no consensus when split", async () => {
    const session = _makeMockSession();
    const deps = _makeMockDeps(session);

    await postMessage(deps, session.id, "dev", "A", { metadata: { vote: "A" } });
    await postMessage(deps, session.id, "critic", "B", { metadata: { vote: "B" } });
    await postMessage(deps, session.id, "research", "C", { metadata: { vote: "C" } });

    const result = await executeConsensus(deps, session.id);
    expect(result.isComplete).toBe(false);
    expect(result.voteResult.consensusReached).toBe(false);
  });
});

// ── executeDelegation ───────────────────────────────────────────

describe("executeDelegation", () => {
  test("delegates task to target agent", async () => {
    const session = _makeMockSession({ participating_agents: ["dev", "critic", "research"] });
    const deps = _makeMockDeps(session);

    const result = await executeDelegation(deps, session.id, "dev", "research", "Find context for this PR");

    expect(result.nextAgent).toBe("research");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].to_agent).toBe("research");
    expect(result.messages[0].from_agent).toBe("dev");
    expect(result.messages[0].content).toBe("Find context for this PR");
    expect(result.messages[0].metadata).toEqual({ delegation: true });
    expect(result.isComplete).toBe(false);
  });

  test("throws when target agent not in participants", async () => {
    const session = _makeMockSession({ participating_agents: ["dev", "critic"] });
    const deps = _makeMockDeps(session);

    await expect(
      executeDelegation(deps, session.id, "dev", "finance", "Do analysis"),
    ).rejects.toThrow("not a participant");
  });
});

// ── executePipeline ─────────────────────────────────────────────

describe("executePipeline", () => {
  test("cycles through agents in order", async () => {
    const session = _makeMockSession({
      turn_count: 0,
      protocol: {
        pattern: "pipeline",
        maxTurns: 6,
        turnOrder: ["research", "content", "critic"],
        requiresApproval: false,
      },
      participating_agents: ["research", "content", "critic"],
    });
    const deps = _makeMockDeps(session);

    // Round 0 → current is research (index 0), next is content
    const r0 = await executePipeline(deps, session.id);
    expect(r0.nextAgent).toBe("content");
    expect(r0.isComplete).toBe(false);

    // Advance to round 1
    await advanceRound(deps, session.id);
    const r1 = await executePipeline(deps, session.id);
    expect(r1.nextAgent).toBe("critic");

    // Advance to round 2
    await advanceRound(deps, session.id);
    const r2 = await executePipeline(deps, session.id);
    expect(r2.nextAgent).toBe("research"); // wraps around
  });

  test("completes after enough cycles", async () => {
    const session = _makeMockSession({
      turn_count: 5,
      protocol: {
        pattern: "pipeline",
        maxTurns: 6,
        turnOrder: ["A", "B", "C"],
        requiresApproval: false,
      },
      participating_agents: ["A", "B", "C"],
    });
    const deps = _makeMockDeps(session);

    // maxTurns=6, turnOrder length=3, maxCycles = ceil(6/3) = 2
    // completedCycles at turn 5 = floor(5/3) = 1, not yet complete
    const r = await executePipeline(deps, session.id);
    expect(r.isComplete).toBe(false);

    // Advance to turn 6 → completedCycles = floor(6/3) = 2 >= maxCycles(2)
    await advanceRound(deps, session.id);
    const r2 = await executePipeline(deps, session.id);
    expect(r2.isComplete).toBe(true);
  });

  test("falls back to participating_agents when no turnOrder", async () => {
    const session = _makeMockSession({
      turn_count: 0,
      protocol: { pattern: "pipeline", maxTurns: 0, requiresApproval: false },
      participating_agents: ["dev", "critic"],
    });
    const deps = _makeMockDeps(session);

    const r = await executePipeline(deps, session.id);
    expect(r.nextAgent).toBe("critic");
  });
});

// ── startSession ────────────────────────────────────────────────

describe("startSession", () => {
  test("creates a new session with system message", async () => {
    const deps = _makeMockDeps();

    const session = await startSession(deps, {
      formation_name: "code-review",
      initiator_agent: "dev",
      participating_agents: ["dev", "critic"],
      protocol: { pattern: "coordinator", maxTurns: 10, coordinator: "dev", requiresApproval: false },
    });

    expect(session.formation_name).toBe("code-review");
    expect(session.initiator_agent).toBe("dev");
    expect(session.state).toBe("active");
    expect(session.turn_count).toBe(0);
    expect(session.participating_agents).toEqual(["dev", "critic"]);

    // Should have a system message
    expect(deps.messages).toHaveLength(1);
    expect(deps.messages[0].message_type).toBe("system");
    expect(deps.messages[0].content).toContain("code-review");
    expect(deps.messages[0].content).toContain("dev, critic");
  });

  test("includes optional fields", async () => {
    const deps = _makeMockDeps();

    const session = await startSession(deps, {
      formation_name: "review",
      initiator_agent: "dev",
      participating_agents: ["dev"],
      protocol: { pattern: "free-form", maxTurns: 0, requiresApproval: false },
      channel: "telegram",
      work_item_id: "ELLIE-674",
      metadata: { custom: "data" },
    });

    expect(session.channel).toBe("telegram");
    expect(session.work_item_id).toBe("ELLIE-674");
    expect(session.metadata).toEqual({ custom: "data" });
  });
});

// ── Mock Helpers ────────────────────────────────────────────────

describe("mock helpers", () => {
  test("_makeMockMessage returns valid message", () => {
    const msg = _makeMockMessage();
    expect(msg.id).toBeDefined();
    expect(msg.from_agent).toBe("dev");
    expect(msg.content).toBe("Test message");
  });

  test("_makeMockMessage accepts overrides", () => {
    const msg = _makeMockMessage({ from_agent: "critic", content: "Custom" });
    expect(msg.from_agent).toBe("critic");
    expect(msg.content).toBe("Custom");
  });

  test("_makeMockSession returns valid session", () => {
    const session = _makeMockSession();
    expect(session.id).toBe("test-session");
    expect(session.state).toBe("active");
    expect(session.participating_agents).toHaveLength(3);
  });

  test("_makeMockDeps provides working in-memory stores", async () => {
    const session = _makeMockSession();
    const deps = _makeMockDeps(session);

    // Can insert and retrieve messages
    const msg = await deps.messageWriter.insertMessage({
      session_id: session.id,
      from_agent: "dev",
      to_agent: null,
      content: "Test",
      turn_number: 0,
      message_type: "response",
    });
    expect(msg.id).toBeDefined();

    const retrieved = await deps.messageReader.getMessagesBySession(session.id);
    expect(retrieved).toHaveLength(1);

    // Can update session
    const updated = await deps.sessionStore.updateSession(session.id, { turn_count: 5 });
    expect(updated.turn_count).toBe(5);
  });

  test("_makeMockDeps messageReader filters by type", async () => {
    const session = _makeMockSession();
    const deps = _makeMockDeps(session);

    await postMessage(deps, session.id, "dev", "Proposal", { messageType: "proposal" });
    await postMessage(deps, session.id, "critic", "Response", { messageType: "response" });
    await postMessage(deps, session.id, "dev", "Decision", { messageType: "decision" });

    const proposals = await deps.messageReader.getMessagesByType(session.id, "proposal");
    expect(proposals).toHaveLength(1);
    expect(proposals[0].content).toBe("Proposal");
  });
});

// ── E2E: Full Formation Lifecycle ───────────────────────────────

describe("E2E: full formation lifecycle", () => {
  test("coordinator pattern: propose → respond → decide → complete", async () => {
    const deps = _makeMockDeps();

    // 1. Start session
    const session = await startSession(deps, {
      formation_name: "code-review",
      initiator_agent: "dev",
      participating_agents: ["dev", "critic", "strategy"],
      protocol: {
        pattern: "coordinator",
        maxTurns: 10,
        coordinator: "strategy",
        requiresApproval: false,
        conflictResolution: "coordinator-decides",
      },
    });
    expect(session.state).toBe("active");

    // 2. Dev proposes (fan-out)
    await executeFanOut(deps, session.id, "dev", "I propose we use approach A for the refactor");

    // 3. Critic and strategy respond
    await postMessage(deps, session.id, "critic", "I disagree, approach B is safer", {
      messageType: "response",
    });
    await postMessage(deps, session.id, "strategy", "Both have merit. Let me evaluate.", {
      messageType: "response",
    });

    // 4. Advance round
    await advanceRound(deps, session.id);

    // 5. Strategy (coordinator) makes a decision
    await postMessage(deps, session.id, "strategy", "Decision: Use approach A with B's safety measures", {
      messageType: "decision",
    });

    // 6. Complete the session
    const completed = await completeSession(deps, session.id, {
      summary: "Decided on hybrid approach: A's architecture with B's safety patterns",
    });

    expect(completed.state).toBe("completed");
    expect(completed.completed_at).not.toBeNull();

    // Verify message trail
    const allMessages = await getSessionMessages(deps, session.id);
    expect(allMessages.length).toBeGreaterThanOrEqual(5); // system start + proposal + 2 responses + decision + system complete

    const decisionMsgs = allMessages.filter(m => m.message_type === "decision");
    expect(decisionMsgs).toHaveLength(1);
    expect(decisionMsgs[0].from_agent).toBe("strategy");
  });

  test("consensus pattern: vote → aggregate → decide", async () => {
    const deps = _makeMockDeps();

    const session = await startSession(deps, {
      formation_name: "architecture-decision",
      initiator_agent: "strategy",
      participating_agents: ["dev", "critic", "strategy"],
      protocol: {
        pattern: "debate",
        maxTurns: 6,
        requiresApproval: true,
        conflictResolution: "majority-vote",
      },
    });

    // All agents vote
    await postMessage(deps, session.id, "dev", "I vote for microservices", {
      metadata: { vote: "microservices", confidence: 0.8 },
    });
    await postMessage(deps, session.id, "critic", "I vote for monolith", {
      metadata: { vote: "monolith", confidence: 0.6 },
    });
    await postMessage(deps, session.id, "strategy", "I vote for microservices", {
      metadata: { vote: "microservices", confidence: 0.9 },
    });

    // Execute consensus
    const result = await executeConsensus(deps, session.id);
    expect(result.voteResult.winner).toBe("microservices");
    expect(result.voteResult.consensusReached).toBe(true);
    expect(result.isComplete).toBe(true);

    // Complete session
    const completed = await completeSession(deps, session.id, {
      summary: "Consensus: microservices architecture",
    });
    expect(completed.state).toBe("completed");
  });

  test("pipeline pattern: sequential agent handoff", async () => {
    const deps = _makeMockDeps();

    const session = await startSession(deps, {
      formation_name: "content-pipeline",
      initiator_agent: "research",
      participating_agents: ["research", "content", "critic"],
      protocol: {
        pattern: "pipeline",
        maxTurns: 3,
        turnOrder: ["research", "content", "critic"],
        requiresApproval: false,
      },
    });

    // Round 0: research gathers info
    const r0 = await executePipeline(deps, session.id);
    expect(r0.nextAgent).toBe("content");
    await postMessage(deps, session.id, "research", "Here are the key findings: ...");
    await advanceRound(deps, session.id);

    // Round 1: content writes draft
    const r1 = await executePipeline(deps, session.id);
    expect(r1.nextAgent).toBe("critic");
    await postMessage(deps, session.id, "content", "Draft article: ...");
    await advanceRound(deps, session.id);

    // Round 2: critic reviews
    const r2 = await executePipeline(deps, session.id);
    await postMessage(deps, session.id, "critic", "Looks good with minor edits");

    // Complete
    const completed = await completeSession(deps, session.id, {
      summary: "Content pipeline complete: research → draft → review",
    });
    expect(completed.state).toBe("completed");

    // Verify each agent contributed
    const researchMsgs = await getAgentMessages(deps, session.id, "research");
    const contentMsgs = await getAgentMessages(deps, session.id, "content");
    const criticMsgs = await getAgentMessages(deps, session.id, "critic");
    expect(researchMsgs.length).toBeGreaterThanOrEqual(1);
    expect(contentMsgs.length).toBeGreaterThanOrEqual(1);
    expect(criticMsgs.length).toBeGreaterThanOrEqual(1);
  });
});
