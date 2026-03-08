/**
 * ELLIE-644 — Mountain: First wave connectors
 *
 * Tests for Web scraper, Document, API poller, RSS feed, and Manual paste
 * connectors. Uses the connector framework's runConnector for integration tests.
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  createWebScraperConnector,
  createDocumentConnector,
  createApiPollerConnector,
  createRssFeedConnector,
  createManualPasteConnector,
  runConnector, clearConnectors, clearRateLimitState,
  getConnectorLog,
} from "../../ellie-forest/src/index";
import sql from "../../ellie-forest/src/db";

const createdLogIds: string[] = [];

beforeEach(() => {
  clearConnectors();
  clearRateLimitState();
});

afterAll(async () => {
  clearConnectors();
  clearRateLimitState();
  if (createdLogIds.length > 0) {
    await sql`DELETE FROM connector_logs WHERE id = ANY(${createdLogIds})`;
  }
});

// ── 1. Web Scraper ────────────────────────────────────────────

describe("web scraper connector", () => {
  const mockHtml = `
    <html>
      <head><title>Test Page</title>
      <meta name="description" content="A test page for scraping">
      </head>
      <body>
        <h1>Hello World</h1>
        <p>This is a test paragraph with enough content to pass validation easily.</p>
        <script>var x = 1;</script>
        <style>.foo { color: red; }</style>
        <p>Second paragraph here.</p>
      </body>
    </html>
  `;

  test("fetches and extracts content from mock URLs", async () => {
    const connector = createWebScraperConnector({
      urls: ["https://example.com/test"],
      fetchFn: async () => ({ text: mockHtml, status: 200 }),
    });

    const raw = await connector.fetch({});
    expect(raw).toHaveLength(1);
    expect(raw[0].sourceId).toBe("https://example.com/test");
  });

  test("normalize strips HTML, scripts, styles", async () => {
    const connector = createWebScraperConnector({
      urls: ["https://example.com"],
      fetchFn: async () => ({ text: mockHtml, status: 200 }),
    });

    const raw = await connector.fetch({});
    const normalized = await connector.normalize(raw);
    expect(normalized[0].content).toContain("Hello World");
    expect(normalized[0].content).toContain("test paragraph");
    expect(normalized[0].content).not.toContain("<script>");
    expect(normalized[0].content).not.toContain("var x = 1");
    expect(normalized[0].content).not.toContain(".foo");
  });

  test("normalize extracts title and meta description", async () => {
    const connector = createWebScraperConnector({
      urls: ["https://example.com"],
      fetchFn: async () => ({ text: mockHtml, status: 200 }),
    });

    const raw = await connector.fetch({});
    const normalized = await connector.normalize(raw);
    expect(normalized[0].metadata.title).toBe("Test Page");
    expect(normalized[0].metadata.description).toBe("A test page for scraping");
  });

  test("validate rejects HTTP errors", async () => {
    const connector = createWebScraperConnector({
      urls: ["https://example.com/404"],
      fetchFn: async () => ({ text: "<html><body>Not found</body></html>", status: 404 }),
    });

    const raw = await connector.fetch({});
    const normalized = await connector.normalize(raw);
    const results = await connector.validate(normalized);
    expect(results[0].valid).toBe(false);
    // May have both short content and HTTP error
    const allErrors = results[0].errors!.join(', ');
    expect(allErrors).toContain("HTTP error: 404");
  });

  test("validate rejects short content", async () => {
    const connector = createWebScraperConnector({
      urls: ["https://example.com"],
      fetchFn: async () => ({ text: "<html><body>Hi</body></html>", status: 200 }),
    });

    const raw = await connector.fetch({});
    const normalized = await connector.normalize(raw);
    const results = await connector.validate(normalized);
    expect(results[0].valid).toBe(false);
    expect(results[0].errors![0]).toContain("too short");
  });

  test("full pipeline via runConnector", async () => {
    const connector = createWebScraperConnector({
      urls: ["https://example.com/page1", "https://example.com/page2"],
      fetchFn: async (url) => ({ text: mockHtml.replace("Test Page", url), status: 200 }),
    });

    const stats = await runConnector(connector);
    createdLogIds.push(stats.logId);
    expect(stats.itemsFetched).toBe(2);
    expect(stats.itemsNormalized).toBe(2);
    expect(stats.itemsValidated).toBe(2);
    expect(stats.errors).toEqual([]);
  });

  test("respects maxContentLength", async () => {
    const connector = createWebScraperConnector({
      urls: ["https://example.com"],
      fetchFn: async () => ({ text: "<html><body>" + "x".repeat(100) + "</body></html>", status: 200 }),
      maxContentLength: 50,
    });

    const raw = await connector.fetch({});
    const normalized = await connector.normalize(raw);
    expect(normalized[0].content.length).toBeLessThanOrEqual(50);
  });
});

// ── 2. Document Connector ─────────────────────────────────────

describe("document connector", () => {
  test("ingests markdown with title extraction", async () => {
    const connector = createDocumentConnector({
      documents: [{
        name: "notes.md",
        content: "# My Notes\n\nSome content here.\n\n## Section 2\n\nMore content.",
        mimeType: "text/markdown",
      }],
    });

    const raw = await connector.fetch({});
    const normalized = await connector.normalize(raw);
    expect(normalized.length).toBeGreaterThanOrEqual(1);
    expect(normalized[0].metadata.title).toBe("My Notes");
    expect(normalized[0].metadata.source).toBe("document");
  });

  test("chunks large markdown by headings", async () => {
    const sections = Array.from({ length: 5 }, (_, i) =>
      `## Section ${i}\n\n${"Lorem ipsum dolor sit amet. ".repeat(50)}`
    ).join("\n\n");
    const content = `# Big Document\n\n${sections}`;

    const connector = createDocumentConnector({
      documents: [{ name: "big.md", content, mimeType: "text/markdown" }],
      chunkSize: 500,
    });

    const raw = await connector.fetch({});
    const normalized = await connector.normalize(raw);
    expect(normalized.length).toBeGreaterThan(1);
    // Each chunk should have metadata about position
    expect(normalized[0].metadata.chunkIndex).toBe(0);
    expect(normalized[0].metadata.totalChunks).toBe(normalized.length);
  });

  test("ingests plain text", async () => {
    const connector = createDocumentConnector({
      documents: [{
        name: "readme.txt",
        content: "This is a plain text document with enough words to be valid.",
        mimeType: "text/plain",
      }],
    });

    const raw = await connector.fetch({});
    const normalized = await connector.normalize(raw);
    expect(normalized).toHaveLength(1);
    expect(normalized[0].content).toContain("plain text document");
  });

  test("handles PDF mime type (text extraction)", async () => {
    const connector = createDocumentConnector({
      documents: [{
        name: "report.pdf",
        content: "This is extracted PDF text content for testing purposes.",
        mimeType: "application/pdf",
      }],
    });

    const raw = await connector.fetch({});
    const normalized = await connector.normalize(raw);
    expect(normalized).toHaveLength(1);
    expect(normalized[0].metadata.title).toBe("report");
    expect(normalized[0].metadata.mimeType).toBe("application/pdf");
  });

  test("validate rejects empty documents", async () => {
    const connector = createDocumentConnector({
      documents: [{ name: "empty.md", content: "", mimeType: "text/markdown" }],
    });

    const raw = await connector.fetch({});
    const normalized = await connector.normalize(raw);
    const results = await connector.validate(normalized);
    expect(results[0].valid).toBe(false);
  });

  test("full pipeline via runConnector", async () => {
    const connector = createDocumentConnector({
      documents: [
        { name: "a.md", content: "# Doc A\n\nContent for doc A.", mimeType: "text/markdown" },
        { name: "b.txt", content: "Plain text document B with content.", mimeType: "text/plain" },
      ],
    });

    const stats = await runConnector(connector);
    createdLogIds.push(stats.logId);
    expect(stats.itemsFetched).toBe(2);
    expect(stats.itemsValidated).toBe(2);
    expect(stats.errors).toEqual([]);
  });

  test("multiple documents produce separate records", async () => {
    const connector = createDocumentConnector({
      documents: [
        { name: "x.md", content: "# X\n\nContent X", mimeType: "text/markdown" },
        { name: "y.md", content: "# Y\n\nContent Y", mimeType: "text/markdown" },
        { name: "z.txt", content: "Content Z", mimeType: "text/plain" },
      ],
    });

    const raw = await connector.fetch({});
    expect(raw).toHaveLength(3);
    const normalized = await connector.normalize(raw);
    expect(normalized).toHaveLength(3);
  });
});

// ── 3. REST API Poller ────────────────────────────────────────

describe("api poller connector", () => {
  const mockApiResponse = {
    data: {
      items: [
        { id: "item-1", title: "First Article", body: "Content of first article." },
        { id: "item-2", title: "Second Article", body: "Content of second article." },
      ],
    },
  };

  test("fetches and maps JSON via field mapping", async () => {
    const connector = createApiPollerConnector({
      url: "https://api.example.com/articles",
      itemsPath: "data.items",
      fieldMapping: { content: "body", sourceId: "id", title: "title" },
      fetchFn: async () => mockApiResponse,
    });

    const raw = await connector.fetch({});
    expect(raw).toHaveLength(2);
    expect(raw[0].sourceId).toBe("item-1");
  });

  test("normalize applies field mapping", async () => {
    const connector = createApiPollerConnector({
      url: "https://api.example.com/articles",
      itemsPath: "data.items",
      fieldMapping: { content: "body", sourceId: "id", title: "title" },
      fetchFn: async () => mockApiResponse,
    });

    const raw = await connector.fetch({});
    const normalized = await connector.normalize(raw);
    expect(normalized[0].content).toContain("First Article");
    expect(normalized[0].content).toContain("Content of first article");
    expect(normalized[0].metadata.source).toBe("api-poller");
  });

  test("handles flat array response (no itemsPath)", async () => {
    const connector = createApiPollerConnector({
      url: "https://api.example.com/list",
      fieldMapping: { content: "text", sourceId: "id" },
      fetchFn: async () => [
        { id: "a", text: "Alpha content here" },
        { id: "b", text: "Beta content here" },
      ],
    });

    const raw = await connector.fetch({});
    expect(raw).toHaveLength(2);
  });

  test("handles nested field paths", async () => {
    const connector = createApiPollerConnector({
      url: "https://api.example.com/deep",
      itemsPath: "response.results",
      fieldMapping: { content: "data.body", sourceId: "data.uuid" },
      fetchFn: async () => ({
        response: {
          results: [{ data: { uuid: "deep-1", body: "Deep nested content value" } }],
        },
      }),
    });

    const raw = await connector.fetch({});
    expect(raw[0].sourceId).toBe("deep-1");
    const normalized = await connector.normalize(raw);
    expect(normalized[0].content).toBe("Deep nested content value");
  });

  test("validate rejects empty content", async () => {
    const connector = createApiPollerConnector({
      url: "https://api.example.com",
      fieldMapping: { content: "missing_field", sourceId: "id" },
      fetchFn: async () => [{ id: "x", other: "data" }],
    });

    const raw = await connector.fetch({});
    const normalized = await connector.normalize(raw);
    const results = await connector.validate(normalized);
    expect(results[0].valid).toBe(false);
  });

  test("full pipeline via runConnector", async () => {
    const connector = createApiPollerConnector({
      url: "https://api.example.com/articles",
      itemsPath: "data.items",
      fieldMapping: { content: "body", sourceId: "id", title: "title" },
      fetchFn: async () => mockApiResponse,
    });

    const stats = await runConnector(connector);
    createdLogIds.push(stats.logId);
    expect(stats.itemsFetched).toBe(2);
    expect(stats.itemsValidated).toBe(2);
    expect(stats.errors).toEqual([]);
  });

  test("passes credentials as authorization header", async () => {
    let receivedHeaders: Record<string, string> = {};
    const connector = createApiPollerConnector({
      url: "https://api.example.com/secure",
      fieldMapping: { content: "text", sourceId: "id" },
      fetchFn: async (_url, init) => {
        receivedHeaders = (init.headers ?? {}) as Record<string, string>;
        return [{ id: "s1", text: "Secure content here" }];
      },
    });

    const stats = await runConnector(connector, { authorization: "Bearer tok123" });
    createdLogIds.push(stats.logId);
    expect(receivedHeaders.authorization).toBe("Bearer tok123");
  });
});

// ── 4. RSS/Atom Feed ──────────────────────────────────────────

describe("rss feed connector", () => {
  const mockRssFeed = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0">
      <channel>
        <title>Test Feed</title>
        <item>
          <guid>guid-001</guid>
          <title>First Post</title>
          <description>This is the first post with enough content to be valid.</description>
          <link>https://blog.example.com/first</link>
          <pubDate>Sat, 08 Mar 2026 10:00:00 GMT</pubDate>
        </item>
        <item>
          <guid>guid-002</guid>
          <title>Second Post</title>
          <description><![CDATA[<p>HTML content in <strong>CDATA</strong> section with sufficient length.</p>]]></description>
          <link>https://blog.example.com/second</link>
          <pubDate>Sat, 08 Mar 2026 12:00:00 GMT</pubDate>
        </item>
      </channel>
    </rss>`;

  const mockAtomFeed = `<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <title>Atom Test</title>
      <entry>
        <id>atom-001</id>
        <title>Atom Entry One</title>
        <content>Content of atom entry one with enough text to pass validation.</content>
        <link href="https://atom.example.com/1"/>
        <published>2026-03-08T10:00:00Z</published>
      </entry>
    </feed>`;

  test("parses RSS feed items", async () => {
    const connector = createRssFeedConnector({
      url: "https://blog.example.com/feed",
      fetchFn: async () => mockRssFeed,
    });

    const raw = await connector.fetch({});
    expect(raw).toHaveLength(2);
    expect(raw[0].sourceId).toBe("guid-001");
    expect(raw[1].sourceId).toBe("guid-002");
  });

  test("parses Atom feed entries", async () => {
    const connector = createRssFeedConnector({
      url: "https://atom.example.com/feed",
      fetchFn: async () => mockAtomFeed,
    });

    const raw = await connector.fetch({});
    expect(raw).toHaveLength(1);
    expect(raw[0].sourceId).toBe("atom-001");
  });

  test("normalize strips HTML from CDATA content", async () => {
    const connector = createRssFeedConnector({
      url: "https://blog.example.com/feed",
      fetchFn: async () => mockRssFeed,
    });

    const raw = await connector.fetch({});
    const normalized = await connector.normalize(raw);
    expect(normalized[1].content).toContain("CDATA");
    expect(normalized[1].content).not.toContain("<strong>");
    expect(normalized[1].metadata.guid).toBe("guid-002");
  });

  test("deduplicates by GUID across fetches", async () => {
    const knownGuids = new Set<string>();
    const connector = createRssFeedConnector({
      url: "https://blog.example.com/feed",
      fetchFn: async () => mockRssFeed,
      knownGuids,
    });

    const raw1 = await connector.fetch({});
    expect(raw1).toHaveLength(2);

    // Second fetch should return 0 (same GUIDs)
    const raw2 = await connector.fetch({});
    expect(raw2).toHaveLength(0);
  });

  test("respects maxItems", async () => {
    const connector = createRssFeedConnector({
      url: "https://blog.example.com/feed",
      fetchFn: async () => mockRssFeed,
      maxItems: 1,
    });

    const raw = await connector.fetch({});
    expect(raw).toHaveLength(1);
  });

  test("full pipeline via runConnector", async () => {
    const connector = createRssFeedConnector({
      url: "https://blog.example.com/feed",
      fetchFn: async () => mockRssFeed,
    });

    const stats = await runConnector(connector);
    createdLogIds.push(stats.logId);
    expect(stats.itemsFetched).toBe(2);
    expect(stats.itemsValidated).toBe(2);
    expect(stats.errors).toEqual([]);
  });

  test("normalize includes feed metadata", async () => {
    const connector = createRssFeedConnector({
      url: "https://blog.example.com/feed",
      fetchFn: async () => mockRssFeed,
    });

    const raw = await connector.fetch({});
    const normalized = await connector.normalize(raw);
    expect(normalized[0].metadata.feedUrl).toBe("https://blog.example.com/feed");
    expect(normalized[0].metadata.link).toBe("https://blog.example.com/first");
    expect(normalized[0].metadata.title).toBe("First Post");
  });
});

// ── 5. Manual Paste ───────────────────────────────────────────

describe("manual paste connector", () => {
  test("creates records from pasted entries", async () => {
    const connector = createManualPasteConnector({
      entries: [
        { content: "Some knowledge I want to remember about forests.", title: "Forest Fact" },
        { content: "Another piece of info about trees and branches." },
      ],
      author: "dave",
    });

    const raw = await connector.fetch({});
    expect(raw).toHaveLength(2);
  });

  test("normalize includes title and author", async () => {
    const connector = createManualPasteConnector({
      entries: [{ content: "Test content here.", title: "My Note", type: "decision" }],
      author: "dave",
    });

    const raw = await connector.fetch({});
    const normalized = await connector.normalize(raw);
    expect(normalized[0].content).toContain("My Note");
    expect(normalized[0].content).toContain("Test content here");
    expect(normalized[0].type).toBe("decision");
    expect(normalized[0].metadata.author).toBe("dave");
  });

  test("defaults type to fact", async () => {
    const connector = createManualPasteConnector({
      entries: [{ content: "Simple fact without type." }],
    });

    const raw = await connector.fetch({});
    const normalized = await connector.normalize(raw);
    expect(normalized[0].type).toBe("fact");
  });

  test("validate rejects empty paste", async () => {
    const connector = createManualPasteConnector({
      entries: [{ content: "" }],
    });

    const raw = await connector.fetch({});
    const normalized = await connector.normalize(raw);
    const results = await connector.validate(normalized);
    expect(results[0].valid).toBe(false);
    expect(results[0].errors![0]).toContain("Empty paste");
  });

  test("full pipeline via runConnector", async () => {
    const connector = createManualPasteConnector({
      entries: [
        { content: "Note about project architecture decisions.", title: "Architecture" },
        { content: "Preference: always use Bun for TypeScript projects.", type: "preference" },
      ],
      author: "dave",
    });

    const stats = await runConnector(connector);
    createdLogIds.push(stats.logId);
    expect(stats.itemsFetched).toBe(2);
    expect(stats.itemsValidated).toBe(2);
    expect(stats.errors).toEqual([]);
  });

  test("includes tags in metadata", async () => {
    const connector = createManualPasteConnector({
      entries: [{ content: "Tagged content here.", tags: ["forest", "memory"] }],
    });

    const raw = await connector.fetch({});
    const normalized = await connector.normalize(raw);
    expect(normalized[0].metadata.tags).toEqual(["forest", "memory"]);
  });
});
