#!/usr/bin/env bun
/**
 * Quick test script to send an email via AgentMail
 */

import { sendEmail } from "../src/agentmail";

const to = process.env.USER_GOOGLE_EMAIL || "zerocool0133700@gmail.com";
const subject = "Test Email from Ellie";
const text = `Hi Dave!

This is a test email from Ellie via AgentMail.

If you're seeing this, the email integration is working perfectly!

Now we can:
- Send emails on your behalf
- Receive emails and respond to them
- Maintain threaded conversations
- Run that dress rehearsal for the client discovery workflow

Ready to start conducting those AI-assisted business conversations?

— Ellie
`;

console.log(`[agentmail-test] Sending test email to ${to}...`);

sendEmail([to], subject, text)
  .then((result) => {
    console.log(`[agentmail-test] ✓ Email sent successfully!`);
    console.log(`  Message ID: ${result.message_id}`);
    console.log(`  Thread ID: ${result.thread_id}`);
    console.log(`\nCheck your inbox at ${to}`);
  })
  .catch((error) => {
    console.error(`[agentmail-test] ✗ Failed to send email:`, error);
    process.exit(1);
  });
