/**
 * Apple Contacts Sync — ELLIE-665
 *
 * CardDAV client for Apple iCloud contacts. Fetches vCards,
 * parses into structured contact records, and exposes as
 * callable functions (list, get, search).
 *
 * Reuses the same Apple ID credentials as calendar-sync.ts
 * (APPLE_CALENDAR_USERNAME + APPLE_CALENDAR_APP_PASSWORD).
 */

import { log } from "./logger.ts";

const logger = log.child("contacts-sync");

const APPLE_CARDDAV_SERVER = "https://contacts.icloud.com";

// ── Types ────────────────────────────────────────────────────

export interface AppleContact {
  /** vCard UID */
  uid: string;

  /** Full formatted name */
  fullName: string;

  /** First name */
  firstName: string;

  /** Last name */
  lastName: string;

  /** Email addresses with labels */
  emails: Array<{ type: string; value: string }>;

  /** Phone numbers with labels */
  phones: Array<{ type: string; value: string }>;

  /** Organization name */
  org: string | null;

  /** Job title */
  title: string | null;

  /** Note/comment */
  note: string | null;

  /** URL of the vCard on the server */
  url: string | null;

  /** Raw vCard data */
  rawVCard: string;
}

// ── Config check ─────────────────────────────────────────────

export function isAppleContactsConfigured(): boolean {
  return !!(
    process.env.APPLE_CALENDAR_USERNAME &&
    process.env.APPLE_CALENDAR_APP_PASSWORD
  );
}

// ── vCard Parser ─────────────────────────────────────────────

/**
 * Parse a vCard string into a structured AppleContact.
 * Handles vCard 3.0 format from iCloud.
 */
export function parseVCard(vcard: string): AppleContact | null {
  if (!vcard.includes("BEGIN:VCARD")) return null;

  const lines = unfoldVCard(vcard);

  const uid = getProperty(lines, "UID") ?? `unknown-${Date.now()}`;
  const fn = getProperty(lines, "FN") ?? "";
  const n = getProperty(lines, "N") ?? "";
  const org = getProperty(lines, "ORG") ?? null;
  const title = getProperty(lines, "TITLE") ?? null;
  const note = getProperty(lines, "NOTE") ?? null;

  // Parse N field: last;first;middle;prefix;suffix
  const nParts = n.split(";");
  const lastName = nParts[0] ?? "";
  const firstName = nParts[1] ?? "";

  const emails = getTypedProperties(lines, "EMAIL");
  const phones = getTypedProperties(lines, "TEL");

  return {
    uid,
    fullName: fn || `${firstName} ${lastName}`.trim(),
    firstName,
    lastName,
    emails,
    phones,
    org: org ? org.replace(/;+$/, "") : null,
    title,
    note,
    url: null,
    rawVCard: vcard,
  };
}

/**
 * Unfold vCard lines (RFC 6350: lines starting with space/tab
 * are continuations of the previous line).
 */
function unfoldVCard(vcard: string): string[] {
  const raw = vcard.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const folded = raw.split("\n");
  const unfolded: string[] = [];

  for (const line of folded) {
    if (line.startsWith(" ") || line.startsWith("\t")) {
      if (unfolded.length > 0) {
        unfolded[unfolded.length - 1] += line.slice(1);
      }
    } else {
      unfolded.push(line);
    }
  }

  return unfolded;
}

/**
 * Get the first value of a simple property.
 */
function getProperty(lines: string[], name: string): string | undefined {
  const prefix = `${name}:`;
  const prefixParam = `${name};`;
  for (const line of lines) {
    if (line.startsWith(prefix)) {
      return decodeVCardValue(line.slice(prefix.length));
    }
    if (line.startsWith(prefixParam)) {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        return decodeVCardValue(line.slice(colonIdx + 1));
      }
    }
  }
  return undefined;
}

/**
 * Get all typed properties (EMAIL, TEL) with their type labels.
 */
