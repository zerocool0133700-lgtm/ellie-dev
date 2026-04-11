# Ask User Question MCP Tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give dispatched agents a structured way to ask the user questions via an MCP tool, replacing unreliable LLM-based question detection.

**Architecture:** A lightweight MCP server (`mcp-ask-user.ts`) exposes an `ask_user_question` tool. When called, it POSTs to a new relay endpoint (`/api/ask-user/question`) which long-polls until the user answers. The relay sends the question to the user (Telegram/Google Chat/WebSocket) with agent attribution, then routes the user's reply back to the blocking MCP call. The dispatched agent receives the answer and continues working.

**Tech Stack:** `@modelcontextprotocol/sdk`, Bun, existing relay HTTP server, existing notification infrastructure

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/ask-user-queue.ts` (create) | In-memory question queue: enqueue, wait-for-answer, answer, list pending |
| `src/api/routes/ask-user.ts` (create) | HTTP endpoints: `POST /api/ask-user/question`, `POST /api/ask-user/answer/:id`, `GET /api/ask-user/pending` |
| `mcp-ask-user.ts` (create) | MCP server with `ask_user_question` tool — thin proxy to relay API |
| `.mcp.json` (modify) | Register the new MCP server |
| `src/claude-cli.ts` (modify:31) | Add `mcp__ask-user__*` to MCP_TOOLS |
| `src/http-routes.ts` (modify) | Wire ask-user routes into the HTTP handler |
| `src/ellie-chat-handler.ts` (modify) | Route user replies to pending agent questions |
| `tests/ask-user-mcp.test.ts` (create) | Tests for the question queue and HTTP endpoints |

---

### Task 1: Question Queue Module

**Files:**
- Create: `src/ask-user-queue.ts`
- Test: `tests/ask-user-mcp.test.ts`

- [ ] **Step 1: Write the failing tests for the question queue**

```typescript
// tests/ask-user-mcp.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import {
  enqueueQuestion,
  answerQuestion,
  getPendingQuestions,
  clearQuestionQueue,
  QUESTION_TIMEOUT_MS,
} from "../src/ask-user-queue";

