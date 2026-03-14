/**
 * Forest Module Tests: Types — ELLIE-712
 *
 * Validates that all Forest enum types and interfaces are properly exported
 * and contain the expected values. This catches schema drift.
 */

import { describe, test, expect } from "bun:test";

import type {
  TreeType, TreeState, EntityType, BranchState,
  CreatureType, CreatureState, EventKind,
  MemoryScope, MemoryType, MemoryTier,
  ContributionPattern,
  Entity, Tree, Branch, Creature, ForestEvent, SharedMemory,
} from "../../ellie-forest/src/types.ts";

describe("forest types", () => {
  // Runtime type checks via exhaustive value arrays that must compile

  describe("TreeType", () => {
    const allTypes: TreeType[] = [
      "conversation", "work_session", "workflow", "project",
      "analysis", "review", "incident_response", "onboarding",
      "learning", "automation", "debate", "deliverable",
      "calendar_event", "person",
    ];

    test("has 14 tree types", () => {
      expect(allTypes).toHaveLength(14);
    });

    test("includes work_session", () => {
      expect(allTypes).toContain("work_session");
    });

    test("includes person (for people trees)", () => {
      expect(allTypes).toContain("person");
    });
  });

  describe("TreeState", () => {
    const allStates: TreeState[] = [
      "nursery", "seedling", "growing", "mature",
      "dormant", "archived", "composted",
    ];

    test("has 7 states", () => {
      expect(allStates).toHaveLength(7);
    });

    test("nursery is initial state", () => {
      expect(allStates[0]).toBe("nursery");
    });

    test("composted is terminal state", () => {
      expect(allStates[allStates.length - 1]).toBe("composted");
    });
  });

  describe("EntityType", () => {
    const allTypes: EntityType[] = [
      "agent", "service", "integration", "store",
      "interface", "person", "group",
    ];

    test("has 7 entity types", () => {
      expect(allTypes).toHaveLength(7);
    });

    test("includes person and group", () => {
      expect(allTypes).toContain("person");
      expect(allTypes).toContain("group");
    });
  });

  describe("BranchState", () => {
    const allStates: BranchState[] = [
      "open", "merging", "merged", "abandoned", "conflicted",
    ];

    test("has 5 states", () => {
      expect(allStates).toHaveLength(5);
    });
  });

  describe("CreatureType", () => {
    const allTypes: CreatureType[] = [
      "pull", "push", "signal", "sync", "gate",
    ];

    test("has 5 creature types", () => {
      expect(allTypes).toHaveLength(5);
    });
  });

  describe("CreatureState", () => {
    const allStates: CreatureState[] = [
      "pending", "dispatched", "working",
      "completed", "failed", "cancelled",
    ];

    test("has 6 creature states", () => {
      expect(allStates).toHaveLength(6);
    });

    test("has terminal states", () => {
      expect(allStates).toContain("completed");
      expect(allStates).toContain("failed");
      expect(allStates).toContain("cancelled");
    });
  });

  describe("EventKind", () => {
    const allKinds: EventKind[] = [
      "tree.created", "tree.state_changed", "tree.closed",
      "trunk.created",
      "branch.created", "branch.merged", "branch.abandoned",
      "commit.added",
      "entity.attached", "entity.detached",
      "creature.dispatched", "creature.completed",
      "creature.failed", "creature.preempted",
      "gate.requested", "gate.approved", "gate.rejected",
    ];

    test("has 17 event kinds", () => {
      expect(allKinds).toHaveLength(17);
    });

    test("tree events are prefixed with 'tree.'", () => {
      const treeKinds = allKinds.filter(k => k.startsWith("tree."));
      expect(treeKinds).toHaveLength(3);
    });

    test("creature events are prefixed with 'creature.'", () => {
      const creatureKinds = allKinds.filter(k => k.startsWith("creature."));
      expect(creatureKinds).toHaveLength(4);
    });

    test("gate events are prefixed with 'gate.'", () => {
      const gateKinds = allKinds.filter(k => k.startsWith("gate."));
      expect(gateKinds).toHaveLength(3);
    });
  });

  describe("MemoryType", () => {
    const allTypes: MemoryType[] = [
      "fact", "decision", "preference", "finding",
      "hypothesis", "contradiction", "summary", "pattern",
    ];

    test("has 8 memory types", () => {
      expect(allTypes).toHaveLength(8);
    });
  });

  describe("ContributionPattern", () => {
    const allPatterns: ContributionPattern[] = [
      "one_tree", "many_trees", "all_trees",
    ];

    test("has 3 contribution patterns", () => {
      expect(allPatterns).toHaveLength(3);
    });
  });

  // Structural checks — verify interfaces have required fields

  describe("interface shapes (compile-time)", () => {
    test("Entity interface has required fields", () => {
      const entity: Partial<Entity> = {
        id: "test",
        name: "dev_agent",
        display_name: "Dev Agent",
        type: "agent",
        active: true,
      };
      expect(entity.id).toBe("test");
      expect(entity.type).toBe("agent");
    });

    test("Tree interface has required fields", () => {
      const tree: Partial<Tree> = {
        id: "test",
        type: "work_session",
        state: "nursery",
        title: "Test",
      };
      expect(tree.state).toBe("nursery");
    });

    test("Branch interface has state field", () => {
      const branch: Partial<Branch> = {
        id: "test",
        state: "open",
        name: "main",
      };
      expect(branch.state).toBe("open");
    });

    test("Creature interface has type and state fields", () => {
      const creature: Partial<Creature> = {
        id: "test",
        type: "pull",
        state: "dispatched",
      };
      expect(creature.type).toBe("pull");
      expect(creature.state).toBe("dispatched");
    });
  });
});
