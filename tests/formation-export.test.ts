/**
 * Formation Export/Import System Tests — ELLIE-732
 *
 * Tests for portable formation packages:
 * - Manifest building and serialization
 * - Secret scrubbing (API keys, tokens, credentials)
 * - Manifest validation
 * - Collision detection and resolution
 * - Unique name generation
 * - Full import validation
 * - Round-trip: export -> import -> verify
 */

import { describe, test, expect } from "bun:test";
import {
  buildManifest,
  serializeManifest,
  deserializeManifest,
  scrubSecrets,
  scrubManifest,
  validateManifest,
  detectCollisions,
  resolveCollisions,
  generateUniqueName,
  validateImport,
  MANIFEST_VERSION,
  SCRUBBED_PLACEHOLDER,
  SECRET_PATTERNS,
  type FormationManifest,
  type ExportedAgent,
  type ExportedProtocol,
  type AgentCollision,
} from "../src/formation-export.ts";

// ── Helpers ─────────────────────────────────────────────────

function makeAgent(overrides: Partial<ExportedAgent> = {}): ExportedAgent {
  return {
    name: "dev",
    type: "dev",
    title: "Lead Developer",
    role: "lead",
    responsibility: "Write implementation code",
    model: "claude-sonnet-4-5-20250929",
    capabilities: ["coding", "review"],
    skills: ["github", "plane"],
    ...overrides,
  };
}

function makeProtocol(overrides: Partial<ExportedProtocol> = {}): ExportedProtocol {
  return {
    pattern: "coordinator",
    maxTurns: 10,
    coordinator: "dev",
    turnOrder: null,
    requiresApproval: false,
    conflictResolution: "coordinator-decides",
    ...overrides,
  };
}

function makeManifest(overrides: Partial<FormationManifest> = {}): FormationManifest {
  return {
    version: MANIFEST_VERSION,
    exported_at: new Date().toISOString(),
    formation: {
      name: "code-review",
      description: "Multi-agent code review formation",
      skill_md: "---\nname: code-review\n---\n## Objective\nReview code",
    },
    agents: [makeAgent(), makeAgent({ name: "critic", type: "critic", role: "reviewer" })],
    protocol: makeProtocol(),
    heartbeat: null,
    metadata: {},
    ...overrides,
  };
}

// ── Constants ───────────────────────────────────────────────

describe("constants", () => {
  test("MANIFEST_VERSION is 1", () => {
    expect(MANIFEST_VERSION).toBe(1);
  });

  test("SCRUBBED_PLACEHOLDER is [SCRUBBED]", () => {
    expect(SCRUBBED_PLACEHOLDER).toBe("[SCRUBBED]");
  });

  test("SECRET_PATTERNS has patterns for common secret types", () => {
    expect(SECRET_PATTERNS.length).toBeGreaterThanOrEqual(5);
  });
});

// ── buildManifest ───────────────────────────────────────────

describe("buildManifest", () => {
  test("builds manifest with all fields", () => {
    const m = buildManifest({
      name: "code-review",
      description: "Review code",
      skill_md: "---\nname: code-review\n---",
      agents: [makeAgent()],
      protocol: makeProtocol(),
    });

    expect(m.version).toBe(MANIFEST_VERSION);
    expect(m.formation.name).toBe("code-review");
    expect(m.agents).toHaveLength(1);
    expect(m.heartbeat).toBeNull();
    expect(m.exported_at).toBeTruthy();
  });

  test("includes heartbeat when provided", () => {
    const m = buildManifest({
      name: "billing",
      description: "Billing ops",
      skill_md: "---\nname: billing\n---",
      agents: [makeAgent()],
      protocol: makeProtocol(),
      heartbeat: { schedule: "0 9 * * *", enabled: true, run_context: {} },
    });

    expect(m.heartbeat).not.toBeNull();
    expect(m.heartbeat!.schedule).toBe("0 9 * * *");
  });

  test("includes metadata when provided", () => {
    const m = buildManifest({
      name: "test",
      description: "test",
      skill_md: "test",
      agents: [makeAgent()],
      protocol: makeProtocol(),
      metadata: { source: "ellie-labs" },
    });

    expect(m.metadata).toEqual({ source: "ellie-labs" });
  });
});

// ── Serialization ───────────────────────────────────────────

