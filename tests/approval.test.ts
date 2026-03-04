/**
 * ELLIE-510 — Approval module: extractApprovalTags + pending action store
 *
 * Covers: [CONFIRM: ...] tag parsing (pure function, no mocking needed),
 * storePendingAction / getPendingAction / removePendingAction Map operations.
 */
import { describe, test, expect } from "bun:test";
import {
  extractApprovalTags,
  storePendingAction,
  getPendingAction,
  removePendingAction,
} from "../src/approval.ts";

// ── extractApprovalTags ───────────────────────────────────────

describe("extractApprovalTags — no tags", () => {
  test("plain text with no tags → unchanged text, empty confirmations", () => {
    const result = extractApprovalTags("Hello, here is my response.");
    expect(result.cleanedText).toBe("Hello, here is my response.");
    expect(result.confirmations).toHaveLength(0);
  });

  test("empty string → empty text, empty confirmations", () => {
    const result = extractApprovalTags("");
    expect(result.cleanedText).toBe("");
    expect(result.confirmations).toHaveLength(0);
  });
});

describe("extractApprovalTags — single tag", () => {
  test("extracts description from a single [CONFIRM: ...] tag", () => {
    const result = extractApprovalTags("I will do this. [CONFIRM: Delete all logs]");
    expect(result.confirmations).toHaveLength(1);
    expect(result.confirmations[0]).toBe("Delete all logs");
  });

  test("removes the tag from cleanedText", () => {
    const result = extractApprovalTags("I will do this. [CONFIRM: Delete all logs]");
    expect(result.cleanedText).not.toContain("[CONFIRM:");
    expect(result.cleanedText).toBe("I will do this.");
  });

  test("description is trimmed of surrounding whitespace", () => {
    const result = extractApprovalTags("[CONFIRM:   lots of spaces   ]");
    expect(result.confirmations[0]).toBe("lots of spaces");
  });

  test("tag at the start of text", () => {
    const result = extractApprovalTags("[CONFIRM: Send email] then continue.");
    expect(result.confirmations[0]).toBe("Send email");
    expect(result.cleanedText).toBe("then continue.");
  });

  test("tag in the middle of text", () => {
    const result = extractApprovalTags("First part [CONFIRM: Reset password] second part.");
    expect(result.confirmations[0]).toBe("Reset password");
    expect(result.cleanedText).toBe("First part  second part.");
  });
});

describe("extractApprovalTags — multiple tags", () => {
  test("extracts all tags from a multi-tag response", () => {
    const response = "Step 1 done. [CONFIRM: Delete user] Step 2. [CONFIRM: Send notification]";
    const result = extractApprovalTags(response);
    expect(result.confirmations).toHaveLength(2);
    expect(result.confirmations).toContain("Delete user");
    expect(result.confirmations).toContain("Send notification");
  });

  test("removes all tags from cleanedText", () => {
    const response = "[CONFIRM: Action A] text [CONFIRM: Action B]";
    const result = extractApprovalTags(response);
    expect(result.cleanedText).not.toContain("[CONFIRM:");
  });

  test("three tags — all extracted in order", () => {
    const response = "[CONFIRM: first] [CONFIRM: second] [CONFIRM: third]";
    const result = extractApprovalTags(response);
    expect(result.confirmations).toEqual(["first", "second", "third"]);
  });
});

describe("extractApprovalTags — case-insensitive matching", () => {
  test("lowercase [confirm: ...] matches", () => {
    const result = extractApprovalTags("[confirm: lowercase action]");
    expect(result.confirmations).toHaveLength(1);
    expect(result.confirmations[0]).toBe("lowercase action");
  });

  test("mixed case [Confirm: ...] matches", () => {
    const result = extractApprovalTags("[Confirm: Mixed Case]");
    expect(result.confirmations).toHaveLength(1);
    expect(result.confirmations[0]).toBe("Mixed Case");
  });

  test("ALLCAPS [CONFIRM: ...] matches (the base case)", () => {
    const result = extractApprovalTags("[CONFIRM: ALL CAPS]");
    expect(result.confirmations[0]).toBe("ALL CAPS");
  });
});

