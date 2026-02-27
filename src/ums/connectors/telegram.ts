/**
 * UMS Connector: Telegram
 *
 * ELLIE-296: Normalizes Telegram bot messages into UnifiedMessage format.
 * Handles text, voice (post-transcription), photos, and documents.
 */

import type { UMSConnector } from "../connector.ts";
import type { UnifiedMessageInsert } from "../types.ts";

interface TelegramUpdate {
  message?: {
    message_id: number;
    date: number;
    text?: string;
    caption?: string;
    chat: { id: number; type: string };
    from?: { id: number; first_name?: string; username?: string; language_code?: string };
    voice?: { duration: number; file_id: string; mime_type?: string };
    photo?: { file_id: string; width: number; height: number }[];
    document?: { file_id: string; file_name?: string; mime_type?: string };
    reply_to_message?: { message_id: number; text?: string };
  };
  callback_query?: { data: string; from: { id: number } };
}

export const telegramConnector: UMSConnector = {
  provider: "telegram",

  normalize(rawPayload: unknown): UnifiedMessageInsert | null {
    const update = rawPayload as TelegramUpdate;
    const msg = update.message;
    if (!msg) return null; // skip callback queries, edits, etc.

    const hasVoice = !!msg.voice;
    const hasPhoto = !!msg.photo?.length;
    const hasDocument = !!msg.document;

    let contentType: string = "text";
    if (hasVoice) contentType = "voice";
    else if (hasPhoto) contentType = "image";

    const content = msg.text || msg.caption || null;

    return {
      provider: "telegram",
      provider_id: `${msg.chat.id}:${msg.message_id}`,
      channel: `telegram:${msg.chat.id}`,
      sender: {
        id: String(msg.from?.id),
        name: msg.from?.first_name,
        username: msg.from?.username,
      },
      content,
      content_type: contentType,
      raw: rawPayload as Record<string, unknown>,
      provider_timestamp: new Date(msg.date * 1000).toISOString(),
      metadata: {
        chat_type: msg.chat.type,
        message_id: msg.message_id,
        has_voice: hasVoice,
        has_photo: hasPhoto,
        has_document: hasDocument,
        voice_duration: msg.voice?.duration,
        document_name: msg.document?.file_name,
        reply_to_message_id: msg.reply_to_message?.message_id,
      },
    };
  },
};
