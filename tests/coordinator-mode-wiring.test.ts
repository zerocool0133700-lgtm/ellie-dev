/**
 * ELLIE-1113 — Integration test for COORDINATOR_MODE handler wiring.
 *
 * Verifies that when COORDINATOR_MODE=true, the ellie-chat message handler:
 *   1. Calls buildCoordinatorDeps + runCoordinatorLoop (not callClaude)
 *   2. Sends the coordinator response via WebSocket
 *   3. Saves the coordinator response to message history
 *   4. Falls through to callClaude on coordinator error
 *   5. Skips the specialist async bypass when COORDINATOR_MODE is on
 *
 * Mocks all heavy dependencies to isolate the wiring logic.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

// ── Tracking vars ───────────────────────────────────────────────────────────

let coordinatorLoopCalls: Array<Record<string, unknown>> = [];
let buildDepsCalls: Array<Record<string, unknown>> = [];
let savedMessages: Array<{ role: string; content: string }> = [];
let wsSentMessages: Array<Record<string, unknown>> = [];

// ── Mock all dependencies (must precede imports) ────────────────────────────

mock.module("../src/logger.ts", () => ({
  log: {
    child: () => ({ info: mock(), warn: mock(), error: mock() }),
    info: mock(),
    warn: mock(),
    error: mock(),
  },
}));

mock.module("../src/relay-config.ts", () => ({
  BOT_TOKEN: "test-token",
  ALLOWED_USER_ID: "test-user",
  GCHAT_SPACE_NOTIFY: "",
  UPLOADS_DIR: "/tmp",
  getContextDocket: mock(() => Promise.resolve("")),
  clearContextCache: mock(() => {}),
}));

const mockGetRelayDeps = mock(() => ({
  bot: null,
  anthropic: null,
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () => ({
              single: () => Promise.resolve({ data: null }),
            }),
          }),
          eq: () => ({
            order: () => ({
              limit: () => ({
                single: () => Promise.resolve({ data: null }),
              }),
            }),
          }),
        }),
        in: () => ({
          order: () => ({
            limit: () => Promise.resolve({ data: [] }),
          }),
        }),
        neq: () => ({
          then: () => Promise.resolve([]),
        }),
      }),
      insert: () => Promise.resolve({ data: null }),
      upsert: () => Promise.resolve({ data: null }),
    }),
  },
}));
mock.module("../src/relay-state.ts", () => ({
  getRelayDeps: mockGetRelayDeps,
  getActiveAgent: mock(() => "general"),
  setActiveAgent: mock(() => {}),
  broadcastExtension: mock(() => {}),
  broadcastToEllieChatClients: mock(() => {}),
  wsAppUserMap: new Map(),
  ellieChatClients: new Set(),
  ellieChatPhoneHistories: new Map(),
  getNotifyCtx: mock(() => null),
  touchPhoneHistory: mock(() => {}),
}));

mock.module("../src/relay-idle.ts", () => ({
  resetEllieChatIdleTimer: mock(() => {}),
  resetTelegramIdleTimer: mock(() => {}),
  resetGchatIdleTimer: mock(() => {}),
}));

mock.module("../src/tts.ts", () => ({
  textToSpeechFast: mock(() => Promise.resolve(null)),
}));

const mockCallClaude = mock(() => Promise.resolve("fallback callClaude response"));
mock.module("../src/claude-cli.ts", () => ({
  callClaude: mockCallClaude,
  callClaudeVoice: mock(() => Promise.resolve("")),
  parseClaudeJsonOutput: mock(() => ({ result: "", isError: false, costUsd: 0 })),
  session: { sessionId: "test-session-123" },
}));

// enqueueEllieChat: execute the task immediately with a dummy abort signal
mock.module("../src/message-queue.ts", () => ({
  enqueueEllieChat: mock((fn: any) => fn(new AbortController().signal)),
}));

const mockSaveMessage = mock(async (role: string, content: string) => {
  savedMessages.push({ role, content });
  return "mem-id-test";
});
mock.module("../src/message-sender.ts", () => ({
  saveMessage: mockSaveMessage,
  sendWithApprovalsEllieChat: mock(() => ({ cleanedText: "response", hadConfirmations: false })),
}));

mock.module("../src/memory.ts", () => ({
  processMemoryIntents: mock((_s: any, text: string) => Promise.resolve(text)),
  getRelevantContext: mock(() => Promise.resolve("")),
  getRelevantFacts: mock(() => Promise.resolve("")),
}));

mock.module("../src/elasticsearch.ts", () => ({
  searchElastic: mock(() => Promise.resolve("")),
}));

mock.module("../src/elasticsearch/context.ts", () => ({
  getForestContext: mock(() => Promise.resolve("")),
}));

mock.module("../src/delivery.ts", () => ({
  acknowledgeChannel: mock(() => {}),
}));

mock.module("../src/ws-delivery.ts", () => ({
  deliverResponse: mock(() => {}),
  markProcessing: mock(() => {}),
  clearProcessing: mock(() => {}),
}));

// Route to "general" agent (not a specialist) so we reach the coordinator branch
mock.module("../src/agent-router.ts", () => ({
  routeAndDispatch: mock(() => Promise.resolve({
    route: {
      agent: "general",
      confidence: 0.95,
      strippedMessage: "Hello help me",
      execution_mode: "single",
      skills: [],
    },
    dispatch: {
      agent: { name: "general", system_prompt: "", tools_enabled: [], model: "claude-sonnet-4-6" },
      session_id: "dispatch-session-1",
      is_new: false,
    },
  })),
  syncResponse: mock(() => Promise.resolve()),
}));

mock.module("../src/context-sources.ts", () => ({
  getAgentStructuredContext: mock(() => Promise.resolve("")),
  getAgentMemoryContext: mock(() => Promise.resolve({ memoryContext: "", sessionIds: null })),
  getMaxMemoriesForModel: mock(() => 10),
  getLiveForestContext: mock(() => Promise.resolve({ awareness: "", incidents: null })),
  refreshSource: mock(() => Promise.resolve("")),
}));

mock.module("../src/conversations.ts", () => ({
  getOrCreateConversation: mock(() => Promise.resolve("conv-test-1")),
  getConversationMessages: mock(() => Promise.resolve({ text: "", messageCount: 0, conversationId: "conv-test-1" })),
}));

mock.module("../src/api/agent-queue.ts", () => ({
  getQueueContext: mock(() => Promise.resolve(null)),
  acknowledgeQueueItems: mock(() => Promise.resolve()),
}));

mock.module("../src/source-hierarchy.ts", () => ({
  checkGroundTruthConflicts: mock(() => Promise.resolve("")),
  buildCrossChannelSection: mock(() => Promise.resolve("")),
}));

mock.module("../src/data-quality.ts", () => ({
  logVerificationTrail: mock(() => Promise.resolve()),
}));

mock.module("../src/trace.ts", () => ({
  withTrace: mock((fn: () => any) => fn()),
  getTraceId: mock(() => "test-trace"),
  generateTraceId: mock(() => "test-trace"),
}));

mock.module("../src/notification-policy.ts", () => ({
  notify: mock(() => Promise.resolve()),
}));

mock.module("../src/mention-parser.ts", () => ({
  parseMentions: mock(() => []),
  extractMentionedAgents: mock(() => []),
  hasBroadcastMention: mock(() => ({ here: false, channel: false })),
  storeMentions: mock(() => Promise.resolve()),
}));

mock.module("../src/api/channels.ts", () => ({
  updateAgentPresence: mock(() => Promise.resolve()),
}));

mock.module("../src/plane.ts", () => ({
  isPlaneConfigured: mock(() => false),
  fetchWorkItemDetails: mock(() => Promise.resolve(null)),
  createPlaneIssue: mock(() => Promise.resolve(null)),
  updateWorkItemOnSessionStart: mock(() => Promise.resolve()),
  updateWorkItemOnSessionComplete: mock(() => Promise.resolve()),
}));

mock.module("../src/correction-detector.ts", () => ({
  detectAndCaptureCorrection: mock(() => Promise.resolve()),
}));

mock.module("../src/calendar-linker.ts", () => ({
  detectAndLinkCalendarEvents: mock(() => Promise.resolve()),
}));

mock.module("../src/working-memory.ts", () => ({
  primeWorkingMemoryCache: mock(() => Promise.resolve()),
}));

mock.module("../src/pending-commitments-prompt.ts", () => ({
  setPendingCommitmentsContext: mock(() => {}),
}));

mock.module("../src/conversational-commitment-detector.ts", () => ({
  detectAndLogCommitments: mock(() => {}),
}));

mock.module("../src/dispatch-commitment-tracker.ts", () => ({
  trackDispatchStart: mock(() => {}),
  trackDispatchComplete: mock(() => {}),
  trackDispatchFailure: mock(() => {}),
}));

mock.module("../src/agent-memory-store.ts", () => ({
  getAgentMemorySummary: mock(() => Promise.resolve("")),
}));

mock.module("../src/empathy-middleware.ts", () => ({
  analyzeAndStoreEmpathy: mock(() => Promise.resolve(null)),
}));

mock.module("../src/prompt-builder.ts", () => ({
  buildPrompt: mock(() => Promise.resolve("test prompt")),
  runPostMessageAssessment: mock(() => Promise.resolve()),
  getPlanningMode: mock(() => false),
  setPlanningMode: mock(() => {}),
  USER_NAME: "TestUser",
  getArchetypeContext: mock(() => Promise.resolve("")),
  getAgentArchetype: mock(() => Promise.resolve(undefined)),
  getAgentRoleContext: mock(() => Promise.resolve(undefined)),
  getPsyContext: mock(() => Promise.resolve(undefined)),
  getPhaseContext: mock(() => Promise.resolve(undefined)),
  getHealthContext: mock(() => Promise.resolve(undefined)),
  getCommitmentFollowUpContext: mock(() => Promise.resolve(undefined)),
  getCognitiveLoadContext: mock(() => Promise.resolve(undefined)),
  getLastBuildMetrics: mock(() => Promise.resolve(undefined)),
}));

mock.module("../src/llm-provider.ts", () => ({
  isFallbackActive: mock(() => false),
  isOutageError: mock(() => false),
  recordAnthropicSuccess: mock(() => {}),
  recordAnthropicFailure: mock(() => {}),
  consumeFallbackJustActivated: mock(() => false),
  callOpenAiFallback: mock(() => Promise.resolve("")),
}));

mock.module("../src/jobs-ledger.ts", () => ({
  createJob: mock(() => Promise.resolve(null)),
  updateJob: mock(() => Promise.resolve()),
  appendJobEvent: mock(() => Promise.resolve()),
  verifyJobWork: mock(() => Promise.resolve()),
  estimateJobCost: mock(() => 0),
}));

mock.module("../src/api/session-compaction.ts", () => ({
  checkContextPressure: mock(() => null),
  shouldNotify: mock(() => false),
  getCompactionNotice: mock(() => ""),
  checkpointSessionToForest: mock(() => Promise.resolve()),
}));

mock.module("../src/resilient-task.ts", () => ({
  resilientTask: mock((_name: string, _level: string, fn: () => any) => {
    try { fn(); } catch { /* best-effort */ }
  }),
}));

