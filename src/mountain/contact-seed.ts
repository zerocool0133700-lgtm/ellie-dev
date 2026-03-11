/**
 * Mountain Contact Seed Layer — ELLIE-666
 *
 * Preloads known contacts into mountain_records as `contact_identity`
 * records so cross-channel identity resolution works from day one.
 *
 * Sources: Apple Contacts (CardDAV), Google Contacts (MCP), Telegram
 * metadata, Discord members, LinkedIn CSV export, conversation_facts.
 *
 * Pattern: source adapters produce ContactRecord[], the ContactSeedPipeline
 * deduplicates, matches identities, and upserts to mountain_records.
 */

import { log } from "../logger.ts";
import type { MountainRecord } from "./records.ts";

const logger = log.child("mountain-contact-seed");

// ── Contact Identity Types ──────────────────────────────────

/** A channel-specific identifier for a contact. */
export interface ChannelIdentifier {
  /** Channel name (e.g. "telegram", "google-chat", "discord", "email", "phone", "linkedin") */
  channel: string;
  /** Identifier value (user ID, email, phone number, etc.) */
  value: string;
  /** Whether this is the primary identifier for this channel */
  primary?: boolean;
}

/** A normalized contact record ready for mountain_records. */
export interface ContactRecord {
  /** Display name */
  displayName: string;
  /** First name */
  firstName?: string;
  /** Last name */
  lastName?: string;
  /** All known identifiers across channels */
  identifiers: ChannelIdentifier[];
  /** Organization / company */
  org?: string;
  /** Job title */
  title?: string;
  /** Contact source (e.g. "apple-contacts", "google-contacts", "discord", "linkedin") */
  source: string;
  /** Source-specific unique ID for dedup */
  sourceId: string;
  /** Extra metadata from the source */
  metadata?: Record<string, unknown>;
}

/** Result of a seed import operation. */
export interface SeedResult {
  /** Number of contacts imported */
  imported: number;
  /** Number of contacts skipped (dedup) */
  skipped: number;
  /** Number of contacts merged with existing */
  merged: number;
  /** Errors encountered */
  errors: Array<{ sourceId: string; error: string }>;
  /** Duration in ms */
  durationMs: number;
}

// ── Identity Matching ───────────────────────────────────────

export type MatchField = "email" | "phone" | "display_name" | "discord_id" | "telegram_id" | "linkedin_url";

/** Rules for matching contacts across sources. */
export interface MatchRule {
  /** Which field to match on */
  field: MatchField;
  /** Whether this is an exact match or fuzzy */
  exact: boolean;
  /** Weight for scoring (higher = more confident match) */
  weight: number;
}

/** Default matching rules — email and phone are strong signals, name is weaker. */
export const DEFAULT_MATCH_RULES: MatchRule[] = [
  { field: "email", exact: true, weight: 1.0 },
  { field: "phone", exact: true, weight: 0.9 },
  { field: "telegram_id", exact: true, weight: 1.0 },
  { field: "discord_id", exact: true, weight: 1.0 },
  { field: "linkedin_url", exact: true, weight: 0.8 },
  { field: "display_name", exact: false, weight: 0.4 },
];

/**
 * Score how well two contacts match based on their identifiers.
 * Returns 0 (no match) to 1 (perfect match).
 */
export function scoreContactMatch(
  a: ContactRecord,
  b: ContactRecord,
  rules: MatchRule[] = DEFAULT_MATCH_RULES,
): number {
  let maxScore = 0;

  for (const rule of rules) {
    const aValues = getFieldValues(a, rule.field);
    const bValues = getFieldValues(b, rule.field);

    for (const av of aValues) {
      for (const bv of bValues) {
        const match = rule.exact
          ? av.toLowerCase() === bv.toLowerCase()
          : fuzzyNameMatch(av, bv);
        if (match) {
          maxScore = Math.max(maxScore, rule.weight);
        }
      }
    }
  }

  return maxScore;
}

