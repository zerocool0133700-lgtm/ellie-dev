/**
 * Voice/Video Call Signaling API — ELLIE-877, ELLIE-878
 *
 * WebRTC signaling via the existing WebSocket infrastructure.
 * Agents participate via TTS/STT bridge (not real WebRTC peers).
 *
 * Call types:
 *   - voice: audio-only WebRTC
 *   - video: audio + video WebRTC
 *   - screen: screen sharing session
 *
 * Flow:
 *   1. Caller sends "call_start" via WS with target channel/user
 *   2. Server broadcasts "call_incoming" to channel participants
 *   3. Participants send "call_accept" or "call_decline"
 *   4. Once accepted, exchange SDP offers/answers via WS relay
 *   5. ICE candidates exchanged via WS
 *   6. Media flows peer-to-peer (server is signaling only)
 *   7. Call ends via "call_end" message
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiRequest, ApiResponse } from "./types.ts";
import { log } from "../logger.ts";

const logger = log.child("calls");

export interface CallSession {
  id: string;
  channel_id: string;
  type: "voice" | "video" | "screen";
  state: "ringing" | "active" | "ended";
  caller_id: string;
  participants: string[];
  started_at: string;
  ended_at?: string;
  recording_url?: string;
  transcript?: string;
  duration_ms?: number;
}

// Per-call lock to prevent concurrent mutation from parallel WS messages.
// Bun is single-threaded but async yields between await points allow interleaving.
const callLocks = new Map<string, Promise<void>>();

function withCallLock<T>(callId: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = callLocks.get(callId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  callLocks.set(callId, next.then(() => {}, () => {}));
  return next;
}

// In-memory active calls (no DB table needed for ephemeral state)
const activeCalls = new Map<string, CallSession>();

export function getActiveCall(channelId: string): CallSession | undefined {
  for (const call of activeCalls.values()) {
    if (call.channel_id === channelId && call.state !== "ended") return call;
  }
  return undefined;
}

export function startCall(id: string, channelId: string, callerId: string, type: "voice" | "video" | "screen"): Promise<CallSession> {
  return withCallLock(id, () => {
    const call: CallSession = {
      id,
      channel_id: channelId,
      type,
      state: "ringing",
      caller_id: callerId,
      participants: [callerId],
      started_at: new Date().toISOString(),
    };
    activeCalls.set(id, call);
    logger.info("Call started", { id, channelId, type, caller: callerId });
    return call;
  });
}

export function acceptCall(callId: string, participantId: string): Promise<CallSession | null> {
  return withCallLock(callId, () => {
    const call = activeCalls.get(callId);
    if (!call || call.state === "ended") return null;
    call.state = "active";
    if (!call.participants.includes(participantId)) {
      call.participants.push(participantId);
    }
    logger.info("Call accepted", { id: callId, participant: participantId });
    return call;
  });
}

export function endCall(callId: string): Promise<CallSession | null> {
  return withCallLock(callId, () => {
    const call = activeCalls.get(callId);
    if (!call) return null;
    call.state = "ended";
    call.ended_at = new Date().toISOString();
    call.duration_ms = new Date(call.ended_at).getTime() - new Date(call.started_at).getTime();
    logger.info("Call ended", { id: callId, duration: call.duration_ms });

    // Clean up after 5 minutes
    setTimeout(() => { activeCalls.delete(callId); callLocks.delete(callId); }, 5 * 60 * 1000);
    return call;
  });
}

/**
 * Save call record to Supabase for history (ELLIE-879)
 */
export async function saveCallRecord(supabase: SupabaseClient, call: CallSession): Promise<void> {
  try {
    // Store as a system message in the channel
    const duration = call.duration_ms ? `${Math.round(call.duration_ms / 1000)}s` : "unknown";
    const content = [
      `📞 **${call.type === "video" ? "Video" : "Voice"} call ended**`,
      `Participants: ${call.participants.join(", ")}`,
      `Duration: ${duration}`,
      call.transcript ? `\n📝 **Transcript:**\n${call.transcript}` : "",
    ].filter(Boolean).join("\n");

    await supabase.from("messages").insert({
      role: "system",
      content,
      channel: call.channel_id,
      metadata: {
        call_id: call.id,
        call_type: call.type,
        participants: call.participants,
        duration_ms: call.duration_ms,
        recording_url: call.recording_url,
      },
    });
  } catch (err) {
    logger.error("Failed to save call record", { callId: call.id, error: err });
  }
}

/**
 * GET /api/calls — list active calls
 */
export async function listActiveCalls(req: ApiRequest, res: ApiResponse) {
  const calls = [...activeCalls.values()].filter(c => c.state !== "ended");
  return res.json({ success: true, calls });
}

/**
 * GET /api/calls/:id — get call details
 */
export async function getCallDetails(req: ApiRequest, res: ApiResponse) {
  const id = req.params?.id;
  if (!id) return res.status(400).json({ error: "Missing call ID" });

  const call = activeCalls.get(id);
  if (!call) return res.status(404).json({ error: "Call not found" });

  return res.json({ success: true, call });
}
