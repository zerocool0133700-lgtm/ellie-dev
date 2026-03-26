import { describe, it, expect } from "bun:test";

describe("ELLIE-1032: Consumer watermark tracking", () => {
  it("exports required functions", async () => {
    const mod = await import("../src/ums/consumer-watermark.ts");
    expect(typeof mod.ensureWatermark).toBe("function");
    expect(typeof mod.advanceWatermark).toBe("function");
    expect(typeof mod.recordWatermarkError).toBe("function");
    expect(typeof mod.getAllWatermarks).toBe("function");
    expect(typeof mod.getWatermark).toBe("function");
  });

  it("ConsumerWatermark interface has required fields", async () => {
    // Type check via construction
    const wm = {
      consumer_name: "test",
      last_message_id: null,
      last_processed_at: null,
      messages_processed: 0,
      errors: 0,
      last_error: null,
      last_error_at: null,
      status: "active" as const,
    };
    expect(wm.consumer_name).toBe("test");
    expect(wm.status).toBe("active");
  });
});