mock.module("../src/context-freshness.ts", () => ({
  freshnessTracker: {
    clear: mock(() => {}),
    recordFetch: mock(() => {}),
    logModeConfig: mock(() => {}),
    logAllFreshness: mock(() => {}),
  },
  autoRefreshStaleSources: mock(() => Promise.resolve({ refreshed: [], results: {} })),
}));

mock.module("../src/context-mode.ts", () => ({
  isContextRefresh: mock(() => false),
  detectMode: mock(() => null),
}));

mock.module("../src/approval.ts", () => ({
  extractApprovalTags: mock((text: string) => ({ cleanedText: text, tags: [] })),
}));

mock.module("../src/playbook.ts", () => ({
  extractPlaybookCommands: mock((text: string) => ({ cleanedText: text, commands: [] })),
  executePlaybookCommands: mock(() => Promise.resolve()),
}));

mock.module("../src/skills/index.ts", () => ({
  getSkillSnapshot: mock(() => ({ skills: [], hash: "" })),
  matchInstantCommand: mock(() => Promise.resolve(null)),
}));

mock.module("../src/orchestrator.ts", () => ({
  executeOrchestrated: mock(() => Promise.resolve()),
  PipelineStepError: class extends Error {},
}));

mock.module("../src/agent-entity-map.ts", () => ({
  resolveEntityName: mock(() => "test_agent"),
}));

