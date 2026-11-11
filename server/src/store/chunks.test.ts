import { describe, expect, it } from "vitest";
import { CHUNK_CHARS, fromChunks, toChunks } from "./chunks";

describe("table chunks", () => {
  it("round-trips a large payload across multiple bounded chunks", () => {
    // Incompressible-ish data so the base64 output spans several chunks.
    const data = { items: Array.from({ length: 20000 }, (_, i) => ({ id: Math.random().toString(36), i, n: "ü".repeat(3) })) };
    const chunks = toChunks(data);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= CHUNK_CHARS)).toBe(true);
    expect(fromChunks(chunks)).toEqual(data);
  });
});
