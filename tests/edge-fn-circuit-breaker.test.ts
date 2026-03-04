/**
 * ELLIE-484 — Edge function circuit breaker
 *
 * Covers: breakers.edgeFn registered in getBreakerStatus(), routeMessage /
 * dispatchAgent / syncResponse stop calling supabase.functions.invoke when the
 * breaker is open, localDispatch/localSync fallbacks activate correctly, and
 * memory functions (checkMemoryConflict, getRelevantContext) guard the search
 * edge function with the same shared breaker.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";

// ── Mock all heavy deps before importing ─────────────────────

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) },
}));

mock.module("../src/relay-epoch.ts", () => ({ RELAY_EPOCH: "test-epoch-1" }));

mock.module("../src/intent-classifier.ts", () => ({
  classifyIntent: mock(() => Promise.resolve({
    agent_name: "general",
    rule_name: "default",
    confidence: 0.9,
    execution_mode: "single",
  })),
}));

mock.module("../src/elasticsearch.ts", () => ({
  indexMemory: mock(() => Promise.resolve()),
  classifyDomain: mock(() => "general"),
  searchElastic: mock(() => Promise.resolve("")),
}));

mock.module("../src/resilient-task.ts", () => ({
  resilientTask: mock((_label: string, _cat: string, fn: () => Promise<void>) => fn().catch(() => {})),
}));

// ── Import after mocks ────────────────────────────────────────

import { breakers, getBreakerStatus } from "../src/resilience.ts";
import { routeMessage, dispatchAgent, syncResponse } from "../src/agent-router.ts";
import { checkMemoryConflict, getRelevantContext } from "../src/memory.ts";

// ── Global teardown — reset shared breaker so other test files aren't affected ─
afterAll(() => { breakers.edgeFn.reset(); });

// ── Shared supabase mock helpers ──────────────────────────────

/** Create a mock supabase where functions.invoke returns the given result. */
function mockSupabase(invokeResult: { data: any; error: any } | null) {
  let invokeCallCount = 0;
  const invoke = mock(async () => {
    invokeCallCount++;
    if (invokeResult === null) throw new Error("invoke should not be called (breaker open)");
    return invokeResult;
  });

  const supabase: any = {
    functions: { invoke },
    _invokeCallCount: () => invokeCallCount,
    // Basic chain for localDispatch / localSync fallback paths
    from: (_table: string) => makeChain(),
  };
  return supabase;
}

/** A chainable mock that returns sensible defaults for localDispatch / localSync. */
function makeChain(overrides?: { agentRow?: any; sessionRow?: any; newSessionRow?: any; sessionLookup?: any }) {
  const agentRow = overrides?.agentRow ?? {
    id: "agent-uuid", name: "general", type: "generalist",
    system_prompt: null, model: null, tools_enabled: [], capabilities: [],
  };
  const newSessionRow = overrides?.newSessionRow ?? { id: "session-uuid" };
  const sessionLookup = overrides?.sessionLookup ?? null; // null = no existing session

  const chain: any = {};
  for (const m of ["select", "insert", "update", "eq", "neq", "is", "order", "limit"]) {
    chain[m] = (..._args: any[]) => chain;
  }
  chain.single = () => {
    // Returns agent row for agents table, null for sessions lookup (no existing session),
    // new session row for session insert
    if (chain._lastInsertHadSessionId) {
      chain._lastInsertHadSessionId = false;
      return Promise.resolve({ data: newSessionRow, error: null });
    }
    if (chain._isSessionLookup) {
      chain._isSessionLookup = false;
      return Promise.resolve({ data: sessionLookup, error: sessionLookup ? null : { message: "not found" } });
    }
    return Promise.resolve({ data: agentRow, error: null });
  };
  // Mark session inserts
  const origInsert = chain.insert.bind(chain);
  chain.insert = (data: any) => {
    if (data && (data.agent_id || data.role)) chain._lastInsertHadSessionId = true;
    return chain;
  };
  // Mark session select/eq chains
  const origEq = chain.eq.bind(chain);
  chain.eq = (col: string, _val: any) => {
    if (col === "state") chain._isSessionLookup = true;
    return chain;
  };
  chain.then = (resolve: Function, reject?: Function) =>
    Promise.resolve({ data: null, error: null }).then(resolve, reject);
  return chain;
}

// ── getBreakerStatus includes edgeFn ─────────────────────────

