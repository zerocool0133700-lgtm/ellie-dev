/**
 * Tests for Google Contacts Sync Pipeline — ELLIE-670
 */
import { describe, test, expect } from "bun:test";
import {
  mapRawToInput,
  parseContactsListResponse,
  GoogleContactsSyncPipeline,
  _makeMockGoogleContactRaw,
  _makeMockGoogleContactsFetcher,
  _makeMockSyncStateStore,
  _makeMockContactWriter,
  type GoogleContactRaw,
  type GoogleContactsPage,
  type SyncState,
} from "../src/mountain/google-contacts-sync.ts";

// ── mapRawToInput ─────────────────────────────────────────────

describe("mapRawToInput", () => {
  test("maps full contact to GoogleContactInput", () => {
    const raw = _makeMockGoogleContactRaw({
      resourceName: "people/c123",
      displayName: "Dave Johnson",
      givenName: "Dave",
      familyName: "Johnson",
      emails: ["dave@test.com"],
      phones: ["+15551234567"],
      organization: "Acme Inc",
      jobTitle: "Engineer",
    });
    const input = mapRawToInput(raw);
    expect(input).not.toBeNull();
    expect(input!.resourceName).toBe("people/c123");
    expect(input!.displayName).toBe("Dave Johnson");
    expect(input!.givenName).toBe("Dave");
    expect(input!.familyName).toBe("Johnson");
    expect(input!.emails).toEqual(["dave@test.com"]);
    expect(input!.phones).toEqual(["+15551234567"]);
    expect(input!.organization).toBe("Acme Inc");
    expect(input!.jobTitle).toBe("Engineer");
  });

  test("constructs display name from given + family if missing", () => {
    const raw = _makeMockGoogleContactRaw({
      displayName: undefined,
      givenName: "Alice",
      familyName: "Smith",
    });
    const input = mapRawToInput(raw);
    expect(input!.displayName).toBe("Alice Smith");
  });

  test("returns null for contact with no name at all", () => {
    const raw: GoogleContactRaw = {
      resourceName: "people/c999",
      emails: ["anon@test.com"],
    };
    expect(mapRawToInput(raw)).toBeNull();
  });

  test("handles contact with only given name", () => {
    const raw = _makeMockGoogleContactRaw({
      displayName: undefined,
      givenName: "Bob",
      familyName: undefined,
    });
    const input = mapRawToInput(raw);
    expect(input!.displayName).toBe("Bob");
  });

  test("passes through optional fields as undefined when missing", () => {
    const raw = _makeMockGoogleContactRaw({
      emails: undefined,
      phones: undefined,
      organization: undefined,
      jobTitle: undefined,
    });
    const input = mapRawToInput(raw);
    expect(input!.emails).toBeUndefined();
    expect(input!.phones).toBeUndefined();
    expect(input!.organization).toBeUndefined();
    expect(input!.jobTitle).toBeUndefined();
  });
});

// ── parseContactsListResponse ─────────────────────────────────

describe("parseContactsListResponse", () => {
  test("parses a typical MCP list response", () => {
    const response = `Contacts (3 total):

1. Name: Dave Johnson
   Resource Name: people/c100
   Email: dave@example.com
   Phone: +15551234567
   Organization: Acme Inc
   Job Title: Engineer

2. Name: Alice Smith
   Resource Name: people/c200
   Email: alice@example.com, alice.personal@gmail.com
   Phone: +15559876543

3. Name: Bob Williams
   Resource Name: people/c300
   Email: bob@test.org

Total: 3
Next page token: abc123`;

    const result = parseContactsListResponse(response);
    expect(result.contacts.length).toBe(3);
    expect(result.nextPageToken).toBe("abc123");
    expect(result.totalItems).toBe(3);

    const dave = result.contacts[0];
    expect(dave.resourceName).toBe("people/c100");
    expect(dave.displayName).toBe("Dave Johnson");
    expect(dave.emails).toContain("dave@example.com");
    expect(dave.phones).toContain("+15551234567");
    expect(dave.organization).toBe("Acme Inc");
    expect(dave.jobTitle).toBe("Engineer");

    const alice = result.contacts[1];
    expect(alice.emails?.length).toBe(2);
    expect(alice.emails).toContain("alice@example.com");
    expect(alice.emails).toContain("alice.personal@gmail.com");
  });

  test("handles empty response", () => {
    const result = parseContactsListResponse("No contacts found.");
    expect(result.contacts.length).toBe(0);
    expect(result.nextPageToken).toBeUndefined();
  });

  test("handles response without pagination token", () => {
    const response = `1. Name: Solo Contact
   Resource Name: people/c1
   Email: solo@test.com

Total contacts: 1`;

    const result = parseContactsListResponse(response);
    expect(result.contacts.length).toBe(1);
    expect(result.nextPageToken).toBeUndefined();
    expect(result.totalItems).toBe(1);
  });

  test("extracts inline emails from text", () => {
    const response = `1. Name: Inline Person
   Resource Name: people/c50
   Contact info: reach me at inline@test.com or backup@test.org`;

    const result = parseContactsListResponse(response);
    const contact = result.contacts[0];
    expect(contact.emails).toContain("inline@test.com");
    expect(contact.emails).toContain("backup@test.org");
  });

  test("handles dash-style list format", () => {
    const response = `- Name: Dash Contact
  Resource Name: people/c77
  Email: dash@test.com`;

    const result = parseContactsListResponse(response);
    expect(result.contacts.length).toBe(1);
    expect(result.contacts[0].displayName).toBe("Dash Contact");
  });
});

