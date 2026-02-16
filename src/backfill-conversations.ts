/**
 * One-time backfill: Create conversation records for messages
 * that were already summarized before the conversations table existed.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

async function backfill() {
  console.log("[backfill] Fetching orphaned messages...");

  const { data: messages, error } = await supabase
    .from("messages")
    .select("id, role, content, channel, created_at")
    .eq("summarized", true)
    .is("conversation_id", null)
    .order("created_at", { ascending: true });

  if (error || !messages) {
    console.error("[backfill] Failed:", error);
    return;
  }

  console.log(`[backfill] ${messages.length} orphaned messages to group.`);

  // Group into conversation blocks (same logic as consolidation)
  interface Block {
    channel: string;
    startedAt: string;
    endedAt: string;
    messageIds: string[];
    count: number;
  }

  const blocks: Block[] = [];
  let current: Block | null = null;

  for (const msg of messages) {
    const gap = current
      ? (new Date(msg.created_at).getTime() - new Date(current.endedAt).getTime()) / 60_000
      : Infinity;

    if (!current || current.channel !== msg.channel || gap > 30) {
      current = {
        channel: msg.channel,
        startedAt: msg.created_at,
        endedAt: msg.created_at,
        messageIds: [],
        count: 0,
      };
      blocks.push(current);
    }

    current.messageIds.push(msg.id);
    current.endedAt = msg.created_at;
    current.count++;
  }

  console.log(`[backfill] Grouped into ${blocks.length} conversations.`);

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];

    // Create conversation record (no summary — those were already stored in memory table)
    const { data: convo, error: err } = await supabase
      .from("conversations")
      .insert({
        channel: block.channel,
        started_at: block.startedAt,
        ended_at: block.endedAt,
        message_count: block.count,
        summary: null,
        metadata: { source: "backfill" },
      })
      .select("id")
      .single();

    if (err || !convo) {
      console.error(`[backfill] Failed to create conversation ${i + 1}:`, err);
      continue;
    }

    // Link messages
    await supabase
      .from("messages")
      .update({ conversation_id: convo.id })
      .in("id", block.messageIds);

    console.log(`[backfill] ${i + 1}/${blocks.length}: ${block.channel} (${block.count} msgs) -> ${convo.id}`);
  }

  // Also try to link existing memory entries to conversations by matching timestamps
  console.log("\n[backfill] Linking existing memories to conversations...");

  const { data: memories } = await supabase
    .from("memory")
    .select("id, created_at, metadata")
    .is("conversation_id", null)
    .order("created_at", { ascending: true });

  if (memories?.length) {
    const { data: convos } = await supabase
      .from("conversations")
      .select("id, started_at, ended_at")
      .order("started_at", { ascending: true });

    if (convos) {
      let linked = 0;
      for (const mem of memories) {
        const memTime = new Date(mem.created_at).getTime();
        // Find the conversation that was being processed when this memory was created
        // Memories are created shortly after the conversation ends
        const match = convos.find((c) => {
          const start = new Date(c.started_at).getTime();
          const end = new Date(c.ended_at).getTime();
          // Memory created within 5 minutes after conversation ended
          return memTime >= start && memTime <= end + 5 * 60_000;
        });

        if (match) {
          await supabase
            .from("memory")
            .update({ conversation_id: match.id })
            .eq("id", mem.id);
          linked++;
        }
      }
      console.log(`[backfill] Linked ${linked}/${memories.length} memories to conversations.`);
    }
  }

  console.log("[backfill] Done.");
}

backfill().catch(console.error);
