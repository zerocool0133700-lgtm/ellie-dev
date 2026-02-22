#!/usr/bin/env bun
/**
 * Microsoft OAuth 2.0 Flow (Outlook / Hotmail)
 *
 * Gets a refresh token for Microsoft Graph API email access.
 * Run once per Microsoft account.
 *
 * Usage:
 *   bun scripts/oauth-microsoft.ts
 *
 * Prerequisites:
 *   1. Register an app at https://portal.azure.com > App registrations
 *      - Name: "Ellie Email" (or similar)
 *      - Supported account types: "Personal Microsoft accounts only"
 *   2. Set redirect URI: http://localhost:8978/callback (Web platform)
 *   3. Go to API permissions > Add permission > Microsoft Graph > Delegated:
 *      - Mail.Read, Mail.Send, Mail.ReadWrite, User.Read, offline_access
 *   4. Go to Certificates & secrets > New client secret > copy the value
 *   5. Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET in .env
 */

import { readFile } from "fs/promises";
import { join, dirname } from "path";

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

const CLIENT_ID = envVars.MICROSOFT_CLIENT_ID;
const CLIENT_SECRET = envVars.MICROSOFT_CLIENT_SECRET;
const PORT = 8978;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = [
  "Mail.Read",
  "Mail.Send",
  "Mail.ReadWrite",
  "offline_access",
  "User.Read",
];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing MICROSOFT_CLIENT_ID or MICROSOFT_CLIENT_SECRET in .env");
  console.error("\nSetup steps:");
  console.error("  1. Go to https://portal.azure.com > App registrations > New registration");
  console.error('  2. Account types: "Personal Microsoft accounts only"');
  console.error(`  3. Redirect URI: Web > ${REDIRECT_URI}`);
  console.error("  4. Create a client secret under Certificates & secrets");
  console.error("  5. Add these to .env:");
  console.error("     MICROSOFT_CLIENT_ID=<Application (client) ID>");
  console.error("     MICROSOFT_CLIENT_SECRET=<Client secret value>");
  process.exit(1);
}

// "consumers" tenant for personal Microsoft accounts (Outlook.com / Hotmail / Live)
const AUTH_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize";
const TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";

const authUrl = new URL(AUTH_URL);
authUrl.searchParams.set("client_id", CLIENT_ID);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPES.join(" "));
authUrl.searchParams.set("response_mode", "query");
authUrl.searchParams.set("prompt", "consent");

console.log("\n=== Microsoft OAuth Flow (Outlook / Hotmail) ===\n");
console.log("1. Open this URL in your browser:\n");
console.log(authUrl.toString());
console.log(`\n2. Sign in with your Microsoft account and authorize access.`);
console.log(`\n3. You'll be redirected to localhost:${PORT} — the token will be captured automatically.\n`);

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname !== "/callback") {
      return new Response("Waiting for OAuth callback...", { status: 200 });
    }

    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (error) {
      console.error(`\nOAuth error: ${error} — ${url.searchParams.get("error_description")}`);
      server.stop();
      process.exit(1);
    }

    if (!code) {
      return new Response("Missing authorization code", { status: 400 });
    }

    // Exchange code for tokens
    try {
      const tokenRes = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          code,
          redirect_uri: REDIRECT_URI,
          grant_type: "authorization_code",
          scope: SCOPES.join(" "),
        }),
      });

      if (!tokenRes.ok) {
        const body = await tokenRes.text();
        console.error(`\nToken exchange failed (${tokenRes.status}): ${body}`);
        server.stop();
        process.exit(1);
      }

      const tokenData = await tokenRes.json();
      const refreshToken = tokenData.refresh_token;

      if (!refreshToken) {
        console.error("\nNo refresh token in response. Make sure offline_access scope is included.");
        console.error("Response:", JSON.stringify(tokenData, null, 2));
        server.stop();
        process.exit(1);
      }

      console.log("\n=== SUCCESS ===\n");
      console.log("Add these to your .env file:\n");
      console.log(`MICROSOFT_REFRESH_TOKEN=${refreshToken}`);

      // Try to get the user's email
      try {
        const profileRes = await fetch("https://graph.microsoft.com/v1.0/me", {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        if (profileRes.ok) {
          const profile = await profileRes.json();
          const email = profile.mail || profile.userPrincipalName || "";
          if (email) {
            console.log(`MICROSOFT_USER_EMAIL=${email}`);
          }
        }
      } catch {
        // Non-critical — user can set email manually
      }

      console.log("\nThen restart the relay.");

      setTimeout(() => {
        server.stop();
        process.exit(0);
      }, 500);

      return new Response(
        "<html><body style='font-family:sans-serif;text-align:center;padding:60px'>" +
          "<h1>Authorized!</h1><p>You can close this tab. Check the terminal for your refresh token.</p>" +
          "</body></html>",
        { headers: { "Content-Type": "text/html" } },
      );
    } catch (err) {
      console.error("\nToken exchange error:", err);
      server.stop();
      process.exit(1);
    }
  },
});

console.log(`Listening for callback on http://localhost:${PORT}...\n`);