describe("serializeManifest / deserializeManifest", () => {
  test("round-trips correctly", () => {
    const original = makeManifest();
    const json = serializeManifest(original);
    const restored = deserializeManifest(json);

    expect(restored).not.toBeNull();
    expect(restored!.formation.name).toBe(original.formation.name);
    expect(restored!.agents).toHaveLength(original.agents.length);
    expect(restored!.version).toBe(MANIFEST_VERSION);
  });

  test("serializes to pretty JSON", () => {
    const json = serializeManifest(makeManifest());
    expect(json).toContain("\n");
    expect(json).toContain("  ");
  });

  test("deserialize returns null for invalid JSON", () => {
    expect(deserializeManifest("not json")).toBeNull();
  });

  test("deserialize returns null for missing required fields", () => {
    expect(deserializeManifest('{"foo": "bar"}')).toBeNull();
    expect(deserializeManifest('{"version": 1}')).toBeNull();
  });

  test("deserialize returns null for empty/null", () => {
    expect(deserializeManifest("null")).toBeNull();
    expect(deserializeManifest("")).toBeNull();
  });
});

// ── Secret Scrubbing ────────────────────────────────────────

describe("scrubSecrets", () => {
  test("scrubs API keys", () => {
    const { scrubbed, count } = scrubSecrets('api_key: "sk-abc123def456ghi789jkl012mno345"');
    expect(scrubbed).not.toContain("sk-abc123");
    expect(scrubbed).toContain(SCRUBBED_PLACEHOLDER);
    expect(count).toBeGreaterThan(0);
  });

  test("scrubs OpenAI-style keys", () => {
    const { scrubbed } = scrubSecrets("Using key sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(scrubbed).toContain(SCRUBBED_PLACEHOLDER);
    expect(scrubbed).not.toContain("sk-abcdefgh");
  });

  test("scrubs bridge keys", () => {
    const { scrubbed } = scrubSecrets("key: bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a");
    expect(scrubbed).toContain(SCRUBBED_PLACEHOLDER);
    expect(scrubbed).not.toContain("bk_d81869ef");
  });

  test("scrubs Bearer tokens", () => {
    const { scrubbed } = scrubSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig");
    expect(scrubbed).toContain(SCRUBBED_PLACEHOLDER);
  });

  test("scrubs GitHub PATs", () => {
    const { scrubbed } = scrubSecrets("token: ghp_1234567890abcdefghijklmnopqrstuvwxyz12");
    expect(scrubbed).toContain(SCRUBBED_PLACEHOLDER);
  });

  test("scrubs Slack tokens", () => {
    const { scrubbed } = scrubSecrets("slack: xoxb-123-456-abcdef");
    expect(scrubbed).toContain(SCRUBBED_PLACEHOLDER);
  });

  test("preserves non-secret content", () => {
    const input = "This is a normal formation description with no secrets.";
    const { scrubbed, count } = scrubSecrets(input);
    expect(scrubbed).toBe(input);
    expect(count).toBe(0);
  });

  test("scrubs multiple secrets in one string", () => {
    const input = 'api_key: "sk-abc123def456ghi789jkl012mno" and token: "ghp_1234567890abcdefghijklmnopqrstuvwxyz12"';
    const { scrubbed, count } = scrubSecrets(input);
    expect(count).toBeGreaterThanOrEqual(2);
    expect(scrubbed).not.toContain("sk-abc123");
    expect(scrubbed).not.toContain("ghp_1234567");
  });
});

describe("scrubManifest", () => {
  test("scrubs secrets from skill_md", () => {
    const manifest = makeManifest();
    manifest.formation.skill_md = "api_key: sk-secret123456789012345678901234\n## Objective\nDo things";

    const { manifest: scrubbed, total_scrubbed } = scrubManifest(manifest);
    expect(scrubbed.formation.skill_md).not.toContain("sk-secret");
    expect(total_scrubbed).toBeGreaterThan(0);
  });

  test("scrubs secrets from metadata", () => {
    const manifest = makeManifest();
    manifest.metadata = { secret: "token=ghp_1234567890abcdefghijklmnopqrstuvwxyz12" };

    const { manifest: scrubbed } = scrubManifest(manifest);
    const metaJson = JSON.stringify(scrubbed.metadata);
    expect(metaJson).not.toContain("ghp_12345");
  });

  test("scrubs secrets from heartbeat run_context", () => {
    const manifest = makeManifest();
    manifest.heartbeat = {
      schedule: "0 9 * * *",
      enabled: true,
      run_context: { auth: "Bearer eyJhbGciOiJIUzI1NiJ9.test.sig" },
    };

    const { manifest: scrubbed } = scrubManifest(manifest);
    const hbJson = JSON.stringify(scrubbed.heartbeat!.run_context);
    expect(hbJson).not.toContain("eyJhbGci");
  });

  test("no-op for clean manifest", () => {
    const manifest = makeManifest();
    const { manifest: scrubbed, total_scrubbed } = scrubManifest(manifest);
    expect(total_scrubbed).toBe(0);
    expect(scrubbed.formation.skill_md).toBe(manifest.formation.skill_md);
  });
});

// ── Manifest Validation ─────────────────────────────────────

describe("validateManifest", () => {
  test("valid manifest passes", () => {
    const errors = validateManifest(makeManifest());
    expect(errors).toHaveLength(0);
  });

  test("wrong version fails", () => {
    const m = makeManifest();
    m.version = 99;
    const errors = validateManifest(m);
    expect(errors.some(e => e.includes("version"))).toBe(true);
  });

  test("missing name fails", () => {
    const m = makeManifest();
    m.formation.name = "";
    expect(validateManifest(m).length).toBeGreaterThan(0);
  });

  test("missing skill_md fails", () => {
    const m = makeManifest();
    m.formation.skill_md = "";
    expect(validateManifest(m).length).toBeGreaterThan(0);
  });

  test("empty agents fails", () => {
    const m = makeManifest();
    m.agents = [];
    expect(validateManifest(m).length).toBeGreaterThan(0);
  });

  test("agent with missing name fails", () => {
    const m = makeManifest();
    m.agents[0].name = "";
    expect(validateManifest(m).some(e => e.includes("name"))).toBe(true);
  });

  test("agent with missing type fails", () => {
    const m = makeManifest();
    m.agents[0].type = "";
    expect(validateManifest(m).some(e => e.includes("type"))).toBe(true);
  });

  test("agent with missing role fails", () => {
    const m = makeManifest();
    m.agents[0].role = "";
    expect(validateManifest(m).some(e => e.includes("role"))).toBe(true);
  });

  test("missing protocol fails", () => {
    const m = makeManifest();
    (m as any).protocol = null;
    expect(validateManifest(m).some(e => e.includes("Protocol"))).toBe(true);
  });
});

// ── Collision Detection ─────────────────────────────────────

describe("detectCollisions", () => {
  test("detects collisions with existing agents", () => {
    const imported = [makeAgent({ name: "dev" }), makeAgent({ name: "critic" })];
    const existing = new Set(["dev", "strategy"]);

    const collisions = detectCollisions(imported, existing);
    expect(collisions).toHaveLength(1);
    expect(collisions[0].imported_name).toBe("dev");
    expect(collisions[0].strategy).toBe("skip");
  });

  test("no collisions when names are unique", () => {
    const imported = [makeAgent({ name: "new-agent" })];
    const existing = new Set(["dev", "critic"]);

    expect(detectCollisions(imported, existing)).toHaveLength(0);
  });

  test("detects all collisions", () => {
    const imported = [makeAgent({ name: "dev" }), makeAgent({ name: "critic" })];
    const existing = new Set(["dev", "critic"]);

    expect(detectCollisions(imported, existing)).toHaveLength(2);
  });
});

// ── resolveCollisions ───────────────────────────────────────

describe("resolveCollisions", () => {
  test("skip removes agents", () => {
    const agents = [makeAgent({ name: "dev" }), makeAgent({ name: "critic" })];
    const collisions: AgentCollision[] = [
      { imported_name: "dev", existing_name: "dev", strategy: "skip", renamed_to: null },
    ];

    const resolved = resolveCollisions(agents, collisions);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].name).toBe("critic");
  });

  test("rename updates agent name", () => {
    const agents = [makeAgent({ name: "dev" })];
    const collisions: AgentCollision[] = [
      { imported_name: "dev", existing_name: "dev", strategy: "rename", renamed_to: "dev-2" },
    ];

    const resolved = resolveCollisions(agents, collisions);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].name).toBe("dev-2");
  });

  test("overwrite keeps imported agent as-is", () => {
    const agents = [makeAgent({ name: "dev" })];
    const collisions: AgentCollision[] = [
      { imported_name: "dev", existing_name: "dev", strategy: "overwrite", renamed_to: null },
    ];

    const resolved = resolveCollisions(agents, collisions);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].name).toBe("dev");
  });

  test("non-colliding agents pass through unchanged", () => {
    const agents = [makeAgent({ name: "dev" }), makeAgent({ name: "new-agent" })];
    const collisions: AgentCollision[] = [
      { imported_name: "dev", existing_name: "dev", strategy: "skip", renamed_to: null },
    ];

    const resolved = resolveCollisions(agents, collisions);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].name).toBe("new-agent");
  });

  test("rename with null renamed_to is treated as skip", () => {
    const agents = [makeAgent({ name: "dev" })];
    const collisions: AgentCollision[] = [
      { imported_name: "dev", existing_name: "dev", strategy: "rename", renamed_to: null },
    ];

    const resolved = resolveCollisions(agents, collisions);
    expect(resolved).toHaveLength(0);
  });
});

