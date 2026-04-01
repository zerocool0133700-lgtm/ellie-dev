/**
 * ELLIE-649 — Test Tier 2: Conversation Facts ([REMEMBER:] tags)
 *
 * Tests tag parsing, pattern extraction, classifiers, conflict type detection,
 * and Memory API endpoints (facts CRUD, goals, conflicts, search).
 */

import { describe, test, expect } from "bun:test";
import { _testing } from "../src/ums/consumers/memory.ts";

const { parseTags, extractPatterns, classifyFactType, classifyCategory, classifyConflictType, inferTags } = _testing;

// ── [REMEMBER:] Tag Parsing ─────────────────────────────────

describe("parseTags — [REMEMBER:]", () => {
  test("extracts a simple REMEMBER tag", () => {
    const facts = parseTags("Hey [REMEMBER: Dave prefers morning meetings] okay?");
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe("Dave prefers morning meetings");
    expect(facts[0].confidence).toBe(1.0);
    expect(facts[0].extraction_method).toBe("tag");
    expect(facts[0].tags).toContain("user-tagged");
  });

  test("extracts multiple REMEMBER tags", () => {
    const facts = parseTags(
      "[REMEMBER: Coffee black no sugar] and also [REMEMBER: Allergic to shellfish]"
    );
    expect(facts).toHaveLength(2);
    expect(facts[0].content).toBe("Coffee black no sugar");
    expect(facts[1].content).toBe("Allergic to shellfish");
  });

  test("classifies REMEMBER tag content by type", () => {
    const prefFacts = parseTags("[REMEMBER: I prefer dark mode]");
    expect(prefFacts[0].type).toBe("preference");

    const factFacts = parseTags("[REMEMBER: The server runs on port 3001]");
    expect(factFacts[0].type).toBe("fact");

    const decisionFacts = parseTags("[REMEMBER: We decided to use Bun]");
    expect(decisionFacts[0].type).toBe("decision");
  });

  test("classifies REMEMBER tag content by category", () => {
    const techFact = parseTags("[REMEMBER: The postgres connection pool is maxed out]");
    expect(techFact[0].category).toBe("technical");

    const scheduleFact = parseTags("[REMEMBER: My flight is on Tuesday]");
    expect(scheduleFact[0].category).toBe("schedule");
  });

  test("ignores REMEMBER tags with very short content", () => {
    const facts = parseTags("[REMEMBER: ab]");
    expect(facts).toHaveLength(0);
  });

  test("is case insensitive", () => {
    const facts = parseTags("[remember: test fact about something]");
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe("test fact about something");
  });

  test("returns empty for no tags", () => {
    const facts = parseTags("Just a regular message with no tags at all.");
    expect(facts).toHaveLength(0);
  });
});

// ── [GOAL:] Tag Parsing ─────────────────────────────────────

describe("parseTags — [GOAL:]", () => {
  test("extracts a simple goal", () => {
    const facts = parseTags("[GOAL: Ship the memory module]");
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe("Ship the memory module");
    expect(facts[0].type).toBe("goal");
    expect(facts[0].confidence).toBe(1.0);
    expect(facts[0].deadline).toBeUndefined();
  });

  test("extracts goal with deadline", () => {
    const facts = parseTags("[GOAL: Test memory system | DEADLINE: 2026-03-10]");
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe("Test memory system");
    expect(facts[0].type).toBe("goal");
    expect(facts[0].deadline).toBe("2026-03-10");
  });

  test("goal category defaults to work", () => {
    const facts = parseTags("[GOAL: Complete the quarterly review]");
    expect(facts[0].category).toBe("work");
  });

  test("handles mixed REMEMBER and GOAL tags", () => {
    const facts = parseTags(
      "[REMEMBER: Dave likes coffee] and [GOAL: Build dashboard | DEADLINE: 2026-04-01]"
    );
    expect(facts).toHaveLength(2);
    expect(facts[0].type).not.toBe("goal"); // REMEMBER → classified type
    expect(facts[1].type).toBe("goal");
    expect(facts[1].deadline).toBe("2026-04-01");
  });
});

// ── Pattern Extraction ──────────────────────────────────────

