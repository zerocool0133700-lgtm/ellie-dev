import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import sql from "../../ellie-forest/src/db";

// Test creature ID — will be created in beforeAll
let testCreatureId: string;

beforeAll(async () => {
  // Create a test entity to use as a creature
  const [entity] = await sql`
    INSERT INTO entities (name, display_name, type, active)
    VALUES ('test-creature-skills-arch', 'Test Creature Skills Arch', 'agent', true)
    ON CONFLICT (name) DO UPDATE SET active = true
    RETURNING id
  `;
  testCreatureId = entity.id;

  // Seed some skills
  await sql`
    INSERT INTO creature_skills (creature_id, skill_name, added_by)
    VALUES
      (${testCreatureId}, 'github', 'test'),
      (${testCreatureId}, 'plane', 'test'),
      (${testCreatureId}, 'ums-calendar', 'test')
    ON CONFLICT DO NOTHING
  `;
});

afterAll(async () => {
  await sql`DELETE FROM creature_skills WHERE creature_id = ${testCreatureId}`;
  await sql`DELETE FROM entities WHERE id = ${testCreatureId}`;
  await sql.end();
});

describe("creature-skills", () => {
  it("getSkillsForCreature returns skill names for a creature", async () => {
    const { getSkillsForCreature } = await import("../../ellie-forest/src/creature-skills");
    const skills = await getSkillsForCreature(testCreatureId);
    expect(skills).toContain("github");
    expect(skills).toContain("plane");
    expect(skills).toContain("ums-calendar");
    expect(skills.length).toBe(3);
  });

  it("getSkillsForCreature returns empty array for unknown creature", async () => {
    const { getSkillsForCreature } = await import("../../ellie-forest/src/creature-skills");
    const skills = await getSkillsForCreature("00000000-0000-0000-0000-000000000000");
    expect(skills).toEqual([]);
  });

  it("addSkillToCreature adds a new skill", async () => {
    const { addSkillToCreature, getSkillsForCreature } = await import("../../ellie-forest/src/creature-skills");
    await addSkillToCreature(testCreatureId, "forest", "test");
    const skills = await getSkillsForCreature(testCreatureId);
    expect(skills).toContain("forest");
  });

  it("removeSkillFromCreature removes a skill", async () => {
    const { removeSkillFromCreature, getSkillsForCreature } = await import("../../ellie-forest/src/creature-skills");
    await removeSkillFromCreature(testCreatureId, "forest");
    const skills = await getSkillsForCreature(testCreatureId);
    expect(skills).not.toContain("forest");
  });

  it("getDefaultSkillsForArchetype returns archetype defaults", async () => {
    const { getDefaultSkillsForArchetype } = await import("../../ellie-forest/src/creature-skills");
    // Seed a default
    await sql`
      INSERT INTO archetype_default_skills (archetype, skill_name)
      VALUES ('test-arch', 'github'), ('test-arch', 'plane')
      ON CONFLICT DO NOTHING
    `;
    const defaults = await getDefaultSkillsForArchetype("test-arch");
    expect(defaults).toContain("github");
    expect(defaults).toContain("plane");
    // Cleanup
    await sql`DELETE FROM archetype_default_skills WHERE archetype = 'test-arch'`;
  });

  it("resolveSkillsForAgent returns null for null creature_id", async () => {
    const { resolveSkillsForAgent } = await import("../../ellie-forest/src/creature-skills");
    const result = await resolveSkillsForAgent(null);
    expect(result).toBeNull();
  });

  it("resolveSkillsForAgent returns skills for valid creature_id", async () => {
    const { resolveSkillsForAgent } = await import("../../ellie-forest/src/creature-skills");
    const skills = await resolveSkillsForAgent(testCreatureId);
    expect(skills).toContain("github");
    expect(skills).toContain("plane");
    expect(skills).toContain("ums-calendar");
  });
});
