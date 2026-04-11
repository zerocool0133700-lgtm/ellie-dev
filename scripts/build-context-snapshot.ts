import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY!);

async function main() {
  const sections: string[] = [];
  const query = "What's the current state of things? How are we doing?";

  sections.push("# Ellie Context Build Snapshot");
  sections.push(`> **Query:** "${query}"`);
  sections.push(`> **Agent:** ellie (general/coordinator)`);
  sections.push(`> **Generated:** ${new Date().toISOString()}`);
  sections.push(`> **Purpose:** Shows exactly what Ellie would see in her context window for a typical conversation start.`);
  sections.push("\n---\n");

  // 1. Relevant Context (Supabase semantic search - Tier 2a)
  sections.push("## 1. Relevant Context (Supabase Tier 2a — semantic search)");
  try {
    const { getRelevantContext } = await import("./src/memory.ts");
    const ctx = await getRelevantContext(supabase, query, "ellie-chat", "general", undefined);
    sections.push(ctx ? "```\n" + String(ctx).slice(0, 1500) + "\n```" : "*Empty*");
  } catch (e) { sections.push(`*Error: ${e}`); }

  // 2. Elasticsearch (scope-filtered)
  sections.push("\n## 2. Elasticsearch Results (scope-filtered to 2/)");
  try {
    const { searchElastic } = await import("./src/elasticsearch.ts");
    const ctx = await searchElastic(query, { limit: 5, recencyBoost: true, channel: "ellie-chat", scope_path: "2" });
    sections.push(ctx ? "```\n" + ctx.slice(0, 1500) + "\n```" : "*Empty*");
  } catch (e) { sections.push(`*Error: ${e}`); }

  // 3. Forest Context (keyword gate)
  sections.push("\n## 3. Forest Context (keyword-gated ES search)");
  try {
    const { getForestContext } = await import("./src/elasticsearch/context.ts");
    const ctx = await getForestContext(query);
    sections.push(ctx ? "```\n" + String(ctx).slice(0, 1000) + "\n```" : "*Empty — query didn't trigger forest keyword gate*");
  } catch (e) { sections.push(`*Error: ${e}`); }

  // 4. Scoped Forest Knowledge (Phase 3 — readMemoriesByPath)
  sections.push("\n## 4. Scoped Forest Knowledge (Phase 3 — scope 2/)");
  try {
    const { getScopedForestContext } = await import("./src/context-sources.ts");
    const ctx = await getScopedForestContext(query, "general", { limit: 8 });
    sections.push(ctx ? "```\n" + ctx.slice(0, 2000) + "\n```" : "*Empty*");
  } catch (e) { sections.push(`*Error: ${e}`); }

  // 5. Related Knowledge (Phase 2 — semantic edges)
  sections.push("\n## 5. Related Knowledge (Phase 2 — semantic edge traversal)");
  try {
    const { getRelatedKnowledge } = await import("./src/context-sources.ts");
    const ctx = await getRelatedKnowledge(query, { limit: 5 });
    sections.push(ctx ? "```\n" + ctx.slice(0, 1500) + "\n```" : "*Empty*");
  } catch (e) { sections.push(`*Error: ${e}`); }

  // 6. Agent Memory Context
  sections.push("\n## 6. Agent Memory Context (Forest — tree/entity scoped)");
  try {
    const { getAgentMemoryContext } = await import("./src/context-sources.ts");
    const ctx = await getAgentMemoryContext("general", undefined, 20);
    sections.push(ctx?.memoryContext ? "```\n" + ctx.memoryContext.slice(0, 1500) + "\n```" : "*Empty*");
  } catch (e) { sections.push(`*Error: ${e}`); }

  // 7. Live Forest Context (creatures, incidents)
  sections.push("\n## 7. Live Forest Context (active creatures, incidents)");
  try {
    const { getLiveForestContext } = await import("./src/context-sources.ts");
    const ctx = await getLiveForestContext(query);
    sections.push(ctx?.awareness ? "```\n" + ctx.awareness.slice(0, 1000) + "\n```" : "*No active creatures or incidents*");
  } catch (e) { sections.push(`*Error: ${e}`); }

  // 8. Relevant Facts (Tier 2b — conversation_facts)
  sections.push("\n## 8. Relevant Facts (Supabase Tier 2b — conversation_facts)");
  try {
    const { getRelevantFacts } = await import("./src/memory.ts");
    const ctx = await getRelevantFacts(supabase, query);
    sections.push(ctx ? "```\n" + String(ctx).slice(0, 1000) + "\n```" : "*Empty*");
  } catch (e) { sections.push(`*Error: ${e}`); }

  // 9. Grove Shared Knowledge (Phase 3)
  sections.push("\n## 9. Grove Shared Knowledge (Phase 3)");
  try {
    const { getGroveKnowledgeContext } = await import("./src/context-sources.ts");
    const ctx = await getGroveKnowledgeContext(query, "general", { limit: 5 });
    sections.push(ctx ? "```\n" + ctx.slice(0, 1000) + "\n```" : "*No grove knowledge available*");
  } catch (e) { sections.push(`*Error: ${e}`); }

  // 10. Bridge Read — what the coordinator would see
  sections.push("\n## 10. Bridge Read (coordinator pre-work briefing — scope 2/)");
  try {
    const resp = await fetch("http://localhost:3001/api/bridge/read", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-bridge-key": process.env.BRIDGE_KEY || "bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a" },
      body: JSON.stringify({ query: "current state of the system and recent work", scope_path: "2", match_count: 8 }),
    });
    const data = await resp.json() as any;
    if (data.memories?.length) {
      const lines = data.memories.map((m: any) => `- [${m.type}, ${m.scope_path}] ${m.content.slice(0, 150)}`);
      sections.push("```\n" + lines.join("\n") + "\n```");
    } else {
      sections.push("*Empty*");
    }
  } catch (e) { sections.push(`*Error: ${e}`); }

  // 11. Top weighted memories (what Ellie reaches for)
  sections.push("\n## 11. Top Weighted Memories (what surfaces first regardless of query)");
  try {
    const forestSql = (await import("../../ellie-forest/src/db.ts")).default;
    const top = await forestSql`
      SELECT content_tier, round(weight::numeric, 3) as weight, scope_path, category::text, type, left(content, 150) as preview
      FROM shared_memories WHERE status = 'active'
      ORDER BY weight DESC LIMIT 15
    `;
    const lines = top.map((m: any) => `- [${m.content_tier}, ${m.weight}, ${m.scope_path}, ${m.category}/${m.type}] ${m.preview}`);
    sections.push("```\n" + lines.join("\n") + "\n```");
  } catch (e) { sections.push(`*Error: ${e}`); }

  // 12. Knowledge distribution summary
  sections.push("\n## 12. Knowledge Distribution Summary");
  try {
    const forestSql = (await import("../../ellie-forest/src/db.ts")).default;
    
    const tiers = await forestSql`
      SELECT content_tier, count(*)::int as cnt, round(avg(weight)::numeric, 3) as avg_w
      FROM shared_memories WHERE status = 'active' GROUP BY content_tier ORDER BY avg_w DESC
    `;
    sections.push("\n| Tier | Count | Avg Weight |");
    sections.push("|------|-------|------------|");
    for (const t of tiers) sections.push(`| ${t.content_tier || "null"} | ${t.cnt} | ${t.avg_w} |`);

    const scopes = await forestSql`
      SELECT scope_path, count(*)::int as cnt
      FROM shared_memories WHERE status = 'active' GROUP BY scope_path ORDER BY cnt DESC LIMIT 10
    `;
    sections.push("\n| Scope | Count |");
    sections.push("|-------|-------|");
    for (const s of scopes) sections.push(`| ${s.scope_path} | ${s.cnt} |`);
  } catch (e) { sections.push(`*Error: ${e}`); }

  const report = sections.join("\n");
  await Bun.write("/home/ellie/obsidian-vault/reports/context-build-snapshot.md", report);
  console.log(`Report saved (${report.length} chars)`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
