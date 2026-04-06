#!/usr/bin/env bun
/**
 * Test Inter-Agent Email — Manual verification script
 *
 * Sends a test email from one agent to another with custom headers.
 * Use this to verify the agent-to-agent identification system works end-to-end.
 *
 * Usage:
 *   bun run scripts/test-inter-agent-email.ts --from brian --to amy
 *   bun run scripts/test-inter-agent-email.ts --from amy --to brian --context code-review
 */

import { sendEmail, buildAgentHeaders, getAgentMailConfig } from "../src/agentmail";

interface AgentConfig {
  email: string;
  name: string;
  type: string;
}

const AGENTS: Record<string, AgentConfig> = {
  brian: {
    email: "brian-ellie-os@agentmail.to",
    name: "brian",
    type: "critic",
  },
  amy: {
    email: "amy-ellie-os@agentmail.to",
    name: "amy",
    type: "content",
  },
  // Add more agents as they're set up
  // james: {
  //   email: "james-ellie-os@agentmail.to",
  //   name: "james",
  //   type: "dev",
  // },
};

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const value = args[i + 1];
      if (value && !value.startsWith("--")) {
        parsed[key] = value;
        i++;
      }
    }
  }

  return parsed;
}

async function main() {
  const args = parseArgs();

  const fromAgent = args.from;
  const toAgent = args.to;
  const context = args.context || "test";
  const subject = args.subject || `Test inter-agent email (${context})`;
  const body = args.body || `This is a test email sent from ${fromAgent} to ${toAgent} to verify the agent-to-agent identification system.\n\nHeaders should include:\n- X-Sent-By-Agent: ${fromAgent}\n- X-Agent-Type: ${AGENTS[fromAgent]?.type}\n- X-Message-Type: inter-agent\n- X-Thread-Context: ${context}`;

  // Validate args
  if (!fromAgent || !toAgent) {
    console.error("❌ Usage: bun run scripts/test-inter-agent-email.ts --from <agent> --to <agent>");
    console.error("\nAvailable agents:");
    Object.keys(AGENTS).forEach((agent) => {
      console.error(`  - ${agent} (${AGENTS[agent].email})`);
    });
    process.exit(1);
  }

  if (!AGENTS[fromAgent]) {
    console.error(`❌ Unknown sender agent: ${fromAgent}`);
    console.error("Available agents:", Object.keys(AGENTS).join(", "));
    process.exit(1);
  }

  if (!AGENTS[toAgent]) {
    console.error(`❌ Unknown recipient agent: ${toAgent}`);
    console.error("Available agents:", Object.keys(AGENTS).join(", "));
    process.exit(1);
  }

  // Get config (we'll use the default AgentMail config)
  const config = getAgentMailConfig();
  if (!config) {
    console.error("❌ AgentMail not configured. Check .env for:");
    console.error("  - AGENTMAIL_API_KEY");
    console.error("  - AGENTMAIL_INBOX_EMAIL");
    console.error("  - AGENTMAIL_WEBHOOK_SECRET");
    process.exit(1);
  }

  // Build agent headers
  const headers = buildAgentHeaders(
    AGENTS[fromAgent].name,
    AGENTS[fromAgent].type,
    "inter-agent",
    context,
  );

  console.log(`📧 Sending inter-agent email:`);
  console.log(`   From: ${fromAgent} (${AGENTS[fromAgent].email})`);
  console.log(`   To: ${toAgent} (${AGENTS[toAgent].email})`);
  console.log(`   Subject: ${subject}`);
  console.log(`   Context: ${context}`);
  console.log(`\n📋 Headers:`);
  Object.entries(headers).forEach(([key, value]) => {
    console.log(`   ${key}: ${value}`);
  });

  try {
    // Note: We're sending FROM the default inbox (ellie.os@agentmail.to) TO the target agent
    // This simulates what would happen if the sender agent had their own inbox configured
    const result = await sendEmail(
      [AGENTS[toAgent].email],
      subject,
      body,
      config,
      headers,
    );

    console.log(`\n✅ Email sent successfully!`);
    console.log(`   Message ID: ${result.message_id}`);
    console.log(`   Thread ID: ${result.thread_id}`);

    console.log(`\n🔍 Next steps:`);
    console.log(`   1. Check ${toAgent}'s inbox within 10 minutes (agent-email-poll runs every 10min)`);
    console.log(`   2. Watch the logs: journalctl --user -u agent-email-poll.service -f`);
    console.log(`   3. Look for: "🤖 Inter-agent message from ${fromAgent} (${AGENTS[fromAgent].type}) — type: inter-agent"`);
    console.log(`   4. ${toAgent} should process and reply with their own agent headers`);
  } catch (err) {
    console.error(`\n❌ Failed to send email:`, err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