describe("getBreakerStatus — edgeFn registered", () => {
  test("getBreakerStatus includes edgeFn key", () => {
    const status = getBreakerStatus();
    expect(status).toHaveProperty("edgeFn");
  });

  test("edgeFn starts in closed state with 0 failures", () => {
    breakers.edgeFn.reset();
    const status = getBreakerStatus();
    expect(status.edgeFn.state).toBe("closed");
    expect(status.edgeFn.failures).toBe(0);
  });

  test("getBreakerStatus still includes all original breakers", () => {
    const status = getBreakerStatus();
    expect(status).toHaveProperty("plane");
    expect(status).toHaveProperty("bridge");
    expect(status).toHaveProperty("outlook");
    expect(status).toHaveProperty("googleChat");
  });
});

// ── routeMessage ──────────────────────────────────────────────

describe("routeMessage — edge fn circuit breaker", () => {
  beforeEach(() => { breakers.edgeFn.reset(); });

  test("returns null when edge fn returns an error", async () => {
    const supabase = mockSupabase({ data: null, error: { message: "edge fn down" } });
    const result = await routeMessage(supabase, "hello", "telegram", "user-1");
    expect(result).toBeNull();
    expect(breakers.edgeFn.getState().failures).toBe(1);
  });

  test("returns RouteResult when edge fn succeeds", async () => {
    const routeData = { agent_name: "dev", rule_name: "code-question", confidence: 0.95, execution_mode: "single" };
    const supabase = mockSupabase({ data: routeData, error: null });
    const result = await routeMessage(supabase, "fix this bug", "telegram", "user-1");
    expect(result).not.toBeNull();
    expect(result!.agent_name).toBe("dev");
    expect(breakers.edgeFn.getState().failures).toBe(0);
  });

  test("returns null immediately without calling invoke when breaker is open", async () => {
    // Open the breaker (threshold=3)
    breakers.edgeFn.reset();
    const failSupabase = mockSupabase({ data: null, error: { message: "down" } });
    await routeMessage(failSupabase, "m", "t", "u");
    await routeMessage(failSupabase, "m", "t", "u");
    await routeMessage(failSupabase, "m", "t", "u");
    expect(breakers.edgeFn.getState().state).toBe("open");

    // Now use a supabase that throws if invoke is called
    const throwingSupabase = mockSupabase(null); // null = throw on invoke
    const result = await routeMessage(throwingSupabase, "test", "telegram", "user-2");
    expect(result).toBeNull();
    expect(throwingSupabase._invokeCallCount()).toBe(0); // never called
  });

  test("returns null when supabase is null (no change)", async () => {
    const result = await routeMessage(null, "hello", "telegram", "user-1");
    expect(result).toBeNull();
  });
});

// ── dispatchAgent ─────────────────────────────────────────────

describe("dispatchAgent — edge fn circuit breaker + local fallback", () => {
  beforeEach(() => { breakers.edgeFn.reset(); });

  test("returns DispatchResult when edge fn succeeds", async () => {
    const dispatchData = {
      session_id: "sess-abc",
      is_new: true,
      agent: { name: "general", type: "generalist", system_prompt: null, model: null, tools_enabled: [], capabilities: [] },
    };
    const supabase = mockSupabase({ data: dispatchData, error: null });
    const result = await dispatchAgent(supabase, "general", "user-1", "telegram", "hello");
    expect(result).not.toBeNull();
    expect(result!.session_id).toBe("sess-abc");
    expect(result!.is_new).toBe(true);
  });

  test("records failure on edge fn error", async () => {
    const supabase: any = {
      functions: { invoke: mock(async () => ({ data: null, error: { message: "503" } })) },
      from: () => makeChain(),
    };
    await dispatchAgent(supabase, "general", "user-1", "telegram", "hi");
    expect(breakers.edgeFn.getState().failures).toBe(1);
  });

  test("skips invoke and goes straight to local fallback when breaker is open", async () => {
    // Manually open the breaker
    for (let i = 0; i < 3; i++) {
      const s: any = {
        functions: { invoke: mock(async () => ({ data: null, error: { message: "down" } })) },
        from: () => makeChain(),
      };
      await dispatchAgent(s, "general", "u", "telegram", "msg");
    }
    expect(breakers.edgeFn.getState().state).toBe("open");

    let invokeCalled = 0;
    const openSupabase: any = {
      functions: { invoke: mock(async () => { invokeCalled++; return { data: null, error: null }; }) },
      from: () => makeChain(),
    };
    const result = await dispatchAgent(openSupabase, "general", "user-2", "telegram", "test");
    // Breaker is open — invoke should not be called; local fallback should run
    expect(invokeCalled).toBe(0);
    // Local fallback produces a result (agent found in mock chain)
    expect(result).not.toBeNull();
  });
});

