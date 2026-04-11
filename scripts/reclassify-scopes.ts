/**
 * LLM-assisted scope re-routing for memories stuck at scope '2' (Projects root).
 * Uses Haiku to determine the best sub-scope for each memory.
 *
 * Usage: bun run scripts/reclassify-scopes.ts [--dry-run] [--limit=500]
 */

import forestSql from "../../ellie-forest/src/db.ts";
import Anthropic from "@anthropic-ai/sdk";

const dryRun = process.argv.includes("--dry-run");
const limitArg = process.argv.find(a => a.startsWith("--limit="));
const limit = limitArg ? parseInt(limitArg.split("=")[1]) : 99999;

const anthropic = new Anthropic();

// Simplified scope menu for the LLM — don't overwhelm with 165 options
const SCOPE_MENU = `Project scopes (code/tech):
  2/1 = ellie-dev (relay, agents, chat pipeline, integrations)
  2/1/1 = relay (HTTP server, WebSocket, channels)
  2/1/2 = agents (agent router, profiles, orchestration, dispatch)
  2/1/3 = memory (memory system, graduation, dedup, tiers)
  2/1/4 = integrations (Telegram, Google Chat, Discord, Slack)
  2/1/5 = context (context builder, pipeline, sources)
  2/2 = ellie-forest (Forest library, trees, creatures, knowledge)
  2/2/4 = shared-memory (shared_memories, weight, search)
  2/3 = ellie-home (dashboard, Nuxt, UI)
  2/4 = ellie-os-app (mobile app, desktop app)

Ellie scopes (about Ellie herself):
  E/1 = Soul (Ellie's personality, voice, how she communicates)
  E/4/1 = Dave relationship (how Ellie relates to Dave)
  E/4/1/1 = Dave profile (what Ellie knows about Dave as a person)
  E/5/3 = accessibility (dyslexia, learning disability, accessible design)

Dave's personal scopes:
  Y/1 = Identity (Dave's values, beliefs, who he is)
  Y/2/1/1 = Dodona family (Dave, Wincy, Georgia, Bette)
  Y/3 = Goals & Vision (product vision, business plans, strategy)
  Y/5/1 = Ellie OS project (Dave's perspective on the product)
  Y/6 = Health & Wellbeing
  Y/7 = Preferences (tools, workflow, communication style)

Jobs/Work scopes:
  J/4 = Patterns (execution, cost, reliability patterns)
  J/5 = Governance (budget limits, agent policies)

Keep at scope 2 if it's genuinely cross-project or doesn't fit anywhere else.`;

async function classifyScope(content: string, contentTier: string | null): Promise<string> {
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 50,
      messages: [{
        role: "user",
        content: `Route this memory to the best scope path.

Memory (${contentTier || "unclassified"}): "${content.slice(0, 400)}"

${SCOPE_MENU}

Return ONLY the scope path (e.g., "2/1" or "Y/3" or "E/4/1/1"). Nothing else.`,
      }],
    });

    const text = response.content
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { type: string; text: string }) => b.text)
      .join("")
      .trim()
      .replace(/['"]/g, "");

    // Validate it looks like a scope path
    if (/^[0-9EYJR]/.test(text) && text.length <= 20 && !text.includes(" ")) {
      return text;
    }
    return "2"; // keep at root if response is garbage
  } catch {
    return "2";
  }
}

async function main() {
  const memories = await forestSql`
    SELECT id, content, content_tier
    FROM shared_memories
    WHERE status = 'active' AND scope_path = '2'
    ORDER BY weight DESC
    LIMIT ${limit}
  `;

  console.log(`Found ${memories.length} memories at scope '2' to re-route`);
  if (dryRun) console.log("(dry run)");

  const moves: Record<string, number> = {};
  let moved = 0;
  let unchanged = 0;

  for (const mem of memories) {
    const newScope = await classifyScope(mem.content, mem.content_tier);

    if (newScope === "2") {
      unchanged++;
    } else {
      moves[newScope] = (moves[newScope] || 0) + 1;
      if (!dryRun) {
        await forestSql`
          UPDATE shared_memories SET scope_path = ${newScope}, updated_at = NOW()
          WHERE id = ${mem.id}
        `;
      }
      moved++;
    }

    const total = moved + unchanged;
    if (total % 100 === 0) {
      console.log(`  ... ${total}/${memories.length} (${moved} moved)`);
    }
  }

  console.log(`\nDone: ${moved} moved, ${unchanged} stayed at scope 2`);
  console.log("Routing distribution:");
  for (const [scope, count] of Object.entries(moves).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${scope}: ${count}`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error("Failed:", err);
  process.exit(1);
});
