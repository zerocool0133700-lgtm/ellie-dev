import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  resolveAgentEntityId,
  resolvePersonId,
  getAgentGroves,
  getAgentGroveAccess,
  canAgentReadScope,
  canAgentWriteScope,
  createFormationGrove,
  getFormationGrove,
} from "../src/forest-grove.ts";

// These tests require the Forest DB with ELLIE-818 migrations applied.
// They test against real data seeded by the migrations.

const JAMES_ENTITY = "e0000000-0000-0000-0000-000000000003";
const BRIAN_ENTITY = "e0000000-0000-0000-0000-000000000004";
const JAMES_PERSON = "e0000000-0000-0000-0000-000000000003";
const BRIAN_PERSON = "e0000000-0000-0000-0000-000000000004";

describe("ELLIE-818: Forest Grove Integration", () => {
  describe("resolveAgentEntityId", () => {
    it("resolves James (dev) entity ID", async () => {
      const id = await resolveAgentEntityId("dev");
      expect(id).toBe(JAMES_ENTITY);
    });

    it("resolves Brian (critic) entity ID", async () => {
      const id = await resolveAgentEntityId("critic");
      expect(id).toBe(BRIAN_ENTITY);
    });

    it("returns null for unknown agent", async () => {
      const id = await resolveAgentEntityId("nonexistent-agent");
      expect(id).toBeNull();
    });
  });

  describe("resolvePersonId", () => {
    it("resolves James person ID from entity ID", async () => {
      const id = await resolvePersonId(JAMES_ENTITY);
      expect(id).toBe(JAMES_PERSON);
    });

    it("resolves Brian person ID from entity ID", async () => {
      const id = await resolvePersonId(BRIAN_ENTITY);
      expect(id).toBe(BRIAN_PERSON);
    });

    it("returns null for nonexistent entity", async () => {
      const id = await resolvePersonId("00000000-0000-0000-0000-000000000099");
      expect(id).toBeNull();
    });
  });

  describe("getAgentGroves", () => {
    it("James belongs to ellie-org, ellie-dev-grove, and ellie-forest-grove", async () => {
      const groves = await getAgentGroves(JAMES_ENTITY);
      const names = groves.map(g => g.group_name).sort();
      expect(names).toContain("ellie-org");
      expect(names).toContain("ellie-dev-grove");
      expect(names).toContain("ellie-forest-grove");
    });

    it("Brian belongs to ellie-org and ellie-dev-grove", async () => {
      const groves = await getAgentGroves(BRIAN_ENTITY);
      const names = groves.map(g => g.group_name).sort();
      expect(names).toContain("ellie-org");
      expect(names).toContain("ellie-dev-grove");
    });

    it("James has write access to ellie-org", async () => {
      const groves = await getAgentGroves(JAMES_ENTITY);
      const org = groves.find(g => g.group_name === "ellie-org");
      expect(org?.access_level).toBe("write");
    });

    it("Brian has read access to ellie-org", async () => {
      const groves = await getAgentGroves(BRIAN_ENTITY);
      const org = groves.find(g => g.group_name === "ellie-org");
      expect(org?.access_level).toBe("read");
    });
  });

  describe("getAgentGroveAccess", () => {
    it("returns full access info for James", async () => {
      const access = await getAgentGroveAccess("dev");
      expect(access).not.toBeNull();
      expect(access!.entity_id).toBe(JAMES_ENTITY);
      expect(access!.agent_name).toBe("dev");
      expect(access!.personal_scope).toBe("3/james");
      expect(access!.groves.length).toBeGreaterThanOrEqual(2);
    });

    it("returns full access info for Brian", async () => {
      const access = await getAgentGroveAccess("critic");
      expect(access).not.toBeNull();
      expect(access!.entity_id).toBe(BRIAN_ENTITY);
      expect(access!.personal_scope).toBe("3/brian");
    });

    it("returns null for unknown agent", async () => {
      const access = await getAgentGroveAccess("nonexistent");
      expect(access).toBeNull();
    });
  });

  describe("canAgentReadScope", () => {
    it("James can read his own personal scope", async () => {
      expect(await canAgentReadScope(JAMES_ENTITY, "3/james")).toBe(true);
    });

    it("Brian can read his own personal scope", async () => {
      expect(await canAgentReadScope(BRIAN_ENTITY, "3/brian")).toBe(true);
    });

    it("James CANNOT read Brian's personal scope", async () => {
      expect(await canAgentReadScope(JAMES_ENTITY, "3/brian")).toBe(false);
    });

    it("Brian CANNOT read James's personal scope", async () => {
      expect(await canAgentReadScope(BRIAN_ENTITY, "3/james")).toBe(false);
    });

    it("James can read ellie-org grove scope", async () => {
      expect(await canAgentReadScope(JAMES_ENTITY, "3/org")).toBe(true);
    });

    it("Brian can read ellie-org grove scope", async () => {
      expect(await canAgentReadScope(BRIAN_ENTITY, "3/org")).toBe(true);
    });

    it("James can read ellie-dev project scope (2/1)", async () => {
      expect(await canAgentReadScope(JAMES_ENTITY, "2/1")).toBe(true);
    });

    it("Brian can read ellie-dev project scope (2/1)", async () => {
      expect(await canAgentReadScope(BRIAN_ENTITY, "2/1")).toBe(true);
    });

    it("James can read ellie-dev sub-scope (2/1/1)", async () => {
      expect(await canAgentReadScope(JAMES_ENTITY, "2/1/1")).toBe(true);
    });
  });

  describe("canAgentWriteScope", () => {
    it("James can write to his own personal scope", async () => {
      expect(await canAgentWriteScope(JAMES_ENTITY, "3/james")).toBe(true);
    });

    it("Brian can write to his own personal scope", async () => {
      expect(await canAgentWriteScope(BRIAN_ENTITY, "3/brian")).toBe(true);
    });

    it("James CANNOT write to Brian's personal scope", async () => {
      expect(await canAgentWriteScope(JAMES_ENTITY, "3/brian")).toBe(false);
    });

    it("Brian CANNOT write to James's personal scope", async () => {
      expect(await canAgentWriteScope(BRIAN_ENTITY, "3/james")).toBe(false);
    });

    it("James CAN write to ellie-org (has write access)", async () => {
      expect(await canAgentWriteScope(JAMES_ENTITY, "3/org")).toBe(true);
    });

    it("Brian CANNOT write to ellie-org (has read access only)", async () => {
      expect(await canAgentWriteScope(BRIAN_ENTITY, "3/org")).toBe(false);
    });

    it("James CAN write to ellie-dev scope (write member)", async () => {
      expect(await canAgentWriteScope(JAMES_ENTITY, "2/1")).toBe(true);
    });

    it("Brian CANNOT write to ellie-dev scope (read member)", async () => {
      expect(await canAgentWriteScope(BRIAN_ENTITY, "2/1")).toBe(false);
    });
  });

  describe("Formation grove management", () => {
    const testFormation = "test-formation";
    const testSession = "test-session-" + Date.now();

    it("creates a formation grove with participating agents", async () => {
      const grove = await createFormationGrove(testFormation, testSession, ["dev", "critic"]);
      expect(grove).not.toBeNull();
      expect(grove!.name).toContain("formation-test-formation");
      expect(grove!.scope_path).toContain("2/formations/test-formation");
    });

    it("looks up existing formation grove", async () => {
      const grove = await getFormationGrove(testFormation, testSession);
      expect(grove).not.toBeNull();
      expect(grove!.name).toContain("formation-test-formation");
    });

    it("formation grove members can read the grove scope", async () => {
      const grove = await getFormationGrove(testFormation, testSession);
      if (!grove?.scope_path) throw new Error("No grove scope");

      // Both James and Brian should be members and able to read
      expect(await canAgentReadScope(JAMES_ENTITY, grove.scope_path)).toBe(true);
      expect(await canAgentReadScope(BRIAN_ENTITY, grove.scope_path)).toBe(true);
    });

    it("formation grove members can write to the grove scope", async () => {
      const grove = await getFormationGrove(testFormation, testSession);
      if (!grove?.scope_path) throw new Error("No grove scope");

      // Both agents got 'participant' + 'write' access in formation
      expect(await canAgentWriteScope(JAMES_ENTITY, grove.scope_path)).toBe(true);
      expect(await canAgentWriteScope(BRIAN_ENTITY, grove.scope_path)).toBe(true);
    });

    it("idempotent — creating same formation grove again doesn't error", async () => {
      const grove = await createFormationGrove(testFormation, testSession, ["dev"]);
      expect(grove).not.toBeNull();
    });
  });
});
