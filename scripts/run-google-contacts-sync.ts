#!/usr/bin/env bun
/**
 * Run Google Contacts Sync — one-shot script
 *
 * Fetches contacts from Google via MCP list_contacts output (piped in),
 * maps them through the contact-seed pipeline, and upserts to mountain_records.
 */

import {
  GoogleContactsSyncPipeline,
  type GoogleContactRaw,
  type GoogleContactsFetcher,
  type SyncStateStore,
  type SyncState,
} from "../src/mountain/google-contacts-sync.ts";
import { upsertRecord } from "../src/mountain/records.ts";
import type { ContactIdentityPayload } from "../src/mountain/contact-seed.ts";
import { log } from "../src/logger.ts";
import { readFileSync, writeFileSync, existsSync } from "fs";

const logger = log.child("google-contacts-sync-runner");

const STATE_FILE = "/home/ellie/ellie-dev/.google-contacts-sync-state.json";

// ── Parse MCP list_contacts output ─────────────────────────────

function parseMcpContactsOutput(text: string): GoogleContactRaw[] {
  const contacts: GoogleContactRaw[] = [];
  // Split on "Contact ID:" blocks
  const blocks = text.split(/(?=Contact ID:)/);

  for (const block of blocks) {
    const idMatch = block.match(/Contact ID:\s*(c\d+)/);
    if (!idMatch) continue;

    const resourceName = `people/${idMatch[1]}`;
    const nameMatch = block.match(/Name:\s*(.+)/);
    const displayName = nameMatch?.[1]?.trim();

    // Extract emails
    const emailLine = block.match(/Email:\s*(.+)/);
    const emails: string[] = [];
    if (emailLine) {
      for (const e of emailLine[1].split(",")) {
        const trimmed = e.trim();
        if (trimmed.includes("@")) emails.push(trimmed);
      }
    }

    // Extract phones
    const phoneLine = block.match(/Phone:\s*(.+)/);
    const phones: string[] = [];
    if (phoneLine) {
      for (const p of phoneLine[1].split(",")) {
        const trimmed = p.trim();
        if (trimmed) phones.push(trimmed);
      }
    }

    // Extract organization
    const orgMatch = block.match(/Organization:\s*(?:at\s+)?(.+)/);

    contacts.push({
      resourceName,
      displayName,
      emails: emails.length > 0 ? emails : undefined,
      phones: phones.length > 0 ? phones : undefined,
      organization: orgMatch?.[1]?.trim(),
    });
  }

  return contacts;
}

// ── Read the MCP response from file argument ───────────────────
const mcpResponseFile = process.argv[2];
if (!mcpResponseFile) {
  console.error("Usage: bun run scripts/run-google-contacts-sync.ts <mcp-response-file>");
  process.exit(1);
}

const mcpResponse = readFileSync(mcpResponseFile, "utf-8");
const contacts = parseMcpContactsOutput(mcpResponse);
console.log(`Parsed ${contacts.length} contacts from MCP response`);

// ── Wire up the pipeline ───────────────────────────────────────

// Fetcher: returns the pre-fetched contacts (single page, no pagination)
const fetcher: GoogleContactsFetcher = async () => ({
  contacts,
  totalItems: contacts.length,
});

// Writer: upserts to mountain_records via Forest DB
const writer = async (payload: ContactIdentityPayload): Promise<void> => {
  await upsertRecord({
    record_type: payload.record_type,
    source_system: payload.source_system,
    external_id: payload.external_id,
    payload: payload.payload,
    summary: payload.summary,
    status: "active",
  });
};

// State store: file-backed
const stateStore: SyncStateStore = {
  async read(): Promise<SyncState | null> {
    if (!existsSync(STATE_FILE)) return null;
    try {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    } catch {
      return null;
    }
  },
  async write(state: SyncState): Promise<void> {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  },
};

// ── Run the sync ───────────────────────────────────────────────

const pipeline = new GoogleContactsSyncPipeline(fetcher, writer, stateStore, {
  incremental: false, // First run — process all contacts
});

console.log("Starting sync...");
const result = await pipeline.sync((progress) => {
  if (progress.phase === "processing" && progress.processed % 10 === 0) {
    console.log(`  Processing: ${progress.processed}/${progress.total}`);
  }
});

console.log("\n=== Sync Complete ===");
console.log(`  Imported: ${result.imported}`);
console.log(`  Merged:   ${result.merged}`);
console.log(`  Skipped:  ${result.skipped}`);
console.log(`  Errors:   ${result.errors}`);
console.log(`  Total:    ${result.total}`);
console.log(`  Duration: ${result.durationMs}ms`);

if (result.errorDetails.length > 0) {
  console.log("\nErrors:");
  for (const err of result.errorDetails) {
    console.log(`  ${err.displayName} (${err.resourceName}): ${err.error}`);
  }
}

process.exit(result.errors > 0 ? 1 : 0);