function getTypedProperties(
  lines: string[],
  name: string,
): Array<{ type: string; value: string }> {
  const results: Array<{ type: string; value: string }> = [];

  for (const line of lines) {
    if (!line.startsWith(`${name}:`) && !line.startsWith(`${name};`)) continue;

    let type = "other";
    let value = "";

    if (line.startsWith(`${name}:`)) {
      value = line.slice(name.length + 1);
    } else {
      // Has parameters: EMAIL;type=WORK:foo@bar.com
      const colonIdx = line.indexOf(":");
      if (colonIdx < 0) continue;

      const params = line.slice(name.length + 1, colonIdx);
      value = line.slice(colonIdx + 1);

      // Extract type from params
      const typeMatch = params.match(/type=([^;,:]+)/i);
      if (typeMatch) {
        type = typeMatch[1].toLowerCase();
      }
    }

    value = decodeVCardValue(value).replace(/^tel:/i, "");
    if (value) {
      results.push({ type, value });
    }
  }

  return results;
}

/**
 * Decode vCard escaped characters.
 */
function decodeVCardValue(val: string): string {
  return val
    .replace(/\\n/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

// ── CardDAV Client ───────────────────────────────────────────

/**
 * Fetch all contacts from Apple iCloud via CardDAV.
 * Returns parsed AppleContact records.
 */
export async function fetchAppleContacts(): Promise<AppleContact[]> {
  if (!isAppleContactsConfigured()) {
    logger.warn("Apple contacts not configured (missing APPLE_CALENDAR_USERNAME or APPLE_CALENDAR_APP_PASSWORD)");
    return [];
  }

  const { createDAVClient } = await import("tsdav");

  const client = await createDAVClient({
    serverUrl: APPLE_CARDDAV_SERVER,
    credentials: {
      username: process.env.APPLE_CALENDAR_USERNAME!,
      password: process.env.APPLE_CALENDAR_APP_PASSWORD!,
    },
    authMethod: "Basic",
    defaultAccountType: "carddav",
  });

  const addressBooks = await client.fetchAddressBooks();
  const contacts: AppleContact[] = [];

  for (const book of addressBooks) {
    try {
      const vcards = await client.fetchVCards({ addressBook: book });

      for (const vcard of vcards) {
        if (!vcard.data) continue;
        try {
          const contact = parseVCard(vcard.data);
          if (contact) {
            contact.url = vcard.url ?? null;
            contacts.push(contact);
          }
        } catch (err) {
          logger.error("vCard parse error", {
            url: vcard.url,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      logger.error("Address book fetch error", {
        book: book.displayName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info(`Fetched ${contacts.length} Apple contacts`);
  return contacts;
}

// ── Query Functions (MCP-callable) ───────────────────────────

let _contactsCache: AppleContact[] | null = null;
let _cacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getContactsCache(): Promise<AppleContact[]> {
  const now = Date.now();
  if (_contactsCache && now - _cacheTime < CACHE_TTL_MS) {
    return _contactsCache;
  }
  _contactsCache = await fetchAppleContacts();
  _cacheTime = now;
  return _contactsCache;
}

/** Invalidate the contacts cache (e.g. after a sync). */
export function invalidateContactsCache(): void {
  _contactsCache = null;
  _cacheTime = 0;
}

/** For testing: inject a cache directly. */
export function _injectContactsCacheForTesting(contacts: AppleContact[]): void {
  _contactsCache = contacts;
  _cacheTime = Date.now();
}

/**
 * List all contacts, optionally limited.
 */
export async function listAppleContacts(opts?: {
  limit?: number;
  offset?: number;
}): Promise<AppleContact[]> {
  const all = await getContactsCache();
  const offset = opts?.offset ?? 0;
  const limit = opts?.limit ?? all.length;
  return all.slice(offset, offset + limit);
}

/**
 * Get a contact by UID.
 */
export async function getAppleContact(
  uid: string,
): Promise<AppleContact | null> {
  const all = await getContactsCache();
  return all.find((c) => c.uid === uid) ?? null;
}

/**
 * Search contacts by name, email, phone, or org.
 * Case-insensitive substring match.
 */
export async function searchAppleContacts(
  query: string,
): Promise<AppleContact[]> {
  const all = await getContactsCache();
  const q = query.toLowerCase();

  return all.filter((c) => {
    if (c.fullName.toLowerCase().includes(q)) return true;
    if (c.org?.toLowerCase().includes(q)) return true;
    if (c.emails.some((e) => e.value.toLowerCase().includes(q))) return true;
    if (c.phones.some((p) => p.value.includes(q))) return true;
    return false;
  });
}