/** Extract values for a match field from a contact. */
export function getFieldValues(
  contact: ContactRecord,
  field: MatchField,
): string[] {
  const channelMap: Record<string, string> = {
    email: "email",
    phone: "phone",
    telegram_id: "telegram",
    discord_id: "discord",
    linkedin_url: "linkedin",
  };

  if (field === "display_name") {
    return contact.displayName ? [contact.displayName] : [];
  }

  const channel = channelMap[field];
  if (!channel) return [];

  return contact.identifiers
    .filter((id) => id.channel === channel)
    .map((id) => id.value);
}

/** Fuzzy name matching — handles common variations. */
export function fuzzyNameMatch(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  // Check if one name is a substring of the other (handles "Dave" vs "Dave Smith")
  if (na.includes(nb) || nb.includes(na)) return true;

  return false;
}

/** Normalize a name for comparison. */
export function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ");
}

/** Normalize a phone number for comparison. */
export function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-\(\)\+\.]/g, "");
}

// ── Source Adapters ─────────────────────────────────────────

/**
 * ContactSourceAdapter — fetches contacts from an external source.
 * Each source implements this to produce normalized ContactRecords.
 */
export interface ContactSourceAdapter {
  /** Source identifier (e.g. "apple-contacts", "discord") */
  readonly id: string;
  /** Fetch contacts from this source */
  fetch(): Promise<ContactRecord[]>;
  /** Check if the source is available/configured */
  isAvailable(): boolean;
}

// ── Apple Contacts Adapter ──────────────────────────────────

export interface AppleContactInput {
  uid: string;
  fullName: string;
  firstName: string;
  lastName: string;
  emails: Array<{ type: string; value: string }>;
  phones: Array<{ type: string; value: string }>;
  org: string | null;
  title: string | null;
  note: string | null;
}

/** Convert Apple Contacts to ContactRecords. */
export function appleContactToRecord(contact: AppleContactInput): ContactRecord {
  const identifiers: ChannelIdentifier[] = [];

  for (const email of contact.emails) {
    identifiers.push({
      channel: "email",
      value: email.value.toLowerCase(),
      primary: email.type === "WORK" || email.type === "HOME",
    });
  }

  for (const phone of contact.phones) {
    identifiers.push({
      channel: "phone",
      value: normalizePhone(phone.value),
    });
  }

  return {
    displayName: contact.fullName || `${contact.firstName} ${contact.lastName}`.trim(),
    firstName: contact.firstName || undefined,
    lastName: contact.lastName || undefined,
    identifiers,
    org: contact.org || undefined,
    title: contact.title || undefined,
    source: "apple-contacts",
    sourceId: contact.uid,
    metadata: contact.note ? { note: contact.note } : undefined,
  };
}

// ── Google Contacts Adapter ─────────────────────────────────

export interface GoogleContactInput {
  resourceName: string;
  displayName: string;
  givenName?: string;
  familyName?: string;
  emails?: string[];
  phones?: string[];
  organization?: string;
  jobTitle?: string;
}

/** Convert Google Contacts to ContactRecords. */
export function googleContactToRecord(contact: GoogleContactInput): ContactRecord {
  const identifiers: ChannelIdentifier[] = [];

  for (const email of contact.emails ?? []) {
    identifiers.push({ channel: "email", value: email.toLowerCase() });
  }

  for (const phone of contact.phones ?? []) {
    identifiers.push({ channel: "phone", value: normalizePhone(phone) });
  }

  return {
    displayName: contact.displayName,
    firstName: contact.givenName,
    lastName: contact.familyName,
    identifiers,
    org: contact.organization,
    title: contact.jobTitle,
    source: "google-contacts",
    sourceId: contact.resourceName,
  };
}

// ── Discord Member Adapter ──────────────────────────────────

export interface DiscordMemberInput {
  /** Discord user ID (snowflake) */
  userId: string;
  /** Username (e.g. "dave#1234" or "dave") */
  username: string;
  /** Display name / nickname */
  displayName: string;
  /** Server/guild ID */
  guildId: string;
  /** Roles in the server */
  roles?: string[];
  /** Bot flag */
  bot?: boolean;
}