describe("extractApprovalTags — edge cases", () => {
  test("description with special characters and punctuation", () => {
    const result = extractApprovalTags("[CONFIRM: Run: rm -rf /tmp/cache (irreversible!)]");
    expect(result.confirmations[0]).toBe("Run: rm -rf /tmp/cache (irreversible!)");
  });

  test("no space after colon → still matches (regex uses \\s*)", () => {
    const result = extractApprovalTags("[CONFIRM:NoSpace]");
    expect(result.confirmations).toHaveLength(1);
    expect(result.confirmations[0]).toBe("NoSpace");
  });

  test("cleanedText is trimmed of leading/trailing whitespace", () => {
    const result = extractApprovalTags("  [CONFIRM: action]  ");
    expect(result.cleanedText).toBe("");
  });
});

// ── Pending action store ──────────────────────────────────────

describe("storePendingAction / getPendingAction / removePendingAction", () => {
  const BASE_ID = "approval-test-" + Date.now();

  test("store then get returns the stored action", () => {
    const id = BASE_ID + "-1";
    storePendingAction(id, "Delete user account", "session-1", 12345, 99);
    const action = getPendingAction(id);
    expect(action).toBeDefined();
    expect(action!.id).toBe(id);
    expect(action!.description).toBe("Delete user account");
    expect(action!.sessionId).toBe("session-1");
    expect(action!.chatId).toBe(12345);
    expect(action!.messageId).toBe(99);
  });

  test("createdAt is set to approximately now", () => {
    const id = BASE_ID + "-2";
    const before = Date.now();
    storePendingAction(id, "some action", null, 1, 1);
    const after = Date.now();
    const action = getPendingAction(id);
    expect(action!.createdAt).toBeGreaterThanOrEqual(before);
    expect(action!.createdAt).toBeLessThanOrEqual(after);
  });

  test("extra fields (channel, spaceName, agentName) stored correctly", () => {
    const id = BASE_ID + "-3";
    storePendingAction(id, "gchat action", "session-gchat", 0, 0, {
      channel: "google-chat",
      spaceName: "spaces/abc123",
      agentName: "dev-agent",
    });
    const action = getPendingAction(id);
    expect(action!.channel).toBe("google-chat");
    expect(action!.spaceName).toBe("spaces/abc123");
    expect(action!.agentName).toBe("dev-agent");
  });

  test("sessionId can be null", () => {
    const id = BASE_ID + "-4";
    storePendingAction(id, "no session", null, 1, 1);
    expect(getPendingAction(id)!.sessionId).toBeNull();
  });

  test("getPendingAction returns undefined for unknown id", () => {
    expect(getPendingAction("completely-unknown-id-xyz")).toBeUndefined();
  });

  test("removePendingAction clears the entry", () => {
    const id = BASE_ID + "-5";
    storePendingAction(id, "to be removed", null, 1, 1);
    expect(getPendingAction(id)).toBeDefined();
    removePendingAction(id);
    expect(getPendingAction(id)).toBeUndefined();
  });

  test("removePendingAction on unknown id is a no-op (no throw)", () => {
    expect(() => removePendingAction("non-existent-id")).not.toThrow();
  });

  test("two distinct ids stored independently", () => {
    const id1 = BASE_ID + "-6a";
    const id2 = BASE_ID + "-6b";
    storePendingAction(id1, "action one", null, 1, 1);
    storePendingAction(id2, "action two", null, 2, 2);
    expect(getPendingAction(id1)!.description).toBe("action one");
    expect(getPendingAction(id2)!.description).toBe("action two");
    removePendingAction(id1);
    expect(getPendingAction(id1)).toBeUndefined();
    expect(getPendingAction(id2)).toBeDefined(); // id2 untouched
  });
});
