import { describe, test, expect } from "bun:test";
import { processResponseTags, _testing } from "../src/response-tag-processor";

const { parseRememberTags, parseGoalTags, classifyFactType, classifyCategory } = _testing;

// ── parseRememberTags ───────────────────────────────────────

describe("parseRememberTags", () => {
  test("extracts a single REMEMBER tag", () => {
    const facts = parseRememberTags("Hello [REMEMBER: Dave likes coffee] world");
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe("Dave likes coffee");
    expect(facts[0].confidence).toBe(1.0);
    expect(facts[0].tags).toEqual(["agent-tagged"]);
  });

  test("extracts multiple REMEMBER tags", () => {
    const facts = parseRememberTags(
      "[REMEMBER: Dave likes coffee] and also [REMEMBER: Dave works remotely]"
    );
    expect(facts).toHaveLength(2);
    expect(facts[0].content).toBe("Dave likes coffee");
    expect(facts[1].content).toBe("Dave works remotely");
  });

  test("is case-insensitive", () => {
    const facts = parseRememberTags("[remember: lowercase tag]");
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe("lowercase tag");
  });

  test("trims whitespace from content", () => {
    const facts = parseRememberTags("[REMEMBER:   extra spaces   ]");
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe("extra spaces");
  });

  test("skips tags with content shorter than 3 characters", () => {
    const facts = parseRememberTags("[REMEMBER: ab]");
    expect(facts).toHaveLength(0);
  });

  test("returns empty array when no tags present", () => {
    const facts = parseRememberTags("Just a normal message with no tags");
    expect(facts).toHaveLength(0);
  });

  test("classifies type and category for each tag", () => {
    // "prefer" (exact word) triggers preference; "prefers" does not (word boundary)
    const facts = parseRememberTags("[REMEMBER: I prefer dark mode]");
    expect(facts[0].type).toBe("preference");
    // "I prefer" doesn't match any specific category pattern (i am, i live, etc.)
    expect(facts[0].category).toBe("other");
  });
});

// ── parseGoalTags ───────────────────────────────────────────

describe("parseGoalTags", () => {
  test("extracts a simple GOAL tag", () => {
    const facts = parseGoalTags("[GOAL: Ship the new dashboard]");
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe("Ship the new dashboard");
    expect(facts[0].type).toBe("goal");
    expect(facts[0].category).toBe("work");
    expect(facts[0].confidence).toBe(1.0);
    expect(facts[0].deadline).toBeUndefined();
  });

  test("extracts GOAL tag with DEADLINE", () => {
    const facts = parseGoalTags("[GOAL: Finish report | DEADLINE: 2026-04-01]");
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe("Finish report");
    expect(facts[0].deadline).toBe("2026-04-01");
  });

  test("extracts multiple GOAL tags", () => {
    const facts = parseGoalTags(
      "[GOAL: First goal] and [GOAL: Second goal | DEADLINE: tomorrow]"
    );
    expect(facts).toHaveLength(2);
    expect(facts[0].content).toBe("First goal");
    expect(facts[1].deadline).toBe("tomorrow");
  });

  test("is case-insensitive", () => {
    const facts = parseGoalTags("[goal: lower case goal]");
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe("lower case goal");
  });

  test("skips tags with content shorter than 3 characters", () => {
    const facts = parseGoalTags("[GOAL: hi]");
    expect(facts).toHaveLength(0);
  });

  test("returns empty array when no tags present", () => {
    const facts = parseGoalTags("No goals here");
    expect(facts).toHaveLength(0);
  });
});

// ── classifyFactType ────────────────────────────────────────

describe("classifyFactType", () => {
  test("classifies preferences", () => {
    expect(classifyFactType("I prefer dark mode")).toBe("preference");
    expect(classifyFactType("I really like tea")).toBe("preference");
    expect(classifyFactType("I always use Vim")).toBe("preference");
    expect(classifyFactType("My favorite editor is Vim")).toBe("preference");
  });

  test("classifies decisions", () => {
    expect(classifyFactType("Decided to use Postgres")).toBe("decision");
    expect(classifyFactType("We will use React")).toBe("decision");
    expect(classifyFactType("Go with option B")).toBe("decision");
  });

  test("classifies constraints", () => {
    expect(classifyFactType("Dave is unavailable on Fridays")).toBe("constraint");
    expect(classifyFactType("Can't meet before 10am")).toBe("constraint");
    expect(classifyFactType("Don't schedule anything Monday")).toBe("constraint");
  });

  test("classifies contacts", () => {
    expect(classifyFactType("Sarah is the project manager")).toBe("contact");
    expect(classifyFactType("Tom works at Google")).toBe("contact");
  });

  test("defaults to fact", () => {
    expect(classifyFactType("The server runs on port 3001")).toBe("fact");
    expect(classifyFactType("Something happened today")).toBe("fact");
  });
});

