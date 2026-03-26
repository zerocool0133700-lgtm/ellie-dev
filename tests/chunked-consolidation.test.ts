import { describe, it, expect } from "bun:test";
import { chunkMessages } from "../src/consolidate-inline.ts";

describe("ELLIE-1033: Chunked consolidation", () => {
  it("splits messages into correct chunks", () => {
    const msgs = Array.from({ length: 35 }, (_, i) => ({ id: i, content: `msg ${i}` }));
    const chunks = chunkMessages(msgs, 15);
    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBe(15);
    expect(chunks[1].length).toBe(15);
    expect(chunks[2].length).toBe(5);
  });

  it("returns single chunk for small blocks", () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({ id: i }));
    const chunks = chunkMessages(msgs, 15);
    expect(chunks.length).toBe(1);
    expect(chunks[0].length).toBe(10);
  });

  it("handles empty array", () => {
    const chunks = chunkMessages([], 15);
    expect(chunks.length).toBe(0);
  });

  it("handles exact chunk size", () => {
    const msgs = Array.from({ length: 15 }, (_, i) => ({ id: i }));
    const chunks = chunkMessages(msgs, 15);
    expect(chunks.length).toBe(1);
    expect(chunks[0].length).toBe(15);
  });

  it("preserves message order across chunks", () => {
    const msgs = Array.from({ length: 20 }, (_, i) => ({ id: i }));
    const chunks = chunkMessages(msgs, 7);
    const flattened = chunks.flat();
    expect(flattened.map(m => m.id)).toEqual(msgs.map(m => m.id));
  });
});