// ── syncResponse ──────────────────────────────────────────────

describe("syncResponse — edge fn circuit breaker + local fallback", () => {
  beforeEach(() => { breakers.edgeFn.reset(); });

  test("returns SyncResult when edge fn succeeds", async () => {
    const supabase = mockSupabase({ data: { success: true }, error: null });
    const result = await syncResponse(supabase, "sess-1", "assistant response");
    expect(result).not.toBeNull();
    expect((result as any).success).toBe(true);
  });

  test("falls back to local sync when edge fn returns error", async () => {
    const supabase: any = {
      functions: { invoke: mock(async () => ({ data: null, error: { message: "edge fn error" } })) },
      from: () => makeChain({ sessionLookup: { id: "sess-1", agent_id: "agent-1", turn_count: 5 } }),
    };
    const result = await syncResponse(supabase, "sess-1", "hi");
    // Falls through to localSync which should succeed with the mock
    expect(result).not.toBeNull();
  });

  test("skips invoke and goes to local sync when breaker is open", async () => {
    // Open the breaker
    for (let i = 0; i < 3; i++) {
      const s: any = {
        functions: { invoke: mock(async () => ({ data: null, error: { message: "down" } })) },
        from: () => makeChain(),
      };
      await syncResponse(s, "sess-x", "msg");
    }
    expect(breakers.edgeFn.getState().state).toBe("open");

    let invokeCalled = 0;
    const openSupabase: any = {
      functions: { invoke: mock(async () => { invokeCalled++; return { data: null, error: null }; }) },
      from: () => makeChain({ sessionLookup: { id: "sess-1", agent_id: "a", turn_count: 0 } }),
    };
    await syncResponse(openSupabase, "sess-1", "response");
    expect(invokeCalled).toBe(0); // never called — breaker short-circuited
  });

  test("returns null when supabase is null", async () => {
    const result = await syncResponse(null, "sess-1", "msg");
    expect(result).toBeNull();
  });
});

// ── Shared breaker — failures from any function count together ─

describe("shared edgeFn breaker — cross-function failure accumulation", () => {
  beforeEach(() => { breakers.edgeFn.reset(); });

  test("failures from routeMessage and dispatchAgent accumulate on same breaker", async () => {
    const failSupabase: any = {
      functions: { invoke: mock(async () => ({ data: null, error: { message: "down" } })) },
      from: () => makeChain(),
    };

    await routeMessage(failSupabase, "m", "t", "u");   // failure 1
    await dispatchAgent(failSupabase, "g", "u", "t", "m"); // failure 2

    expect(breakers.edgeFn.getState().failures).toBe(2);
  });

  test("breaker opens after 3 failures regardless of which function caused them", async () => {
    const failSupabase: any = {
      functions: { invoke: mock(async () => ({ data: null, error: { message: "down" } })) },
      from: () => makeChain(),
    };

    await routeMessage(failSupabase, "m", "t", "u");    // failure 1
    await syncResponse(failSupabase, "s", "msg");       // failure 2
    await dispatchAgent(failSupabase, "g", "u", "t", "m"); // failure 3 → OPEN

    expect(breakers.edgeFn.getState().state).toBe("open");
  });

  test("success resets the failure count", async () => {
    const failSupabase: any = {
      functions: { invoke: mock(async () => ({ data: null, error: { message: "down" } })) },
      from: () => makeChain(),
    };
    await routeMessage(failSupabase, "m", "t", "u");
    await routeMessage(failSupabase, "m", "t", "u");
    expect(breakers.edgeFn.getState().failures).toBe(2);

    const goodRouteData = { agent_name: "general", rule_name: "default", confidence: 0.9, execution_mode: "single" };
    const goodSupabase = mockSupabase({ data: goodRouteData, error: null });
    await routeMessage(goodSupabase, "hello", "telegram", "u");
    expect(breakers.edgeFn.getState().failures).toBe(0);
    expect(breakers.edgeFn.getState().state).toBe("closed");
  });
});

// ── checkMemoryConflict ───────────────────────────────────────