// ── classifyCategory ────────────────────────────────────────

describe("classifyCategory", () => {
  test("classifies schedule", () => {
    expect(classifyCategory("Meeting at 3pm tomorrow")).toBe("schedule");
    expect(classifyCategory("Flight to NYC on Friday")).toBe("schedule");
    expect(classifyCategory("Vacation next week")).toBe("schedule");
  });

  test("classifies work", () => {
    expect(classifyCategory("Deploy the API changes")).toBe("work");
    expect(classifyCategory("The Ellie project needs updates")).toBe("work");
    expect(classifyCategory("Fix the database migration")).toBe("work");
  });

  test("classifies people", () => {
    expect(classifyCategory("Sarah works at Acme Corp")).toBe("people");
    expect(classifyCategory("My colleague mentioned it")).toBe("people");
    expect(classifyCategory("He is the CTO")).toBe("people");
  });

  test("classifies technical", () => {
    expect(classifyCategory("Using Redis for caching")).toBe("technical");
    expect(classifyCategory("TypeScript strict mode enabled")).toBe("technical");
    expect(classifyCategory("Docker container setup")).toBe("technical");
  });

  test("classifies personal", () => {
    expect(classifyCategory("I am from Chicago")).toBe("personal");
    expect(classifyCategory("My birthday is in June")).toBe("personal");
  });

  test("defaults to other", () => {
    expect(classifyCategory("Something interesting")).toBe("other");
    expect(classifyCategory("Random note")).toBe("other");
  });
});

// ── processResponseTags (integration) ───────────────────────

