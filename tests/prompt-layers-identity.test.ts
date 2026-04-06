import { describe, test, expect, beforeEach } from "bun:test";
import {
  loadIdentityDocs,
  buildSkillSummary,
  renderIdentityBlock,
  _injectIdentityForTesting,
  _clearIdentityCacheForTesting,
} from "../src/prompt-layers/identity";

describe("Layer 1: Identity", () => {
  beforeEach(() => {
    _clearIdentityCacheForTesting();
  });

  test("loadIdentityDocs loads all four documents", async () => {
    const docs = await loadIdentityDocs();
    expect(docs.soul).toContain("patient teacher");
    expect(docs.user).toContain("Dave");
    expect(docs.identity).toContain("Ellie");
    expect(docs.relationship).toContain("partnership");
  });

  test("loadIdentityDocs caches on second call", async () => {
    const docs1 = await loadIdentityDocs();
    const docs2 = await loadIdentityDocs();
    expect(docs1).toBe(docs2); // same reference = cached
  });

  test("buildSkillSummary produces compact list", () => {
    const entries = [
      { name: "plane", triggers: ["check plane"], file: "skills/plane/SKILL.md", description: "Manage Plane tickets" },
      { name: "forest", triggers: ["search forest"], file: "skills/forest/SKILL.md", description: "Query the knowledge Forest" },
    ];
    const summary = buildSkillSummary(entries);
    expect(summary).toContain("plane");
    expect(summary).toContain("forest");
    expect(summary).toContain("Manage Plane tickets");
    expect(summary.length).toBeLessThan(500);
  });

  test("renderIdentityBlock combines all sections under 4KB", async () => {
    const block = await renderIdentityBlock();
    expect(block).toContain("IDENTITY");
    expect(block).toContain("Dave");
    expect(block).toContain("Ellie");
    expect(new TextEncoder().encode(block).length).toBeLessThan(4096);
  });

  test("_injectIdentityForTesting overrides loaded docs", async () => {
    _injectIdentityForTesting({
      soul: "test soul",
      identity: "test identity",
      user: "test user",
      relationship: "test relationship",
      skillSummary: "test skills",
    });
    const block = await renderIdentityBlock();
    expect(block).toContain("test soul");
    expect(block).toContain("test user");
  });
});
