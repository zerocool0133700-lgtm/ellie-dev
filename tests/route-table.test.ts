/**
 * ELLIE-559 — route-table.ts tests
 *
 * Tests path matching, JSON parsing, query extraction, and route matching.
 */

import { describe, test, expect } from "bun:test";
import {
  matchPath,
  matchRoute,
  parseJson,
  extractQuery,
  type Route,
} from "../src/route-table.ts";

// ── matchPath — exact ───────────────────────────────────────

describe("matchPath — exact", () => {
  test("exact match returns empty params", () => {
    expect(matchPath("/health", "/health")).toEqual({});
  });

  test("exact mismatch returns null", () => {
    expect(matchPath("/health", "/status")).toBeNull();
  });

  test("trailing slash mismatch returns null", () => {
    expect(matchPath("/health", "/health/")).toBeNull();
  });
});

// ── matchPath — wildcard ────────────────────────────────────

describe("matchPath — wildcard", () => {
  test("prefix/* matches prefix exactly", () => {
    const result = matchPath("/forest/*", "/forest");
    expect(result).toEqual({ "*": "" });
  });

  test("prefix/* matches prefix/sub", () => {
    const result = matchPath("/forest/*", "/forest/trees");
    expect(result).toEqual({ "*": "trees" });
  });

  test("prefix/* matches deeply nested", () => {
    const result = matchPath("/api/*", "/api/v1/users/123");
    expect(result).toEqual({ "*": "v1/users/123" });
  });

  test("wildcard mismatch returns null", () => {
    expect(matchPath("/api/*", "/other/path")).toBeNull();
  });
});

// ── matchPath — parameterized ───────────────────────────────

describe("matchPath — parameterized", () => {
  test("single param extracted", () => {
    const result = matchPath("/api/jobs/:id", "/api/jobs/123");
    expect(result).toEqual({ id: "123" });
  });

  test("multiple params extracted", () => {
    const result = matchPath("/api/:resource/:id", "/api/users/42");
    expect(result).toEqual({ resource: "users", id: "42" });
  });

  test("param with suffix segments", () => {
    const result = matchPath("/api/jobs/:id/logs", "/api/jobs/456/logs");
    expect(result).toEqual({ id: "456" });
  });

  test("wrong segment count returns null", () => {
    expect(matchPath("/api/jobs/:id", "/api/jobs/123/extra")).toBeNull();
  });

  test("non-matching static segment returns null", () => {
    expect(matchPath("/api/jobs/:id", "/api/users/123")).toBeNull();
  });

  test("URL-encoded params decoded", () => {
    const result = matchPath("/api/:name", "/api/hello%20world");
    expect(result).toEqual({ name: "hello world" });
  });
});

// ── matchRoute ──────────────────────────────────────────────

describe("matchRoute", () => {
  const routes: Route[] = [
    { method: "GET", path: "/health", handler: async () => {} },
    { method: "POST", path: "/api/jobs", handler: async () => {} },
    { method: "GET", path: "/api/jobs/:id", handler: async () => {} },
    { method: "ANY", path: "/api/bridge/*", handler: async () => {} },
  ];

  test("matches exact route with correct method", () => {
    const result = matchRoute("GET", "/health", routes);
    expect(result).not.toBeNull();
    expect(result!.params).toEqual({});
  });

  test("returns null for wrong method", () => {
    expect(matchRoute("POST", "/health", routes)).toBeNull();
  });

  test("matches param route", () => {
    const result = matchRoute("GET", "/api/jobs/42", routes);
    expect(result).not.toBeNull();
    expect(result!.params).toEqual({ id: "42" });
  });

  test("matches ANY method", () => {
    const result = matchRoute("DELETE", "/api/bridge/write", routes);
    expect(result).not.toBeNull();
    expect(result!.params).toEqual({ "*": "write" });
  });

  test("returns null for unmatched path", () => {
    expect(matchRoute("GET", "/nope", routes)).toBeNull();
  });

  test("first match wins", () => {
    const result = matchRoute("POST", "/api/jobs", routes);
    expect(result).not.toBeNull();
    expect(result!.route.method).toBe("POST");
  });
});

// ── parseJson ───────────────────────────────────────────────

describe("parseJson", () => {
  test("parses valid JSON", () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
  });

  test("returns {} for empty string", () => {
    expect(parseJson("")).toEqual({});
  });

  test("returns {} for whitespace", () => {
    expect(parseJson("  \n  ")).toEqual({});
  });

  test("throws on invalid JSON", () => {
    expect(() => parseJson("{bad}")).toThrow();
  });
});

// ── extractQuery ────────────────────────────────────────────

describe("extractQuery", () => {
  test("extracts query params", () => {
    const url = new URL("http://localhost/api?foo=bar&baz=42");
    expect(extractQuery(url)).toEqual({ foo: "bar", baz: "42" });
  });

  test("returns empty object for no params", () => {
    const url = new URL("http://localhost/api");
    expect(extractQuery(url)).toEqual({});
  });

  test("handles duplicate keys (last wins)", () => {
    const url = new URL("http://localhost/api?a=1&a=2");
    expect(extractQuery(url)).toEqual({ a: "2" });
  });
});