describe("extractPatterns", () => {
  test("extracts preference patterns", () => {
    const facts = extractPatterns("I prefer using TypeScript for everything.");
    expect(facts).toHaveLength(1);
    expect(facts[0].type).toBe("preference");
    expect(facts[0].confidence).toBe(0.7);
    expect(facts[0].extraction_method).toBe("pattern");
  });

  test("extracts decision patterns", () => {
    const facts = extractPatterns("I've decided to migrate to Bun runtime.");
    expect(facts).toHaveLength(1);
    expect(facts[0].type).toBe("decision");
    expect(facts[0].confidence).toBe(0.7);
  });

  test("extracts constraint patterns", () => {
    const facts = extractPatterns("I can't do meetings on Fridays after noon.");
    expect(facts).toHaveLength(1);
    expect(facts[0].type).toBe("constraint");
    expect(facts[0].category).toBe("schedule");
  });

  test("extracts contact patterns", () => {
    const facts = extractPatterns("Sarah is the VP at Anthropic headquarters.");
    expect(facts).toHaveLength(1);
    expect(facts[0].type).toBe("contact");
    expect(facts[0].category).toBe("people");
  });

  test("extracts fact patterns about self", () => {
    const facts = extractPatterns("I work at a startup in Austin Texas.");
    expect(facts).toHaveLength(1);
    expect(facts[0].type).toBe("fact");
    expect(facts[0].confidence).toBe(0.6);
  });

  test("extracts schedule patterns", () => {
    const facts = extractPatterns("I have a meeting with the team tomorrow morning.");
    expect(facts).toHaveLength(1);
    expect(facts[0].category).toBe("schedule");
  });

  test("skips questions", () => {
    const facts = extractPatterns("What do you prefer for dinner tonight?");
    expect(facts).toHaveLength(0);
  });

  test("skips short sentences", () => {
    const facts = extractPatterns("I like it.");
    expect(facts).toHaveLength(0);
  });

  test("returns empty for unrecognizable text", () => {
    const facts = extractPatterns("The weather looks nice outside today.");
    expect(facts).toHaveLength(0);
  });
});

// ── Fact Type Classifier ────────────────────────────────────

describe("classifyFactType", () => {
  test("classifies preferences", () => {
    expect(classifyFactType("I prefer dark mode")).toBe("preference");
    expect(classifyFactType("My favorite editor is vim")).toBe("preference");
    expect(classifyFactType("I always use TypeScript")).toBe("preference");
  });

  test("classifies decisions", () => {
    expect(classifyFactType("We decided to use Postgres")).toBe("decision");
    expect(classifyFactType("Let's go with option B")).toBe("decision");
  });

  test("classifies constraints", () => {
    expect(classifyFactType("I can't do mornings")).toBe("constraint");
    expect(classifyFactType("Unavailable on weekends")).toBe("constraint");
  });

  test("classifies contacts", () => {
    expect(classifyFactType("Tom is the CTO at Acme")).toBe("contact");
    expect(classifyFactType("Sarah works at Google")).toBe("contact");
  });

  test("defaults to fact", () => {
    expect(classifyFactType("The server runs on port 8080")).toBe("fact");
    expect(classifyFactType("Project started in January")).toBe("fact");
  });
});

// ── Category Classifier ─────────────────────────────────────

describe("classifyCategory", () => {
  test("classifies schedule", () => {
    expect(classifyCategory("My meeting is at 3pm")).toBe("schedule");
    expect(classifyCategory("The deadline is Friday")).toBe("schedule");
    expect(classifyCategory("I have a flight on Monday")).toBe("schedule");
  });

  test("classifies work", () => {
    expect(classifyCategory("The deploy broke again")).toBe("work");
    expect(classifyCategory("Need to fix the API endpoint")).toBe("work");
  });

  test("classifies people", () => {
    expect(classifyCategory("My wife said to call back")).toBe("people");
    expect(classifyCategory("Tom works at the lab")).toBe("people");
  });

  test("classifies technical", () => {
    expect(classifyCategory("The postgres connection pool is full")).toBe("technical");
    expect(classifyCategory("We need to upgrade bun")).toBe("technical");
  });

  test("classifies personal", () => {
    expect(classifyCategory("I am originally from Texas")).toBe("personal");
    expect(classifyCategory("My hobby is woodworking")).toBe("personal");
  });

  test("defaults to other", () => {
    expect(classifyCategory("Something happened yesterday")).toBe("other");
  });
});

// ── Tag Inference ───────────────────────────────────────────

describe("inferTags", () => {
  test("infers editor tag", () => {
    expect(inferTags("I use vscode for everything")).toContain("editor");
  });

  test("infers timezone tag", () => {
    expect(inferTags("My timezone is CST")).toContain("timezone");
  });

  test("infers schedule tag", () => {
    expect(inferTags("I have a meeting at 3pm")).toContain("schedule");
  });

  test("infers food tag", () => {
    expect(inferTags("I drink coffee every morning")).toContain("food");
  });

  test("infers development tag", () => {
    expect(inferTags("TypeScript is my main programming language")).toContain("development");
  });

  test("infers communication tag", () => {
    expect(inferTags("I prefer telegram for messaging")).toContain("communication");
  });

  test("infers multiple tags", () => {
    const tags = inferTags("I schedule my vim coding sessions via slack");
    expect(tags).toContain("editor");
    expect(tags).toContain("schedule");
    expect(tags).toContain("communication");
  });

  test("returns empty for no matches", () => {
    expect(inferTags("The sky is blue")).toHaveLength(0);
  });
});

