/**
 * Voice Pipeline — Twilio media stream handler + voice processing.
 *
 * Extracted from relay.ts — ELLIE-211.
 * Handles: VoiceCallSession lifecycle, silence detection, audio processing,
 * transcription → LLM → TTS pipeline, WebSocket connection management.
 */

import type { WebSocket } from "ws";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mulawEnergy, transcribeMulaw, streamTTSToTwilio, textToSpeechMulaw } from "./tts.ts";
import { callClaudeVoice } from "./claude-cli.ts";
import { saveMessage } from "./message-sender.ts";
import { getRelevantContext } from "./memory.ts";
import { searchElastic } from "./elasticsearch.ts";
import { getForestContext } from "./elasticsearch/context.ts";
import { trimSearchContext } from "./relay-utils.ts";
import { USER_NAME } from "./prompt-builder.ts";
import { log } from "./logger.ts";

const logger = log.child("voice-pipeline");

// ── Config ───────────────────────────────────────────────────

const MULAW_ENERGY_THRESHOLD = 10;
const SILENCE_THRESHOLD_MS = 800;
const MIN_AUDIO_MS = 400;

// ── External dependencies (registered by relay.ts at startup) ──

export interface VoicePipelineDeps {
  supabase: SupabaseClient | null;
  getActiveAgent: (channel?: string) => string;
  broadcastExtension: (event: Record<string, unknown>) => void;
  getContextDocket: () => Promise<string>;
  triggerConsolidation: (channel?: string) => Promise<void>;
}

let _deps: VoicePipelineDeps = {
  supabase: null,
  getActiveAgent: () => "general",
  broadcastExtension: () => {},
  getContextDocket: async () => "",
  triggerConsolidation: async () => {},
};

export function setVoicePipelineDeps(deps: VoicePipelineDeps): void { _deps = deps; }

// ── VoiceCallSession ─────────────────────────────────────────

interface VoiceCallSession {
  ws: WebSocket;
  streamSid: string | null;
  callSid: string | null;
  audioChunks: Buffer[];
  silenceTimer: ReturnType<typeof setTimeout> | null;
  lastAudioTime: number;
  lastSpeechTime: number;
  hasSpeech: boolean;
  processing: boolean;
  speaking: boolean;
  conversationHistory: Array<{ role: string; content: string }>;
}

// ── processVoiceAudio ────────────────────────────────────────

async function processVoiceAudio(session: VoiceCallSession): Promise<void> {
  if (session.processing || session.audioChunks.length === 0) return;
  session.processing = true;

  const chunks = session.audioChunks.splice(0);
  const pipelineStart = Date.now();

  try {
    // Start context retrieval in parallel with transcription
    const contextDocketPromise = _deps.getContextDocket();

    console.log(`[voice] Transcribing ${chunks.length} chunks...`);
    const text = await transcribeMulaw(chunks);

    if (!text || text.length < 2 || text.includes("[BLANK_AUDIO]") || text.includes("(blank audio)")) {
      console.log("[voice] Empty/blank transcription, skipping");
      session.processing = false;
      return;
    }

    console.log(`[voice] User said: "${text}" (transcribed in ${Date.now() - pipelineStart}ms)`);
    session.conversationHistory.push({ role: "user", content: text });

    // Fire-and-forget: save user message
    saveMessage("user", text, { callSid: session.callSid }, "voice", session.callSid || undefined).catch(() => {});
    _deps.broadcastExtension({ type: "message_in", channel: "voice", preview: text.substring(0, 200) });

    const conversationContext = session.conversationHistory
      .slice(-6)
      .map(m => `${m.role}: ${m.content}`)
      .join("\n");

    // Text-dependent searches in parallel with pre-started docket fetch
    const [contextDocket, relevantContext, elasticContext, forestContext] = await Promise.all([
      contextDocketPromise,
      getRelevantContext(_deps.supabase, text, "voice", _deps.getActiveAgent("voice")),
      searchElastic(text, { limit: 3, recencyBoost: true, channel: "voice", sourceAgent: _deps.getActiveAgent("voice") }),
      getForestContext(text),
    ]);

    const systemParts = [
      "You are Ellie, Dave's AI assistant. You are on a VOICE CALL.",
      "Keep responses SHORT and natural for speech — 1-3 sentences max.",
      "No markdown, no bullet points, no formatting. Just spoken words.",
      "Be warm and conversational, like talking to a friend.",
    ];
    if (USER_NAME) systemParts.push(`You are speaking with ${USER_NAME}.`);
    if (contextDocket) systemParts.push(`\n${contextDocket}`);
    const voiceSearchBlock = trimSearchContext([relevantContext || '', elasticContext || '', forestContext || '']);
    if (voiceSearchBlock) systemParts.push(`\n${voiceSearchBlock}`);

    const systemPrompt = systemParts.join("\n");

    const userPrompt = conversationContext
      ? `Conversation so far:\n${conversationContext}\n\nDave just said: ${text}`
      : `Dave said: ${text}`;

    const response = await callClaudeVoice(systemPrompt, userPrompt);
    const cleanResponse = response
      .replace(/\[REMEMBER:.*?\]/g, "")
      .replace(/\[GOAL:.*?\]/g, "")
      .replace(/\[DONE:.*?\]/g, "")
      .trim();

    console.log(`[voice] Ellie says: "${cleanResponse}" (LLM done at ${Date.now() - pipelineStart}ms)`);
    session.conversationHistory.push({ role: "assistant", content: cleanResponse });

    // Fire-and-forget: save assistant message
    saveMessage("assistant", cleanResponse, { callSid: session.callSid }, "voice", session.callSid || undefined).catch(() => {});
    _deps.broadcastExtension({ type: "message_out", channel: "voice", agent: "voice", preview: cleanResponse.substring(0, 200) });

    if (!session.streamSid) {
      logger.error("No stream SID");
      session.processing = false;
      return;
    }

    // Mark as speaking — ignore inbound audio until playback finishes
    session.speaking = true;

    // Clear buffered audio then stream response
    session.ws.send(JSON.stringify({ event: "clear", streamSid: session.streamSid }));

    // Stream TTS chunks to Twilio as they arrive from ElevenLabs
    const streamed = await streamTTSToTwilio(cleanResponse, session.ws, session.streamSid);

    if (!streamed) {
      // Fallback to non-streaming TTS
      console.log("[voice] Streaming failed, falling back to buffered TTS");
      const audioBase64 = await textToSpeechMulaw(cleanResponse);
      if (!audioBase64) {
        logger.error("No audio from fallback TTS");
        session.speaking = false;
        session.processing = false;
        return;
      }
      const CHUNK_SIZE = 160 * 20;
      const audioBuffer = Buffer.from(audioBase64, "base64");
      for (let i = 0; i < audioBuffer.length; i += CHUNK_SIZE) {
        const chunk = audioBuffer.subarray(i, i + CHUNK_SIZE);
        session.ws.send(JSON.stringify({
          event: "media",
          streamSid: session.streamSid,
          media: { payload: chunk.toString("base64") },
        }));
      }
    }

    // Send mark to detect when playback finishes
    session.ws.send(JSON.stringify({
      event: "mark",
      streamSid: session.streamSid,
      mark: { name: `response_${Date.now()}` },
    }));

    console.log(`[voice] Total pipeline: ${Date.now() - pipelineStart}ms`);
  } catch (error) {
    logger.error("Processing error", error);
  }

  session.processing = false;
}

