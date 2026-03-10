/**
 * Mountain Entity Extraction Tests — ELLIE-662
 *
 * Tests entity types, validation, Claude extractor, identity resolution,
 * extraction pipeline, prompt building, and River document generation.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  ClaudeEntityExtractor,
  IdentityResolver,
  ExtractionPipeline,
  buildExtractionPrompt,
  parseExtractionResponse,
  validateEntity,
  getContentFromRecord,
  buildEntityDocument,
  normalizeName,
  _makeMockRecordForExtraction,
  _makeMockClaudeCallFn,
  _makeMockClaudeCallFnError,
  type ExtractedEntity,
  type PersonEntity,
  type TopicEntity,
  type ActionItemEntity,
  type DecisionEntity,
  type ExtractionResult,
  type ClaudeCallFn,
} from "../src/mountain/entity-extraction.ts";
import type { MountainRecord } from "../src/mountain/records.ts";

// ── Test Data ───────────────────────────────────────────────

const SAMPLE_ENTITIES: ExtractedEntity[] = [
  {
    type: "person",
    name: "Dave",
    role: "mentioned",
    identifiers: [{ channel: "telegram", value: "12345" }],
    confidence: 0.9,
  },
  {
    type: "person",
    name: "Wincy",
    role: "recipient",
    identifiers: [],
    confidence: 0.85,
  },
  {
    type: "topic",
    label: "Q2 report",
    description: "Quarterly report discussion",
    confidence: 0.8,
  },
  {
    type: "action_item",
    description: "Send the Q2 report to Wincy",
    assignee: "Dave",
    dueDate: "Friday",
    priority: "high",
    confidence: 0.75,
  },
  {
    type: "decision",
    description: "Use the new template for Q2 report",
    rationale: "Better formatting",
    confidence: 0.7,
  },
];

// ── validateEntity ──────────────────────────────────────────

describe("validateEntity", () => {
  test("validates a person entity", () => {
    const entity = validateEntity({
      type: "person",
      name: "Dave",
      role: "sender",
      identifiers: [{ channel: "telegram", value: "12345" }],
      confidence: 0.9,
    });
    expect(entity).not.toBeNull();
    expect(entity!.type).toBe("person");
    expect((entity as PersonEntity).name).toBe("Dave");
    expect((entity as PersonEntity).role).toBe("sender");
    expect((entity as PersonEntity).identifiers).toHaveLength(1);
  });

  test("validates a topic entity", () => {
    const entity = validateEntity({
      type: "topic",
      label: "project deadline",
      description: "Discussion about Q2 deadline",
      confidence: 0.8,
    });
    expect(entity).not.toBeNull();
    expect(entity!.type).toBe("topic");
    expect((entity as TopicEntity).label).toBe("project deadline");
  });

  test("validates an action item entity", () => {
    const entity = validateEntity({
      type: "action_item",
      description: "Send report",
      assignee: "Dave",
      priority: "high",
      confidence: 0.7,
    });
    expect(entity).not.toBeNull();
    expect(entity!.type).toBe("action_item");
    expect((entity as ActionItemEntity).assignee).toBe("Dave");
    expect((entity as ActionItemEntity).priority).toBe("high");
  });

  test("validates a decision entity", () => {
    const entity = validateEntity({
      type: "decision",
      description: "Using PostgreSQL",
      rationale: "Better for relational data",
      decider: "Dave",
      confidence: 0.85,
    });
    expect(entity).not.toBeNull();
    expect(entity!.type).toBe("decision");
    expect((entity as DecisionEntity).rationale).toBe("Better for relational data");
  });

  test("rejects null/undefined", () => {
    expect(validateEntity(null)).toBeNull();
    expect(validateEntity(undefined)).toBeNull();
  });

  test("rejects non-object", () => {
    expect(validateEntity("string")).toBeNull();
    expect(validateEntity(42)).toBeNull();
  });

  test("rejects unknown entity type", () => {
    expect(
      validateEntity({ type: "unknown", confidence: 0.5 }),
    ).toBeNull();
  });

  test("rejects invalid confidence", () => {
    expect(
      validateEntity({ type: "topic", label: "test", confidence: 1.5 }),
    ).toBeNull();
    expect(
      validateEntity({ type: "topic", label: "test", confidence: -0.1 }),
    ).toBeNull();
    expect(
      validateEntity({ type: "topic", label: "test", confidence: "high" }),
    ).toBeNull();
  });

  test("rejects person with invalid role", () => {
    expect(
      validateEntity({
        type: "person",
        name: "Dave",
        role: "invalid",
        identifiers: [],
        confidence: 0.9,
      }),
    ).toBeNull();
  });

  test("rejects person without name", () => {
    expect(
      validateEntity({
        type: "person",
        name: "",
        role: "sender",
        identifiers: [],
        confidence: 0.9,
      }),
    ).toBeNull();
  });

  test("rejects topic without label", () => {
    expect(
      validateEntity({ type: "topic", label: "", confidence: 0.8 }),
    ).toBeNull();
  });

  test("rejects action item without description", () => {
    expect(
      validateEntity({ type: "action_item", description: "", confidence: 0.7 }),
    ).toBeNull();
  });

  test("rejects decision without description", () => {
    expect(
      validateEntity({ type: "decision", description: "", confidence: 0.7 }),
    ).toBeNull();
  });

  test("handles person with invalid identifiers gracefully", () => {
    const entity = validateEntity({
      type: "person",
      name: "Dave",
      role: "sender",
      identifiers: [{ bad: true }, { channel: "telegram", value: "123" }],
      confidence: 0.9,
    });
    expect(entity).not.toBeNull();
    expect((entity as PersonEntity).identifiers).toHaveLength(1);
  });

  test("handles action item with invalid priority", () => {
    const entity = validateEntity({
      type: "action_item",
      description: "Do something",
      priority: "urgent",
      confidence: 0.7,
    });
    expect(entity).not.toBeNull();
    expect((entity as ActionItemEntity).priority).toBeUndefined();
  });

  test("handles optional fields being absent", () => {
    const topic = validateEntity({
      type: "topic",
      label: "test",
      confidence: 0.8,
    });
    expect(topic).not.toBeNull();
    expect((topic as TopicEntity).description).toBeUndefined();

    const action = validateEntity({
      type: "action_item",
      description: "do it",
      confidence: 0.7,
    });
    expect(action).not.toBeNull();
    expect((action as ActionItemEntity).assignee).toBeUndefined();
    expect((action as ActionItemEntity).dueDate).toBeUndefined();
    expect((action as ActionItemEntity).priority).toBeUndefined();

    const decision = validateEntity({
      type: "decision",
      description: "chose A",
      confidence: 0.8,
    });
    expect(decision).not.toBeNull();
    expect((decision as DecisionEntity).rationale).toBeUndefined();
    expect((decision as DecisionEntity).decider).toBeUndefined();
  });
});

// ── parseExtractionResponse ─────────────────────────────────

describe("parseExtractionResponse", () => {
  test("parses valid JSON array", () => {
    const raw = JSON.stringify(SAMPLE_ENTITIES);
    const entities = parseExtractionResponse(raw, 0.0);
    expect(entities).toHaveLength(5);
  });

  test("filters by minimum confidence", () => {
    const raw = JSON.stringify(SAMPLE_ENTITIES);
    const entities = parseExtractionResponse(raw, 0.8);
    expect(entities).toHaveLength(3); // Dave (0.9), Wincy (0.85), topic (0.8)
  });

  test("handles markdown-wrapped JSON", () => {
    const raw = `Here are the entities:\n\`\`\`json\n${JSON.stringify(SAMPLE_ENTITIES)}\n\`\`\``;
    const entities = parseExtractionResponse(raw, 0.0);
    expect(entities).toHaveLength(5);
  });

  test("returns empty array for no JSON", () => {
    expect(parseExtractionResponse("No entities found.", 0.0)).toEqual([]);
  });

  test("returns empty array for invalid JSON", () => {
    expect(parseExtractionResponse("[{broken json", 0.0)).toEqual([]);
  });

  test("returns empty array for empty array", () => {
    expect(parseExtractionResponse("[]", 0.0)).toEqual([]);
  });

  test("skips invalid entities in the array", () => {
    const raw = JSON.stringify([
      { type: "person", name: "Dave", role: "sender", identifiers: [], confidence: 0.9 },
      { type: "invalid", confidence: 0.5 },
      { type: "topic", label: "test", confidence: 0.8 },
    ]);
    const entities = parseExtractionResponse(raw, 0.0);
    expect(entities).toHaveLength(2);
  });
});

// ── getContentFromRecord ────────────────────────────────────

describe("getContentFromRecord", () => {
  test("extracts content from payload", () => {
    const record = _makeMockRecordForExtraction({
      payload: { content: "Hello world" },
    });
    expect(getContentFromRecord(record)).toBe("Hello world");
  });

  test("falls back to summary", () => {
    const record = _makeMockRecordForExtraction({
      payload: {},
      summary: "Test summary",
    });
    expect(getContentFromRecord(record)).toBe("Test summary");
  });

  test("returns empty string when no content", () => {
    const record = _makeMockRecordForExtraction({
      payload: {},
      summary: null,
    });
    expect(getContentFromRecord(record)).toBe("");
  });
});

// ── normalizeName ───────────────────────────────────────────

describe("normalizeName", () => {
  test("lowercases name", () => {
    expect(normalizeName("Dave")).toBe("dave");
  });

  test("trims whitespace", () => {
    expect(normalizeName("  Dave  ")).toBe("dave");
  });

  test("collapses multiple spaces", () => {
    expect(normalizeName("Dave   Smith")).toBe("dave smith");
  });
});

// ── buildExtractionPrompt ───────────────────────────────────

describe("buildExtractionPrompt", () => {
  test("includes message content", () => {
    const record = _makeMockRecordForExtraction();
    const prompt = buildExtractionPrompt(record, ["person", "topic"]);
    expect(prompt).toContain("Q2 report");
  });

  test("includes source context", () => {
    const record = _makeMockRecordForExtraction();
    const prompt = buildExtractionPrompt(record, ["person"]);
    expect(prompt).toContain("relay");
    expect(prompt).toContain("telegram");
  });

  test("includes requested entity types", () => {
    const record = _makeMockRecordForExtraction();
    const prompt = buildExtractionPrompt(record, ["person", "action_item"]);
    expect(prompt).toContain("Person");
    expect(prompt).toContain("Action Item");
    expect(prompt).not.toContain("**Topic**");
  });

  test("includes output format examples", () => {
    const record = _makeMockRecordForExtraction();
    const prompt = buildExtractionPrompt(record, ["person", "topic", "action_item", "decision"]);
    expect(prompt).toContain("JSON array");
    expect(prompt).toContain("confidence");
  });
});

// ── ClaudeEntityExtractor ───────────────────────────────────

describe("ClaudeEntityExtractor", () => {
  test("extracts entities from a record", async () => {
    const callFn = _makeMockClaudeCallFn(SAMPLE_ENTITIES);
    const extractor = new ClaudeEntityExtractor(callFn);
    const record = _makeMockRecordForExtraction();

    const result = await extractor.extract(record);
    expect(result.skipped).toBe(false);
    expect(result.entities).toHaveLength(5);
    expect(result.mountainRecordId).toBe(record.id);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("skips content below minimum length", async () => {
    const callFn = _makeMockClaudeCallFn(SAMPLE_ENTITIES);
    const extractor = new ClaudeEntityExtractor(callFn, { minContentLength: 200 });
    const record = _makeMockRecordForExtraction({
      payload: { content: "Short" },
    });

    const result = await extractor.extract(record);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain("too short");
    expect(result.entities).toHaveLength(0);
  });

  test("skips disabled sources", async () => {
    const callFn = _makeMockClaudeCallFn(SAMPLE_ENTITIES);
    const extractor = new ClaudeEntityExtractor(callFn, {
      disabledSources: ["relay"],
    });
    const record = _makeMockRecordForExtraction({ source_system: "relay" });

    const result = await extractor.extract(record);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain("disabled");
  });

  test("filters entities below minimum confidence", async () => {
    const callFn = _makeMockClaudeCallFn(SAMPLE_ENTITIES);
    const extractor = new ClaudeEntityExtractor(callFn, { minConfidence: 0.8 });
    const record = _makeMockRecordForExtraction();

    const result = await extractor.extract(record);
    expect(result.entities.length).toBeLessThan(SAMPLE_ENTITIES.length);
    for (const entity of result.entities) {
      expect(entity.confidence).toBeGreaterThanOrEqual(0.8);
    }
  });

  test("handles API error gracefully", async () => {
    const callFn = _makeMockClaudeCallFnError("API rate limited");
    const extractor = new ClaudeEntityExtractor(callFn);
    const record = _makeMockRecordForExtraction();

    const result = await extractor.extract(record);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain("API rate limited");
    expect(result.entities).toHaveLength(0);
  });

  test("handles malformed API response", async () => {
    const callFn: ClaudeCallFn = async () => "Not JSON at all";
    const extractor = new ClaudeEntityExtractor(callFn);
    const record = _makeMockRecordForExtraction();

    const result = await extractor.extract(record);
    expect(result.skipped).toBe(false);
    expect(result.entities).toHaveLength(0);
  });

  test("uses default config values", async () => {
    const callFn = _makeMockClaudeCallFn([]);
    const extractor = new ClaudeEntityExtractor(callFn);
    const record = _makeMockRecordForExtraction({
      payload: { content: "A" }, // 1 char — below default min of 10
    });

    const result = await extractor.extract(record);
    expect(result.skipped).toBe(true);
  });
});

// ── IdentityResolver ────────────────────────────────────────

describe("IdentityResolver", () => {
  let resolver: IdentityResolver;

  beforeEach(() => {
    resolver = new IdentityResolver();
  });

  test("creates new profile for unknown person", () => {
    const name = resolver.resolve({
      type: "person",
      name: "Dave",
      role: "sender",
      identifiers: [{ channel: "telegram", value: "12345" }],
      confidence: 0.9,
    });
    expect(name).toBe("Dave");
    expect(resolver.profileCount).toBe(1);
  });

  test("matches by identifier across channels", () => {
    // First mention on telegram
    resolver.resolve({
      type: "person",
      name: "Dave",
      role: "sender",
      identifiers: [{ channel: "telegram", value: "12345" }],
      confidence: 0.9,
    });

    // Same person on gchat with same telegram ID
    const name = resolver.resolve({
      type: "person",
      name: "David",
      role: "sender",
      identifiers: [
        { channel: "telegram", value: "12345" },
        { channel: "google-chat", value: "dave@example.com" },
      ],
      confidence: 0.85,
    });

    expect(name).toBe("Dave"); // Canonical name from first encounter
    expect(resolver.profileCount).toBe(1); // Same profile
    const profile = resolver.findByIdentifier({
      channel: "google-chat",
      value: "dave@example.com",
    });
    expect(profile).not.toBeNull();
    expect(profile!.identifiers).toHaveLength(2);
  });

  test("matches by name when no identifier match", () => {
    resolver.resolve({
      type: "person",
      name: "Wincy",
      role: "mentioned",
      identifiers: [],
      confidence: 0.8,
    });

    const name = resolver.resolve({
      type: "person",
      name: "Wincy",
      role: "mentioned",
      identifiers: [{ channel: "telegram", value: "67890" }],
      confidence: 0.7,
    });

    expect(name).toBe("Wincy");
    expect(resolver.profileCount).toBe(1);
    const profile = resolver.findByName("Wincy");
    expect(profile!.identifiers).toHaveLength(1);
  });

  test("creates separate profiles for different people", () => {
    resolver.resolve({
      type: "person",
      name: "Dave",
      role: "sender",
      identifiers: [{ channel: "telegram", value: "12345" }],
      confidence: 0.9,
    });
    resolver.resolve({
      type: "person",
      name: "Wincy",
      role: "mentioned",
      identifiers: [{ channel: "telegram", value: "67890" }],
      confidence: 0.85,
    });

    expect(resolver.profileCount).toBe(2);
  });

  test("getProfiles returns all profiles", () => {
    resolver.resolve({
      type: "person",
      name: "Dave",
      role: "sender",
      identifiers: [],
      confidence: 0.9,
    });
    resolver.resolve({
      type: "person",
      name: "Wincy",
      role: "mentioned",
      identifiers: [],
      confidence: 0.85,
    });

    const profiles = resolver.getProfiles();
    expect(profiles).toHaveLength(2);
  });

  test("findByName is case insensitive", () => {
    resolver.resolve({
      type: "person",
      name: "Dave Smith",
      role: "sender",
      identifiers: [],
      confidence: 0.9,
    });

    expect(resolver.findByName("dave smith")).not.toBeNull();
    expect(resolver.findByName("DAVE SMITH")).not.toBeNull();
    expect(resolver.findByName("  Dave  Smith  ")).not.toBeNull();
  });

  test("clear removes all profiles", () => {
    resolver.resolve({
      type: "person",
      name: "Dave",
      role: "sender",
      identifiers: [],
      confidence: 0.9,
    });
    expect(resolver.profileCount).toBe(1);

    resolver.clear();
    expect(resolver.profileCount).toBe(0);
  });

  test("does not duplicate identifiers on re-resolve", () => {
    const person: PersonEntity = {
      type: "person",
      name: "Dave",
      role: "sender",
      identifiers: [{ channel: "telegram", value: "12345" }],
      confidence: 0.9,
    };

    resolver.resolve(person);
    resolver.resolve(person);

    const profile = resolver.findByName("Dave");
    expect(profile!.identifiers).toHaveLength(1);
  });
});

// ── ExtractionPipeline ──────────────────────────────────────

describe("ExtractionPipeline", () => {
  test("processes a record through extraction", async () => {
    const callFn = _makeMockClaudeCallFn(SAMPLE_ENTITIES);
    const extractor = new ClaudeEntityExtractor(callFn);
    const pipeline = new ExtractionPipeline(extractor);
    const record = _makeMockRecordForExtraction();

    const result = await pipeline.process(record);
    expect(result.skipped).toBe(false);
    expect(result.entities).toHaveLength(5);
  });

  test("resolves person identities during processing", async () => {
    const callFn = _makeMockClaudeCallFn(SAMPLE_ENTITIES);
    const extractor = new ClaudeEntityExtractor(callFn);
    const pipeline = new ExtractionPipeline(extractor);
    const record = _makeMockRecordForExtraction();

    await pipeline.process(record);

    const resolver = pipeline.getResolver();
    expect(resolver.profileCount).toBe(2); // Dave + Wincy
  });

  test("skips disabled sources", async () => {
    const callFn = _makeMockClaudeCallFn(SAMPLE_ENTITIES);
    const extractor = new ClaudeEntityExtractor(callFn);
    const pipeline = new ExtractionPipeline(extractor);

    pipeline.enableSource("github");
    // "relay" is not enabled

    const record = _makeMockRecordForExtraction({ source_system: "relay" });
    const result = await pipeline.process(record);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain("disabled");
  });

  test("enableAllSources allows all sources", async () => {
    const callFn = _makeMockClaudeCallFn(SAMPLE_ENTITIES);
    const extractor = new ClaudeEntityExtractor(callFn);
    const pipeline = new ExtractionPipeline(extractor);

    // Switch to selective mode then back
    pipeline.enableSource("github");
    pipeline.enableAllSources();

    const record = _makeMockRecordForExtraction({ source_system: "relay" });
    const result = await pipeline.process(record);
    expect(result.skipped).toBe(false);
  });

  test("disableSource removes from enabled set", () => {
    const callFn = _makeMockClaudeCallFn([]);
    const extractor = new ClaudeEntityExtractor(callFn);
    const pipeline = new ExtractionPipeline(extractor);

    pipeline.enableSource("relay");
    pipeline.enableSource("github");
    expect(pipeline.isSourceEnabled("relay")).toBe(true);

    pipeline.disableSource("relay");
    expect(pipeline.isSourceEnabled("relay")).toBe(false);
    expect(pipeline.isSourceEnabled("github")).toBe(true);
  });

  test("processBatch handles multiple records", async () => {
    const callFn = _makeMockClaudeCallFn(SAMPLE_ENTITIES);
    const extractor = new ClaudeEntityExtractor(callFn);
    const pipeline = new ExtractionPipeline(extractor);

    const records = [
      _makeMockRecordForExtraction(),
      _makeMockRecordForExtraction(),
      _makeMockRecordForExtraction(),
    ];

    const results = await pipeline.processBatch(records);
    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.skipped).toBe(false);
      expect(result.entities).toHaveLength(5);
    }
  });

  test("processBatch accumulates identity profiles", async () => {
    // Each call returns different people
    let callCount = 0;
    const callFn: ClaudeCallFn = async () => {
      callCount++;
      if (callCount === 1) {
        return JSON.stringify([
          { type: "person", name: "Dave", role: "sender", identifiers: [{ channel: "telegram", value: "111" }], confidence: 0.9 },
        ]);
      }
      return JSON.stringify([
        { type: "person", name: "Wincy", role: "sender", identifiers: [{ channel: "telegram", value: "222" }], confidence: 0.9 },
      ]);
    };

    const extractor = new ClaudeEntityExtractor(callFn);
    const pipeline = new ExtractionPipeline(extractor);

    await pipeline.processBatch([
      _makeMockRecordForExtraction(),
      _makeMockRecordForExtraction(),
    ]);

    expect(pipeline.getResolver().profileCount).toBe(2);
  });

  test("uses custom identity resolver if provided", async () => {
    const callFn = _makeMockClaudeCallFn(SAMPLE_ENTITIES);
    const extractor = new ClaudeEntityExtractor(callFn);
    const customResolver = new IdentityResolver();

    // Pre-populate with a known identity
    customResolver.resolve({
      type: "person",
      name: "Dave",
      role: "sender",
      identifiers: [{ channel: "email", value: "dave@example.com" }],
      confidence: 1.0,
    });

    const pipeline = new ExtractionPipeline(extractor, customResolver);
    const record = _makeMockRecordForExtraction();

    await pipeline.process(record);

    // Dave should have merged identifiers (email + telegram)
    const profile = customResolver.findByName("Dave");
    expect(profile).not.toBeNull();
    expect(profile!.identifiers.length).toBeGreaterThanOrEqual(2);
  });
});

// ── buildEntityDocument ─────────────────────────────────────

describe("buildEntityDocument", () => {
  test("builds path with source and date", () => {
    const record = _makeMockRecordForExtraction();
    const result: ExtractionResult = {
      mountainRecordId: record.id,
      entities: SAMPLE_ENTITIES,
      durationMs: 42,
      skipped: false,
    };

    const doc = buildEntityDocument(record, result);
    expect(doc.path).toContain("mountain/entities/relay/");
    expect(doc.path).toContain("2026-03-10");
    expect(doc.path).toEndWith(".json.md");
  });

  test("includes entity count in frontmatter", () => {
    const record = _makeMockRecordForExtraction();
    const result: ExtractionResult = {
      mountainRecordId: record.id,
      entities: SAMPLE_ENTITIES,
      durationMs: 42,
      skipped: false,
    };

    const doc = buildEntityDocument(record, result);
    expect(doc.frontmatter.entity_count).toBe(5);
    expect(doc.frontmatter.mountain_record_id).toBe(record.id);
    expect(doc.frontmatter.source_system).toBe("relay");
  });

  test("includes entity types in frontmatter", () => {
    const record = _makeMockRecordForExtraction();
    const result: ExtractionResult = {
      mountainRecordId: record.id,
      entities: SAMPLE_ENTITIES,
      durationMs: 42,
      skipped: false,
    };

    const doc = buildEntityDocument(record, result);
    const types = doc.frontmatter.entity_types as string[];
    expect(types).toContain("person");
    expect(types).toContain("topic");
    expect(types).toContain("action_item");
    expect(types).toContain("decision");
  });

  test("groups entities by type in markdown", () => {
    const record = _makeMockRecordForExtraction();
    const result: ExtractionResult = {
      mountainRecordId: record.id,
      entities: SAMPLE_ENTITIES,
      durationMs: 42,
      skipped: false,
    };

    const doc = buildEntityDocument(record, result);
    expect(doc.content).toContain("## Persons");
    expect(doc.content).toContain("## Topics");
    expect(doc.content).toContain("## Action items");
    expect(doc.content).toContain("## Decisions");
  });

  test("handles empty entities", () => {
    const record = _makeMockRecordForExtraction();
    const result: ExtractionResult = {
      mountainRecordId: record.id,
      entities: [],
      durationMs: 5,
      skipped: false,
    };

    const doc = buildEntityDocument(record, result);
    expect(doc.frontmatter.entity_count).toBe(0);
    expect(doc.content).toContain("Entity Extraction");
  });

  test("uses created_at when no source_timestamp", () => {
    const record = _makeMockRecordForExtraction({
      source_timestamp: null,
      created_at: new Date("2026-01-15T10:00:00Z"),
    });
    const result: ExtractionResult = {
      mountainRecordId: record.id,
      entities: [],
      durationMs: 5,
      skipped: false,
    };

    const doc = buildEntityDocument(record, result);
    expect(doc.path).toContain("2026-01-15");
  });
});

// ── _makeMockRecordForExtraction ────────────────────────────

describe("_makeMockRecordForExtraction", () => {
  test("creates a valid mock record", () => {
    const record = _makeMockRecordForExtraction();
    expect(record.id).toBeTruthy();
    expect(record.source_system).toBe("relay");
    expect(record.record_type).toBe("message");
    expect(record.payload).toHaveProperty("content");
  });

  test("accepts overrides", () => {
    const record = _makeMockRecordForExtraction({
      source_system: "github",
      record_type: "issue",
    });
    expect(record.source_system).toBe("github");
    expect(record.record_type).toBe("issue");
  });
});

// ── E2E: Extraction → Identity → Document ──────────────────

describe("E2E: extraction pipeline to document", () => {
  test("full flow: record → extract → resolve → document", async () => {
    const callFn = _makeMockClaudeCallFn(SAMPLE_ENTITIES);
    const extractor = new ClaudeEntityExtractor(callFn);
    const pipeline = new ExtractionPipeline(extractor);
    const record = _makeMockRecordForExtraction();

    // Extract
    const result = await pipeline.process(record);
    expect(result.skipped).toBe(false);
    expect(result.entities).toHaveLength(5);

    // Identity resolution happened
    const resolver = pipeline.getResolver();
    expect(resolver.profileCount).toBe(2);
    expect(resolver.findByName("Dave")).not.toBeNull();
    expect(resolver.findByName("Wincy")).not.toBeNull();

    // Build document for River
    const doc = buildEntityDocument(record, result);
    expect(doc.path).toBeTruthy();
    expect(doc.frontmatter.entity_count).toBe(5);
    expect(doc.content).toContain("Dave");
  });

  test("cross-channel identity merging across messages", async () => {
    // Message 1: Dave on Telegram
    const entities1: ExtractedEntity[] = [
      {
        type: "person",
        name: "Dave",
        role: "sender",
        identifiers: [{ channel: "telegram", value: "12345" }],
        confidence: 0.9,
      },
    ];

    // Message 2: Dave on Google Chat (same person, different channel)
    const entities2: ExtractedEntity[] = [
      {
        type: "person",
        name: "Dave",
        role: "sender",
        identifiers: [
          { channel: "telegram", value: "12345" },
          { channel: "google-chat", value: "dave@example.com" },
        ],
        confidence: 0.9,
      },
    ];

    let callCount = 0;
    const callFn: ClaudeCallFn = async () => {
      callCount++;
      return JSON.stringify(callCount === 1 ? entities1 : entities2);
    };

    const extractor = new ClaudeEntityExtractor(callFn);
    const pipeline = new ExtractionPipeline(extractor);

    const record1 = _makeMockRecordForExtraction({ source_system: "relay" });
    const record2 = _makeMockRecordForExtraction({ source_system: "relay" });

    await pipeline.processBatch([record1, record2]);

    // Should be merged into one profile
    const resolver = pipeline.getResolver();
    expect(resolver.profileCount).toBe(1);

    const profile = resolver.findByName("Dave");
    expect(profile).not.toBeNull();
    expect(profile!.identifiers).toHaveLength(2);
    expect(
      profile!.identifiers.some(
        (id) => id.channel === "google-chat" && id.value === "dave@example.com",
      ),
    ).toBe(true);
  });

  test("mixed source extraction with toggle", async () => {
    const callFn = _makeMockClaudeCallFn([
      {
        type: "topic",
        label: "test topic",
        confidence: 0.8,
      },
    ]);
    const extractor = new ClaudeEntityExtractor(callFn);
    const pipeline = new ExtractionPipeline(extractor);

    // Only enable relay
    pipeline.enableSource("relay");

    const relayRecord = _makeMockRecordForExtraction({ source_system: "relay" });
    const githubRecord = _makeMockRecordForExtraction({ source_system: "github" });

    const results = await pipeline.processBatch([relayRecord, githubRecord]);

    expect(results[0].skipped).toBe(false);
    expect(results[0].entities).toHaveLength(1);
    expect(results[1].skipped).toBe(true);
    expect(results[1].entities).toHaveLength(0);
  });
});
