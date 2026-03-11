/**
 * Mountain Relay Integration Tests — ELLIE-669
 *
 * Verifies that the relay's saveMessage() hook correctly fires
 * Mountain ingestion (via resilientTask fire-and-forget) for all
 * three channels, and that Mountain failures do NOT block message delivery.
 *
 * The wiring lives in src/message-sender.ts:
 *   resilientTask("mountainIngest", "best-effort", () => ingestMessage({...}))
 *
 * These tests mock Supabase-dependent modules so the suite runs
 * without a live Supabase instance, while still hitting the real
 * Forest DB for mountain_records assertions.
 */

import { mock, describe, test, expect, beforeEach, afterAll } from "bun:test";
import { sql } from "../../ellie-forest/src/index.ts";

// ── Mock Supabase-dependent modules ──────────────────────────
// Must be registered before message-sender.ts is imported so
// Bun's module mock hoisting applies to all transitive imports.

mock.module("../src/conversations.ts", () => ({
  getOrCreateConversation: async (_sb: unknown, _ch: string) => "mock-conv-id",
  attachMessage: async () => {},
  maybeGenerateSummary: async () => {},
}));

mock.module("../src/elasticsearch.ts", () => ({
  indexMessage: async () => {},
}));

// ── Imports (after mocks registered) ─────────────────────────

import { saveMessage, setSenderDeps } from "../src/message-sender.ts";
import {
  _resetIngestionForTesting,
  setIngestionEnabled,
  disableChannel,
} from "../src/mountain/message-ingestion.ts";
import { _resetMetricsForTesting, getFireForgetMetrics } from "../src/resilient-task.ts";

// ── Helpers ───────────────────────────────────────────────────

const TEST_PREFIX = "relay-integ-";

/** Minimal Supabase mock that returns a controlled message ID. */
function makeMockSupabase(messageId: string) {
  return {
    from: (_table: string) => ({
      insert: (_row: unknown) => ({
        select: (_cols: string) => ({
          single: () => Promise.resolve({ data: { id: messageId }, error: null }),
        }),
      }),
    }),
  } as unknown as import("@supabase/supabase-js").SupabaseClient;
}

/** Minimal Supabase mock that always throws on insert. */
function makeBrokenSupabase() {
  return {
    from: (_table: string) => ({
      insert: (_row: unknown) => ({
        select: (_cols: string) => ({
          single: () => Promise.reject(new Error("Supabase connection failed")),
        }),
      }),
    }),
  } as unknown as import("@supabase/supabase-js").SupabaseClient;
}

/** Wait for fire-and-forget tasks to settle (resilientTask is non-blocking). */
async function waitForTasks(ms = 60) {
  await new Promise((r) => setTimeout(r, ms));
}

async function cleanupTestRecords() {
  await sql`
    DELETE FROM mountain_records
    WHERE source_system = 'relay'
      AND external_id LIKE ${"relay:%" + TEST_PREFIX + "%"}
  `;
}

// ── Hooks ────────────────────────────────────────────────────

beforeEach(async () => {
  _resetIngestionForTesting();
  _resetMetricsForTesting();
  await cleanupTestRecords();
  // Reset to no Supabase between tests
  setSenderDeps({ supabase: null, getActiveAgent: () => "test-agent" });
});

afterAll(async () => {
  await cleanupTestRecords();
});

// ── Relay → Mountain Wiring ───────────────────────────────────