describe("ELLIE-1267: ask-user question queue", () => {
  beforeEach(() => {
    clearQuestionQueue();
  });

  test("enqueueQuestion returns a question ID and stores the question", () => {
    const id = enqueueQuestion("james", "What framework should I use?");
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");

    const pending = getPendingQuestions();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(id);
    expect(pending[0].agentName).toBe("james");
    expect(pending[0].question).toBe("What framework should I use?");
    expect(pending[0].status).toBe("pending");
  });

  test("answerQuestion resolves the waiting promise", async () => {
    const id = enqueueQuestion("kate", "Which API?");

    // Start waiting (don't await yet)
    const waitPromise = getPendingQuestions().find(q => q.id === id)!.promise;

    // Answer it
    const answered = answerQuestion(id, "Use the REST API");
    expect(answered).toBe(true);

    const result = await waitPromise;
    expect(result).toBe("Use the REST API");
  });

  test("answerQuestion returns false for unknown question ID", () => {
    expect(answerQuestion("nonexistent", "answer")).toBe(false);
  });

  test("answering removes the question from pending list", () => {
    const id = enqueueQuestion("james", "Question?");
    expect(getPendingQuestions()).toHaveLength(1);

    answerQuestion(id, "Answer");
    expect(getPendingQuestions()).toHaveLength(0);
  });

  test("multiple questions are tracked independently", () => {
    const id1 = enqueueQuestion("james", "Q1");
    const id2 = enqueueQuestion("kate", "Q2");
    expect(getPendingQuestions()).toHaveLength(2);

    answerQuestion(id1, "A1");
    expect(getPendingQuestions()).toHaveLength(1);
    expect(getPendingQuestions()[0].id).toBe(id2);
  });

  test("clearQuestionQueue removes all pending questions", () => {
    enqueueQuestion("james", "Q1");
    enqueueQuestion("kate", "Q2");
    clearQuestionQueue();
    expect(getPendingQuestions()).toHaveLength(0);
  });

  test("question includes optional context fields", () => {
    const id = enqueueQuestion("brian", "Is this pattern correct?", {
      workItemId: "ELLIE-500",
      urgency: "high",
      options: ["Yes", "No", "Needs refactor"],
    });
    const q = getPendingQuestions().find(q => q.id === id)!;
    expect(q.workItemId).toBe("ELLIE-500");
    expect(q.urgency).toBe("high");
    expect(q.options).toEqual(["Yes", "No", "Needs refactor"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/ask-user-mcp.test.ts`
Expected: FAIL — module `../src/ask-user-queue` not found

- [ ] **Step 3: Implement the question queue**

```typescript
// src/ask-user-queue.ts
/**
 * Ask-User Question Queue — ELLIE-1267
 *
 * In-memory queue for dispatched agents to ask the user questions.
 * An MCP tool enqueues a question and blocks; the relay answers it
 * when the user replies.
 */

import { log } from "./logger.ts";

const logger = log.child("ask-user-queue");

export const QUESTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface PendingQuestion {
  id: string;
  agentName: string;
  question: string;
  status: "pending" | "answered" | "timed_out";
  options?: string[];
  urgency?: "low" | "normal" | "high";
  workItemId?: string;
  enqueuedAt: number;
  promise: Promise<string>;
}

interface QueueEntry {
  question: PendingQuestion;
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const _queue = new Map<string, QueueEntry>();

/**
 * Enqueue a question from a dispatched agent.
 * Returns the question ID. The question's `promise` field resolves when answered.
 */
export function enqueueQuestion(
  agentName: string,
  question: string,
  opts?: { workItemId?: string; urgency?: "low" | "normal" | "high"; options?: string[] },
): string {
  const id = crypto.randomUUID();
  let resolve!: (answer: string) => void;
  let reject!: (error: Error) => void;

  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const timer = setTimeout(() => {
    const entry = _queue.get(id);
    if (entry) {
      entry.question.status = "timed_out";
      _queue.delete(id);
      logger.warn("Question timed out", { id: id.slice(0, 8), agentName, question: question.slice(0, 100) });
      reject(new Error(`Question timed out after ${QUESTION_TIMEOUT_MS / 1000}s`));
    }
  }, QUESTION_TIMEOUT_MS);

  const pendingQuestion: PendingQuestion = {
    id,
    agentName,
    question,
    status: "pending",
    options: opts?.options,
    urgency: opts?.urgency,
    workItemId: opts?.workItemId,
    enqueuedAt: Date.now(),
    promise,
  };

  _queue.set(id, { question: pendingQuestion, resolve, reject, timer });

  logger.info("Question enqueued", { id: id.slice(0, 8), agentName, question: question.slice(0, 100) });

  return id;
}

/**
 * Answer a pending question. Returns true if the question was found and answered.
 */
export function answerQuestion(questionId: string, answer: string): boolean {
  const entry = _queue.get(questionId);
  if (!entry) return false;

  clearTimeout(entry.timer);
  entry.question.status = "answered";
  _queue.delete(questionId);

  logger.info("Question answered", { id: questionId.slice(0, 8), agentName: entry.question.agentName });
  entry.resolve(answer);

  return true;
}

/** Get all currently pending questions. */
export function getPendingQuestions(): PendingQuestion[] {
  return Array.from(_queue.values()).map(e => e.question);
}

/** Get a specific pending question by ID. */
export function getQuestion(questionId: string): PendingQuestion | null {
  return _queue.get(questionId)?.question ?? null;
}

/** Wait for a question to be answered. Returns the answer or throws on timeout. */
export function waitForAnswer(questionId: string): Promise<string> | null {
  const entry = _queue.get(questionId);
  return entry?.question.promise ?? null;
}

/** Clear all pending questions. For testing only. */
export function clearQuestionQueue(): void {
  for (const entry of _queue.values()) {
    clearTimeout(entry.timer);
  }
  _queue.clear();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/ask-user-mcp.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/ask-user-queue.ts tests/ask-user-mcp.test.ts
git commit -m "[ELLIE-1267] Add in-memory question queue for dispatched agent ask-user"
```

---

### Task 2: HTTP API Endpoints

**Files:**
- Create: `src/api/routes/ask-user.ts`
- Modify: `src/http-routes.ts`
- Test: `tests/ask-user-mcp.test.ts` (append)

- [ ] **Step 1: Write the failing tests for the HTTP layer**

Append to `tests/ask-user-mcp.test.ts`:

```typescript
import {
  handleAskUserRoute,
} from "../src/api/routes/ask-user";

// Minimal mock for IncomingMessage + ServerResponse
function mockReq(method: string, url: string, body?: unknown): any {
  const req: any = {
    method,
    url,
    headers: { "content-type": "application/json" },
  };
  // Simulate readable stream for body parsing
  if (body) {
    req._body = JSON.stringify(body);
  }
  return req;
}

function mockRes(): any {
  const res: any = {
    statusCode: 200,
    _headers: {} as Record<string, string>,
    _body: "",
    setHeader(k: string, v: string) { res._headers[k] = v; },
    writeHead(code: number, headers?: Record<string, string>) {
      res.statusCode = code;
      if (headers) Object.assign(res._headers, headers);
    },
    end(body?: string) { res._body = body || ""; res._ended = true; },
    _ended: false,
  };
  return res;
}

describe("ELLIE-1267: ask-user HTTP endpoints", () => {
  beforeEach(() => {
    clearQuestionQueue();
  });

  test("GET /api/ask-user/pending returns empty list initially", async () => {
    const req = mockReq("GET", "/api/ask-user/pending");
    const res = mockRes();
    const handled = await handleAskUserRoute(req, res, "/api/ask-user/pending");
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.questions).toEqual([]);
  });

  test("POST /api/ask-user/answer/:id answers a pending question", async () => {
    const id = enqueueQuestion("james", "Test question?");
    const waitPromise = waitForAnswer(id);

    const req = mockReq("POST", `/api/ask-user/answer/${id}`, { answer: "Test answer" });
    const res = mockRes();
    const handled = await handleAskUserRoute(req, res, `/api/ask-user/answer/${id}`, { readBody: async () => ({ answer: "Test answer" }) });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);

    const answer = await waitPromise;
    expect(answer).toBe("Test answer");
  });

  test("POST /api/ask-user/answer/:id returns 404 for unknown question", async () => {
    const req = mockReq("POST", "/api/ask-user/answer/nonexistent", { answer: "x" });
    const res = mockRes();
    const handled = await handleAskUserRoute(req, res, "/api/ask-user/answer/nonexistent", { readBody: async () => ({ answer: "x" }) });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/ask-user-mcp.test.ts`
Expected: FAIL — module `../src/api/routes/ask-user` not found

- [ ] **Step 3: Implement the HTTP route handler**

```typescript
// src/api/routes/ask-user.ts
/**
 * Ask-User HTTP routes — ELLIE-1267
 *
 * Endpoints for the ask-user MCP tool and answer routing.
 *
 * POST /api/ask-user/question  — MCP tool calls this; long-polls until answered
 * POST /api/ask-user/answer/:id — Answer a pending question
 * GET  /api/ask-user/pending    — List pending questions
 */

import type { IncomingMessage, ServerResponse } from "http";
import {
  enqueueQuestion,
  answerQuestion,
  getPendingQuestions,
  waitForAnswer,
  getQuestion,
} from "../ask-user-queue.ts";
import { log } from "../logger.ts";

const logger = log.child("ask-user-api");

interface RouteOpts {
  readBody?: () => Promise<Record<string, unknown>>;
  onQuestion?: (question: { id: string; agentName: string; question: string; workItemId?: string; urgency?: string; options?: string[] }) => void;
}

/**
 * Handle ask-user routes. Returns true if the route was handled.
 */
export async function handleAskUserRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  opts?: RouteOpts,
): Promise<boolean> {
  // GET /api/ask-user/pending
  if (pathname === "/api/ask-user/pending" && req.method === "GET") {
    const questions = getPendingQuestions().map(q => ({
      id: q.id,
      agentName: q.agentName,
      question: q.question,
      status: q.status,
      options: q.options,
      urgency: q.urgency,
      workItemId: q.workItemId,
      enqueuedAt: q.enqueuedAt,
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ questions }));
    return true;
  }

  // POST /api/ask-user/question — MCP tool calls this, blocks until answered
  if (pathname === "/api/ask-user/question" && req.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = opts?.readBody ? await opts.readBody() : await readJsonBody(req);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return true;
    }

    const agentName = String(body.agent_name || "unknown");
    const question = String(body.question || "");
    const workItemId = body.work_item_id ? String(body.work_item_id) : undefined;
    const urgency = body.urgency as "low" | "normal" | "high" | undefined;
    const options = Array.isArray(body.options) ? body.options.map(String) : undefined;

    if (!question) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "question is required" }));
      return true;
    }

    const id = enqueueQuestion(agentName, question, { workItemId, urgency, options });

    // Notify the relay so it can send the question to the user
    opts?.onQuestion?.({ id, agentName, question, workItemId, urgency, options });

    // Long-poll: block until answered or timed out
    const promise = waitForAnswer(id);
    if (!promise) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to create question" }));
      return true;
    }

    try {
      const answer = await promise;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ answer, question_id: id }));
    } catch (err) {
      res.writeHead(408, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Question timed out", question_id: id }));
    }
    return true;
  }

  // POST /api/ask-user/answer/:id
  const answerMatch = pathname.match(/^\/api\/ask-user\/answer\/(.+)$/);
  if (answerMatch && req.method === "POST") {
    const questionId = answerMatch[1];

    let body: Record<string, unknown>;
    try {
      body = opts?.readBody ? await opts.readBody() : await readJsonBody(req);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return true;
    }

    const answer = String(body.answer || "");
    if (!answer) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "answer is required" }));
      return true;
    }

    const answered = answerQuestion(questionId, answer);
    if (!answered) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Question not found or already answered" }));
      return true;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
    return true;
  }

  return false;
}

