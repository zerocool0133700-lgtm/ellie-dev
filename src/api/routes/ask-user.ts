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
} from "../../ask-user-queue.ts";
import { log } from "../../logger.ts";

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
      logger.warn("ask-user question timed out", { id });
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