// ── generateUniqueName ──────────────────────────────────────

describe("generateUniqueName", () => {
  test("appends -2 when name exists", () => {
    const name = generateUniqueName("dev", new Set(["dev"]));
    expect(name).toBe("dev-2");
  });

  test("increments suffix until unique", () => {
    const name = generateUniqueName("dev", new Set(["dev", "dev-2", "dev-3"]));
    expect(name).toBe("dev-4");
  });

  test("starts at -2", () => {
    const name = generateUniqueName("agent", new Set(["agent"]));
    expect(name).toBe("agent-2");
  });
});

// ── validateImport ──────────────────────────────────────────

describe("validateImport", () => {
  test("valid import with no collisions", () => {
    const result = validateImport(makeManifest(), new Set(["strategy"]));
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.collisions).toHaveLength(0);
  });

  test("valid import with collisions", () => {
    const result = validateImport(makeManifest(), new Set(["dev"]));
    expect(result.valid).toBe(true);
    expect(result.collisions).toHaveLength(1);
    expect(result.collisions[0].imported_name).toBe("dev");
  });

  test("invalid manifest skips collision detection", () => {
    const m = makeManifest();
    m.formation.name = "";
    const result = validateImport(m, new Set(["dev"]));
    expect(result.valid).toBe(false);
    expect(result.collisions).toHaveLength(0); // Skipped
  });
});

