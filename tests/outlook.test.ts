/**
 * ELLIE-86 — Unit tests for Microsoft Outlook module
 *
 * Covers: token refresh, caching, listUnread, searchMessages,
 * getMessage, sendEmail, replyToMessage, markAsRead, error handling.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  isOutlookConfigured,
  getOutlookEmail,
  initOutlook,
  listUnread,
  getUnreadCount,
  searchMessages,
  getMessage,
  sendEmail,
  replyToMessage,
  markAsRead,
  _resetTokenCache,
} from "../src/outlook.ts";

// ── Env setup ───────────────────────────────────────────────────

const MOCK_CLIENT_ID = "test-client-id";
const MOCK_CLIENT_SECRET = "test-client-secret";
const MOCK_REFRESH_TOKEN = "test-refresh-token";
const MOCK_USER_EMAIL = "dave@outlook.com";

// ── Fetch mock ──────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; options?: RequestInit }> = [];

function mockFetchResponses(...responses: Array<{ status: number; body: any; ok?: boolean }>) {
  const queue = [...responses];
  fetchCalls = [];
  const fn = (url: string | URL | Request, options?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    fetchCalls.push({ url: urlStr, options });
    const resp = queue.shift();
    if (!resp) throw new Error(`Unexpected fetch call: ${urlStr}`);
    return Promise.resolve({
      ok: resp.ok ?? resp.status < 400,
      status: resp.status,
      json: () => Promise.resolve(resp.body),
      text: () => Promise.resolve(typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body)),
    } as Response);
  };
  globalThis.fetch = fn as any;
}

beforeEach(() => {
  // Set env vars before each test (lazy reads in module)
  process.env.MICROSOFT_CLIENT_ID = MOCK_CLIENT_ID;
  process.env.MICROSOFT_CLIENT_SECRET = MOCK_CLIENT_SECRET;
  process.env.MICROSOFT_REFRESH_TOKEN = MOCK_REFRESH_TOKEN;
  process.env.MICROSOFT_USER_EMAIL = MOCK_USER_EMAIL;
  // Reset cached token so each test starts fresh
  _resetTokenCache();
  fetchCalls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── Tests ───────────────────────────────────────────────────────

describe("outlook config", () => {
  test("isOutlookConfigured returns true when env vars set", () => {
    expect(isOutlookConfigured()).toBe(true);
  });

  test("isOutlookConfigured returns false when env vars missing", () => {
    delete process.env.MICROSOFT_CLIENT_ID;
    expect(isOutlookConfigured()).toBe(false);
  });

  test("getOutlookEmail returns configured email", () => {
    expect(getOutlookEmail()).toBe(MOCK_USER_EMAIL);
  });
});

describe("initOutlook", () => {
  test("returns true on successful token refresh", async () => {
    mockFetchResponses({
      status: 200,
      body: { access_token: "test-access-token", expires_in: 3600 },
    });
    const result = await initOutlook();
    expect(result).toBe(true);
  });

  test("returns false on token refresh failure", async () => {
    mockFetchResponses({
      status: 400,
      body: { error: "invalid_grant" },
      ok: false,
    });
    const result = await initOutlook();
    expect(result).toBe(false);
  });

  test("returns false when not configured", async () => {
    delete process.env.MICROSOFT_CLIENT_ID;
    const result = await initOutlook();
    expect(result).toBe(false);
  });
});

describe("listUnread", () => {
  test("returns unread messages from inbox", async () => {
    const mockMessages = [
      {
        id: "msg-1",
        subject: "Test email",
        from: { emailAddress: { name: "Sender", address: "sender@test.com" } },
        receivedDateTime: "2026-02-19T10:00:00Z",
        bodyPreview: "Hello world",
        isRead: false,
      },
    ];

    mockFetchResponses(
      { status: 200, body: { access_token: "tok", expires_in: 3600 } },
      { status: 200, body: { value: mockMessages } },
    );

    const result = await listUnread(5);
    expect(result).toHaveLength(1);
    expect(result[0].subject).toBe("Test email");
    expect(result[0].from.emailAddress.address).toBe("sender@test.com");
  });

  test("returns empty array when no messages", async () => {
    mockFetchResponses(
      { status: 200, body: { access_token: "tok", expires_in: 3600 } },
      { status: 200, body: { value: [] } },
    );

    const result = await listUnread();
    expect(result).toEqual([]);
  });
});

describe("getUnreadCount", () => {
  test("returns unread count from inbox folder", async () => {
    mockFetchResponses(
      { status: 200, body: { access_token: "tok", expires_in: 3600 } },
      { status: 200, body: { unreadItemCount: 42 } },
    );

    const count = await getUnreadCount();
    expect(count).toBe(42);
  });
});

describe("searchMessages", () => {
  test("passes search query to Graph API", async () => {
    mockFetchResponses(
      { status: 200, body: { access_token: "tok", expires_in: 3600 } },
      { status: 200, body: { value: [{ id: "msg-1", subject: "Found it" }] } },
    );

    const result = await searchMessages("invoice", 5);
    expect(result).toHaveLength(1);
    expect(result[0].subject).toBe("Found it");

    // Verify the search query was included in the URL (2nd call = Graph API)
    // $search gets URL-encoded as %24search by URLSearchParams
    const graphUrl = fetchCalls[1].url;
    expect(graphUrl).toContain("search");
    expect(graphUrl).toContain("invoice");
  });
});

describe("getMessage", () => {
  test("fetches single message by ID", async () => {
    const mockMessage = {
      id: "msg-123",
      subject: "Full message",
      body: { contentType: "Text", content: "Full body content" },
    };

    mockFetchResponses(
      { status: 200, body: { access_token: "tok", expires_in: 3600 } },
      { status: 200, body: mockMessage },
    );

    const result = await getMessage("msg-123");
    expect(result.id).toBe("msg-123");
    expect(result.body?.content).toBe("Full body content");
  });

  test("encodes message ID in URL", async () => {
    mockFetchResponses(
      { status: 200, body: { access_token: "tok", expires_in: 3600 } },
      { status: 200, body: { id: "msg+special/chars" } },
    );

    await getMessage("msg+special/chars");
    expect(fetchCalls[1].url).toContain(encodeURIComponent("msg+special/chars"));
  });
});

describe("sendEmail", () => {
  test("sends email with correct payload structure", async () => {
    mockFetchResponses(
      { status: 200, body: { access_token: "tok", expires_in: 3600 } },
      { status: 204, body: null },
    );

    await sendEmail({
      subject: "Test Subject",
      body: "Test body",
      to: ["recipient@test.com"],
      cc: ["cc@test.com"],
    });

    const graphCall = fetchCalls[1];
    expect(graphCall.url).toContain("/sendMail");
    expect(graphCall.options?.method).toBe("POST");

    const sentBody = JSON.parse(graphCall.options?.body as string);
    expect(sentBody.message.subject).toBe("Test Subject");
    expect(sentBody.message.toRecipients[0].emailAddress.address).toBe("recipient@test.com");
    expect(sentBody.message.ccRecipients[0].emailAddress.address).toBe("cc@test.com");
    expect(sentBody.saveToSentItems).toBe(true);
  });

  test("omits ccRecipients when cc is empty", async () => {
    mockFetchResponses(
      { status: 200, body: { access_token: "tok", expires_in: 3600 } },
      { status: 204, body: null },
    );

    await sendEmail({
      subject: "No CC",
      body: "Body",
      to: ["recipient@test.com"],
    });

    const graphCall = fetchCalls[1];
    const sentBody = JSON.parse(graphCall.options?.body as string);
    expect(sentBody.message.ccRecipients).toBeUndefined();
  });
});

describe("replyToMessage", () => {
  test("sends reply with comment", async () => {
    mockFetchResponses(
      { status: 200, body: { access_token: "tok", expires_in: 3600 } },
      { status: 204, body: null },
    );

    await replyToMessage("msg-123", "Thanks for the email!");

    const graphCall = fetchCalls[1];
    expect(graphCall.url).toContain("/messages/msg-123/reply");
    expect(graphCall.options?.method).toBe("POST");
    const sentBody = JSON.parse(graphCall.options?.body as string);
    expect(sentBody.comment).toBe("Thanks for the email!");
  });
});

describe("markAsRead", () => {
  test("patches message with isRead true", async () => {
    mockFetchResponses(
      { status: 200, body: { access_token: "tok", expires_in: 3600 } },
      { status: 200, body: { id: "msg-123", isRead: true } },
    );

    await markAsRead("msg-123");

    const graphCall = fetchCalls[1];
    expect(graphCall.options?.method).toBe("PATCH");
    const sentBody = JSON.parse(graphCall.options?.body as string);
    expect(sentBody.isRead).toBe(true);
  });
});

describe("error handling", () => {
  test("throws on Graph API error", async () => {
    mockFetchResponses(
      { status: 200, body: { access_token: "tok", expires_in: 3600 } },
      { status: 401, body: { error: { message: "Unauthorized" } }, ok: false },
    );

    await expect(listUnread()).rejects.toThrow("Graph API error (401)");
  });

  test("throws when auth fails mid-request", async () => {
    // Token refresh fails — getAccessToken returns null — graphFetch throws
    mockFetchResponses({
      status: 400,
      body: { error: "invalid_grant" },
      ok: false,
    });

    await expect(listUnread()).rejects.toThrow("not authenticated");
  });
});

describe("token caching", () => {
  test("reuses cached token for second call", async () => {
    mockFetchResponses(
      // First call: token refresh + graph
      { status: 200, body: { access_token: "cached-tok", expires_in: 3600 } },
      { status: 200, body: { value: [] } },
      // Second call: only graph (token cached)
      { status: 200, body: { unreadItemCount: 5 } },
    );

    await listUnread();
    const count = await getUnreadCount();
    expect(count).toBe(5);
    // 3 total calls: 1 token + 2 graph (no second token refresh)
    expect(fetchCalls).toHaveLength(3);
  });
});
