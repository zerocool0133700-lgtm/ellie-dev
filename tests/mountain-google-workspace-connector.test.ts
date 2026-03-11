/**
 * Tests for GoogleWorkspaceMountainSource — ELLIE-671
 *
 * Covers: calendar fetch, contacts fetch, record type routing,
 * error handling, pagination, and E2E harvest.
 */

import { describe, test, expect, mock } from "bun:test";
import { GoogleWorkspaceMountainSource } from "../src/mountain/connectors/google-workspace.ts";
import type { HarvestJob } from "../src/mountain/types.ts";

// ── Helpers ─────────────────────────────────────────────────

function makeMockToolCaller(responses: Record<string, unknown> = {}) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const fn = mock(async (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    if (responses[tool] !== undefined) {
      if (typeof responses[tool] === "function") {
        return (responses[tool] as Function)(args);
      }
      return responses[tool];
    }
    return {};
  });
  return { fn, calls };
}

function makeJob(overrides: Partial<HarvestJob> = {}): HarvestJob {
  return {
    id: "test-job-1",
    sourceId: "google-workspace",
    ...overrides,
  };
}

// ── Calendar Fetch ──────────────────────────────────────────

describe("fetchCalendar (via harvest)", () => {
  test("fetches calendar events with correct MCP args", async () => {
    const since = new Date("2025-01-01T00:00:00Z");
    const until = new Date("2025-01-31T23:59:59Z");
    const { fn, calls } = makeMockToolCaller({
      "mcp__google-workspace__get_events": {
        events: [
          {
            id: "evt1",
            summary: "Team standup",
            description: "Daily sync",
            start: { dateTime: "2025-01-15T09:00:00Z" },
            end: { dateTime: "2025-01-15T09:30:00Z" },
            location: "Zoom",
            attendees: [{ email: "alice@test.com", displayName: "Alice" }],
            organizer: { email: "dave@test.com", displayName: "Dave" },
            status: "confirmed",
          },
        ],
      },
    });

    const source = new GoogleWorkspaceMountainSource(fn);
    const result = await source.harvest(
      makeJob({
        since,
        until,
        filters: { recordTypes: ["calendar"] },
      }),
    );

    expect(result.items).toHaveLength(1);
    expect(result.errors).toHaveLength(0);

    // Verify MCP call args
    const calCall = calls.find((c) => c.tool === "mcp__google-workspace__get_events");
    expect(calCall).toBeDefined();
    expect(calCall!.args.time_min).toBe(since.toISOString());
    expect(calCall!.args.time_max).toBe(until.toISOString());
    expect(calCall!.args.calendar_id).toBe("primary");
    expect(calCall!.args.detailed).toBe(true);
  });

  test("maps calendar events to HarvestItems correctly", async () => {
    const { fn } = makeMockToolCaller({
      "mcp__google-workspace__get_events": {
        events: [
          {
            id: "evt-abc",
            summary: "Lunch with Wincy",
            description: "At the Thai place",
            start: { dateTime: "2025-03-10T12:00:00Z" },
            end: { dateTime: "2025-03-10T13:00:00Z" },
            location: "Thai Kitchen",
            attendees: [],
            status: "confirmed",
          },
        ],
      },
    });

    const source = new GoogleWorkspaceMountainSource(fn);
    const result = await source.harvest(
      makeJob({ filters: { recordTypes: ["calendar"] } }),
    );

    const item = result.items[0];
    expect(item.externalId).toBe("calendar:evt-abc");
    expect(item.content).toBe("Lunch with Wincy — At the Thai place");
    expect(item.sourceTimestamp).toEqual(new Date("2025-03-10T12:00:00Z"));
    expect(item.metadata?.type).toBe("calendar");
    expect(item.metadata?.location).toBe("Thai Kitchen");
    expect(item.metadata?.summary).toBe("Lunch with Wincy");
    expect(item.metadata?.description).toBe("At the Thai place");
    expect(item.metadata?.status).toBe("confirmed");
  });

  test("handles all-day events (date instead of dateTime)", async () => {
    const { fn } = makeMockToolCaller({
      "mcp__google-workspace__get_events": {
        events: [
          {
            id: "evt-allday",
            summary: "Holiday",
            start: { date: "2025-12-25" },
            end: { date: "2025-12-26" },
          },
        ],
      },
    });

    const source = new GoogleWorkspaceMountainSource(fn);
    const result = await source.harvest(
      makeJob({ filters: { recordTypes: ["calendar"] } }),
    );

    const item = result.items[0];
    expect(item.externalId).toBe("calendar:evt-allday");
    expect(item.sourceTimestamp).toEqual(new Date("2025-12-25"));
    expect(item.metadata?.start).toEqual({ date: "2025-12-25" });
  });

  test("handles events with no description", async () => {
    const { fn } = makeMockToolCaller({
      "mcp__google-workspace__get_events": {
        events: [
          {
            id: "evt-nodesc",
            summary: "Quick call",
            start: { dateTime: "2025-06-01T14:00:00Z" },
            end: { dateTime: "2025-06-01T14:15:00Z" },
          },
        ],
      },
    });

    const source = new GoogleWorkspaceMountainSource(fn);
    const result = await source.harvest(
      makeJob({ filters: { recordTypes: ["calendar"] } }),
    );

    expect(result.items[0].content).toBe("Quick call");
  });

  test("handles empty events list", async () => {
    const { fn } = makeMockToolCaller({
      "mcp__google-workspace__get_events": { events: [] },
    });

    const source = new GoogleWorkspaceMountainSource(fn);
    const result = await source.harvest(
      makeJob({ filters: { recordTypes: ["calendar"] } }),
    );

    expect(result.items).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  test("handles missing events field", async () => {
    const { fn } = makeMockToolCaller({
      "mcp__google-workspace__get_events": {},
    });

    const source = new GoogleWorkspaceMountainSource(fn);
    const result = await source.harvest(
      makeJob({ filters: { recordTypes: ["calendar"] } }),
    );

    expect(result.items).toHaveLength(0);
  });

  test("uses custom calendarId from filters", async () => {
    const { fn, calls } = makeMockToolCaller({
      "mcp__google-workspace__get_events": { events: [] },
    });

    const source = new GoogleWorkspaceMountainSource(fn);
    await source.harvest(
      makeJob({
        filters: {
          recordTypes: ["calendar"],
          calendarId: "work@group.calendar.google.com",
        },
      }),
    );

    const calCall = calls.find((c) => c.tool === "mcp__google-workspace__get_events");
    expect(calCall!.args.calendar_id).toBe("work@group.calendar.google.com");
  });

  test("records error when calendar fetch fails", async () => {
    const fn = mock(async (tool: string) => {
      if (tool === "mcp__google-workspace__get_events") {
        throw new Error("Calendar API unavailable");
      }
      return {};
    });

    const source = new GoogleWorkspaceMountainSource(fn);
    const result = await source.harvest(
      makeJob({ filters: { recordTypes: ["calendar"] } }),
    );

    expect(result.items).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("Calendar fetch failed");
    expect(result.errors[0].message).toContain("Calendar API unavailable");
    expect(result.errors[0].retryable).toBe(true);
  });
});

// ── Contacts Fetch ──────────────────────────────────────────

describe("fetchContacts (via harvest)", () => {
  test("fetches contacts with correct MCP args", async () => {
    const { fn, calls } = makeMockToolCaller({
      "mcp__google-workspace__list_contacts": {
        contacts: [
          {
            resourceName: "people/c1",
            displayName: "Alice Smith",
            emails: ["alice@test.com"],
            phones: ["+15551234567"],
            organization: "Acme Corp",
            title: "Engineer",
          },
        ],
      },
    });

    const source = new GoogleWorkspaceMountainSource(fn);
    const result = await source.harvest(
      makeJob({ filters: { recordTypes: ["contacts"] } }),
    );

    expect(result.items).toHaveLength(1);
    expect(result.errors).toHaveLength(0);

    const ctCall = calls.find((c) => c.tool === "mcp__google-workspace__list_contacts");
    expect(ctCall).toBeDefined();
    expect(ctCall!.args.user_google_email).toBe("zerocool0133700@gmail.com");
  });

  test("maps contacts to HarvestItems correctly", async () => {
    const { fn } = makeMockToolCaller({
      "mcp__google-workspace__list_contacts": {
        contacts: [
          {
            resourceName: "people/c42",
            displayName: "Bob Jones",
            emails: ["bob@example.com"],
            phones: ["+15559876543"],
            organization: "StartupCo",
            title: "CTO",
            updatedAt: "2025-02-20T10:30:00Z",
          },
        ],
      },
    });

    const source = new GoogleWorkspaceMountainSource(fn);
    const result = await source.harvest(
      makeJob({ filters: { recordTypes: ["contacts"] } }),
    );

    const item = result.items[0];
    expect(item.externalId).toBe("contacts:people/c42");
    expect(item.content).toBe("Bob Jones");
    expect(item.sourceTimestamp).toEqual(new Date("2025-02-20T10:30:00Z"));
    expect(item.metadata?.type).toBe("contacts");
    expect(item.metadata?.resourceName).toBe("people/c42");
    expect(item.metadata?.displayName).toBe("Bob Jones");
    expect(item.metadata?.emails).toEqual(["bob@example.com"]);
    expect(item.metadata?.phones).toEqual(["+15559876543"]);
    expect(item.metadata?.organization).toBe("StartupCo");
    expect(item.metadata?.title).toBe("CTO");
  });

  test("paginates contacts", async () => {
    let callCount = 0;
    const fn = mock(async (tool: string, args: Record<string, unknown>) => {
      if (tool === "mcp__google-workspace__list_contacts") {
        callCount++;
        if (!args.page_token) {
          return {
            contacts: [
              { resourceName: "people/c1", displayName: "Page1 Contact" },
            ],
            nextPageToken: "token-page2",
          };
        } else {
          return {
            contacts: [
              { resourceName: "people/c2", displayName: "Page2 Contact" },
            ],
          };
        }
      }
      return {};
    });

    const source = new GoogleWorkspaceMountainSource(fn);
    const result = await source.harvest(
      makeJob({ filters: { recordTypes: ["contacts"] }, limit: 50 }),
    );

    expect(result.items).toHaveLength(2);
    expect(result.items[0].content).toBe("Page1 Contact");
    expect(result.items[1].content).toBe("Page2 Contact");
    expect(callCount).toBe(2);
  });

  test("stops paginating when limit reached", async () => {
    let callCount = 0;
    const fn = mock(async (tool: string) => {
      if (tool === "mcp__google-workspace__list_contacts") {
        callCount++;
        const contacts = Array.from({ length: 3 }, (_, i) => ({
          resourceName: `people/c${callCount * 10 + i}`,
          displayName: `Contact ${callCount}-${i}`,
        }));
        return {
          contacts,
          nextPageToken: "more",
        };
      }
      return {};
    });

    const source = new GoogleWorkspaceMountainSource(fn);
    const result = await source.harvest(
      makeJob({ filters: { recordTypes: ["contacts"] }, limit: 3 }),
    );

    // Should stop after first page since we got 3 contacts which equals the limit
    expect(result.items.length).toBeLessThanOrEqual(3);
    expect(callCount).toBe(1);
  });

  test("handles empty contacts list", async () => {
    const { fn } = makeMockToolCaller({
      "mcp__google-workspace__list_contacts": { contacts: [] },
    });

    const source = new GoogleWorkspaceMountainSource(fn);
    const result = await source.harvest(
      makeJob({ filters: { recordTypes: ["contacts"] } }),
    );

    expect(result.items).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  test("handles contact with no resourceName", async () => {
    const { fn } = makeMockToolCaller({
      "mcp__google-workspace__list_contacts": {
        contacts: [{ displayName: "Mystery Person" }],
      },
    });

    const source = new GoogleWorkspaceMountainSource(fn);
    const result = await source.harvest(
      makeJob({ filters: { recordTypes: ["contacts"] } }),
    );

    expect(result.items[0].externalId).toBe("contacts:unknown-0");
    expect(result.items[0].content).toBe("Mystery Person");
  });

  test("handles contact with no displayName", async () => {
    const { fn } = makeMockToolCaller({
      "mcp__google-workspace__list_contacts": {
        contacts: [{ resourceName: "people/c99", emails: ["anon@test.com"] }],
      },
    });

    const source = new GoogleWorkspaceMountainSource(fn);
    const result = await source.harvest(
      makeJob({ filters: { recordTypes: ["contacts"] } }),
    );

    expect(result.items[0].content).toBe("");
    expect(result.items[0].metadata?.emails).toEqual(["anon@test.com"]);
  });

  test("records error when contacts fetch fails", async () => {
    const fn = mock(async (tool: string) => {
      if (tool === "mcp__google-workspace__list_contacts") {
        throw new Error("Contacts API down");
      }
      return {};
    });

    const source = new GoogleWorkspaceMountainSource(fn);
    const result = await source.harvest(
      makeJob({ filters: { recordTypes: ["contacts"] } }),
    );

    expect(result.items).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("Contacts fetch failed");
    expect(result.errors[0].message).toContain("Contacts API down");
    expect(result.errors[0].retryable).toBe(true);
  });

  test("uses custom email from filters", async () => {
    const { fn, calls } = makeMockToolCaller({
      "mcp__google-workspace__list_contacts": { contacts: [] },
    });

    const source = new GoogleWorkspaceMountainSource(fn);
    await source.harvest(
      makeJob({
        filters: { recordTypes: ["contacts"], email: "custom@example.com" },
      }),
    );

    const ctCall = calls.find((c) => c.tool === "mcp__google-workspace__list_contacts");
    expect(ctCall!.args.user_google_email).toBe("custom@example.com");
  });
});

// ── Record Type Routing ─────────────────────────────────────

describe("record type routing", () => {
  test("default record types include all four", async () => {
    const { fn, calls } = makeMockToolCaller({
      "mcp__google-workspace__search_gmail_messages": { messages: [] },
      "mcp__google-workspace__search_drive_files": { files: [] },
      "mcp__google-workspace__get_events": { events: [] },
      "mcp__google-workspace__list_contacts": { contacts: [] },
    });

    const source = new GoogleWorkspaceMountainSource(fn);
    await source.harvest(makeJob());

    const tools = calls.map((c) => c.tool);
    expect(tools).toContain("mcp__google-workspace__search_gmail_messages");
    expect(tools).toContain("mcp__google-workspace__search_drive_files");
    expect(tools).toContain("mcp__google-workspace__get_events");
    expect(tools).toContain("mcp__google-workspace__list_contacts");
  });

  test("only fetches requested record types", async () => {
    const { fn, calls } = makeMockToolCaller({
      "mcp__google-workspace__get_events": {
        events: [{ id: "e1", summary: "Test" }],
      },
    });

    const source = new GoogleWorkspaceMountainSource(fn);
    const result = await source.harvest(
      makeJob({ filters: { recordTypes: ["calendar"] } }),
    );

    expect(result.items).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe("mcp__google-workspace__get_events");
  });

  test("can fetch gmail + calendar only", async () => {
    const { fn, calls } = makeMockToolCaller({
      "mcp__google-workspace__search_gmail_messages": {
        messages: [{ id: "m1", snippet: "Hello" }],
      },
      "mcp__google-workspace__get_events": {
        events: [{ id: "e1", summary: "Meeting" }],
      },
    });

    const source = new GoogleWorkspaceMountainSource(fn);
    const result = await source.harvest(
      makeJob({ filters: { recordTypes: ["gmail", "calendar"] } }),
    );

    expect(result.items).toHaveLength(2);
    const tools = calls.map((c) => c.tool);
    expect(tools).not.toContain("mcp__google-workspace__search_drive_files");
    expect(tools).not.toContain("mcp__google-workspace__list_contacts");
  });

  test("errors in one type do not block others", async () => {
    const fn = mock(async (tool: string) => {
      if (tool === "mcp__google-workspace__get_events") {
        throw new Error("Calendar exploded");
      }
      if (tool === "mcp__google-workspace__list_contacts") {
        return {
          contacts: [
            { resourceName: "people/c1", displayName: "Survivor" },
          ],
        };
      }
      return {};
    });

    const source = new GoogleWorkspaceMountainSource(fn);
    const result = await source.harvest(
      makeJob({ filters: { recordTypes: ["calendar", "contacts"] } }),
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].content).toBe("Survivor");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("Calendar exploded");
  });
});

// ── Health Check ────────────────────────────────────────────

describe("healthCheck", () => {
  test("returns true on successful gmail check", async () => {
    const { fn } = makeMockToolCaller({
      "mcp__google-workspace__search_gmail_messages": { messages: [] },
    });

    const source = new GoogleWorkspaceMountainSource(fn);
    const healthy = await source.healthCheck();
    expect(healthy).toBe(true);
  });

  test("returns false on failure", async () => {
    const fn = mock(async () => {
      throw new Error("Auth failed");
    });

    const source = new GoogleWorkspaceMountainSource(fn);
    const healthy = await source.healthCheck();
    expect(healthy).toBe(false);
  });
});

// ── E2E ─────────────────────────────────────────────────────

describe("E2E harvest with all four types", () => {
  test("harvests gmail, drive, calendar, and contacts together", async () => {
    const { fn } = makeMockToolCaller({
      "mcp__google-workspace__search_gmail_messages": {
        messages: [
          { id: "m1", snippet: "Hey there", subject: "Hello", from: "alice@test.com", date: "2025-03-01T10:00:00Z" },
          { id: "m2", snippet: "Follow up", subject: "Re: Hello", from: "bob@test.com", date: "2025-03-02T11:00:00Z" },
        ],
      },
      "mcp__google-workspace__search_drive_files": {
        files: [
          { id: "d1", name: "Project Plan.docx", mimeType: "application/vnd.google-apps.document", modifiedTime: "2025-03-01T08:00:00Z" },
        ],
      },
      "mcp__google-workspace__get_events": {
        events: [
          { id: "e1", summary: "Sprint Planning", start: { dateTime: "2025-03-03T09:00:00Z" }, end: { dateTime: "2025-03-03T10:00:00Z" } },
          { id: "e2", summary: "1:1 with Dave", description: "Weekly sync", start: { dateTime: "2025-03-04T14:00:00Z" }, end: { dateTime: "2025-03-04T14:30:00Z" } },
        ],
      },
      "mcp__google-workspace__list_contacts": {
        contacts: [
          { resourceName: "people/c1", displayName: "Alice Smith", emails: ["alice@test.com"], phones: ["+15551111111"] },
          { resourceName: "people/c2", displayName: "Bob Jones", emails: ["bob@test.com"], phones: ["+15552222222"] },
          { resourceName: "people/c3", displayName: "Charlie Brown", emails: ["charlie@test.com"], phones: ["+15553333333"] },
        ],
      },
    });

    const source = new GoogleWorkspaceMountainSource(fn);
    const result = await source.harvest(makeJob({ limit: 100 }));

    expect(result.errors).toHaveLength(0);
    expect(result.items).toHaveLength(8); // 2 gmail + 1 drive + 2 calendar + 3 contacts

    // Check each type is present
    const types = result.items.map((i) => i.metadata?.type);
    expect(types.filter((t) => t === "gmail")).toHaveLength(2);
    expect(types.filter((t) => t === "drive")).toHaveLength(1);
    expect(types.filter((t) => t === "calendar")).toHaveLength(2);
    expect(types.filter((t) => t === "contacts")).toHaveLength(3);

    // Spot check IDs
    const ids = result.items.map((i) => i.externalId);
    expect(ids).toContain("gmail:m1");
    expect(ids).toContain("drive:d1");
    expect(ids).toContain("calendar:e1");
    expect(ids).toContain("contacts:people/c1");
  });
});
