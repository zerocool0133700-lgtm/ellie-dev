import { describe, test, expect, mock } from "bun:test";

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: mock(), warn: mock(), error: mock(), debug: mock() }) },
}));

import {
  filterRosterByThread,
  buildCrossThreadAwareness,
} from "../src/thread-context.ts";

describe("thread-context", () => {
  test("filterRosterByThread filters to thread participants only", () => {
    const fullRoster = ["james", "kate", "alan", "brian", "jason", "amy", "marcus", "ellie"];
    const threadAgents = ["james", "brian", "ellie"];
    const filtered = filterRosterByThread(fullRoster, threadAgents);
    expect(filtered).toEqual(["james", "brian", "ellie"]);
  });

  test("filterRosterByThread returns full roster if no thread filter", () => {
    const fullRoster = ["james", "kate"];
    const filtered = filterRosterByThread(fullRoster, null);
    expect(filtered).toEqual(["james", "kate"]);
  });

  test("buildCrossThreadAwareness returns null for empty sibling records", () => {
    const result = buildCrossThreadAwareness("james", "thread-1", []);
    expect(result).toBeNull();
  });

  test("buildCrossThreadAwareness builds awareness string from sibling records", () => {
    const siblings = [
      { thread_id: "thread-2", thread_name: "ELLIE-500 work", context_anchors: "Working on v2 API endpoint, file: src/api/v2.ts" },
    ];
    const result = buildCrossThreadAwareness("james", "thread-1", siblings);
    expect(result).not.toBeNull();
    expect(result).toContain("ELLIE-500 work");
    expect(result).toContain("v2 API endpoint");
  });
});