/** Convert Discord members to ContactRecords. */
export function discordMemberToRecord(member: DiscordMemberInput): ContactRecord {
  return {
    displayName: member.displayName || member.username,
    identifiers: [
      { channel: "discord", value: member.userId, primary: true },
    ],
    source: "discord",
    sourceId: `discord:${member.guildId}:${member.userId}`,
    metadata: {
      username: member.username,
      guildId: member.guildId,
      roles: member.roles,
      bot: member.bot,
    },
  };
}

// ── LinkedIn CSV Adapter ────────────────────────────────────

export interface LinkedInConnectionInput {
  firstName: string;
  lastName: string;
  emailAddress?: string;
  company?: string;
  position?: string;
  connectedOn?: string;
  profileUrl?: string;
}

/** Convert LinkedIn connections to ContactRecords. */
export function linkedInConnectionToRecord(
  conn: LinkedInConnectionInput,
): ContactRecord {
  const identifiers: ChannelIdentifier[] = [];

  if (conn.emailAddress) {
    identifiers.push({ channel: "email", value: conn.emailAddress.toLowerCase() });
  }
  if (conn.profileUrl) {
    identifiers.push({ channel: "linkedin", value: conn.profileUrl });
  }

  return {
    displayName: `${conn.firstName} ${conn.lastName}`.trim(),
    firstName: conn.firstName,
    lastName: conn.lastName,
    identifiers,
    org: conn.company,
    title: conn.position,
    source: "linkedin",
    sourceId: conn.profileUrl ?? `linkedin:${conn.firstName}-${conn.lastName}`,
    metadata: conn.connectedOn ? { connectedOn: conn.connectedOn } : undefined,
  };
}

/**
 * Parse a LinkedIn connections CSV export.
 * LinkedIn CSV format: First Name, Last Name, Email Address, Company, Position, Connected On, URL
 */
export function parseLinkedInCsv(csv: string): LinkedInConnectionInput[] {
  const lines = csv.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  // Find header row (LinkedIn CSVs sometimes have notes before the header)
  const headerIdx = lines.findIndex((l) =>
    l.toLowerCase().includes("first name") && l.toLowerCase().includes("last name"),
  );
  if (headerIdx === -1) return [];

  const headers = parseCsvLine(lines[headerIdx]).map((h) => h.toLowerCase().trim());
  const firstNameIdx = headers.findIndex((h) => h === "first name");
  const lastNameIdx = headers.findIndex((h) => h === "last name");
  const emailIdx = headers.findIndex((h) => h === "email address");
  const companyIdx = headers.findIndex((h) => h === "company");
  const positionIdx = headers.findIndex((h) => h === "position");
  const connectedIdx = headers.findIndex((h) => h === "connected on");
  const urlIdx = headers.findIndex((h) => h === "url" || h === "profile url");

  if (firstNameIdx === -1 || lastNameIdx === -1) return [];

  const results: LinkedInConnectionInput[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const firstName = fields[firstNameIdx]?.trim();
    const lastName = fields[lastNameIdx]?.trim();
    if (!firstName && !lastName) continue;

    results.push({
      firstName: firstName ?? "",
      lastName: lastName ?? "",
      emailAddress: emailIdx >= 0 ? fields[emailIdx]?.trim() || undefined : undefined,
      company: companyIdx >= 0 ? fields[companyIdx]?.trim() || undefined : undefined,
      position: positionIdx >= 0 ? fields[positionIdx]?.trim() || undefined : undefined,
      connectedOn: connectedIdx >= 0 ? fields[connectedIdx]?.trim() || undefined : undefined,
      profileUrl: urlIdx >= 0 ? fields[urlIdx]?.trim() || undefined : undefined,
    });
  }

  return results;
}

/** Simple CSV line parser that handles quoted fields. */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// ── Telegram Metadata Adapter ───────────────────────────────

export interface TelegramUserInput {
  /** Telegram user ID */
  userId: string;
  /** Display name */
  displayName: string;
  /** Username (without @) */
  username?: string;
}

/** Convert Telegram user metadata to ContactRecord. */
export function telegramUserToRecord(user: TelegramUserInput): ContactRecord {
  const identifiers: ChannelIdentifier[] = [
    { channel: "telegram", value: user.userId, primary: true },
  ];
  if (user.username) {
    identifiers.push({ channel: "telegram", value: `@${user.username}` });
  }

  return {
    displayName: user.displayName,
    identifiers,
    source: "telegram",
    sourceId: `telegram:${user.userId}`,
  };
}

