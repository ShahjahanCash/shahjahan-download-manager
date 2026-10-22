/**
 * Bridge protocol v1 — shared by the Native Messaging host, the loopback
 * HTTP bridge, and (in Phase 5) the browser extension.
 *
 * Rules, enforced by parseBridgeMessage():
 * - url must be http: or https:
 * - filename must be a bare name (no /, \, or .. traversal)
 * - headers, when present, are a flat string map, capped in size
 * - unknown message types are rejected, never ignored
 * Auth headers/cookies are accepted only over the local bridge and are
 * never logged and never persisted (see manager: headers are in-memory).
 */

export const BRIDGE_PROTOCOL_VERSION = 1;
export const BRIDGE_HOST_NAME = "com.downloadmanager.bridge";

export type BridgeRequest =
  | { type: "ping" }
  | { type: "get_bridge_info" }
  | { type: "list" }
  | {
      type: "add_download";
      url: string;
      filename?: string;
      referrer?: string;
      headers?: Record<string, string>;
      /** True when the URL is an HLS/DASH manifest to assemble (Phase 6). */
      stream?: boolean;
    }
  | { type: "pause"; id: string }
  | { type: "resume"; id: string }
  | { type: "cancel"; id: string };

export type BridgeResponse =
  | { ok: true; type: string; [key: string]: unknown }
  | { ok: false; code: string; error: string };

export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function sanitizeFilename(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) {
    return null;
  }
  if (
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value === "." ||
    value === ".." ||
    value.includes("..")
  ) {
    return null;
  }
  return value;
}

function parseHeaders(value: unknown): Record<string, string> | null {
  if (value === undefined) return undefined as unknown as Record<string, string>;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 20) return null;
  const out: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (typeof entry !== "string" || entry.length > 8192) return null;
    // Never forward hop-by-hop headers the bridge itself must control.
    if (["host", "content-length", "connection"].includes(key.toLowerCase())) {
      return null;
    }
    out[key] = entry;
  }
  return out;
}

export class BridgeProtocolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function parseBridgeMessage(value: unknown): BridgeRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BridgeProtocolError("invalid_message", "Message must be a JSON object");
  }
  const message = value as Record<string, unknown>;
  switch (message["type"]) {
    case "ping":
    case "get_bridge_info":
    case "list":
      return { type: message["type"] };
    case "add_download": {
      if (!isHttpUrl(message["url"])) {
        throw new BridgeProtocolError("invalid_url", "url must be http: or https:");
      }
      const headers = parseHeaders(message["headers"]);
      if (headers === null) {
        throw new BridgeProtocolError("invalid_headers", "headers must be a flat string map");
      }
      let filename: string | undefined;
      if (message["filename"] !== undefined) {
        const clean = sanitizeFilename(message["filename"]);
        if (clean === null) {
          throw new BridgeProtocolError("invalid_filename", "filename must be a bare file name");
        }
        filename = clean;
      }
      return {
        type: "add_download",
        url: message["url"],
        ...(filename ? { filename } : {}),
        ...(typeof message["referrer"] === "string" ? { referrer: message["referrer"] } : {}),
        ...(headers ? { headers } : {}),
        ...(message["stream"] === true ? { stream: true as const } : {}),
      };
    }
    case "pause":
    case "resume":
    case "cancel": {
      if (typeof message["id"] !== "string" || message["id"].length === 0) {
        throw new BridgeProtocolError("invalid_id", "id must be a non-empty string");
      }
      return { type: message["type"], id: message["id"] };
    }
    default:
      throw new BridgeProtocolError(
        "unknown_type",
        `Unknown message type: ${String(message["type"])}`,
      );
  }
}
