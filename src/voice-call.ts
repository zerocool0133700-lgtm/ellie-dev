/**
 * Voice Call Module
 *
 * Bidirectional voice calls via Twilio + Whisper + Claude + ElevenLabs TTS.
 *
 * Flow:
 *   Phone call → Twilio Media Stream (mulaw 8kHz)
 *     → accumulate audio chunks → silence detection → ffmpeg mulaw→WAV
 *     → Whisper transcription → Claude response → ElevenLabs TTS (ulaw_8000)
 *     → stream back to caller via WebSocket
 */

import { WebSocketServer, WebSocket } from "ws";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { spawn } from "bun";
import { writeFile, readFile, unlink, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { ElevenLabsClient } from "elevenlabs";
import Twilio from "twilio";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

// ============================================================
// CONFIG
// ============================================================

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || "";
const DAVE_PHONE_NUMBER = process.env.DAVE_PHONE_NUMBER || "";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";

const VOICE_CALL_PORT = parseInt(process.env.VOICE_CALL_PORT || "8765");
const PUBLIC_URL = process.env.PUBLIC_URL || ""; // ngrok/cloudflare URL

const TMP_DIR = process.env.TMPDIR || "/tmp";

// Silence detection: how long to wait after last audio before processing
const SILENCE_THRESHOLD_MS = 1500;
// Minimum audio duration to bother transcribing (ms)
const MIN_AUDIO_MS = 500;

// ============================================================
// CLIENTS
// ============================================================

const twilioClient = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
  ? Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;

const elevenlabs = ELEVENLABS_API_KEY
  ? new ElevenLabsClient({ apiKey: ELEVENLABS_API_KEY })
  : null;

// ============================================================
// CLAUDE INTEGRATION
// ============================================================

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || "";
const AGENT_MODE = process.env.AGENT_MODE !== "false";
const DEFAULT_TOOLS = "Read,Edit,Write,Bash,Glob,Grep,WebSearch,WebFetch";
const MCP_TOOLS = "mcp__google-workspace__*,mcp__github__*,mcp__memory__*,mcp__sequential-thinking__*";
const ALLOWED_TOOLS = (process.env.ALLOWED_TOOLS || `${DEFAULT_TOOLS},${MCP_TOOLS}`).split(",").map(t => t.trim());

async function callClaude(prompt: string): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt, "--output-format", "text"];
  if (AGENT_MODE) {
    args.push("--allowedTools", ...ALLOWED_TOOLS);
  }

  console.log(`[voice] Claude: ${prompt.substring(0, 80)}...`);

  const proc = spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    cwd: PROJECT_DIR || undefined,
    env: { ...process.env, CLAUDECODE: "" },
  });

  const timeout = setTimeout(() => proc.kill(), 120_000);
  const output = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  clearTimeout(timeout);

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error("[voice] Claude error:", stderr);
    return "Sorry, I had trouble processing that. Could you repeat?";
  }

  return output.trim();
}

// ============================================================
// WHISPER TRANSCRIPTION (mulaw buffer → text)
// ============================================================

async function transcribeMulaw(mulawChunks: Buffer[]): Promise<string> {
  const combined = Buffer.concat(mulawChunks);
  if (combined.length < 400) return ""; // too short, skip (~50ms of audio)

  const timestamp = Date.now();
  const mulawPath = join(TMP_DIR, `call_${timestamp}.raw`);
  const wavPath = join(TMP_DIR, `call_${timestamp}.wav`);

  try {
    await writeFile(mulawPath, combined);

    // Convert mulaw 8kHz → WAV 16kHz PCM (what Whisper needs)
    const ffmpeg = spawn([
      "ffmpeg", "-f", "mulaw", "-ar", "8000", "-ac", "1",
      "-i", mulawPath,
      "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
      wavPath, "-y"
    ], { stdout: "pipe", stderr: "pipe" });

    const ffmpegExit = await ffmpeg.exited;
    if (ffmpegExit !== 0) {
      const stderr = await new Response(ffmpeg.stderr).text();
      console.error("[voice] ffmpeg error:", stderr);
      return "";
    }

    // Use the existing transcription approach
    const provider = process.env.VOICE_PROVIDER || "local";

    if (provider === "groq") {
      const wavBuffer = await readFile(wavPath);
      const Groq = (await import("groq-sdk")).default;
      const groq = new Groq();
      const file = new File([wavBuffer], "call.wav", { type: "audio/wav" });
      const result = await groq.audio.transcriptions.create({
        file,
        model: "whisper-large-v3-turbo",
      });
      return result.text.trim();
    }

    // Local whisper.cpp
    const whisperBinary = process.env.WHISPER_BINARY || "whisper-cpp";
    const modelPath = process.env.WHISPER_MODEL_PATH || "";
    if (!modelPath) {
      console.error("[voice] WHISPER_MODEL_PATH not set");
      return "";
    }

    const txtPath = join(TMP_DIR, `call_${timestamp}.txt`);
    const whisper = spawn([
      whisperBinary, "--model", modelPath,
      "--file", wavPath,
      "--output-txt", "--output-file", join(TMP_DIR, `call_${timestamp}`),
      "--no-prints"
    ], { stdout: "pipe", stderr: "pipe" });

    const whisperExit = await whisper.exited;
    if (whisperExit !== 0) {
      const stderr = await new Response(whisper.stderr).text();
      console.error("[voice] whisper error:", stderr);
      return "";
    }

    const text = await readFile(txtPath, "utf-8");
    await unlink(txtPath).catch(() => {});
    return text.trim();
  } finally {
    await unlink(mulawPath).catch(() => {});
    await unlink(wavPath).catch(() => {});
  }
}

