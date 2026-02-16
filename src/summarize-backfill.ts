/**
 * One-time: Generate summaries for backfilled conversations that have none.
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

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

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: "Summarize this conversation in 1-3 sentences. Be concise and standalone. Return ONLY the summary text, no JSON, no formatting.",
      messages: [{ role: "user", content: transcript }],
    });

    const summary = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    await supabase
      .from("conversations")
      .update({ summary })
      .eq("id", convo.id);

    console.log(`  -> ${summary.substring(0, 100)}...`);
  }

  console.log("\nDone.");
}

run().catch(console.error);