// ── Conflict Type Classification ────────────────────────────

describe("classifyConflictType", () => {
  test("detects update when new content has update keywords", () => {
    expect(classifyConflictType(
      "I use vim as my editor",
      "I switched to vscode recently"
    )).toBe("update");
  });

  test("detects update with 'now use' keyword", () => {
    expect(classifyConflictType(
      "We use REST APIs",
      "We now use GraphQL for everything"
    )).toBe("update");
  });

  test("detects update with 'changed' keyword", () => {
    expect(classifyConflictType(
      "My timezone is EST",
      "I changed my timezone to CST"
    )).toBe("update");
  });

  test("detects clarification when new content is much longer", () => {
    expect(classifyConflictType(
      "I use Bun",
      "I use Bun as my primary JavaScript runtime because it is faster than Node and has built-in TypeScript support with a great test runner"
    )).toBe("clarification");
  });

  test("detects contradiction with negation change", () => {
    const result = classifyConflictType(
      "I like working with Java applications",
      "I don't like working with Java applications"
    );
    expect(result).toBe("contradiction");
  });

  test("defaults to clarification for different-enough content", () => {
    const result = classifyConflictType(
      "The project started in January",
      "We hired three new engineers for the project"
    );
    expect(result).toBe("clarification");
  });
});

// ── Memory API Integration Tests ────────────────────────────
// SKIPPED: These require the relay to be running (http://localhost:3001)
// They are integration tests, not unit tests. Run manually with `bun start` + `bun test tests/conversation-facts.test.ts`

const API_BASE = "http://localhost:3001/api/memory";
const testIds: string[] = [];

// Helper to clean up test facts
async function cleanupTestFacts() {
  for (const id of testIds) {
    try {
      await fetch(`${API_BASE}/facts/${id}`, { method: "DELETE" });
    } catch { /* ignore cleanup errors */ }
  }
  testIds.length = 0;
}