/** Read and parse JSON body from an IncomingMessage. */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/ask-user-mcp.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/api/routes/ask-user.ts tests/ask-user-mcp.test.ts
git commit -m "[ELLIE-1267] Add HTTP endpoints for ask-user question/answer flow"
```

---

### Task 3: MCP Server

**Files:**
- Create: `mcp-ask-user.ts`
- Modify: `.mcp.json`

- [ ] **Step 1: Create the MCP server**

```typescript
// mcp-ask-user.ts
#!/usr/bin/env bun
/**
 * Ask-User MCP Server — ELLIE-1267
 *
 * Exposes an `ask_user_question` tool to dispatched Claude Code agents.
 * When called, POSTs to the relay's /api/ask-user/question endpoint
 * which long-polls until the user answers.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const RELAY_URL = process.env.RELAY_URL || "http://localhost:3001";

const server = new McpServer({
  name: "ask-user",
  version: "1.0.0",
});

server.tool(
  "ask_user_question",
  "Ask the user a question and wait for their response. Use this when you need clarification, a decision, or approval from the user before proceeding. The question will be sent to the user via their active messaging channel (Telegram/Google Chat/dashboard) with your name attributed. You will block until the user responds or the request times out (5 minutes).",
  {
    question: z.string().describe("The question to ask the user. Be specific and concise."),
    agent_name: z.string().describe("Your agent name (e.g. 'james', 'kate', 'brian')"),
    work_item_id: z.string().optional().describe("The ELLIE-XXX ticket ID you're working on, if any"),
    urgency: z.enum(["low", "normal", "high"]).optional().describe("How urgent is this question? 'high' = blocking critical work"),
    options: z.array(z.string()).optional().describe("Optional list of suggested answers for the user to choose from"),
  },
  async ({ question, agent_name, work_item_id, urgency, options }) => {
    try {
      const res = await fetch(`${RELAY_URL}/api/ask-user/question`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, agent_name, work_item_id, urgency, options }),
      });

      if (!res.ok) {
        const text = await res.text();
        return { content: [{ type: "text" as const, text: `Error asking question: ${res.status} ${text}` }], isError: true };
      }

      const data = await res.json() as { answer?: string; error?: string; question_id?: string };

      if (data.error) {
        return { content: [{ type: "text" as const, text: `Question failed: ${data.error}` }], isError: true };
      }

      return {
        content: [{ type: "text" as const, text: data.answer || "No answer received" }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Failed to reach relay: ${msg}` }], isError: true };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 2: Register the MCP server in `.mcp.json`**

Add to the `mcpServers` object in `.mcp.json`:

```json
"ask-user": {
  "type": "stdio",
  "command": "bun",
  "args": ["/home/ellie/ellie-dev/mcp-ask-user.ts"],
  "env": {
    "RELAY_URL": "http://localhost:3001"
  }
}
```

- [ ] **Step 3: Add `mcp__ask-user__*` to MCP_TOOLS in `src/claude-cli.ts`**

In `src/claude-cli.ts` line 30, add `mcp__ask-user__*` to the MCP_TOOLS string:

```typescript
const MCP_TOOLS = "mcp__google-workspace__*,mcp__github__*,mcp__memory__*,mcp__sequential-thinking__*,mcp__plane__*,mcp__claude_ai_Miro__*,mcp__brave-search__*,mcp__excalidraw__*,mcp__forest-bridge__*,mcp__qmd__*,mcp__ask-user__*";
```

- [ ] **Step 4: Commit**

```bash
git add mcp-ask-user.ts .mcp.json src/claude-cli.ts
git commit -m "[ELLIE-1267] Add ask-user MCP server and register it for dispatched agents"
```

---

### Task 4: Wire Routes into HTTP Server + User Notification

**Files:**
- Modify: `src/http-routes.ts`
- Modify: `src/ellie-chat-handler.ts`

- [ ] **Step 1: Wire the ask-user routes into the HTTP handler**

In `src/http-routes.ts`, add the import and route delegation. Find the section where other `/api/` routes are handled (around line 1926 where `/api/orchestration/dispatch` is handled) and add:

Import at top of file:
```typescript
import { handleAskUserRoute } from "./api/routes/ask-user.ts";
import { getPendingQuestions } from "./ask-user-queue.ts";
import { notify } from "./notification-policy.ts";
```

Route delegation (add before the catch-all 404):
```typescript
  // ELLIE-1267: Ask-user question routing
  if (url.pathname.startsWith("/api/ask-user/")) {
    const handled = await handleAskUserRoute(req, res, url.pathname, {
      onQuestion: (q) => {
        // Send question to user via all active channels
        const attribution = `${q.agentName} asks`;
        const optionsText = q.options?.length ? `\nOptions: ${q.options.join(", ")}` : "";
        const message = `${attribution}: ${q.question}${optionsText}`;
        const notifyCtx = getNotifyCtx();
        notify(notifyCtx, {
          event: "ask_user",
          workItemId: q.workItemId,
          telegramMessage: message,
          gchatMessage: message,
        }).catch(() => {});
        // Also broadcast to dashboard WebSocket clients
        broadcastToEllieChatClients({
          type: "agent_question",
          questionId: q.id,
          agentName: q.agentName,
          question: q.question,
          options: q.options,
          urgency: q.urgency,
          workItemId: q.workItemId,
        });
      },
    });
    if (handled) return;
  }
```

- [ ] **Step 2: Route user replies to pending agent questions in `src/ellie-chat-handler.ts`**

In `src/ellie-chat-handler.ts`, in the `handleEllieChatMessage` function, add a check early in the message handling flow — before the coordinator/specialist dispatch — to see if there are pending agent questions. If so, route the user's reply as an answer:

Import at top:
```typescript
import { getPendingQuestions, answerQuestion } from "./ask-user-queue.ts";
```

Add this check near the top of `handleEllieChatMessage`, after the existing `shiftPendingAskUser()` check:

```typescript
    // ELLIE-1267: Check if any dispatched agents are waiting for user answers
    const pendingAgentQuestions = getPendingQuestions();
    if (pendingAgentQuestions.length > 0) {
      const oldest = pendingAgentQuestions[0];
      logger.info("[ask-user] Routing reply to agent question", {
        questionId: oldest.id.slice(0, 8),
        agentName: oldest.agentName,
        question: oldest.question.slice(0, 100),
      });
      answerQuestion(oldest.id, message);
      deliverResponse(ws, `Answer sent to ${oldest.agentName}.`, channel, messageId);
      return;
    }
```

- [ ] **Step 3: Commit**

```bash
git add src/http-routes.ts src/ellie-chat-handler.ts
git commit -m "[ELLIE-1267] Wire ask-user routes and user reply routing into relay"
```

---

### Task 5: Telegram Reply Routing

**Files:**
- Modify: `src/relay.ts` (Telegram message handler)

- [ ] **Step 1: Find and read the Telegram message handler**

Read the Telegram bot message handler in `src/relay.ts` to find where incoming messages are processed. Look for `bot.on("message"` or equivalent.

- [ ] **Step 2: Add agent question check to Telegram handler**

Add the same pattern as the ellie-chat handler — before processing the message normally, check if any dispatched agents are waiting for answers:

Import at top:
```typescript
import { getPendingQuestions, answerQuestion } from "./ask-user-queue.ts";
```

In the Telegram message handler, add before the main processing:

```typescript
    // ELLIE-1267: Route reply to pending agent question if any
    const pendingAgentQuestions = getPendingQuestions();
    if (pendingAgentQuestions.length > 0) {
      const oldest = pendingAgentQuestions[0];
      logger.info("[ask-user] Routing Telegram reply to agent question", {
        questionId: oldest.id.slice(0, 8),
        agentName: oldest.agentName,
      });
      answerQuestion(oldest.id, messageText);
      await ctx.reply(`Answer sent to ${oldest.agentName}.`);
      return;
    }
```

- [ ] **Step 3: Commit**

```bash
git add src/relay.ts
git commit -m "[ELLIE-1267] Route Telegram replies to pending agent questions"
```

---

### Task 6: Integration Test

**Files:**
- Test: `tests/ask-user-mcp.test.ts` (append)

- [ ] **Step 1: Write an end-to-end integration test**

Append to `tests/ask-user-mcp.test.ts`:

```typescript
describe("ELLIE-1267: end-to-end question/answer flow", () => {
  beforeEach(() => {
    clearQuestionQueue();
  });

  test("full flow: enqueue → notify → answer → resolve", async () => {
    // Simulate: agent asks question via queue
    const id = enqueueQuestion("james", "Should I use REST or GraphQL?", {
      workItemId: "ELLIE-500",
      options: ["REST", "GraphQL"],
    });

    // Verify question is pending
    const pending = getPendingQuestions();
    expect(pending).toHaveLength(1);
    expect(pending[0].agentName).toBe("james");
    expect(pending[0].options).toEqual(["REST", "GraphQL"]);

    // Get the promise before answering
    const answerPromise = waitForAnswer(id)!;
    expect(answerPromise).not.toBeNull();

    // Simulate: user replies
    const answered = answerQuestion(id, "Use REST");
    expect(answered).toBe(true);

    // Verify: agent receives the answer
    const result = await answerPromise;
    expect(result).toBe("Use REST");

    // Verify: question is removed from queue
    expect(getPendingQuestions()).toHaveLength(0);
  });

  test("concurrent questions from different agents", async () => {
    const id1 = enqueueQuestion("james", "Q from James?");
    const id2 = enqueueQuestion("kate", "Q from Kate?");

    const p1 = waitForAnswer(id1)!;
    const p2 = waitForAnswer(id2)!;

    // Answer in reverse order
    answerQuestion(id2, "Answer for Kate");
    answerQuestion(id1, "Answer for James");

    expect(await p1).toBe("Answer for James");
    expect(await p2).toBe("Answer for Kate");
  });
});
```

- [ ] **Step 2: Run all tests**

Run: `bun test tests/ask-user-mcp.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/ask-user-mcp.test.ts
git commit -m "[ELLIE-1267] Add integration tests for ask-user question flow"
```

---

### Task 7: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: No regressions

- [ ] **Step 2: Verify MCP server starts**

Run: `echo '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}},"id":1}' | bun mcp-ask-user.ts 2>/dev/null | head -1`
Expected: JSON response with server capabilities

- [ ] **Step 3: Final commit if needed, push**

```bash
git push origin feature/orchestrator-observability
```
