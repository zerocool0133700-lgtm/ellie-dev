/**
 * TTS (ElevenLabs / OpenAI) + Transcription (Whisper/Groq) utilities.
 *
 * Extracted from relay.ts — ELLIE-184.
 * Provider selection via TTS_PROVIDER env var ("elevenlabs" | "openai").
 * Falls back to the other provider if the primary fails or is unconfigured.
 */

import { spawn } from "bun";
import { writeFile, readFile, unlink } from "fs/promises";
import { join } from "path";
import type { WebSocket } from "ws";
import { log } from "./logger.ts";

const logger = log.child("tts");

// ── Config (from env) ───────────────────────────────────────

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || "nova";
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || "tts-1";
const TTS_PROVIDER = (process.env.TTS_PROVIDER || "elevenlabs") as "elevenlabs" | "openai";
const TMP_DIR = process.env.TMPDIR || "/tmp";

/** Returns which provider to use, falling back if primary is unconfigured. */
function getProvider(): "elevenlabs" | "openai" | null {
  if (TTS_PROVIDER === "openai" && OPENAI_API_KEY) return "openai";
  if (TTS_PROVIDER === "elevenlabs" && ELEVENLABS_API_KEY) return "elevenlabs";
  // Fallback: try the other one
  if (OPENAI_API_KEY) return "openai";
  if (ELEVENLABS_API_KEY) return "elevenlabs";
  return null;
}

// ── OpenAI TTS helper ───────────────────────────────────────

type OpenAIFormat = "opus" | "mp3" | "aac" | "flac" | "wav" | "pcm";

async function openaiTTS(text: string, format: OpenAIFormat): Promise<Buffer | null> {
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_TTS_MODEL,
      input: text,
      voice: OPENAI_TTS_VOICE,
      response_format: format,
    }),
  });

  if (!response.ok) {
    logger.error("OpenAI TTS error", { status: response.status, body: await response.text() });
    return null;
  }

  return Buffer.from(await response.arrayBuffer());
}

/** Convert PCM s16le to mulaw 8kHz via ffmpeg (for Twilio). */
async function pcmToMulaw(pcmBuf: Buffer): Promise<Buffer> {
  const ts = Date.now();
  const pcmPath = join(TMP_DIR, `tts_pcm_${ts}.raw`);
  const mulawPath = join(TMP_DIR, `tts_mulaw_${ts}.raw`);

  try {
    await writeFile(pcmPath, pcmBuf);
    const ffmpeg = spawn([
      "ffmpeg", "-f", "s16le", "-ar", "24000", "-ac", "1",
      "-i", pcmPath,
      "-f", "mulaw", "-ar", "8000", "-ac", "1",
      mulawPath, "-y",
    ], { stdout: "pipe", stderr: "pipe" });

    if (await ffmpeg.exited !== 0) {
      logger.error("pcmToMulaw ffmpeg error", { detail: await new Response(ffmpeg.stderr).text() });
      return Buffer.alloc(0);
    }

    return await readFile(mulawPath);
  } finally {
    await unlink(pcmPath).catch(() => {});
    await unlink(mulawPath).catch(() => {});
  }
}

// ── Mulaw energy detection ──────────────────────────────────

/**
 * Compute average energy of a mulaw audio buffer.
 * Mulaw encodes silence as 0xFF (positive zero) or 0x7F (negative zero).
 * We decode each sample to linear and take the average absolute value.
 */
export function mulawEnergy(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i];
    const dist = Math.min(Math.abs(byte - 0xFF), Math.abs(byte - 0x7F));
    sum += dist;
  }
  return sum / buf.length;
}

// ── Whisper transcription (mulaw → text) ────────────────────

