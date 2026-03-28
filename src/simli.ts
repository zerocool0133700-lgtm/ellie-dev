/**
 * Simli API client — avatar session management.
 *
 * The relay creates session tokens (keeps API key server-side).
 * The browser uses simli-client SDK for WebRTC + video.
 */

import { log } from "./logger.ts";

const logger = log.child("simli");

const SIMLI_API_KEY = process.env.SIMLI_API_KEY || "";
const SIMLI_API_URL = process.env.SIMLI_API_URL || "https://api.simli.ai";
const SIMLI_FACE_ID = process.env.SIMLI_FACE_ID || "";

/**
 * Get a Simli session token for the browser to establish WebRTC.
 * Returns the session_token string, or null on failure.
 */
export async function getSimliSessionToken(
  faceId?: string,
  options?: { maxSessionLength?: number; maxIdleTime?: number }
): Promise<string | null> {
  if (!SIMLI_API_KEY) {
    logger.warn("SIMLI_API_KEY not configured — proceeding without auth header");
  }

  const body = {
    faceId: faceId || SIMLI_FACE_ID,
    handleSilence: true,
    maxSessionLength: options?.maxSessionLength ?? 600,
    maxIdleTime: options?.maxIdleTime ?? 300,
    model: "fasttalk",
  };

  try {
    const response = await fetch(`${SIMLI_API_URL}/compose/token`, {
      method: "POST",
      headers: {
        "x-simli-api-key": SIMLI_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      logger.error("Simli token error", { status: response.status, body: await response.text() });
      return null;
    }

    const data = await response.json() as { session_token: string };
    logger.info("Simli session token created", { faceId: body.faceId });
    return data.session_token;
  } catch (err) {
    logger.error("Simli token request failed", err);
    return null;
  }
}

/**
 * Get ICE servers from Simli for P2P WebRTC.
 * Returns the ICE server array, or null on failure.
 */
export async function getSimliIceServers(): Promise<any[] | null> {
  if (!SIMLI_API_KEY) return null;

  try {
    const response = await fetch(`${SIMLI_API_URL}/compose/ice`, {
      headers: { "x-simli-api-key": SIMLI_API_KEY },
    });

    if (!response.ok) {
      logger.error("Simli ICE error", { status: response.status });
      return null;
    }

    return await response.json() as any[];
  } catch (err) {
    logger.error("Simli ICE request failed", err);
    return null;
  }
}

/** Check if Simli is configured. */
export function isSimliConfigured(): boolean {
  return !!(SIMLI_API_KEY && SIMLI_FACE_ID);
}

/** Get the configured face ID. */
export function getSimliFaceId(): string {
  return SIMLI_FACE_ID;
}
