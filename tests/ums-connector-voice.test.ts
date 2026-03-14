/**
 * UMS Connector Tests: Voice — ELLIE-708
 */

import { describe, test, expect } from "bun:test";
import { voiceConnector } from "../src/ums/connectors/voice.ts";
import { voiceFixtures as fx } from "./fixtures/ums-connector-payloads.ts";

describe("voiceConnector", () => {
  test("provider is 'voice'", () => {
    expect(voiceConnector.provider).toBe("voice");
  });

  test("normalizes a full voice transcription", () => {
    const result = voiceConnector.normalize(fx.basicTranscription);
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("voice");
    expect(result!.provider_id).toBe("voice-001");
    expect(result!.channel).toBe("voice:telegram");
    expect(result!.content).toBe("Remember to call the dentist tomorrow");
    expect(result!.content_type).toBe("voice");
    expect(result!.sender).toEqual({ id: "99", name: "Dave", username: "davey" });
    expect(result!.provider_timestamp).toBe("2026-03-14T10:30:00Z");
    expect(result!.metadata).toMatchObject({
      duration_seconds: 5.2,
      transcription_confidence: 0.95,
      language: "en",
      original_provider: "telegram",
      original_message_id: "tg-msg-102",
      audio_format: "ogg",
    });
  });

  test("normalizes minimal transcription", () => {
    const result = voiceConnector.normalize(fx.minimalTranscription);
    expect(result).not.toBeNull();
    expect(result!.channel).toBe("voice:phone");
    expect(result!.content).toBe("Hello");
    expect(result!.provider_timestamp).toBeNull();
  });

  test("normalizes transcription without sender", () => {
    const result = voiceConnector.normalize(fx.noSender);
    expect(result).not.toBeNull();
    expect(result!.sender).toBeNull();
  });

  test("returns null when id is missing", () => {
    expect(voiceConnector.normalize(fx.noId)).toBeNull();
  });

  test("returns null when transcription is missing", () => {
    expect(voiceConnector.normalize(fx.noTranscription)).toBeNull();
  });

  test("returns null for empty payload", () => {
    expect(voiceConnector.normalize(fx.empty)).toBeNull();
  });
});