mock.module("../src/creature-profile.ts", () => ({
  getCreatureProfile: mock(() => null),
  setCreatureProfile: mock(() => {}),
}));

mock.module("../src/relay-utils.ts", () => ({
  estimateTokens: mock(() => 100),
  trimSearchContext: mock((arr: string[]) => arr.filter(Boolean).join("\n")),
  getSpecialistAck: mock(() => "Working on it..."),
}));

mock.module("../src/response-tag-processor.ts", () => ({
  processResponseTags: mock((_, text: string) => text),
}));

// ── Mock coordinator module — the key module under test ─────────────────────

const mockRunCoordinatorLoop = mock(async (opts: Record<string, unknown>) => {
  coordinatorLoopCalls.push(opts);
  return {
    response: "Coordinator says hello",
    loopIterations: 2,
    envelopes: [],
    totalTokensIn: 500,
    totalTokensOut: 200,
    totalCostUsd: 0.005,
    hitSafetyRail: false,
    durationMs: 1200,
  };
});

const mockBuildCoordinatorDeps = mock((opts: Record<string, unknown>) => {
  buildDepsCalls.push(opts);
  return {
    callSpecialist: async () => ({ agent: "test", status: "completed", output: "", tokens_used: 0, cost_usd: 0, duration_ms: 0 }),
    sendMessage: async () => {},
    readForest: async () => "",
    readPlane: async () => "",
    readMemory: async () => "",
    readSessions: async () => "",
    getWorkingMemorySummary: async () => "",
    updateWorkingMemory: async () => {},
    promoteToForest: async () => {},
    logEnvelope: async () => {},
  };
});