describe("processResponseTags", () => {
  test("returns response unchanged when supabase is null", async () => {
    const input = "Hello [REMEMBER: something] world";
    const result = await processResponseTags(null, input, "telegram");
    expect(result).toBe(input);
  });

  test("strips REMEMBER tags from response", async () => {
    const supabase = mockSupabase();
    const result = await processResponseTags(
      supabase,
      "Hello [REMEMBER: Dave likes coffee] world",
      "telegram"
    );
    expect(result).not.toContain("[REMEMBER:");
    expect(result).toContain("Hello");
    expect(result).toContain("world");
  });

  test("strips GOAL tags from response", async () => {
    const supabase = mockSupabase();
    const result = await processResponseTags(
      supabase,
      "Working on [GOAL: Ship dashboard | DEADLINE: 2026-04-01] now",
      "telegram"
    );
    expect(result).not.toContain("[GOAL:");
    expect(result).not.toContain("DEADLINE");
    expect(result).toContain("Working on");
    expect(result).toContain("now");
  });

  test("strips DONE tags from response", async () => {
    const supabase = mockSupabase();
    const result = await processResponseTags(
      supabase,
      "Great job! [DONE: Ship dashboard] All finished.",
      "telegram"
    );
    expect(result).not.toContain("[DONE:");
    expect(result).toContain("Great job!");
    expect(result).toContain("All finished.");
  });

  test("strips multiple tag types in one response", async () => {
    const supabase = mockSupabase();
    const result = await processResponseTags(
      supabase,
      "[REMEMBER: Dave likes coffee] Got it. [GOAL: Buy more coffee] [DONE: Old task]",
      "telegram"
    );
    expect(result).not.toContain("[REMEMBER:");
    expect(result).not.toContain("[GOAL:");
    expect(result).not.toContain("[DONE:");
    expect(result).toContain("Got it.");
  });

  test("stores REMEMBER facts to database", async () => {
    const inserted: Record<string, unknown>[] = [];
    const supabase = mockSupabase({ onInsert: (row) => inserted.push(row) });

    await processResponseTags(
      supabase,
      "Sure thing [REMEMBER: Dave prefers dark mode]",
      "telegram"
    );

    expect(inserted).toHaveLength(1);
    expect(inserted[0].content).toBe("Dave prefers dark mode");
    expect(inserted[0].extraction_method).toBe("tag");
    expect(inserted[0].source_channel).toBe("telegram");
  });

  test("stores GOAL facts to database", async () => {
    const inserted: Record<string, unknown>[] = [];
    const supabase = mockSupabase({ onInsert: (row) => inserted.push(row) });

    await processResponseTags(
      supabase,
      "Let's do it [GOAL: Launch by April | DEADLINE: 2026-04-01]",
      "telegram"
    );

    expect(inserted).toHaveLength(1);
    expect(inserted[0].content).toBe("Launch by April");
    expect(inserted[0].type).toBe("goal");
    expect(inserted[0].deadline).toBeDefined();
  });

  test("handles DONE tags by querying for matching goals", async () => {
    let selectedGoal = false;
    const supabase = mockSupabase({
      onSelect: () => {
        selectedGoal = true;
        return [{ id: "goal-123" }];
      },
    });

    await processResponseTags(
      supabase,
      "Completed [DONE: Ship dashboard]",
      "telegram"
    );

    expect(selectedGoal).toBe(true);
  });

  test("cleans up double spaces after tag removal", async () => {
    const supabase = mockSupabase();
    const result = await processResponseTags(
      supabase,
      "Before [REMEMBER: something] after",
      "telegram"
    );
    // Should not have double spaces
    expect(result).not.toMatch(/  /);
  });

  test("handles response with no tags", async () => {
    const supabase = mockSupabase();
    const result = await processResponseTags(
      supabase,
      "Just a normal response with no special tags",
      "telegram"
    );
    expect(result).toBe("Just a normal response with no special tags");
  });

  test("handles empty response", async () => {
    const supabase = mockSupabase();
    const result = await processResponseTags(supabase, "", "telegram");
    expect(result).toBe("");
  });

  test("handles duplicate insert gracefully (23505 error)", async () => {
    const supabase = mockSupabase({
      insertError: { code: "23505", message: "duplicate key" },
    });

    // Should not throw
    const result = await processResponseTags(
      supabase,
      "[REMEMBER: Duplicate fact]",
      "telegram"
    );
    expect(result).not.toContain("[REMEMBER:");
  });

  test("defaults sourceChannel to telegram", async () => {
    const inserted: Record<string, unknown>[] = [];
    const supabase = mockSupabase({ onInsert: (row) => inserted.push(row) });

    await processResponseTags(supabase, "[REMEMBER: Some fact]");

    expect(inserted).toHaveLength(1);
    expect(inserted[0].source_channel).toBe("telegram");
  });

  test("passes google-chat as sourceChannel", async () => {
    const inserted: Record<string, unknown>[] = [];
    const supabase = mockSupabase({ onInsert: (row) => inserted.push(row) });

    await processResponseTags(
      supabase,
      "[REMEMBER: Some fact]",
      "google-chat"
    );

    expect(inserted).toHaveLength(1);
    expect(inserted[0].source_channel).toBe("google-chat");
  });
});

// ── Mock Supabase ───────────────────────────────────────────

interface MockOpts {
  onInsert?: (row: Record<string, unknown>) => void;
  onSelect?: () => Array<{ id: string }>;
  insertError?: { code: string; message: string } | null;
}

function mockSupabase(opts: MockOpts = {}): any {
  const { onInsert, onSelect, insertError } = opts;

  function chainable(data: unknown = null, error: unknown = null) {
    const obj: any = {
      select: () => obj,
      single: () => ({ data, error }),
      eq: () => obj,
      ilike: () => obj,
      limit: () => obj,
    };

    // For select queries, resolve the chain with data
    if (onSelect) {
      obj.limit = () => ({ data: onSelect(), error: null });
    }

    return obj;
  }

  return {
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        onInsert?.(row);
        if (insertError) {
          return chainable(null, insertError);
        }
        return chainable({ id: `mock-${Date.now()}` });
      },
      select: (..._args: unknown[]) => {
        const chain = chainable();
        if (onSelect) {
          chain.limit = () => ({ data: onSelect(), error: null });
        }
        return chain;
      },
      update: (_row: Record<string, unknown>) => chainable(),
    }),
  };
}
