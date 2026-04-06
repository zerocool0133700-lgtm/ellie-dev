#!/usr/bin/env bun
/**
 * Test script: Send test emails to Brian and Amy's AgentMail addresses
 * to verify connectivity.
 */

import { sendEmail } from "../src/agentmail.ts";

const brianEmail = "brian-ellie-os@agentmail.to";
const amyEmail = "amy-ellie-os@agentmail.to";

try {
  console.log("Sending test email to Brian...");
  const brianResult = await sendEmail(
    [brianEmail],
    "Test: AgentMail Connectivity",
    "This is a test email to verify Brian's AgentMail inbox is reachable. If you receive this, the inbox exists and is functional."
  );
  console.log("✅ Email sent to Brian:", brianResult);

  console.log("\nSending test email to Amy...");
  const amyResult = await sendEmail(
    [amyEmail],
    "Test: AgentMail Connectivity",
    "This is a test email to verify Amy's AgentMail inbox is reachable. If you receive this, the inbox exists and is functional."
  );
  console.log("✅ Email sent to Amy:", amyResult);

  console.log("\n✅ Both test emails sent successfully!");
  process.exit(0);
} catch (err) {
  console.error("❌ Error:", err);
  process.exit(1);
}
