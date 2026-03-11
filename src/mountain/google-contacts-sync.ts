/**
 * Google Contacts Sync Pipeline — ELLIE-670
 *
 * Pulls contacts from Google Contacts via MCP, maps them to Mountain
 * records via the contact-seed pipeline, with incremental sync support.
 *
 * Pattern: injectable GoogleContactsFetcher + ContactRecordWriter for testability.
 */

import { log } from "../logger.ts";
import {
  googleContactToRecord,
  ContactSeedPipeline,
  buildContactPayload,
  type GoogleContactInput,
  type ContactRecord,
  type ContactRecordWriter,
  type ContactIdentityPayload,
  type MatchRule,
} from "./contact-seed.ts";

const logger = log.child("google-contacts-sync");

// ── Types ────────────────────────────────────────────────────

/** Raw contact from Google People API / MCP list_contacts response. */
export interface GoogleContactRaw {
  resourceName: string;
  etag?: string;
  displayName?: string;
  givenName?: string;
  familyName?: string;
  emails?: string[];
  phones?: string[];
  organization?: string;
  jobTitle?: string;
  notes?: string;
  /** ISO timestamp of last update in Google */
  updatedAt?: string;
}

/** Result of a paginated contacts fetch. */
export interface GoogleContactsPage {
  contacts: GoogleContactRaw[];
  nextPageToken?: string;
  totalItems?: number;
}

/** Sync state persisted between runs for incremental sync. */
export interface SyncState {
  lastSyncAt: string; // ISO 8601
  lastSyncCount: number;
  totalSynced: number;
  syncVersion: number;
}

/** Configuration for the sync pipeline. */
export interface GoogleContactsSyncConfig {
  /** Page size for fetching contacts. Default: 100 */
  pageSize?: number;
  /** Maximum contacts to sync in one run. Default: unlimited (0) */
  maxContacts?: number;
  /** Match threshold for identity resolution. Default: 0.7 */
  matchThreshold?: number;
  /** Custom match rules for identity resolution. */
  matchRules?: MatchRule[];
  /** If true, only sync contacts updated since last sync. Default: true */
  incremental?: boolean;
}

/** Result of a sync run. */
export interface SyncResult {
  imported: number;
  merged: number;
  skipped: number;
  errors: number;
  total: number;
  durationMs: number;
  syncState: SyncState;
  errorDetails: SyncError[];
}

/** Individual sync error for a contact. */
export interface SyncError {
  resourceName: string;
  displayName: string;
  error: string;
}

/** Progress callback for long-running syncs. */
export type SyncProgressCallback = (progress: SyncProgress) => void;

/** Progress report. */
export interface SyncProgress {
  phase: "fetching" | "processing" | "flushing" | "complete";
  processed: number;
  total: number;
  currentContact?: string;
}

// ── Injectable Interfaces ───────────────────────────────────

/**
 * Fetches a page of Google Contacts.
 * Injectable — in production wraps MCP list_contacts,
 * in tests returns predefined data.
 */
export type GoogleContactsFetcher = (
  pageSize: number,
  pageToken?: string,
  sortOrder?: string,
) => Promise<GoogleContactsPage>;

/**
 * Reads and writes sync state for incremental sync.
 * Injectable — in production backed by a config record or file,
 * in tests uses in-memory state.
 */
export interface SyncStateStore {
  read(): Promise<SyncState | null>;
  write(state: SyncState): Promise<void>;
}

// ── Field Mapping ───────────────────────────────────────────

/**
 * Map a raw Google contact to the GoogleContactInput expected
 * by the contact-seed adapter.
 */
export function mapRawToInput(raw: GoogleContactRaw): GoogleContactInput | null {
  // Skip contacts with no useful data
  if (!raw.displayName && !raw.givenName && !raw.familyName) {
    return null;
  }

  return {
    resourceName: raw.resourceName,
    displayName: raw.displayName || `${raw.givenName ?? ""} ${raw.familyName ?? ""}`.trim(),
    givenName: raw.givenName,
    familyName: raw.familyName,
    emails: raw.emails,
    phones: raw.phones,
    organization: raw.organization,
    jobTitle: raw.jobTitle,
  };
}

/**
 * Parse the MCP list_contacts text response into structured contacts.
 * The MCP returns a formatted text string; this extracts contact data.
 */
