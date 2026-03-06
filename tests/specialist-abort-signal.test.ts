/**
 * Regression tests for ELLIE-482 queueSignal wiring in runSpecialistAsync.
 *
 * Bug: ELLIE-482 added queueSignal references inside runSpecialistAsync but
 * forgot to add it as a parameter, causing "queueSignal is not defined"
 * ReferenceError for every specialist dispatch (finance, research, etc.).
 *
 * Fix: Added `queueSignal?: AbortSignal` parameter + pass it at call site.
 *
 * Tests:
 *   1. Pre-aborted signal → callClaude is called, then early return fires,
 *      processMemoryIntents NOT called (idempotency check works).
 *   2. No signal (undefined) → full happy path completes without error.
 *   3. Regression guard — no ReferenceError thrown in either case.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

// ── Mocks — must precede imports ──────────────────────────────────────────────

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: mock(), warn: mock(), error: mock() }) },
}));

mock.module("../src/relay-config.ts", () => ({
  BOT_TOKEN: "test", ALLOWED_USER_ID: "test-user", GCHAT_SPACE_NOTIFY: "",
  UPLOADS_DIR: "/tmp",
  getContextDocket: mock(() => Promise.resolve("")),
  clearContextCache: mock(() => {}),
}));

const mockGetRelayDeps = mock(() => ({ bot: null, anthropic: null }));
const mockGetActiveAgent = mock(() => "general");
const mockBroadcastExtension = mock(() => {});
mock.module("../src/relay-state.ts", () => ({
  getRelayDeps: mockGetRelayDeps,
  getActiveAgent: mockGetActiveAgent,
  broadcastExtension: mockBroadcastExtension,
  wsAppUserMap: new Map(),
  ellieChatClients: new Set(),
  ellieChatPhoneHistories: new Map(),
  getNotifyCtx: mock(() => null),
  touchPhoneHistory: mock(() => {}),
  setActiveAgent: mock(() => {}),
}));

mock.module("../src/relay-idle.ts", () => ({
  resetEllieChatIdleTimer: mock(() => {}),
  resetTelegramIdleTimer: mock(() => {}),
  resetGchatIdleTimer: mock(() => {}),
}));

// agent-entity-map.ts is NOT mocked — pure lookup, not called from runSpecialistAsync.
// prompt-builder.ts is NOT mocked — reads files; prompt-builder.test.ts tests real impl.

mock.module("../src/tts.ts", () => ({
  textToSpeechFast: mock(() => Promise.resolve(null)),
}));

const mockCallClaude = mock(() => Promise.resolve("specialist response"));
mock.module("../src/claude-cli.ts", () => ({
  callClaude: mockCallClaude,
  callClaudeVoice: mock(() => Promise.resolve("")),
  session: { sessionId: "test-session" },
}));

mock.module("../src/message-queue.ts", () => ({
  enqueueEllieChat: mock((fn: any) => fn(new AbortController().signal)),
}));

const mockProcessMemoryIntents = mock((_supabase: any, text: string) => Promise.resolve(text));
mock.module("../src/memory.ts", () => ({
  processMemoryIntents: mockProcessMemoryIntents,
  getRelevantContext: mock(() => Promise.resolve("")),
}));

const mockSaveMessage = mock(() => Promise.resolve("mem-id-1"));
const mockSendWithApprovals = mock(() => ({ cleanedText: "specialist response", hadConfirmations: false }));
mock.module("../src/message-sender.ts", () => ({
  saveMessage: mockSaveMessage,
  sendWithApprovalsEllieChat: mockSendWithApprovals,
}));

// approval.ts is NOT mocked — extractApprovalTags is pure string parsing.

mock.module("../src/elasticsearch.ts", () => ({
  searchElastic: mock(() => Promise.resolve("")),
}));

// ws-delivery.ts is NOT mocked — drainMemoryBuffer has stateful behavior tested in
// ws-delivery-dedup.test.ts; real deliverResponse calls ws.send, which we assert on via mockWs.

// tool-approval.ts is NOT mocked — enterDispatchMode/exitDispatchMode are pure counter ops.

mock.module("../src/elasticsearch/context.ts", () => ({
  getForestContext: mock(() => Promise.resolve("")),
}));

mock.module("../src/delivery.ts", () => ({
  acknowledgeChannel: mock(() => {}),
}));

mock.module("../src/agent-router.ts", () => ({
  routeAndDispatch: mock(() => Promise.resolve(null)),
  syncResponse: mock(() => Promise.resolve()),
}));

// skills/index.ts is NOT mocked — getSkillSnapshot reads YAML files; safe in dev env.
// relay-utils.ts is NOT mocked — estimateTokens is only called inside if(jobId), which is
// null (createJob→null from jobs-ledger mock), so tiktoken WASM is never loaded.

mock.module("../src/context-sources.ts", () => ({
  getAgentStructuredContext: mock(() => Promise.resolve("")),
  getAgentMemoryContext: mock(() => Promise.resolve({ memoryContext: "", sessionIds: null })),
  getMaxMemoriesForModel: mock(() => 10),
  getLiveForestContext: mock(() => Promise.resolve({ awareness: "", incidents: null })),
  refreshSource: mock(() => Promise.resolve("")),
}));

// orchestrator.ts is NOT mocked — executeOrchestrated is not called from runSpecialistAsync.

// plane.ts is NOT mocked — isPlaneConfigured() is guarded by workItemId2 (extractWorkItemId
// returns null for "research something"), so the real impl is never called in these tests.

// playbook.ts is NOT mocked — extractPlaybookCommands is pure string parsing.
// notification-policy.ts is NOT mocked — notify() is not called from runSpecialistAsync.

mock.module("../src/conversations.ts", () => ({
  getOrCreateConversation: mock(() => Promise.resolve("conv-test-1")),
  getConversationMessages: mock(() => Promise.resolve({ text: "", messageCount: 0, conversationId: "conv-test-1" })),
}));

mock.module("../src/api/agent-queue.ts", () => ({
  getQueueContext: mock(() => Promise.resolve(null)),
  acknowledgeQueueItems: mock(() => Promise.resolve()),
}));

// correction-detector.ts is NOT mocked — not called from runSpecialistAsync.
// calendar-linker.ts is NOT mocked — not called from runSpecialistAsync.

// context-mode.ts is NOT mocked — pipeline test uses real processMessageMode.
// context-freshness.ts is NOT mocked — not used by runSpecialistAsync.

mock.module("../src/source-hierarchy.ts", () => ({
  checkGroundTruthConflicts: mock(() => Promise.resolve(null)),
  buildCrossChannelSection: mock(() => Promise.resolve(null)),
}));

mock.module("../src/data-quality.ts", () => ({
  logVerificationTrail: mock(() => {}),
}));

// creature-profile.ts is NOT mocked — pipeline test uses real setCreatureProfile/getCreatureProfile.

mock.module("../src/trace.ts", () => ({
  withTrace: mock((fn: () => any) => fn()),
  getTraceId: mock(() => "test-trace"),
  generateTraceId: mock(() => "test-trace"),
}));

// jobs-ledger.ts is NOT mocked — real createJob writes to Forest DB (acceptable test artifact).
// estimateTokens from relay-utils is safe to call (tiktoken loads in ~500ms, doesn't hang).
// verifyJobWork runs git-status (fast); writeJobTouchpointForAgent not called from runSpecialistAsync.

// api/session-compaction.ts is NOT mocked — checkContextPressure is a pure function that
// returns null for a short test prompt; no DB writes triggered in test conditions.

// resilient-task.ts is NOT mocked — resilientTask() calls inside runSpecialistAsync
// are guarded by conditions that are all false in these tests (is_new=false, specQueueContext=null,
// contextPressure=null, playCmds=[]).

mock.module("../src/llm-provider.ts", () => ({
  isFallbackActive: mock(() => false),
  isOutageError: mock(() => false),
  recordAnthropicSuccess: mock(() => {}),
  recordAnthropicFailure: mock(() => {}),
  consumeFallbackJustActivated: mock(() => false),
  callOpenAiFallback: mock(() => Promise.resolve("")),
}));

// ellie-chat-pipeline.ts is NOT mocked — use the real functions with their
// transitive deps already mocked above (conversations, memory, elasticsearch, etc.).
// Mocking it would contaminate ellie-chat-pipeline.test.ts (same bun process).

// ellie-chat-utils.ts is NOT mocked — pure functions, no side effects,
// and other test files (ellie-chat-handler.test.ts) test the real exports.

// ── Imports ───────────────────────────────────────────────────────────────────

import { runSpecialistAsync } from "../src/ellie-chat-handler.ts";
import { exitDispatchMode } from "../src/tool-approval.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const mockWs = {
  readyState: 1, // WebSocket.OPEN
  send: mock(() => {}),
} as any;

function makeAgentResult() {
  return {
    route: { skill_name: "code_analysis" },
    dispatch: {
      agent: {
        name: "research",
        tools_enabled: [],
        model: "claude-haiku-4-5-20251001",
        system_prompt: "You are a research specialist.",
      },
      skill_context: "",
      is_new: false,
      session_id: "session-test-1",
    },
  } as any;
}

beforeEach(() => {
  mockCallClaude.mockClear();
  mockCallClaude.mockImplementation(() => Promise.resolve("specialist response"));
  mockProcessMemoryIntents.mockClear();
  mockProcessMemoryIntents.mockImplementation((_s: any, text: string) => Promise.resolve(text));
  mockSaveMessage.mockClear();
  mockSaveMessage.mockImplementation(() => Promise.resolve("mem-id-1"));
  mockSendWithApprovals.mockClear();
  mockSendWithApprovals.mockImplementation(() => ({ cleanedText: "specialist response", hadConfirmations: false }));
  (mockWs.send as ReturnType<typeof mock>).mockClear();
});

// test 4 (pre-aborted) does early return before exitDispatchMode, leaving _activeDispatches > 0.
// Reset after each test so tool-approval.test.ts sees a clean counter when it runs later.
afterEach(() => { exitDispatchMode(); });

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runSpecialistAsync — queueSignal (ELLIE-482 regression)", () => {
  test("no ReferenceError when called without queueSignal (undefined)", async () => {
    // Before the fix, this threw: ReferenceError: queueSignal is not defined
    await expect(
      runSpecialistAsync(mockWs, null, "research something", "research something", makeAgentResult(), undefined, undefined)
    ).resolves.toBeUndefined();
  });

  test("callClaude is called with correct abortSignal when queueSignal provided", async () => {
    const ctrl = new AbortController();
    await runSpecialistAsync(
      mockWs, null, "research something", "research something",
      makeAgentResult(), undefined, undefined,
      undefined, undefined, ctrl.signal,
    );
    expect(mockCallClaude).toHaveBeenCalledTimes(1);
    const opts = mockCallClaude.mock.calls[0]?.[1] as any;
    expect(opts.abortSignal).toBe(ctrl.signal);
  });

  test("callClaude abortSignal is undefined when no queueSignal", async () => {
    await runSpecialistAsync(
      mockWs, null, "research something", "research something",
      makeAgentResult(), undefined, undefined,
    );
    expect(mockCallClaude).toHaveBeenCalledTimes(1);
    const opts = mockCallClaude.mock.calls[0]?.[1] as any;
    expect(opts.abortSignal).toBeUndefined();
  });

  test("pre-aborted queueSignal → early return, processMemoryIntents NOT called", async () => {
    const ctrl = new AbortController();
    ctrl.abort(); // pre-abort before calling

    await runSpecialistAsync(
      mockWs, null, "research something", "research something",
      makeAgentResult(), undefined, undefined,
      undefined, undefined, ctrl.signal,
    );

    // callClaude was called (specialist started work)
    expect(mockCallClaude).toHaveBeenCalledTimes(1);
    // but the idempotency check fired → returned early
    expect(mockProcessMemoryIntents).not.toHaveBeenCalled();
    // and no response was delivered via WS (ws.send not called with "type":"response")
    const sendCalls = (mockWs.send as ReturnType<typeof mock>).mock.calls;
    expect(sendCalls.every((c: any[]) => !String(c[0]).includes('"type":"response"'))).toBe(true);
  });

  test("non-aborted queueSignal → full happy path, processMemoryIntents IS called", async () => {
    const ctrl = new AbortController();
    // signal is NOT aborted

    await runSpecialistAsync(
      mockWs, null, "research something", "research something",
      makeAgentResult(), undefined, undefined,
      undefined, undefined, ctrl.signal,
    );

    expect(mockCallClaude).toHaveBeenCalledTimes(1);
    expect(mockProcessMemoryIntents).toHaveBeenCalledTimes(1);
    // response was delivered: ws.send was called with "type":"response"
    const sendCalls = (mockWs.send as ReturnType<typeof mock>).mock.calls;
    expect(sendCalls.some((c: any[]) => String(c[0]).includes('"type":"response"'))).toBe(true);
  });
});