// ── _makeMockGoogleContactRaw ─────────────────────────────────

describe("_makeMockGoogleContactRaw", () => {
  test("creates contact with defaults", () => {
    const raw = _makeMockGoogleContactRaw();
    expect(raw.resourceName).toMatch(/^people\/c\d+$/);
    expect(raw.displayName).toBe("Test Contact");
    expect(raw.emails).toEqual(["test@example.com"]);
  });

  test("accepts overrides", () => {
    const raw = _makeMockGoogleContactRaw({
      displayName: "Custom",
      emails: ["custom@test.com"],
    });
    expect(raw.displayName).toBe("Custom");
    expect(raw.emails).toEqual(["custom@test.com"]);
  });
});

// ── _makeMockGoogleContactsFetcher ────────────────────────────

describe("_makeMockGoogleContactsFetcher", () => {
  test("returns pages in order", async () => {
    const pages: GoogleContactsPage[] = [
      {
        contacts: [_makeMockGoogleContactRaw({ displayName: "Page1" })],
        nextPageToken: "token2",
      },
      {
        contacts: [_makeMockGoogleContactRaw({ displayName: "Page2" })],
      },
    ];
    const fetcher = _makeMockGoogleContactsFetcher(pages);

    const p1 = await fetcher(100);
    expect(p1.contacts[0].displayName).toBe("Page1");
    expect(p1.nextPageToken).toBe("token2");

    const p2 = await fetcher(100, "token2");
    expect(p2.contacts[0].displayName).toBe("Page2");
    expect(p2.nextPageToken).toBeUndefined();
  });

  test("returns empty page when exhausted", async () => {
    const fetcher = _makeMockGoogleContactsFetcher([]);
    const page = await fetcher(100);
    expect(page.contacts.length).toBe(0);
  });
});

// ── _makeMockSyncStateStore ───────────────────────────────────

describe("_makeMockSyncStateStore", () => {
  test("starts with null state by default", async () => {
    const store = _makeMockSyncStateStore();
    expect(await store.read()).toBeNull();
  });

  test("starts with provided initial state", async () => {
    const initial: SyncState = {
      lastSyncAt: "2026-03-10T00:00:00Z",
      lastSyncCount: 5,
      totalSynced: 100,
      syncVersion: 3,
    };
    const store = _makeMockSyncStateStore(initial);
    expect(await store.read()).toEqual(initial);
  });

  test("persists written state", async () => {
    const store = _makeMockSyncStateStore();
    const state: SyncState = {
      lastSyncAt: "2026-03-11T12:00:00Z",
      lastSyncCount: 10,
      totalSynced: 10,
      syncVersion: 1,
    };
    await store.write(state);
    expect(await store.read()).toEqual(state);
    expect(store.getState()).toEqual(state);
  });
});

// ── _makeMockContactWriter ────────────────────────────────────

describe("_makeMockContactWriter", () => {
  test("records written payloads", async () => {
    const writer = _makeMockContactWriter();
    expect(writer.getWritten().length).toBe(0);

    await writer({
      record_type: "contact_identity",
      source_system: "google-contacts",
      external_id: "contact:google-contacts:people/c1",
      payload: { displayName: "Test" },
      summary: "Test Contact",
    } as any);

    expect(writer.getWritten().length).toBe(1);
  });
});

