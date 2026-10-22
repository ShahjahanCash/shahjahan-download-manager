import type { Readable, Writable } from "node:stream";
import { readBridgeInfo } from "./bridgeInfo.js";
import { encodeNativeMessage, NativeMessageDecoder } from "./framing.js";
import {
  BridgeProtocolError,
  parseBridgeMessage,
  type BridgeResponse,
} from "./protocol.js";

export interface NativeHostOptions {
  stdin?: Readable;
  stdout?: Writable;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Injectable for tests; defaults to readBridgeInfo(). */
  readInfo?: () => Promise<
    { port: number; token: string; host: string } | null
  >;
}

async function forwardToBridge(
  info: { port: number; token: string; host: string },
  fetchFn: typeof fetch,
  path: string,
  method: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const response = await fetchFn(`http://${info.host}:${info.port}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${info.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

/**
 * Chrome/Firefox Native Messaging host (stdio, length-prefixed JSON).
 * It does NOT download anything itself: it forwards validated messages
 * to the loopback bridge of the running desktop app. If the app is not
 * running, it answers app_not_running so the extension can prompt the
 * user to open the app — it never silently starts a second manager.
 */
export async function runNativeHost(options: NativeHostOptions = {}): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const fetchFn = options.fetchFn ?? fetch;
  const readInfo = options.readInfo ?? readBridgeInfo;
  const decoder = new NativeMessageDecoder();

  const respond = (response: BridgeResponse): void => {
    stdout.write(encodeNativeMessage(response));
  };

  const handle = async (raw: unknown): Promise<void> => {
    let request;
    try {
      request = parseBridgeMessage(raw);
    } catch (error) {
      if (error instanceof BridgeProtocolError) {
        respond({ ok: false, code: error.code, error: error.message });
        return;
      }
      respond({ ok: false, code: "invalid_message", error: "Message could not be parsed" });
      return;
    }

    if (request.type === "ping") {
      respond({ ok: true, type: "pong" });
      return;
    }

    const info = await readInfo();
    if (request.type === "get_bridge_info") {
      if (!info) {
        respond({ ok: false, code: "app_not_running", error: "Desktop app bridge is not running" });
        return;
      }
      respond({ ok: true, type: "bridge_info", port: info.port, host: info.host });
      return;
    }

    if (!info) {
      respond({ ok: false, code: "app_not_running", error: "Desktop app bridge is not running" });
      return;
    }

    try {
      if (request.type === "list") {
        const { status, json } = await forwardToBridge(info, fetchFn, "/api/downloads", "GET");
        if (status !== 200) {
          respond({ ok: false, code: "bridge_error", error: `Bridge returned ${status}` });
          return;
        }
        respond({ ok: true, type: "list", ...(json as Record<string, unknown>) });
        return;
      }
      if (request.type === "add_download") {
        const { status, json } = await forwardToBridge(info, fetchFn, "/api/downloads", "POST", {
          url: request.url,
          ...(request.filename ? { filename: request.filename } : {}),
          ...(request.headers ? { headers: request.headers } : {}),
          ...(request.stream === true ? { stream: true } : {}),
        });
        if (status !== 201) {
          const body = json as { error?: string; code?: string } | null;
          respond({
            ok: false,
            code: body?.code ?? "bridge_error",
            error: body?.error ?? `Bridge returned ${status}`,
          });
          return;
        }
        respond({ ok: true, type: "add_download", ...(json as Record<string, unknown>) });
        return;
      }
      // pause / resume / cancel
      const { status, json } = await forwardToBridge(
        info,
        fetchFn,
        `/api/downloads/${encodeURIComponent(request.id)}/${request.type}`,
        "POST",
      );
      if (status !== 200) {
        const body = json as { error?: string; code?: string } | null;
        respond({
          ok: false,
          code: body?.code ?? "bridge_error",
          error: body?.error ?? `Bridge returned ${status}`,
        });
        return;
      }
      respond({ ok: true, type: request.type, ...(json as Record<string, unknown>) });
    } catch (error) {
      respond({
        ok: false,
        code: "bridge_unreachable",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // Process messages sequentially: stdin order is the extension's order,
  // and add/pause for the same job must not race.
  let queue: Promise<void> = Promise.resolve();
  for await (const chunk of stdin) {
    let messages: unknown[];
    try {
      messages = decoder.push(chunk as Buffer);
    } catch {
      respond({ ok: false, code: "invalid_framing", error: "Native message framing is invalid" });
      continue;
    }
    for (const message of messages) {
      queue = queue.then(() => handle(message));
    }
  }
  await queue;
}
