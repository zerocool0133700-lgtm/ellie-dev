/**
 * UMS Connector Tests: Google Tasks — ELLIE-708
 */

import { describe, test, expect } from "bun:test";
import { googleTasksConnector } from "../src/ums/connectors/google-tasks.ts";
import { googleTasksFixtures as fx } from "./fixtures/ums-connector-payloads.ts";

describe("googleTasksConnector", () => {
  test("provider is 'google-tasks'", () => {
    expect(googleTasksConnector.provider).toBe("google-tasks");
  });

  test("normalizes a task with notes", () => {
    const result = googleTasksConnector.normalize(fx.basicTask);
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("google-tasks");
    expect(result!.provider_id).toBe("task-001");
    expect(result!.channel).toBe("google-tasks:default");
    expect(result!.content).toBe("Buy groceries\n\nMilk, eggs, bread");
    expect(result!.content_type).toBe("task");
    expect(result!.sender).toBeNull();
    expect(result!.provider_timestamp).toBe("2026-03-14T09:00:00Z");
    expect(result!.metadata).toMatchObject({
      title: "Buy groceries",
      notes: "Milk, eggs, bread",
      due_date: "2026-03-15T00:00:00Z",
      external_status: "needsAction",
    });
  });

  test("normalizes a completed task (no notes)", () => {
    const result = googleTasksConnector.normalize(fx.completedTask);
    expect(result).not.toBeNull();
    expect(result!.content).toBe("Submit report");
    expect(result!.metadata!.external_status).toBe("completed");
    expect(result!.metadata!.notes).toBeUndefined();
  });

  test("normalizes a minimal task", () => {
    const result = googleTasksConnector.normalize(fx.minimalTask);
    expect(result).not.toBeNull();
    expect(result!.content).toBe("Quick reminder");
    expect(result!.provider_timestamp).toBeNull();
  });

  test("returns null when id is missing", () => {
    expect(googleTasksConnector.normalize(fx.noId)).toBeNull();
  });

  test("returns null when title is missing", () => {
    expect(googleTasksConnector.normalize(fx.noTitle)).toBeNull();
  });

  test("returns null for empty payload", () => {
    expect(googleTasksConnector.normalize(fx.empty)).toBeNull();
  });
});
