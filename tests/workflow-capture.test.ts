/**
 * Workflow Capture Queue Tests — ELLIE-766
 *
 * Tests for workflow detection and queue management:
 * - Pattern detection (7 patterns)
 * - Confidence scoring
 * - Queue CRUD (add, get, update status, clear)
 * - Deduplication
 * - Cross-reference filtering
 * - Obsidian create doc URI
 * - Multi-message detection
 * - E2E scenarios
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  detectWorkflows,
  detectWorkflowsInMessages,
  addToQueue,
  getQueue,
  updateWorkflowStatus,
  clearQueue,
  filterAlreadyCaptured,
  buildCreateDocUri,
  WORKFLOW_PATTERNS,
  _setQueueForTesting,
  type DetectedWorkflow,
} from "../src/workflow-capture.ts";

beforeEach(() => {
  clearQueue();
});

// ── Pattern Detection ───────────────────────────────────────

describe("detectWorkflows", () => {
  test("detects when-then pattern", () => {
    const results = detectWorkflows("When a new ticket comes in, then we triage it and assign to the right agent");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].pattern_matched).toBe("when-then");
  });

  test("detects process-for pattern", () => {
    const results = detectWorkflows("The process for deploying a new release is to run tests, build, and push to production");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].pattern_matched).toBe("process-for");
  });

  test("detects steps-to pattern", () => {
    const results = detectWorkflows("Steps to set up a new client: create company, add payers, configure agents.");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].pattern_matched).toBe("steps-to");
  });

  test("detects always-do pattern", () => {
    const results = detectWorkflows("Always make sure to run the migration before restarting the relay service.");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].pattern_matched).toBe("always-do");
  });

  test("detects decision pattern", () => {
    const results = detectWorkflows("If the claim is denied for medical necessity, then we should file an appeal with clinical evidence");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].pattern_matched).toBe("decision-pattern");
  });

  test("detects deploy process", () => {
    const results = detectWorkflows("To deploy the dashboard, run bun build then restart the service.");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  test("detects checklist pattern", () => {
    const results = detectWorkflows("Before deploying to production, verify all tests pass and check the logs.");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  test("returns empty for non-workflow text", () => {
    expect(detectWorkflows("Hello, how are you today?")).toHaveLength(0);
    expect(detectWorkflows("The weather is nice.")).toHaveLength(0);
  });

  test("includes channel in results", () => {
    const results = detectWorkflows("The process for billing is clear", "telegram");
    if (results.length > 0) {
      expect(results[0].channel).toBe("telegram");
    }
  });

  test("generates suggested_key with prefix", () => {
    const results = detectWorkflows("The process for onboarding new clients is straightforward");
    if (results.length > 0) {
      expect(results[0].suggested_key).toMatch(/^process-/);
    }
  });

  test("generates suggested_path under prompts/workflows/", () => {
    const results = detectWorkflows("Steps to configure the FHIR connector properly.");
    if (results.length > 0) {
      expect(results[0].suggested_path).toMatch(/^prompts\/workflows\//);
    }
  });
});

// ── Confidence Scoring ──────────────────────────────────────

describe("confidence scoring", () => {
  test("longer descriptions get higher confidence", () => {
    const short = detectWorkflows("The process for X is simple.");
    const long = detectWorkflows("The process for onboarding a new medical billing client involves setting up their company profile, configuring payer integrations, and training agents.");
    if (short.length > 0 && long.length > 0) {
      expect(long[0].confidence).toBeGreaterThanOrEqual(short[0].confidence);
    }
  });

  test("confidence is between 0 and 1", () => {
    const results = detectWorkflows("When we receive a denial, then we classify it and route to the right handler.");
    for (const r of results) {
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }
  });
});

// ── Queue Management ────────────────────────────────────────

describe("queue management", () => {
  test("addToQueue adds items and returns count", () => {
    const items = detectWorkflows("The process for billing claims is to validate, submit, and track.");
    const added = addToQueue(items);
    expect(added).toBe(items.length);
    expect(getQueue().total).toBe(items.length);
  });

  test("addToQueue deduplicates by suggested_key", () => {
    const items = detectWorkflows("The process for billing claims is to validate, submit, and track.");
    addToQueue(items);
    const added2 = addToQueue(items); // Same items again
    expect(added2).toBe(0);
  });

  test("getQueue returns all items", () => {
    const items = detectWorkflows("When a claim is denied, then we analyze the denial code.");
    addToQueue(items);
    const queue = getQueue();
    expect(queue.total).toBeGreaterThanOrEqual(1);
    expect(queue.pending).toBe(queue.total); // All detected = pending
  });

  test("getQueue filters by status", () => {
    const items = detectWorkflows("Steps to configure payer integrations.");
    addToQueue(items);
    if (items.length > 0) {
      updateWorkflowStatus(items[0].id, "dismissed");
      expect(getQueue({ status: "detected" }).items.length).toBeLessThan(getQueue().total);
      expect(getQueue({ status: "dismissed" }).items).toHaveLength(1);
    }
  });

  test("updateWorkflowStatus changes status", () => {
    const items = detectWorkflows("The process for handling appeals is documented.");
    addToQueue(items);
    if (items.length > 0) {
      expect(updateWorkflowStatus(items[0].id, "captured")).toBe(true);
      expect(getQueue().items.find(w => w.id === items[0].id)?.status).toBe("captured");
    }
  });

  test("updateWorkflowStatus returns false for unknown id", () => {
    expect(updateWorkflowStatus("nonexistent", "dismissed")).toBe(false);
  });

  test("clearQueue empties the queue", () => {
    addToQueue(detectWorkflows("When we deploy, then we test everything."));
    clearQueue();
    expect(getQueue().total).toBe(0);
  });
});

// ── Cross-Reference Filtering ───────────────────────────────

describe("filterAlreadyCaptured", () => {
  test("filters out workflows matching existing doc keys", () => {
    const workflows: DetectedWorkflow[] = [
      { id: "1", detected_at: "", status: "detected", description: "test", source_text: "", channel: "", suggested_key: "process-billing", suggested_path: "", confidence: 0.5, pattern_matched: "process-for" },
      { id: "2", detected_at: "", status: "detected", description: "test2", source_text: "", channel: "", suggested_key: "workflow-deploy", suggested_path: "", confidence: 0.5, pattern_matched: "when-then" },
    ];
    const existing = new Set(["process-billing"]);
    const filtered = filterAlreadyCaptured(workflows, existing);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].suggested_key).toBe("workflow-deploy");
  });

  test("returns all when no matches", () => {
    const workflows: DetectedWorkflow[] = [
      { id: "1", detected_at: "", status: "detected", description: "test", source_text: "", channel: "", suggested_key: "new-workflow", suggested_path: "", confidence: 0.5, pattern_matched: "when-then" },
    ];
    expect(filterAlreadyCaptured(workflows, new Set())).toHaveLength(1);
  });
});

// ── buildCreateDocUri ───────────────────────────────────────

describe("buildCreateDocUri", () => {
  test("builds obsidian://new URI", () => {
    const wf: DetectedWorkflow = {
      id: "wf-1", detected_at: "", status: "detected",
      description: "Process for onboarding",
      source_text: "Original conversation text",
      channel: "telegram",
      suggested_key: "process-onboarding",
      suggested_path: "prompts/workflows/process-onboarding.md",
      confidence: 0.7, pattern_matched: "process-for",
    };
    const uri = buildCreateDocUri(wf);
    expect(uri).toContain("obsidian://new");
    expect(uri).toContain("vault=obsidian-vault");
    expect(uri).toContain("file=");
    expect(uri).toContain("content=");
  });

  test("URI content includes YAML frontmatter", () => {
    const wf: DetectedWorkflow = {
      id: "wf-1", detected_at: "", status: "detected",
      description: "Deploy process", source_text: "source",
      channel: "telegram", suggested_key: "deploy-process",
      suggested_path: "prompts/workflows/deploy-process.md",
      confidence: 0.7, pattern_matched: "deploy-process",
    };
    const uri = buildCreateDocUri(wf);
    const content = decodeURIComponent(uri.split("content=")[1]);
    expect(content).toContain("---");
    expect(content).toContain("name: deploy-process");
    expect(content).toContain("## Deploy process");
    expect(content).toContain("### Steps");
  });
});

// ── Multi-Message Detection ─────────────────────────────────

describe("detectWorkflowsInMessages", () => {
  test("detects across multiple messages", () => {
    const messages = [
      { text: "When a new client signs up, then we create their company profile.", channel: "telegram" },
      { text: "The process for payer enrollment is to submit the application.", channel: "google-chat" },
    ];
    const results = detectWorkflowsInMessages(messages);
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  test("deduplicates across messages", () => {
    const messages = [
      { text: "The process for billing is clear.", channel: "telegram" },
      { text: "The process for billing is clear.", channel: "telegram" },
    ];
    const results = detectWorkflowsInMessages(messages);
    // Same text should deduplicate
    const keys = results.map(r => r.suggested_key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// ── Constants ───────────────────────────────────────────────

describe("WORKFLOW_PATTERNS", () => {
  test("has 7 patterns", () => {
    expect(WORKFLOW_PATTERNS).toHaveLength(7);
  });

  test("each pattern has name, regex, and keyPrefix", () => {
    for (const p of WORKFLOW_PATTERNS) {
      expect(p.name).toBeTruthy();
      expect(p.pattern).toBeInstanceOf(RegExp);
      expect(p.keyPrefix).toBeTruthy();
    }
  });
});

// ── E2E ─────────────────────────────────────────────────────

describe("E2E: detect -> queue -> filter -> action", () => {
  test("full workflow capture lifecycle", () => {
    // Detect
    const conversations = [
      { text: "When we get a CO-16 denial, then we add the missing modifier and resubmit.", channel: "telegram" },
      { text: "The process for running the morning briefing is to check tickets, review forest, and send summary.", channel: "ellie-chat" },
      { text: "Always make sure to run bun test before pushing any code changes.", channel: "telegram" },
    ];
    const detected = detectWorkflowsInMessages(conversations);
    expect(detected.length).toBeGreaterThanOrEqual(1);

    // Add to queue
    addToQueue(detected);
    const initialQueue = getQueue();
    expect(initialQueue.total).toBeGreaterThanOrEqual(1);
    expect(initialQueue.pending).toBe(initialQueue.total);

    // Filter against existing docs
    const existing = new Set([detected[0].suggested_key]);
    const uncaptured = filterAlreadyCaptured(detected, existing);
    expect(uncaptured.length).toBeLessThan(detected.length);

    // Dismiss first item
    updateWorkflowStatus(detected[0].id, "dismissed");
    expect(getQueue({ status: "dismissed" }).items).toHaveLength(1);

    // Pending count decreased
    expect(getQueue().pending).toBe(initialQueue.total - 1);

    // Build create URI for an uncaptured workflow
    if (uncaptured.length > 0) {
      const uri = buildCreateDocUri(uncaptured[0]);
      expect(uri).toContain("obsidian://new");
    }
  });
});
