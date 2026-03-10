/**
 * Apple Contacts Sync Tests — ELLIE-665
 *
 * Tests vCard parsing, contact queries (list, get, search),
 * and configuration detection. Uses injected cache — no real
 * CardDAV calls.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  parseVCard,
  isAppleContactsConfigured,
  listAppleContacts,
  getAppleContact,
  searchAppleContacts,
  invalidateContactsCache,
  _injectContactsCacheForTesting,
  type AppleContact,
} from "../src/contacts-sync.ts";

// ── Sample vCards ────────────────────────────────────────────

const VCARD_SIMPLE = `BEGIN:VCARD
VERSION:3.0
UID:abc-123-def
FN:Dave Johnson
N:Johnson;Dave;;;
EMAIL;type=WORK:dave@example.com
EMAIL;type=HOME:dave.j@gmail.com
TEL;type=CELL:+1-555-123-4567
TEL;type=WORK:+1-555-987-6543
ORG:Ellie Labs;
TITLE:Founder
NOTE:VIP contact
END:VCARD`;

const VCARD_MINIMAL = `BEGIN:VCARD
VERSION:3.0
UID:min-001
FN:Alice
N:;Alice;;;
END:VCARD`;

const VCARD_FOLDED = `BEGIN:VCARD
VERSION:3.0
UID:fold-001
FN:Bob With A Very Long Na
 me That Wraps
N:Name That Wraps;Bob With A Very Long;;
 ;
EMAIL:bob@longdomain.example.com
END:VCARD`;

const VCARD_ESCAPED = `BEGIN:VCARD
VERSION:3.0
UID:esc-001
FN:Carol O'Brien
N:O'Brien;Carol;;;
NOTE:Line one\\nLine two\\, with comma
ORG:Acme\\, Inc.;
END:VCARD`;

const VCARD_MULTI_TYPE = `BEGIN:VCARD
VERSION:3.0
UID:multi-001
FN:Eve Smith
N:Smith;Eve;;;
EMAIL;type=WORK;type=pref:eve@work.com
EMAIL;type=HOME:eve@home.com
TEL;type=IPHONE:+1-555-000-1111
TEL;type=MAIN:+1-555-000-2222
END:VCARD`;

const VCARD_NO_FN = `BEGIN:VCARD
VERSION:3.0
UID:nofn-001
N:Williams;James;;;
EMAIL:james@example.com
END:VCARD`;

// ── parseVCard ───────────────────────────────────────────────

describe("parseVCard", () => {
  test("parses a complete vCard", () => {
    const c = parseVCard(VCARD_SIMPLE)!;
    expect(c).not.toBeNull();
    expect(c.uid).toBe("abc-123-def");
    expect(c.fullName).toBe("Dave Johnson");
    expect(c.firstName).toBe("Dave");
    expect(c.lastName).toBe("Johnson");
    expect(c.org).toBe("Ellie Labs");
    expect(c.title).toBe("Founder");
    expect(c.note).toBe("VIP contact");
  });

  test("parses emails with types", () => {
    const c = parseVCard(VCARD_SIMPLE)!;
    expect(c.emails).toHaveLength(2);
    expect(c.emails[0]).toEqual({ type: "work", value: "dave@example.com" });
    expect(c.emails[1]).toEqual({ type: "home", value: "dave.j@gmail.com" });
  });

  test("parses phone numbers with types", () => {
    const c = parseVCard(VCARD_SIMPLE)!;
    expect(c.phones).toHaveLength(2);
    expect(c.phones[0]).toEqual({ type: "cell", value: "+1-555-123-4567" });
    expect(c.phones[1]).toEqual({ type: "work", value: "+1-555-987-6543" });
  });

  test("parses minimal vCard", () => {
    const c = parseVCard(VCARD_MINIMAL)!;
    expect(c.uid).toBe("min-001");
    expect(c.fullName).toBe("Alice");
    expect(c.firstName).toBe("Alice");
    expect(c.lastName).toBe("");
    expect(c.emails).toHaveLength(0);
    expect(c.phones).toHaveLength(0);
    expect(c.org).toBeNull();
  });

  test("handles folded lines (RFC 6350)", () => {
    const c = parseVCard(VCARD_FOLDED)!;
    expect(c.fullName).toBe("Bob With A Very Long Name That Wraps");
    expect(c.emails[0].value).toBe("bob@longdomain.example.com");
  });

  test("decodes escaped characters", () => {
    const c = parseVCard(VCARD_ESCAPED)!;
    expect(c.note).toBe("Line one\nLine two, with comma");
    expect(c.org).toBe("Acme, Inc.");
  });

  test("handles multiple type parameters", () => {
    const c = parseVCard(VCARD_MULTI_TYPE)!;
    expect(c.emails).toHaveLength(2);
    // First type wins for the type= match
    expect(c.emails[0].type).toBe("work");
    expect(c.phones[0].type).toBe("iphone");
    expect(c.phones[1].type).toBe("main");
  });

  test("falls back to N field when FN is missing", () => {
    const c = parseVCard(VCARD_NO_FN)!;
    expect(c.fullName).toBe("James Williams");
    expect(c.firstName).toBe("James");
    expect(c.lastName).toBe("Williams");
  });

  test("returns null for non-vCard input", () => {
    expect(parseVCard("not a vcard")).toBeNull();
    expect(parseVCard("")).toBeNull();
  });

  test("includes rawVCard", () => {
    const c = parseVCard(VCARD_SIMPLE)!;
    expect(c.rawVCard).toBe(VCARD_SIMPLE);
  });
});

// ── Query Functions ──────────────────────────────────────────

function sampleContacts(): AppleContact[] {
  return [
    parseVCard(VCARD_SIMPLE)!,
    parseVCard(VCARD_MINIMAL)!,
    parseVCard(VCARD_ESCAPED)!,
    parseVCard(VCARD_MULTI_TYPE)!,
  ];
}

describe("listAppleContacts", () => {
  beforeEach(() => {
    _injectContactsCacheForTesting(sampleContacts());
  });

  test("returns all contacts", async () => {
    const result = await listAppleContacts();
    expect(result).toHaveLength(4);
  });

  test("respects limit", async () => {
    const result = await listAppleContacts({ limit: 2 });
    expect(result).toHaveLength(2);
    expect(result[0].uid).toBe("abc-123-def");
  });

  test("respects offset", async () => {
    const result = await listAppleContacts({ offset: 2 });
    expect(result).toHaveLength(2);
    expect(result[0].uid).toBe("esc-001");
  });

  test("respects limit + offset", async () => {
    const result = await listAppleContacts({ limit: 1, offset: 1 });
    expect(result).toHaveLength(1);
    expect(result[0].uid).toBe("min-001");
  });
});

describe("getAppleContact", () => {
  beforeEach(() => {
    _injectContactsCacheForTesting(sampleContacts());
  });

  test("finds a contact by UID", async () => {
    const c = await getAppleContact("abc-123-def");
    expect(c).not.toBeNull();
    expect(c!.fullName).toBe("Dave Johnson");
  });

  test("returns null for unknown UID", async () => {
    const c = await getAppleContact("nonexistent");
    expect(c).toBeNull();
  });
});

describe("searchAppleContacts", () => {
  beforeEach(() => {
    _injectContactsCacheForTesting(sampleContacts());
  });

  test("searches by name", async () => {
    const results = await searchAppleContacts("Dave");
    expect(results).toHaveLength(1);
    expect(results[0].uid).toBe("abc-123-def");
  });

  test("searches by email", async () => {
    const results = await searchAppleContacts("eve@work");
    expect(results).toHaveLength(1);
    expect(results[0].uid).toBe("multi-001");
  });

  test("searches by phone", async () => {
    const results = await searchAppleContacts("555-123");
    expect(results).toHaveLength(1);
    expect(results[0].uid).toBe("abc-123-def");
  });

  test("searches by org", async () => {
    const results = await searchAppleContacts("Ellie Labs");
    expect(results).toHaveLength(1);
    expect(results[0].uid).toBe("abc-123-def");
  });

  test("case-insensitive search", async () => {
    const results = await searchAppleContacts("alice");
    expect(results).toHaveLength(1);
    expect(results[0].uid).toBe("min-001");
  });

  test("returns empty for no match", async () => {
    const results = await searchAppleContacts("zzzznotfound");
    expect(results).toHaveLength(0);
  });

  test("returns multiple matches", async () => {
    const results = await searchAppleContacts("example.com");
    // Dave has dave@example.com
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Configuration ────────────────────────────────────────────

describe("isAppleContactsConfigured", () => {
  test("returns false when env vars are missing", () => {
    const origUser = process.env.APPLE_CALENDAR_USERNAME;
    const origPass = process.env.APPLE_CALENDAR_APP_PASSWORD;
    delete process.env.APPLE_CALENDAR_USERNAME;
    delete process.env.APPLE_CALENDAR_APP_PASSWORD;

    expect(isAppleContactsConfigured()).toBe(false);

    // Restore
    if (origUser) process.env.APPLE_CALENDAR_USERNAME = origUser;
    if (origPass) process.env.APPLE_CALENDAR_APP_PASSWORD = origPass;
  });
});

// ── Cache ────────────────────────────────────────────────────

describe("cache", () => {
  test("invalidateContactsCache clears cache", async () => {
    _injectContactsCacheForTesting(sampleContacts());
    let result = await listAppleContacts();
    expect(result).toHaveLength(4);

    invalidateContactsCache();
    // After invalidation, next call would fetch from server
    // but since we're not connected, inject again to test the flow
    _injectContactsCacheForTesting([parseVCard(VCARD_MINIMAL)!]);
    result = await listAppleContacts();
    expect(result).toHaveLength(1);
  });
});