describe("checkMemoryConflict — edge fn circuit breaker", () => {
  beforeEach(() => { breakers.edgeFn.reset(); });

  test("returns null when search edge fn returns error", async () => {
    const supabase: any = {
      functions: { invoke: mock(async () => ({ data: null, error: { message: "search down" } })) },
    };
    const result = await checkMemoryConflict(supabase, "test content", "fact");
    expect(result).toBeNull();
    expect(breakers.edgeFn.getState().failures).toBe(1);
  });

  test("returns match when search succeeds with same-type results", async () => {
    const searchData = [
      { id: "mem-1", content: "test fact", type: "fact", source_agent: "general", visibility: "shared", metadata: {}, similarity: 0.92 },
    ];
    const supabase: any = {
      functions: { invoke: mock(async () => ({ data: searchData, error: null })) },
    };
    const result = await checkMemoryConflict(supabase, "test fact similar", "fact");
    expect(result).not.toBeNull();
    expect(result!.similarity).toBe(0.92);
  });

  test("returns null when breaker is open (no invoke call)", async () => {
    // Open the breaker
    const failSupabase: any = {
      functions: { invoke: mock(async () => ({ data: null, error: { message: "down" } })) },
      from: () => makeChain(),
    };
    for (let i = 0; i < 3; i++) {
      await routeMessage(failSupabase, "m", "t", "u");
    }
    expect(breakers.edgeFn.getState().state).toBe("open");

    let invokeCalled = 0;
    const supabase: any = {
      functions: { invoke: mock(async () => { invokeCalled++; return { data: null, error: null }; }) },
    };
    const result = await checkMemoryConflict(supabase, "test", "fact");
    expect(result).toBeNull();
    expect(invokeCalled).toBe(0); // breaker blocked the call
  });

  test("returns null when search returns empty array", async () => {
    const supabase: any = {
      functions: { invoke: mock(async () => ({ data: [], error: null })) },
    };
    const result = await checkMemoryConflict(supabase, "test", "fact");
    expect(result).toBeNull();
  });

  test("returns null when type doesn't match any result", async () => {
    const searchData = [
      { id: "mem-1", content: "test", type: "goal", source_agent: "general", visibility: "shared", metadata: {}, similarity: 0.9 },
    ];
    const supabase: any = {
      functions: { invoke: mock(async () => ({ data: searchData, error: null })) },
    };
    const result = await checkMemoryConflict(supabase, "test", "fact"); // type=fact but data has goal
    expect(result).toBeNull();
  });
});

// ── getRelevantContext ────────────────────────────────────────

describe("getRelevantContext — edge fn circuit breaker", () => {
  beforeEach(() => { breakers.edgeFn.reset(); });

  test("returns empty string when search edge fn returns error", async () => {
    const supabase: any = {
      functions: { invoke: mock(async () => ({ data: null, error: { message: "search down" } })) },
    };
    const result = await getRelevantContext(supabase, "what did we discuss about billing?");
    expect(result).toBe("");
    expect(breakers.edgeFn.getState().failures).toBe(1);
  });

  test("returns empty string when supabase is null", async () => {
    const result = await getRelevantContext(null, "test query");
    expect(result).toBe("");
  });

  test("returns empty string when query is too short (< 10 chars)", async () => {
    const supabase: any = {
      functions: { invoke: mock(async () => ({ data: [{ role: "user", content: "hi" }], error: null })) },
    };
    const result = await getRelevantContext(supabase, "hi");
    expect(result).toBe("");
    // No invoke should be called for short queries
    expect((supabase.functions.invoke as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });

  test("returns RELEVANT PAST MESSAGES header when results found", async () => {
    const searchData = [
      { role: "user", content: "let's discuss billing", channel: "telegram", created_at: new Date().toISOString() },
    ];
    const supabase: any = {
      functions: { invoke: mock(async () => ({ data: searchData, error: null })) },
    };
    const result = await getRelevantContext(supabase, "billing question long enough");
    expect(result).toContain("RELEVANT PAST MESSAGES");
    expect(result).toContain("billing");
  });

  test("returns empty string when breaker is open", async () => {
    // Open the breaker via three failures elsewhere
    const failSupabase: any = {
      functions: { invoke: mock(async () => ({ data: null, error: { message: "down" } })) },
      from: () => makeChain(),
    };
    for (let i = 0; i < 3; i++) {
      await routeMessage(failSupabase, "msg", "telegram", "u");
    }
    expect(breakers.edgeFn.getState().state).toBe("open");

    let invokeCalled = 0;
    const supabase: any = {
      functions: { invoke: mock(async () => { invokeCalled++; return { data: [{ role: "user", content: "x" }], error: null }; }) },
    };
    const result = await getRelevantContext(supabase, "this query is long enough to pass the short guard");
    expect(result).toBe("");
    expect(invokeCalled).toBe(0); // breaker blocked it
  });
});
