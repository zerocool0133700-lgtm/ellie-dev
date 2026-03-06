/**
 * ELLIE-564 — Dispatch Verifier Tests
 *
 * Tests the pure verification functions (file checks, commit checks,
 * discrepancy detection, content building) and the effectful verifyDispatch
 * with mocked dependencies.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mock dependencies before import ──────────────────────────────────────────

let _appendCalls: Array<{ workItemId: string; content: string }> = [];

mock.module("../src/work-trail-writer.ts", () => ({
  appendWorkTrailProgress: mock(async (workItemId: string, content: string) => {
    _appendCalls.push({ workItemId, content });
    return true;
  }),
  writeWorkTrailStart: mock(async () => true),
  buildWorkTrailUpdateAppend: mock((msg: string) => `\n### Update\n\n${msg}\n`),
  buildWorkTrailCompleteAppend: mock((msg: string) => `\n## Completion\n\n${msg}\n`),
}));

mock.module("../src/plane.ts", () => ({
  resolveWorkItemId: mock(async (workItemId: string) => {
    if (workItemId === "ELLIE-NORESOLVE") return null;
    return { projectId: "proj-123", issueId: "issue-456" };
  }),
  getIssueStateGroup: mock(async (_projectId: string, _issueId: string) => {
    return _mockPlaneState;
  }),
  updateWorkItemOnSessionStart: mock(async () => {}),
  updateWorkItemOnSessionComplete: mock(async () => {}),
}));

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

import {
  checkFiles,
  checkCommits,
  expectedPlaneState,
  findDiscrepancies,
  buildVerificationContent,
  verifyDispatch,
  type FileCheck,
  type CommitCheck,
  type PlaneCheck,
  type VerificationResult,
} from "../src/dispatch-verifier";

// ── Mutable test state ──────────────────────────────────────────────────────

let _mockPlaneState: string | null = "completed";

beforeEach(() => {
  _appendCalls = [];
  _mockPlaneState = "completed";
});

// ── checkFiles ──────────────────────────────────────────────────────────────

describe("checkFiles", () => {
  test("returns exists=true with mtime for files that exist", () => {
    const now = Date.now();
    const statFn = (path: string) => {
      if (path === "/home/ellie/ellie-dev/src/foo.ts") {
        return { mtimeMs: now - 5 * 60_000 }; // 5 min ago
      }
      return null;
    };

    const results = checkFiles(
      ["/home/ellie/ellie-dev/src/foo.ts"],
      statFn,
    );

    expect(results).toHaveLength(1);
    expect(results[0].exists).toBe(true);
    expect(results[0].modifiedWithinMinutes).toBe(5);
  });

  test("returns exists=false for missing files", () => {
    const statFn = () => null;

    const results = checkFiles(
      ["/home/ellie/ellie-dev/src/nonexistent.ts"],
      statFn,
    );

    expect(results).toHaveLength(1);
    expect(results[0].exists).toBe(false);
    expect(results[0].modifiedWithinMinutes).toBeUndefined();
  });

  test("handles multiple files with mixed results", () => {
    const now = Date.now();
    const statFn = (path: string) => {
      if (path.includes("exists")) return { mtimeMs: now - 60_000 };
      return null;
    };

    const results = checkFiles(
      ["/exists.ts", "/missing.ts", "/also-exists.ts"],
      (p) => (p.includes("missing") ? null : statFn(p)),
    );

    expect(results).toHaveLength(3);
    expect(results[0].exists).toBe(true);
    expect(results[1].exists).toBe(false);
    expect(results[2].exists).toBe(true);
  });

  test("returns empty array for empty input", () => {
    const results = checkFiles([], () => null);
    expect(results).toHaveLength(0);
  });
});

// ── checkCommits ────────────────────────────────────────────────────────────

describe("checkCommits", () => {
  test("finds commits with matching prefix", () => {
    const execFn = () =>
      "abc1234 [ELLIE-564] Add dispatch verifier\ndef5678 [ELLIE-562] Fix logging\n";

    const result = checkCommits("[ELLIE-564]", "/repo", execFn);

    expect(result.found).toBe(true);
    expect(result.prefix).toBe("[ELLIE-564]");
    expect(result.recentCommits).toHaveLength(2);
  });

  test("returns found=false when no matching prefix", () => {
    const execFn = () =>
      "abc1234 [ELLIE-500] Unrelated work\ndef5678 Fix typo\n";

    const result = checkCommits("[ELLIE-564]", "/repo", execFn);

    expect(result.found).toBe(false);
    expect(result.recentCommits).toHaveLength(2);
  });

  test("returns found=false on exec error", () => {
    const execFn = () => {
      throw new Error("git not found");
    };

    const result = checkCommits("[ELLIE-564]", "/repo", execFn);

    expect(result.found).toBe(false);
    expect(result.recentCommits).toHaveLength(0);
  });

  test("limits recent commits to 5", () => {
    const lines = Array.from(
      { length: 20 },
      (_, i) => `hash${i} Commit ${i}`,
    ).join("\n");
    const execFn = () => lines;

    const result = checkCommits("[X]", "/repo", execFn);

    expect(result.recentCommits).toHaveLength(5);
  });

  test("handles empty git log", () => {
    const execFn = () => "";

    const result = checkCommits("[ELLIE-564]", "/repo", execFn);

    expect(result.found).toBe(false);
    expect(result.recentCommits).toHaveLength(0);
  });
});

// ── expectedPlaneState ──────────────────────────────────────────────────────

describe("expectedPlaneState", () => {
  test("returns 'completed' for success outcome", () => {
    expect(expectedPlaneState("success")).toBe("completed");
  });

  test("returns null for timeout outcome", () => {
    expect(expectedPlaneState("timeout")).toBeNull();
  });

  test("returns null for failure outcome", () => {
    expect(expectedPlaneState("failure")).toBeNull();
  });
});

// ── findDiscrepancies ───────────────────────────────────────────────────────

describe("findDiscrepancies", () => {
  test("returns empty array when everything checks out", () => {
    const fileChecks: FileCheck[] = [
      { path: "src/foo.ts", exists: true, modifiedWithinMinutes: 2 },
    ];
    const commitCheck: CommitCheck = {
      prefix: "[ELLIE-564]",
      found: true,
      recentCommits: ["abc [ELLIE-564] Done"],
    };
    const planeCheck: PlaneCheck = {
      workItemId: "ELLIE-564",
      currentState: "completed",
      expectedState: "completed",
      matches: true,
    };

    const issues = findDiscrepancies("success", fileChecks, commitCheck, planeCheck);
    expect(issues).toHaveLength(0);
  });

  test("flags missing files", () => {
    const fileChecks: FileCheck[] = [
      { path: "src/foo.ts", exists: false },
      { path: "src/bar.ts", exists: true, modifiedWithinMinutes: 1 },
    ];

    const issues = findDiscrepancies("success", fileChecks, null, null);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("File missing: src/foo.ts");
  });

  test("flags missing commits on success outcome", () => {
    const commitCheck: CommitCheck = {
      prefix: "[ELLIE-564]",
      found: false,
      recentCommits: ["abc Fix typo"],
    };

    const issues = findDiscrepancies("success", [], commitCheck, null);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('No commits found with prefix "[ELLIE-564]"');
  });

  test("does NOT flag missing commits on timeout/failure", () => {
    const commitCheck: CommitCheck = {
      prefix: "[ELLIE-564]",
      found: false,
      recentCommits: [],
    };

    const issues = findDiscrepancies("timeout", [], commitCheck, null);
    expect(issues).toHaveLength(0);

    const issues2 = findDiscrepancies("failure", [], commitCheck, null);
    expect(issues2).toHaveLength(0);
  });

  test("flags Plane state mismatch", () => {
    const planeCheck: PlaneCheck = {
      workItemId: "ELLIE-564",
      currentState: "started",
      expectedState: "completed",
      matches: false,
    };

    const issues = findDiscrepancies("success", [], null, planeCheck);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("Plane state mismatch");
    expect(issues[0]).toContain("expected \"completed\"");
    expect(issues[0]).toContain("got \"started\"");
  });

  test("does not flag Plane when expectedState is null", () => {
    const planeCheck: PlaneCheck = {
      workItemId: "ELLIE-564",
      currentState: "started",
      expectedState: null,
      matches: true,
    };

    const issues = findDiscrepancies("timeout", [], null, planeCheck);
    expect(issues).toHaveLength(0);
  });

  test("accumulates multiple discrepancies", () => {
    const fileChecks: FileCheck[] = [
      { path: "a.ts", exists: false },
      { path: "b.ts", exists: false },
    ];
    const commitCheck: CommitCheck = {
      prefix: "[ELLIE-564]",
      found: false,
      recentCommits: [],
    };
    const planeCheck: PlaneCheck = {
      workItemId: "ELLIE-564",
      currentState: "started",
      expectedState: "completed",
      matches: false,
    };

    const issues = findDiscrepancies("success", fileChecks, commitCheck, planeCheck);
    expect(issues).toHaveLength(4); // 2 files + 1 commit + 1 plane
  });
});

// ── buildVerificationContent ────────────────────────────────────────────────

describe("buildVerificationContent", () => {
  test("builds markdown with all sections", () => {
    const result: VerificationResult = {
      workItemId: "ELLIE-564",
      agent: "dev",
      outcome: "success",
      timestamp: "2026-03-05T12:00:00Z",
      verified: true,
      fileChecks: [
        { path: "src/foo.ts", exists: true, modifiedWithinMinutes: 3 },
      ],
      commitCheck: {
        prefix: "[ELLIE-564]",
        found: true,
        recentCommits: ["abc [ELLIE-564] Added verifier"],
      },
      planeCheck: {
        workItemId: "ELLIE-564",
        currentState: "completed",
        expectedState: "completed",
        matches: true,
      },
      discrepancies: [],
    };

    const content = buildVerificationContent(result);

    expect(content).toContain("### Verification");
    expect(content).toContain("**Outcome:** success");
    expect(content).toContain("**Verified:** PASS");
    expect(content).toContain("**Agent:** dev");
    expect(content).toContain("`src/foo.ts`: exists");
    expect(content).toContain("prefix `[ELLIE-564]` — found");
    expect(content).toContain("**Plane State:**");
    expect(content).not.toContain("**Discrepancies:**");
  });

  test("shows FAIL and discrepancies when verification fails", () => {
    const result: VerificationResult = {
      workItemId: "ELLIE-564",
      outcome: "success",
      timestamp: "2026-03-05T12:00:00Z",
      verified: false,
      fileChecks: [{ path: "src/missing.ts", exists: false }],
      commitCheck: null,
      planeCheck: null,
      discrepancies: ["File missing: src/missing.ts"],
    };

    const content = buildVerificationContent(result);

    expect(content).toContain("**Verified:** FAIL");
    expect(content).toContain("**Discrepancies:**");
    expect(content).toContain("File missing: src/missing.ts");
    expect(content).toContain("`src/missing.ts`: MISSING");
  });

  test("omits agent line when agent is undefined", () => {
    const result: VerificationResult = {
      workItemId: "ELLIE-564",
      outcome: "timeout",
      timestamp: "2026-03-05T12:00:00Z",
      verified: true,
      fileChecks: [],
      commitCheck: null,
      planeCheck: null,
      discrepancies: [],
    };

    const content = buildVerificationContent(result);

    expect(content).not.toContain("**Agent:**");
  });

  test("handles empty file checks and commit checks", () => {
    const result: VerificationResult = {
      workItemId: "ELLIE-564",
      outcome: "failure",
      timestamp: "2026-03-05T12:00:00Z",
      verified: true,
      fileChecks: [],
      commitCheck: null,
      planeCheck: null,
      discrepancies: [],
    };

    const content = buildVerificationContent(result);

    expect(content).toContain("### Verification");
    expect(content).toContain("**Outcome:** failure");
    expect(content).not.toContain("**File Checks:**");
    expect(content).not.toContain("**Commit Check:**");
  });
});

// ── repo path resolution (ELLIE-582) ────────────────────────────────────────

describe("repo path resolution (ELLIE-582)", () => {
  test("opts.repo overrides everything", async () => {
    const result = await verifyDispatch({
      workItemId: "ELLIE-582",
      outcome: "timeout",
      repo: "/custom/repo",
    });

    expect(result).not.toBeNull();
    // commitCheck should exist (uses /custom/repo as cwd for git)
    expect(result!.commitCheck).not.toBeNull();
    expect(result!.commitCheck!.prefix).toBe("[ELLIE-582]");
  });

  test("falls back to ELLIE_DEV_PATH env var when opts.repo not set", async () => {
    const original = process.env.ELLIE_DEV_PATH;
    try {
      process.env.ELLIE_DEV_PATH = "/env/repo/path";

      const result = await verifyDispatch({
        workItemId: "ELLIE-582",
        outcome: "timeout",
      });

      expect(result).not.toBeNull();
      expect(result!.commitCheck).not.toBeNull();
    } finally {
      if (original !== undefined) {
        process.env.ELLIE_DEV_PATH = original;
      } else {
        delete process.env.ELLIE_DEV_PATH;
      }
    }
  });

  test("falls back to process.cwd() when neither opts.repo nor env var set", async () => {
    const original = process.env.ELLIE_DEV_PATH;
    try {
      delete process.env.ELLIE_DEV_PATH;

      const result = await verifyDispatch({
        workItemId: "ELLIE-582",
        outcome: "timeout",
      });

      expect(result).not.toBeNull();
      expect(result!.commitCheck).not.toBeNull();
    } finally {
      if (original !== undefined) {
        process.env.ELLIE_DEV_PATH = original;
      } else {
        delete process.env.ELLIE_DEV_PATH;
      }
    }
  });

  test("no longer contains hardcoded /home/ellie/ellie-dev path", async () => {
    // Read the source file and verify the hardcoded path is gone
    const { readFileSync } = await import("fs");
    const source = readFileSync(
      new URL("../src/dispatch-verifier.ts", import.meta.url),
      "utf-8",
    );
    // The fallback line should NOT contain the hardcoded path
    expect(source).not.toContain('?? "/home/ellie/ellie-dev"');
    // It should contain the env var fallback
    expect(source).toContain("process.env.ELLIE_DEV_PATH");
    expect(source).toContain("process.cwd()");
  });
});

// ── verifyDispatch (effectful, mocked deps) ─────────────────────────────────

describe("verifyDispatch", () => {
  test("runs full verification and writes to River", async () => {
    _mockPlaneState = "completed";

    const result = await verifyDispatch({
      workItemId: "ELLIE-564",
      agent: "dev",
      outcome: "success",
      summary: "Added dispatch verifier",
    });

    expect(result).not.toBeNull();
    expect(result!.workItemId).toBe("ELLIE-564");
    expect(result!.outcome).toBe("success");
    expect(result!.planeCheck).not.toBeNull();
    expect(result!.planeCheck!.matches).toBe(true);

    // Should have appended to work trail
    expect(_appendCalls).toHaveLength(1);
    expect(_appendCalls[0].workItemId).toBe("ELLIE-564");
    expect(_appendCalls[0].content).toContain("### Verification");
  });

  test("detects Plane state mismatch", async () => {
    _mockPlaneState = "started"; // Not "completed" as expected for success

    const result = await verifyDispatch({
      workItemId: "ELLIE-564",
      outcome: "success",
    });

    expect(result).not.toBeNull();
    expect(result!.verified).toBe(false);
    expect(result!.discrepancies.length).toBeGreaterThan(0);
    expect(result!.discrepancies.some((d) => d.includes("Plane state mismatch"))).toBe(
      true,
    );
  });

  test("handles unresolvable work item gracefully", async () => {
    const result = await verifyDispatch({
      workItemId: "ELLIE-NORESOLVE",
      outcome: "success",
    });

    expect(result).not.toBeNull();
    // Plane check should be null when can't resolve
    expect(result!.planeCheck).toBeNull();
  });

  test("uses default commit prefix from work item ID", async () => {
    const result = await verifyDispatch({
      workItemId: "ELLIE-564",
      outcome: "timeout",
    });

    expect(result).not.toBeNull();
    expect(result!.commitCheck).not.toBeNull();
    expect(result!.commitCheck!.prefix).toBe("[ELLIE-564]");
  });

  test("timeout outcome does not require completed Plane state", async () => {
    _mockPlaneState = "started";

    const result = await verifyDispatch({
      workItemId: "ELLIE-564",
      outcome: "timeout",
    });

    expect(result).not.toBeNull();
    // Plane check should match because expectedState is null for timeout
    if (result!.planeCheck) {
      expect(result!.planeCheck.expectedState).toBeNull();
      expect(result!.planeCheck.matches).toBe(true);
    }
  });

  test("failure outcome does not flag missing commits", async () => {
    _mockPlaneState = "started";

    const result = await verifyDispatch({
      workItemId: "ELLIE-564",
      outcome: "failure",
    });

    expect(result).not.toBeNull();
    // No discrepancies about commits for failure
    const commitDisc = result!.discrepancies.filter((d) =>
      d.includes("No commits found"),
    );
    expect(commitDisc).toHaveLength(0);
  });

  test("writes verification content to work trail", async () => {
    await verifyDispatch({
      workItemId: "ELLIE-999",
      agent: "dev",
      outcome: "success",
      summary: "Test verification",
    });

    expect(_appendCalls).toHaveLength(1);
    expect(_appendCalls[0].workItemId).toBe("ELLIE-999");
    const content = _appendCalls[0].content;
    expect(content).toContain("**Outcome:** success");
    expect(content).toContain("**Agent:** dev");
  });
});
