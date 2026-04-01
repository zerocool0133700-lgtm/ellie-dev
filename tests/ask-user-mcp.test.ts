import { describe, test, expect, beforeEach } from "bun:test";
import {
  enqueueQuestion,
  answerQuestion,
  getPendingQuestions,
  clearQuestionQueue,
  waitForAnswer,
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

    const waitPromise = waitForAnswer(id)!;
    expect(waitPromise).not.toBeNull();

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

// ── Task 2: HTTP endpoint tests ──

import {
  handleAskUserRoute,
} from "../src/api/routes/ask-user";

function mockReq(method: string, url: string): any {
  return {
    method,
    url,
    headers: { "content-type": "application/json" },
  };
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

    const req = mockReq("POST", `/api/ask-user/answer/${id}`);
    const res = mockRes();
    const handled = await handleAskUserRoute(req, res, `/api/ask-user/answer/${id}`, { readBody: async () => ({ answer: "Test answer" }) });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);

    const answer = await waitPromise;
    expect(answer).toBe("Test answer");
  });

  test("POST /api/ask-user/answer/:id returns 404 for unknown question", async () => {
    const req = mockReq("POST", "/api/ask-user/answer/nonexistent");
    const res = mockRes();
    const handled = await handleAskUserRoute(req, res, "/api/ask-user/answer/nonexistent", { readBody: async () => ({ answer: "x" }) });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(404);
  });

  test("unmatched route returns false", async () => {
    const req = mockReq("GET", "/api/something-else");
    const res = mockRes();
    const handled = await handleAskUserRoute(req, res, "/api/something-else");
    expect(handled).toBe(false);
  });
});