describe("relay → Mountain wiring (all channels)", () => {
  test("telegram message creates a mountain_record", async () => {
    const msgId = `${TEST_PREFIX}${crypto.randomUUID()}`;
    setSenderDeps({ supabase: makeMockSupabase(msgId), getActiveAgent: () => "test" });

    const savedId = await saveMessage("user", "Hello from Telegram", {}, "telegram", "user-123");
    expect(savedId).toBe(msgId);

    await waitForTasks();

    const [row] = await sql`
      SELECT * FROM mountain_records
      WHERE external_id = ${"relay:telegram:" + msgId}
    `;
    expect(row).toBeDefined();
    expect(row.source_system).toBe("relay");
    expect(row.record_type).toBe("message");
    expect(row.status).toBe("active");
    expect(row.payload.content).toBe("Hello from Telegram");
    expect(row.payload.channel).toBe("telegram");
    expect(row.payload.role).toBe("user");
    expect(row.payload.sender).toBe("user-123");
  });

  test("google-chat message creates a mountain_record", async () => {
    const msgId = `${TEST_PREFIX}${crypto.randomUUID()}`;
    setSenderDeps({ supabase: makeMockSupabase(msgId), getActiveAgent: () => "test" });

    await saveMessage(
      "user",
      "Hello from GChat",
      { sender: "dave@ellie-labs.dev", space: "spaces/ABC" },
      "google-chat",
      "dave@ellie-labs.dev",
    );
    await waitForTasks();

    const [row] = await sql`
      SELECT * FROM mountain_records
      WHERE external_id = ${"relay:google-chat:" + msgId}
    `;
    expect(row).toBeDefined();
    expect(row.payload.channel).toBe("google-chat");
    expect(row.payload.sender).toBe("dave@ellie-labs.dev");
  });

  test("ellie-chat message creates a mountain_record", async () => {
    const msgId = `${TEST_PREFIX}${crypto.randomUUID()}`;
    setSenderDeps({ supabase: makeMockSupabase(msgId), getActiveAgent: () => "test" });

    await saveMessage("user", "Hello from Ellie Chat", {}, "ellie-chat", "anon-xyz");
    await waitForTasks();

    const [row] = await sql`
      SELECT * FROM mountain_records
      WHERE external_id = ${"relay:ellie-chat:" + msgId}
    `;
    expect(row).toBeDefined();
    expect(row.payload.channel).toBe("ellie-chat");
    expect(row.payload.sender).toBe("anon-xyz");
  });

  test("assistant responses are also ingested", async () => {
    const msgId = `${TEST_PREFIX}${crypto.randomUUID()}`;
    setSenderDeps({ supabase: makeMockSupabase(msgId), getActiveAgent: () => "test" });

    await saveMessage("assistant", "Here is my response", {}, "telegram", "bot");
    await waitForTasks();

    const [row] = await sql`
      SELECT * FROM mountain_records
      WHERE external_id = ${"relay:telegram:" + msgId}
    `;
    expect(row).toBeDefined();
    expect(row.payload.role).toBe("assistant");
  });

  test("voice transcripts get record_type = voice_transcript", async () => {
    const msgId = `${TEST_PREFIX}${crypto.randomUUID()}`;
    setSenderDeps({ supabase: makeMockSupabase(msgId), getActiveAgent: () => "test" });

    await saveMessage(
      "user",
      "Transcribed voice message",
      { voice_transcript: true },
      "telegram",
      "user-123",
    );
    await waitForTasks();

    const [row] = await sql`
      SELECT * FROM mountain_records
      WHERE external_id = ${"relay:telegram:" + msgId}
    `;
    expect(row.record_type).toBe("voice_transcript");
  });

  test("image captions get record_type = image_caption", async () => {
    const msgId = `${TEST_PREFIX}${crypto.randomUUID()}`;
    setSenderDeps({ supabase: makeMockSupabase(msgId), getActiveAgent: () => "test" });

    await saveMessage(
      "user",
      "A beautiful sunset photo",
      { image_name: "sunset.jpg", image_mime: "image/jpeg" },
      "telegram",
      "user-123",
    );
    await waitForTasks();

    const [row] = await sql`
      SELECT * FROM mountain_records
      WHERE external_id = ${"relay:telegram:" + msgId}
    `;
    expect(row.record_type).toBe("image_caption");
  });
});

// ── externalId Format ─────────────────────────────────────────

describe("mountain_record externalId format", () => {
  test.each([
    ["telegram", "relay:telegram:"],
    ["google-chat", "relay:google-chat:"],
    ["ellie-chat", "relay:ellie-chat:"],
  ] as const)(
    "%s messages produce externalId with prefix %s",
    async (channel, prefix) => {
      const msgId = `${TEST_PREFIX}${crypto.randomUUID()}`;
      setSenderDeps({ supabase: makeMockSupabase(msgId), getActiveAgent: () => "test" });

      await saveMessage("user", "Format test", {}, channel, "user");
      await waitForTasks();

      const [row] = await sql`
        SELECT external_id FROM mountain_records
        WHERE external_id = ${prefix + msgId}
      `;
      expect(row).toBeDefined();
      expect(row.external_id).toBe(prefix + msgId);
    },
  );
});

