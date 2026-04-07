import { describe, test, expect } from "bun:test";
import { riverFolderToScope, slugifyFolder } from "../src/river-folder-scope";

describe("slugifyFolder", () => {
  test("strips trailing slash", () => {
    expect(slugifyFolder("research/")).toBe("research");
  });

  test("converts path separators to dashes", () => {
    expect(slugifyFolder("research/quantum-computing/")).toBe("research-quantum-computing");
  });

  test("lowercases the result", () => {
    expect(slugifyFolder("Architecture/AI/")).toBe("architecture-ai");
  });

  test("handles deeply nested paths", () => {
    expect(slugifyFolder("a/b/c/d/")).toBe("a-b-c-d");
  });

  test("strips invalid characters", () => {
    expect(slugifyFolder("foo bar/baz!")).toBe("foo-bar-baz");
  });
});

describe("riverFolderToScope", () => {
  test("returns 2/river-ingest/{slug}", () => {
    expect(riverFolderToScope("research/")).toBe("2/river-ingest/research");
    expect(riverFolderToScope("research/quantum-computing/")).toBe("2/river-ingest/research-quantum-computing");
  });

  test("falls back to 'misc' for empty input", () => {
    expect(riverFolderToScope("")).toBe("2/river-ingest/misc");
    expect(riverFolderToScope("/")).toBe("2/river-ingest/misc");
  });
});
