import { gunzipSync, gzipSync } from "node:zlib";

// Table Storage string properties hold at most 32K UTF-16 chars, so a snapshot is gzipped,
// base64-encoded and spread over many rows.
export const CHUNK_CHARS = 30_000;

export function toChunks(value: unknown): string[] {
  const b64 = gzipSync(JSON.stringify(value)).toString("base64");
  const chunks: string[] = [];
  for (let i = 0; i < b64.length; i += CHUNK_CHARS) chunks.push(b64.slice(i, i + CHUNK_CHARS));
  return chunks;
}

export function fromChunks<T>(chunks: string[]): T {
  return JSON.parse(gunzipSync(Buffer.from(chunks.join(""), "base64")).toString("utf8")) as T;
}