// ============================================================
// ELEVENLABS TTS (text → mulaw base64 for Twilio)
// ============================================================

async function textToSpeechMulaw(text: string): Promise<string> {
  if (!ELEVENLABS_API_KEY) {
    console.error("[voice] No ElevenLabs API key");
    return "";
  }

  // Use the REST API directly for output_format control
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2_5",
        output_format: "ulaw_8000",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    console.error("[voice] ElevenLabs error:", response.status, err);
    return "";
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  return audioBuffer.toString("base64");
}

// ============================================================
// CALL SESSION — one per active call
// ============================================================

interface CallSession {
  ws: WebSocket;
  streamSid: string | null;
  callSid: string | null;
  audioChunks: Buffer[];
  silenceTimer: ReturnType<typeof setTimeout> | null;
  lastAudioTime: number;
  processing: boolean;
  conversationHistory: Array<{ role: string; content: string }>;
}

function createSession(ws: WebSocket): CallSession {
  return {
    ws,
    streamSid: null,
    callSid: null,
    audioChunks: [],
    silenceTimer: null,
    lastAudioTime: 0,
    processing: false,
    conversationHistory: [],
  };
}

async function processAudio(session: CallSession): Promise<void> {
  if (session.processing || session.audioChunks.length === 0) return;
  session.processing = true;

  const chunks = session.audioChunks.splice(0);

  try {
    // 1. Transcribe
    console.log(`[voice] Transcribing ${chunks.length} chunks...`);
    const text = await transcribeMulaw(chunks);

    if (!text || text.length < 2) {
      console.log("[voice] Empty transcription, skipping");
      session.processing = false;
      return;
    }

    console.log(`[voice] User said: "${text}"`);
    session.conversationHistory.push({ role: "user", content: text });

    // 2. Get Claude response
    const conversationContext = session.conversationHistory
      .slice(-6) // last 6 turns (reduced for latency)
      .map(m => `${m.role}: ${m.content}`)
      .join("\n");

    // Format current time with timezone
    const now = new Date();
    const USER_TIMEZONE = process.env.USER_TIMEZONE || "America/Chicago";
    const USER_NAME = process.env.USER_NAME || "Dave";
    const timeStr = now.toLocaleString("en-US", {
      timeZone: USER_TIMEZONE,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    const prompt = [
      "You are Ellie, Dave's AI assistant. You are on a VOICE CALL.",
      "Keep responses SHORT and natural for speech — 1-3 sentences max.",
      "No markdown, no bullet points, no formatting. Just spoken words.",
      "Be warm and conversational, like talking to a friend.",
      "",
      `Speaking with: ${USER_NAME}`,
      `Current time: ${timeStr}`,
      "",
      "Conversation so far:",
      conversationContext,
      "",
      `${USER_NAME} just said: ${text}`,
    ].join("\n");

    const response = await callClaude(prompt);
    // Strip any memory tags from voice response
    const cleanResponse = response
      .replace(/\[REMEMBER:.*?\]/g, "")
      .replace(/\[GOAL:.*?\]/g, "")
      .replace(/\[DONE:.*?\]/g, "")
      .trim();

    console.log(`[voice] Ellie says: "${cleanResponse}"`);
    session.conversationHistory.push({ role: "assistant", content: cleanResponse });

    // 3. TTS → mulaw
    const audioBase64 = await textToSpeechMulaw(cleanResponse);

    if (!audioBase64 || !session.streamSid) {
      console.error("[voice] No audio or no stream SID");
      session.processing = false;
      return;
    }

    // 4. Send audio back to caller
    // Clear any buffered audio first (in case caller interrupted)
    session.ws.send(JSON.stringify({
      event: "clear",
      streamSid: session.streamSid,
    }));

    // Send audio in chunks (Twilio recommends ~20ms chunks = 160 bytes of mulaw)
    const CHUNK_SIZE = 160 * 20; // ~400ms chunks for smoother streaming
    const audioBuffer = Buffer.from(audioBase64, "base64");

    for (let i = 0; i < audioBuffer.length; i += CHUNK_SIZE) {
      const chunk = audioBuffer.subarray(i, i + CHUNK_SIZE);
      session.ws.send(JSON.stringify({
        event: "media",
        streamSid: session.streamSid,
        media: {
          payload: chunk.toString("base64"),
        },
      }));
    }

    // Send mark to know when playback finishes
    session.ws.send(JSON.stringify({
      event: "mark",
      streamSid: session.streamSid,
      mark: { name: `response_${Date.now()}` },
    }));

  } catch (error) {
    console.error("[voice] Processing error:", error);
  }

  session.processing = false;
}

// ============================================================
// HTTP SERVER + WEBSOCKET
// ============================================================

const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // Twilio webhook for incoming/outgoing calls — returns TwiML
  if (url.pathname === "/voice" && req.method === "POST") {
    const wsUrl = PUBLIC_URL
      ? PUBLIC_URL.replace(/^https?/, "wss") + "/media-stream"
      : `wss://${req.headers.host}/media-stream`;

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting you to Ellie.</Say>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end(twiml);
    console.log("[voice] TwiML served, connecting media stream...");
    return;
  }

  // Health check
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "voice-call" }));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

