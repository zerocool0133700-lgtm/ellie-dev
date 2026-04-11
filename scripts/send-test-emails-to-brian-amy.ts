#!/usr/bin/env bun

/**
 * Send test emails to Brian and Amy to verify the AgentMail pipeline.
 * Run: bun scripts/send-test-emails-to-brian-amy.ts
 */

import { sendEmail } from "../src/agentmail";

async function main() {
  console.log("📧 Sending test emails to Brian and Amy...\n");

  // Email to Brian (Critic)
  const brianEmail = "brian-ellie-os@agentmail.to";
  const brianSubject = "Testing the Wire — Can You Hear Me?";
  const brianBody = `Hey Brian,

This is Dave. Just bringing you online for the first time. If you're receiving this and the AgentMail → polling → relay pipeline is working, reply with a quick confirmation.

Let me know you're awake and we'll get you your first review assignment.

— Dave`;

  console.log(`Sending to ${brianEmail}...`);
  const brianResult = await sendEmail([brianEmail], brianSubject, brianBody);
  console.log(`✅ Sent to Brian: ${brianResult.message_id}\n`);

  // Email to Amy (Content)
  const amyEmail = "amy-ellie-os@agentmail.to";
  const amySubject = "First Signal — Testing Your Inbox";
  const amyBody = `Hey Amy,

Dave here. You're officially live now. If this message reaches you and you can reply, just send me a quick confirmation so I know the email pipeline is working.

Once I hear back, I'll send your first documentation task.

— Dave`;

  console.log(`Sending to ${amyEmail}...`);
  const amyResult = await sendEmail([amyEmail], amySubject, amyBody);
  console.log(`✅ Sent to Amy: ${amyResult.message_id}\n`);

  console.log("🎉 Both test emails sent successfully!");
  console.log("\nNext steps:");
  console.log("1. Check the polling service logs:");
  console.log("   journalctl --user -u agent-email-poll -f");
  console.log("2. Wait for Brian and Amy to reply (polling runs every 10 minutes)");
  console.log("3. Confirm replies arrive and are dispatched correctly");
}

main().catch((error) => {
  console.error("❌ Failed to send test emails:", error);
  process.exit(1);
});
