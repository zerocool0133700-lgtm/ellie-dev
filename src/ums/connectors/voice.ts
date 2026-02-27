/**
 * UMS Connector: Voice (transcribed notes + calls)
 *
 * ELLIE-301: Normalizes transcribed voice into UnifiedMessage format.
 * Called after Whisper/Groq transcription completes.
 */

import type { UMSConnector } from "../connector.ts";
import type { UnifiedMessageInsert } from "../types.ts";

interface VoiceTranscription {
  id: string;
  transcription: string;
  duration_seconds?: number;
  confidence?: number;
  language?: string;
  original_provider: string; // "telegram", "phone", etc.
  original_message_id?: string;
  audio_format?: string;
  timestamp?: string;
  sender?: { id?: string; name?: string; username?: string };
}

export const voiceConnector: UMSConnector = {
  provider: "voice",

  normalize(rawPayload: unknown): UnifiedMessageInsert | null {
    const voice = rawPayload as VoiceTranscription;
    if (!voice.id || !voice.transcription) return null;

    return {
      provider: "voice",
      provider_id: voice.id,
      channel: `voice:${voice.original_provider}`,
      sender: voice.sender ? {
        id: voice.sender.id,
        name: voice.sender.name,
        username: voice.sender.username,
      } : null,
      content: voice.transcription,
      content_type: "voice",
      raw: rawPayload as Record<string, unknown>,
      provider_timestamp: voice.timestamp || null,
      metadata: {
        duration_seconds: voice.duration_seconds,
        transcription_confidence: voice.confidence,
        language: voice.language,
        original_provider: voice.original_provider,
        original_message_id: voice.original_message_id,
        audio_format: voice.audio_format,
      },
    };
  },
};
