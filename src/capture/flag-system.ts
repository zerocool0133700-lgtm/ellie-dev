/**
 * Capture Tag/Flag System — ELLIE-773
 * Allows users to flag messages for later River capture via multiple methods:
 * - /capture command
 * - Telegram reaction (📌)
 * - Button click (UI handled separately)
 * Pure functions with injected SQL for testability.
 */

import type { Channel, CaptureType } from "../capture-queue.ts";

// Types

export interface FlagInput {
  channel: Channel;
  raw_content: string;
  source_message_id?: string;
  capture_type: CaptureType;
  user_note?: string;
}

export interface FlagResult {
  success: boolean;
  capture_id?: string;
  message: string;
  error?: string;
}

// /capture command parser

export interface CaptureCommand {
  valid: boolean;
  quoted_text?: string;
  note?: string;
  error?: string;
}

export function parseCaptureCommand(text: string): CaptureCommand {
  const trimmed = text.trim();

  // /capture with no args — flag previous message
  if (trimmed === "/capture" || trimmed === "/capture ") {
    return { valid: true };
  }

  // /capture "quoted text" [optional note]
  const quoteMatch = trimmed.match(/^\/capture\s+"([^"]+)"(?:\s+(.+))?$/s);
  if (quoteMatch) {
    return { valid: true, quoted_text: quoteMatch[1], note: quoteMatch[2]?.trim() };
  }

  // /capture <note about previous message>
  const noteMatch = trimmed.match(/^\/capture\s+(.+)$/s);
  if (noteMatch) {
    return { valid: true, note: noteMatch[1].trim() };
  }

  return { valid: false, error: "Usage: /capture [\"quoted text\"] [note]" };
}

// Telegram reaction detection

const CAPTURE_EMOJIS = ["📌", "🏷", "💾", "🔖"];

export function isCaptureReaction(emoji: string): boolean {
  return CAPTURE_EMOJIS.includes(emoji);
}

export function getCaptureEmojis(): string[] {
  return [...CAPTURE_EMOJIS];
}

// Flag a message for capture

export async function flagForCapture(sql: any, input: FlagInput): Promise<FlagResult> {
  try {
    if (!input.raw_content || input.raw_content.trim() === "") {
      return { success: false, message: "Nothing to capture", error: "Empty content" };
    }

    if (!input.channel) {
      return { success: false, message: "Channel required", error: "Missing channel" };
    }

    const rows = await sql`
      INSERT INTO capture_queue (
        channel, raw_content, capture_type, source_message_id, status, confidence
      ) VALUES (
        ${input.channel},
        ${input.user_note ? `${input.raw_content}\n\n---\nNote: ${input.user_note}` : input.raw_content},
        ${input.capture_type},
        ${input.source_message_id ?? null},
        'queued',
        ${input.capture_type === "tag" ? 0.9 : 0.7}
      )
      RETURNING id
    `;

    return {
      success: true,
      capture_id: rows[0]?.id,
      message: "Flagged for River review",
    };
  } catch (err: any) {
    return {
      success: false,
      message: "Failed to flag message",
      error: err.message ?? "Unknown error",
    };
  }
}

// Check if a message is already flagged (dedup)

export async function isAlreadyFlagged(sql: any, sourceMessageId: string): Promise<boolean> {
  if (!sourceMessageId) return false;
  const rows = await sql`
    SELECT 1 FROM capture_queue
    WHERE source_message_id = ${sourceMessageId}
    AND status != 'dismissed'
    LIMIT 1
  `;
  return rows.length > 0;
}

// Build confirmation response per channel

export function buildConfirmation(channel: Channel, captureId: string): string {
  switch (channel) {
    case "telegram":
      return "📌 Flagged for River";
    case "google-chat":
      return "📌 Flagged for River review";
    case "ellie-chat":
      return "Flagged for River review";
    case "voice":
      return "Got it, flagged for later";
    default:
      return "Flagged for River review";
  }
}

// Handle /capture command end-to-end

export async function handleCaptureCommand(
  sql: any,
  commandText: string,
  previousMessage: string | null,
  channel: Channel,
  sourceMessageId?: string,
): Promise<FlagResult> {
  const parsed = parseCaptureCommand(commandText);

  if (!parsed.valid) {
    return { success: false, message: parsed.error ?? "Invalid command" };
  }

  const content = parsed.quoted_text ?? previousMessage;
  if (!content) {
    return { success: false, message: "No message to capture. Use /capture \"text\" or reply to a message." };
  }

  return flagForCapture(sql, {
    channel,
    raw_content: content,
    source_message_id: sourceMessageId,
    capture_type: "tag",
    user_note: parsed.note,
  });
}

// Handle Telegram reaction

export async function handleReactionCapture(
  sql: any,
  emoji: string,
  messageText: string,
  messageId: string,
): Promise<FlagResult | null> {
  if (!isCaptureReaction(emoji)) return null;

  const alreadyFlagged = await isAlreadyFlagged(sql, messageId);
  if (alreadyFlagged) {
    return { success: true, message: "Already flagged" };
  }

  return flagForCapture(sql, {
    channel: "telegram",
    raw_content: messageText,
    source_message_id: messageId,
    capture_type: "tag",
  });
}
