/**
 * Voice Transcription Module — ELLIE-229
 *
 * Fallback chain: Groq (cloud) → local whisper.cpp → graceful error.
 * Provider order:
 *   - VOICE_PROVIDER=groq  → try Groq first, fall back to local
 *   - VOICE_PROVIDER=local → try local first, fall back to Groq
 *   - (unset)              → try Groq if GROQ_API_KEY present, else local
 *
 * Both providers must be independently available (key / binary+model).
 * Silent failures are replaced with a user-visible error string.
 */

import { spawn } from "bun";
import { writeFile, readFile, unlink } from "fs/promises";
import { join } from "path";
import { log } from "./logger.ts";

const logger = log.child("transcribe");

const VOICE_PROVIDER    = process.env.VOICE_PROVIDER    || "";
const GROQ_API_KEY      = process.env.GROQ_API_KEY      || "";
const WHISPER_BINARY    = process.env.WHISPER_BINARY    || "whisper-cpp";
const WHISPER_MODEL_PATH = process.env.WHISPER_MODEL_PATH || "";
const TMP_DIR           = process.env.TMPDIR            || "/tmp";

// ── Provider availability ─────────────────────────────────────────────────

export function getTranscriptionProviderInfo() {
  return {
    preferred:        VOICE_PROVIDER || "auto",
    groq_available:   !!GROQ_API_KEY,
    local_available:  !!WHISPER_MODEL_PATH,
  };
}

/**
 * Log provider availability at startup (non-blocking).
 */
