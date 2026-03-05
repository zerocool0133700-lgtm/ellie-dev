/**
 * ELLIE-544 — Multi-agent pipeline coordination tests
 *
 * Tests for:
 *   - src/pipeline.ts state management (createPipeline, step lifecycle, context accumulation)
 *   - extractPlaybookCommands() pipeline command parsing (ELLIE:: pipeline)
 *
 * All tests are pure — no server, DB, or agent dispatch required.
 *
 * Coverage:
 *   - parseAgentSequence / parseStepDescriptions (Unicode + ASCII arrows)
 *   - createPipeline: step count, padding, status, registry
 *   - startCurrentStep: status transitions
 *   - completeCurrentStep: output capture, advancement, done detection
 *   - failCurrentStep: failure propagation
 *   - buildStepContext: accumulation from completed steps only
 *   - formatPipelineSummary: status markers
 *   - getPipelineState / getPipelineForTicket
 *   - extractPlaybookCommands: full pipeline parse round-trip
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  parseAgentSequence,
  parseStepDescriptions,
  createPipeline,
  startCurrentStep,
  completeCurrentStep,
  failCurrentStep,
  buildStepContext,
  formatPipelineSummary,
  getPipelineState,
  getPipelineForTicket,
  getAllPipelines,
  _resetPipelinesForTesting,
  type PipelineState,
} from "../src/pipeline.ts";
import { extractPlaybookCommands } from "../src/playbook.ts";

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  _resetPipelinesForTesting();
});

// ── parseAgentSequence ────────────────────────────────────────────────────────

describe("parseAgentSequence", () => {
  test("splits on Unicode arrow →", () => {
    expect(parseAgentSequence("dev→research→dev")).toEqual(["dev", "research", "dev"]);
  });

  test("splits on ASCII arrow ->", () => {
    expect(parseAgentSequence("dev->research->dev")).toEqual(["dev", "research", "dev"]);
  });

  test("normalises to lowercase", () => {
    expect(parseAgentSequence("Dev→Research→Strategy")).toEqual(["dev", "research", "strategy"]);
  });

  test("single agent returns single-element array", () => {
    expect(parseAgentSequence("dev")).toEqual(["dev"]);
  });

  test("trims whitespace around arrows", () => {
    expect(parseAgentSequence("dev → research")).toEqual(["dev", "research"]);
  });

  test("filters empty segments", () => {
    expect(parseAgentSequence("dev→→research")).toEqual(["dev", "research"]);
  });
});

// ── parseStepDescriptions ─────────────────────────────────────────────────────

describe("parseStepDescriptions", () => {
  test("splits on Unicode arrow →", () => {
    expect(parseStepDescriptions("implement→validate→finalize")).toEqual([
      "implement", "validate", "finalize",
    ]);
  });

  test("splits on ASCII arrow ->", () => {
    expect(parseStepDescriptions("implement->validate->finalize")).toEqual([
      "implement", "validate", "finalize",
    ]);
  });

  test("preserves original casing", () => {
    expect(parseStepDescriptions("Implement Feature→Run Tests")).toEqual([
      "Implement Feature", "Run Tests",
    ]);
  });

  test("single description returns single-element array", () => {
    expect(parseStepDescriptions("implement")).toEqual(["implement"]);
  });

  test("trims whitespace around arrows", () => {
    expect(parseStepDescriptions("step one → step two")).toEqual(["step one", "step two"]);
  });
});

// ── createPipeline ────────────────────────────────────────────────────────────

describe("createPipeline", () => {
  test("creates pipeline with correct step count", () => {
    const p = createPipeline("ELLIE-544", ["dev", "research"], ["implement", "validate"]);
    expect(p.steps).toHaveLength(2);
  });

  test("all steps start as pending", () => {
    const p = createPipeline("ELLIE-1", ["dev", "research", "dev"], ["a", "b", "c"]);
    expect(p.steps.every(s => s.status === "pending")).toBe(true);
  });

  test("currentStepIndex starts at 0", () => {
    const p = createPipeline("ELLIE-1", ["dev"], ["task"]);
    expect(p.currentStepIndex).toBe(0);
  });

  test("pipeline status starts as pending", () => {
    const p = createPipeline("ELLIE-1", ["dev"], ["task"]);
    expect(p.status).toBe("pending");
  });

  test("step agents and descriptions are assigned correctly", () => {
    const p = createPipeline("ELLIE-2", ["dev", "research"], ["implement", "validate"]);
    expect(p.steps[0].agent).toBe("dev");
    expect(p.steps[0].description).toBe("implement");
    expect(p.steps[1].agent).toBe("research");
    expect(p.steps[1].description).toBe("validate");
  });

  test("pads descriptions if fewer than agents", () => {
    const p = createPipeline("ELLIE-3", ["dev", "research", "dev"], ["implement"]);
    expect(p.steps[1].description).toBe("Step 2");
    expect(p.steps[2].description).toBe("Step 3");
  });

  test("ticketId is stored correctly", () => {
    const p = createPipeline("ELLIE-99", ["dev"], ["task"]);
    expect(p.ticketId).toBe("ELLIE-99");
  });

  test("uses provided id when given", () => {
    const p = createPipeline("ELLIE-1", ["dev"], ["task"], "fixed-id-123");
    expect(p.id).toBe("fixed-id-123");
  });

  test("throws when agents array is empty", () => {
    expect(() => createPipeline("ELLIE-1", [], [])).toThrow();
  });

  test("can be looked up by pipeline ID", () => {
    const p = createPipeline("ELLIE-10", ["dev"], ["task"]);
    expect(getPipelineState(p.id)).toBe(p);
  });

  test("can be looked up by ticket ID", () => {
    const p = createPipeline("ELLIE-11", ["dev"], ["task"]);
    expect(getPipelineForTicket("ELLIE-11")).toBe(p);
  });
});

// ── startCurrentStep ──────────────────────────────────────────────────────────

describe("startCurrentStep", () => {
  test("marks first step as running", () => {
    const p = createPipeline("ELLIE-20", ["dev", "research"], ["a", "b"]);
    startCurrentStep(p.id);
    expect(p.steps[0].status).toBe("running");
  });

  test("sets startedAt timestamp", () => {
    const now = Date.now();
    const p = createPipeline("ELLIE-20", ["dev"], ["a"]);
    startCurrentStep(p.id, now);
    expect(p.steps[0].startedAt).toBe(now);
  });

  test("transitions pipeline status to running", () => {
    const p = createPipeline("ELLIE-21", ["dev"], ["a"]);
    startCurrentStep(p.id);
    expect(p.status).toBe("running");
  });

  test("returns null for unknown pipeline ID", () => {
    expect(startCurrentStep("nonexistent")).toBeNull();
  });

  test("does not affect steps other than current", () => {
    const p = createPipeline("ELLIE-22", ["dev", "research"], ["a", "b"]);
    startCurrentStep(p.id);
    expect(p.steps[1].status).toBe("pending");
  });
});

// ── completeCurrentStep ───────────────────────────────────────────────────────

describe("completeCurrentStep", () => {
  test("marks current step as completed", () => {
    const p = createPipeline("ELLIE-30", ["dev", "research"], ["a", "b"]);
    startCurrentStep(p.id);
    completeCurrentStep(p.id, "done output");
    expect(p.steps[0].status).toBe("completed");
  });

  test("captures step output", () => {
    const p = createPipeline("ELLIE-31", ["dev", "research"], ["a", "b"]);
    startCurrentStep(p.id);
    completeCurrentStep(p.id, "my output here");
    expect(p.steps[0].output).toBe("my output here");
  });

  test("advances currentStepIndex", () => {
    const p = createPipeline("ELLIE-32", ["dev", "research"], ["a", "b"]);
    startCurrentStep(p.id);
    completeCurrentStep(p.id);
    expect(p.currentStepIndex).toBe(1);
  });

  test("returns nextStep for intermediate steps", () => {
    const p = createPipeline("ELLIE-33", ["dev", "research"], ["a", "b"]);
    startCurrentStep(p.id);
    const result = completeCurrentStep(p.id, "output");
    expect(result?.done).toBe(false);
    expect(result?.nextStep?.agent).toBe("research");
  });

  test("returns done=true when last step completes", () => {
    const p = createPipeline("ELLIE-34", ["dev"], ["a"]);
    startCurrentStep(p.id);
    const result = completeCurrentStep(p.id, "final output");
    expect(result?.done).toBe(true);
    expect(result?.nextStep).toBeNull();
  });

  test("sets pipeline status to completed when last step finishes", () => {
    const p = createPipeline("ELLIE-35", ["dev"], ["a"]);
    startCurrentStep(p.id);
    completeCurrentStep(p.id);
    expect(p.status).toBe("completed");
  });

  test("sets pipeline completedAt when last step finishes", () => {
    const now = 9_999_999;
    const p = createPipeline("ELLIE-36", ["dev"], ["a"]);
    startCurrentStep(p.id);
    completeCurrentStep(p.id, undefined, now);
    expect(p.completedAt).toBe(now);
  });

  test("three-step pipeline: advances through all steps", () => {
    const p = createPipeline("ELLIE-37", ["dev", "research", "dev"], ["a", "b", "c"]);

    startCurrentStep(p.id);
    const r1 = completeCurrentStep(p.id, "output1");
    expect(r1?.done).toBe(false);
    expect(p.currentStepIndex).toBe(1);

    startCurrentStep(p.id);
    const r2 = completeCurrentStep(p.id, "output2");
    expect(r2?.done).toBe(false);
    expect(p.currentStepIndex).toBe(2);

    startCurrentStep(p.id);
    const r3 = completeCurrentStep(p.id, "output3");
    expect(r3?.done).toBe(true);
    expect(p.status).toBe("completed");
  });

  test("returns null for unknown pipeline ID", () => {
    expect(completeCurrentStep("nonexistent")).toBeNull();
  });
});

// ── failCurrentStep ───────────────────────────────────────────────────────────

describe("failCurrentStep", () => {
  test("marks current step as failed", () => {
    const p = createPipeline("ELLIE-40", ["dev", "research"], ["a", "b"]);
    startCurrentStep(p.id);
    failCurrentStep(p.id, "timeout");
    expect(p.steps[0].status).toBe("failed");
  });

  test("records failure reason in step output", () => {
    const p = createPipeline("ELLIE-41", ["dev"], ["a"]);
    startCurrentStep(p.id);
    failCurrentStep(p.id, "network error");
    expect(p.steps[0].output).toContain("FAILED");
    expect(p.steps[0].output).toContain("network error");
  });

  test("marks pipeline status as failed", () => {
    const p = createPipeline("ELLIE-42", ["dev", "research"], ["a", "b"]);
    startCurrentStep(p.id);
    failCurrentStep(p.id);
    expect(p.status).toBe("failed");
  });

  test("subsequent steps remain pending after failure", () => {
    const p = createPipeline("ELLIE-43", ["dev", "research"], ["a", "b"]);
    startCurrentStep(p.id);
    failCurrentStep(p.id);
    expect(p.steps[1].status).toBe("pending");
  });

  test("returns null for unknown pipeline ID", () => {
    expect(failCurrentStep("nonexistent")).toBeNull();
  });
});

// ── buildStepContext ──────────────────────────────────────────────────────────

describe("buildStepContext", () => {
  test("returns empty string when no steps completed", () => {
    const p = createPipeline("ELLIE-50", ["dev", "research"], ["a", "b"]);
    expect(buildStepContext(p)).toBe("");
  });

  test("returns empty string when current step is first", () => {
    const p = createPipeline("ELLIE-51", ["dev", "research"], ["a", "b"]);
    startCurrentStep(p.id);
    expect(buildStepContext(p)).toBe("");
  });

  test("includes output from completed steps before current", () => {
    const p = createPipeline("ELLIE-52", ["dev", "research", "dev"], ["a", "b", "c"]);
    startCurrentStep(p.id);
    completeCurrentStep(p.id, "step 1 output here");

    const ctx = buildStepContext(p);
    expect(ctx).toContain("step 1 output here");
    expect(ctx).toContain("dev");
    expect(ctx).toContain("a");
  });

  test("includes outputs from all completed steps", () => {
    const p = createPipeline("ELLIE-53", ["dev", "research", "dev"], ["a", "b", "c"]);

    startCurrentStep(p.id);
    completeCurrentStep(p.id, "dev output");
    startCurrentStep(p.id);
    completeCurrentStep(p.id, "research output");

    const ctx = buildStepContext(p);
    expect(ctx).toContain("dev output");
    expect(ctx).toContain("research output");
  });

  test("excludes steps without output", () => {
    const p = createPipeline("ELLIE-54", ["dev", "research"], ["a", "b"]);
    startCurrentStep(p.id);
    completeCurrentStep(p.id); // no output

    const ctx = buildStepContext(p);
    expect(ctx).toBe(""); // no output to accumulate
  });

  test("context includes step number and agent label", () => {
    const p = createPipeline("ELLIE-55", ["dev", "research"], ["implement", "validate"]);
    startCurrentStep(p.id);
    completeCurrentStep(p.id, "implementation done");

    const ctx = buildStepContext(p);
    expect(ctx).toContain("Step 1");
    expect(ctx).toContain("dev");
    expect(ctx).toContain("implement");
  });
});

// ── formatPipelineSummary ─────────────────────────────────────────────────────

describe("formatPipelineSummary", () => {
  test("shows pending steps with ○", () => {
    const p = createPipeline("ELLIE-60", ["dev", "research"], ["a", "b"]);
    const summary = formatPipelineSummary(p);
    expect(summary).toContain("○");
  });

  test("shows running step with ▶", () => {
    const p = createPipeline("ELLIE-61", ["dev", "research"], ["a", "b"]);
    startCurrentStep(p.id);
    const summary = formatPipelineSummary(p);
    expect(summary).toContain("▶");
  });

  test("shows completed step with ✓", () => {
    const p = createPipeline("ELLIE-62", ["dev", "research"], ["a", "b"]);
    startCurrentStep(p.id);
    completeCurrentStep(p.id, "done");
    const summary = formatPipelineSummary(p);
    expect(summary).toContain("✓");
  });

  test("shows failed step with ✗", () => {
    const p = createPipeline("ELLIE-63", ["dev"], ["a"]);
    startCurrentStep(p.id);
    failCurrentStep(p.id);
    const summary = formatPipelineSummary(p);
    expect(summary).toContain("✗");
  });

  test("includes ticket ID in summary", () => {
    const p = createPipeline("ELLIE-64", ["dev"], ["a"]);
    expect(formatPipelineSummary(p)).toContain("ELLIE-64");
  });

  test("includes all agent names", () => {
    const p = createPipeline("ELLIE-65", ["dev", "research", "strategy"], ["a", "b", "c"]);
    const summary = formatPipelineSummary(p);
    expect(summary).toContain("dev");
    expect(summary).toContain("research");
    expect(summary).toContain("strategy");
  });
});

// ── registry functions ────────────────────────────────────────────────────────

describe("getPipelineState / getPipelineForTicket / getAllPipelines", () => {
  test("getPipelineState returns null for unknown ID", () => {
    expect(getPipelineState("unknown")).toBeNull();
  });

  test("getPipelineForTicket returns null when no pipeline for ticket", () => {
    expect(getPipelineForTicket("ELLIE-999")).toBeNull();
  });

  test("getAllPipelines returns all created pipelines", () => {
    createPipeline("ELLIE-70", ["dev"], ["a"]);
    createPipeline("ELLIE-71", ["research"], ["b"]);
    expect(getAllPipelines()).toHaveLength(2);
  });

  test("later pipeline for same ticket overwrites ticket index", () => {
    const p1 = createPipeline("ELLIE-72", ["dev"], ["a"], "pipe-1");
    const p2 = createPipeline("ELLIE-72", ["research"], ["b"], "pipe-2");
    // Latest one wins in the ticket index
    expect(getPipelineForTicket("ELLIE-72")).toBe(p2);
    // Both are still retrievable by ID
    expect(getPipelineState("pipe-1")).toBe(p1);
    expect(getPipelineState("pipe-2")).toBe(p2);
  });
});

// ── extractPlaybookCommands — pipeline (ELLIE-544) ────────────────────────────

describe("extractPlaybookCommands — pipeline (ELLIE-544)", () => {
  test("parses basic pipeline command", () => {
    const input = 'ELLIE:: pipeline ELLIE-544 dev→research→dev "implement→validate→finalize"';
    const { commands, cleanedText } = extractPlaybookCommands(input);

    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe("pipeline");
    expect(commands[0].ticketId).toBe("ELLIE-544");
    expect(commands[0].agents).toEqual(["dev", "research", "dev"]);
    expect(commands[0].pipelineSteps).toEqual(["implement", "validate", "finalize"]);
    expect(cleanedText).toBe("");
  });

  test("parses pipeline with ASCII arrows (->)", () => {
    const input = 'ELLIE:: pipeline ELLIE-1 dev->research "impl->validate"';
    const { commands } = extractPlaybookCommands(input);

    expect(commands[0].agents).toEqual(["dev", "research"]);
    expect(commands[0].pipelineSteps).toEqual(["impl", "validate"]);
  });

  test("agent names are normalised to lowercase", () => {
    const input = 'ELLIE:: pipeline ELLIE-2 Dev→Research "a→b"';
    const { commands } = extractPlaybookCommands(input);
    expect(commands[0].agents).toEqual(["dev", "research"]);
  });

  test("strips the tag and preserves surrounding text", () => {
    const input = [
      "Kicking off the pipeline now.",
      'ELLIE:: pipeline ELLIE-100 dev→research "impl→validate"',
      "The pipeline has been queued.",
    ].join("\n");
    const { commands, cleanedText } = extractPlaybookCommands(input);

    expect(commands).toHaveLength(1);
    expect(cleanedText).toContain("Kicking off the pipeline now.");
    expect(cleanedText).toContain("The pipeline has been queued.");
    expect(cleanedText).not.toContain("ELLIE::");
  });

  test("stores the raw matched text", () => {
    const raw = 'ELLIE:: pipeline ELLIE-200 dev→research "a→b"';
    const { commands } = extractPlaybookCommands(raw);
    expect(commands[0].raw).toBe(raw);
  });

  test("is case insensitive on the ELLIE:: prefix", () => {
    const { commands } = extractPlaybookCommands('ellie:: pipeline ELLIE-3 dev→research "a→b"');
    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe("pipeline");
  });

  test("pipeline alongside other commands", () => {
    const input = [
      "ELLIE:: send ELLIE-500 to dev",
      'ELLIE:: pipeline ELLIE-501 dev→research "impl→validate"',
    ].join("\n");
    const { commands } = extractPlaybookCommands(input);

    expect(commands).toHaveLength(2);
    const types = commands.map(c => c.type);
    expect(types).toContain("send");
    expect(types).toContain("pipeline");
  });

  test("single-agent pipeline parses correctly", () => {
    const input = 'ELLIE:: pipeline ELLIE-4 dev "implement feature"';
    const { commands } = extractPlaybookCommands(input);

    expect(commands[0].agents).toEqual(["dev"]);
    expect(commands[0].pipelineSteps).toEqual(["implement feature"]);
  });

  test("step descriptions with spaces are preserved", () => {
    const input = 'ELLIE:: pipeline ELLIE-5 dev→research "implement feature→validate and test"';
    const { commands } = extractPlaybookCommands(input);
    expect(commands[0].pipelineSteps).toEqual(["implement feature", "validate and test"]);
  });

  test("ELLIE__ neutralised tags are ignored", () => {
    const { commands } = extractPlaybookCommands('ELLIE__ pipeline ELLIE-6 dev→research "a→b"');
    expect(commands).toHaveLength(0);
  });
});
