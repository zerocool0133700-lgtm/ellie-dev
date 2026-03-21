/**
 * ELLIE-300: Google Tasks → UMS → GTD Integration Test
 *
 * Verifies that Google Tasks flow through UMS into the GTD inbox:
 * 1. Task is normalized by googleTasksConnector
 * 2. Ingested into unified_messages with content_type="task"
 * 3. GTD consumer creates inbox item in todos table
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import { registerConnector, googleTasksConnector, ingest, initGtdConsumer } from "../src/ums/index.ts";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!,
);

describe("Google Tasks → UMS → GTD integration", () => {
  beforeAll(() => {
    // Register connector once
    registerConnector(googleTasksConnector);

    // Initialize GTD consumer once
    initGtdConsumer(supabase);
  });

  beforeEach(async () => {
    // Clean up test data
    await supabase.from("todos").delete().eq("source_type", "ums").like("source_ref", "google-tasks:test-%");
    await supabase.from("unified_messages").delete().eq("provider", "google-tasks").like("provider_id", "test-%");
  });

  afterEach(async () => {
    // Clean up test data
    await supabase.from("todos").delete().eq("source_type", "ums").like("source_ref", "google-tasks:test-%");
    await supabase.from("unified_messages").delete().eq("provider", "google-tasks").like("provider_id", "test-%");
  });

  test("task flows from connector → UMS → GTD inbox", async () => {
    // Google Tasks API payload
    const googleTask = {
      id: "test-task-001",
      title: "Review ELLIE-300 implementation",
      notes: "Check connector, consumer, and polling",
      status: "needsAction",
      due: "2026-03-22T00:00:00Z",
      updated: "2026-03-21T19:00:00Z",
    };

    // Ingest via UMS
    const message = await ingest(supabase, "google-tasks", googleTask);

    expect(message).not.toBeNull();
    expect(message!.provider).toBe("google-tasks");
    expect(message!.content_type).toBe("task");
    expect(message!.content).toContain("Review ELLIE-300 implementation");
    expect(message!.content).toContain("Check connector, consumer, and polling");

    // Wait for GTD consumer to process (async event)
    await new Promise(resolve => setTimeout(resolve, 200));

    // Verify todo was created
    const { data: todos } = await supabase
      .from("todos")
      .select("*")
      .eq("source_ref", "google-tasks:test-task-001")
      .single();

    expect(todos).not.toBeNull();
    expect(todos!.status).toBe("inbox");
    expect(todos!.content).toContain("Review ELLIE-300 implementation");
    expect(todos!.tags).toContain("imported");
    expect(todos!.tags).toContain("source:google-tasks");
  });

  test("completed task still ingests to GTD", async () => {
    const completedTask = {
      id: "test-task-002",
      title: "Deploy to production",
      status: "completed",
      updated: "2026-03-21T18:00:00Z",
    };

    const message = await ingest(supabase, "google-tasks", completedTask);

    expect(message).not.toBeNull();
    expect(message!.content_type).toBe("task");

    await new Promise(resolve => setTimeout(resolve, 200));

    const { data: todos } = await supabase
      .from("todos")
      .select("*")
      .eq("source_ref", "google-tasks:test-task-002")
      .single();

    expect(todos).not.toBeNull();
    expect(todos!.status).toBe("inbox");
  });

  test("duplicate tasks are ignored by UMS", async () => {
    const task = {
      id: "test-task-003",
      title: "Write tests",
      status: "needsAction",
      updated: "2026-03-21T17:00:00Z",
    };

    // Ingest twice
    const first = await ingest(supabase, "google-tasks", task);
    const second = await ingest(supabase, "google-tasks", task);

    expect(first).not.toBeNull();
    expect(second).toBeNull(); // Duplicate ignored

    await new Promise(resolve => setTimeout(resolve, 200));

    // Only one todo created
    const { data: todos } = await supabase
      .from("todos")
      .select("*")
      .eq("source_ref", "google-tasks:test-task-003");

    expect(todos).not.toBeNull();
    expect(todos!.length).toBe(1);
  });
});