export function parseContactsListResponse(response: string): GoogleContactsPage {
  const contacts: GoogleContactRaw[] = [];
  let nextPageToken: string | undefined;
  let totalItems: number | undefined;

  // Look for pagination token
  const tokenMatch = response.match(/Next page token:\s*(\S+)/i);
  if (tokenMatch) nextPageToken = tokenMatch[1];

  // Look for total count
  const totalMatch = response.match(/Total(?:\s+contacts)?:\s*(\d+)/i);
  if (totalMatch) totalItems = parseInt(totalMatch[1], 10);

  // Split by contact blocks — MCP typically formats as numbered or dashed entries
  // Pattern: look for resource name markers or numbered entries
  const blocks = response.split(/(?=(?:^|\n)(?:\d+\.|[-•])\s)/);

  for (const block of blocks) {
    if (!block.trim()) continue;

    const resourceMatch = block.match(/(?:Resource(?:\s*Name)?|ID):\s*(people\/[^\s,]+|c\d+)/i);
    const nameMatch = block.match(/(?:Name|Display\s*Name):\s*(.+?)(?:\n|$)/i);
    const givenMatch = block.match(/(?:Given\s*Name|First\s*Name):\s*(.+?)(?:\n|$)/i);
    const familyMatch = block.match(/(?:Family\s*Name|Last\s*Name):\s*(.+?)(?:\n|$)/i);
    const orgMatch = block.match(/(?:Organization|Company):\s*(.+?)(?:\n|$)/i);
    const titleMatch = block.match(/(?:Job\s*Title|Title):\s*(.+?)(?:\n|$)/i);
    const notesMatch = block.match(/(?:Notes|Bio):\s*(.+?)(?:\n|$)/i);
    const updatedMatch = block.match(/(?:Updated|Modified|Last\s*Modified):\s*(.+?)(?:\n|$)/i);

    // Extract emails (may be multiple)
    const emails: string[] = [];
    const emailPattern = /(?:Email|E-mail)s?:\s*(.+?)(?:\n|$)/gi;
    let emailMatch;
    while ((emailMatch = emailPattern.exec(block)) !== null) {
      // May contain comma-separated or single
      for (const e of emailMatch[1].split(/[,;]\s*/)) {
        const trimmed = e.trim();
        if (trimmed && trimmed.includes("@")) emails.push(trimmed);
      }
    }
    // Also catch inline emails
    const inlineEmails = block.match(/[\w.+-]+@[\w.-]+\.\w+/g);
    if (inlineEmails) {
      for (const e of inlineEmails) {
        if (!emails.includes(e)) emails.push(e);
      }
    }

    // Extract phones
    const phones: string[] = [];
    const phonePattern = /(?:Phone|Tel(?:ephone)?)s?:\s*(.+?)(?:\n|$)/gi;
    let phoneMatch;
    while ((phoneMatch = phonePattern.exec(block)) !== null) {
      for (const p of phoneMatch[1].split(/[,;]\s*/)) {
        const trimmed = p.trim();
        if (trimmed && /[\d+()-]/.test(trimmed)) phones.push(trimmed);
      }
    }

    // Only add if we have a resource name or a display name
    const resourceName = resourceMatch?.[1] || "";
    const displayName = nameMatch?.[1]?.trim() || "";

    if (!resourceName && !displayName) continue;

    contacts.push({
      resourceName: resourceName || `people/unknown-${contacts.length}`,
      displayName: displayName || undefined,
      givenName: givenMatch?.[1]?.trim(),
      familyName: familyMatch?.[1]?.trim(),
      emails: emails.length > 0 ? emails : undefined,
      phones: phones.length > 0 ? phones : undefined,
      organization: orgMatch?.[1]?.trim(),
      jobTitle: titleMatch?.[1]?.trim(),
      notes: notesMatch?.[1]?.trim(),
      updatedAt: updatedMatch?.[1]?.trim(),
    });
  }

  return { contacts, nextPageToken, totalItems };
}

// ── Sync Pipeline ───────────────────────────────────────────

/**
 * Main sync pipeline: fetches Google Contacts, maps, deduplicates,
 * and writes to Mountain via ContactSeedPipeline.
 */
export class GoogleContactsSyncPipeline {
  private fetcher: GoogleContactsFetcher;
  private writer: ContactRecordWriter;
  private stateStore: SyncStateStore;
  private config: Required<GoogleContactsSyncConfig>;

