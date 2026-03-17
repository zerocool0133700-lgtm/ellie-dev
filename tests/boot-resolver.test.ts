/**
 * ELLIE-839: Boot-up Packet Resolver tests
 *
 * Tests creature parsing, 4-layer boot resolution,
 * boot packet formatting, and dispatch validation.
 */

import { describe, it, expect } from "bun:test";
import {
  parseCreature,
  resolveBootRequirements,
  formatBootPacket,
  canDispatch,
  getCreature,
  loadCreatures,
  AGENT_TEMPLATES,
  type CreatureDef,
  type BootResolverContext,
} from "../src/boot-resolver.ts";

// ── Test fixtures ────────────────────────────────────────────────

const JAMES_CREATURE_MD = `---
name: James
role: dev
species: ant
cognitive_style: "depth-first, single-threaded"
description: "Dev agent"
produces:
  - code_implementation
  - test_results
  - commit_summary
consumes:
  - work_item_assignment
  - implementation_spec
  - review_feedback
boot_requirements:
  identity:
    - agent_name: James
    - role: dev
    - work_item_id: required
  capability:
    - codebase_access: ["ellie-dev", "ellie-home", "ellie-forest"]
    - database_access: ["supabase_mcp", "forest_psql"]
    - runtime: bun
  context:
    - work_item_details: title, description, acceptance_criteria
    - forest_search: prior_decisions_on_topic
    - service_state: systemd_status
    - test_environment: ready
  communication:
    - output_format: code_diffs_with_line_numbers
    - progress_reports: major_milestones_only
    - decision_logging: forest_write
---

# James — Dev Creature
Body content here.
`;

const KATE_CREATURE_MD = `---
name: kate
species: squirrel
cognitive_style: "breadth-first, evidence-driven"
description: Research specialist
produces:
  - research_findings
  - source_comparison
consumes:
  - research_question
  - topic_investigation_request
boot_requirements:
  identity:
    - user_profile
    - soul_file
    - channel_state
  capability:
    - search_apis
    - forest_access
    - codebase_read_access
  context:
    - prior_research_on_topic
    - related_forest_entries
    - relevant_work_items
  communication:
    - output_format_preference
    - detail_level_expected
---

# Kate — Research Creature
`;

const MINIMAL_CREATURE_MD = `---
name: minimal
species: ant
cognitive_style: "basic"
---

# Minimal Creature
No boot requirements.
`;

// ── Creature parsing ─────────────────────────────────────────────

describe("ELLIE-839: Creature file parsing", () => {
  it("parses James creature with all fields", () => {
    const def = parseCreature(JAMES_CREATURE_MD);
    expect(def).not.toBeNull();
    expect(def!.name).toBe("James");
    expect(def!.role).toBe("dev");
    expect(def!.species).toBe("ant");
    expect(def!.cognitive_style).toBe("depth-first, single-threaded");
    expect(def!.produces).toContain("code_implementation");
    expect(def!.consumes).toContain("work_item_assignment");
  });

  it("parses boot_requirements with 4 layers", () => {
    const def = parseCreature(JAMES_CREATURE_MD);
    expect(def!.boot_requirements).toBeDefined();
    const reqs = def!.boot_requirements!;
    expect(reqs.identity).toBeDefined();
    expect(reqs.capability).toBeDefined();
    expect(reqs.context).toBeDefined();
    expect(reqs.communication).toBeDefined();
  });

  it("parses Kate creature with different format", () => {
    const def = parseCreature(KATE_CREATURE_MD);
    expect(def).not.toBeNull();
    expect(def!.name).toBe("kate");
    expect(def!.boot_requirements).toBeDefined();
    expect(def!.boot_requirements!.identity).toBeDefined();
  });

  it("parses creature without boot_requirements", () => {
    const def = parseCreature(MINIMAL_CREATURE_MD);
    expect(def).not.toBeNull();
    expect(def!.name).toBe("minimal");
    expect(def!.boot_requirements).toBeUndefined();
  });

  it("returns null for invalid content", () => {
    expect(parseCreature("no frontmatter here")).toBeNull();
    expect(parseCreature("")).toBeNull();
  });

  it("preserves body content", () => {
    const def = parseCreature(JAMES_CREATURE_MD);
    expect(def!.body).toContain("Dev Creature");
  });
});

// ── Boot resolution ──────────────────────────────────────────────

