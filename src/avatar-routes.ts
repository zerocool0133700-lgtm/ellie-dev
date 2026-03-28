/**
 * Avatar API routes — Simli session + TTS streaming for avatar lip-sync.
 *
 * POST /api/avatar/session — create Simli session, return token + ICE servers
 * POST /api/avatar/speak   — stream PCM16 TTS audio for browser to pipe to Simli
 * GET  /api/avatar/status   — check if avatar (Simli) is configured
 */

import type { IncomingMessage, ServerResponse } from "http";
import { log } from "./logger.ts";
import { getSimliSessionToken, getSimliIceServers, isSimliConfigured } from "./simli.ts";
import { textToSpeechPCM16Stream } from "./tts.ts";

const logger = log.child("avatar");

/**
 * Handle avatar-related API routes.
 * Returns true if the route was handled, false if not an avatar route.
 */
export function handleAvatarRoutes(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  authenticateRequest: (req: IncomingMessage, scope: string, legacyKey: string) => Promise<boolean>,
  legacyKey: string,
): boolean {
  if (!url.pathname.startsWith("/api/avatar")) return false;

  // GET /api/avatar/status — no auth needed
  if (url.pathname === "/api/avatar/status" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ configured: isSimliConfigured() }));
    return true;
  }

  // POST /api/avatar/session — create Simli session
  if (url.pathname === "/api/avatar/session" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const auth = await authenticateRequest(req, "tts", legacyKey);
        if (!auth) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        const [sessionToken, iceServers] = await Promise.all([
          getSimliSessionToken(),
          getSimliIceServers(),
        ]);

        if (!sessionToken) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Simli unavailable" }));
          return;
        }

        logger.info("Avatar session created");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          session_token: sessionToken,
          ice_servers: iceServers,
        }));
      } catch (err) {
        logger.error("Avatar session error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
    return true;
  }

  // POST /api/avatar/speak — stream PCM16 TTS for Simli
  if (url.pathname === "/api/avatar/speak" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const auth = await authenticateRequest(req, "tts", legacyKey);
        if (!auth) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        const data = JSON.parse(body);
        if (!data.text || typeof data.text !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing 'text' field" }));
          return;
        }

        const text = data.text.substring(0, 4000);
        const providerOverride = (data.provider === "elevenlabs" || data.provider === "openai")
          ? data.provider : undefined;

        const stream = await textToSpeechPCM16Stream(text, providerOverride);
        if (!stream) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "TTS unavailable" }));
          return;
        }

        // Stream PCM16 directly to the browser
        res.writeHead(200, {
          "Content-Type": "audio/pcm",
          "X-Audio-Format": "pcm_s16le",
          "X-Sample-Rate": "16000",
          "X-Channels": "1",
        });
        for await (const chunk of stream.body) {
          res.write(chunk);
        }
        res.end();
      } catch (err) {
        logger.error("Avatar speak error", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        }
      }
    });
    return true;
  }

  return false;
}