  constructor(
    fetcher: GoogleContactsFetcher,
    writer: ContactRecordWriter,
    stateStore: SyncStateStore,
    config: GoogleContactsSyncConfig = {},
  ) {
    this.fetcher = fetcher;
    this.writer = writer;
    this.stateStore = stateStore;
    this.config = {
      pageSize: config.pageSize ?? 100,
      maxContacts: config.maxContacts ?? 0,
      matchThreshold: config.matchThreshold ?? 0.7,
      matchRules: config.matchRules ?? [],
      incremental: config.incremental ?? true,
    };
  }

  /** Run a full or incremental sync. */
  async sync(onProgress?: SyncProgressCallback): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let imported = 0;
    let merged = 0;
    let skipped = 0;
    let total = 0;

    // Read previous sync state
    const prevState = this.config.incremental ? await this.stateStore.read() : null;

    // Build the seed pipeline with identity resolution
    const seedPipeline = new ContactSeedPipeline(this.writer, {
      matchRules: this.config.matchRules.length > 0 ? this.config.matchRules : undefined,
      matchThreshold: this.config.matchThreshold,
    });

    // Phase 1: Fetch all contacts
    logger.info("Starting Google Contacts sync", {
      incremental: this.config.incremental,
      lastSync: prevState?.lastSyncAt ?? "never",
    });

    onProgress?.({ phase: "fetching", processed: 0, total: 0 });

    const allContacts = await this.fetchAllContacts();
    total = allContacts.length;

    logger.info("Fetched contacts", { count: total });

    // Phase 2: Process each contact through the seed pipeline
    onProgress?.({ phase: "processing", processed: 0, total });

    for (let i = 0; i < allContacts.length; i++) {
      const raw = allContacts[i];

      // Check limit
      if (this.config.maxContacts > 0 && (imported + merged) >= this.config.maxContacts) {
        skipped += total - i;
        break;
      }

      // Skip if incremental and contact hasn't been updated since last sync
      if (prevState && raw.updatedAt) {
        const updatedAt = new Date(raw.updatedAt);
        const lastSync = new Date(prevState.lastSyncAt);
        if (updatedAt < lastSync) {
          skipped++;
          continue;
        }
      }

      // Map to GoogleContactInput
      const input = mapRawToInput(raw);
      if (!input) {
        skipped++;
        continue;
      }

      try {
        // Convert to ContactRecord via existing adapter
        const record = googleContactToRecord(input);

        // Add to seed pipeline (handles dedup + identity resolution)
        const result = seedPipeline.addContact(record);

        if (result === "imported") imported++;
        else if (result === "merged") merged++;
        else skipped++;
      } catch (err) {
        errors.push({
          resourceName: raw.resourceName,
          displayName: raw.displayName ?? "unknown",
          error: err instanceof Error ? err.message : String(err),
        });
      }

      onProgress?.({
        phase: "processing",
        processed: i + 1,
        total,
        currentContact: raw.displayName,
      });
    }

    // Phase 3: Flush to Mountain records
    onProgress?.({ phase: "flushing", processed: 0, total: imported + merged });

