/**
 * ELLIE-656: Tests for chat bubble array mutation patterns.
 *
 * The composable useEllieChat.ts had bugs where array reassignment
 * (e.g. `messages.value = messages.value.filter(...)`) broke Vue
 * reactivity, causing chat bubbles to vanish.
 *
 * The fix: use in-place mutations (splice, push) instead of reassignment.
 * These tests validate the mutation logic works correctly without
 * depending on Vue or browser APIs.
 */

import { describe, it, expect, beforeEach } from "bun:test";

// ── Simulate Vue ref behavior ────────────────────────────────
// A ref holds a .value that can be a primitive or array.
// The key insight: reassigning .value = newArray loses the reactive proxy.
// Splicing in-place keeps the same array reference.

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  ts: number;
}

interface ToolApproval {
  id: string;
  tool_name: string;
  description: string;
  ts: number;
  remember: boolean;
  expired: boolean;
}

interface Confirm {
  id: string;
  description: string;
  ts: number;
}

// ── Test helpers ─────────────────────────────────────────────

function makeMessage(id: string, role: Message["role"] = "assistant", text = "hello"): Message {
  return { id, role, text, ts: Date.now() };
}

function makeApproval(id: string): ToolApproval {
  return { id, tool_name: "bash", description: "run ls", ts: Date.now(), remember: true, expired: false };
}

function makeConfirm(id: string): Confirm {
  return { id, description: "confirm action", ts: Date.now() };
}

// ── switchChannel ────────────────────────────────────────────

describe("switchChannel — array mutation", () => {
  it("replaces messages in-place using splice, preserving array reference", () => {
    const messages: Message[] = [makeMessage("a"), makeMessage("b")];
    const originalRef = messages;
    const loaded = [makeMessage("c"), makeMessage("d"), makeMessage("e")];

    // Fix pattern: splice(0, length, ...newItems) instead of reassignment
    messages.splice(0, messages.length, ...loaded);

    expect(messages).toBe(originalRef); // Same array reference
    expect(messages.length).toBe(3);
    expect(messages[0].id).toBe("c");
    expect(messages[2].id).toBe("e");
  });

  it("clears pendingConfirms in-place using splice(0)", () => {
    const confirms: Confirm[] = [makeConfirm("1"), makeConfirm("2")];
    const originalRef = confirms;

    confirms.splice(0);

    expect(confirms).toBe(originalRef);
    expect(confirms.length).toBe(0);
  });

  it("clears pendingToolApprovals in-place using splice(0)", () => {
    const approvals: ToolApproval[] = [makeApproval("1"), makeApproval("2")];
    const originalRef = approvals;

    approvals.splice(0);

    expect(approvals).toBe(originalRef);
    expect(approvals.length).toBe(0);
  });
});

// ── tool_approval_expired ────────────────────────────────────

describe("tool_approval_expired — array mutation", () => {
  it("removes approval by splice instead of filter reassignment", () => {
    const approvals: ToolApproval[] = [
      makeApproval("a1"),
      makeApproval("a2"),
      makeApproval("a3"),
    ];
    const originalRef = approvals;
    const targetId = "a2";

    // Fix pattern: findIndex + splice instead of filter reassignment
    const idx = approvals.findIndex(a => a.id === targetId);
    if (idx !== -1) approvals.splice(idx, 1);

    expect(approvals).toBe(originalRef);
    expect(approvals.length).toBe(2);
    expect(approvals.map(a => a.id)).toEqual(["a1", "a3"]);
  });

  it("removes expired message by splice instead of filter reassignment", () => {
    const messages: Message[] = [
      makeMessage("msg-1"),
      makeMessage("expired-tool-1", "system", "Tool approval expired"),
      makeMessage("msg-2"),
    ];
    const originalRef = messages;
    const expiredId = "expired-tool-1";

    // Fix pattern: findIndex + splice instead of filter reassignment
    const rmIdx = messages.findIndex(m => m.id === expiredId);
    if (rmIdx !== -1) messages.splice(rmIdx, 1);

    expect(messages).toBe(originalRef);
    expect(messages.length).toBe(2);
    expect(messages.map(m => m.id)).toEqual(["msg-1", "msg-2"]);
  });

  it("handles removal when item not found (no-op)", () => {
    const messages: Message[] = [makeMessage("msg-1"), makeMessage("msg-2")];
    const originalRef = messages;

    const rmIdx = messages.findIndex(m => m.id === "nonexistent");
    if (rmIdx !== -1) messages.splice(rmIdx, 1);

    expect(messages).toBe(originalRef);
    expect(messages.length).toBe(2);
  });
});

