/**
 * Mountain Entity Extraction — ELLIE-662
 *
 * Extracts structured entities from message content — people, topics,
 * action items, and decisions. Powers cross-channel identity resolution
 * and topic threading.
 *
 * Pattern: interface (testable) + Claude implementation (injectable).
 */

import { log } from "../logger.ts";
import type { MountainRecord } from "./records.ts";

const logger = log.child("mountain-entity-extraction");

// ── Entity Types ────────────────────────────────────────────

export type EntityType = "person" | "topic" | "action_item" | "decision";

/** A person mentioned or involved in a message. */
export interface PersonEntity {
  type: "person";
  /** Display name as found in the message */
  name: string;
  /** Role in the message: sender, mentioned, or recipient */
  role: "sender" | "mentioned" | "recipient";
  /** Channel-specific identifiers for cross-channel matching */
  identifiers: PersonIdentifier[];
  /** Confidence score 0–1 */
  confidence: number;
}

export interface PersonIdentifier {
  /** Channel where this identifier is valid */
  channel: string;
  /** The identifier value (e.g. Telegram user ID, email) */
  value: string;
}

/** A topic or subject discussed in a message. */
export interface TopicEntity {
  type: "topic";
  /** Short label for the topic */
  label: string;
  /** Optional longer description */
  description?: string;
  /** Confidence score 0–1 */
  confidence: number;
}

/** An action item or commitment extracted from a message. */
export interface ActionItemEntity {
  type: "action_item";
  /** What needs to be done */
  description: string;
  /** Who is responsible (if mentioned) */
  assignee?: string;
  /** When it's due (if mentioned) */
  dueDate?: string;
  /** Priority hint from context */
  priority?: "high" | "medium" | "low";
  /** Confidence score 0–1 */
  confidence: number;
}

/** A decision that was made or communicated. */
export interface DecisionEntity {
  type: "decision";
  /** What was decided */
  description: string;
  /** Reasoning or context (if mentioned) */
  rationale?: string;
  /** Who made the decision (if clear) */
  decider?: string;
  /** Confidence score 0–1 */
  confidence: number;
}

export type ExtractedEntity =
  | PersonEntity
  | TopicEntity
  | ActionItemEntity
  | DecisionEntity;

// ── Extraction Result ───────────────────────────────────────

export interface ExtractionResult {
  /** Mountain record ID that was processed */
  mountainRecordId: string;
  /** All extracted entities */
  entities: ExtractedEntity[];
  /** Processing duration in ms */
  durationMs: number;
  /** Whether extraction was skipped (e.g. content too short) */
  skipped: boolean;
  /** Reason for skipping (if skipped) */
  skipReason?: string;
}

// ── Extractor Interface ─────────────────────────────────────

/**
 * EntityExtractor — contract for entity extraction implementations.
 * Implementations can use LLMs, regex, or any other approach.
 */
export interface EntityExtractor {
  /** Unique ID for this extractor (e.g. "claude", "regex", "mock") */
  readonly id: string;

  /**
   * Extract entities from a mountain record.
   * Returns structured entities with confidence scores.
   */
  extract(record: MountainRecord): Promise<ExtractionResult>;
}

// ── Extraction Config ───────────────────────────────────────

export interface ExtractionConfig {
  /** Minimum content length to attempt extraction. Default: 10 */
  minContentLength?: number;
  /** Minimum confidence to include an entity. Default: 0.3 */
  minConfidence?: number;
  /** Entity types to extract. Default: all */
  entityTypes?: EntityType[];
  /** Sources to skip extraction for */
  disabledSources?: string[];
}

const DEFAULT_CONFIG: Required<ExtractionConfig> = {
  minContentLength: 10,
  minConfidence: 0.3,
  entityTypes: ["person", "topic", "action_item", "decision"],
  disabledSources: [],
};

// ── Claude Entity Extractor ─────────────────────────────────

/**
 * ClaudeEntityExtractor — uses Claude API for intelligent extraction.
 * Injectable callFn for testing without real API calls.
 */
