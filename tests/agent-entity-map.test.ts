import { describe, it, expect } from "bun:test";
import { AGENT_ENTITY_MAP, resolveEntityName } from "../src/agent-entity-map.ts";

describe("AGENT_ENTITY_MAP", () => {
  it("contains all expected agent mappings", () => {
    expect(AGENT_ENTITY_MAP.dev).toBe("dev_agent");
    expect(AGENT_ENTITY_MAP.research).toBe("research_agent");
    expect(AGENT_ENTITY_MAP.critic).toBe("critic_agent");
    expect(AGENT_ENTITY_MAP.content).toBe("content_agent");
    expect(AGENT_ENTITY_MAP.finance).toBe("finance_agent");
    expect(AGENT_ENTITY_MAP.strategy).toBe("strategy_agent");
    expect(AGENT_ENTITY_MAP.general).toBe("general_agent");
    expect(AGENT_ENTITY_MAP.router).toBe("agent_router");
    expect(AGENT_ENTITY_MAP.ops).toBe("ops_agent");
  });
});

describe("resolveEntityName", () => {
  it("resolves known agent names to entity names", () => {
    expect(resolveEntityName("dev")).toBe("dev_agent");
    expect(resolveEntityName("research")).toBe("research_agent");
    expect(resolveEntityName("general")).toBe("general_agent");
    expect(resolveEntityName("ops")).toBe("ops_agent");
  });

  it("falls back to the agent name itself for unknown agents", () => {
    expect(resolveEntityName("unknown")).toBe("unknown");
    expect(resolveEntityName("custom_agent")).toBe("custom_agent");
  });

  it("falls back for empty string", () => {
    expect(resolveEntityName("")).toBe("");
  });
});