// ── E2E: Round-Trip ─────────────────────────────────────────

describe("E2E: export -> scrub -> serialize -> deserialize -> validate -> import", () => {
  test("full round-trip with secrets scrubbed", () => {
    // Step 1: Build manifest with a secret in skill_md
    const manifest = buildManifest({
      name: "billing-ops",
      description: "Medical billing operations",
      skill_md: "---\nname: billing-ops\n---\n## Objective\nProcess claims\napi_key: sk-realkey123456789012345678901234",
      agents: [
        makeAgent({ name: "billing-lead", type: "finance", role: "lead" }),
        makeAgent({ name: "claims-processor", type: "finance", role: "processor" }),
      ],
      protocol: makeProtocol(),
      heartbeat: { schedule: "0 */6 * * *", enabled: true, run_context: {} },
    });

    // Step 2: Scrub secrets
    const { manifest: scrubbed, total_scrubbed } = scrubManifest(manifest);
    expect(total_scrubbed).toBeGreaterThan(0);
    expect(scrubbed.formation.skill_md).not.toContain("sk-realkey");

    // Step 3: Serialize
    const json = serializeManifest(scrubbed);
    expect(typeof json).toBe("string");

    // Step 4: Deserialize (simulating import on another instance)
    const imported = deserializeManifest(json);
    expect(imported).not.toBeNull();

    // Step 5: Validate manifest structure
    const manifestErrors = validateManifest(imported!);
    expect(manifestErrors).toHaveLength(0);

    // Step 6: Validate import with collision detection
    const existing = new Set(["billing-lead"]); // One collision
    const result = validateImport(imported!, existing);
    expect(result.valid).toBe(true);
    expect(result.collisions).toHaveLength(1);
    expect(result.collisions[0].imported_name).toBe("billing-lead");

    // Step 7: Resolve collision with rename
    const resolvedCollisions: AgentCollision[] = result.collisions.map(c => ({
      ...c,
      strategy: "rename" as const,
      renamed_to: generateUniqueName(c.imported_name, existing),
    }));

    const finalAgents = resolveCollisions(imported!.agents, resolvedCollisions);
    expect(finalAgents).toHaveLength(2);
    expect(finalAgents.find(a => a.name === "billing-lead-2")).toBeTruthy();
    expect(finalAgents.find(a => a.name === "claims-processor")).toBeTruthy();

    // Step 8: Verify formation name and content survived
    expect(imported!.formation.name).toBe("billing-ops");
    expect(imported!.heartbeat?.schedule).toBe("0 */6 * * *");
    expect(imported!.formation.skill_md).toContain("Process claims");
    expect(imported!.formation.skill_md).not.toContain("sk-realkey");
  });

  test("clean export with no secrets, no collisions", () => {
    const manifest = buildManifest({
      name: "think-tank",
      description: "Strategic think tank",
      skill_md: "---\nname: think-tank\n---\n## Objective\nThink deeply",
      agents: [makeAgent({ name: "strategy" }), makeAgent({ name: "research" })],
      protocol: makeProtocol({ coordinator: "strategy" }),
    });

    const { total_scrubbed } = scrubManifest(manifest);
    expect(total_scrubbed).toBe(0);

    const json = serializeManifest(manifest);
    const imported = deserializeManifest(json)!;
    const result = validateImport(imported, new Set([]));

    expect(result.valid).toBe(true);
    expect(result.collisions).toHaveLength(0);
  });
});
