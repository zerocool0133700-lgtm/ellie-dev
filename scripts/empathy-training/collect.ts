#!/usr/bin/env bun
/**
 * Phase 1: Training Data Collection — ELLIE-990
 *
 * Collects empathy training data from two sources:
 * 1. emotion_history table (real labeled data from production)
 * 2. Synthetic dataset (curated examples covering edge cases)
 *
 * Outputs JSONL: { "text": "...", "label": 0|1|2 }
 *   0 = LOW empathy need
 *   1 = MODERATE empathy need
 *   2 = HIGH empathy need
 */

import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync, existsSync } from "fs";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;

const OUTPUT_DIR = `${import.meta.dir}/../../data/empathy-training`;
const OUTPUT_FILE = `${OUTPUT_DIR}/collected.jsonl`;

// ── Label mapping ────────────────────────────────────────────

type EmpathyLabel = 0 | 1 | 2; // LOW, MODERATE, HIGH

function empathyScoreToLabel(score: number): EmpathyLabel {
  if (score > 0.6) return 2; // HIGH
  if (score >= 0.3) return 1; // MODERATE
  return 0; // LOW
}

// ── Synthetic training examples ──────────────────────────────

interface TrainingExample {
  text: string;
  label: EmpathyLabel;
}

const SYNTHETIC_DATA: TrainingExample[] = [
  // HIGH empathy need (label 2)
  { text: "I'm so frustrated and overwhelmed. I don't know what to do anymore.", label: 2 },
  { text: "I feel like I'm failing at everything. Nothing I do seems to work.", label: 2 },
  { text: "I'm scared I'm going to lose my job. I can't handle the pressure.", label: 2 },
  { text: "Why does this always happen to me? I'm so tired of struggling.", label: 2 },
  { text: "I don't know what to do. I feel completely lost and helpless.", label: 2 },
  { text: "I'm exhausted. I've been working 16 hour days and I can't keep going.", label: 2 },
  { text: "I feel so alone in this. Nobody understands what I'm going through.", label: 2 },
  { text: "I'm terrified about the diagnosis. What am I going to do?", label: 2 },
  { text: "Everything is falling apart. My relationship, my work, my health.", label: 2 },
  { text: "I just got the worst news. I don't even know how to process this.", label: 2 },
  { text: "I keep making the same mistakes over and over. What's wrong with me?", label: 2 },
  { text: "I'm so angry at myself for letting this happen again.", label: 2 },
  { text: "I had a panic attack at work today. I'm worried it'll happen again.", label: 2 },
  { text: "My anxiety is through the roof. I can barely function.", label: 2 },
  { text: "I've been crying all day. I just feel so hopeless.", label: 2 },
  { text: "I feel defeated. I've tried everything and nothing is changing.", label: 2 },
  { text: "I can't sleep because I keep worrying about everything going wrong.", label: 2 },
  { text: "I'm so disappointed in myself. I thought I was past this.", label: 2 },
  { text: "I feel like a burden on everyone around me.", label: 2 },
  { text: "The grief is overwhelming. I miss them so much it physically hurts.", label: 2 },

  // MODERATE empathy need (label 1)
  { text: "I'm a bit stuck on this problem. Can you help me figure it out?", label: 1 },
  { text: "This is getting frustrating but I think we can figure it out.", label: 1 },
  { text: "I'm worried about the deadline but I'll manage somehow.", label: 1 },
  { text: "It's been a tough week but things are looking up.", label: 1 },
  { text: "I'm a little overwhelmed with all the tasks but I'll prioritize.", label: 1 },
  { text: "Not the best day. Had some setbacks but pushing through.", label: 1 },
  { text: "I'm stressed about the presentation but I've prepared well.", label: 1 },
  { text: "It's annoying that this keeps breaking but I know we'll fix it.", label: 1 },
  { text: "I'm slightly anxious about the meeting tomorrow.", label: 1 },
  { text: "Having a hard time focusing today. Brain is scattered.", label: 1 },
  { text: "This is harder than I expected but I'm learning a lot.", label: 1 },
  { text: "I'm not thrilled about the feedback but I understand it.", label: 1 },
  { text: "Feeling a bit down today, not sure why exactly.", label: 1 },
  { text: "The project isn't going great but I have a plan to fix it.", label: 1 },
  { text: "I'm concerned about the direction we're heading but open to ideas.", label: 1 },
  { text: "Things didn't go as planned but it's not the end of the world.", label: 1 },
  { text: "I was hoping for better results. Need to rethink the approach.", label: 1 },
  { text: "A bit discouraged by the test results but I'll iterate.", label: 1 },
  { text: "I'm nervous about launching this but excited too.", label: 1 },
  { text: "It's been challenging but I'm making progress every day.", label: 1 },

  // LOW empathy need (label 0)
  { text: "How do I fix this bug in the authentication handler?", label: 0 },
  { text: "Can you show me how to implement this feature?", label: 0 },
  { text: "What's the best way to structure this database schema?", label: 0 },
  { text: "Please run the tests and tell me what fails.", label: 0 },
  { text: "Build the empathy detector MVP now.", label: 0 },
  { text: "Push the commit and close the ticket.", label: 0 },
  { text: "Restart the relay service.", label: 0 },
  { text: "Run the database migration.", label: 0 },
  { text: "How does the agent router work?", label: 0 },
  { text: "List all files in the directory.", label: 0 },
  { text: "What's the current status of ELLIE-942?", label: 0 },
  { text: "Can you refactor this function to use async await?", label: 0 },
  { text: "Deploy the latest changes to production.", label: 0 },
  { text: "Create a new branch for this feature.", label: 0 },
  { text: "Show me the git log for the last week.", label: 0 },
  { text: "Add a health check endpoint to the API.", label: 0 },
  { text: "What dependencies does this project use?", label: 0 },
  { text: "Run the linter and fix any errors.", label: 0 },
  { text: "Compare the two implementations and tell me which is better.", label: 0 },
  { text: "Schedule a meeting for Thursday at 2pm.", label: 0 },
  { text: "Uh, done.", label: 0 },
  { text: "ok", label: 0 },
  { text: "yes", label: 0 },
  { text: "no that's wrong, try again", label: 0 },
  { text: "let's move on to the next task", label: 0 },
  { text: "good, what's next?", label: 0 },
  { text: "I need you to check the database connection.", label: 0 },
  { text: "The weather is nice today.", label: 0 },
  { text: "Can you explain how WebSocket connections work?", label: 0 },
  { text: "Write a unit test for this function.", label: 0 },
];

