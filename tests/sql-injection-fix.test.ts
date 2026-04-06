import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";

/**
 * ELLIE-801: Verify no sql.unsafe() with user input remains
 * in permission and capture modules.
 */

const permApi = readFileSync("/home/ellie/ellie-dev/src/permission-api.ts", "utf-8");
const permAudit = readFileSync("/home/ellie/ellie-dev/src/permission-audit.ts", "utf-8");
const captureQueue = readFileSync("/home/ellie/ellie-dev/src/capture-queue.ts", "utf-8");

describe("ELLIE-801: SQL injection fix", () => {
  describe("permission-api.ts", () => {
    it("has no sql.unsafe() calls", () => {
      expect(permApi).not.toContain("sql.unsafe");
    });

    it("updateEntity uses parameterized queries", () => {
      expect(permApi).toContain("sql`UPDATE rbac_entities SET name = ${input.name}");
    });

    it("does not concatenate user input into SQL strings", () => {
      // No pattern like `'${input.` or `'${entityId}'` in raw SQL
      const unsafePattern = /`[^`]*'\$\{input\./;
      expect(unsafePattern.test(permApi)).toBe(false);
    });
  });

  describe("permission-audit.ts", () => {
    it("has no sql.unsafe() calls", () => {
      expect(permAudit).not.toContain("sql.unsafe");
    });

    it("queryAuditLog uses parameterized queries", () => {
      expect(permAudit).toContain("${entityId}::uuid");
      expect(permAudit).toContain("${resource}");
      expect(permAudit).toContain("${result}");
    });
  });

  describe("capture-queue.ts", () => {
    it("has no sql.unsafe() calls", () => {
      expect(captureQueue).not.toContain("sql.unsafe");
    });

    it("listQueue uses parameterized queries", () => {
      expect(captureQueue).toContain("${status}::text IS NULL");
      expect(captureQueue).toContain("${channel}::text IS NULL");
    });

    it("updateCapture uses parameterized queries", () => {
      expect(captureQueue).toContain("COALESCE(${input.refined_content");
    });
  });
});