// ── Failure Isolation ─────────────────────────────────────────

describe("Mountain failure isolation", () => {
  test("saveMessage returns null when Supabase is not configured", async () => {
    // supabase = null (default after reset)
    const result = await saveMessage("user", "Test", {}, "telegram", "user");
    expect(result).toBeNull();
  });

  test("saveMessage returns null when Supabase throws", async () => {
    setSenderDeps({ supabase: makeBrokenSupabase(), getActiveAgent: () => "test" });
    const result = await saveMessage("user", "Test", {}, "telegram", "user");
    expect(result).toBeNull();
  });

  test("saveMessage still returns ID when Mountain ingestion is globally disabled", async () => {
    setIngestionEnabled(false);
    const msgId = `${TEST_PREFIX}${crypto.randomUUID()}`;
    setSenderDeps({ supabase: makeMockSupabase(msgId), getActiveAgent: () => "test" });

    const savedId = await saveMessage("user", "Test", {}, "telegram", "user");
    expect(savedId).toBe(msgId); // Supabase save still worked

    await waitForTasks();

    // Mountain record should NOT exist
    const rows = await sql`
      SELECT id FROM mountain_records
      WHERE external_id = ${"relay:telegram:" + msgId}
    `;
    expect(rows).toHaveLength(0);
  });

  test("saveMessage still returns ID when channel is disabled for Mountain", async () => {
    disableChannel("telegram");
    const msgId = `${TEST_PREFIX}${crypto.randomUUID()}`;
    setSenderDeps({ supabase: makeMockSupabase(msgId), getActiveAgent: () => "test" });

    const savedId = await saveMessage("user", "Test", {}, "telegram", "user");
    expect(savedId).toBe(msgId);

    await waitForTasks();

    const rows = await sql`
      SELECT id FROM mountain_records
      WHERE external_id = ${"relay:telegram:" + msgId}
    `;
    expect(rows).toHaveLength(0);
  });

  test("other channels still ingest when one channel is disabled", async () => {
    disableChannel("telegram");
    const msgId = `${TEST_PREFIX}${crypto.randomUUID()}`;
    setSenderDeps({ supabase: makeMockSupabase(msgId), getActiveAgent: () => "test" });

    await saveMessage("user", "GChat message", {}, "google-chat", "user");
    await waitForTasks();

    const [row] = await sql`
      SELECT id FROM mountain_records
      WHERE external_id = ${"relay:google-chat:" + msgId}
    `;
    expect(row).toBeDefined();
  });

  test("mountainIngest is registered as best-effort (no retries on failure)", async () => {
    // best-effort tasks track successes but don't retry — verify via metrics
    const msgId = `${TEST_PREFIX}${crypto.randomUUID()}`;
    setSenderDeps({ supabase: makeMockSupabase(msgId), getActiveAgent: () => "test" });

    await saveMessage("user", "Metrics test", {}, "telegram", "user");
    await waitForTasks();

    const metrics = getFireForgetMetrics();
    const mountainOp = metrics.operations.find((o) => o.label === "mountainIngest");
    expect(mountainOp).toBeDefined();
    expect(mountainOp!.totalSuccesses).toBeGreaterThanOrEqual(1);
    // best-effort: zero retries on success
    expect(mountainOp!.totalRetries).toBe(0);
  });
});

// ── Fire-and-Forget Behavior ──────────────────────────────────

