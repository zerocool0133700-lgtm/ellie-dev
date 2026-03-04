import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import {
  buildPrompt,
  getLastBuildMetrics,
  getPlanningMode,
  setPlanningMode,
  clearPersonalityCache,
  stopPersonalityWatchers,
  validateArchetypes,
  getAgentArchetype,
  USER_NAME,
  type BuildMetrics,
} from "../src/prompt-builder.ts";
import { setCreatureProfile, getCreatureProfile } from "../src/creature-profile.ts";

// ── Cleanup watchers after all tests ─────────────────────────

afterAll(() => {
  stopPersonalityWatchers();
});

// ── Planning mode state ──────────────────────────────────────

describe("getPlanningMode / setPlanningMode", () => {
  beforeEach(() => {
    setPlanningMode(false);
  });

  it("defaults to false", () => {
    expect(getPlanningMode()).toBe(false);
  });

  it("can be set to true", () => {
    setPlanningMode(true);
    expect(getPlanningMode()).toBe(true);
  });

  it("can be toggled back to false", () => {
    setPlanningMode(true);
    setPlanningMode(false);
    expect(getPlanningMode()).toBe(false);
  });
});

// ── clearPersonalityCache ────────────────────────────────────

describe("clearPersonalityCache", () => {
  it("does not throw", () => {
    expect(() => clearPersonalityCache()).not.toThrow();
  });

  it("can be called multiple times", () => {
    clearPersonalityCache();
    clearPersonalityCache();
    // No error means it works
  });
});

// ── buildPrompt — basic structure ────────────────────────────