// ── Contact Seed Pipeline ───────────────────────────────────

/**
 * ContactSeedPipeline — imports contacts from multiple sources,
 * deduplicates, and produces mountain_records-ready payloads.
 *
 * Uses a MountainRecordWriter function for testability (injectable).
 */
export class ContactSeedPipeline {
  private contacts: Map<string, ContactRecord> = new Map();
  private matchRules: MatchRule[];
  private matchThreshold: number;
  private writerFn: ContactRecordWriter;

  constructor(
    writerFn: ContactRecordWriter,
    opts: { matchRules?: MatchRule[]; matchThreshold?: number } = {},
  ) {
    this.writerFn = writerFn;
    this.matchRules = opts.matchRules ?? DEFAULT_MATCH_RULES;
    this.matchThreshold = opts.matchThreshold ?? 0.7;
  }

  /**
   * Import contacts from a source adapter.
   * Deduplicates against already-imported contacts.
   */
  async importSource(adapter: ContactSourceAdapter): Promise<SeedResult> {
    const start = Date.now();
    const result: SeedResult = {
      imported: 0,
      skipped: 0,
      merged: 0,
      errors: [],
      durationMs: 0,
    };

    if (!adapter.isAvailable()) {
      logger.info(`Source "${adapter.id}" is not available, skipping`);
      result.durationMs = Date.now() - start;
      return result;
    }

    let records: ContactRecord[];
    try {
      records = await adapter.fetch();
    } catch (err) {
      result.errors.push({
        sourceId: adapter.id,
        error: err instanceof Error ? err.message : String(err),
      });
      result.durationMs = Date.now() - start;
      return result;
    }

    for (const record of records) {
      try {
        const action = this.addContact(record);
        if (action === "imported") result.imported++;
        else if (action === "merged") result.merged++;
        else result.skipped++;
      } catch (err) {
        result.errors.push({
          sourceId: record.sourceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    result.durationMs = Date.now() - start;
    logger.info(`Source "${adapter.id}" imported`, {
      imported: result.imported,
      merged: result.merged,
      skipped: result.skipped,
      errors: result.errors.length,
    });

    return result;
  }

  /**
   * Add a single contact. Returns "imported", "merged", or "skipped".
   */
  addContact(contact: ContactRecord): "imported" | "merged" | "skipped" {
    // Check for exact source dedup
    const dedupKey = `${contact.source}:${contact.sourceId}`;
    if (this.contacts.has(dedupKey)) return "skipped";

    // Check for identity match against existing contacts
    for (const [, existing] of this.contacts) {
      const score = scoreContactMatch(contact, existing, this.matchRules);
      if (score >= this.matchThreshold) {
        // Merge identifiers into existing
        this.mergeContact(existing, contact);
        return "merged";
      }
    }

    // New contact
    this.contacts.set(dedupKey, contact);
    return "imported";
  }

  /**
   * Flush all contacts to mountain_records via the writer function.
   */
  async flush(): Promise<SeedResult> {
    const start = Date.now();
    const result: SeedResult = {
      imported: 0,
      skipped: 0,
      merged: 0,
      errors: [],
      durationMs: 0,
    };

    for (const [, contact] of this.contacts) {
      try {
        await this.writerFn(buildContactPayload(contact));
        result.imported++;
      } catch (err) {
        result.errors.push({
          sourceId: contact.sourceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    result.durationMs = Date.now() - start;
    logger.info("Contact seed flush complete", {
      imported: result.imported,
      errors: result.errors.length,
      durationMs: result.durationMs,
    });

    return result;
  }

  /** Get the current contact count. */
  get contactCount(): number {
    return this.contacts.size;
  }

  /** Get all contacts. */
  getContacts(): ContactRecord[] {
    return Array.from(this.contacts.values());
  }

  /** Find contacts matching a query by name. */
  findByName(name: string): ContactRecord[] {
    const normalized = normalizeName(name);
    return Array.from(this.contacts.values()).filter((c) =>
      normalizeName(c.displayName).includes(normalized),
    );
  }

  /** Find contact by channel identifier. */
  findByIdentifier(channel: string, value: string): ContactRecord | null {
    const normalizedValue = value.toLowerCase();
    for (const contact of this.contacts.values()) {
      if (
        contact.identifiers.some(
          (id) =>
            id.channel === channel &&
            id.value.toLowerCase() === normalizedValue,
        )
      ) {
        return contact;
      }
    }
    return null;
  }

  /** Clear all contacts. */
  clear(): void {
    this.contacts.clear();
  }

  private mergeContact(target: ContactRecord, source: ContactRecord): void {
    // Merge identifiers (avoid duplicates)
    for (const id of source.identifiers) {
      const exists = target.identifiers.some(
        (tid) =>
          tid.channel === id.channel &&
          tid.value.toLowerCase() === id.value.toLowerCase(),
      );
      if (!exists) {
        target.identifiers.push(id);
      }
    }

    // Fill missing fields
    if (!target.firstName && source.firstName) target.firstName = source.firstName;
    if (!target.lastName && source.lastName) target.lastName = source.lastName;
    if (!target.org && source.org) target.org = source.org;
    if (!target.title && source.title) target.title = source.title;

    // Merge metadata
    if (source.metadata) {
      target.metadata = { ...target.metadata, ...source.metadata };
    }
  }
}

// ── Payload Builder ─────────────────────────────────────────

/** Build a mountain_records-compatible payload from a ContactRecord. */
export function buildContactPayload(contact: ContactRecord): ContactIdentityPayload {
  return {
    record_type: "contact_identity",
    source_system: contact.source,
    external_id: `contact:${contact.source}:${contact.sourceId}`,
    payload: {
      displayName: contact.displayName,
      firstName: contact.firstName ?? null,
      lastName: contact.lastName ?? null,
      identifiers: contact.identifiers,
      org: contact.org ?? null,
      title: contact.title ?? null,
      metadata: contact.metadata ?? null,
    },
    summary: contact.displayName,
  };
}

/** The payload shape written to mountain_records. */
export interface ContactIdentityPayload {
  record_type: "contact_identity";
  source_system: string;
  external_id: string;
  payload: {
    displayName: string;
    firstName: string | null;
    lastName: string | null;
    identifiers: ChannelIdentifier[];
    org: string | null;
    title: string | null;
    metadata: Record<string, unknown> | null;
  };
  summary: string;
}

/** Writer function type — injectable for testing. */
export type ContactRecordWriter = (
  payload: ContactIdentityPayload,
) => Promise<void>;

// ── Sender Resolution ───────────────────────────────────────

/**
 * Resolve a message sender's identity from the contact seed.
 * Returns the matching ContactRecord or null.
 */
export function resolveSenderIdentity(
  pipeline: ContactSeedPipeline,
  channel: string,
  senderId: string,
): ContactRecord | null {
  return pipeline.findByIdentifier(channel, senderId);
}

// ── Testing Helpers ─────────────────────────────────────────

/** Create a mock ContactRecord for testing. */
export function _makeMockContact(
  overrides: Partial<ContactRecord> = {},
): ContactRecord {
  return {
    displayName: "Test User",
    firstName: "Test",
    lastName: "User",
    identifiers: [
      { channel: "email", value: "test@example.com" },
      { channel: "telegram", value: "12345" },
    ],
    source: "test",
    sourceId: crypto.randomUUID(),
    ...overrides,
  };
}

/** Create a no-op writer for testing. */
export function _makeMockWriter(): {
  writer: ContactRecordWriter;
  written: ContactIdentityPayload[];
} {
  const written: ContactIdentityPayload[] = [];
  const writer: ContactRecordWriter = async (payload) => {
    written.push(payload);
  };
  return { writer, written };
}

/** Create a mock source adapter for testing. */
export function _makeMockSourceAdapter(
  id: string,
  contacts: ContactRecord[],
  available = true,
): ContactSourceAdapter {
  return {
    id,
    isAvailable: () => available,
    fetch: async () => contacts,
  };
}
