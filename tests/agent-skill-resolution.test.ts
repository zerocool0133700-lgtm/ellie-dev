import { describe, it, expect, mock } from "bun:test";

describe("agent skill resolution via creature", () => {
  it("resolves skills from creature_skills when creature_id is present", async () => {
    const mockResolve = mock(() => Promise.resolve(["github", "plane", "ums-calendar"]));
    const { resolveAgentSkills } = await import("../src/agent-router");

    const agent = {
      name: "dev",
      creature_id: "test-creature-uuid",
      tools_enabled: ["old-skill-1", "old-skill-2"],
    };

    const skills = await resolveAgentSkills(agent, mockResolve);
    expect(skills).toEqual(["github", "plane", "ums-calendar"]);
    expect(mockResolve).toHaveBeenCalledWith("test-creature-uuid");
  });

  it("falls back to tools_enabled when creature_id is null", async () => {
    const mockResolve = mock(() => Promise.resolve(null));
    const { resolveAgentSkills } = await import("../src/agent-router");

    const agent = {
      name: "dev",
      creature_id: null,
      tools_enabled: ["fallback-skill"],
    };

    const skills = await resolveAgentSkills(agent, mockResolve);
    expect(skills).toEqual(["fallback-skill"]);
  });

  it("falls back to tools_enabled when creature resolver returns empty array", async () => {
    const mockResolve = mock(() => Promise.resolve([]));
    const { resolveAgentSkills } = await import("../src/agent-router");

    const agent = {
      name: "dev",
      creature_id: "creature-with-no-skills",
      tools_enabled: ["fallback-skill"],
    };

    const skills = await resolveAgentSkills(agent, mockResolve);
    expect(skills).toEqual(["fallback-skill"]);
  });

  it("falls back to tools_enabled when resolver throws", async () => {
    const mockResolve = mock(() => Promise.reject(new Error("DB connection failed")));
    const { resolveAgentSkills } = await import("../src/agent-router");

    const agent = {
      name: "dev",
      creature_id: "test-creature-uuid",
      tools_enabled: ["fallback-skill"],
    };

    const skills = await resolveAgentSkills(agent, mockResolve);
    expect(skills).toEqual(["fallback-skill"]);
  });

  it("does not call resolver when creature_id is undefined", async () => {
    const mockResolve = mock(() => Promise.resolve(["should-not-reach"]));
    const { resolveAgentSkills } = await import("../src/agent-router");

    const agent = {
      name: "dev",
      tools_enabled: ["default-skill"],
    };

    const skills = await resolveAgentSkills(agent, mockResolve);
    expect(skills).toEqual(["default-skill"]);
    expect(mockResolve).not.toHaveBeenCalled();
  });
});
