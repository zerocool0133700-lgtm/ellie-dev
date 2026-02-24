/**
 * TTS (ElevenLabs) + Transcription (Whisper/Groq) utilities.
 *
 * Extracted from relay.ts — ELLIE-184.
 * Zero shared state: only depends on env vars and stdlib.
 */

import { spawn } from "bun";
import { writeFile, readFile, unlink } from "fs/promises";
import { join } from "path";
import type { WebSocket } from "ws";

// ── Config (from env) ───────────────────────────────────────

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";
const TMP_DIR = process.env.TMPDIR || "/tmp";

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
      console.error("[voice] ffmpeg error:", await new Response(ffmpeg.stderr).text());
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
    if (!modelPath) { console.error("[voice] WHISPER_MODEL_PATH not set"); return ""; }

    const txtPath = join(TMP_DIR, `call_${timestamp}.txt`);
    const whisper = spawn([
      whisperBinary, "--model", modelPath,
      "--file", wavPath,
      "--output-txt", "--output-file", join(TMP_DIR, `call_${timestamp}`),
      "--no-prints"
    ], { stdout: "pipe", stderr: "pipe" });

    if (await whisper.exited !== 0) {
      console.error("[voice] whisper error:", await new Response(whisper.stderr).text());
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

// ── ElevenLabs TTS ──────────────────────────────────────────

/**
 * Stream TTS audio directly to Twilio WebSocket as chunks arrive from ElevenLabs.
 * Returns true on success, false on failure.
 */
export async function streamTTSToTwilio(
  text: string,
  ws: WebSocket,
  streamSid: string,
): Promise<boolean> {
  if (!ELEVENLABS_API_KEY) { console.error("[voice] No ElevenLabs API key"); return false; }

  const start = Date.now();

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
    console.error("[voice] ElevenLabs stream error:", response.status, await response.text());
    return false;
  }

  const CHUNK_SIZE = 160 * 20; // ~400ms of mulaw audio per Twilio chunk
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
        console.log(`[voice] First TTS chunk sent in ${Date.now() - start}ms`);
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

  console.log(`[voice] TTS stream complete in ${Date.now() - start}ms`);
  return true;
}

/** Non-streaming mulaw TTS (fallback for when streaming not possible). */
export async function textToSpeechMulaw(text: string): Promise<string> {
  if (!ELEVENLABS_API_KEY) { console.error("[voice] No ElevenLabs API key"); return ""; }

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
    console.error("[voice] ElevenLabs error:", response.status, await response.text());
    return "";
  }

  return Buffer.from(await response.arrayBuffer()).toString("base64");
}

/** Convert text to OGG/Opus audio via ElevenLabs (for Telegram voice messages). */
export async function textToSpeechOgg(text: string): Promise<Buffer | null> {
  if (!ELEVENLABS_API_KEY) return null;

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
    console.error("[tts] ElevenLabs error:", response.status, await response.text());
    return null;
  }

  return Buffer.from(await response.arrayBuffer());
}

/** Low-bandwidth TTS for phone conversation mode (mp3_22050_32 — ~4x smaller than opus_48000_64). */
export async function textToSpeechFast(text: string): Promise<Buffer | null> {
  if (!ELEVENLABS_API_KEY) return null;

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
    console.error("[tts] ElevenLabs fast error:", response.status, await response.text());
    return null;
  }

  return Buffer.from(await response.arrayBuffer());
}