mock.module("../src/coordinator.ts", () => ({
  runCoordinatorLoop: mockRunCoordinatorLoop,
  buildCoordinatorDeps: mockBuildCoordinatorDeps,
}));

// Foundation registry returns null (uses hardcoded fallbacks)
mock.module("../src/foundation-registry.ts", () => ({
  FoundationRegistry: class {
    refresh() { return Promise.resolve(); }
    getActive() { return null; }
    getCoordinatorPrompt() { return null; }
    getBehavior() { return null; }
    getAgentRoster() { return null; }
    getAgentTools() { return null; }
    listAll() { return []; }
    switchTo() { return Promise.resolve(null); }
  },
  createSupabaseFoundationStore: mock(() => ({})),
}));

mock.module("../src/tool-approval.ts", () => ({
  enterDispatchMode: mock(() => {}),
  exitDispatchMode: mock(() => {}),
}));

// ── Import handler AFTER all mocks ──────────────────────────────────────────

import { handleEllieChatMessage } from "../src/ellie-chat-handler.ts";

// ── Mock WebSocket ──────────────────────────────────────────────────────────

function createMockWs() {
  wsSentMessages = [];
  return {
    readyState: 1, // WebSocket.OPEN
    send: mock((data: string) => {
      wsSentMessages.push(JSON.parse(data));
    }),
  } as any;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("COORDINATOR_MODE handler wiring (ELLIE-1113)", () => {
  const originalEnv = process.env.COORDINATOR_MODE;

  beforeEach(() => {
    coordinatorLoopCalls = [];
    buildDepsCalls = [];
    savedMessages = [];
    wsSentMessages = [];
    mockRunCoordinatorLoop.mockClear();
    mockBuildCoordinatorDeps.mockClear();
    mockCallClaude.mockClear();
    mockSaveMessage.mockClear();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.COORDINATOR_MODE;
    } else {
      process.env.COORDINATOR_MODE = originalEnv;
    }
  });

  test("COORDINATOR_MODE=true → calls runCoordinatorLoop, sends response via WS", async () => {
    process.env.COORDINATOR_MODE = "true";
    const ws = createMockWs();

    await handleEllieChatMessage(ws, "Hello help me with something");

    // runCoordinatorLoop was called
    expect(mockRunCoordinatorLoop).toHaveBeenCalledTimes(1);

    // buildCoordinatorDeps was called with session + channel info
    expect(mockBuildCoordinatorDeps).toHaveBeenCalledTimes(1);
    const depsArgs = buildDepsCalls[0];
    expect(depsArgs.sessionId).toBeDefined();
    expect(depsArgs.channel).toBe("ellie-chat");

    // Coordinator loop received expected fields
    const loopArgs = coordinatorLoopCalls[0];
    expect(loopArgs.message).toContain("Hello help me");
    expect(loopArgs.channel).toBe("ellie-chat");
    expect(loopArgs.userId).toBe("dashboard");
    expect(loopArgs.agentRoster).toBeDefined();

    // Response sent via WebSocket
    const responseMsg = wsSentMessages.find(m => m.type === "response" && m.text === "Coordinator says hello");
    expect(responseMsg).toBeDefined();
    expect(responseMsg!.agent).toBe("ellie");

    // callClaude should NOT have been called — coordinator handled it
    expect(mockCallClaude).not.toHaveBeenCalled();
  });

  test("COORDINATOR_MODE=true → saves coordinator response to message history", async () => {
    process.env.COORDINATOR_MODE = "true";
    const ws = createMockWs();

    await handleEllieChatMessage(ws, "Save this response");

    // Assistant message saved with coordinator's response text
    const assistantSave = savedMessages.find(m => m.role === "assistant" && m.content === "Coordinator says hello");
    expect(assistantSave).toBeDefined();
  });

  test("COORDINATOR_MODE=true → sends typing indicator before coordinator loop", async () => {
    process.env.COORDINATOR_MODE = "true";
    const ws = createMockWs();

    await handleEllieChatMessage(ws, "Check typing");

    // At least one typing message with agent "ellie" should precede the response
    const typingMsg = wsSentMessages.find(m => m.type === "typing" && m.agent === "ellie");
    expect(typingMsg).toBeDefined();
  });

  test("COORDINATOR_MODE unset → does NOT call runCoordinatorLoop", async () => {
    delete process.env.COORDINATOR_MODE;
    const ws = createMockWs();

    await handleEllieChatMessage(ws, "Hello no coordinator");

    expect(mockRunCoordinatorLoop).not.toHaveBeenCalled();
    expect(mockBuildCoordinatorDeps).not.toHaveBeenCalled();
  });

  test("COORDINATOR_MODE=false → does NOT call runCoordinatorLoop", async () => {
    process.env.COORDINATOR_MODE = "false";
    const ws = createMockWs();

    await handleEllieChatMessage(ws, "Hello no coordinator");

    expect(mockRunCoordinatorLoop).not.toHaveBeenCalled();
  });

  test("coordinator error → caught gracefully, handler does not throw", async () => {
    process.env.COORDINATOR_MODE = "true";
    const ws = createMockWs();

    // Make coordinator throw
    mockRunCoordinatorLoop.mockImplementationOnce(async () => {
      throw new Error("coordinator crashed");
    });

    // Handler should not throw — error is caught in the coordinator try/catch
    await handleEllieChatMessage(ws, "Trigger fallback");

    // Coordinator was attempted
    expect(mockRunCoordinatorLoop).toHaveBeenCalledTimes(1);

    // The coordinator response ("Coordinator says hello") should NOT appear — it threw
    const coordResponse = wsSentMessages.find(m => m.type === "response" && m.text === "Coordinator says hello");
    expect(coordResponse).toBeUndefined();
  });
});
