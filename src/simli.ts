/**
 * Simli API client — avatar session management.
 *
 * The relay creates session tokens (keeps API key server-side).
 * API key is stored in The Hollow (encrypted credential store).
 * The browser uses simli-client SDK for WebRTC + video.
 */

import { log } from "./logger.ts";
import { getCredentialByDomain } from "../../ellie-forest/src/hollow";

const logger = log.child("simli");

const SIMLI_API_URL = process.env.SIMLI_API_URL || "https://api.simli.ai";
const SIMLI_FACE_ID = process.env.SIMLI_FACE_ID || "";

// Cache the API key after first Hollow lookup
let _cachedApiKey: string | null = null;

async function getSimliApiKey(): Promise<string> {
  if (_cachedApiKey) return _cachedApiKey;
  try {
    const cred = await getCredentialByDomain("simli.ai", "api_key");
    if (cred?.payload) {
      _cachedApiKey = typeof cred.payload === "string" ? cred.payload : String(cred.payload);
      return _cachedApiKey;
    }
  } catch (err) {
    logger.error("Failed to fetch Simli API key from Hollow", err);
  }
  return "";
}

/**
 * Get a Simli session token for the browser to establish WebRTC.
 * Returns the session_token string, or null on failure.
 */
export async function getSimliSessionToken(
  faceId?: string,
  options?: { maxSessionLength?: number; maxIdleTime?: number }
): Promise<string | null> {
  const apiKey = await getSimliApiKey();
  if (!apiKey) {
    logger.error("SIMLI_API_KEY not found in Hollow (simli.ai/api_key)");
    return null;
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
        "x-simli-api-key": apiKey,
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
  const apiKey = await getSimliApiKey();
  if (!apiKey) return null;

  try {
    const response = await fetch(`${SIMLI_API_URL}/compose/ice`, {
      headers: { "x-simli-api-key": apiKey },
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

/** Check if Simli is configured (checks Hollow for API key). */
export async function isSimliConfigured(): Promise<boolean> {
  const apiKey = await getSimliApiKey();
  return !!(apiKey && SIMLI_FACE_ID);
}

/** Get the configured face ID. */
export function getSimliFaceId(): string {
  return SIMLI_FACE_ID;
}
