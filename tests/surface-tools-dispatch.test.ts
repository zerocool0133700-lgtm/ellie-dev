import { describe, test, expect } from "bun:test";
import { runCoordinatorLoop, type CoordinatorOpts } from "../src/coordinator";

const stubDeps = {
  sendMessage: async () => {},
  readForest: async () => "",
  readPlane: async () => "",
  readMemory: async () => "",
  readSessions: async () => "",
  getWorkingMemorySummary: async () => "",
  updateWorkingMemory: async () => {},
  promoteToForest: async () => {},
  logEnvelope: async () => {},
};

describe("Coordinator surface tool dispatch", () => {
  test("collects surface_actions when surface tools are called", async () => {
    // Use _testResponses to inject a fake LLM response that calls propose_create_folder
    const fakeResponses = [
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "propose_create_folder",
            input: { paths: ["research/quantum/"], reason: "test" },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Proposal queued." }],
        usage: { input_tokens: 5, output_tokens: 5 },
      },
    ];

    const result = await runCoordinatorLoop({
      message: "create a folder for quantum research",
      channel: "ellie-chat",
      userId: "test",
      foundation: "test",
      systemPrompt: "test",
      model: "claude-haiku-4-5",
      agentRoster: ["ellie"],
      deps: stubDeps as any,
      surfaceContext: {
        surface_id: "knowledge-river",
        surface_origin: "panel-test",
        selection: { folder: null, folder_file_count: 0, folder_subfolder_count: 0, last_files: [] },
        ingestion_state: { in_progress: false, queued: 0, last_ingested_at: null },
        river_summary: { total_docs: 0, total_folders: 0 },
      },
      _testResponses: fakeResponses,
    } as CoordinatorOpts);

    expect(result.surfaceActions).toBeDefined();
    expect(result.surfaceActions).toHaveLength(1);
    expect(result.surfaceActions![0].tool).toBe("propose_create_folder");
    expect(result.surfaceActions![0].args.paths).toEqual(["research/quantum/"]);
    expect(result.surfaceActions![0].proposal_id).toMatch(/^prop_/);
  });

  test("surfaceActions is empty array when no surface tools called", async () => {
    const fakeResponses = [
      {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Hello!" }],
        usage: { input_tokens: 5, output_tokens: 5 },
      },
    ];

    const result = await runCoordinatorLoop({
      message: "hi",
      channel: "ellie-chat",
      userId: "test",
      foundation: "test",
      systemPrompt: "test",
      model: "claude-haiku-4-5",
      agentRoster: ["ellie"],
      deps: stubDeps as any,
      _testResponses: fakeResponses,
    } as CoordinatorOpts);

    expect(result.surfaceActions).toBeDefined();
    expect(result.surfaceActions).toHaveLength(0);
  });
});
