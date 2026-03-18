#!/usr/bin/env bun
/**
 * Poll Brian and Amy's AgentMail inboxes for unread messages, dispatch to agents, and send replies.
 * Usage: bun run scripts/poll-agent-emails.ts
 *
 * This should be run every 10 minutes via cron or systemd timer.
 */

import { getAgentMailConfig, isInterAgentMessage, buildAgentHeaders } from "../src/agentmail";
import { createClient } from "@supabase/supabase-js";

const API_BASE = "https://api.agentmail.to/v0";

interface Message {
  message_id: string;
  thread_id: string;
  from: string;
  to: string[];
  subject: string;
  preview: string;
  labels: string[];
  inbox_id: string;
  headers?: Record<string, string>;
}

interface Inbox {
  inbox_id: string;
  agent_name: string;
}

interface InboxConfig {
  inbox_id: string;
  agent_name: string;
  agent_type: string;
}

const AGENT_INBOXES: InboxConfig[] = [
  { inbox_id: "brian-ellie-os@agentmail.to", agent_name: "brian", agent_type: "critic" },
  { inbox_id: "amy-ellie-os@agentmail.to", agent_name: "amy", agent_type: "content" },
];

async function getUnreadMessages(inboxId: string, apiKey: string): Promise<Message[]> {
  const url = `${API_BASE}/inboxes/${encodeURIComponent(inboxId)}/messages`;
  const res = await fetch(url, {
    headers: { "Authorization": `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch messages for ${inboxId}: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as { messages: Message[] };
  return data.messages.filter(m => m.labels.includes("unread"));
}

async function getMessageContent(inboxId: string, messageId: string, apiKey: string): Promise<{ text: string; headers?: Record<string, string> }> {
  const url = `${API_BASE}/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}`;
  const res = await fetch(url, {
    headers: { "Authorization": `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch message ${messageId}: ${res.status}`);
  }

  const data = await res.json() as { text?: string; extracted_text?: string; headers?: Record<string, string> };
  return {
    text: data.extracted_text || data.text || "",
    headers: data.headers,
  };
}

async function sendReply(
  inboxEmail: string,
  messageId: string,
  replyText: string,
  apiKey: string,
  agentName: string,
  agentType: string,
): Promise<void> {
  const headers = buildAgentHeaders(agentName, agentType, "inter-agent");

  const url = `${API_BASE}/inboxes/${encodeURIComponent(inboxEmail)}/messages/${encodeURIComponent(messageId)}/reply`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: replyText, headers }),
  });

  if (!res.ok) {
    throw new Error(`Failed to send reply: ${res.status} ${await res.text()}`);
  }
}

async function markAsRead(inboxId: string, messageId: string, apiKey: string): Promise<void> {
  const url = `${API_BASE}/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}/labels`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ labels: ["read"] }),
  });

  if (!res.ok) {
    console.warn(`Failed to mark message ${messageId} as read: ${res.status}`);
  }
}

async function dispatchToAgent(agentName: string, emailContent: string, from: string, subject: string): Promise<string> {
  // Import relay modules
  const { buildPrompt } = await import("../src/prompt-builder");
  const { getContextDocket } = await import("../src/relay-config");
  const { callClaude } = await import("../src/claude-cli");
  const { processMemoryIntents } = await import("../src/memory");
  const { processResponseTags } = await import("../src/response-tag-processor");

  // Create Supabase client
  const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;
  const emailContext = `[Email from ${from}]\nSubject: ${subject}\n\n${emailContent}`;

  let prompt: string;
  let response: string;

  if (agentName === "general") {
    // General agent flow
    const { getAgentMemoryContext, getRelevantContext } = await import("../src/memory");
    const agentMemory = await getAgentMemoryContext(supabase, "email");
    const relevantContext = await getRelevantContext(supabase, emailContent);

    prompt = buildPrompt(
      emailContext,
      getContextDocket(),
      relevantContext,
      undefined,
      "email",
    );

    const rawResponse = await callClaude(prompt);
    response = await processMemoryIntents(supabase, rawResponse, agentName);
  } else {
    // Specific agent flow (Brian, Amy, etc.)
    const { getAgentArchetype, getAgentRoleContext } = await import("../src/prompt-builder");
    const archetypeContext = await getAgentArchetype(agentName);
    const roleContext = await getAgentRoleContext(agentName);

    prompt = buildPrompt(
      emailContext,
      getContextDocket(),
      undefined, // relevantContext
      undefined, // elasticContext
      "email",
      { name: agentName }, // agentConfig
      undefined, // workItemContext
      undefined, // structuredContext
      undefined, // recentMessages
      undefined, // skillContext
      undefined, // forestContext
      undefined, // agentMemoryContext
      undefined, // sessionIds
      archetypeContext,
      roleContext,
    );

    const rawResponse = await callClaude(prompt);
    response = await processMemoryIntents(supabase, rawResponse, agentName);
  }

  // Process response tags
  const cleanResponse = await processResponseTags(supabase, response, "email");

  // Save message to Supabase (inbound and outbound)
  if (supabase) {
    try {
      const { getOrCreateConversation } = await import("../src/conversations");
      const conversationId = await getOrCreateConversation(supabase, "email", agentName);
      await supabase.from("messages").insert([
        { role: "user", content: emailContent, channel: "email", metadata: { sender: from, subject, agent: agentName }, conversation_id: conversationId },
        { role: "assistant", content: cleanResponse, channel: "email", metadata: { agent: agentName }, conversation_id: conversationId },
      ]);
    } catch (e) {
      console.warn(`   ⚠️  Failed to save messages to DB: ${e}`);
    }
  }

  return cleanResponse;
}

async function main() {
  const config = getAgentMailConfig();
  if (!config) {
    console.error("❌ AgentMail not configured (missing env vars)");
    process.exit(1);
  }

  console.log(`🔍 Polling agent inboxes (${new Date().toISOString()})...\n`);

  let totalProcessed = 0;

  for (const inbox of AGENT_INBOXES) {
    try {
      const unreadMessages = await getUnreadMessages(inbox.inbox_id, config.apiKey);
      console.log(`📬 ${inbox.agent_name}: ${unreadMessages.length} unread message(s)`);

      for (const message of unreadMessages) {
        try {
          console.log(`   Processing: "${message.subject}" from ${message.from}`);

          // Skip self-sent messages (echo prevention)
          // Only skip if the sender inbox matches the recipient inbox
          if (message.from.includes(inbox.inbox_id)) {
            console.log(`   ⏭️  Skipped (self-sent)`);
            await markAsRead(inbox.inbox_id, message.message_id, config.apiKey);
            continue;
          }

          // Fetch full message content
          const { text: content, headers } = await getMessageContent(inbox.inbox_id, message.message_id, config.apiKey);

          // Check if this is an inter-agent message
          const isInterAgent = isInterAgentMessage(headers);
          if (isInterAgent) {
            const senderAgent = headers?.["X-Sent-By-Agent"] || "unknown";
            const senderType = headers?.["X-Agent-Type"] || "unknown";
            const messageType = headers?.["X-Message-Type"] || "inter-agent";
            console.log(`   🤖 Inter-agent message from ${senderAgent} (${senderType}) — type: ${messageType}`);
          }

          // Dispatch to agent
          const response = await dispatchToAgent(inbox.agent_name, content, message.from, message.subject);

          // Send reply (with agent headers)
          try {
            await sendReply(inbox.inbox_id, message.message_id, response, config.apiKey, inbox.agent_name, inbox.agent_type);
            console.log(`   ✅ Processed and replied`);
          } catch (replyErr) {
            console.error(`   ⚠️  Reply failed (rate limit or error), marking as read anyway:`, replyErr instanceof Error ? replyErr.message : String(replyErr));
          }

          // ALWAYS mark as read to prevent re-processing the same message
          await markAsRead(inbox.inbox_id, message.message_id, config.apiKey);

          totalProcessed++;
        } catch (err) {
          console.error(`   ❌ Error processing message ${message.message_id}:`, err);
          // Mark as read even on complete failure to prevent infinite retry loop
          try {
            await markAsRead(inbox.inbox_id, message.message_id, config.apiKey);
          } catch (markErr) {
            console.error(`   ⚠️  Failed to mark as read:`, markErr);
          }
        }
      }
    } catch (err) {
      console.error(`❌ Error polling ${inbox.inbox_id}:`, err);
    }
  }

  console.log(`\n✅ Poll complete: ${totalProcessed} message(s) processed`);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Fatal error:", err);
    process.exit(1);
  });