export async function probeVoiceProviders(): Promise<void> {
  const { groq_available, local_available } = getTranscriptionProviderInfo();

  if (!groq_available && !local_available) {
    logger.warn("[transcribe] No voice provider configured — transcription disabled");
    return;
  }

  if (groq_available) {
    logger.info("[transcribe] Groq available (GROQ_API_KEY set)");
  } else {
    logger.info("[transcribe] Groq not configured (no GROQ_API_KEY)");
  }

  if (local_available) {
    // Quick binary check (non-blocking)
    try {
      const proc = spawn([WHISPER_BINARY, "--help"], { stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      logger.info("[transcribe] Local whisper.cpp available", { binary: WHISPER_BINARY, model: WHISPER_MODEL_PATH });
    } catch {
      logger.warn("[transcribe] Local whisper.cpp binary not found", { binary: WHISPER_BINARY });
    }
  } else {
    logger.info("[transcribe] Local whisper.cpp not configured (no WHISPER_MODEL_PATH)");
  }

  const fallbackReady = groq_available && local_available;
  logger.info(`[transcribe] Fallback chain ${fallbackReady ? "READY (Groq → local)" : "single-provider only"}`);
}

// ── Internal providers ────────────────────────────────────────────────────

/**
 * Groq transcription — accepts OGG (Telegram) or WAV (phone call).
 * Groq API auto-detects format from filename.
 */
async function transcribeGroq(
  audioBuffer: Buffer,
  filename = "voice.ogg",
  mimeType = "audio/ogg",
): Promise<string> {
  const Groq = (await import("groq-sdk")).default;
  const groq = new Groq(); // reads GROQ_API_KEY from env
  const file = new File([audioBuffer], filename, { type: mimeType });
  const result = await groq.audio.transcriptions.create({
    file,
    model: "whisper-large-v3-turbo",
  });
  return result.text.trim();
}

/**
 * Local whisper.cpp transcription — accepts OGG buffer.
 * Converts OGG → WAV 16kHz via ffmpeg before running whisper.
 */
async function transcribeLocalFromOgg(audioBuffer: Buffer): Promise<string> {
  if (!WHISPER_MODEL_PATH) throw new Error("WHISPER_MODEL_PATH not set");

  const ts = Date.now();
  const oggPath = join(TMP_DIR, `voice_${ts}.ogg`);
  const wavPath = join(TMP_DIR, `voice_${ts}.wav`);
  const txtPath = join(TMP_DIR, `voice_${ts}.txt`);

  try {
    await writeFile(oggPath, audioBuffer);

    const ffmpeg = spawn(
      ["ffmpeg", "-i", oggPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath, "-y"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const ffmpegExit = await ffmpeg.exited;
    if (ffmpegExit !== 0) {
      const stderr = await new Response(ffmpeg.stderr).text();
      throw new Error(`ffmpeg failed (code ${ffmpegExit}): ${stderr.slice(0, 200)}`);
    }

    const whisper = spawn(
      [WHISPER_BINARY, "--model", WHISPER_MODEL_PATH, "--file", wavPath,
       "--output-txt", "--output-file", join(TMP_DIR, `voice_${ts}`), "--no-prints"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const whisperExit = await whisper.exited;
    if (whisperExit !== 0) {
      const stderr = await new Response(whisper.stderr).text();
      throw new Error(`whisper-cpp failed (code ${whisperExit}): ${stderr.slice(0, 200)}`);
    }

    return (await readFile(txtPath, "utf-8")).trim();
  } finally {
    await unlink(oggPath).catch(() => {});
    await unlink(wavPath).catch(() => {});
    await unlink(txtPath).catch(() => {});
  }
}

/**
 * Local whisper.cpp transcription — accepts a pre-converted WAV buffer.
 * Used by the mulaw phone call path where ffmpeg conversion is done upstream.
 */
export async function transcribeLocalFromWav(wavBuffer: Buffer): Promise<string> {
  if (!WHISPER_MODEL_PATH) throw new Error("WHISPER_MODEL_PATH not set");

  const ts = Date.now();
  const wavPath = join(TMP_DIR, `voice_${ts}.wav`);
  const txtPath = join(TMP_DIR, `voice_${ts}.txt`);

  try {
    await writeFile(wavPath, wavBuffer);

    const whisper = spawn(
      [WHISPER_BINARY, "--model", WHISPER_MODEL_PATH, "--file", wavPath,
       "--output-txt", "--output-file", join(TMP_DIR, `voice_${ts}`), "--no-prints"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const whisperExit = await whisper.exited;
    if (whisperExit !== 0) {
      const stderr = await new Response(whisper.stderr).text();
      throw new Error(`whisper-cpp failed (code ${whisperExit}): ${stderr.slice(0, 200)}`);
    }

    return (await readFile(txtPath, "utf-8")).trim();
  } finally {
    await unlink(wavPath).catch(() => {});
    await unlink(txtPath).catch(() => {});
  }
}

// ── Ordered fallback chains ───────────────────────────────────────────────

type OggFn = () => Promise<string>;

async function tryChain(ordered: Array<{ name: string; fn: OggFn }>): Promise<string | null> {
  for (const { name, fn } of ordered) {
    try {
      const result = await fn();
      logger.info(`[transcribe] Success via ${name}`);
      return result;
    } catch (err: unknown) {
      logger.warn(`[transcribe] ${name} failed — trying next`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return null;
}

function buildOggChain(audioBuffer: Buffer): Array<{ name: string; fn: OggFn }> {
  const groq  = { name: "groq",  fn: () => transcribeGroq(audioBuffer) };
  const local = { name: "local", fn: () => transcribeLocalFromOgg(audioBuffer) };

  if (VOICE_PROVIDER === "local") return [local, groq].filter(p =>
    p.name === "local" ? !!WHISPER_MODEL_PATH : !!GROQ_API_KEY
  );
  // Default: Groq first (faster, better quality), local fallback
  return [groq, local].filter(p =>
    p.name === "groq" ? !!GROQ_API_KEY : !!WHISPER_MODEL_PATH
  );
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Transcribe an audio buffer (OGG/opus from Telegram) to text.
 * Tries Groq first, falls back to local whisper.cpp.
 * Returns a user-visible error string if both fail.
 */
export async function transcribe(audioBuffer: Buffer): Promise<string> {
  const chain = buildOggChain(audioBuffer);

  if (!chain.length) {
    logger.error("[transcribe] No voice provider configured");
    return "";
  }

  const result = await tryChain(chain);
  if (result !== null) return result;

  logger.error("[transcribe] All providers failed");
  return "Sorry, I couldn't transcribe that — please try again.";
}

/**
 * Transcribe a WAV buffer (from phone call mulaw→WAV conversion).
 * Tries Groq first (passes WAV), falls back to local whisper.cpp.
 * Returns empty string on total failure (silent phone call path).
 */
export async function transcribeWav(wavBuffer: Buffer): Promise<string> {
  type WavFn = () => Promise<string>;
  const groqFn:  { name: string; fn: WavFn } = {
    name: "groq",
    fn: () => transcribeGroq(wavBuffer, "call.wav", "audio/wav"),
  };
  const localFn: { name: string; fn: WavFn } = {
    name: "local",
    fn: () => transcribeLocalFromWav(wavBuffer),
  };

  const chain: Array<{ name: string; fn: WavFn }> = VOICE_PROVIDER === "local"
    ? [localFn, groqFn].filter(p => p.name === "local" ? !!WHISPER_MODEL_PATH : !!GROQ_API_KEY)
    : [groqFn, localFn].filter(p => p.name === "groq"  ? !!GROQ_API_KEY       : !!WHISPER_MODEL_PATH);

  if (!chain.length) {
    logger.error("[transcribe] No voice provider configured (WAV path)");
    return "";
  }

  for (const { name, fn } of chain) {
    try {
      const result = await fn();
      logger.info(`[transcribe] WAV success via ${name}`);
      return result;
    } catch (err: unknown) {
      logger.warn(`[transcribe] WAV ${name} failed — trying next`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.error("[transcribe] All WAV providers failed");
  return "";
}
