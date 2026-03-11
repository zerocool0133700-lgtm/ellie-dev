/**
 * Mountain Contact Seed Tests — ELLIE-666
 *
 * Tests contact adapters, identity matching, CSV parsing,
 * pipeline dedup/merge, flush, and sender resolution.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  ContactSeedPipeline,
  scoreContactMatch,
  fuzzyNameMatch,
  normalizePhone,
  getFieldValues,
  appleContactToRecord,
  googleContactToRecord,
  discordMemberToRecord,
  linkedInConnectionToRecord,
  telegramUserToRecord,
  parseLinkedInCsv,
  parseCsvLine,
  buildContactPayload,
  resolveSenderIdentity,
  _makeMockContact,
  _makeMockWriter,
  _makeMockSourceAdapter,
  type ContactRecord,
  type AppleContactInput,
  type GoogleContactInput,
  type DiscordMemberInput,
  type LinkedInConnectionInput,
  type TelegramUserInput,
} from "../src/mountain/contact-seed.ts";

// ── normalizePhone ──────────────────────────────────────────

describe("normalizePhone", () => {
  test("strips spaces, dashes, parens, plus", () => {
    expect(normalizePhone("+1 (555) 123-4567")).toBe("15551234567");
  });

  test("handles already clean number", () => {
    expect(normalizePhone("15551234567")).toBe("15551234567");
  });

  test("strips dots", () => {
    expect(normalizePhone("555.123.4567")).toBe("5551234567");
  });
});

// ── fuzzyNameMatch ──────────────────────────────────────────

describe("fuzzyNameMatch", () => {
  test("exact match", () => {
    expect(fuzzyNameMatch("Dave", "Dave")).toBe(true);
  });

  test("case insensitive", () => {
    expect(fuzzyNameMatch("dave", "DAVE")).toBe(true);
  });

  test("substring match — first name vs full name", () => {
    expect(fuzzyNameMatch("Dave", "Dave Smith")).toBe(true);
  });

  test("no match for different names", () => {
    expect(fuzzyNameMatch("Dave", "Wincy")).toBe(false);
  });

  test("empty strings don't match", () => {
    expect(fuzzyNameMatch("", "Dave")).toBe(false);
    expect(fuzzyNameMatch("Dave", "")).toBe(false);
  });

  test("handles extra whitespace", () => {
    expect(fuzzyNameMatch("  Dave  Smith  ", "dave smith")).toBe(true);
  });
});

// ── parseCsvLine ────────────────────────────────────────────

describe("parseCsvLine", () => {
  test("simple comma-separated values", () => {
    expect(parseCsvLine("a,b,c")).toEqual(["a", "b", "c"]);
  });

  test("quoted fields with commas", () => {
    expect(parseCsvLine('"hello, world",b,c')).toEqual(["hello, world", "b", "c"]);
  });

  test("escaped quotes", () => {
    expect(parseCsvLine('"say ""hi""",b')).toEqual(['say "hi"', "b"]);
  });

  test("empty fields", () => {
    expect(parseCsvLine("a,,c")).toEqual(["a", "", "c"]);
  });
});

// ── parseLinkedInCsv ────────────────────────────────────────

describe("parseLinkedInCsv", () => {
  const CSV = `First Name,Last Name,Email Address,Company,Position,Connected On,URL
Dave,Smith,dave@example.com,Acme Inc,Engineer,10 Mar 2025,https://linkedin.com/in/davesmith
Wincy,Chen,,HealthCo,Doctor,15 Jan 2025,https://linkedin.com/in/wincychen`;

  test("parses valid CSV", () => {
    const results = parseLinkedInCsv(CSV);
    expect(results).toHaveLength(2);
    expect(results[0].firstName).toBe("Dave");
    expect(results[0].lastName).toBe("Smith");
    expect(results[0].emailAddress).toBe("dave@example.com");
    expect(results[0].company).toBe("Acme Inc");
    expect(results[0].position).toBe("Engineer");
    expect(results[0].profileUrl).toBe("https://linkedin.com/in/davesmith");
  });

  test("handles missing email", () => {
    const results = parseLinkedInCsv(CSV);
    expect(results[1].emailAddress).toBeUndefined();
  });

  test("returns empty for no header", () => {
    expect(parseLinkedInCsv("random data\nmore data")).toEqual([]);
  });

  test("returns empty for empty input", () => {
    expect(parseLinkedInCsv("")).toEqual([]);
  });

  test("handles notes before header", () => {
    const csv = `Notes: This is an export\n\n${CSV}`;
    const results = parseLinkedInCsv(csv);
    expect(results).toHaveLength(2);
  });

  test("skips empty rows", () => {
    const csv = `First Name,Last Name\nDave,Smith\n\n`;
    const results = parseLinkedInCsv(csv);
    expect(results).toHaveLength(1);
  });
});

// ── Source Adapters ─────────────────────────────────────────

describe("appleContactToRecord", () => {
  test("converts Apple contact with all fields", () => {
    const input: AppleContactInput = {
      uid: "abc-123",
      fullName: "Dave Smith",
      firstName: "Dave",
      lastName: "Smith",
      emails: [{ type: "WORK", value: "Dave@Example.com" }],
      phones: [{ type: "CELL", value: "+1 (555) 123-4567" }],
      org: "Acme Inc",
      title: "Engineer",
      note: "Met at conference",
    };

    const record = appleContactToRecord(input);
    expect(record.displayName).toBe("Dave Smith");
    expect(record.firstName).toBe("Dave");
    expect(record.source).toBe("apple-contacts");
    expect(record.sourceId).toBe("abc-123");
    expect(record.identifiers).toHaveLength(2);
    expect(record.identifiers[0]).toEqual({
      channel: "email",
      value: "dave@example.com",
      primary: true,
    });
    expect(record.identifiers[1].channel).toBe("phone");
    expect(record.identifiers[1].value).toBe("15551234567");
    expect(record.org).toBe("Acme Inc");
    expect(record.metadata?.note).toBe("Met at conference");
  });

  test("handles contact with no emails or phones", () => {
    const input: AppleContactInput = {
      uid: "xyz",
      fullName: "Jane Doe",
      firstName: "Jane",
      lastName: "Doe",
      emails: [],
      phones: [],
      org: null,
      title: null,
      note: null,
    };

    const record = appleContactToRecord(input);
    expect(record.identifiers).toHaveLength(0);
    expect(record.org).toBeUndefined();
    expect(record.metadata).toBeUndefined();
  });

  test("builds display name from parts when fullName is empty", () => {
    const input: AppleContactInput = {
      uid: "xyz",
      fullName: "",
      firstName: "Jane",
      lastName: "Doe",
      emails: [],
      phones: [],
      org: null,
      title: null,
      note: null,
    };

    const record = appleContactToRecord(input);
    expect(record.displayName).toBe("Jane Doe");
  });
});

describe("googleContactToRecord", () => {
  test("converts Google contact", () => {
    const input: GoogleContactInput = {
      resourceName: "people/c123",
      displayName: "Wincy Chen",
      givenName: "Wincy",
      familyName: "Chen",
      emails: ["wincy@example.com"],
      phones: ["555-0100"],
      organization: "HealthCo",
      jobTitle: "Doctor",
    };

    const record = googleContactToRecord(input);
    expect(record.displayName).toBe("Wincy Chen");
    expect(record.source).toBe("google-contacts");
    expect(record.sourceId).toBe("people/c123");
    expect(record.identifiers).toHaveLength(2);
    expect(record.identifiers[0].value).toBe("wincy@example.com");
    expect(record.org).toBe("HealthCo");
  });

  test("handles missing optional fields", () => {
    const input: GoogleContactInput = {
      resourceName: "people/c456",
      displayName: "Unknown",
    };

    const record = googleContactToRecord(input);
    expect(record.identifiers).toHaveLength(0);
    expect(record.firstName).toBeUndefined();
  });
});

describe("discordMemberToRecord", () => {
  test("converts Discord member", () => {
    const input: DiscordMemberInput = {
      userId: "999888777",
      username: "dave_dev",
      displayName: "Dave",
      guildId: "guild-123",
      roles: ["admin", "dev"],
      bot: false,
    };

    const record = discordMemberToRecord(input);
    expect(record.displayName).toBe("Dave");
    expect(record.source).toBe("discord");
    expect(record.sourceId).toBe("discord:guild-123:999888777");
    expect(record.identifiers).toHaveLength(1);
    expect(record.identifiers[0]).toEqual({
      channel: "discord",
      value: "999888777",
      primary: true,
    });
    expect(record.metadata?.username).toBe("dave_dev");
    expect(record.metadata?.roles).toEqual(["admin", "dev"]);
  });

  test("falls back to username when no displayName", () => {
    const input: DiscordMemberInput = {
      userId: "111",
      username: "bot_user",
      displayName: "",
      guildId: "guild-1",
    };

    const record = discordMemberToRecord(input);
    expect(record.displayName).toBe("bot_user");
  });
});

describe("linkedInConnectionToRecord", () => {
  test("converts LinkedIn connection", () => {
    const input: LinkedInConnectionInput = {
      firstName: "Dave",
      lastName: "Smith",
      emailAddress: "dave@example.com",
      company: "Acme",
      position: "CTO",
      connectedOn: "10 Mar 2025",
      profileUrl: "https://linkedin.com/in/dave",
    };

    const record = linkedInConnectionToRecord(input);
    expect(record.displayName).toBe("Dave Smith");
    expect(record.source).toBe("linkedin");
    expect(record.identifiers).toHaveLength(2);
    expect(record.identifiers[0].channel).toBe("email");
    expect(record.identifiers[1].channel).toBe("linkedin");
    expect(record.org).toBe("Acme");
    expect(record.metadata?.connectedOn).toBe("10 Mar 2025");
  });

  test("handles missing email and URL", () => {
    const input: LinkedInConnectionInput = {
      firstName: "Jane",
      lastName: "Doe",
    };

    const record = linkedInConnectionToRecord(input);
    expect(record.identifiers).toHaveLength(0);
    expect(record.sourceId).toBe("linkedin:Jane-Doe");
  });
});

describe("telegramUserToRecord", () => {
  test("converts Telegram user", () => {
    const input: TelegramUserInput = {
      userId: "12345",
      displayName: "Dave",
      username: "dave_dev",
    };

    const record = telegramUserToRecord(input);
    expect(record.displayName).toBe("Dave");
    expect(record.source).toBe("telegram");
    expect(record.sourceId).toBe("telegram:12345");
    expect(record.identifiers).toHaveLength(2);
    expect(record.identifiers[0].value).toBe("12345");
    expect(record.identifiers[1].value).toBe("@dave_dev");
  });

  test("handles no username", () => {
    const input: TelegramUserInput = {
      userId: "67890",
      displayName: "Wincy",
    };

    const record = telegramUserToRecord(input);
    expect(record.identifiers).toHaveLength(1);
  });
});

// ── scoreContactMatch ───────────────────────────────────────

describe("scoreContactMatch", () => {
  test("matches by email — high confidence", () => {
    const a = _makeMockContact({
      identifiers: [{ channel: "email", value: "dave@example.com" }],
    });
    const b = _makeMockContact({
      identifiers: [{ channel: "email", value: "dave@example.com" }],
    });

    expect(scoreContactMatch(a, b)).toBe(1.0);
  });

  test("matches by phone — high confidence", () => {
    const a = _makeMockContact({
      identifiers: [{ channel: "phone", value: "15551234567" }],
    });
    const b = _makeMockContact({
      identifiers: [{ channel: "phone", value: "15551234567" }],
    });

    expect(scoreContactMatch(a, b)).toBe(0.9);
  });

  test("matches by telegram ID", () => {
    const a = _makeMockContact({
      identifiers: [{ channel: "telegram", value: "12345" }],
    });
    const b = _makeMockContact({
      identifiers: [{ channel: "telegram", value: "12345" }],
    });

    expect(scoreContactMatch(a, b)).toBe(1.0);
  });

  test("matches by discord ID", () => {
    const a = _makeMockContact({
      identifiers: [{ channel: "discord", value: "999888" }],
    });
    const b = _makeMockContact({
      identifiers: [{ channel: "discord", value: "999888" }],
    });

    expect(scoreContactMatch(a, b)).toBe(1.0);
  });

  test("matches by linkedin URL", () => {
    const a = _makeMockContact({
      identifiers: [{ channel: "linkedin", value: "https://linkedin.com/in/dave" }],
    });
    const b = _makeMockContact({
      identifiers: [{ channel: "linkedin", value: "https://linkedin.com/in/dave" }],
    });

    expect(scoreContactMatch(a, b)).toBe(0.8);
  });

  test("matches by display name — low confidence", () => {
    const a = _makeMockContact({ displayName: "Dave Smith", identifiers: [] });
    const b = _makeMockContact({ displayName: "Dave Smith", identifiers: [] });

    expect(scoreContactMatch(a, b)).toBe(0.4);
  });

  test("no match for different contacts", () => {
    const a = _makeMockContact({
      displayName: "Dave",
      identifiers: [{ channel: "email", value: "dave@example.com" }],
    });
    const b = _makeMockContact({
      displayName: "Wincy",
      identifiers: [{ channel: "email", value: "wincy@example.com" }],
    });

    expect(scoreContactMatch(a, b)).toBe(0);
  });

  test("email match is case insensitive", () => {
    const a = _makeMockContact({
      identifiers: [{ channel: "email", value: "Dave@Example.COM" }],
    });
    const b = _makeMockContact({
      identifiers: [{ channel: "email", value: "dave@example.com" }],
    });

    expect(scoreContactMatch(a, b)).toBe(1.0);
  });

  test("returns highest matching score", () => {
    const a = _makeMockContact({
      displayName: "Dave",
      identifiers: [
        { channel: "email", value: "dave@example.com" },
        { channel: "phone", value: "555" },
      ],
    });
    const b = _makeMockContact({
      displayName: "Dave",
      identifiers: [
        { channel: "email", value: "dave@example.com" },
      ],
    });

    // Email match (1.0) > name match (0.4), so should get 1.0
    expect(scoreContactMatch(a, b)).toBe(1.0);
  });
});

// ── getFieldValues ──────────────────────────────────────────

describe("getFieldValues", () => {
  test("extracts display_name", () => {
    const contact = _makeMockContact({ displayName: "Dave" });
    expect(getFieldValues(contact, "display_name")).toEqual(["Dave"]);
  });

  test("extracts email identifiers", () => {
    const contact = _makeMockContact({
      identifiers: [
        { channel: "email", value: "a@b.com" },
        { channel: "email", value: "c@d.com" },
        { channel: "phone", value: "555" },
      ],
    });
    expect(getFieldValues(contact, "email")).toEqual(["a@b.com", "c@d.com"]);
  });

  test("extracts telegram identifiers", () => {
    const contact = _makeMockContact({
      identifiers: [{ channel: "telegram", value: "12345" }],
    });
    expect(getFieldValues(contact, "telegram_id")).toEqual(["12345"]);
  });

  test("returns empty for no matches", () => {
    const contact = _makeMockContact({ identifiers: [] });
    expect(getFieldValues(contact, "email")).toEqual([]);
  });
});

// ── buildContactPayload ─────────────────────────────────────

describe("buildContactPayload", () => {
  test("builds valid payload for mountain_records", () => {
    const contact = _makeMockContact({
      displayName: "Dave Smith",
      firstName: "Dave",
      lastName: "Smith",
      source: "apple-contacts",
      sourceId: "abc-123",
      org: "Acme",
    });

    const payload = buildContactPayload(contact);
    expect(payload.record_type).toBe("contact_identity");
    expect(payload.source_system).toBe("apple-contacts");
    expect(payload.external_id).toBe("contact:apple-contacts:abc-123");
    expect(payload.summary).toBe("Dave Smith");
    expect(payload.payload.displayName).toBe("Dave Smith");
    expect(payload.payload.identifiers).toHaveLength(2);
    expect(payload.payload.org).toBe("Acme");
  });

  test("handles null optional fields", () => {
    const contact = _makeMockContact({
      firstName: undefined,
      lastName: undefined,
      org: undefined,
      title: undefined,
    });

    const payload = buildContactPayload(contact);
    expect(payload.payload.firstName).toBeNull();
    expect(payload.payload.lastName).toBeNull();
    expect(payload.payload.org).toBeNull();
  });
});

// ── ContactSeedPipeline ─────────────────────────────────────

describe("ContactSeedPipeline", () => {
  let pipeline: ContactSeedPipeline;
  let mockWriter: ReturnType<typeof _makeMockWriter>;

  beforeEach(() => {
    mockWriter = _makeMockWriter();
    pipeline = new ContactSeedPipeline(mockWriter.writer);
  });

  test("adds a new contact", () => {
    const result = pipeline.addContact(_makeMockContact({ sourceId: "a1" }));
    expect(result).toBe("imported");
    expect(pipeline.contactCount).toBe(1);
  });

  test("skips duplicate from same source", () => {
    const contact = _makeMockContact({ source: "test", sourceId: "a1" });
    pipeline.addContact(contact);
    const result = pipeline.addContact(contact);
    expect(result).toBe("skipped");
    expect(pipeline.contactCount).toBe(1);
  });

  test("merges contacts with matching email", () => {
    const a = _makeMockContact({
      displayName: "Dave",
      source: "apple-contacts",
      sourceId: "apple-1",
      identifiers: [{ channel: "email", value: "dave@example.com" }],
    });
    const b = _makeMockContact({
      displayName: "Dave Smith",
      source: "google-contacts",
      sourceId: "google-1",
      identifiers: [
        { channel: "email", value: "dave@example.com" },
        { channel: "phone", value: "555" },
      ],
      org: "Acme",
    });

    pipeline.addContact(a);
    const result = pipeline.addContact(b);
    expect(result).toBe("merged");
    expect(pipeline.contactCount).toBe(1);

    const contacts = pipeline.getContacts();
    // Should have merged identifiers
    expect(contacts[0].identifiers.length).toBeGreaterThanOrEqual(2);
    // Should have filled org from second source
    expect(contacts[0].org).toBe("Acme");
  });

  test("does not merge contacts below threshold", () => {
    const a = _makeMockContact({
      displayName: "Dave",
      source: "test",
      sourceId: "a1",
      identifiers: [],
    });
    const b = _makeMockContact({
      displayName: "Wincy",
      source: "test",
      sourceId: "a2",
      identifiers: [],
    });

    pipeline.addContact(a);
    pipeline.addContact(b);
    expect(pipeline.contactCount).toBe(2);
  });

  test("importSource fetches and adds contacts", async () => {
    const contacts = [
      _makeMockContact({ displayName: "Alice", sourceId: "c1", identifiers: [{ channel: "email", value: "alice@example.com" }] }),
      _makeMockContact({ displayName: "Bob", sourceId: "c2", identifiers: [{ channel: "email", value: "bob@example.com" }] }),
    ];
    const adapter = _makeMockSourceAdapter("test-source", contacts);

    const result = await pipeline.importSource(adapter);
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
    expect(pipeline.contactCount).toBe(2);
  });

  test("importSource skips unavailable adapters", async () => {
    const adapter = _makeMockSourceAdapter("offline", [], false);
    const result = await pipeline.importSource(adapter);
    expect(result.imported).toBe(0);
    expect(pipeline.contactCount).toBe(0);
  });

  test("importSource handles fetch errors", async () => {
    const adapter: ReturnType<typeof _makeMockSourceAdapter> = {
      id: "broken",
      isAvailable: () => true,
      fetch: async () => {
        throw new Error("Network error");
      },
    };

    const result = await pipeline.importSource(adapter);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain("Network error");
  });

  test("flush writes all contacts via writer", async () => {
    pipeline.addContact(_makeMockContact({ displayName: "Alice", sourceId: "c1", identifiers: [{ channel: "email", value: "alice@test.com" }] }));
    pipeline.addContact(_makeMockContact({ displayName: "Bob", sourceId: "c2", identifiers: [{ channel: "email", value: "bob@test.com" }] }));

    const result = await pipeline.flush();
    expect(result.imported).toBe(2);
    expect(mockWriter.written).toHaveLength(2);
    expect(mockWriter.written[0].record_type).toBe("contact_identity");
  });

  test("flush handles writer errors", async () => {
    let callCount = 0;
    const failWriter = _makeMockWriter();
    failWriter.writer = async (payload) => {
      callCount++;
      if (callCount === 1) throw new Error("Write failed");
      failWriter.written.push(payload);
    };

    const failPipeline = new ContactSeedPipeline(failWriter.writer);
    failPipeline.addContact(_makeMockContact({ displayName: "Alice", sourceId: "c1", identifiers: [{ channel: "email", value: "alice@test.com" }] }));
    failPipeline.addContact(_makeMockContact({ displayName: "Bob", sourceId: "c2", identifiers: [{ channel: "email", value: "bob@test.com" }] }));

    const result = await failPipeline.flush();
    expect(result.errors).toHaveLength(1);
    expect(result.imported).toBe(1);
  });

  test("findByName searches contacts", () => {
    pipeline.addContact(_makeMockContact({ displayName: "Dave Smith", sourceId: "c1", identifiers: [{ channel: "email", value: "dave@test.com" }] }));
    pipeline.addContact(_makeMockContact({ displayName: "Wincy Chen", sourceId: "c2", identifiers: [{ channel: "email", value: "wincy@test.com" }] }));

    expect(pipeline.findByName("Dave")).toHaveLength(1);
    expect(pipeline.findByName("chen")).toHaveLength(1);
    expect(pipeline.findByName("nobody")).toHaveLength(0);
  });

  test("findByIdentifier searches by channel + value", () => {
    pipeline.addContact(
      _makeMockContact({
        sourceId: "c1",
        identifiers: [{ channel: "telegram", value: "12345" }],
      }),
    );

    expect(pipeline.findByIdentifier("telegram", "12345")).not.toBeNull();
    expect(pipeline.findByIdentifier("telegram", "99999")).toBeNull();
    expect(pipeline.findByIdentifier("discord", "12345")).toBeNull();
  });

  test("findByIdentifier is case insensitive", () => {
    pipeline.addContact(
      _makeMockContact({
        sourceId: "c1",
        identifiers: [{ channel: "email", value: "Dave@Example.com" }],
      }),
    );

    expect(pipeline.findByIdentifier("email", "dave@example.com")).not.toBeNull();
  });

  test("clear removes all contacts", () => {
    pipeline.addContact(_makeMockContact({ sourceId: "c1" }));
    expect(pipeline.contactCount).toBe(1);

    pipeline.clear();
    expect(pipeline.contactCount).toBe(0);
  });

  test("merge fills missing fields from second source", () => {
    const a = _makeMockContact({
      displayName: "Dave",
      source: "telegram",
      sourceId: "t1",
      identifiers: [{ channel: "telegram", value: "12345" }],
      firstName: undefined,
      lastName: undefined,
      org: undefined,
    });
    const b = _makeMockContact({
      displayName: "Dave Smith",
      source: "apple-contacts",
      sourceId: "apple-1",
      identifiers: [{ channel: "telegram", value: "12345" }],
      firstName: "Dave",
      lastName: "Smith",
      org: "Acme",
    });

    pipeline.addContact(a);
    pipeline.addContact(b);

    const contacts = pipeline.getContacts();
    expect(contacts).toHaveLength(1);
    expect(contacts[0].firstName).toBe("Dave");
    expect(contacts[0].lastName).toBe("Smith");
    expect(contacts[0].org).toBe("Acme");
  });
});

// ── resolveSenderIdentity ───────────────────────────────────

describe("resolveSenderIdentity", () => {
  test("resolves known sender", () => {
    const { writer } = _makeMockWriter();
    const pipeline = new ContactSeedPipeline(writer);
    pipeline.addContact(
      _makeMockContact({
        displayName: "Dave",
        sourceId: "c1",
        identifiers: [{ channel: "telegram", value: "12345" }],
      }),
    );

    const result = resolveSenderIdentity(pipeline, "telegram", "12345");
    expect(result).not.toBeNull();
    expect(result!.displayName).toBe("Dave");
  });

  test("returns null for unknown sender", () => {
    const { writer } = _makeMockWriter();
    const pipeline = new ContactSeedPipeline(writer);

    const result = resolveSenderIdentity(pipeline, "telegram", "99999");
    expect(result).toBeNull();
  });
});

// ── E2E: Multi-source import + dedup + flush ────────────────

describe("E2E: multi-source contact seed", () => {
  test("imports from multiple sources with cross-source dedup", async () => {
    const mockWriter = _makeMockWriter();
    const pipeline = new ContactSeedPipeline(mockWriter.writer);

    // Apple contacts
    const appleAdapter = _makeMockSourceAdapter("apple", [
      appleContactToRecord({
        uid: "apple-1",
        fullName: "Dave Smith",
        firstName: "Dave",
        lastName: "Smith",
        emails: [{ type: "WORK", value: "dave@example.com" }],
        phones: [{ type: "CELL", value: "555-1234" }],
        org: "Acme",
        title: "Engineer",
        note: null,
      }),
    ]);

    // Google contacts — same person (matching email)
    const googleAdapter = _makeMockSourceAdapter("google", [
      googleContactToRecord({
        resourceName: "people/c1",
        displayName: "Dave Smith",
        givenName: "Dave",
        familyName: "Smith",
        emails: ["dave@example.com"],
      }),
    ]);

    // Telegram user
    const telegramAdapter = _makeMockSourceAdapter("telegram", [
      telegramUserToRecord({
        userId: "12345",
        displayName: "Dave",
        username: "dave_dev",
      }),
    ]);

    // Discord member — different person
    const discordAdapter = _makeMockSourceAdapter("discord", [
      discordMemberToRecord({
        userId: "999",
        username: "wincy_bot",
        displayName: "Wincy",
        guildId: "guild-1",
      }),
    ]);

    const r1 = await pipeline.importSource(appleAdapter);
    const r2 = await pipeline.importSource(googleAdapter);
    const r3 = await pipeline.importSource(telegramAdapter);
    const r4 = await pipeline.importSource(discordAdapter);

    expect(r1.imported).toBe(1);
    expect(r2.merged).toBe(1); // Google Dave merged with Apple Dave
    expect(r4.imported).toBe(1); // Wincy is a different person

    // Dave from Telegram won't match Apple Dave (no shared email/phone/telegram)
    // unless name matching triggers — but threshold is 0.7 and name match weight is 0.4
    // So Telegram Dave should be a new contact
    expect(pipeline.contactCount).toBeGreaterThanOrEqual(2); // At least Dave(s) + Wincy

    // Flush
    const flushResult = await pipeline.flush();
    expect(flushResult.imported).toBe(pipeline.contactCount);
    expect(mockWriter.written.length).toBe(pipeline.contactCount);

    // Verify all records have contact_identity type
    for (const payload of mockWriter.written) {
      expect(payload.record_type).toBe("contact_identity");
      expect(payload.external_id).toContain("contact:");
    }
  });

  test("LinkedIn CSV → contacts → flush", async () => {
    const mockWriter = _makeMockWriter();
    const pipeline = new ContactSeedPipeline(mockWriter.writer);

    const csv = `First Name,Last Name,Email Address,Company,Position,Connected On,URL
Alice,Johnson,alice@example.com,TechCo,PM,01 Jan 2026,https://linkedin.com/in/alice
Bob,Brown,,StartupX,Founder,15 Feb 2026,https://linkedin.com/in/bob`;

    const connections = parseLinkedInCsv(csv);
    const records = connections.map(linkedInConnectionToRecord);
    const adapter = _makeMockSourceAdapter("linkedin", records);

    const result = await pipeline.importSource(adapter);
    expect(result.imported).toBe(2);

    const flush = await pipeline.flush();
    expect(flush.imported).toBe(2);

    // Alice should have email + linkedin identifiers
    const alice = pipeline.findByIdentifier("email", "alice@example.com");
    expect(alice).not.toBeNull();
    expect(alice!.identifiers).toHaveLength(2);
    expect(alice!.org).toBe("TechCo");

    // Bob has only linkedin (no email)
    const bob = pipeline.findByIdentifier("linkedin", "https://linkedin.com/in/bob");
    expect(bob).not.toBeNull();
    expect(bob!.identifiers).toHaveLength(1);
  });

  test("idempotent re-import skips duplicates", async () => {
    const mockWriter = _makeMockWriter();
    const pipeline = new ContactSeedPipeline(mockWriter.writer);

    const contacts = [
      _makeMockContact({ source: "test", sourceId: "fixed-id-1" }),
    ];
    const adapter = _makeMockSourceAdapter("test", contacts);

    const r1 = await pipeline.importSource(adapter);
    expect(r1.imported).toBe(1);

    const r2 = await pipeline.importSource(adapter);
    expect(r2.skipped).toBe(1);
    expect(r2.imported).toBe(0);

    expect(pipeline.contactCount).toBe(1);
  });
});