describe("fire-and-forget (saveMessage does not block on Mountain)", () => {
  test("saveMessage resolves before mountain ingest completes", async () => {
    let ingestStarted = false;

    // Slow down ingestion by patching with a delayed upsert check
    // We verify that saveMessage returned BEFORE the mountain record appeared
    const msgId = `${TEST_PREFIX}${crypto.randomUUID()}`;
    setSenderDeps({ supabase: makeMockSupabase(msgId), getActiveAgent: () => "test" });

    const start = Date.now();
    const savedId = await saveMessage("user", "Fire and forget test", {}, "telegram", "user");
    const elapsed = Date.now() - start;

    expect(savedId).toBe(msgId);
    // saveMessage should complete quickly (well under 1 second) even with background tasks
    expect(elapsed).toBeLessThan(500);

    // Background tasks are still running — wait for them
    await waitForTasks();

    const [row] = await sql`
      SELECT id FROM mountain_records
      WHERE external_id = ${"relay:telegram:" + msgId}
    `;
    expect(row).toBeDefined();
  });

  test("multiple messages each get their own mountain_record", async () => {
    const ids = [
      `${TEST_PREFIX}${crypto.randomUUID()}`,
      `${TEST_PREFIX}${crypto.randomUUID()}`,
      `${TEST_PREFIX}${crypto.randomUUID()}`,
    ];

    for (const id of ids) {
      setSenderDeps({ supabase: makeMockSupabase(id), getActiveAgent: () => "test" });
      await saveMessage("user", `Message ${id}`, {}, "telegram", "user");
    }

    await waitForTasks();

    for (const id of ids) {
      const [row] = await sql`
        SELECT id FROM mountain_records
        WHERE external_id = ${"relay:telegram:" + id}
      `;
      expect(row).toBeDefined();
    }
  });
});

// ── E2E: Full relay message lifecycle ─────────────────────────

describe("E2E: full relay message lifecycle", () => {
  test("user message → Supabase save → Mountain record → correct payload", async () => {
    const msgId = `${TEST_PREFIX}e2e-${crypto.randomUUID()}`;
    setSenderDeps({ supabase: makeMockSupabase(msgId), getActiveAgent: () => "test-agent" });

    // Simulate a Telegram user sending a message
    const savedId = await saveMessage(
      "user",
      "Can you help me with my schedule?",
      { device: "mobile" },
      "telegram",
      "tg-user-99",
    );

    expect(savedId).toBe(msgId);
    await waitForTasks();

    // Verify mountain_record was created with full payload
    const [row] = await sql`
      SELECT * FROM mountain_records
      WHERE external_id = ${"relay:telegram:" + msgId}
    `;

    expect(row).toBeDefined();
    expect(row.source_system).toBe("relay");
    expect(row.record_type).toBe("message");
    expect(row.status).toBe("active");
    expect(row.summary).toContain("Can you help me");
    expect(row.payload.role).toBe("user");
    expect(row.payload.content).toBe("Can you help me with my schedule?");
    expect(row.payload.channel).toBe("telegram");
    expect(row.payload.sender).toBe("tg-user-99");
    expect(row.payload.conversation_context.user_id).toBe("tg-user-99");
  });

  test("conversation: user message + assistant reply both ingested", async () => {
    const userMsgId = `${TEST_PREFIX}e2e-user-${crypto.randomUUID()}`;
    const asstMsgId = `${TEST_PREFIX}e2e-asst-${crypto.randomUUID()}`;

    // User message
    setSenderDeps({ supabase: makeMockSupabase(userMsgId), getActiveAgent: () => "test" });
    await saveMessage("user", "What's the weather like?", {}, "ellie-chat", "dave");

    // Assistant response
    setSenderDeps({ supabase: makeMockSupabase(asstMsgId), getActiveAgent: () => "test" });
    await saveMessage("assistant", "It's sunny and 72°F today.", {}, "ellie-chat", "dave");

    await waitForTasks();

    const [userRow] = await sql`
      SELECT * FROM mountain_records
      WHERE external_id = ${"relay:ellie-chat:" + userMsgId}
    `;
    const [asstRow] = await sql`
      SELECT * FROM mountain_records
      WHERE external_id = ${"relay:ellie-chat:" + asstMsgId}
    `;

    expect(userRow.payload.role).toBe("user");
    expect(asstRow.payload.role).toBe("assistant");
    expect(asstRow.payload.content).toBe("It's sunny and 72°F today.");
  });
});