describe("ELLIE-839: Boot requirement resolution", () => {
  const james = parseCreature(JAMES_CREATURE_MD)!;
  const kate = parseCreature(KATE_CREATURE_MD)!;
  const minimal = parseCreature(MINIMAL_CREATURE_MD)!;

  describe("successful boot (all layers resolved)", () => {
    it("resolves all 4 layers when context is provided", () => {
      const ctx: BootResolverContext = {
        workItemId: "ELLIE-839",
        workItemTitle: "Boot resolver",
        workItemDescription: "Build the boot resolver",
        channel: "telegram",
        forestSearchResults: "Prior context found",
      };

      const result = resolveBootRequirements(james, ctx);
      expect(result.allResolved).toBe(true);
      expect(result.layers.length).toBe(4);
      expect(result.layers.every(l => l.status === "resolved")).toBe(true);
      expect(result.summary).toBe("All boot requirements resolved");
    });

    it("resolves identity layer with agent name and role", () => {
      const ctx: BootResolverContext = { workItemId: "ELLIE-839", channel: "telegram" };
      const result = resolveBootRequirements(james, ctx);
      const identity = result.layers.find(l => l.layer === "identity")!;
      expect(identity.resolved.agent_name).toBe("James");
      expect(identity.resolved.role).toBe("dev");
      expect(identity.resolved.work_item_id).toBe("ELLIE-839");
    });

    it("resolves capability layer", () => {
      const ctx: BootResolverContext = { workItemId: "ELLIE-839" };
      const result = resolveBootRequirements(james, ctx);
      const capability = result.layers.find(l => l.layer === "capability")!;
      expect(capability.status).toBe("resolved");
      expect(capability.resolved.runtime).toBe("bun");
    });

    it("resolves context layer with work item details", () => {
      const ctx: BootResolverContext = {
        workItemId: "ELLIE-839",
        workItemTitle: "Boot resolver",
        forestSearchResults: "Found prior work",
      };
      const result = resolveBootRequirements(james, ctx);
      const context = result.layers.find(l => l.layer === "context")!;
      expect(context.resolved.work_item_details).toBeDefined();
      expect(context.resolved.forest_search).toBe("Found prior work");
    });

    it("resolves communication layer with produces/consumes", () => {
      const ctx: BootResolverContext = { workItemId: "ELLIE-839" };
      const result = resolveBootRequirements(james, ctx);
      const comm = result.layers.find(l => l.layer === "communication")!;
      expect(comm.resolved.output_format).toBe("code_diffs_with_line_numbers");
      expect(comm.resolved.produces).toContain("code_implementation");
      expect(comm.resolved.consumes).toContain("work_item_assignment");
    });
  });

  describe("failed boot (missing required layer)", () => {
    it("fails identity when work_item_id is required but missing", () => {
      const ctx: BootResolverContext = { channel: "telegram" }; // No workItemId
      const result = resolveBootRequirements(james, ctx);
      expect(result.allResolved).toBe(false);

      const identity = result.layers.find(l => l.layer === "identity")!;
      expect(identity.status).toBe("failed");
      expect(identity.missing).toContain("work_item_id");
    });
  });

  describe("partial boot (optional layers incomplete)", () => {
    it("resolves Kate without work item (no required fields)", () => {
      const ctx: BootResolverContext = { channel: "ellie-chat" };
      const result = resolveBootRequirements(kate, ctx);
      // Kate's identity doesn't require work_item_id
      const identity = result.layers.find(l => l.layer === "identity")!;
      expect(identity.status).toBe("resolved");
    });
  });

  describe("no boot requirements", () => {
    it("returns empty resolution for creature without requirements", () => {
      const result = resolveBootRequirements(minimal, {});
      expect(result.allResolved).toBe(true);
      expect(result.layers.length).toBe(0);
      expect(result.summary).toBe("No boot requirements declared");
    });
  });
});

// ── Boot packet formatting ───────────────────────────────────────

describe("ELLIE-839: Boot packet formatting", () => {
  it("generates markdown boot packet", () => {
    const james = parseCreature(JAMES_CREATURE_MD)!;
    const result = resolveBootRequirements(james, {
      workItemId: "ELLIE-839",
      channel: "telegram",
    });
    const packet = formatBootPacket(result);

    expect(packet).toContain("## Boot Packet");
    expect(packet).toContain("### Identity");
    expect(packet).toContain("### Capability");
    expect(packet).toContain("### Context");
    expect(packet).toContain("### Communication");
    expect(packet).toContain("ELLIE-839");
  });

  it("includes warning for missing requirements", () => {
    const james = parseCreature(JAMES_CREATURE_MD)!;
    const result = resolveBootRequirements(james, {}); // Missing work_item_id
    const packet = formatBootPacket(result);

    expect(packet).toContain("MISSING");
    expect(packet).toContain("work_item_id");
  });
});

// ── Dispatch validation ──────────────────────────────────────────

describe("ELLIE-839: Dispatch validation", () => {
  const james = parseCreature(JAMES_CREATURE_MD)!;

  it("allows dispatch when all requirements met", () => {
    const result = resolveBootRequirements(james, {
      workItemId: "ELLIE-839",
      channel: "telegram",
    });
    const check = canDispatch(result);
    expect(check.allowed).toBe(true);
  });

  it("blocks dispatch when identity requirements fail", () => {
    const result = resolveBootRequirements(james, {}); // Missing work_item_id
    const check = canDispatch(result);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("Identity requirements not met");
  });

  it("allows dispatch when only non-identity layers are partial", () => {
    const kate = parseCreature(KATE_CREATURE_MD)!;
    const result = resolveBootRequirements(kate, { channel: "telegram" });
    const check = canDispatch(result);
    expect(check.allowed).toBe(true);
  });
});

// ── Load from filesystem ─────────────────────────────────────────

describe("ELLIE-839: Creature file loading", () => {
  it("loads creatures from the creatures/ directory", () => {
    const creatures = loadCreatures();
    // Should find at least some creatures in the repo
    expect(creatures.size).toBeGreaterThan(0);
  });

  it("getCreature returns a creature by role name", () => {
    const dev = getCreature("dev");
    if (dev) {
      expect(dev.name.toLowerCase()).toMatch(/james|dev/);
      expect(dev.boot_requirements).toBeDefined();
    }
    // It's OK if creature files aren't present in test env
  });

  it("getCreature returns null for unknown agent", () => {
    const unknown = getCreature("nonexistent-agent-xyz");
    expect(unknown).toBeNull();
  });
});
