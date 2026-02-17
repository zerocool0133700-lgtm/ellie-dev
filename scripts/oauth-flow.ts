#!/usr/bin/env bun
/**
 * Google Chat OAuth 2.0 Flow
 *
 * Usage: bun scripts/oauth-flow.ts <client_id> <client_secret>
 *
 * Opens a browser URL for consent, captures the callback,
 * exchanges the code for a refresh token, and prints the result.
 */

const CLIENT_ID = process.argv[2];
const CLIENT_SECRET = process.argv[3];
const PORT = 8976;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = [
  "https://www.googleapis.com/auth/chat.messages",
  "https://www.googleapis.com/auth/chat.spaces",
  "https://www.googleapis.com/auth/chat.messages.readonly",
];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Usage: bun scripts/oauth-flow.ts <client_id> <client_secret>");
  process.exit(1);
}

// Build the consent URL
const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", CLIENT_ID);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPES.join(" "));
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");

console.log("\n=== Google Chat OAuth Flow ===\n");
console.log("1. Open this URL in your browser:\n");
console.log(authUrl.toString());
console.log("\n2. Sign in and authorize the app");
console.log(`3. Waiting for callback on http://localhost:${PORT}/callback ...\n`);

// Start local server to capture the callback
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

      // Exchange code for tokens
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
        return new Response(`<h1>Token exchange failed</h1><pre>${JSON.stringify(tokenData, null, 2)}</pre>`, {
          headers: { "Content-Type": "text/html" },
        });
      }

      console.log("=== SUCCESS ===\n");
      console.log("Refresh Token:", tokenData.refresh_token);
      console.log("\nAdd to .env:");
      console.log(`GOOGLE_CHAT_OAUTH_CLIENT_ID=${CLIENT_ID}`);
      console.log(`GOOGLE_CHAT_OAUTH_CLIENT_SECRET=${CLIENT_SECRET}`);
      console.log(`GOOGLE_CHAT_OAUTH_REFRESH_TOKEN=${tokenData.refresh_token}`);
      console.log("\n===============\n");

      setTimeout(() => process.exit(0), 500);

      return new Response(
        `<h1>Success!</h1><p>Refresh token captured. You can close this tab.</p>`,
        { headers: { "Content-Type": "text/html" } },
      );
    }

    return new Response("Waiting for OAuth callback...", { status: 200 });
  },
});

console.log(`Local server running on http://localhost:${PORT}`);