export async function transcribeMulaw(mulawChunks: Buffer[]): Promise<string> {
  const combined = Buffer.concat(mulawChunks);
  if (combined.length < 400) return "";

  const timestamp = Date.now();
  const mulawPath = join(TMP_DIR, `call_${timestamp}.raw`);
  const wavPath = join(TMP_DIR, `call_${timestamp}.wav`);

  try {
    await writeFile(mulawPath, combined);

    const ffmpeg = spawn([
      "ffmpeg", "-f", "mulaw", "-ar", "8000", "-ac", "1",
      "-i", mulawPath,
      "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
      wavPath, "-y"
    ], { stdout: "pipe", stderr: "pipe" });

    if (await ffmpeg.exited !== 0) {
      logger.error("ffmpeg error", { detail: await new Response(ffmpeg.stderr).text() });
      return "";
    }

    const provider = process.env.VOICE_PROVIDER || "local";

    if (provider === "groq") {
      const wavBuffer = await readFile(wavPath);
      const Groq = (await import("groq-sdk")).default;
      const groq = new Groq();
      const file = new File([wavBuffer], "call.wav", { type: "audio/wav" });
      const result = await groq.audio.transcriptions.create({ file, model: "whisper-large-v3-turbo" });
      return result.text.trim();
    }

    const whisperBinary = process.env.WHISPER_BINARY || "whisper-cpp";
    const modelPath = process.env.WHISPER_MODEL_PATH || "";
    if (!modelPath) { logger.error("WHISPER_MODEL_PATH not set"); return ""; }

    const txtPath = join(TMP_DIR, `call_${timestamp}.txt`);
    const whisper = spawn([
      whisperBinary, "--model", modelPath,
      "--file", wavPath,
      "--output-txt", "--output-file", join(TMP_DIR, `call_${timestamp}`),
      "--no-prints"
    ], { stdout: "pipe", stderr: "pipe" });

    if (await whisper.exited !== 0) {
      logger.error("whisper error", { detail: await new Response(whisper.stderr).text() });
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

// ── TTS: Twilio streaming ───────────────────────────────────

/**
 * Stream TTS audio directly to Twilio WebSocket.
 * ElevenLabs: true streaming (chunks as they arrive).
 * OpenAI: fetch full audio, convert PCM→mulaw, then chunk to WS.
 */
export async function streamTTSToTwilio(
  text: string,
  ws: WebSocket,
  streamSid: string,
): Promise<boolean> {
  const provider = getProvider();
  if (!provider) { logger.error("No TTS provider configured"); return false; }

  const start = Date.now();
  const CHUNK_SIZE = 160 * 20; // ~400ms of mulaw audio per Twilio chunk

  if (provider === "openai") {
    // OpenAI: fetch PCM, convert to mulaw, chunk to WS
    const pcmBuf = await openaiTTS(text, "pcm");
    if (!pcmBuf) return false;

    const mulawBuf = await pcmToMulaw(pcmBuf);
    if (mulawBuf.length === 0) return false;

    let offset = 0;
    let firstChunkSent = false;
    while (offset < mulawBuf.length) {
      const end = Math.min(offset + CHUNK_SIZE, mulawBuf.length);
      const chunk = mulawBuf.subarray(offset, end);
      offset = end;

      ws.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: chunk.toString("base64") },
      }));

      if (!firstChunkSent) {
        console.log(`[voice] First TTS chunk sent in ${Date.now() - start}ms (openai)`);
        firstChunkSent = true;
      }
    }

    console.log(`[voice] TTS complete in ${Date.now() - start}ms (openai)`);
    return true;
  }

  // ElevenLabs: true streaming
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?output_format=ulaw_8000`,
    {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2_5",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    }
  );

  if (!response.ok || !response.body) {
    logger.error("ElevenLabs stream error", { status: response.status, body: await response.text() });
    return false;
  }

  let buffer = Buffer.alloc(0);
  let firstChunkSent = false;

  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer = Buffer.concat([buffer, Buffer.from(value)]);

    while (buffer.length >= CHUNK_SIZE) {
      const chunk = buffer.subarray(0, CHUNK_SIZE);
      buffer = buffer.subarray(CHUNK_SIZE);

      ws.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: chunk.toString("base64") },
      }));

      if (!firstChunkSent) {
        console.log(`[voice] First TTS chunk sent in ${Date.now() - start}ms (elevenlabs)`);
        firstChunkSent = true;
      }
    }
  }

  if (buffer.length > 0) {
    ws.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: buffer.toString("base64") },
    }));
  }

  console.log(`[voice] TTS stream complete in ${Date.now() - start}ms (elevenlabs)`);
  return true;
}

// ── TTS: Mulaw (non-streaming, for Twilio fallback) ─────────

/** Non-streaming mulaw TTS (fallback for when streaming not possible). */
export async function textToSpeechMulaw(text: string): Promise<string> {
  const provider = getProvider();
  if (!provider) { logger.error("No TTS provider configured"); return ""; }

  if (provider === "openai") {
    const pcmBuf = await openaiTTS(text, "pcm");
    if (!pcmBuf) return "";
    const mulawBuf = await pcmToMulaw(pcmBuf);
    return mulawBuf.toString("base64");
  }

  // ElevenLabs
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=ulaw_8000`,
    {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2_5",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    }
  );

  if (!response.ok) {
    logger.error("ElevenLabs error", { status: response.status, body: await response.text() });
    return "";
  }

  return Buffer.from(await response.arrayBuffer()).toString("base64");
}

// ── TTS: OGG/Opus (for Telegram voice messages) ─────────────

/** Convert text to OGG/Opus audio (for Telegram voice messages). */
export async function textToSpeechOgg(text: string): Promise<Buffer | null> {
  const provider = getProvider();
  if (!provider) return null;

  if (provider === "openai") {
    return await openaiTTS(text, "opus");
  }

  // ElevenLabs
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=opus_48000_64`,
    {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2_5",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    }
  );

  if (!response.ok) {
    logger.error("ElevenLabs error", { status: response.status, body: await response.text() });
    return null;
  }

  return Buffer.from(await response.arrayBuffer());
}

// ── TTS: MP3 (for dashboard / ellie-chat playback) ──────────

/** Low-bandwidth TTS for dashboard playback (MP3). */
export async function textToSpeechFast(text: string): Promise<Buffer | null> {
  const provider = getProvider();
  if (!provider) return null;

  if (provider === "openai") {
    return await openaiTTS(text, "mp3");
  }

  // ElevenLabs
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=mp3_22050_32`,
    {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2_5",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    }
  );

  if (!response.ok) {
    logger.error("ElevenLabs fast error", { status: response.status, body: await response.text() });
    return null;
  }

  return Buffer.from(await response.arrayBuffer());
}