const wss = new WebSocketServer({ server: httpServer, path: "/media-stream" });

wss.on("connection", (ws: WebSocket) => {
  console.log("[voice] Media stream connected");
  const session = createSession(ws);

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
          // Decode base64 mulaw audio
          const payload = Buffer.from(msg.media.payload, "base64");
          session.audioChunks.push(payload);
          session.lastAudioTime = Date.now();

          // Reset silence timer
          if (session.silenceTimer) clearTimeout(session.silenceTimer);

          if (!session.processing) {
            session.silenceTimer = setTimeout(() => {
              // Check if enough audio accumulated
              const totalBytes = session.audioChunks.reduce((sum, c) => sum + c.length, 0);
              const estimatedMs = (totalBytes / 8000) * 1000; // 8000 bytes/sec for mulaw

              if (estimatedMs >= MIN_AUDIO_MS) {
                processAudio(session);
              } else {
                // Too short, discard
                session.audioChunks = [];
              }
            }, SILENCE_THRESHOLD_MS);
          }
          break;
        }

        case "mark":
          console.log(`[voice] Playback mark: ${msg.mark?.name}`);
          break;

        case "stop":
          console.log("[voice] Stream stopped");
          if (session.silenceTimer) clearTimeout(session.silenceTimer);
          break;

        default:
          console.log(`[voice] Unknown event: ${msg.event}`);
      }
    } catch (error) {
      console.error("[voice] Message parse error:", error);
    }
  });

  ws.on("close", () => {
    console.log("[voice] WebSocket closed");
    if (session.silenceTimer) clearTimeout(session.silenceTimer);
  });

  ws.on("error", (error) => {
    console.error("[voice] WebSocket error:", error);
  });
});

// ============================================================
// OUTBOUND CALL
// ============================================================

export async function initiateCall(toNumber?: string): Promise<string> {
  if (!twilioClient) return "Twilio not configured. Check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.";
  if (!PUBLIC_URL) return "PUBLIC_URL not set. Start ngrok or Cloudflare tunnel first.";

  const to = toNumber || DAVE_PHONE_NUMBER;
  if (!to) return "No phone number to call.";

  try {
    const call = await twilioClient.calls.create({
      to,
      from: TWILIO_PHONE_NUMBER,
      url: `${PUBLIC_URL}/voice`,
    });

    console.log(`[voice] Outbound call initiated: ${call.sid}`);
    return `Calling ${to}... (SID: ${call.sid})`;
  } catch (error: any) {
    console.error("[voice] Call error:", error);
    return `Failed to call: ${error.message}`;
  }
}

// ============================================================
// START SERVER
// ============================================================

export function startVoiceServer(): void {
  httpServer.listen(VOICE_CALL_PORT, () => {
    console.log(`[voice] Server listening on port ${VOICE_CALL_PORT}`);
    console.log(`[voice] WebSocket: ws://localhost:${VOICE_CALL_PORT}/media-stream`);
    console.log(`[voice] TwiML webhook: http://localhost:${VOICE_CALL_PORT}/voice`);
    if (PUBLIC_URL) {
      console.log(`[voice] Public URL: ${PUBLIC_URL}`);
    } else {
      console.log(`[voice] ⚠ PUBLIC_URL not set — run ngrok or cloudflare tunnel`);
    }
  });
}

export { httpServer, wss };