// ── GoogleContactsSyncPipeline ────────────────────────────────

describe("GoogleContactsSyncPipeline", () => {
  function makeTestContacts(count: number, prefix = "Contact"): GoogleContactRaw[] {
    return Array.from({ length: count }, (_, i) =>
      _makeMockGoogleContactRaw({
        resourceName: `people/c${i + 1}`,
        displayName: `${prefix} ${i + 1}`,
        givenName: prefix,
        familyName: `${i + 1}`,
        emails: [`${prefix.toLowerCase()}${i + 1}@test.com`],
        phones: [`+1555000${String(i + 1).padStart(4, "0")}`],
      }),
    );
  }

  test("syncs contacts from single page", async () => {
    const contacts = makeTestContacts(3);
    const fetcher = _makeMockGoogleContactsFetcher([{ contacts }]);
    const writer = _makeMockContactWriter();
    const store = _makeMockSyncStateStore();

    const pipeline = new GoogleContactsSyncPipeline(fetcher, writer, store);
    const result = await pipeline.sync();

    expect(result.total).toBe(3);
    expect(result.imported).toBe(3);
    expect(result.merged).toBe(0);
    expect(result.errors).toBe(0);
    expect(writer.getWritten().length).toBe(3);
    expect(store.getState()).not.toBeNull();
    expect(store.getState()!.syncVersion).toBe(1);
    expect(store.getState()!.lastSyncCount).toBe(3);
  });

  test("syncs contacts across multiple pages", async () => {
    const page1Contacts = makeTestContacts(2, "PageOne");
    // Offset resource names, emails, and phones so they don't collide with page1
    const page2Contacts = makeTestContacts(2, "PageTwo").map((c, i) => ({
      ...c,
      resourceName: `people/c${i + 100}`,
      emails: [`pagetwo${i + 1}@unique.com`],
      phones: [`+1555999${String(i + 1).padStart(4, "0")}`],
    }));
    const fetcher = _makeMockGoogleContactsFetcher([
      { contacts: page1Contacts, nextPageToken: "page2" },
      { contacts: page2Contacts },
    ]);
    const writer = _makeMockContactWriter();
    const store = _makeMockSyncStateStore();

    const pipeline = new GoogleContactsSyncPipeline(fetcher, writer, store);
    const result = await pipeline.sync();

    expect(result.total).toBe(4);
    expect(result.imported).toBe(4);
    expect(writer.getWritten().length).toBe(4);
  });

  test("handles empty contacts list", async () => {
    const fetcher = _makeMockGoogleContactsFetcher([{ contacts: [] }]);
    const writer = _makeMockContactWriter();
    const store = _makeMockSyncStateStore();

    const pipeline = new GoogleContactsSyncPipeline(fetcher, writer, store);
    const result = await pipeline.sync();

    expect(result.total).toBe(0);
    expect(result.imported).toBe(0);
    expect(writer.getWritten().length).toBe(0);
    expect(store.getState()!.syncVersion).toBe(1);
  });

  test("skips contacts with no name", async () => {
    const contacts: GoogleContactRaw[] = [
      _makeMockGoogleContactRaw({ displayName: "Valid Contact", resourceName: "people/c1", emails: ["valid@test.com"] }),
      { resourceName: "people/c2", emails: ["noname@test.com"] }, // no name
    ];
    const fetcher = _makeMockGoogleContactsFetcher([{ contacts }]);
    const writer = _makeMockContactWriter();
    const store = _makeMockSyncStateStore();

    const pipeline = new GoogleContactsSyncPipeline(fetcher, writer, store);
    const result = await pipeline.sync();

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
  });

  test("merges duplicate contacts by email", async () => {
    // Two contacts with the same email should merge
    const contacts: GoogleContactRaw[] = [
      _makeMockGoogleContactRaw({
        resourceName: "people/c1",
        displayName: "Dave Work",
        emails: ["dave@shared.com"],
      }),
      _makeMockGoogleContactRaw({
        resourceName: "people/c2",
        displayName: "Dave Personal",
        emails: ["dave@shared.com"],
      }),
    ];
    const fetcher = _makeMockGoogleContactsFetcher([{ contacts }]);
    const writer = _makeMockContactWriter();
    const store = _makeMockSyncStateStore();

    const pipeline = new GoogleContactsSyncPipeline(fetcher, writer, store);
    const result = await pipeline.sync();

    expect(result.imported).toBe(1);
    expect(result.merged).toBe(1);
    // After merge, only the merged contact is flushed
    expect(writer.getWritten().length).toBe(1);
  });

  test("incremental sync skips old contacts", async () => {
    const now = new Date("2026-03-11T12:00:00Z");
    const contacts: GoogleContactRaw[] = [
      _makeMockGoogleContactRaw({
        resourceName: "people/c1",
        displayName: "Updated Contact",
        emails: ["updated@test.com"],
        updatedAt: "2026-03-11T10:00:00Z", // after last sync
      }),
      _makeMockGoogleContactRaw({
        resourceName: "people/c2",
        displayName: "Old Contact",
        emails: ["old@test.com"],
        updatedAt: "2026-03-09T10:00:00Z", // before last sync
      }),
    ];

    const fetcher = _makeMockGoogleContactsFetcher([{ contacts }]);
    const writer = _makeMockContactWriter();
    const store = _makeMockSyncStateStore({
      lastSyncAt: "2026-03-10T00:00:00Z",
      lastSyncCount: 5,
      totalSynced: 50,
      syncVersion: 3,
    });

    const pipeline = new GoogleContactsSyncPipeline(fetcher, writer, store, {
      incremental: true,
    });
    const result = await pipeline.sync();

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(store.getState()!.syncVersion).toBe(4);
    expect(store.getState()!.totalSynced).toBe(51);
  });

  test("full sync ignores last sync timestamp", async () => {
    const contacts: GoogleContactRaw[] = [
      _makeMockGoogleContactRaw({
        resourceName: "people/c1",
        displayName: "Old But Included",
        emails: ["old-but-included@test.com"],
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    ];

    const fetcher = _makeMockGoogleContactsFetcher([{ contacts }]);
    const writer = _makeMockContactWriter();
    const store = _makeMockSyncStateStore({
      lastSyncAt: "2026-03-10T00:00:00Z",
      lastSyncCount: 5,
      totalSynced: 50,
      syncVersion: 3,
    });

    const pipeline = new GoogleContactsSyncPipeline(fetcher, writer, store, {
      incremental: false,
    });
    const result = await pipeline.sync();

    expect(result.imported).toBe(1); // not skipped
  });

  test("respects maxContacts limit", async () => {
    const contacts = makeTestContacts(10);
    const fetcher = _makeMockGoogleContactsFetcher([{ contacts }]);
    const writer = _makeMockContactWriter();
    const store = _makeMockSyncStateStore();

    const pipeline = new GoogleContactsSyncPipeline(fetcher, writer, store, {
      maxContacts: 3,
    });
    const result = await pipeline.sync();

    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(7);
  });

  test("reports progress via callback", async () => {
    const contacts = makeTestContacts(3);
    const fetcher = _makeMockGoogleContactsFetcher([{ contacts }]);
    const writer = _makeMockContactWriter();
    const store = _makeMockSyncStateStore();

    const progressEvents: Array<{ phase: string; processed: number }> = [];
    const pipeline = new GoogleContactsSyncPipeline(fetcher, writer, store);
    await pipeline.sync((progress) => {
      progressEvents.push({ phase: progress.phase, processed: progress.processed });
    });

    expect(progressEvents.some((e) => e.phase === "fetching")).toBe(true);
    expect(progressEvents.some((e) => e.phase === "processing")).toBe(true);
    expect(progressEvents.some((e) => e.phase === "flushing")).toBe(true);
    expect(progressEvents.some((e) => e.phase === "complete")).toBe(true);
  });

  test("updates sync state on each run", async () => {
    const contacts = makeTestContacts(2);
    const fetcher = _makeMockGoogleContactsFetcher([{ contacts }]);
    const writer = _makeMockContactWriter();
    const store = _makeMockSyncStateStore();

    const pipeline = new GoogleContactsSyncPipeline(fetcher, writer, store);

    // First sync
    const r1 = await pipeline.sync();
    expect(r1.syncState.syncVersion).toBe(1);
    expect(r1.syncState.totalSynced).toBe(2);
  });

  test("accumulates totalSynced across runs", async () => {
    const store = _makeMockSyncStateStore({
      lastSyncAt: "2026-03-10T00:00:00Z",
      lastSyncCount: 5,
      totalSynced: 50,
      syncVersion: 3,
    });

    const contacts = makeTestContacts(3);
    // Mark all as recently updated so they pass incremental filter
    for (const c of contacts) c.updatedAt = "2026-03-11T12:00:00Z";

    const fetcher = _makeMockGoogleContactsFetcher([{ contacts }]);
    const writer = _makeMockContactWriter();

    const pipeline = new GoogleContactsSyncPipeline(fetcher, writer, store, {
      incremental: true,
    });
    const result = await pipeline.sync();

    expect(result.syncState.totalSynced).toBe(53);
    expect(result.syncState.syncVersion).toBe(4);
  });

  test("records errors for contacts that fail processing", async () => {
    // Create a contact that will cause an error by having the fetcher return
    // contacts but making the pipeline hit an edge case
    const contacts: GoogleContactRaw[] = [
      _makeMockGoogleContactRaw({
        resourceName: "people/c1",
        displayName: "Good Contact",
        emails: ["good@test.com"],
      }),
    ];

    const fetcher = _makeMockGoogleContactsFetcher([{ contacts }]);

    // Writer that throws on flush
    let flushCount = 0;
    const errorWriter = async () => {
      flushCount++;
      throw new Error("DB connection failed");
    };
    const store = _makeMockSyncStateStore();

    const pipeline = new GoogleContactsSyncPipeline(fetcher, errorWriter as any, store);
    const result = await pipeline.sync();

    // The contact is imported into seed pipeline (in-memory), flush fails with writer error
    expect(result.imported).toBe(1);
    expect(result.errors).toBeGreaterThan(0);
    expect(result.errorDetails.some((e) => e.error.includes("DB connection failed"))).toBe(true);
  });

  test("result includes duration", async () => {
    const fetcher = _makeMockGoogleContactsFetcher([{ contacts: [] }]);
    const writer = _makeMockContactWriter();
    const store = _makeMockSyncStateStore();

    const pipeline = new GoogleContactsSyncPipeline(fetcher, writer, store);
    const result = await pipeline.sync();

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ── dryRun ────────────────────────────────────────────────────

describe("dryRun", () => {
  test("previews what would happen without writing", async () => {
    const contacts: GoogleContactRaw[] = [
      _makeMockGoogleContactRaw({
        resourceName: "people/c1",
        displayName: "New Contact",
        emails: ["new@test.com"],
      }),
      _makeMockGoogleContactRaw({
        resourceName: "people/c2",
        displayName: "Same Email",
        emails: ["new@test.com"], // will merge
      }),
    ];

    const fetcher = _makeMockGoogleContactsFetcher([{ contacts }]);
    const writer = _makeMockContactWriter();
    const store = _makeMockSyncStateStore();

    const pipeline = new GoogleContactsSyncPipeline(fetcher, writer, store);
    const preview = await pipeline.dryRun();

    expect(preview.wouldImport).toBe(1);
    expect(preview.wouldMerge).toBe(1);
    expect(preview.contacts.length).toBe(2);
    // Writer should NOT have been called
    expect(writer.getWritten().length).toBe(0);
  });

  test("dry run skips contacts based on incremental sync", async () => {
    const contacts: GoogleContactRaw[] = [
      _makeMockGoogleContactRaw({
        resourceName: "people/c1",
        displayName: "Updated",
        emails: ["updated@test.com"],
        updatedAt: "2026-03-11T10:00:00Z",
      }),
      _makeMockGoogleContactRaw({
        resourceName: "people/c2",
        displayName: "Stale",
        emails: ["stale@test.com"],
        updatedAt: "2026-03-08T10:00:00Z",
      }),
    ];

    const fetcher = _makeMockGoogleContactsFetcher([{ contacts }]);
    const writer = _makeMockContactWriter();
    const store = _makeMockSyncStateStore({
      lastSyncAt: "2026-03-10T00:00:00Z",
      lastSyncCount: 5,
      totalSynced: 50,
      syncVersion: 3,
    });

    const pipeline = new GoogleContactsSyncPipeline(fetcher, writer, store, {
      incremental: true,
    });
    const preview = await pipeline.dryRun();

    expect(preview.wouldImport).toBe(1);
    expect(preview.wouldSkip).toBe(1);
    expect(preview.contacts.find((c) => c.displayName === "Stale")!.action).toBe("skip");
    expect(preview.contacts.find((c) => c.displayName === "Updated")!.action).toBe("import");
  });

  test("dry run does not modify state store", async () => {
    const contacts = [_makeMockGoogleContactRaw({ displayName: "Test", emails: ["test-dr@test.com"] })];
    const fetcher = _makeMockGoogleContactsFetcher([{ contacts }]);
    const writer = _makeMockContactWriter();
    const store = _makeMockSyncStateStore();

    const pipeline = new GoogleContactsSyncPipeline(fetcher, writer, store);
    await pipeline.dryRun();

    expect(store.getState()).toBeNull(); // unchanged
  });
});

// ── E2E ───────────────────────────────────────────────────────

describe("E2E: full Google Contacts sync flow", () => {
  test("initial sync + incremental sync", async () => {
    const store = _makeMockSyncStateStore();

    // Initial sync: 5 contacts, two share an email
    const initialContacts: GoogleContactRaw[] = [
      _makeMockGoogleContactRaw({
        resourceName: "people/c1",
        displayName: "Alice",
        emails: ["alice@corp.com"],
        phones: ["+15551110001"],
        updatedAt: "2026-03-10T08:00:00Z",
      }),
      _makeMockGoogleContactRaw({
        resourceName: "people/c2",
        displayName: "Bob",
        emails: ["bob@corp.com"],
        phones: ["+15551110002"],
        updatedAt: "2026-03-10T09:00:00Z",
      }),
      _makeMockGoogleContactRaw({
        resourceName: "people/c3",
        displayName: "Charlie",
        emails: ["charlie@corp.com"],
        phones: ["+15551110003"],
        updatedAt: "2026-03-10T10:00:00Z",
      }),
      _makeMockGoogleContactRaw({
        resourceName: "people/c4",
        displayName: "Alice Duplicate",
        emails: ["alice@corp.com"], // same email as c1 → merge
        phones: ["+15551110004"],
        updatedAt: "2026-03-10T11:00:00Z",
      }),
      _makeMockGoogleContactRaw({
        resourceName: "people/c5",
        displayName: "Eve",
        emails: ["eve@corp.com"],
        phones: ["+15551110005"],
        updatedAt: "2026-03-10T12:00:00Z",
      }),
    ];

    const writer1 = _makeMockContactWriter();
    const fetcher1 = _makeMockGoogleContactsFetcher([{ contacts: initialContacts }]);
    const pipeline1 = new GoogleContactsSyncPipeline(fetcher1, writer1, store);
    const r1 = await pipeline1.sync();

    expect(r1.imported).toBe(4); // alice, bob, charlie, eve
    expect(r1.merged).toBe(1); // alice duplicate
    expect(r1.total).toBe(5);
    expect(writer1.getWritten().length).toBe(4);
    expect(r1.syncState.syncVersion).toBe(1);

    // Incremental sync: 3 contacts returned, but only 2 updated since last sync
    // Use future timestamps (2026-03-14 = today) so they pass the incremental filter
    const incrementalContacts: GoogleContactRaw[] = [
      _makeMockGoogleContactRaw({
        resourceName: "people/c2",
        displayName: "Bob Updated",
        emails: ["bob@corp.com", "bob.new@corp.com"],
        phones: ["+15551110002"],
        updatedAt: "2026-03-14T15:00:00Z", // recently updated
      }),
      _makeMockGoogleContactRaw({
        resourceName: "people/c3",
        displayName: "Charlie",
        emails: ["charlie@corp.com"],
        phones: ["+15551110003"],
        updatedAt: "2026-03-10T10:00:00Z", // old — before last sync (should skip)
      }),
      _makeMockGoogleContactRaw({
        resourceName: "people/c6",
        displayName: "New Person",
        emails: ["newperson@corp.com"],
        phones: ["+15551110006"],
        updatedAt: "2026-03-14T16:00:00Z", // recently added
      }),
    ];

    const writer2 = _makeMockContactWriter();
    const fetcher2 = _makeMockGoogleContactsFetcher([{ contacts: incrementalContacts }]);
    const pipeline2 = new GoogleContactsSyncPipeline(fetcher2, writer2, store, {
      incremental: true,
    });
    const r2 = await pipeline2.sync();

    expect(r2.imported).toBe(2); // bob updated + new person
    expect(r2.skipped).toBe(1); // charlie (not updated)
    expect(r2.syncState.syncVersion).toBe(2);
    expect(r2.syncState.totalSynced).toBe(7); // 5 from first + 2 from second
    expect(writer2.getWritten().length).toBe(2);
  });
});
