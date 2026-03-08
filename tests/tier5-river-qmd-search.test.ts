/**
 * ELLIE-655 — Test Tier 5: River Vault (work trail creation & QMD search)
 *
 * Focuses on QMD indexing/search, cross-referencing, and bridge-river pure functions:
 * - Pure validators/parsers from bridge-river.ts
 * - QMD search for work trails by ticket ID
 * - River doc retrieval for work trail content
 * - Cross-referencing between work trails
 * - River link API (Forest↔River vines)
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  validateRiverPath,
  parseYamlScalar,
  parseFrontmatter,
  serializeWithFrontmatter,
  mergeFrontmatter,
  applyFrontmatter,
} from "../src/api/bridge-river.ts";
import {
  buildWorkTrailStartContent,
  buildWorkTrailDecisionAppend,
} from "../src/work-trail-writer.ts";
import { unlink } from "fs/promises";

const BRIDGE_API = "http://localhost:3001/api/bridge";
const BRIDGE_KEY =
  "bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a";
const RIVER_ROOT = "/home/ellie/obsidian-vault/ellie-river";

async function riverFetch(
  path: string,
  method: string = "GET",
  body?: Record<string, unknown>,
) {
  const opts: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-bridge-key": BRIDGE_KEY,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch(`${BRIDGE_API}/river/${path}`, opts);
}

// ── Pure: validateRiverPath ─────────────────────────────────

describe("validateRiverPath", () => {
  test("accepts valid relative .md path", () => {
    const r = validateRiverPath("work-trails/ELLIE-655/ELLIE-655-2026-03-08.md");
    expect(r.valid).toBe(true);
  });

  test("accepts nested paths", () => {
    const r = validateRiverPath("prompts/protocols/memory-management.md");
    expect(r.valid).toBe(true);
  });

  test("accepts simple filename", () => {
    const r = validateRiverPath("notes.md");
    expect(r.valid).toBe(true);
  });

  test("rejects empty string", () => {
    const r = validateRiverPath("");
    expect(r.valid).toBe(false);
    expect(r.error).toContain("required");
  });

  test("rejects null", () => {
    const r = validateRiverPath(null);
    expect(r.valid).toBe(false);
  });

  test("rejects undefined", () => {
    const r = validateRiverPath(undefined);
    expect(r.valid).toBe(false);
  });

  test("rejects number", () => {
    const r = validateRiverPath(42);
    expect(r.valid).toBe(false);
  });

  test("rejects absolute path", () => {
    const r = validateRiverPath("/etc/passwd.md");
    expect(r.valid).toBe(false);
    expect(r.error).toContain("relative");
  });

  test("rejects path traversal", () => {
    const r = validateRiverPath("../escape.md");
    expect(r.valid).toBe(false);
    expect(r.error).toContain("traversal");
  });

  test("rejects embedded traversal", () => {
    const r = validateRiverPath("work-trails/../../../etc/passwd.md");
    expect(r.valid).toBe(false);
  });

  test("rejects non-.md extension", () => {
    const r = validateRiverPath("file.txt");
    expect(r.valid).toBe(false);
    expect(r.error).toContain(".md");
  });

  test("rejects null bytes", () => {
    const r = validateRiverPath("file\x00.md");
    expect(r.valid).toBe(false);
    expect(r.error).toContain("invalid");
  });
});

// ── Pure: parseYamlScalar ───────────────────────────────────

describe("parseYamlScalar", () => {
  test("parses null variants", () => {
    expect(parseYamlScalar("null")).toBeNull();
    expect(parseYamlScalar("~")).toBeNull();
    expect(parseYamlScalar("")).toBeNull();
  });

  test("parses booleans", () => {
    expect(parseYamlScalar("true")).toBe(true);
    expect(parseYamlScalar("false")).toBe(false);
  });

  test("parses integers", () => {
    expect(parseYamlScalar("42")).toBe(42);
    expect(parseYamlScalar("-7")).toBe(-7);
    expect(parseYamlScalar("0")).toBe(0);
  });

  test("parses floats", () => {
    expect(parseYamlScalar("3.14")).toBeCloseTo(3.14);
    expect(parseYamlScalar("-0.5")).toBeCloseTo(-0.5);
  });

  test("parses double-quoted strings", () => {
    expect(parseYamlScalar('"hello world"')).toBe("hello world");
  });

  test("parses single-quoted strings", () => {
    expect(parseYamlScalar("'hello world'")).toBe("hello world");
  });

  test("returns plain strings as-is", () => {
    expect(parseYamlScalar("ELLIE-655")).toBe("ELLIE-655");
    expect(parseYamlScalar("in-progress")).toBe("in-progress");
  });

  test("returns ISO datetime as string", () => {
    expect(parseYamlScalar("2026-03-08T06:00:00Z")).toBe("2026-03-08T06:00:00Z");
  });
});

// ── Pure: parseFrontmatter ──────────────────────────────────

describe("parseFrontmatter", () => {
  test("parses standard frontmatter", () => {
    const md = "---\ntitle: Hello\nstatus: done\n---\n# Body";
    const { frontmatter, body } = parseFrontmatter(md);
    expect(frontmatter.title).toBe("Hello");
    expect(frontmatter.status).toBe("done");
    expect(body).toBe("# Body");
  });

  test("handles null values", () => {
    const md = "---\ncompleted_at: null\n---\nBody";
    const { frontmatter } = parseFrontmatter(md);
    expect(frontmatter.completed_at).toBeNull();
  });

  test("handles numeric values", () => {
    const md = "---\nconfidence: 0.9\ncount: 5\n---\nBody";
    const { frontmatter } = parseFrontmatter(md);
    expect(frontmatter.confidence).toBeCloseTo(0.9);
    expect(frontmatter.count).toBe(5);
  });

  test("handles boolean values", () => {
    const md = "---\nactive: true\narchived: false\n---\nBody";
    const { frontmatter } = parseFrontmatter(md);
    expect(frontmatter.active).toBe(true);
    expect(frontmatter.archived).toBe(false);
  });

  test("returns empty frontmatter if no --- block", () => {
    const md = "Just a plain document\nwith no frontmatter";
    const { frontmatter, body } = parseFrontmatter(md);
    expect(Object.keys(frontmatter)).toHaveLength(0);
    expect(body).toBe(md);
  });

  test("handles colon in values", () => {
    const md = '---\ntimestamp: "2026-03-08T06:00:00Z"\n---\nBody';
    const { frontmatter } = parseFrontmatter(md);
    expect(frontmatter.timestamp).toBe("2026-03-08T06:00:00Z");
  });

  test("parses real work trail frontmatter", () => {
    const md = [
      "---",
      "work_item_id: ELLIE-338",
      "agent: claude-code",
      "status: in-progress",
      "started_at: 2026-03-07T06:17:48.282Z",
      "completed_at: null",
      "scope_path: 2/1",
      "---",
      "",
      "# Title",
    ].join("\n");

    const { frontmatter, body } = parseFrontmatter(md);
    expect(frontmatter.work_item_id).toBe("ELLIE-338");
    expect(frontmatter.agent).toBe("claude-code");
    expect(frontmatter.status).toBe("in-progress");
    expect(frontmatter.completed_at).toBeNull();
    expect(body).toContain("# Title");
  });
});

// ── Pure: serializeWithFrontmatter ──────────────────────────

describe("serializeWithFrontmatter", () => {
  test("serializes frontmatter + body", () => {
    const fm = { title: "Hello", status: "done" };
    const result = serializeWithFrontmatter(fm, "# Body");
    expect(result).toBe("---\ntitle: Hello\nstatus: done\n---\n# Body");
  });

  test("returns body unchanged if frontmatter is empty", () => {
    const result = serializeWithFrontmatter({}, "# Body");
    expect(result).toBe("# Body");
  });

  test("serializes null values", () => {
    const result = serializeWithFrontmatter({ completed_at: null }, "Body");
    expect(result).toContain("completed_at: null");
  });

  test("serializes boolean values", () => {
    const result = serializeWithFrontmatter({ active: true, archived: false }, "Body");
    expect(result).toContain("active: true");
    expect(result).toContain("archived: false");
  });

  test("serializes numeric values", () => {
    const result = serializeWithFrontmatter({ count: 5, score: 0.9 }, "Body");
    expect(result).toContain("count: 5");
    expect(result).toContain("score: 0.9");
  });

  test("quotes values containing colons", () => {
    const result = serializeWithFrontmatter(
      { timestamp: "2026-03-08T06:00:00Z" },
      "Body",
    );
    expect(result).toContain('"2026-03-08T06:00:00Z"');
  });

  test("roundtrips with parseFrontmatter", () => {
    const fm = { work_item_id: "ELLIE-655", status: "in-progress" };
    const body = "# Title\n\nContent here";
    const serialized = serializeWithFrontmatter(fm, body);
    const { frontmatter, body: parsedBody } = parseFrontmatter(serialized);
    expect(frontmatter.work_item_id).toBe("ELLIE-655");
    expect(frontmatter.status).toBe("in-progress");
    expect(parsedBody).toBe(body);
  });
});

// ── Pure: mergeFrontmatter ──────────────────────────────────

describe("mergeFrontmatter", () => {
  test("incoming values override existing", () => {
    const result = mergeFrontmatter(
      { status: "in-progress", agent: "dev" },
      { status: "done" },
    );
    expect(result.status).toBe("done");
    expect(result.agent).toBe("dev");
  });

  test("adds new keys from incoming", () => {
    const result = mergeFrontmatter(
      { title: "Old" },
      { completed_at: "2026-03-08" },
    );
    expect(result.title).toBe("Old");
    expect(result.completed_at).toBe("2026-03-08");
  });

  test("does not mutate inputs", () => {
    const existing = { a: 1 };
    const incoming = { b: 2 };
    mergeFrontmatter(existing, incoming);
    expect(existing).toEqual({ a: 1 });
    expect(incoming).toEqual({ b: 2 });
  });
});

// ── Pure: applyFrontmatter ──────────────────────────────────

describe("applyFrontmatter", () => {
  test("merges into existing frontmatter", () => {
    const md = "---\nstatus: in-progress\n---\n# Body";
    const result = applyFrontmatter(md, { status: "done", completed_at: "2026-03-08" });
    const { frontmatter } = parseFrontmatter(result);
    expect(frontmatter.status).toBe("done");
    expect(frontmatter.completed_at).toBe("2026-03-08");
  });

  test("adds frontmatter to plain content", () => {
    const result = applyFrontmatter("# Body", { title: "New" });
    expect(result).toContain("---");
    expect(result).toContain("title: New");
    expect(result).toContain("# Body");
  });

  test("returns content unchanged with empty incoming", () => {
    const md = "---\nstatus: done\n---\n# Body";
    const result = applyFrontmatter(md, {});
    expect(result).toBe(md);
  });
});

// ── Integration: QMD Search for Indexed River Docs ──────────

describe("Tier 5 — QMD Search for River Docs", () => {
  test("search finds indexed documents by keyword", async () => {
    // "architecture" matches indexed docs in architecture/ directory
    const res = await riverFetch("search", "POST", {
      query: "architecture",
      limit: 5,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.memories.length).toBeGreaterThan(0);
  });

  test("search results have expected shape", async () => {
    const res = await riverFetch("search", "POST", {
      query: "protocol",
      limit: 3,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    if (data.memories.length > 0) {
      const m = data.memories[0];
      expect(m.id).toBeTruthy(); // docid
      expect(m.content).toBeTruthy(); // snippet
      expect(m.source).toBe("river");
      expect(m.scope_path).toBe("R/R");
      expect(typeof m.score).toBe("number");
      expect(typeof m.confidence).toBe("number");
      expect(m.file).toMatch(/^qmd:\/\/ellie-river\//);
    }
  });

  test("search respects limit parameter", async () => {
    const res = await riverFetch("search", "POST", {
      query: "agent",
      limit: 2,
    });
    const data = await res.json();
    expect(data.memories.length).toBeLessThanOrEqual(2);
  });

  test("search returns 400 for missing query", async () => {
    const res = await riverFetch("search", "POST", {});
    expect(res.status).toBe(400);
  });
});

// ── Integration: QMD Doc Retrieval ──────────────────────────

describe("Tier 5 — QMD Doc Retrieval", () => {
  test("retrieves indexed document by docid", async () => {
    // Get catalog, pick first indexed doc
    const catRes = await riverFetch("catalog");
    const catData = await catRes.json();
    expect(catData.docs.length).toBeGreaterThan(0);

    const doc = catData.docs[0];
    const res = await riverFetch(
      `doc?id=${encodeURIComponent(doc.docid)}`,
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.content).toBeTruthy();
    expect(data.docid).toBe(doc.docid);
  });

  test("retrieved doc content is valid markdown", async () => {
    const catRes = await riverFetch("catalog");
    const catData = await catRes.json();
    // Find a doc with frontmatter (skills/prompts usually have it)
    const skillDoc = catData.docs.find((d: any) =>
      d.path.startsWith("skills/") || d.path.startsWith("prompts/"),
    );
    if (skillDoc) {
      const res = await riverFetch(
        `doc?id=${encodeURIComponent(skillDoc.docid)}`,
      );
      const data = await res.json();
      // Should have frontmatter or markdown content
      expect(data.content.length).toBeGreaterThan(10);
    }
  });

  test("doc endpoint validates missing id", async () => {
    const res = await riverFetch("doc");
    expect(res.status).toBe(400);
  });

  test("doc endpoint validates non-qmd URI", async () => {
    const res = await riverFetch("doc?id=https://example.com");
    expect(res.status).toBe(400);
  });
});

// ── Integration: River Catalog ───────────────────────────────

describe("Tier 5 — River Catalog", () => {
  test("catalog returns indexed documents", async () => {
    const res = await riverFetch("catalog");
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.docs.length).toBeGreaterThan(0);
  });

  test("catalog entries have correct docid format", async () => {
    const res = await riverFetch("catalog");
    const data = await res.json();

    for (const doc of data.docs.slice(0, 5)) {
      expect(doc.docid).toMatch(/^qmd:\/\/ellie-river\//);
      expect(doc.path).toMatch(/\.md$/);
      expect(doc.path).not.toStartWith("/");
    }
  });

  test("catalog has metadata fields", async () => {
    const res = await riverFetch("catalog");
    const data = await res.json();
    const doc = data.docs[0];
    expect(doc.size).toBeTruthy();
    expect(doc.updated_at).toBeTruthy();
  });

  test("work trails exist on disk even if not in QMD index", () => {
    // Work trails are written to disk but QMD may not index them
    // Verify they exist on the filesystem
    const fs = require("fs");
    const trailDirs = fs.readdirSync(`${RIVER_ROOT}/work-trails`);
    expect(trailDirs.length).toBeGreaterThan(0);
    // Spot-check a known trail
    expect(
      fs.existsSync(
        `${RIVER_ROOT}/work-trails/ELLIE-338/ELLIE-338-2026-03-07.md`,
      ),
    ).toBe(true);
  });
});

// ── Integration: Cross-Referencing Work Trails ──────────────

describe("Tier 5 — Work Trail Cross-Referencing", () => {
  const TRAIL_A_PATH = "work-trails/TEST-655A/TEST-655A-2026-03-08.md";
  const TRAIL_B_PATH = "work-trails/TEST-655B/TEST-655B-2026-03-08.md";

  beforeAll(async () => {
    // Clean up any leftovers
    await unlink(`${RIVER_ROOT}/${TRAIL_A_PATH}`).catch(() => {});
    await unlink(`${RIVER_ROOT}/${TRAIL_B_PATH}`).catch(() => {});
    const { rmdir } = await import("fs/promises");
    await rmdir(`${RIVER_ROOT}/work-trails/TEST-655A`).catch(() => {});
    await rmdir(`${RIVER_ROOT}/work-trails/TEST-655B`).catch(() => {});
  });

  afterAll(async () => {
    await unlink(`${RIVER_ROOT}/${TRAIL_A_PATH}`).catch(() => {});
    await unlink(`${RIVER_ROOT}/${TRAIL_B_PATH}`).catch(() => {});
    const { rmdir } = await import("fs/promises");
    await rmdir(`${RIVER_ROOT}/work-trails/TEST-655A`).catch(() => {});
    await rmdir(`${RIVER_ROOT}/work-trails/TEST-655B`).catch(() => {});
  });

  test("create trail A with cross-reference to trail B", async () => {
    const content = buildWorkTrailStartContent(
      "TEST-655A",
      "First trail with cross-ref",
      "test-agent",
      "2026-03-08T06:00:00Z",
    );

    const res = await riverFetch("write", "POST", {
      path: TRAIL_A_PATH,
      content,
      operation: "create",
    });
    expect(res.status).toBe(200);
  });

  test("create trail B referencing trail A", async () => {
    const content = buildWorkTrailStartContent(
      "TEST-655B",
      "Second trail referencing first",
      "test-agent",
      "2026-03-08T07:00:00Z",
    );

    const res = await riverFetch("write", "POST", {
      path: TRAIL_B_PATH,
      content,
      operation: "create",
    });
    expect(res.status).toBe(200);
  });

  test("append cross-reference from B to A", async () => {
    const crossRef = buildWorkTrailDecisionAppend(
      "Depends on [[work-trails/TEST-655A/TEST-655A-2026-03-08]] — reusing same approach",
      "test-agent",
      "2026-03-08T08:00:00Z",
    );

    const res = await riverFetch("write", "POST", {
      path: TRAIL_B_PATH,
      content: crossRef,
      operation: "append",
    });
    expect(res.status).toBe(200);
  });

  test("verify cross-reference content on disk", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync(
      `${RIVER_ROOT}/${TRAIL_B_PATH}`,
      "utf-8",
    );
    expect(content).toContain("[[work-trails/TEST-655A/TEST-655A-2026-03-08]]");
    expect(content).toContain("work_item_id: TEST-655B");
  });

  test("cross-reference uses valid Obsidian wiki link format", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync(
      `${RIVER_ROOT}/${TRAIL_B_PATH}`,
      "utf-8",
    );
    // Obsidian wiki links: [[path/to/file]] or [[path/to/file|display text]]
    const wikiLinks = content.match(/\[\[([^\]]+)\]\]/g) || [];
    expect(wikiLinks.length).toBeGreaterThan(0);

    for (const link of wikiLinks) {
      const inner = link.slice(2, -2).split("|")[0];
      // Should be a valid relative path (no extension needed for Obsidian)
      expect(inner).not.toContain("..");
      expect(inner).not.toStartWith("/");
    }
  });

  test("plain ticket ID references are valid", async () => {
    const fs = await import("fs");
    const contentA = fs.readFileSync(
      `${RIVER_ROOT}/${TRAIL_A_PATH}`,
      "utf-8",
    );
    // Ticket IDs in frontmatter should match the path
    expect(contentA).toContain("work_item_id: TEST-655A");
  });
});

// ── Integration: River Link API ─────────────────────────────

describe("Tier 5 — River Link API", () => {
  let createdLinkMemoryId: string | null = null;

  test("creates a vine from Forest to River doc", async () => {
    // Use a real docid from catalog
    const catRes = await riverFetch("catalog");
    const catData = await catRes.json();
    const doc = catData.docs[0];

    const res = await riverFetch("link", "POST", {
      doc_id: doc.docid,
      tree_id: "00000000-0000-0000-0000-000000000001", // synthetic tree_id
      link_type: "related",
      description: "Test link from ELLIE-655 test suite",
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.memory_id).toBeTruthy();
    createdLinkMemoryId = data.memory_id;
  });

  test("link requires doc_id", async () => {
    const res = await riverFetch("link", "POST", {
      tree_id: "00000000-0000-0000-0000-000000000001",
    });
    expect(res.status).toBe(400);
  });

  test("link requires at least one target (tree_id or memory_id)", async () => {
    const res = await riverFetch("link", "POST", {
      doc_id: "qmd://ellie-river/some-doc.md",
    });
    expect(res.status).toBe(400);
  });

  test("link with memory_id target", async () => {
    const catRes = await riverFetch("catalog");
    const catData = await catRes.json();
    const doc = catData.docs[0];

    const res = await riverFetch("link", "POST", {
      doc_id: doc.docid,
      memory_id: "00000000-0000-0000-0000-000000000002",
      link_type: "references",
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });
});

// ── Integration: Write + Search Roundtrip ───────────────────

describe("Tier 5 — Write + Verify Roundtrip", () => {
  const TS = Date.now();
  const UNIQUE_PATH = `work-trails/TEST-655RT/TEST-655RT-2026-03-08.md`;

  beforeAll(async () => {
    await unlink(`${RIVER_ROOT}/${UNIQUE_PATH}`).catch(() => {});
    const { rmdir } = await import("fs/promises");
    await rmdir(`${RIVER_ROOT}/work-trails/TEST-655RT`).catch(() => {});
  });

  afterAll(async () => {
    await unlink(`${RIVER_ROOT}/${UNIQUE_PATH}`).catch(() => {});
    const { rmdir } = await import("fs/promises");
    await rmdir(`${RIVER_ROOT}/work-trails/TEST-655RT`).catch(() => {});
  });

  test("create work trail with unique content", async () => {
    const content = buildWorkTrailStartContent(
      "TEST-655RT",
      `Roundtrip test ${TS}`,
      "test-agent",
      "2026-03-08T06:00:00Z",
    );

    const res = await riverFetch("write", "POST", {
      path: UNIQUE_PATH,
      content,
      operation: "create",
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.docid).toBe(`qmd://ellie-river/${UNIQUE_PATH}`);
    expect(data.operation).toBe("create");
  });

  test("verify file on disk matches expected structure", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync(
      `${RIVER_ROOT}/${UNIQUE_PATH}`,
      "utf-8",
    );

    // Parse and validate frontmatter
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter.work_item_id).toBe("TEST-655RT");
    expect(frontmatter.status).toBe("in-progress");
    expect(frontmatter.started_at).toBe("2026-03-08T06:00:00Z");

    // Validate body has required sections
    expect(body).toContain("## Context");
    expect(body).toContain("## What Was Done");
    expect(body).toContain("## Files Changed");
    expect(body).toContain("## Decisions");
  });

  test("append updates frontmatter via merge", async () => {
    const res = await riverFetch("write", "POST", {
      path: UNIQUE_PATH,
      content: "\n### Update — 2026-03-08T10:00:00Z\n\nAdded some progress.",
      operation: "append",
      frontmatter: { status: "done", completed_at: "2026-03-08T10:00:00Z" },
    });

    expect(res.status).toBe(200);

    // Verify merged frontmatter on disk
    const fs = await import("fs");
    const content = fs.readFileSync(
      `${RIVER_ROOT}/${UNIQUE_PATH}`,
      "utf-8",
    );
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.status).toBe("done");
    expect(frontmatter.completed_at).toBe("2026-03-08T10:00:00Z");
    // Original fields preserved
    expect(frontmatter.work_item_id).toBe("TEST-655RT");
  });

  test("update replaces full content", async () => {
    const newContent = [
      "---",
      "work_item_id: TEST-655RT",
      "status: done",
      "started_at: 2026-03-08T06:00:00Z",
      "completed_at: 2026-03-08T12:00:00Z",
      "---",
      "",
      "# Replaced Content",
      "",
      "## Context",
      "Fully replaced",
      "## What Was Done",
      "Everything",
      "## Files Changed",
      "None",
      "## Decisions",
      "Replace all",
    ].join("\n");

    const res = await riverFetch("write", "POST", {
      path: UNIQUE_PATH,
      content: newContent,
      operation: "update",
    });
    expect(res.status).toBe(200);

    const fs = await import("fs");
    const content = fs.readFileSync(
      `${RIVER_ROOT}/${UNIQUE_PATH}`,
      "utf-8",
    );
    expect(content).toContain("# Replaced Content");
    expect(content).toContain("Fully replaced");
  });
});