describe.skip("Memory API — Facts CRUD", () => {
  test("POST /api/memory/facts — creates a fact", async () => {
    const res = await fetch(`${API_BASE}/facts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "ELLIE-649 test fact: Dave prefers morning meetings",
        type: "preference",
        category: "work",
        confidence: 1.0,
        tags: ["test-649", "schedule"],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.fact).toBeDefined();
    expect(data.fact.content).toBe("ELLIE-649 test fact: Dave prefers morning meetings");
    expect(data.fact.type).toBe("preference");
    expect(data.fact.confidence).toBe(1.0);
    expect(data.fact.extraction_method).toBe("manual");
    testIds.push(data.fact.id);
  });

  test("GET /api/memory/facts — lists facts", async () => {
    const res = await fetch(`${API_BASE}/facts?limit=5`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(Array.isArray(data.facts)).toBe(true);
    expect(typeof data.total).toBe("number");
  });

  test("GET /api/memory/facts — filters by type", async () => {
    const res = await fetch(`${API_BASE}/facts?type=preference&limit=5`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    if (data.facts.length > 0) {
      expect(data.facts.every((f: { type: string }) => f.type === "preference")).toBe(true);
    }
  });

  test("GET /api/memory/facts — filters by tag", async () => {
    const res = await fetch(`${API_BASE}/facts?tag=test-649&limit=5`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    if (data.facts.length > 0) {
      expect(data.facts.every((f: { tags: string[] }) => f.tags.includes("test-649"))).toBe(true);
    }
  });

  test("PUT /api/memory/facts/:id — updates a fact", async () => {
    // Create a fact first
    const createRes = await fetch(`${API_BASE}/facts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "ELLIE-649 update test original",
        type: "fact",
        tags: ["test-649"],
      }),
    });
    const created = await createRes.json();
    testIds.push(created.fact.id);

    // Update it
    const res = await fetch(`${API_BASE}/facts/${created.fact.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "ELLIE-649 update test modified",
        confidence: 0.9,
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.fact.content).toBe("ELLIE-649 update test modified");
    expect(data.fact.confidence).toBe(0.9);
  });

  test("DELETE /api/memory/facts/:id — archives a fact", async () => {
    const createRes = await fetch(`${API_BASE}/facts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "ELLIE-649 delete test fact",
        type: "fact",
        tags: ["test-649"],
      }),
    });
    const created = await createRes.json();
    // Don't add to testIds since we're deleting it

    const res = await fetch(`${API_BASE}/facts/${created.fact.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.archived).toBe(true);
  });

  test("POST /api/memory/facts — rejects missing content", async () => {
    const res = await fetch(`${API_BASE}/facts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "fact" }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/memory/facts — rejects invalid type", async () => {
    const res = await fetch(`${API_BASE}/facts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "test", type: "invalid_type" }),
    });
    expect(res.status).toBe(400);
  });
});

// ── Goals API ───────────────────────────────────────────────

describe.skip("Memory API — Goals", () => {
  test("creates and lists a goal", async () => {
    // Create a goal via facts endpoint
    const createRes = await fetch(`${API_BASE}/facts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "ELLIE-649 test goal: Ship memory module",
        type: "goal",
        category: "work",
        tags: ["test-649"],
        deadline: "2026-03-10T00:00:00Z",
      }),
    });
    const created = await createRes.json();
    expect(created.success).toBe(true);
    testIds.push(created.fact.id);

    // List active goals
    const res = await fetch(`${API_BASE}/goals?status=active`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(Array.isArray(data.goals)).toBe(true);

    // Our test goal should be in there
    const testGoal = data.goals.find((g: { id: string }) => g.id === created.fact.id);
    expect(testGoal).toBeDefined();
    expect(testGoal.type).toBe("goal");
    expect(testGoal.deadline).toBeTruthy();
  });

  test("completes a goal via API", async () => {
    // Create a goal
    const createRes = await fetch(`${API_BASE}/facts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "ELLIE-649 goal to complete",
        type: "goal",
        tags: ["test-649"],
      }),
    });
    const created = await createRes.json();
    testIds.push(created.fact.id);

    // Complete it
    const res = await fetch(`${API_BASE}/goals/${created.fact.id}/complete`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.goal.type).toBe("completed_goal");
    expect(data.goal.status).toBe("archived");
    expect(data.goal.completed_at).toBeTruthy();
  });

  test("rejects completing a non-goal", async () => {
    // Create a regular fact
    const createRes = await fetch(`${API_BASE}/facts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "ELLIE-649 not a goal",
        type: "fact",
        tags: ["test-649"],
      }),
    });
    const created = await createRes.json();
    testIds.push(created.fact.id);

    // Try to complete it
    const res = await fetch(`${API_BASE}/goals/${created.fact.id}/complete`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  test("lists completed goals", async () => {
    const res = await fetch(`${API_BASE}/goals?status=completed`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    if (data.goals.length > 0) {
      expect(data.goals.every((g: { type: string }) => g.type === "completed_goal")).toBe(true);
    }
  });
});

// ── Search API ──────────────────────────────────────────────

describe.skip("Memory API — Search", () => {
  test("searches facts by text", async () => {
    // Create a searchable fact
    const createRes = await fetch(`${API_BASE}/facts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "ELLIE-649 searchable: Dave uses bun runtime exclusively",
        type: "fact",
        tags: ["test-649"],
      }),
    });
    const created = await createRes.json();
    testIds.push(created.fact.id);

    const res = await fetch(`${API_BASE}/search?q=bun+runtime+exclusively&limit=5`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.results.length).toBeGreaterThan(0);
    expect(data.results.some((r: { id: string }) => r.id === created.fact.id)).toBe(true);
  });

  test("rejects empty search query", async () => {
    const res = await fetch(`${API_BASE}/search?q=`);
    expect(res.status).toBe(400);
  });

  test("filters search by type", async () => {
    const res = await fetch(`${API_BASE}/search?q=ELLIE-649&type=preference&limit=5`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    if (data.results.length > 0) {
      expect(data.results.every((r: { type: string }) => r.type === "preference")).toBe(true);
    }
  });
});

// ── Tags API ────────────────────────────────────────────────

describe.skip("Memory API — Tags", () => {
  test("lists all tags", async () => {
    const res = await fetch(`${API_BASE}/tags`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });
});

// ── Module Stats & Health ───────────────────────────────────

describe.skip("Memory API — Stats & Health", () => {
  test("returns module stats", async () => {
    const res = await fetch(`${API_BASE}/module-stats`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(typeof data.factCount).toBe("number");
    expect(typeof data.goalCount).toBe("number");
    expect(typeof data.conflictCount).toBe("number");
  });

  test("returns health report", async () => {
    const res = await fetch(`${API_BASE}/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.grade).toBeDefined();
    expect(typeof data.avgConfidence).toBe("number");
    expect(typeof data.totalActive).toBe("number");
  });
});

// ── Cleanup ─────────────────────────────────────────────────

import { afterAll } from "bun:test";
afterAll(async () => {
  await cleanupTestFacts();
});
