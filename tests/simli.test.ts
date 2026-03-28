import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";

// Set env var before the module is imported (module caches top-level consts)
process.env.SIMLI_API_KEY = "test-api-key";

// Mock fetch before importing
const mockFetch = mock(() => Promise.resolve(new Response(
  JSON.stringify({ session_token: "test-token-123" }),
  { status: 200, headers: { "Content-Type": "application/json" } }
)));

// Store original and override
const originalFetch = globalThis.fetch;
globalThis.fetch = mockFetch as any;

describe("simli", () => {
  beforeEach(() => {
    mockFetch.mockClear();
    globalThis.fetch = mockFetch as any;
  });

  it("should export getSimliSessionToken", async () => {
    const { getSimliSessionToken } = await import("../src/simli.ts");
    expect(typeof getSimliSessionToken).toBe("function");
  });

  it("getSimliSessionToken calls Simli API with correct params", async () => {
    const { getSimliSessionToken } = await import("../src/simli.ts");

    const result = await getSimliSessionToken("test-face-id");

    expect(result).toBe("test-token-123");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.simli.ai/compose/token");
    expect(options.method).toBe("POST");

    const body = JSON.parse(options.body as string);
    expect(body.faceId).toBe("test-face-id");
    expect(body.handleSilence).toBe(true);
  });

  it("getSimliSessionToken returns null on API failure", async () => {
    mockFetch.mockImplementationOnce(() => Promise.resolve(
      new Response("Internal Server Error", { status: 500 })
    ));

    const { getSimliSessionToken } = await import("../src/simli.ts");
    const result = await getSimliSessionToken("test-face-id");
    expect(result).toBeNull();
  });

  // Restore fetch after all tests
  afterAll(() => {
    globalThis.fetch = originalFetch;
  });
});
