/**
 * Structured Voice Extraction — ELLIE-1065
 * Extracts action items, decisions, speakers from voice call transcripts.
 * Runs post-call via Haiku. Stores structured data in conversation metadata.
 * Inspired by Minutes crates/core/src/pipeline.rs
 */

import { log } from "./logger.ts";
import { estimateTokens } from "./relay-utils.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

const logger = log.child("voice:extraction");
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";

export interface ActionItem {
  assignee: string;
  task: string;
  due?: string;
  status: "open";
}

export interface Decision {
  text: string;
  topic?: string;
  participants?: string[];
}

export interface VoiceExtraction {
  summary: string;
  actionItems: ActionItem[];
  decisions: Decision[];
  openQuestions: string[];
  speakers: string[];
  topics: string[];
  duration?: string;
}

/**
 * Extract structured data from a voice call transcript.
 */
export async function extractFromTranscript(transcript: string): Promise<VoiceExtraction> {
  const prompt = `Analyze this voice call transcript and extract structured data.

Return a JSON object with these fields:
1. "summary": 2-3 sentence summary of the call (standalone, no references to "the call")
2. "actionItems": array of {assignee, task, due?, status:"open"}
   - Extract commitments like "I'll send you X" or "Can you do Y by Friday"
3. "decisions": array of {text, topic?}
   - Extract choices made: "We decided to...", "Let's go with..."
4. "openQuestions": array of strings
   - Unresolved questions that need follow-up
5. "speakers": array of participant names mentioned or identified
6. "topics": array of main topics discussed (2-5 keywords)

If nothing worth extracting in a category, use an empty array.
Return ONLY valid JSON. No markdown fences, no explanation.

TRANSCRIPT:
${transcript}`;

  try {
    const { spawn } = await import("bun");
    const args = [
      CLAUDE_PATH, "-p",
      "--output-format", "text",
      "--no-session-persistence",
      "--allowedTools", "",
      "--model", "haiku",
    ];

    const proc = spawn(args, {
      stdin: new Blob([prompt]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDECODE: "", ANTHROPIC_API_KEY: "" },
    });

    const timer = setTimeout(() => proc.kill(), 30_000);
    const output = await new Response(proc.stdout).text();
    clearTimeout(timer);
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      logger.warn("Voice extraction CLI failed", { exitCode });
      return emptyExtraction();
    }

    // Parse JSON (handle preamble text)
    const cleaned = output.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      const jsonMatch = cleaned.match(/\{[\s\S]*"summary"[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
      logger.warn("Failed to parse extraction JSON", { preview: cleaned.slice(0, 200) });
      return emptyExtraction();
    }
  } catch (err) {
    logger.error("Voice extraction error", { error: String(err) });
    return emptyExtraction();
  }
}

function emptyExtraction(): VoiceExtraction {
  return { summary: "", actionItems: [], decisions: [], openQuestions: [], speakers: [], topics: [] };
}

/**
 * Process a completed voice call — extract structured data and store.
 */
export async function processVoiceCall(
  supabase: SupabaseClient,
  conversationId: string,
  callSid?: string
): Promise<VoiceExtraction> {
  // Fetch all messages for this conversation
  const { data: messages } = await supabase
    .from("messages")
    .select("role, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (!messages || messages.length === 0) {
    return emptyExtraction();
  }

  // Build transcript
  const transcript = messages
    .map(m => `[${m.role}]: ${m.content}`)
    .join("\n");

  // Skip very short calls
  if (estimateTokens(transcript) < 50) {
    return emptyExtraction();
  }

  // Extract
  const extraction = await extractFromTranscript(transcript);

  // Store extraction in conversation metadata
  await supabase
    .from("conversations")
    .update({
      metadata: {
        extraction,
        callSid,
        extractedAt: new Date().toISOString(),
      },
    })
    .eq("id", conversationId);

  logger.info("Voice extraction complete", {
    conversationId,
    actionItems: extraction.actionItems.length,
    decisions: extraction.decisions.length,
    topics: extraction.topics,
  });

  return extraction;
}

/**
 * Get extraction for a conversation (from stored metadata).
 */
export async function getVoiceExtraction(
  supabase: SupabaseClient,
  conversationId: string
): Promise<VoiceExtraction | null> {
  const { data } = await supabase
    .from("conversations")
    .select("metadata")
    .eq("id", conversationId)
    .single();

  return data?.metadata?.extraction ?? null;
}