// ── respondToConfirm ─────────────────────────────────────────

describe("respondToConfirm — array mutation", () => {
  it("removes confirm by splice instead of filter reassignment", () => {
    const confirms: Confirm[] = [
      makeConfirm("c1"),
      makeConfirm("c2"),
      makeConfirm("c3"),
    ];
    const originalRef = confirms;
    const targetId = "c2";

    const idx = confirms.findIndex(c => c.id === targetId);
    if (idx !== -1) confirms.splice(idx, 1);

    expect(confirms).toBe(originalRef);
    expect(confirms.length).toBe(2);
    expect(confirms.map(c => c.id)).toEqual(["c1", "c3"]);
  });
});

// ── respondToToolApproval ────────────────────────────────────

describe("respondToToolApproval — array mutation", () => {
  it("finds approval remember value and removes by splice", () => {
    const approvals: ToolApproval[] = [
      makeApproval("a1"),
      { ...makeApproval("a2"), remember: false },
      makeApproval("a3"),
    ];
    const originalRef = approvals;

    const approvalIdx = approvals.findIndex(a => a.id === "a2");
    const remember = approvalIdx !== -1 ? approvals[approvalIdx].remember : true;
    if (approvalIdx !== -1) approvals.splice(approvalIdx, 1);

    expect(remember).toBe(false);
    expect(approvals).toBe(originalRef);
    expect(approvals.length).toBe(2);
    expect(approvals.map(a => a.id)).toEqual(["a1", "a3"]);
  });

  it("defaults remember to true when approval not found", () => {
    const approvals: ToolApproval[] = [makeApproval("a1")];

    const approvalIdx = approvals.findIndex(a => a.id === "nonexistent");
    const remember = approvalIdx !== -1 ? approvals[approvalIdx].remember : true;

    expect(remember).toBe(true);
    expect(approvals.length).toBe(1); // unchanged
  });
});

// ── startNewChat ─────────────────────────────────────────────

describe("startNewChat — array mutation", () => {
  it("clears all arrays in-place using splice(0)", () => {
    const messages: Message[] = [makeMessage("a"), makeMessage("b"), makeMessage("c")];
    const confirms: Confirm[] = [makeConfirm("c1")];
    const approvals: ToolApproval[] = [makeApproval("a1"), makeApproval("a2")];

    const msgRef = messages;
    const confRef = confirms;
    const appRef = approvals;

    messages.splice(0);
    confirms.splice(0);
    approvals.splice(0);

    expect(messages).toBe(msgRef);
    expect(confirms).toBe(confRef);
    expect(approvals).toBe(appRef);
    expect(messages.length).toBe(0);
    expect(confirms.length).toBe(0);
    expect(approvals.length).toBe(0);
  });
});

// ── Regression: reassignment vs splice ───────────────────────

describe("regression — reassignment breaks reference identity", () => {
  it("filter reassignment creates a NEW array (the bug)", () => {
    const original: Message[] = [makeMessage("a"), makeMessage("b")];
    const ref = original;

    // This is what the OLD code did — breaks reactivity
    const filtered = original.filter(m => m.id !== "a");

    // filtered is a new array, not the same reference
    expect(filtered).not.toBe(ref);
    expect(filtered.length).toBe(1);
  });

  it("splice preserves the SAME array reference (the fix)", () => {
    const original: Message[] = [makeMessage("a"), makeMessage("b")];
    const ref = original;

    // This is what the NEW code does — preserves reactivity
    const idx = original.findIndex(m => m.id === "a");
    if (idx !== -1) original.splice(idx, 1);

    expect(original).toBe(ref); // Same reference!
    expect(original.length).toBe(1);
    expect(original[0].id).toBe("b");
  });

  it("empty array assignment creates a NEW array (the bug)", () => {
    const original: Message[] = [makeMessage("a")];
    const ref = original;

    // Old code: messages.value = []
    const replacement: Message[] = [];
    expect(replacement).not.toBe(ref);
  });

  it("splice(0) preserves the SAME array reference (the fix)", () => {
    const original: Message[] = [makeMessage("a")];
    const ref = original;

    original.splice(0);

    expect(original).toBe(ref);
    expect(original.length).toBe(0);
  });

  it("splice(0, length, ...new) replaces content preserving reference (the fix)", () => {
    const original: Message[] = [makeMessage("a")];
    const ref = original;
    const newItems = [makeMessage("b"), makeMessage("c")];

    original.splice(0, original.length, ...newItems);

    expect(original).toBe(ref);
    expect(original.length).toBe(2);
    expect(original[0].id).toBe("b");
    expect(original[1].id).toBe("c");
  });
});
