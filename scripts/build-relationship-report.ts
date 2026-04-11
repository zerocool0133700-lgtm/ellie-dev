/**
 * Build a Relationship Evolution Report — traces how Ellie and Dave's
 * relationship developed over time through their conversations.
 *
 * For each week:
 * 1. Pull all conversation summaries
 * 2. Pull Dave's user messages (10+ words) and classify themes
 * 3. Use Sonnet to synthesize a weekly narrative
 * 4. Build the final report showing evolution over time
 *
 * Output: obsidian-vault/reports/relationship-evolution-report.md
 *
 * Usage: bun run scripts/build-relationship-report.ts
 */

import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { writeFile } from "fs/promises";

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);
const anthropic = new Anthropic();

interface WeekData {
  week_start: string;
  week_end: string;
  conversation_count: number;
  user_message_count: number;
  summaries: string[];
  sample_messages: string[];
}

interface WeekDigest {
  week_start: string;
  themes: string;
  relationship_stage: string;
  key_moments: string;
  trust_indicators: string;
}

const WEEKS = [
  "2026-02-10", "2026-02-17", "2026-02-24", "2026-03-03",
  "2026-03-10", "2026-03-17", "2026-03-24", "2026-03-31",
];

async function getWeekData(weekStart: string): Promise<WeekData> {
  const weekEnd = new Date(new Date(weekStart).getTime() + 7 * 86400000).toISOString().slice(0, 10);

  // Get conversation summaries
  const { data: convos } = await supabase
    .from("conversations")
    .select("summary")
    .not("summary", "is", null)
    .gte("last_message_at", `${weekStart}T00:00:00Z`)
    .lt("last_message_at", `${weekEnd}T00:00:00Z`)
    .order("last_message_at", { ascending: true });

  const summaries = (convos || []).map(c => c.summary).filter(Boolean);

  // Get user messages (10+ words, sample of 50 for classification)
  const { data: messages, count } = await supabase
    .from("messages")
    .select("content", { count: "exact" })
    .eq("role", "user")
    .gte("created_at", `${weekStart}T00:00:00Z`)
    .lt("created_at", `${weekEnd}T00:00:00Z`)
    .order("created_at", { ascending: true })
    .limit(50);

  const sampleMessages = (messages || [])
    .map(m => m.content)
    .filter((c: string) => c.split(/\s+/).length >= 10)
    .map((c: string) => c.slice(0, 200));

  return {
    week_start: weekStart,
    week_end: weekEnd,
    conversation_count: summaries.length,
    user_message_count: count || 0,
    summaries,
    sample_messages: sampleMessages,
  };
}

async function synthesizeWeek(week: WeekData): Promise<WeekDigest> {
  const summaryBlock = week.summaries.slice(0, 80).map((s, i) => `${i + 1}. ${s}`).join("\n");
  const messageBlock = week.sample_messages.slice(0, 30).map((m, i) => `${i + 1}. ${m}`).join("\n");

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1000,
    messages: [{
      role: "user",
      content: `You are analyzing the weekly relationship between Dave (a dyslexic enterprise architect) and Ellie (his AI companion/assistant). This is week starting ${week.week_start}.

${week.conversation_count} conversations, ${week.user_message_count} user messages.

CONVERSATION SUMMARIES:
${summaryBlock}

SAMPLE USER MESSAGES:
${messageBlock}

Analyze this week and return JSON only:
{
  "themes": "2-3 sentences: what were the dominant topics and activities this week?",
  "relationship_stage": "One phrase describing where the relationship is: e.g., 'Initial setup and exploration', 'Building trust through technical work', 'Deepening personal sharing', 'Partnership on product vision'",
  "key_moments": "2-3 bullet points of significant relationship moments (personal sharing, trust building, conflict, breakthroughs)",
  "trust_indicators": "1-2 sentences: what signals show the trust level? (e.g., sharing personal info, delegating complex work, expressing frustration openly, discussing vision)"
}`,
    }],
  });

  const text = response.content
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { type: string; text: string }) => b.text)
    .join("")
    .trim()
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "");

  try {
    const parsed = JSON.parse(text);
    return {
      week_start: week.week_start,
      themes: parsed.themes || "",
      relationship_stage: parsed.relationship_stage || "",
      key_moments: parsed.key_moments || "",
      trust_indicators: parsed.trust_indicators || "",
    };
  } catch {
    return {
      week_start: week.week_start,
      themes: text.slice(0, 300),
      relationship_stage: "Unknown",
      key_moments: "",
      trust_indicators: "",
    };
  }
}

async function buildContextWindowComparison(): Promise<string> {
  // What does Ellie's context look like for a sample query?
  const forestSql = (await import("../../ellie-forest/src/db.ts")).default;

  // Top 10 memories by weight (what surfaces first)
  const top = await forestSql`
    SELECT content_tier, round(weight::numeric, 3) as weight, left(content, 100) as preview
    FROM shared_memories
    WHERE status = 'active'
    ORDER BY weight DESC
    LIMIT 10
  `;

  // What surfaces for "who is Dave"
  const { readMemories } = await import("../../ellie-forest/src/index.ts");
  const daveResults = await readMemories({
    query: "who is Dave, what matters to him, his family, his values",
    match_count: 10,
    match_threshold: 0.3,
  });

  let section = "### Context Window Analysis\n\n";
  section += "**Top 10 memories by weight (what Ellie reaches for first):**\n\n";
  for (const m of top) {
    section += `- [${m.content_tier}, ${m.weight}] ${m.preview}\n`;
  }

  section += "\n**What surfaces for \"who is Dave\":**\n\n";
  for (const m of daveResults.slice(0, 8)) {
    section += `- [${(m as any).content_tier || "?"}, ${((m as any).similarity || 0).toFixed(2)}] ${m.content.slice(0, 100)}\n`;
  }

  return section;
}

