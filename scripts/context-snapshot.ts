/**
 * Context Build Snapshot — shows what Ellie's context window contains.
 * Uses Bridge API + direct Forest SQL to avoid module resolution issues.
 */
import "dotenv/config";
import forestSql from "../../ellie-forest/src/db.ts";
import { readMemories } from "../../ellie-forest/src/index.ts";
import { writeFile } from "fs/promises";

const BRIDGE_KEY = "bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a";

async function bridgeRead(query: string, scopePath?: string, count = 8) {
  const resp = await fetch("http://localhost:3001/api/bridge/read", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-bridge-key": BRIDGE_KEY },
    body: JSON.stringify({ query, scope_path: scopePath, match_count: count, match_threshold: 0.3 }),
  });
  const data = await resp.json() as any;
  return data.memories || [];
}

async function esSearch(query: string, scopePath?: string) {
  try {
    const body: any = {
      size: 8,
      query: {
        bool: {
          must: [{ multi_match: { query, fields: ["content"], type: "best_fields" } }],
          ...(scopePath ? { filter: [{ prefix: { scope_path: scopePath } }] } : {}),
        },
      },
      sort: [{ _score: "desc" }],
    };
    const resp = await fetch("http://localhost:9200/ellie-memory/_search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json() as any;
    return (data.hits?.hits || []).map((h: any) => ({
      content: h._source.content?.slice(0, 150),
      scope_path: h._source.scope_path,
      score: h._score?.toFixed(2),
    }));
  } catch { return []; }
}

async function main() {
  const s: string[] = [];
  const q = "What's the current state of things? How are we doing?";

  s.push("# Ellie Context Build Snapshot\n");
  s.push(`> **Query:** "${q}"`);
  s.push(`> **Agent:** ellie (coordinator)`);
  s.push(`> **Generated:** ${new Date().toISOString().replace("T", " ").slice(0, 19)} CST`);
  s.push(`> **Purpose:** What Ellie sees in her context window when Dave starts a conversation.\n`);
  s.push("---\n");

  // 1. Forest semantic search (what readMemories returns for this query)
  s.push("## 1. Forest Semantic Search (readMemories — hybrid vector + BM25)");
  const forestResults = await readMemories({ query: q, match_count: 10, match_threshold: 0.3 });
  if (forestResults.length) {
    for (const m of forestResults) {
      s.push(`- [${(m as any).content_tier || "?"}, ${((m as any).similarity || 0).toFixed(2)}] ${m.content.slice(0, 150)}`);
    }
  } else { s.push("*Empty*"); }

  // 2. Forest scoped search (what getScopedForestContext does — scope 2/)
  s.push("\n## 2. Scoped Forest Search (scope 2/ — project knowledge)");
  const scopedResults = await readMemories({ query: q, scope_path: "2", match_count: 8, match_threshold: 0.3 });
  if (scopedResults.length) {
    for (const m of scopedResults) {
      s.push(`- [${(m as any).content_tier || "?"}, ${(m as any).scope_path || "?"}] ${m.content.slice(0, 150)}`);
    }
  } else { s.push("*Empty*"); }

  // 3. Bridge read (what coordinator pre-work briefing sees)
  s.push("\n## 3. Bridge Read (coordinator briefing — scope 2/)");
  const bridgeResults = await bridgeRead("current state recent work decisions findings", "2", 8);
  if (bridgeResults.length) {
    for (const m of bridgeResults) {
      s.push(`- [${m.type}, ${m.scope_path || "?"}] ${m.content?.slice(0, 150)}`);
    }
  } else { s.push("*Empty*"); }

  // 4. "Who is Dave" query — scoped to Y/ (Dave's personal tree) and E/4/1 (Ellie knows Dave)
  s.push('\n## 4. "Who is Dave?" (what surfaces about the user)');
  const [davePersonal, daveRelationship] = await Promise.all([
    bridgeRead("Dave identity values family how he thinks personality", "Y", 10),
    bridgeRead("Dave relationship preferences working style", "E/4/1", 10),
  ]);
  const daveResults = [...davePersonal, ...daveRelationship];
  if (daveResults.length) {
    for (const m of daveResults) {
      s.push(`- [${m.type}, ${m.scope_path || "?"}] ${m.content?.slice(0, 150)}`);
    }
  } else { s.push("*Empty*"); }

  // 5. "What is Ellie" query
  s.push('\n## 5. "What is Ellie?" (self-knowledge)');
  const ellieResults = await bridgeRead("what is Ellie, her purpose, personality, relationship with Dave", "E", 8);
  if (ellieResults.length) {
    for (const m of ellieResults) {
      s.push(`- [${m.type}, ${m.scope_path || "?"}] ${m.content?.slice(0, 150)}`);
    }
  } else { s.push("*Empty*"); }

  // 6. ES search (what searchElastic returns)
  s.push("\n## 6. Elasticsearch Results (keyword + recency boost)");
  const esResults = await esSearch("current state system architecture", "2");
  if (esResults.length) {
    for (const m of esResults) {
      s.push(`- [${m.scope_path || "?"}, score=${m.score}] ${m.content}`);
    }
  } else { s.push("*Empty*"); }

  // 7. Top weighted memories
  s.push("\n## 7. Top 15 Weighted Memories (what Ellie reaches for first)");
  const top = await forestSql`
    SELECT content_tier, round(weight::numeric, 3) as weight, scope_path, category::text, type,
      left(content, 150) as preview
    FROM shared_memories WHERE status = 'active'
    ORDER BY weight DESC LIMIT 15
  `;
  for (const m of top) {
    s.push(`- **${m.weight}** [${m.content_tier}, ${m.scope_path}, ${m.category}/${m.type}] ${m.preview}`);
  }

  // 8. Knowledge distribution
  s.push("\n## 8. Knowledge Distribution\n");

  const tiers = await forestSql`
    SELECT content_tier, count(*)::int as cnt, round(avg(weight)::numeric, 3) as avg_w,
      round(min(weight)::numeric, 3) as min_w, round(max(weight)::numeric, 3) as max_w
    FROM shared_memories WHERE status = 'active' GROUP BY content_tier ORDER BY avg_w DESC
  `;
  s.push("| Tier | Count | Avg Weight | Range |");
  s.push("|------|-------|------------|-------|");
  for (const t of tiers) s.push(`| ${t.content_tier || "null"} | ${t.cnt} | ${t.avg_w} | ${t.min_w}-${t.max_w} |`);

  const cats = await forestSql`
    SELECT category::text, count(*)::int as cnt
    FROM shared_memories WHERE status = 'active' GROUP BY category ORDER BY cnt DESC LIMIT 10
  `;
  s.push("\n| Category | Count |");
  s.push("|----------|-------|");
  for (const c of cats) s.push(`| ${c.category} | ${c.cnt} |`);

  const types = await forestSql`
    SELECT type, count(*)::int as cnt
    FROM shared_memories WHERE status = 'active' GROUP BY type ORDER BY cnt DESC
  `;
  s.push("\n| Type | Count |");
  s.push("|------|-------|");
  for (const t of types) s.push(`| ${t.type} | ${t.cnt} |`);

  const scopes = await forestSql`
    SELECT scope_path, count(*)::int as cnt
    FROM shared_memories WHERE status = 'active' GROUP BY scope_path ORDER BY cnt DESC LIMIT 15
  `;
  s.push("\n| Scope | Count |");
  s.push("|-------|-------|");
  for (const sc of scopes) s.push(`| ${sc.scope_path} | ${sc.cnt} |`);

  const report = s.join("\n");
  await writeFile("/home/ellie/obsidian-vault/reports/context-build-snapshot.md", report);
  console.log(`Report saved (${report.length} chars, ${s.length} lines)`);
  await forestSql.end();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
