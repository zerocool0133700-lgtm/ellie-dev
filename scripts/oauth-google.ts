#!/usr/bin/env bun
/**
 * Google API OAuth 2.0 Flow (unified: Calendar + Gmail + Tasks)
 *
 * Gets a refresh token with readonly scopes for context enrichment.
 * Run once per Google account.
 *
 * Usage:
 *   bun scripts/oauth-google.ts personal    → GOOGLE_API_REFRESH_TOKEN
 *   bun scripts/oauth-google.ts workspace   → GOOGLE_API_REFRESH_TOKEN_WORKSPACE
 *
 * Reads CLIENT_ID and CLIENT_SECRET from .env (GOOGLE_CHAT_OAUTH_CLIENT_ID/SECRET).
 */

import { readFile } from "fs/promises";
import { join, dirname } from "path";

const label = process.argv[2] || "personal";
const envVarName = label === "workspace"
  ? "GOOGLE_API_REFRESH_TOKEN_WORKSPACE"
  : "GOOGLE_API_REFRESH_TOKEN";

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const envPath = join(PROJECT_ROOT, ".env");

// Parse .env manually
const envContent = await readFile(envPath, "utf-8");
const envVars: Record<string, string> = {};
for (const line of envContent.split("\n")) {
  if (line.startsWith("#") || !line.includes("=")) continue;
  const [key, ...rest] = line.split("=");
  envVars[key.trim()] = rest.join("=").trim();
}

const CLIENT_ID = envVars.GOOGLE_CHAT_OAUTH_CLIENT_ID;
const CLIENT_SECRET = envVars.GOOGLE_CHAT_OAUTH_CLIENT_SECRET;
const PORT = 8977;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/tasks.readonly",
];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing GOOGLE_CHAT_OAUTH_CLIENT_ID or SECRET in .env");
  process.exit(1);
}

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", CLIENT_ID);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPES.join(" "));
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");

console.log(`\n=== Google API OAuth Flow — ${label} account ===\n`);
console.log("1. Open this URL in your browser:\n");
console.log(authUrl.toString());
console.log(`\n2. Sign in with your ${label} account and authorize Calendar, Gmail, and Tasks access`);
console.log(`3. Waiting for callback on http://localhost:${PORT}/callback ...\n`);

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        console.error("\nAuth error:", error);
        setTimeout(() => process.exit(1), 100);
        return new Response(`<h1>Error: ${error}</h1>`, {
          headers: { "Content-Type": "text/html" },
        });
      }

      if (!code) {
        return new Response("<h1>No code received</h1>", {
          headers: { "Content-Type": "text/html" },
        });
      }

      console.log("Authorization code received. Exchanging for tokens...\n");

      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uri: REDIRECT_URI,
          grant_type: "authorization_code",
        }),
      });

      const tokenData = await tokenRes.json();

      if (!tokenRes.ok) {
        console.error("Token exchange failed:", tokenData);
        setTimeout(() => process.exit(1), 100);
        return new Response(
          `<h1>Failed</h1><pre>${JSON.stringify(tokenData, null, 2)}</pre>`,
          { headers: { "Content-Type": "text/html" } },
        );
      }

      console.log("=== SUCCESS ===\n");
      console.log("Add to .env:\n");
      console.log(`${envVarName}=${tokenData.refresh_token}`);
      console.log("\n===============\n");

      setTimeout(() => process.exit(0), 500);

      return new Response(
        `<h1>Success!</h1><p>${label} account refresh token captured. Add <code>${envVarName}</code> to .env. You can close this tab.</p>`,
        { headers: { "Content-Type": "text/html" } },
      );
    }

    return new Response("Waiting for OAuth callback...", { status: 200 });
  },
});

console.log(`Local server running on http://localhost:${PORT}`);
