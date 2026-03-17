/**
 * ELLIE-836 + ELLIE-838: Workflow engine + 3-step integration test
 *
 * Tests the full workflow lifecycle: research → dev → critic
 * with checkpoint persistence, message validation, and failure handling.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { runWorkflow, type WorkflowEvent, type StepExecutor } from "../src/workflow-engine.ts";
import { getInstance, getCheckpoints } from "../src/workflow-checkpoint.ts";
import { parseWorkflowYaml, type WorkflowConfig } from "../src/workflow-config.ts";
import { buildContractRegistry, type AgentMessageContract } from "../src/workflow-message-types.ts";
import { parseRaciMatrix } from "../src/workflow-raci.ts";
import { parseArchetype } from "../src/archetype-schema.ts";

const TEST_DB = "ellie-forest-test";
let sql: any;
const createdIds: string[] = [];

beforeAll(async () => {
  const postgres = (await import("postgres")).default;
  sql = postgres({ database: TEST_DB, host: "/var/run/postgresql", max: 3 });
});

afterAll(async () => {
  for (const id of createdIds) {
    await sql`DELETE FROM workflow_checkpoints WHERE workflow_id = ${id}`.catch(() => {});
    await sql`DELETE FROM workflow_messages WHERE workflow_id = ${id}`.catch(() => {});
    await sql`DELETE FROM workflow_instances WHERE id = ${id}`.catch(() => {});
  }
  if (sql) await sql.end();
});

// ── Test fixtures ────────────────────────────────────────────────

const RESEARCH_ARCHETYPE = parseArchetype(`---
species: owl
cognitive_style: "breadth-first"
produces: [finding, report]
consumes: [direction, approval]
---
## Cognitive Style
Test.
## Communication
Test.
## Anti-Patterns
Test.
`)!;

const DEV_ARCHETYPE = parseArchetype(`---
species: ant
cognitive_style: "depth-first"
produces: [finding, checkpoint, status_update]
consumes: [direction, finding]
---
## Cognitive Style
Test.
## Communication
Test.
## Anti-Patterns
Test.
`)!;

const CRITIC_ARCHETYPE = parseArchetype(`---
species: bee
cognitive_style: "cross-pollination"
produces: [review, approval, rejection]
consumes: [checkpoint, finding]
---
## Cognitive Style
Test.
## Communication
Test.
## Anti-Patterns
Test.
`)!;

const registry = buildContractRegistry(new Map([
  ["research", RESEARCH_ARCHETYPE],
  ["dev", DEV_ARCHETYPE],
  ["critic", CRITIC_ARCHETYPE],
]));

const raciMatrix = parseRaciMatrix(`
workflow: test_pipeline
  research: R, P
  dev: P
  critic: A
  Dave: D
`);

const THREE_STEP_CONFIG: WorkflowConfig = {
  name: "test_pipeline",
  description: "Research → Dev → Critic",
  steps: [
    { agent: "research", action: "investigate", instruction: "Research the topic", timeout_seconds: 5, produces: "finding" },
    { agent: "dev", action: "implement", instruction: "Implement based on findings", timeout_seconds: 5, consumes: "finding", produces: "checkpoint" },
    { agent: "critic", action: "review", instruction: "Review the implementation", timeout_seconds: 5, consumes: "checkpoint", produces: "review" },
  ],
};

// ── Tests ────────────────────────────────────────────────────────

describe("ELLIE-836 + ELLIE-838: Workflow engine integration", () => {

  describe("3-step workflow: research → dev → critic", () => {
    it("executes all steps successfully", async () => {
      const executor: StepExecutor = async (agent, instruction) => {
        return { output: `${agent} completed: ${instruction.slice(0, 30)}` };
      };

      const { instance, events } = await runWorkflow({
        sql,
        config: THREE_STEP_CONFIG,
        executor,
        raciMatrix,
        contractRegistry: registry,
        workItemId: "ELLIE-TEST-838",
      });
      createdIds.push(instance.id);

      expect(instance.status).toBe("completed");

      // Verify events
      const eventTypes = events.map(e => e.type);
      expect(eventTypes).toContain("workflow.started");
      expect(eventTypes).toContain("workflow.completed");
      expect(eventTypes.filter(t => t === "workflow.step_started").length).toBe(3);
      expect(eventTypes.filter(t => t === "workflow.step_completed").length).toBe(3);
    });

    it("creates checkpoints for each step", async () => {
      const executor: StepExecutor = async (agent) => ({ output: `${agent} done` });

      const { instance } = await runWorkflow({
        sql,
        config: THREE_STEP_CONFIG,
        executor,
        workItemId: "ELLIE-TEST-838-CP",
      });
      createdIds.push(instance.id);

      const checkpoints = await getCheckpoints(sql, instance.id);
      expect(checkpoints.length).toBe(3);
      expect(checkpoints[0].agent).toBe("research");
      expect(checkpoints[0].status).toBe("completed");
      expect(checkpoints[1].agent).toBe("dev");
      expect(checkpoints[1].status).toBe("completed");
      expect(checkpoints[2].agent).toBe("critic");
      expect(checkpoints[2].status).toBe("completed");
    });

    it("passes output from step N to step N+1", async () => {
      const receivedInputs: Record<string, unknown>[] = [];
      const executor: StepExecutor = async (agent, _instruction, input) => {
        receivedInputs.push(input ?? {});
        return { output: `${agent} output data` };
      };

      const { instance } = await runWorkflow({
        sql,
        config: THREE_STEP_CONFIG,
        executor,
        workItemId: "ELLIE-TEST-838-CHAIN",
      });
      createdIds.push(instance.id);

      // Step 0 (research) gets empty input
      expect(receivedInputs[0]).toEqual({});
      // Step 1 (dev) gets research output
      expect((receivedInputs[1] as any).text).toContain("research output");
      // Step 2 (critic) gets dev output
      expect((receivedInputs[2] as any).text).toContain("dev output");
    });
  });

  describe("failure handling", () => {
    it("escalates on step failure (default)", async () => {
      let callCount = 0;
      const executor: StepExecutor = async (agent) => {
        callCount++;
        if (agent === "dev") throw new Error("Build failed");
        return { output: `${agent} done` };
      };

      const { instance, events } = await runWorkflow({
        sql,
        config: THREE_STEP_CONFIG,
        executor,
        raciMatrix,
        workItemId: "ELLIE-TEST-838-FAIL",
      });
      createdIds.push(instance.id);

      expect(instance.status).toBe("failed");
      expect(events.some(e => e.type === "workflow.escalated")).toBe(true);
      expect(events.some(e => e.type === "workflow.step_failed")).toBe(true);

      // Critic step should not have been reached
      const checkpoints = await getCheckpoints(sql, instance.id);
      const criticCp = checkpoints.find(cp => cp.agent === "critic");
      expect(criticCp).toBeUndefined();
    });

    it("retries once on failure with on_failure=retry", async () => {
      let devAttempts = 0;
      const retryConfig: WorkflowConfig = {
        name: "retry_test",
        description: "Test retry",
        steps: [
          { agent: "dev", action: "build", instruction: "Build it", timeout_seconds: 5, on_failure: "retry" },
        ],
      };

      const executor: StepExecutor = async () => {
        devAttempts++;
        if (devAttempts === 1) throw new Error("First attempt failed");
        return { output: "Success on retry" };
      };

      const { instance } = await runWorkflow({
        sql,
        config: retryConfig,
        executor,
        workItemId: "ELLIE-TEST-838-RETRY",
      });
      createdIds.push(instance.id);

      expect(instance.status).toBe("completed");
      expect(devAttempts).toBe(2);
    });

    it("skips step with on_failure=skip", async () => {
      const skipConfig: WorkflowConfig = {
        name: "skip_test",
        description: "Test skip",
        steps: [
          { agent: "research", action: "find", instruction: "Research", timeout_seconds: 5, on_failure: "skip" },
          { agent: "dev", action: "build", instruction: "Build anyway", timeout_seconds: 5 },
        ],
      };

      const executor: StepExecutor = async (agent) => {
        if (agent === "research") throw new Error("Research failed");
        return { output: "Built successfully" };
      };

      const { instance, events } = await runWorkflow({
        sql,
        config: skipConfig,
        executor,
        workItemId: "ELLIE-TEST-838-SKIP",
      });
      createdIds.push(instance.id);

      expect(instance.status).toBe("completed");
      expect(events.some(e => e.type === "workflow.step_skipped")).toBe(true);
    });
  });

  describe("timeout handling", () => {
    it("times out a slow step", async () => {
      const timeoutConfig: WorkflowConfig = {
        name: "timeout_test",
        description: "Test timeout",
        steps: [
          { agent: "dev", action: "slow", instruction: "Take forever", timeout_seconds: 1 },
        ],
      };

      const executor: StepExecutor = async () => {
        await new Promise(r => setTimeout(r, 3000));
        return { output: "Too late" };
      };

      const { instance, events } = await runWorkflow({
        sql,
        config: timeoutConfig,
        executor,
        workItemId: "ELLIE-TEST-838-TIMEOUT",
      });
      createdIds.push(instance.id);

      expect(instance.status).toBe("failed");
      expect(events.some(e => e.type === "workflow.step_timeout")).toBe(true);
    }, 10000);
  });

  describe("observability (ELLIE-838)", () => {
    it("emits events for all state transitions", async () => {
      const collectedEvents: WorkflowEvent[] = [];
      const executor: StepExecutor = async (agent) => ({ output: `${agent} done` });

      await runWorkflow({
        sql,
        config: THREE_STEP_CONFIG,
        executor,
        workItemId: "ELLIE-TEST-838-OBS",
        onEvent: (event) => { collectedEvents.push(event); },
      }).then(r => { createdIds.push(r.instance.id); });

      // Verify complete event trace
      expect(collectedEvents[0].type).toBe("workflow.started");
      expect(collectedEvents[collectedEvents.length - 1].type).toBe("workflow.completed");

      // Every event has timestamp and workflow_id
      for (const event of collectedEvents) {
        expect(event.timestamp).toBeTruthy();
        expect(event.workflow_id).toBeTruthy();
      }
    });

    it("events include agent and step info for step events", async () => {
      const events: WorkflowEvent[] = [];
      const executor: StepExecutor = async (agent) => ({ output: `${agent} done` });

      await runWorkflow({
        sql,
        config: THREE_STEP_CONFIG,
        executor,
        workItemId: "ELLIE-TEST-838-OBS2",
        onEvent: (e) => { events.push(e); },
      }).then(r => { createdIds.push(r.instance.id); });

      const stepEvents = events.filter(e => e.type.startsWith("workflow.step_"));
      for (const event of stepEvents) {
        expect(event.agent).toBeTruthy();
        expect(event.step).toBeDefined();
      }
    });
  });
});
