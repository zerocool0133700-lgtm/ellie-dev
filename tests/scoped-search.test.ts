import { describe, it, expect } from "bun:test";
import { resolveSearchScope, AGENT_SCOPE_MAP } from "../../ellie-forest/src/scoped-search.ts";

describe("ELLIE-1045: Tag-scoped agent conversations", () => {
  describe("AGENT_SCOPE_MAP", () => {
    it("has scope for all agent archetypes", () => {
      expect(AGENT_SCOPE_MAP.dev).toBeDefined();
      expect(AGENT_SCOPE_MAP.research).toBeDefined();
      expect(AGENT_SCOPE_MAP.critic).toBeDefined();
      expect(AGENT_SCOPE_MAP.general).toBeDefined();
    });

    it("dev scopes to ellie-dev", () => {
      expect(AGENT_SCOPE_MAP.dev).toContain("2/1");
    });

    it("general sees all projects", () => {
      expect(AGENT_SCOPE_MAP.general).toContain("2");
    });
  });

  describe("resolveSearchScope", () => {
    it("uses explicit scope when provided", () => {
      const scopes = resolveSearchScope({ agent: "dev", explicitScope: "2/3" });
      expect(scopes).toEqual(["2/3"]);
    });

    it("uses ticket project scope", () => {
      const scopes = resolveSearchScope({ agent: "dev", ticketProject: "ellie-home" });
      expect(scopes).toEqual(["2/3"]);
    });

    it("falls back to agent default", () => {
      const scopes = resolveSearchScope({ agent: "dev" });
      expect(scopes).toEqual(["2/1"]);
    });

    it("uses general scope for unknown agent", () => {
      const scopes = resolveSearchScope({ agent: "unknown" });
      expect(scopes).toEqual(["2"]);
    });

    it("explicit scope overrides ticket project", () => {
      const scopes = resolveSearchScope({ agent: "dev", ticketProject: "ellie-home", explicitScope: "2/2" });
      expect(scopes).toEqual(["2/2"]);
    });
  });
});
