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
  /** Structured question metadata from coordinator — used by Telegram disambiguation */
  questionId?: string;       // q-{8hex} format from GTD
  answerFormat?: "text" | "choice" | "approve_deny";
  choices?: string[];
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
