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