    try {
      const flushResult = await seedPipeline.flush();
      logger.info("Flushed contacts to Mountain", {
        written: flushResult.written,
        errors: flushResult.errors,
      });
      if (flushResult.errors.length > 0) {
        for (const flushErr of flushResult.errors) {
          errors.push({
            resourceName: flushErr.sourceId,
            displayName: flushErr.sourceId,
            error: flushErr.error,
          });
        }
      }
    } catch (err) {
      errors.push({
        resourceName: "flush",
        displayName: "batch",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Update sync state
    const newState: SyncState = {
      lastSyncAt: new Date().toISOString(),
      lastSyncCount: imported + merged,
      totalSynced: (prevState?.totalSynced ?? 0) + imported + merged,
      syncVersion: (prevState?.syncVersion ?? 0) + 1,
    };
    await this.stateStore.write(newState);

    const durationMs = Date.now() - start;

    onProgress?.({ phase: "complete", processed: total, total });

    logger.info("Sync complete", {
      imported,
      merged,
      skipped,
      errors: errors.length,
      durationMs,
    });

    return {
      imported,
      merged,
      skipped,
      errors: errors.length,
      total,
      durationMs,
      syncState: newState,
      errorDetails: errors,
    };
  }

  /** Fetch all contacts with pagination. */
  private async fetchAllContacts(): Promise<GoogleContactRaw[]> {
    const all: GoogleContactRaw[] = [];
    let pageToken: string | undefined;

    do {
      const page = await this.fetcher(
        this.config.pageSize,
        pageToken,
        "LAST_MODIFIED_DESCENDING",
      );
      all.push(...page.contacts);
      pageToken = page.nextPageToken;
    } while (pageToken);

    return all;
  }

  /** Run a dry-run sync that returns what would change without writing. */
  async dryRun(): Promise<{
    wouldImport: number;
    wouldMerge: number;
    wouldSkip: number;
    contacts: Array<{ resourceName: string; displayName: string; action: string }>;
  }> {
    const prevState = this.config.incremental ? await this.stateStore.read() : null;

    // Noop writer
    const noopWriter: ContactRecordWriter = async () => {};
    const seedPipeline = new ContactSeedPipeline(noopWriter, {
      matchRules: this.config.matchRules.length > 0 ? this.config.matchRules : undefined,
      matchThreshold: this.config.matchThreshold,
    });

    const allContacts = await this.fetchAllContacts();
    const contacts: Array<{ resourceName: string; displayName: string; action: string }> = [];
    let wouldImport = 0;
    let wouldMerge = 0;
    let wouldSkip = 0;

    for (const raw of allContacts) {
      if (prevState && raw.updatedAt) {
        const updatedAt = new Date(raw.updatedAt);
        const lastSync = new Date(prevState.lastSyncAt);
        if (updatedAt < lastSync) {
          wouldSkip++;
          contacts.push({ resourceName: raw.resourceName, displayName: raw.displayName ?? "", action: "skip" });
          continue;
        }
      }

      const input = mapRawToInput(raw);
      if (!input) {
        wouldSkip++;
        contacts.push({ resourceName: raw.resourceName, displayName: raw.displayName ?? "", action: "skip" });
        continue;
      }

      const record = googleContactToRecord(input);
      const result = seedPipeline.addContact(record);

      if (result === "imported") {
        wouldImport++;
        contacts.push({ resourceName: raw.resourceName, displayName: raw.displayName ?? "", action: "import" });
      } else if (result === "merged") {
        wouldMerge++;
        contacts.push({ resourceName: raw.resourceName, displayName: raw.displayName ?? "", action: "merge" });
      } else {
        wouldSkip++;
        contacts.push({ resourceName: raw.resourceName, displayName: raw.displayName ?? "", action: "skip" });
      }
    }

    return { wouldImport, wouldMerge, wouldSkip, contacts };
  }
}

// ── Testing Helpers ─────────────────────────────────────────

/** Create a mock raw Google contact for testing. */
export function _makeMockGoogleContactRaw(
  overrides: Partial<GoogleContactRaw> = {},
): GoogleContactRaw {
  return {
    resourceName: `people/c${Math.floor(Math.random() * 1_000_000)}`,
    displayName: "Test Contact",
    givenName: "Test",
    familyName: "Contact",
    emails: ["test@example.com"],
    phones: ["+1234567890"],
    ...overrides,
  };
}

/** Create a mock fetcher that returns predefined pages. */
export function _makeMockGoogleContactsFetcher(
  pages: GoogleContactsPage[],
): GoogleContactsFetcher {
  let callIndex = 0;
  return async () => {
    const page = pages[callIndex] ?? { contacts: [] };
    callIndex++;
    return page;
  };
}

/** Create an in-memory sync state store. */
export function _makeMockSyncStateStore(
  initial?: SyncState | null,
): SyncStateStore & { getState(): SyncState | null } {
  let state: SyncState | null = initial ?? null;
  return {
    async read() {
      return state;
    },
    async write(s: SyncState) {
      state = s;
    },
    getState() {
      return state;
    },
  };
}

/** Create a mock writer that records all written payloads. */
export function _makeMockContactWriter(): ContactRecordWriter & {
  getWritten(): ContactIdentityPayload[];
} {
  const written: ContactIdentityPayload[] = [];
  const fn = async (payload: ContactIdentityPayload) => {
    written.push(payload);
  };
  (fn as any).getWritten = () => written;
  return fn as ContactRecordWriter & { getWritten(): ContactIdentityPayload[] };
}
