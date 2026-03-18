/**
 * Call Signaling Tests — ELLIE-877, ELLIE-878, ELLIE-879
 */

import { describe, it, expect } from "bun:test";
import { startCall, acceptCall, endCall, getActiveCall } from "../src/api/calls.ts";

describe("Call Session Management", () => {
  it("starts a voice call", () => {
    const call = startCall("test-call-1", "channel-1", "dave", "voice");
    expect(call.id).toBe("test-call-1");
    expect(call.type).toBe("voice");
    expect(call.state).toBe("ringing");
    expect(call.caller_id).toBe("dave");
    expect(call.participants).toEqual(["dave"]);
  });

  it("starts a video call", () => {
    const call = startCall("test-call-2", "channel-1", "dave", "video");
    expect(call.type).toBe("video");
    expect(call.state).toBe("ringing");
  });

  it("accepts a call", () => {
    startCall("test-call-3", "channel-2", "dave", "voice");
    const call = acceptCall("test-call-3", "ellie");
    expect(call).not.toBeNull();
    expect(call!.state).toBe("active");
    expect(call!.participants).toContain("ellie");
    expect(call!.participants).toContain("dave");
  });

  it("ends a call", () => {
    startCall("test-call-4", "channel-3", "dave", "voice");
    acceptCall("test-call-4", "ellie");
    const call = endCall("test-call-4");
    expect(call).not.toBeNull();
    expect(call!.state).toBe("ended");
    expect(call!.ended_at).toBeDefined();
    expect(call!.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("gets active call for channel", () => {
    startCall("test-call-5", "channel-5", "dave", "voice");
    const active = getActiveCall("channel-5");
    expect(active).toBeDefined();
    expect(active!.id).toBe("test-call-5");
  });

  it("returns undefined for channel with no active call", () => {
    expect(getActiveCall("nonexistent-channel")).toBeUndefined();
  });

  it("returns null when accepting nonexistent call", () => {
    expect(acceptCall("nonexistent", "dave")).toBeNull();
  });

  it("returns null when ending nonexistent call", () => {
    expect(endCall("nonexistent")).toBeNull();
  });

  it("adds multiple participants", () => {
    startCall("test-call-6", "channel-6", "dave", "voice");
    acceptCall("test-call-6", "james");
    const call = acceptCall("test-call-6", "kate");
    expect(call!.participants).toEqual(["dave", "james", "kate"]);
  });

  it("does not duplicate participants", () => {
    startCall("test-call-7", "channel-7", "dave", "voice");
    acceptCall("test-call-7", "dave");
    const call = acceptCall("test-call-7", "dave");
    expect(call!.participants).toEqual(["dave"]);
  });

  it("screen share call type", () => {
    const call = startCall("test-call-8", "channel-8", "dave", "screen");
    expect(call.type).toBe("screen");
  });
});
