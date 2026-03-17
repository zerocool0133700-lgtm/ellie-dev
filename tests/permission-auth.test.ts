import { describe, it, expect } from "bun:test";
import {
  isPermissionAdmin,
  guardPermissionWritePure,
  resolveCallerEntity,
  guardPermissionWrite,
  type EntityType,
} from "../src/permission-auth.ts";

function mockSql(returnValue: any = []) {
  const calls: any[] = [];
  const fn: any = function (...args: any[]) {
    calls.push(args);
    return Promise.resolve(returnValue);
  };
  fn.calls = calls;
  return fn;
}

describe("ELLIE-802: Permission API authentication", () => {
  describe("isPermissionAdmin", () => {
    it("allows super_user", () => {
      expect(isPermissionAdmin("super_user" as EntityType)).toBe(true);
    });

    it("allows super_agent", () => {
      expect(isPermissionAdmin("super_agent")).toBe(true);
    });

    it("denies agent", () => {
      expect(isPermissionAdmin("agent")).toBe(false);
    });

    it("allows user (Dave is admin via entity_type)", () => {
      expect(isPermissionAdmin("user")).toBe(true);
    });
  });

  describe("guardPermissionWritePure", () => {
    it("allows super_user", () => {
      const result = guardPermissionWritePure("super_user" as EntityType);
      expect(result.authorized).toBe(true);
      expect(result.status_code).toBe(200);
    });

    it("allows super_agent", () => {
      const result = guardPermissionWritePure("super_agent");
      expect(result.authorized).toBe(true);
    });

    it("denies agent with 403", () => {
      const result = guardPermissionWritePure("agent");
      expect(result.authorized).toBe(false);
      expect(result.status_code).toBe(403);
      expect(result.error).toContain("not authorized");
    });

    it("allows user (Dave is admin)", () => {
      const result = guardPermissionWritePure("user");
      expect(result.authorized).toBe(true);
      expect(result.status_code).toBe(200);
    });

    it("denies null with 401", () => {
      const result = guardPermissionWritePure(null);
      expect(result.authorized).toBe(false);
      expect(result.status_code).toBe(401);
    });
  });

  describe("resolveCallerEntity", () => {
    it("resolves by x-entity-id header", async () => {
      const sql = mockSql([{ id: "e1", entity_type: "super_agent", name: "Ellie" }]);
      const result = await resolveCallerEntity(sql, { "x-entity-id": "e1" });
      expect(result.authorized).toBe(true);
      expect(result.entity_id).toBe("e1");
      expect(result.entity_type).toBe("super_agent");
    });

    it("resolves by x-bridge-key header", async () => {
      const sql = mockSql([{ id: "e2", entity_type: "agent", name: "James" }]);
      const result = await resolveCallerEntity(sql, { "x-bridge-key": "bk_test" });
      expect(result.authorized).toBe(true);
      expect(result.entity_id).toBe("e2");
    });

    it("returns 401 for unknown entity ID", async () => {
      const sql = mockSql([]);
      const result = await resolveCallerEntity(sql, { "x-entity-id": "unknown" });
      expect(result.authorized).toBe(false);
      expect(result.status_code).toBe(401);
    });

    it("returns 401 for invalid bridge key", async () => {
      const sql = mockSql([]);
      const result = await resolveCallerEntity(sql, { "x-bridge-key": "invalid" });
      expect(result.authorized).toBe(false);
      expect(result.status_code).toBe(401);
    });

    it("returns 401 when no auth headers provided", async () => {
      const sql = mockSql();
      const result = await resolveCallerEntity(sql, {});
      expect(result.authorized).toBe(false);
      expect(result.status_code).toBe(401);
      expect(result.error).toContain("No authentication");
    });
  });

  describe("guardPermissionWrite (full flow)", () => {
    it("allows super_agent caller", async () => {
      const sql = mockSql([{ id: "e1", entity_type: "super_agent", name: "Ellie" }]);
      const result = await guardPermissionWrite(sql, { "x-entity-id": "e1" });
      expect(result.authorized).toBe(true);
    });

    it("denies agent caller with 403", async () => {
      const sql = mockSql([{ id: "e2", entity_type: "agent", name: "James" }]);
      const result = await guardPermissionWrite(sql, { "x-entity-id": "e2" });
      expect(result.authorized).toBe(false);
      expect(result.status_code).toBe(403);
      expect(result.error).toContain("agent");
    });

    it("denies unauthenticated with 401", async () => {
      const sql = mockSql();
      const result = await guardPermissionWrite(sql, {});
      expect(result.authorized).toBe(false);
      expect(result.status_code).toBe(401);
    });

    it("denies unknown entity with 401", async () => {
      const sql = mockSql([]);
      const result = await guardPermissionWrite(sql, { "x-entity-id": "nonexistent" });
      expect(result.authorized).toBe(false);
      expect(result.status_code).toBe(401);
    });
  });
});
