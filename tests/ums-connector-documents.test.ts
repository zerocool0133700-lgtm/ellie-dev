/**
 * UMS Connector Tests: Documents — ELLIE-708
 */

import { describe, test, expect } from "bun:test";
import { documentsConnector } from "../src/ums/connectors/documents.ts";
import { documentsFixtures as fx } from "./fixtures/ums-connector-payloads.ts";

describe("documentsConnector", () => {
  test("provider is 'documents'", () => {
    expect(documentsConnector.provider).toBe("documents");
  });

  // ── Change types ─────────────────────────────────────────

  test("normalizes a comment event", () => {
    const result = documentsConnector.normalize(fx.comment);
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("documents");
    expect(result!.provider_id).toBe("doc-evt-001");
    expect(result!.channel).toBe("doc:doc-123");
    expect(result!.content).toContain('Comment on "Q1 Planning"');
    expect(result!.content).toContain("We should revisit this section");
    expect(result!.content_type).toBe("notification");
    expect(result!.sender).toEqual({ name: "Alice", email: "alice@example.com" });
    expect(result!.provider_timestamp).toBe("2026-03-14T10:00:00Z");
    expect(result!.metadata).toMatchObject({
      doc_id: "doc-123",
      doc_title: "Q1 Planning",
      change_type: "comment",
      section: "Budget",
      doc_url: "https://docs.google.com/doc/123",
      doc_provider: "google-docs",
    });
  });

  test("normalizes an edit event", () => {
    const result = documentsConnector.normalize(fx.edit);
    expect(result).not.toBeNull();
    expect(result!.content).toContain('Edit to "Q1 Planning"');
    expect(result!.content).toContain("(Timeline)");
    expect(result!.sender).toEqual({ name: "Bob", email: undefined });
  });

  test("normalizes a share event", () => {
    const result = documentsConnector.normalize(fx.share);
    expect(result).not.toBeNull();
    expect(result!.content).toContain('"Team Handbook" was shared with you');
    expect(result!.sender).toBeNull();
  });

  test("normalizes a mention event", () => {
    const result = documentsConnector.normalize(fx.mention);
    expect(result).not.toBeNull();
    expect(result!.content).toContain('You were mentioned in "Design Review"');
    expect(result!.content).toContain("Dave, can you review this?");
  });

  test("normalizes a suggestion event", () => {
    const result = documentsConnector.normalize(fx.suggestion);
    expect(result).not.toBeNull();
    expect(result!.content).toContain('Suggestion on "Q1 Planning"');
    expect(result!.content).toContain("Replace 'quarterly' with 'monthly'");
  });

  // ── Error paths ──────────────────────────────────────────

  test("returns null when id is missing", () => {
    expect(documentsConnector.normalize(fx.noId)).toBeNull();
  });

  test("returns null when doc_id is missing", () => {
    expect(documentsConnector.normalize(fx.noDocId)).toBeNull();
  });

  test("returns null for empty payload", () => {
    expect(documentsConnector.normalize(fx.empty)).toBeNull();
  });

  test("preserves raw payload", () => {
    const result = documentsConnector.normalize(fx.comment);
    expect(result!.raw).toBe(fx.comment);
  });
});
