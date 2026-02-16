/**
 * Google Chat Integration Test
 *
 * Verifies service account auth is configured correctly.
 * Run: bun run test:gchat
 */

import "dotenv/config";
import { readFile } from "fs/promises";
import { createSign } from "crypto";

const KEY_PATH = process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_KEY_PATH || "";
const ALLOWED_EMAIL = process.env.GOOGLE_CHAT_ALLOWED_EMAIL || "";

async function testServiceAccount(): Promise<boolean> {
  if (!KEY_PATH) {
    console.error("GOOGLE_CHAT_SERVICE_ACCOUNT_KEY_PATH is not set in .env");
    return false;
  }

  // Load key file
  let sa: { client_email: string; private_key: string; token_uri: string };
  try {
    const raw = await readFile(KEY_PATH, "utf-8");
    sa = JSON.parse(raw);
    console.log(`Service account: ${sa.client_email}`);
  } catch (err: any) {
    console.error(`Failed to read key file at ${KEY_PATH}:`, err.message);
    return false;
  }

  // Verify required fields
  if (!sa.client_email || !sa.private_key || !sa.token_uri) {
    console.error("Key file is missing required fields (client_email, private_key, token_uri)");
    return false;
  }

  // Sign a test JWT and exchange for access token
  try {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/chat.bot",
      aud: sa.token_uri,
      iat: now,
      exp: now + 3600,
    })).toString("base64url");

    const signInput = `${header}.${payload}`;
    const signer = createSign("RSA-SHA256");
    signer.update(signInput);
    const signature = signer.sign(sa.private_key, "base64url");
    const jwt = `${signInput}.${signature}`;

    console.log("JWT signed successfully");

    const res = await fetch(sa.token_uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`Token exchange failed (${res.status}):`, body);
      return false;
    }

    const data = await res.json();
    console.log(`Access token obtained (expires in ${data.expires_in}s)`);
    return true;
  } catch (err: any) {
    console.error("Auth error:", err.message);
    return false;
  }
}

// ---- Main ----

console.log("Google Chat Integration Test\n");

if (!KEY_PATH) {
  console.log("GOOGLE_CHAT_SERVICE_ACCOUNT_KEY_PATH is not set in .env — Google Chat is disabled.");
  console.log("\nTo enable:");
  console.log("1. Enable Google Chat API in Google Cloud Console");
  console.log("2. Create a service account and download the JSON key");
  console.log("3. Set GOOGLE_CHAT_SERVICE_ACCOUNT_KEY_PATH in .env");
  console.log("4. Set GOOGLE_CHAT_ALLOWED_EMAIL to your Google email");
  process.exit(0);
}

let allGood = true;

// Test auth
const authOk = await testServiceAccount();
if (!authOk) allGood = false;

// Check allowed email
if (!ALLOWED_EMAIL) {
  console.warn("\nGOOGLE_CHAT_ALLOWED_EMAIL is not set — all messages will be rejected");
  allGood = false;
} else {
  console.log(`Allowed email: ${ALLOWED_EMAIL}`);
}

if (allGood) {
  console.log("\nGoogle Chat integration is ready.");
  console.log(`\nWebhook URL: {PUBLIC_URL}/google-chat`);
  console.log("Configure this in Google Cloud Console > Chat API > Configuration > Connection settings");
} else {
  console.error("\nGoogle Chat test failed. Fix the issues above.");
  process.exit(1);
}