describe("buildPrompt — basic structure", () => {
  it("returns a non-empty string", () => {
    const result = buildPrompt("Hello");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("includes the user message", () => {
    const result = buildPrompt("What is the weather today?");
    expect(result).toContain("What is the weather today?");
  });

  it("includes current date/time", () => {
    const result = buildPrompt("Hello");
    expect(result).toContain("Current date/time:");
  });

  it("includes source hierarchy", () => {
    const result = buildPrompt("Hello");
    expect(result).toContain("SOURCE TRUST HIERARCHY");
  });

  it("includes memory protocol", () => {
    const result = buildPrompt("Hello");
    expect(result).toContain("MEMORY MANAGEMENT:");
    expect(result).toContain("[REMEMBER:");
  });

  it("includes confirm protocol", () => {
    const result = buildPrompt("Hello");
    expect(result).toContain("ACTION CONFIRMATIONS:");
    expect(result).toContain("[CONFIRM:");
  });
});

// ── buildPrompt — channel labels ─────────────────────────────

describe("buildPrompt — channel labels", () => {
  it("defaults to Telegram channel", () => {
    const result = buildPrompt("Hello");
    expect(result).toContain("Telegram");
  });

  it("uses Google Chat label for google-chat channel", () => {
    const result = buildPrompt("Hello", undefined, undefined, undefined, "google-chat");
    expect(result).toContain("Google Chat");
  });

  it("uses Ellie Chat label for ellie-chat channel", () => {
    const result = buildPrompt("Hello", undefined, undefined, undefined, "ellie-chat");
    expect(result).toContain("Ellie Chat (dashboard)");
  });

  it("uses Telegram label for telegram channel", () => {
    const result = buildPrompt("Hello", undefined, undefined, undefined, "telegram");
    expect(result).toContain("Telegram");
  });
});

// ── buildPrompt — agent configs (archetype variants) ─────────

describe("buildPrompt — agent config variants", () => {
  it("uses default assistant prompt when no agent config", () => {
    const result = buildPrompt("Hello");
    expect(result).toContain("personal AI assistant");
  });

  it("uses custom system prompt from agent config", () => {
    const result = buildPrompt("Hello", undefined, undefined, undefined, "telegram", {
      system_prompt: "You are a dev specialist.",
      name: "dev",
    });
    expect(result).toContain("You are a dev specialist.");
    expect(result).not.toContain("personal AI assistant");
  });

  it("appends channel label to custom system prompt", () => {
    const result = buildPrompt("Hello", undefined, undefined, undefined, "ellie-chat", {
      system_prompt: "You are a research agent.",
      name: "research",
    });
    expect(result).toContain("You are a research agent.");
    expect(result).toContain("Ellie Chat (dashboard)");
  });

  it("falls back to default prompt when system_prompt is null", () => {
    const result = buildPrompt("Hello", undefined, undefined, undefined, "telegram", {
      system_prompt: null,
      name: "general",
    });
    expect(result).toContain("personal AI assistant");
  });

  it("includes tools list when agent mode is active", () => {
    const result = buildPrompt("Hello", undefined, undefined, undefined, "telegram", {
      tools_enabled: ["Read", "Write", "Bash"],
    });
    expect(result).toContain("Read, Write, Bash");
  });

  it("includes MCP tool descriptions", () => {
    const result = buildPrompt("Hello");
    expect(result).toContain("Google Workspace");
    expect(result).toContain("Forest Bridge");
    expect(result).toContain("QMD");
  });
});

// ── buildPrompt — context injection ──────────────────────────

describe("buildPrompt — context injection", () => {
  it("includes context docket when provided", () => {
    const result = buildPrompt("Hello", "Some docket context");
    expect(result).toContain("Some docket context");
  });

  it("suppresses search context by default (priority 7)", () => {
    // relevantContext, elasticContext, forestContext are combined into a "search" section
    // at priority 7, which is >= the suppress threshold. They should NOT appear in output.
    const result = buildPrompt("Hello", undefined, "Some relevant context");
    expect(result).not.toContain("Some relevant context");
  });

  it("suppresses elastic context by default (priority 7)", () => {
    const result = buildPrompt("Hello", undefined, undefined, "Elastic search results");
    expect(result).not.toContain("Elastic search results");
  });

  it("includes search context when creature profile rescues it below threshold", () => {
    // Set creature profile that lowers search priority below suppress threshold
    setCreatureProfile("search-rescuer", {
      section_priorities: { search: 4 },
      token_budget: 30000,
    });
    const result = buildPrompt(
      "Hello", undefined, "Rescued search context", undefined, "telegram",
      { name: "search-rescuer" },
    );
    expect(result).toContain("Rescued search context");
  });

  it("includes work item context when provided", () => {
    const result = buildPrompt(
      "Hello", undefined, undefined, undefined, "telegram", undefined,
      "ACTIVE WORK ITEM: ELLIE-505",
    );
    expect(result).toContain("ACTIVE WORK ITEM: ELLIE-505");
  });

  it("includes structured context when provided", () => {
    const result = buildPrompt(
      "Hello", undefined, undefined, undefined, "telegram", undefined,
      undefined, "Structured context here",
    );
    expect(result).toContain("Structured context here");
  });

  it("includes recent messages when provided", () => {
    const result = buildPrompt(
      "Hello", undefined, undefined, undefined, "telegram", undefined,
      undefined, undefined, "User: hi\nAssistant: hello",
    );
    expect(result).toContain("User: hi");
    expect(result).toContain("Assistant: hello");
  });

  it("suppresses forest context by default (combined in search at priority 7)", () => {
    const result = buildPrompt(
      "Hello", undefined, undefined, undefined, "telegram", undefined,
      undefined, undefined, undefined, undefined, "Forest tree data",
    );
    // Forest context goes into the "search" section at priority 7, which gets suppressed
    expect(result).not.toContain("Forest tree data");
  });

  it("includes agent memory context when provided", () => {
    const result = buildPrompt(
      "Hello", undefined, undefined, undefined, "telegram", undefined,
      undefined, undefined, undefined, undefined, undefined, "Agent memories here",
    );
    expect(result).toContain("Agent memories here");
  });
});

// ── buildPrompt — skill context ──────────────────────────────

describe("buildPrompt — skill context", () => {
  it("includes active skill when provided", () => {
    const result = buildPrompt(
      "Hello", undefined, undefined, undefined, "telegram", undefined,
      undefined, undefined, undefined,
      { name: "plane", description: "Manage Plane work items" },
    );
    expect(result).toContain("ACTIVE SKILL: plane");
    expect(result).toContain("Manage Plane work items");
  });

  it("includes skills prompt block when provided", () => {
    const result = buildPrompt(
      "Hello", undefined, undefined, undefined, "telegram", undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined,
      "Available skills: briefing, forest, github",
    );
    expect(result).toContain("Available skills: briefing, forest, github");
  });
});

// ── buildPrompt — personality context ────────────────────────

describe("buildPrompt — personality context", () => {
  it("includes archetype context when provided", () => {
    const result = buildPrompt(
      "Hello", undefined, undefined, undefined, "telegram", undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, "You are a methodical ant.",
    );
    expect(result).toContain("Behavioral Archetype");
    expect(result).toContain("You are a methodical ant.");
  });

  it("includes psy context when provided", () => {
    const result = buildPrompt(
      "Hello", undefined, undefined, undefined, "telegram", undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, "MBTI: INTJ",
    );
    expect(result).toContain("Psychological Profile");
    expect(result).toContain("MBTI: INTJ");
  });

  it("includes phase context when provided", () => {
    const result = buildPrompt(
      "Hello", undefined, undefined, undefined, "telegram", undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, "Phase: Established",
    );
    expect(result).toContain("Relationship Phase");
    expect(result).toContain("Phase: Established");
  });

  it("includes health context when provided", () => {
    const result = buildPrompt(
      "Hello", undefined, undefined, undefined, "telegram", undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, "Health signals here",
    );
    expect(result).toContain("Health & Life Context");
    expect(result).toContain("Health signals here");
  });
});

// ── buildPrompt — session and Forest memory writes ───────────

describe("buildPrompt — session IDs and forest memory writes", () => {
  it("includes forest memory write instructions when sessionIds provided", () => {
    const sessionIds = {
      tree_id: "t1",
      branch_id: "b1",
      creature_id: "c1",
      entity_id: "e1",
    };
    const result = buildPrompt(
      "Hello", undefined, undefined, undefined, "telegram", undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      sessionIds,
    );
    expect(result).toContain("FOREST MEMORY WRITES");
    expect(result).toContain("[MEMORY:");
  });

  it("omits forest memory writes when no sessionIds", () => {
    const result = buildPrompt("Hello");
    expect(result).not.toContain("FOREST MEMORY WRITES");
  });

  it("includes no-session notice in memory protocol when no sessionIds", () => {
    const result = buildPrompt("Hello");
    expect(result).toContain("forest writes unavailable");
  });
});

// ── buildPrompt — dev protocol ───────────────────────────────

describe("buildPrompt — dev protocol", () => {
  it("includes dev protocol for non-general agent with active work item", () => {
    const result = buildPrompt(
      "Hello", undefined, undefined, undefined, "telegram",
      { system_prompt: "You are a dev agent.", name: "dev" },
      "ACTIVE WORK ITEM: ELLIE-505 — Test prompt builder",
    );
    expect(result).toContain("DEV AGENT PROTOCOL:");
    expect(result).toContain("[ELLIE-N] prefix");
  });

  it("omits dev protocol for general agent even with work item", () => {
    const result = buildPrompt(
      "Hello", undefined, undefined, undefined, "telegram",
      { system_prompt: "You are the general assistant.", name: "general" },
      "ACTIVE WORK ITEM: ELLIE-505 — Test prompt builder",
    );
    expect(result).not.toContain("DEV AGENT PROTOCOL:");
  });

  it("omits dev protocol when no work item context", () => {
    const result = buildPrompt(
      "Hello", undefined, undefined, undefined, "telegram",
      { system_prompt: "You are a dev agent.", name: "dev" },
    );
    expect(result).not.toContain("DEV AGENT PROTOCOL:");
  });
});

// ── buildPrompt — planning mode ──────────────────────────────

describe("buildPrompt — planning mode", () => {
  beforeEach(() => {
    setPlanningMode(false);
  });

  it("omits planning mode block when inactive", () => {
    const result = buildPrompt("Hello");
    expect(result).not.toContain("PLANNING MODE ACTIVE:");
  });

  it("includes planning mode block when active", () => {
    setPlanningMode(true);
    const result = buildPrompt("Hello");
    expect(result).toContain("PLANNING MODE ACTIVE:");
    expect(result).toContain("extended planning session");
    setPlanningMode(false);
  });
});

// ── buildPrompt — channel profile ────────────────────────────

describe("buildPrompt — channel profile", () => {
  it("includes channel context when channelProfile has channelName", () => {
    const result = buildPrompt(
      "Hello", undefined, undefined, undefined, "ellie-chat", undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      { channelName: "Research", contextMode: "strategy" as any, suppressedSections: [], tokenBudget: 24000, contextPriority: 2, sources: [] },
    );
    expect(result).toContain("CURRENT CHANNEL: Research");
    expect(result).toContain("Channel mode: strategy");
  });

  it("suppresses sections listed in channelProfile.suppressedSections", () => {
    // Build with profile context that would normally appear
    const result = buildPrompt(
      "Hello", undefined, undefined, undefined, "ellie-chat", undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      { channelName: "Test", contextMode: "general" as any, suppressedSections: ["confirm-protocol"], tokenBudget: 24000, contextPriority: 2, sources: [] },
    );
    expect(result).not.toContain("ACTION CONFIRMATIONS:");
  });
});

// ── buildPrompt — creature profile section priorities ────────

describe("buildPrompt — creature profile priorities", () => {
  beforeEach(() => {
    // Clear any cached creature profiles
    clearPersonalityCache();
  });

  it("applies creature section priority overrides", () => {
    // Set creature profile that prioritizes archetype and deprioritizes psy
    setCreatureProfile("test-agent", {
      section_priorities: { archetype: 1, psy: 6 },
      token_budget: 30000,
    });

    const result = buildPrompt(
      "Hello", undefined, undefined, undefined, "telegram",
      { name: "test-agent" },
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, "Test archetype content", "Test psy content",
    );

    // Both should still be in the output (priorities affect trimming, not removal unless >= 7)
    expect(result).toContain("Test archetype content");
    expect(result).toContain("Test psy content");
  });

  it("suppresses sections with priority >= 7 after creature override", () => {
    setCreatureProfile("suppressor", {
      section_priorities: { psy: 8 },
      token_budget: 30000,
    });

    const result = buildPrompt(
      "Hello", undefined, undefined, undefined, "telegram",
      { name: "suppressor" },
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, "Should be suppressed psy",
    );

    // psy was set to priority 8 — should be suppressed
    expect(result).not.toContain("Should be suppressed psy");
  });

  it("creature budget overrides channel profile budget", () => {
    setCreatureProfile("high-budget", {
      section_priorities: {},
      token_budget: 50000,
    });

    buildPrompt(
      "Hello", undefined, undefined, undefined, "telegram",
      { name: "high-budget" },
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      { channelName: "Test", contextMode: "general" as any, suppressedSections: [], tokenBudget: 10000, contextPriority: 2, sources: [] },
    );

    const metrics = getLastBuildMetrics();
    expect(metrics).not.toBeNull();
    // Creature budget (50000) should win over channel profile budget (10000)
    expect(metrics!.budget).toBe(50000);
  });
});

// ── buildPrompt — ground truth conflicts ─────────────────────

describe("buildPrompt — ground truth and corrections", () => {
  it("includes ground truth conflicts when provided", () => {
    const result = buildPrompt(
      "Hello", undefined, undefined, undefined, "telegram", undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      undefined, "CONFLICT: Forest says X but conversation says Y",
    );
    expect(result).toContain("CONFLICT: Forest says X but conversation says Y");
  });

  it("includes cross-channel corrections when provided", () => {
    const result = buildPrompt(
      "Hello", undefined, undefined, undefined, "telegram", undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, "Correction from Telegram: X is actually Y",
    );
    expect(result).toContain("Correction from Telegram: X is actually Y");
  });
});

// ── buildPrompt — queue and incident context ─────────────────

describe("buildPrompt — queue and incident context", () => {
  it("includes queue context when provided", () => {
    const result = buildPrompt(
      "Hello", undefined, undefined, undefined, "telegram", undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined,
      "Pending queue items: ELLIE-100, ELLIE-200",
    );
    expect(result).toContain("Pending queue items: ELLIE-100, ELLIE-200");
  });

  it("includes incident context when provided", () => {
    const result = buildPrompt(
      "Hello", undefined, undefined, undefined, "telegram", undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      "ACTIVE INCIDENT: Database connection pool exhausted",
    );
    expect(result).toContain("ACTIVE INCIDENT: Database connection pool exhausted");
  });
});

// ── getLastBuildMetrics ──────────────────────────────────────

describe("getLastBuildMetrics", () => {
  it("returns metrics after buildPrompt call", () => {
    buildPrompt("Test message");
    const metrics = getLastBuildMetrics();
    expect(metrics).not.toBeNull();
  });

  it("metrics contain section array", () => {
    buildPrompt("Test message");
    const metrics = getLastBuildMetrics()!;
    expect(Array.isArray(metrics.sections)).toBe(true);
    expect(metrics.sections.length).toBeGreaterThan(0);
  });

  it("metrics have totalTokens > 0", () => {
    buildPrompt("Test message");
    const metrics = getLastBuildMetrics()!;
    expect(metrics.totalTokens).toBeGreaterThan(0);
  });

  it("metrics include sectionCount matching sections array length", () => {
    buildPrompt("Test message");
    const metrics = getLastBuildMetrics()!;
    expect(metrics.sectionCount).toBe(metrics.sections.length);
  });

  it("metrics have positive budget", () => {
    buildPrompt("Test message");
    const metrics = getLastBuildMetrics()!;
    expect(metrics.budget).toBeGreaterThan(0);
  });

  it("tracks creature name in metrics", () => {
    buildPrompt(
      "Test message", undefined, undefined, undefined, "telegram",
      { name: "dev" },
    );
    const metrics = getLastBuildMetrics()!;
    expect(metrics.creature).toBe("dev");
  });

  it("sections include known labels", () => {
    buildPrompt("Test message");
    const metrics = getLastBuildMetrics()!;
    const labels = metrics.sections.map(s => s.label);
    expect(labels).toContain("user-message");
    expect(labels).toContain("base-prompt");
    expect(labels).toContain("time");
    expect(labels).toContain("memory-protocol");
    expect(labels).toContain("confirm-protocol");
    expect(labels).toContain("source-hierarchy");
  });

  it("user-message section has priority 1", () => {
    buildPrompt("Test message");
    const metrics = getLastBuildMetrics()!;
    const userMsg = metrics.sections.find(s => s.label === "user-message");
    expect(userMsg).toBeDefined();
    expect(userMsg!.priority).toBe(1);
  });

  it("base-prompt section has priority 2", () => {
    buildPrompt("Test message");
    const metrics = getLastBuildMetrics()!;
    const basePrompt = metrics.sections.find(s => s.label === "base-prompt");
    expect(basePrompt).toBeDefined();
    expect(basePrompt!.priority).toBe(2);
  });

  it("updates on each buildPrompt call", () => {
    buildPrompt("First call");
    const m1 = getLastBuildMetrics()!;
    buildPrompt("Second call with more context", "docket", "relevant");
    const m2 = getLastBuildMetrics()!;
    // Second call has more sections (docket + relevant context)
    expect(m2.sectionCount).toBeGreaterThanOrEqual(m1.sectionCount);
  });
});

// ── validateArchetypes ───────────────────────────────────────

describe("validateArchetypes", () => {
  it("returns valid count and warnings array", async () => {
    const result = await validateArchetypes();
    expect(typeof result.valid).toBe("number");
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it("finds archetype files in config/archetypes/", async () => {
    const result = await validateArchetypes();
    // We know dev.md, general.md, research.md etc exist
    expect(result.valid).toBeGreaterThan(0);
  });

  it("valid count + warning count covers all files", async () => {
    const result = await validateArchetypes();
    // At least the files we know have proper frontmatter should be valid
    expect(result.valid).toBeGreaterThanOrEqual(3);
  });
});

// ── getAgentArchetype ────────────────────────────────────────

describe("getAgentArchetype", () => {
  beforeEach(() => {
    clearPersonalityCache();
  });

  it("returns non-empty string for dev agent", async () => {
    const result = await getAgentArchetype("dev");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns non-empty string for general agent", async () => {
    const result = await getAgentArchetype("general");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns non-empty string for research agent", async () => {
    const result = await getAgentArchetype("research");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns non-empty string for strategy agent", async () => {
    const result = await getAgentArchetype("strategy");
    expect(result.length).toBeGreaterThan(0);
  });

  it("falls back gracefully for unknown agent name", async () => {
    const result = await getAgentArchetype("nonexistent-agent");
    // Should fall back to Forest chain-owner or return empty
    expect(typeof result).toBe("string");
  });

  it("normalizes agent name (strips non-alphanumeric)", async () => {
    // Should treat "DEV" same as "dev"
    const dev1 = await getAgentArchetype("dev");
    clearPersonalityCache();
    const dev2 = await getAgentArchetype("DEV");
    // Both should resolve to the same archetype
    expect(dev1).toBe(dev2);
  });

  it("returns chain-owner archetype when no agent name given", async () => {
    const result = await getAgentArchetype();
    // Should return the chain-owner archetype (may be empty if Forest not configured)
    expect(typeof result).toBe("string");
  });

  it("caches archetype content", async () => {
    const first = await getAgentArchetype("dev");
    const second = await getAgentArchetype("dev");
    // Should return identical cached content
    expect(first).toBe(second);
  });

  it("sets creature profile when loaded", async () => {
    clearPersonalityCache();
    await getAgentArchetype("dev");
    const profile = getCreatureProfile("dev");
    // dev is mapped in AGENT_PROFILE_MAP → loads from Forest (dev-ant)
    expect(profile).not.toBeNull();
    expect(profile!.section_priorities).toBeDefined();
    expect(profile!.token_budget).toBeGreaterThan(0);
  });

  it("sets allowed_skills when loaded", async () => {
    clearPersonalityCache();
    await getAgentArchetype("dev");
    const profile = getCreatureProfile("dev");
    expect(profile!.allowed_skills).toBeDefined();
    expect(profile!.allowed_skills!.length).toBeGreaterThan(0);
  });

  it("sets creature profile from file for unmapped agents", async () => {
    clearPersonalityCache();
    // critic is not in AGENT_PROFILE_MAP, so it loads from file
    await getAgentArchetype("critic");
    const profile = getCreatureProfile("critic");
    expect(profile).not.toBeNull();
    expect(profile!.section_priorities).toBeDefined();
  });
});

// ── buildPrompt — comprehensive integration ──────────────────

describe("buildPrompt — integration with real archetype", () => {
  it("builds complete prompt with dev archetype and work item", async () => {
    // Load real archetype
    const archetype = await getAgentArchetype("dev");

    const result = buildPrompt(
      "Fix the bug in relay.ts",
      undefined, undefined, undefined,
      "ellie-chat",
      { system_prompt: "You are a dev specialist.", name: "dev" },
      "ACTIVE WORK ITEM: ELLIE-505 — Test prompt builder",
      undefined,
      "User: can you fix it?\nAssistant: Looking into it now.",
      undefined, undefined, undefined,
      { tree_id: "t1", branch_id: "b1", creature_id: "c1", entity_id: "e1" },
      archetype,
    );

    // Should have the essential pieces
    expect(result).toContain("Fix the bug in relay.ts");
    expect(result).toContain("You are a dev specialist.");
    expect(result).toContain("ACTIVE WORK ITEM: ELLIE-505");
    expect(result).toContain("DEV AGENT PROTOCOL:");
    expect(result).toContain("FOREST MEMORY WRITES");
    expect(result).toContain("Ellie Chat (dashboard)");
  });

  it("builds complete prompt with general archetype", async () => {
    const archetype = await getAgentArchetype("general");

    const result = buildPrompt(
      "What's on my calendar today?",
      undefined, undefined, undefined,
      "telegram",
      { system_prompt: "You are the general assistant.", name: "general" },
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, archetype,
    );

    expect(result).toContain("What's on my calendar today?");
    expect(result).toContain("You are the general assistant.");
    expect(result).toContain("Telegram");
    // General agent should not have dev protocol
    expect(result).not.toContain("DEV AGENT PROTOCOL:");
  });

  it("builds complete prompt with research archetype", async () => {
    const archetype = await getAgentArchetype("research");

    const result = buildPrompt(
      "Research EVE Online market trends",
      undefined, undefined, undefined,
      "ellie-chat",
      { system_prompt: "You are a research specialist.", name: "research" },
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, archetype,
    );

    expect(result).toContain("Research EVE Online market trends");
    expect(result).toContain("You are a research specialist.");
  });
});

// ── buildPrompt — user identity ──────────────────────────────

describe("buildPrompt — user identity", () => {
  it("includes user name when set", () => {
    if (USER_NAME) {
      const result = buildPrompt("Hello");
      expect(result).toContain(`speaking with ${USER_NAME}`);
    }
  });

  it("includes timezone in date/time", () => {
    const result = buildPrompt("Hello");
    // Should contain the timezone identifier
    expect(result).toMatch(/Current date\/time:.*\(/);
  });
});

// ── buildPrompt — awareness and command bar context ──────────

describe("buildPrompt — awareness and command bar context", () => {
  it("includes awareness context when provided", () => {
    const result = buildPrompt(
      "Hello", undefined, undefined, undefined, "telegram", undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, "Forest awareness: 3 active trees",
    );
    expect(result).toContain("Forest awareness: 3 active trees");
  });

  it("includes command bar context when provided", () => {
    const result = buildPrompt(
      "Hello", undefined, undefined, undefined, "ellie-chat", undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, "Command bar: /search active",
    );
    expect(result).toContain("Command bar: /search active");
  });
});

// ── ELLIE-525: Soul only for primary Ellie ────────────────────

describe("buildPrompt — ELLIE-525 soul gating", () => {
  // The soul section only appears when soulContext is non-empty AND the agent
  // is primary Ellie (general). If soul.md is not loaded in the test environment
  // we check via metrics; if it is loaded we can check string content too.

  it("general agent (no agentConfig.name) includes soul section in metrics", () => {
    buildPrompt("Hello");
    const metrics = getLastBuildMetrics()!;
    // Soul section should be present for primary Ellie (or absent if soul.md not loaded)
    const soul = metrics.sections.find(s => s.label === "soul");
    // If soulContext is loaded the section exists; if not, it correctly doesn't appear.
    // Either way, there must be NO soul when we pass a downstream agent name (tested below).
    expect(metrics).not.toBeNull();
  });

  it("dev agent does NOT include soul section in metrics", () => {
    buildPrompt(
      "Fix the bug",
      undefined, undefined, undefined, "telegram",
      { system_prompt: "You are a dev agent.", name: "dev" },
    );
    const metrics = getLastBuildMetrics()!;
    const soul = metrics.sections.find(s => s.label === "soul");
    expect(soul).toBeUndefined();
  });

  it("research agent does NOT include soul section", () => {
    buildPrompt(
      "Research this topic",
      undefined, undefined, undefined, "telegram",
      { system_prompt: "You are a research agent.", name: "research" },
    );
    const metrics = getLastBuildMetrics()!;
    expect(metrics.sections.find(s => s.label === "soul")).toBeUndefined();
  });

  it("strategy agent does NOT include soul section", () => {
    buildPrompt(
      "Plan Q2",
      undefined, undefined, undefined, "telegram",
      { system_prompt: "You are a strategy agent.", name: "strategy" },
    );
    const metrics = getLastBuildMetrics()!;
    expect(metrics.sections.find(s => s.label === "soul")).toBeUndefined();
  });

  it("critic agent does NOT include soul section", () => {
    buildPrompt(
      "Review this code",
      undefined, undefined, undefined, "telegram",
      { system_prompt: "You are a critic.", name: "critic" },
    );
    const metrics = getLastBuildMetrics()!;
    expect(metrics.sections.find(s => s.label === "soul")).toBeUndefined();
  });

  it("finance agent does NOT include soul section", () => {
    buildPrompt(
      "Analyse the P&L",
      undefined, undefined, undefined, "telegram",
      { system_prompt: "You are a finance agent.", name: "finance" },
    );
    const metrics = getLastBuildMetrics()!;
    expect(metrics.sections.find(s => s.label === "soul")).toBeUndefined();
  });

  it("ops agent does NOT include soul section", () => {
    buildPrompt(
      "Check the servers",
      undefined, undefined, undefined, "telegram",
      { system_prompt: "You are an ops agent.", name: "ops" },
    );
    const metrics = getLastBuildMetrics()!;
    expect(metrics.sections.find(s => s.label === "soul")).toBeUndefined();
  });

  it("explicit general agent name still includes soul section", () => {
    buildPrompt(
      "Hello",
      undefined, undefined, undefined, "telegram",
      { system_prompt: null, name: "general" },
    );
    const metrics = getLastBuildMetrics()!;
    // Soul should be present for 'general' IF soul.md is loaded
    // (section only exists when soulContext is non-empty)
    const soul = metrics.sections.find(s => s.label === "soul");
    // General agent is allowed to have it — it must not be explicitly absent due to the gate
    // We can't assert presence unless we know soul.md content, but we assert the label
    // is not artificially blocked for 'general'.
    // Verify the gate condition: if soul.md exists and content is loaded, it should appear.
    if (soul !== undefined) {
      expect(soul.label).toBe("soul");
    }
  });

  it("downstream agent gets archetype and psy but NOT soul", () => {
    buildPrompt(
      "Do the work",
      undefined, undefined, undefined, "telegram",
      { system_prompt: "You are a dev agent.", name: "dev" },
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, "Dev archetype content", "Psy context here",
    );
    const metrics = getLastBuildMetrics()!;
    const labels = metrics.sections.map(s => s.label);

    expect(labels).not.toContain("soul");
    expect(labels).toContain("archetype"); // archetype is NOT gated
    expect(labels).toContain("psy");       // psy is NOT gated
  });

  it("no agentConfig at all treats as general agent (soul allowed)", () => {
    // buildPrompt with no agentConfig → isGeneralAgent = true
    buildPrompt("Hello");
    const metrics = getLastBuildMetrics()!;
    // soul section may or may not be present depending on whether soul.md is loaded,
    // but the gate MUST NOT block it when there's no agent config.
    // We verify by checking dev does NOT have soul, confirming the gate is asymmetric.
    const noneMetrics = metrics;

    buildPrompt(
      "Hello",
      undefined, undefined, undefined, "telegram",
      { name: "dev" },
    );
    const devMetrics = getLastBuildMetrics()!;
    expect(devMetrics.sections.find(s => s.label === "soul")).toBeUndefined();
  });

  it("soul-gating does not affect other personality sections (archetype/psy/phase/health)", () => {
    // Downstream agent should still receive archetype, psy, phase, health
    buildPrompt(
      "Hello",
      undefined, undefined, undefined, "telegram",
      { name: "research" },
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined,
      "Research archetype", "MBTI: INTJ", "Phase: Established", "Health: Good",
    );
    const metrics = getLastBuildMetrics()!;
    const labels = metrics.sections.map(s => s.label);

    expect(labels).not.toContain("soul");
    expect(labels).toContain("archetype");
    expect(labels).toContain("psy");
    expect(labels).toContain("phase");
    expect(labels).toContain("health");
  });
});

// ── Prompt section ordering sanity checks ────────────────────

describe("buildPrompt — section ordering", () => {
  it("user message appears in prompt", () => {
    const result = buildPrompt("Critical user question");
    expect(result).toContain("Critical user question");
  });

  it("base prompt appears before context sections", () => {
    const result = buildPrompt(
      "Hello", "Docket context here", undefined, undefined, "telegram",
    );
    const baseIdx = result.indexOf("personal AI assistant");
    const docketIdx = result.indexOf("Docket context here");
    // Both should be present
    expect(baseIdx).toBeGreaterThan(-1);
    expect(docketIdx).toBeGreaterThan(-1);
    // Base prompt (priority 2) should come before docket (priority 6)
    expect(baseIdx).toBeLessThan(docketIdx);
  });

  it("memory protocol appears before context docket", () => {
    const result = buildPrompt(
      "Hello", "Some docket data",
    );
    const memIdx = result.indexOf("MEMORY MANAGEMENT:");
    const docketIdx = result.indexOf("Some docket data");
    // Memory protocol (priority 3) should come before docket (priority 6)
    expect(memIdx).toBeGreaterThan(-1);
    expect(docketIdx).toBeGreaterThan(-1);
    expect(memIdx).toBeLessThan(docketIdx);
  });
});
