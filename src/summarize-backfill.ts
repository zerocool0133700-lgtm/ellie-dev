/**
 * One-time: Generate summaries for backfilled conversations that have none.
 * Uses Claude CLI (Max subscription) instead of direct API.
 */
import "dotenv/config";
import { spawn } from "bun";
import { createClient } from "@supabase/supabase-js";
import { log } from "./logger.ts";

const logger = log.child("summarize-backfill");

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";

async function callClaudeCLI(prompt: string): Promise<string> {
  const args = [CLAUDE_PATH, "-p", "--output-format", "text"];

  const proc = spawn(args, {
    stdin: new Blob([prompt]),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CLAUDECODE: "",
      ANTHROPIC_API_KEY: "",
    },
  });

  const TIMEOUT_MS = 60_000;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, TIMEOUT_MS);

  const output = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  clearTimeout(timeout);

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const msg = timedOut ? "timed out" : stderr || `exit code ${exitCode}`;
    throw new Error(`Claude CLI failed: ${msg}`);
  }

  return output.trim();
}

async function run() {
  const { data: convos } = await supabase
    .from("conversations")
    .select("id, channel, started_at, message_count")
    .is("summary", null)
    .order("started_at", { ascending: true });

  if (!convos?.length) {
    console.log("No conversations need summaries.");
    return;
  }

  console.log(`${convos.length} conversations need summaries.\n`);

  for (let i = 0; i < convos.length; i++) {
    const convo = convos[i];
    console.log(`[${i + 1}/${convos.length}] ${convo.channel} (${convo.message_count} msgs)...`);

    const { data: msgs } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", convo.id)
      .order("created_at", { ascending: true });

    if (!msgs?.length) continue;

    const transcript = msgs.map((m) => `[${m.role}]: ${m.content}`).join("\n");

    const prompt = `Summarize this conversation in 1-3 sentences. Be concise and standalone. Return ONLY the summary text, no JSON, no formatting.\n\n${transcript}`;

    try {
      const summary = await callClaudeCLI(prompt);

      await supabase
        .from("conversations")
        .update({ summary })
        .eq("id", convo.id);

      console.log(`  -> ${summary.substring(0, 100)}...`);
    } catch (err) {
      logger.error("Failed to summarize conversation", { conversationId: convo.id }, err);
    }
  }

  console.log("\nDone.");
}

run().catch((err) => logger.error("Fatal error", err));