// ── Collection from production data ─────────────────────────

async function collectFromEmotionHistory(): Promise<TrainingExample[]> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.log("  No Supabase credentials — skipping production data");
    return [];
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const { data, error } = await supabase
    .from("emotion_history")
    .select("message_text, empathy_score")
    .not("message_text", "is", null)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error || !data) {
    console.log(`  Failed to fetch emotion_history: ${error?.message || "no data"}`);
    return [];
  }

  const examples: TrainingExample[] = [];
  for (const row of data) {
    if (!row.message_text || row.message_text.length < 3) continue;
    examples.push({
      text: row.message_text,
      label: empathyScoreToLabel(row.empathy_score ?? 0),
    });
  }

  return examples;
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  console.log("\nPhase 1: Training Data Collection\n");

  // 1. Collect production data
  console.log("Collecting from emotion_history...");
  const productionData = await collectFromEmotionHistory();
  console.log(`  Found ${productionData.length} production examples`);

  // 2. Add synthetic data
  console.log(`Adding ${SYNTHETIC_DATA.length} synthetic examples...`);

  // 3. Merge and deduplicate
  const allExamples = [...productionData, ...SYNTHETIC_DATA];
  const seen = new Set<string>();
  const deduped: TrainingExample[] = [];
  for (const ex of allExamples) {
    const key = ex.text.toLowerCase().trim();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(ex);
    }
  }

  // 4. Print distribution
  const dist = { 0: 0, 1: 0, 2: 0 };
  for (const ex of deduped) dist[ex.label]++;

  console.log(`\nTotal: ${deduped.length} examples (deduped from ${allExamples.length})`);
  console.log(`  LOW (0):      ${dist[0]}`);
  console.log(`  MODERATE (1): ${dist[1]}`);
  console.log(`  HIGH (2):     ${dist[2]}`);

  // 5. Write JSONL
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  const jsonl = deduped.map((ex) => JSON.stringify(ex)).join("\n") + "\n";
  writeFileSync(OUTPUT_FILE, jsonl);
  console.log(`\nWritten to: ${OUTPUT_FILE}`);
}

main().catch(console.error);
