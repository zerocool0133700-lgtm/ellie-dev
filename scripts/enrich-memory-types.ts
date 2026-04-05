/**
 * Enrich memory types: reclassify 'fact' memories into fact/finding/decision/hypothesis.
 * Uses Haiku for classification.
 *
 * Usage: bun run scripts/enrich-memory-types.ts [--dry-run] [--limit=500]
 */

import forestSql from "../../ellie-forest/src/db.ts";
import Anthropic from "@anthropic-ai/sdk";

const dryRun = process.argv.includes("--dry-run");
const limitArg = process.argv.find(a => a.startsWith("--limit="));
const limit = limitArg ? parseInt(limitArg.split("=")[1]) : 99999;

const anthropic = new Anthropic();

const VALID_TYPES = ["fact", "finding", "decision", "hypothesis"];

async function classifyType(content: string): Promise<string> {
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 30,
      messages: [{
        role: "user",
        content: `Classify this memory's type.

Memory: "${content.slice(0, 400)}"

Types:
- fact: A stable truth or piece of information (e.g., "Relay runs on port 3001")
- finding: A discovery or observation from investigation (e.g., "Found that RLS policies block anon access")
- decision: A choice that was made with reasoning (e.g., "Chose PostgreSQL over MongoDB because...")
- hypothesis: An educated guess needing validation (e.g., "The crash may be caused by...")

Return ONLY the type word.`,
      }],
    });

    const text = response.content
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { type: string; text: string }) => b.text)
      .join("")
      .trim()
      .toLowerCase();

    return VALID_TYPES.includes(text) ? text : "fact";
  } catch {
    return "fact";
  }
}

async function main() {
  const memories = await forestSql`
    SELECT id, content
    FROM shared_memories
    WHERE status = 'active' AND type = 'fact'
    ORDER BY weight DESC
    LIMIT ${limit}
  `;

  console.log(`Found ${memories.length} 'fact' memories to enrich`);
  if (dryRun) {
    console.log("(dry run)");
    return;
  }

  const stats: Record<string, number> = {};
  let enriched = 0;

  for (const mem of memories) {
    const newType = await classifyType(mem.content);
    stats[newType] = (stats[newType] || 0) + 1;

    if (newType !== "fact") {
      await forestSql`
        UPDATE shared_memories SET type = ${newType}, updated_at = NOW()
        WHERE id = ${mem.id}
      `;
      enriched++;
    }

    const total = enriched + (stats["fact"] || 0);
    if (total % 100 === 0) {
      console.log(`  ... ${total}/${memories.length} (${enriched} enriched)`);
    }
  }

  console.log(`\nDone: ${enriched} enriched from 'fact'`);
  console.log("Type distribution:");
  for (const [type, count] of Object.entries(stats).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error("Failed:", err);
  process.exit(1);
});