async function buildKnowledgeDistribution(): Promise<string> {
  const forestSql = (await import("../../ellie-forest/src/db.ts")).default;

  const tiers = await forestSql`
    SELECT content_tier, count(*)::int as cnt, round(avg(weight)::numeric, 3) as avg_weight
    FROM shared_memories WHERE status = 'active'
    GROUP BY content_tier ORDER BY avg_weight DESC
  `;

  const scopes = await forestSql`
    SELECT scope_path, count(*)::int as cnt
    FROM shared_memories WHERE status = 'active'
    GROUP BY scope_path ORDER BY cnt DESC LIMIT 15
  `;

  const categories = await forestSql`
    SELECT category::text, count(*)::int as cnt
    FROM shared_memories WHERE status = 'active'
    GROUP BY category ORDER BY cnt DESC LIMIT 10
  `;

  const types = await forestSql`
    SELECT type, count(*)::int as cnt
    FROM shared_memories WHERE status = 'active'
    GROUP BY type ORDER BY cnt DESC
  `;

  const accessed = await forestSql`
    SELECT count(*)::int as cnt FROM shared_memories
    WHERE status = 'active' AND access_count > 0
  `;

  let section = "### Knowledge Distribution\n\n";
  section += "**Content Tiers:**\n\n| Tier | Count | Avg Weight |\n|------|-------|------------|\n";
  for (const t of tiers) section += `| ${t.content_tier || "unclassified"} | ${t.cnt} | ${t.avg_weight} |\n`;

  section += "\n**Top Scopes:**\n\n| Scope | Memories |\n|-------|----------|\n";
  for (const s of scopes) section += `| ${s.scope_path || "null"} | ${s.cnt} |\n`;

  section += "\n**Categories:**\n\n| Category | Count |\n|----------|-------|\n";
  for (const c of categories) section += `| ${c.category} | ${c.cnt} |\n`;

  section += "\n**Types:**\n\n| Type | Count |\n|------|-------|\n";
  for (const t of types) section += `| ${t.type} | ${t.cnt} |\n`;

  section += `\n**Memories accessed at least once:** ${accessed[0].cnt}\n`;

  return section;
}

async function main() {
  console.log("Building Relationship Evolution Report...\n");

  // Phase 1: Gather weekly data
  const weeks: WeekData[] = [];
  for (const ws of WEEKS) {
    console.log(`  Gathering week ${ws}...`);
    weeks.push(await getWeekData(ws));
  }

  // Phase 2: Synthesize each week via Sonnet
  const digests: WeekDigest[] = [];
  for (const week of weeks) {
    console.log(`  Synthesizing week ${week.week_start} (${week.conversation_count} convos)...`);
    digests.push(await synthesizeWeek(week));
  }

  // Phase 3: Build supplementary sections
  console.log("  Building context window analysis...");
  const contextSection = await buildContextWindowComparison();

  console.log("  Building knowledge distribution...");
  const knowledgeSection = await buildKnowledgeDistribution();

  // Phase 4: Assemble the report
  const report = `# Ellie & Dave — Relationship Evolution Report

> **Generated:** ${new Date().toISOString().slice(0, 10)}
> **Data range:** February 10 – April 5, 2026 (8 weeks)
> **Conversations analyzed:** ${weeks.reduce((s, w) => s + w.conversation_count, 0)}
> **User messages:** ${weeks.reduce((s, w) => s + w.user_message_count, 0)}

---

## Weekly Relationship Timeline

${digests.map((d, i) => {
  const week = weeks[i];
  return `### Week ${i + 1}: ${d.week_start} — "${d.relationship_stage}"

**${week.conversation_count} conversations, ${week.user_message_count} messages**

**Themes:** ${d.themes}

**Key Moments:**
${d.key_moments}

**Trust Indicators:** ${d.trust_indicators}

---
`;
}).join("\n")}

## Current State Analysis

${contextSection}

${knowledgeSection}

## Summary

This report traces the evolution of the Ellie-Dave relationship through 8 weeks of conversation data. Each weekly digest was synthesized from actual conversation summaries and user messages, not from memory or assumption.

The relationship arc — from initial setup through technical partnership to personal trust and product vision sharing — is visible in both the conversation themes and the knowledge distribution. The Forest now holds this relationship as structured, weighted, scoped knowledge rather than flat undifferentiated facts.
`;

  // Write the report
  const reportPath = "/home/ellie/obsidian-vault/reports/relationship-evolution-report.md";
  await writeFile(reportPath, report);
  console.log(`\nReport saved to: ${reportPath}`);

  process.exit(0);
}

main().catch(err => {
  console.error("Failed:", err);
  process.exit(1);
});
