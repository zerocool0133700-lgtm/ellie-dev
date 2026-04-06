#!/usr/bin/env bun
/**
 * Phase 4: Send welcome emails to Brian and Amy asking them to
 * describe what they see in their profile/soul/archetype/role setup.
 */

import { sendEmail } from "../src/agentmail.ts";

const brianEmail = "brian-ellie-os@agentmail.to";
const amyEmail = "amy-ellie-os@agentmail.to";

const welcomeMessageBrian = `
Hi Brian,

Welcome to the Ellie OS agent team! You're now active as the Critic agent.

**Quick request:** Reply to this email with a summary of what you see in your profile — your soul, archetype, behavioral rules, role definition, species, the whole setup. I want to verify you're seeing the right configuration.

This helps us confirm:
- Your soul file is loading (patient teacher, forest metaphor, etc.)
- Your archetype is correct (Owl, depth-first, systematic review)
- Your role instructions are complete (what you do, tools available, communication contracts)
- Your skills are accessible

Take your time and give me a complete overview of what you're seeing.

Thanks!

— Dave (via Ellie)
`.trim();

const welcomeMessageAmy = `
Hi Amy,

Welcome to the Ellie OS agent team! You're now active as the Content agent.

**Quick request:** Reply to this email with a summary of what you see in your profile — your soul, archetype, behavioral rules, role definition, species, the whole setup. I want to verify you're seeing the right configuration.

This helps us confirm:
- Your soul file is loading (patient teacher, forest metaphor, etc.)
- Your archetype is correct (Ant, depth-first, single-threaded focus)
- Your role instructions are complete (what you do, tools available, communication contracts)
- Your skills are accessible

Take your time and give me a complete overview of what you're seeing.

Thanks!

— Dave (via Ellie)
`.trim();

try {
  console.log("📧 Sending welcome email to Brian...\n");
  const brianResult = await sendEmail(
    [brianEmail],
    "Welcome to the team, Brian!",
    welcomeMessageBrian
  );
  console.log("✅ Email sent to Brian");
  console.log(`   Message ID: ${brianResult.message_id}`);
  console.log(`   Thread ID: ${brianResult.thread_id}\n`);

  console.log("📧 Sending welcome email to Amy...\n");
  const amyResult = await sendEmail(
    [amyEmail],
    "Welcome to the team, Amy!",
    welcomeMessageAmy
  );
  console.log("✅ Email sent to Amy");
  console.log(`   Message ID: ${amyResult.message_id}`);
  console.log(`   Thread ID: ${amyResult.thread_id}\n`);

  console.log("✅ Both welcome emails sent successfully!");
  console.log("\n📝 Next steps:");
  console.log("1. Obtain Brian and Amy's AgentMail API keys");
  console.log("2. Set up email polling every 10 minutes");
  console.log("3. Configure agent-specific prompt injection");
  console.log("4. Verify responses when they reply");

  process.exit(0);
} catch (err) {
  console.error("❌ Error:", err);
  process.exit(1);
}
