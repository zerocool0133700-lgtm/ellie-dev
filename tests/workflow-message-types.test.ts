/**
 * ELLIE-832 + ELLIE-833: Archetype produces/consumes + message type generator tests
 */

import { describe, it, expect } from "bun:test";
import {
  parseArchetype,
  validateArchetype,
  MESSAGE_TYPES,
  type MessageType,
} from "../src/archetype-schema.ts";
import {
  extractContract,
  buildContractRegistry,
  validateSend,
  validateReceive,
  validateMessage,
  generateTypeScript,
  type AgentMessageContract,
} from "../src/workflow-message-types.ts";

// ── ELLIE-832: Archetype produces/consumes parsing ───────────────

describe("ELLIE-832: Archetype produces/consumes schema", () => {
  const VALID_ARCHETYPE = `---
species: ant
cognitive_style: "depth-first"
produces: [finding, recommendation, checkpoint]
consumes: [direction, approval, rejection]
---

## Cognitive Style
Depth-first focused.

## Communication
Clear and concise.

## Anti-Patterns
Never wander.
`;

  it("parses produces and consumes from frontmatter", () => {
    const schema = parseArchetype(VALID_ARCHETYPE);
    expect(schema).not.toBeNull();
    expect(schema!.frontmatter.produces).toEqual(["finding", "recommendation", "checkpoint"]);
    expect(schema!.frontmatter.consumes).toEqual(["direction", "approval", "rejection"]);
  });

  it("produces/consumes are optional", () => {
    const minimal = `---
species: ant
cognitive_style: "depth-first"
---

## Cognitive Style
Focused.

## Communication
Clear.

## Anti-Patterns
None.
`;
    const schema = parseArchetype(minimal);
    expect(schema).not.toBeNull();
    expect(schema!.frontmatter.produces).toBeUndefined();
    expect(schema!.frontmatter.consumes).toBeUndefined();
  });

  it("validates invalid message types in produces", () => {
    const bad = `---
species: ant
cognitive_style: "depth-first"
produces: [finding, invalid_type]
consumes: [direction]
---

## Cognitive Style
Test.

## Communication
Test.

## Anti-Patterns
Test.
`;
    const schema = parseArchetype(bad);
    expect(schema).not.toBeNull();
    const result = validateArchetype(schema!);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes("invalid_type"))).toBe(true);
  });

  it("validates invalid message types in consumes", () => {
    const bad = `---
species: ant
cognitive_style: "depth-first"
produces: [finding]
consumes: [direction, bogus]
---

## Cognitive Style
Test.

## Communication
Test.

## Anti-Patterns
Test.
`;
    const schema = parseArchetype(bad);
    const result = validateArchetype(schema!);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes("bogus"))).toBe(true);
  });

  it("MESSAGE_TYPES contains all expected types", () => {
    expect(MESSAGE_TYPES).toContain("finding");
    expect(MESSAGE_TYPES).toContain("recommendation");
    expect(MESSAGE_TYPES).toContain("direction");
    expect(MESSAGE_TYPES).toContain("approval");
    expect(MESSAGE_TYPES).toContain("escalation");
    expect(MESSAGE_TYPES).toContain("checkpoint");
    expect(MESSAGE_TYPES).toContain("handoff");
    expect(MESSAGE_TYPES.length).toBeGreaterThanOrEqual(10);
  });
});

// ── ELLIE-833: Message type schema generator ─────────────────────

describe("ELLIE-833: Message type schema generator", () => {
  const devSchema = parseArchetype(`---
species: ant
cognitive_style: "depth-first"
produces: [finding, recommendation, checkpoint]
consumes: [direction, approval]
---

## Cognitive Style
Test.

## Communication
Test.

## Anti-Patterns
Test.
`)!;

  const criticSchema = parseArchetype(`---
species: bee
cognitive_style: "cross-pollination"
produces: [review, rejection]
consumes: [direction, checkpoint]
---

## Cognitive Style
Test.

## Communication
Test.

## Anti-Patterns
Test.
`)!;

  describe("extractContract", () => {
    it("extracts contract from archetype schema", () => {
      const contract = extractContract(devSchema, "dev");
      expect(contract.agent).toBe("dev");
      expect(contract.species).toBe("ant");
      expect(contract.produces).toEqual(["finding", "recommendation", "checkpoint"]);
      expect(contract.consumes).toEqual(["direction", "approval"]);
    });
  });

  describe("buildContractRegistry", () => {
    it("builds registry from map of archetypes", () => {
      const archetypes = new Map([
        ["dev", devSchema],
        ["critic", criticSchema],
      ]);
      const registry = buildContractRegistry(archetypes);
      expect(registry.size).toBe(2);
      expect(registry.get("dev")!.produces).toContain("finding");
      expect(registry.get("critic")!.produces).toContain("review");
    });
  });

  describe("validateSend", () => {
    const registry = buildContractRegistry(new Map([
      ["dev", devSchema],
      ["critic", criticSchema],
    ]));

    it("allows agent to send declared produce type", () => {
      expect(validateSend(registry, "dev", "finding").valid).toBe(true);
    });

    it("denies agent sending undeclared type", () => {
      const result = validateSend(registry, "dev", "review");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("cannot produce");
    });

    it("denies unknown agent", () => {
      const result = validateSend(registry, "unknown", "finding");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Unknown agent");
    });
  });

  describe("validateReceive", () => {
    const registry = buildContractRegistry(new Map([
      ["dev", devSchema],
      ["critic", criticSchema],
    ]));

    it("allows agent to receive declared consume type", () => {
      expect(validateReceive(registry, "dev", "direction").valid).toBe(true);
    });

    it("denies agent receiving undeclared type", () => {
      const result = validateReceive(registry, "dev", "review");
      expect(result.valid).toBe(false);
    });
  });

  describe("validateMessage", () => {
    const registry = buildContractRegistry(new Map([
      ["dev", devSchema],
      ["critic", criticSchema],
    ]));

    it("validates full message (sender produces + receiver consumes)", () => {
      // dev produces checkpoint, critic consumes checkpoint
      expect(validateMessage(registry, "dev", "critic", "checkpoint").valid).toBe(true);
    });

    it("rejects if sender cannot produce", () => {
      // dev cannot produce review
      expect(validateMessage(registry, "dev", "critic", "review").valid).toBe(false);
    });

    it("rejects if receiver cannot consume", () => {
      // critic cannot consume recommendation
      const result = validateMessage(registry, "dev", "critic", "recommendation");
      expect(result.valid).toBe(false);
    });
  });

  describe("generateTypeScript", () => {
    it("generates valid TypeScript code", () => {
      const registry = buildContractRegistry(new Map([
        ["dev", devSchema],
        ["critic", criticSchema],
      ]));
      const code = generateTypeScript(registry);

      expect(code).toContain("DevProduces");
      expect(code).toContain("CriticProduces");
      expect(code).toContain("AGENT_CONTRACTS");
      expect(code).toContain("MessageType");
      expect(code).toContain('"finding"');
    });
  });
});
