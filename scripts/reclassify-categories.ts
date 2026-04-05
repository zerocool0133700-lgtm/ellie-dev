/**
 * One-time: Reclassify memories with category 'general' using the deep classifier.
 * Only updates category — does NOT change tier, confidence, or weight.
 *
 * Usage: bun run scripts/reclassify-categories.ts [--dry-run] [--limit=500]
 */

import forestSql from "../../ellie-forest/src/db.ts";
import Anthropic from "@anthropic-ai/sdk";
import { log } from "../src/logger.ts";

const logger = log.child("category-reclassify");
const dryRun = process.argv.includes("--dry-run");
const limitArg = process.argv.find(a => a.startsWith("--limit="));
const limit = limitArg ? parseInt(limitArg.split("=")[1]) : 99999;

const VALID_CATEGORIES = [
  "health", "fitness", "relationships", "identity", "financial",
  "learning", "mental_health", "work", "hobbies", "family",
  "spirituality", "general",
];

const anthropic = new Anthropic();

async function classifyCategory(content: string): Promise<string> {
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
      messages: [{
        role: "user",
        content: `Classify this memory into exactly one category for a personal AI assistant.

Memory: "${content.slice(0, 500)}"

Categories: health, fitness, relationships, identity, financial, learning, mental_health, work, hobbies, family, spirituality, general

Rules:
- "work" = software engineering, technical, deployment, code, architecture, system design
- "identity" = who someone is, their values, beliefs, personality, how they think
- "family" = family members, family relationships, family events
- "learning" = education, studying, courses, skill development
- "relationships" = interpersonal dynamics (not family)
- Use "general" ONLY if nothing else fits

Return ONLY the category word, nothing else.`,
      }],
    });

    const text = response.content
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { type: string; text: string }) => b.text)
      .join("")
      .trim()
      .toLowerCase()
      .replace(/[^a-z_]/g, "");

    return VALID_CATEGORIES.includes(text) ? text : "general";
  } catch {
    return "general";
  }
}

async function main() {
  const memories = await forestSql`
    SELECT id, content, category::text
    FROM shared_memories
    WHERE status = 'active'
      AND category = 'general'
    ORDER BY weight DESC
    LIMIT ${limit}
  `;

  console.log(`Found ${memories.length} 'general' category memories to reclassify`);

  if (dryRun) {
    console.log("(dry run — no changes)");
    return;
  }

  const stats: Record<string, number> = {};
  let reclassified = 0;
  let unchanged = 0;

  for (const mem of memories) {
    const category = await classifyCategory(mem.content);
    stats[category] = (stats[category] || 0) + 1;

    if (category !== "general") {
      await forestSql`
        UPDATE shared_memories SET category = ${category}, updated_at = NOW()
        WHERE id = ${mem.id}
      `;
      reclassified++;
    } else {
      unchanged++;
    }

    const total = reclassified + unchanged;
    if (total % 100 === 0) {
      console.log(`  ... ${total}/${memories.length} (${reclassified} reclassified)`);
    }
  }

  console.log(`\nDone: ${reclassified} reclassified, ${unchanged} stayed general`);
  console.log("Distribution:");
  for (const [cat, count] of Object.entries(stats).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${count}`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error("Failed:", err);
  process.exit(1);
});
