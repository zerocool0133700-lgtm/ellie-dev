/**
 * ELLIE-824, ELLIE-825, ELLIE-827, ELLIE-829: Grove spaces tests
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  GROVE_SPACES,
  getGroveAccess,
  getAgentGroveMatrix,
  getWriters,
  canWriteGroveSpace,
  canReadGroveSpace,
  type GroveSpace,
} from "../src/grove-spaces.ts";

// ── ELLIE-824: Grove structure ───────────────────────────────────

describe("ELLIE-824: Grove collaborative spaces", () => {
  it("defines all expected grove spaces", () => {
    expect(GROVE_SPACES).toContain("requirements");
    expect(GROVE_SPACES).toContain("codebase");
    expect(GROVE_SPACES).toContain("design-specs");
    expect(GROVE_SPACES).toContain("reviews");
    expect(GROVE_SPACES).toContain("risk-registry");
    expect(GROVE_SPACES).toContain("test-results");
    expect(GROVE_SPACES).toContain("handoffs");
    expect(GROVE_SPACES).toContain("work-trails");
    expect(GROVE_SPACES.length).toBeGreaterThanOrEqual(10);
  });
});

// ── ELLIE-825: Per-role access matrix ────────────────────────────

describe("ELLIE-825: Grove RBAC policies", () => {
  describe("research agent (Kate)", () => {
    it("can write to requirements", () => {
      expect(getGroveAccess("research", "requirements")).toBe("write");
    });

    it("can write to client-context", () => {
      expect(getGroveAccess("research", "client-context")).toBe("write");
    });

    it("can write to handoffs", () => {
      expect(getGroveAccess("research", "handoffs")).toBe("write");
    });

    it("can read codebase (read-only)", () => {
      expect(getGroveAccess("research", "codebase")).toBe("read");
    });

    it("cannot write to reviews", () => {
      expect(canWriteGroveSpace("research", "reviews")).toBe(false);
    });
  });

  describe("dev agent (James)", () => {
    it("can write to codebase", () => {
      expect(getGroveAccess("dev", "codebase")).toBe("write");
    });

    it("can write to work-trails", () => {
      expect(getGroveAccess("dev", "work-trails")).toBe("write");
    });

    it("can write to technical-debt", () => {
      expect(getGroveAccess("dev", "technical-debt")).toBe("write");
    });

    it("can read requirements (read-only)", () => {
      expect(getGroveAccess("dev", "requirements")).toBe("read");
    });
  });

  describe("critic agent (Brian)", () => {
    it("can write to reviews", () => {
      expect(getGroveAccess("critic", "reviews")).toBe("write");
    });

    it("can write to risk-registry", () => {
      expect(getGroveAccess("critic", "risk-registry")).toBe("write");
    });

    it("can write to post-mortems", () => {
      expect(getGroveAccess("critic", "post-mortems")).toBe("write");
    });
  });

  describe("getAgentGroveMatrix", () => {
    it("returns access rules for all grove spaces", () => {
      const matrix = getAgentGroveMatrix("dev");
      expect(matrix.length).toBe(GROVE_SPACES.length);
      expect(matrix.every(r => r.agent === "dev")).toBe(true);
    });
  });

  describe("getWriters", () => {
    it("returns all agents who can write to codebase", () => {
      const writers = getWriters("codebase");
      expect(writers).toContain("dev");
      expect(writers).toContain("ops");
      expect(writers).not.toContain("research");
    });

    it("returns all agents who can write to requirements", () => {
      const writers = getWriters("requirements");
      expect(writers).toContain("research");
      expect(writers).toContain("strategy");
    });
  });
});

// ── ELLIE-827: Critic broad-read ─────────────────────────────────

describe("ELLIE-827: Critic broad-read access", () => {
  it("critic can read every grove space", () => {
    for (const space of GROVE_SPACES) {
      expect(canReadGroveSpace("critic", space)).toBe(true);
    }
  });

  it("critic can only write to reviews, risk-registry, post-mortems", () => {
    const writeableSpaces: GroveSpace[] = ["reviews", "risk-registry", "post-mortems"];
    for (const space of GROVE_SPACES) {
      if (writeableSpaces.includes(space)) {
        expect(canWriteGroveSpace("critic", space)).toBe(true);
      } else {
        expect(canWriteGroveSpace("critic", space)).toBe(false);
      }
    }
  });

  it("other agents also have read access (default)", () => {
    for (const space of GROVE_SPACES) {
      expect(canReadGroveSpace("dev", space)).toBe(true);
      expect(canReadGroveSpace("research", space)).toBe(true);
    }
  });
});

// ── ELLIE-830: Access lifecycle integration ──────────────────────

describe("ELLIE-830: Access lifecycle scenarios", () => {
  it("private write: agent writes to own River workspace — succeeds (via RBAC)", async () => {
    // canAccessRiverPath is tested in river-workspace.test.ts
    // This validates the rule: owner always has full access
    const { canAccessRiverPath } = await import("../src/river-workspace.ts");
    const access = await canAccessRiverPath("dev", "river/dev/scratch/test.md");
    expect(access.write).toBe(true);
  });

  it("cross-agent denied: agent tries to read another's River — denied", async () => {
    const { canAccessRiverPath } = await import("../src/river-workspace.ts");
    const access = await canAccessRiverPath("research", "river/dev/scratch/test.md");
    expect(access.read).toBe(false);
  });

  it("publish to authorized grove — dev can write to codebase", () => {
    expect(canWriteGroveSpace("dev", "codebase")).toBe(true);
  });

  it("unauthorized publish — research cannot write to codebase", () => {
    expect(canWriteGroveSpace("research", "codebase")).toBe(false);
  });

  it("collaborative read — all agents can read all grove spaces", () => {
    for (const agent of ["dev", "research", "critic", "content", "strategy", "finance"]) {
      for (const space of GROVE_SPACES) {
        expect(canReadGroveSpace(agent, space)).toBe(true);
      }
    }
  });

  it("broad-read critic — Brian reads everything, writes only reviews", () => {
    expect(canReadGroveSpace("critic", "codebase")).toBe(true);
    expect(canReadGroveSpace("critic", "requirements")).toBe(true);
    expect(canReadGroveSpace("critic", "test-results")).toBe(true);
    expect(canWriteGroveSpace("critic", "reviews")).toBe(true);
    expect(canWriteGroveSpace("critic", "codebase")).toBe(false);
  });
});