export class ClaudeEntityExtractor implements EntityExtractor {
  readonly id = "claude";
  private config: Required<ExtractionConfig>;
  private callFn: ClaudeCallFn;

  constructor(callFn: ClaudeCallFn, config: ExtractionConfig = {}) {
    this.callFn = callFn;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async extract(record: MountainRecord): Promise<ExtractionResult> {
    const start = Date.now();

    // Check if source is disabled
    if (this.config.disabledSources.includes(record.source_system)) {
      return {
        mountainRecordId: record.id,
        entities: [],
        durationMs: Date.now() - start,
        skipped: true,
        skipReason: `Source "${record.source_system}" is disabled for extraction`,
      };
    }

    // Check content length
    const content = getContentFromRecord(record);
    if (content.length < this.config.minContentLength) {
      return {
        mountainRecordId: record.id,
        entities: [],
        durationMs: Date.now() - start,
        skipped: true,
        skipReason: `Content too short (${content.length} chars, min ${this.config.minContentLength})`,
      };
    }

    try {
      const prompt = buildExtractionPrompt(record, this.config.entityTypes);
      const raw = await this.callFn(prompt);
      const entities = parseExtractionResponse(raw, this.config.minConfidence);

      logger.debug("Entities extracted", {
        mountainRecordId: record.id,
        entityCount: entities.length,
        types: [...new Set(entities.map((e) => e.type))],
      });

      return {
        mountainRecordId: record.id,
        entities,
        durationMs: Date.now() - start,
        skipped: false,
      };
    } catch (err) {
      logger.error("Entity extraction failed", {
        mountainRecordId: record.id,
        error: err instanceof Error ? err.message : String(err),
      });

      return {
        mountainRecordId: record.id,
        entities: [],
        durationMs: Date.now() - start,
        skipped: true,
        skipReason: `Extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

/** Injectable Claude API call function */
export type ClaudeCallFn = (prompt: string) => Promise<string>;

// ── Cross-Channel Identity Resolution ───────────────────────

export interface IdentityProfile {
  /** Canonical name for this person */
  canonicalName: string;
  /** All known identifiers across channels */
  identifiers: PersonIdentifier[];
  /** When this profile was last updated */
  updatedAt: Date;
}

/**
 * IdentityResolver — links the same person across channels.
 *
 * Uses exact identifier matching and name similarity to merge
 * PersonEntities into unified IdentityProfiles.
 */
export class IdentityResolver {
  private profiles: Map<string, IdentityProfile> = new Map();

  /**
   * Resolve a PersonEntity — find or create an IdentityProfile.
   * Returns the canonical name for this person.
   */
  resolve(person: PersonEntity): string {
    // Try exact identifier match first
    for (const id of person.identifiers) {
      const existing = this.findByIdentifier(id);
      if (existing) {
        // Merge any new identifiers
        this.mergeIdentifiers(existing, person.identifiers);
        return existing.canonicalName;
      }
    }

    // Try name match
    const nameMatch = this.findByName(person.name);
    if (nameMatch) {
      this.mergeIdentifiers(nameMatch, person.identifiers);
      return nameMatch.canonicalName;
    }

    // Create new profile
    const profile: IdentityProfile = {
      canonicalName: person.name,
      identifiers: [...person.identifiers],
      updatedAt: new Date(),
    };
    this.profiles.set(normalizeName(person.name), profile);
    return profile.canonicalName;
  }

  /** Get all known profiles. */
  getProfiles(): IdentityProfile[] {
    return Array.from(this.profiles.values());
  }

  /** Get profile count. */
  get profileCount(): number {
    return this.profiles.size;
  }

  /** Find profile by identifier. */
  findByIdentifier(id: PersonIdentifier): IdentityProfile | null {
    for (const profile of this.profiles.values()) {
      if (
        profile.identifiers.some(
          (pid) => pid.channel === id.channel && pid.value === id.value,
        )
      ) {
        return profile;
      }
    }
    return null;
  }

  /** Find profile by name (normalized). */
  findByName(name: string): IdentityProfile | null {
    return this.profiles.get(normalizeName(name)) ?? null;
  }

  /** Clear all profiles. */
  clear(): void {
    this.profiles.clear();
  }

  private mergeIdentifiers(
    profile: IdentityProfile,
    newIds: PersonIdentifier[],
  ): void {
    for (const id of newIds) {
      const exists = profile.identifiers.some(
        (pid) => pid.channel === id.channel && pid.value === id.value,
      );
      if (!exists) {
        profile.identifiers.push(id);
        profile.updatedAt = new Date();
      }
    }
  }
}

/** Normalize a name for matching. */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

// ── Extraction Pipeline ─────────────────────────────────────

/**
 * ExtractionPipeline — processes mountain records through entity
 * extraction and identity resolution, producing structured output
 * ready for River storage.
 */
export class ExtractionPipeline {
  private extractor: EntityExtractor;
  private resolver: IdentityResolver;
  private enabledSources = new Set<string>();
  private _allSourcesEnabled = true;

  constructor(extractor: EntityExtractor, resolver?: IdentityResolver) {
    this.extractor = extractor;
    this.resolver = resolver ?? new IdentityResolver();
  }

  /** Enable extraction for a specific source. Disables all-sources mode. */
  enableSource(sourceSystem: string): void {
    this.enabledSources.add(sourceSystem);
    this._allSourcesEnabled = false;
  }

  /** Disable extraction for a specific source. */
  disableSource(sourceSystem: string): void {
    this.enabledSources.delete(sourceSystem);
  }

  /** Enable extraction for all sources (default). */
  enableAllSources(): void {
    this._allSourcesEnabled = true;
    this.enabledSources.clear();
  }

  /** Check if extraction is enabled for a source. */
  isSourceEnabled(sourceSystem: string): boolean {
    if (this._allSourcesEnabled) return true;
    return this.enabledSources.has(sourceSystem);
  }

  /**
   * Process a mountain record through extraction + identity resolution.
   * Returns the extraction result with resolved person identities.
   */
  async process(record: MountainRecord): Promise<ExtractionResult> {
    if (!this.isSourceEnabled(record.source_system)) {
      return {
        mountainRecordId: record.id,
        entities: [],
        durationMs: 0,
        skipped: true,
        skipReason: `Source "${record.source_system}" is disabled`,
      };
    }

    const result = await this.extractor.extract(record);

    // Resolve person identities
    for (const entity of result.entities) {
      if (entity.type === "person") {
        this.resolver.resolve(entity);
      }
    }

    return result;
  }

  /**
   * Process a batch of records. Returns results in the same order.
   */
  async processBatch(records: MountainRecord[]): Promise<ExtractionResult[]> {
    const results: ExtractionResult[] = [];
    for (const record of records) {
      results.push(await this.process(record));
    }
    return results;
  }

  /** Get the identity resolver. */
  getResolver(): IdentityResolver {
    return this.resolver;
  }
}

// ── Prompt Building ─────────────────────────────────────────

/**
 * Build the extraction prompt for Claude.
 * The prompt asks Claude to return a JSON array of entities.
 */
export function buildExtractionPrompt(
  record: MountainRecord,
  entityTypes: EntityType[],
): string {
  const content = getContentFromRecord(record);
  const context = buildContextString(record);
  const typeDescriptions = entityTypes
    .map((t) => ENTITY_TYPE_DESCRIPTIONS[t])
    .join("\n");

  return `Extract structured entities from this message. Return ONLY a JSON array of entities, no other text.

## Entity Types to Extract
${typeDescriptions}

## Message Context
- Source: ${record.source_system}
- Channel: ${(record.payload as Record<string, unknown>)?.channel ?? "unknown"}
- Record type: ${record.record_type}
${context}

## Message Content
${content}

## Output Format
Return a JSON array. Each entity must have a "type" field and a "confidence" field (0-1).

Person example: {"type":"person","name":"Dave","role":"mentioned","identifiers":[{"channel":"telegram","value":"12345"}],"confidence":0.9}
Topic example: {"type":"topic","label":"project deadline","description":"Discussion about Q2 deadline","confidence":0.8}
Action item example: {"type":"action_item","description":"Send report to team","assignee":"Dave","priority":"high","confidence":0.7}
Decision example: {"type":"decision","description":"Using PostgreSQL instead of MongoDB","rationale":"Better for relational data","confidence":0.85}

Return [] if no entities are found.`;
}

const ENTITY_TYPE_DESCRIPTIONS: Record<EntityType, string> = {
  person:
    "- **Person**: Anyone mentioned, sending, or receiving. Include name, role (sender/mentioned/recipient), and any channel identifiers.",
  topic:
    "- **Topic**: Main subjects or themes discussed. Include a short label and optional description.",
  action_item:
    "- **Action Item**: Tasks, commitments, or todos. Include description, assignee if mentioned, due date if mentioned, and priority hint.",
  decision:
    "- **Decision**: Choices made or communicated. Include what was decided, rationale if given, and who decided.",
};

// ── Response Parsing ────────────────────────────────────────

/**
 * Parse Claude's extraction response into typed entities.
 * Filters by minimum confidence and validates structure.
 */
export function parseExtractionResponse(
  raw: string,
  minConfidence: number,
): ExtractedEntity[] {
  // Extract JSON array from response (Claude might wrap it in markdown)
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  let parsed: unknown[];
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    logger.warn("Failed to parse extraction response", {
      raw: raw.slice(0, 200),
    });
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const entities: ExtractedEntity[] = [];
  for (const item of parsed) {
    const entity = validateEntity(item);
    if (entity && entity.confidence >= minConfidence) {
      entities.push(entity);
    }
  }

  return entities;
}

/**
 * Validate and type a raw entity object.
 * Returns null if the entity is invalid.
 */
export function validateEntity(raw: unknown): ExtractedEntity | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  if (typeof obj.confidence !== "number" || obj.confidence < 0 || obj.confidence > 1) {
    return null;
  }

  switch (obj.type) {
    case "person":
      return validatePersonEntity(obj);
    case "topic":
      return validateTopicEntity(obj);
    case "action_item":
      return validateActionItemEntity(obj);
    case "decision":
      return validateDecisionEntity(obj);
    default:
      return null;
  }
}

function validatePersonEntity(obj: Record<string, unknown>): PersonEntity | null {
  if (typeof obj.name !== "string" || !obj.name) return null;
  const role = obj.role as string;
  if (!["sender", "mentioned", "recipient"].includes(role)) return null;

  const identifiers: PersonIdentifier[] = [];
  if (Array.isArray(obj.identifiers)) {
    for (const id of obj.identifiers) {
      if (
        id &&
        typeof id === "object" &&
        typeof (id as Record<string, unknown>).channel === "string" &&
        typeof (id as Record<string, unknown>).value === "string"
      ) {
        identifiers.push({
          channel: (id as Record<string, unknown>).channel as string,
          value: (id as Record<string, unknown>).value as string,
        });
      }
    }
  }

  return {
    type: "person",
    name: obj.name as string,
    role: role as PersonEntity["role"],
    identifiers,
    confidence: obj.confidence as number,
  };
}

function validateTopicEntity(obj: Record<string, unknown>): TopicEntity | null {
  if (typeof obj.label !== "string" || !obj.label) return null;
  return {
    type: "topic",
    label: obj.label as string,
    description: typeof obj.description === "string" ? obj.description : undefined,
    confidence: obj.confidence as number,
  };
}

function validateActionItemEntity(
  obj: Record<string, unknown>,
): ActionItemEntity | null {
  if (typeof obj.description !== "string" || !obj.description) return null;
  const priority = obj.priority as string | undefined;
  return {
    type: "action_item",
    description: obj.description as string,
    assignee: typeof obj.assignee === "string" ? obj.assignee : undefined,
    dueDate: typeof obj.dueDate === "string" ? obj.dueDate : undefined,
    priority:
      priority && ["high", "medium", "low"].includes(priority)
        ? (priority as "high" | "medium" | "low")
        : undefined,
    confidence: obj.confidence as number,
  };
}

function validateDecisionEntity(
  obj: Record<string, unknown>,
): DecisionEntity | null {
  if (typeof obj.description !== "string" || !obj.description) return null;
  return {
    type: "decision",
    description: obj.description as string,
    rationale: typeof obj.rationale === "string" ? obj.rationale : undefined,
    decider: typeof obj.decider === "string" ? obj.decider : undefined,
    confidence: obj.confidence as number,
  };
}

// ── Helpers ─────────────────────────────────────────────────

/** Extract the text content from a mountain record. */
export function getContentFromRecord(record: MountainRecord): string {
  const payload = record.payload ?? {};
  if (typeof payload.content === "string") return payload.content;
  if (record.summary) return record.summary;
  return "";
}

/** Build context string from record metadata. */
function buildContextString(record: MountainRecord): string {
  const payload = record.payload as Record<string, unknown>;
  const parts: string[] = [];

  if (payload?.role) parts.push(`- Role: ${payload.role}`);
  if (payload?.sender) parts.push(`- Sender: ${payload.sender}`);

  return parts.length > 0 ? parts.join("\n") : "";
}

/**
 * Build a River-compatible document from extraction results.
 * Produces structured JSON frontmatter + markdown body.
 */
export function buildEntityDocument(
  record: MountainRecord,
  result: ExtractionResult,
): { path: string; content: string; frontmatter: Record<string, unknown> } {
  const date = record.source_timestamp
    ? new Date(record.source_timestamp).toISOString().slice(0, 10)
    : new Date(record.created_at).toISOString().slice(0, 10);

  const path = `mountain/entities/${record.source_system}/${date}/${record.id}.json.md`;

  const frontmatter: Record<string, unknown> = {
    mountain_record_id: record.id,
    source_system: record.source_system,
    external_id: record.external_id,
    extraction_duration_ms: result.durationMs,
    entity_count: result.entities.length,
    entity_types: [...new Set(result.entities.map((e) => e.type))],
    extracted_at: new Date().toISOString(),
  };

  const lines: string[] = [];
  lines.push(`# Entity Extraction: ${record.external_id}`);
  lines.push("");

  // Group by type
  const byType = new Map<string, ExtractedEntity[]>();
  for (const entity of result.entities) {
    const group = byType.get(entity.type) ?? [];
    group.push(entity);
    byType.set(entity.type, group);
  }

  for (const [type, entities] of byType) {
    lines.push(`## ${type.charAt(0).toUpperCase() + type.slice(1).replace(/_/g, " ")}s`);
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(entities, null, 2));
    lines.push("```");
    lines.push("");
  }

  return {
    path,
    content: lines.join("\n").trim(),
    frontmatter,
  };
}

// ── Testing Helpers ─────────────────────────────────────────

/** Create a mock mountain record for entity extraction tests. */
export function _makeMockRecordForExtraction(
  overrides: Partial<MountainRecord> = {},
): MountainRecord {
  return {
    id: crypto.randomUUID(),
    record_type: "message",
    source_system: "relay",
    external_id: `relay:telegram:${crypto.randomUUID()}`,
    payload: {
      content: "Hey Dave, can you send the Q2 report to Wincy by Friday? I've decided we should use the new template.",
      channel: "telegram",
      role: "user",
      sender: "12345",
    },
    summary: "Message about Q2 report",
    status: "active",
    harvest_job_id: null,
    source_timestamp: new Date("2026-03-10T12:00:00Z"),
    supersedes_id: null,
    version: 1,
    created_at: new Date("2026-03-10T12:00:00Z"),
    updated_at: new Date("2026-03-10T12:00:00Z"),
    ...overrides,
  };
}

/** Create a mock ClaudeCallFn that returns predefined entities. */
export function _makeMockClaudeCallFn(
  entities: ExtractedEntity[],
): ClaudeCallFn {
  return async (_prompt: string) => JSON.stringify(entities);
}

/** Create a mock ClaudeCallFn that throws. */
export function _makeMockClaudeCallFnError(error: string): ClaudeCallFn {
  return async (_prompt: string) => {
    throw new Error(error);
  };
}