// ── handleVoiceConnection ────────────────────────────────────

/**
 * Handle a new Twilio media stream WebSocket connection.
 * Call from voiceWss.on("connection", handleVoiceConnection).
 */
export function handleVoiceConnection(ws: WebSocket): void {
  console.log("[voice] Media stream connected");
  const session: VoiceCallSession = {
    ws, streamSid: null, callSid: null,
    audioChunks: [], silenceTimer: null,
    lastAudioTime: 0, lastSpeechTime: 0,
    hasSpeech: false, processing: false, speaking: false,
    conversationHistory: [],
  };

  ws.on("message", async (data: Buffer | string) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.event) {
        case "connected":
          console.log("[voice] Stream connected:", msg.protocol);
          break;

        case "start":
          session.streamSid = msg.streamSid;
          session.callSid = msg.callSid;
          console.log(`[voice] Call started — streamSid: ${msg.streamSid}, callSid: ${msg.callSid}`);
          break;

        case "media": {
          // Ignore inbound audio while Ellie is speaking (prevents echo/feedback loop)
          if (session.speaking) break;

          const payload = Buffer.from(msg.media.payload, "base64");
          const now = Date.now();
          session.lastAudioTime = now;

          const energy = mulawEnergy(payload);
          const isSpeech = energy > MULAW_ENERGY_THRESHOLD;

          if (isSpeech) {
            session.audioChunks.push(payload);
            session.lastSpeechTime = now;
            session.hasSpeech = true;

            if (session.silenceTimer) {
              clearTimeout(session.silenceTimer);
              session.silenceTimer = null;
            }
          } else if (session.hasSpeech && !session.processing) {
            session.audioChunks.push(payload);

            if (!session.silenceTimer) {
              session.silenceTimer = setTimeout(() => {
                session.silenceTimer = null;
                const totalBytes = session.audioChunks.reduce((sum, c) => sum + c.length, 0);
                const estimatedMs = (totalBytes / 8000) * 1000;

                if (estimatedMs >= MIN_AUDIO_MS) {
                  session.hasSpeech = false;
                  processVoiceAudio(session);
                } else {
                  session.audioChunks = [];
                  session.hasSpeech = false;
                }
              }, SILENCE_THRESHOLD_MS);
            }
          }
          break;
        }

        case "mark":
          console.log(`[voice] Playback mark: ${msg.mark?.name}`);
          session.speaking = false;
          session.audioChunks = [];
          session.hasSpeech = false;
          break;

        case "stop":
          console.log("[voice] Stream stopped");
          if (session.silenceTimer) clearTimeout(session.silenceTimer);
          break;
      }
    } catch (error) {
      logger.error("Message parse error", error);
    }
  });

  ws.on("close", () => {
    console.log("[voice] WebSocket closed");
    if (session.silenceTimer) clearTimeout(session.silenceTimer);

    // Voice call ended — consolidate immediately
    if (session.conversationHistory.length > 0) {
      console.log("[voice] Call ended with messages — triggering consolidation...");
      _deps.triggerConsolidation("voice");
    }
  });

  ws.on("error", (error) => logger.error("WebSocket error", error));
}
