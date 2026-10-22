/**
 * Chrome/Firefox Native Messaging framing: a 4-byte little-endian length
 * prefix followed by that many bytes of UTF-8 JSON. No other framing is
 * accepted, and messages over 1 MiB are rejected (browser downloads
 * metadata is small; a larger message is a protocol error, not a file).
 */

export const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;

export function encodeNativeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_NATIVE_MESSAGE_BYTES) {
    throw new Error("Native message exceeds 1 MiB");
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Incremental decoder for a stdin-style byte stream. */
export class NativeMessageDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > MAX_NATIVE_MESSAGE_BYTES) {
        throw new Error("Native message length exceeds 1 MiB");
      }
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length).toString("utf8");
      messages.push(JSON.parse(body) as unknown);
      this.buffer = this.buffer.subarray(4 + length);
    }
    return messages;
  }
}
