import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { join } from "node:path";
import type { AppDownloadManager } from "../app/manager.js";
import { categorize } from "../engine/categories.js";
import { generateToken, type BridgeInfo } from "./bridgeInfo.js";
import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeProtocolError,
  parseBridgeMessage,
  type BridgeRequest,
} from "./protocol.js";

export interface BridgeServerOptions {
  /** 0 = ephemeral (recommended: discovered via bridge.json). */
  port?: number;
  host?: string;
  token?: string;
  /** Must match the manager's downloads dir for forced filenames. */
  downloadsDir?: string;
}

type EventSubscriber = (data: string) => void;

function isStreamUrl(raw: string): boolean {
  try {
    const pathname = new URL(raw).pathname;
    return pathname.endsWith(".m3u8") || pathname.endsWith(".mpd");
  } catch {
    return raw.includes(".m3u8") || raw.includes(".mpd");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    // No CORS allow-origin: browser pages must not be able to read
    // bridge responses. The extension talks via Native Messaging.
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function readBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Loopback HTTP bridge. Bound to 127.0.0.1 only, bearer-token protected,
 * and hostile-Origin rejected. It is the app-side half of Phase 4;
 * the browser side is the Native Messaging host, which forwards to here.
 */
export class BridgeServer {
  private readonly manager: AppDownloadManager;
  private readonly host: string;
  private readonly token: string;
  private readonly requestedPort: number;
  private downloadsDir: string;
  private server: Server | null = null;
  private subscribers = new Set<EventSubscriber>();
  private actualPort = 0;

  constructor(manager: AppDownloadManager, options: BridgeServerOptions = {}) {
    this.manager = manager;
    this.host = options.host ?? "127.0.0.1";
    this.token = options.token ?? generateToken();
    this.requestedPort = options.port ?? 0;
    this.downloadsDir = options.downloadsDir ?? "downloads";
  }

  setDownloadsDir(dir: string): void {
    const value = dir.trim();
    if (value) this.downloadsDir = value;
  }

  get info(): BridgeInfo {
    return { version: 1, port: this.actualPort, token: this.token, host: this.host };
  }

  async start(): Promise<BridgeInfo> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        if (!res.headersSent) {
          sendJson(res, 500, {
            ok: false,
            code: "internal",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.requestedPort, this.host, () => resolve());
      this.server!.once("error", reject);
    });
    const address = this.server.address();
    if (typeof address === "object" && address !== null) {
      this.actualPort = address.port;
    }
    return this.info;
  }

  async stop(): Promise<void> {
    for (const subscriber of [...this.subscribers]) subscriber("close");
    this.subscribers.clear();
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  /** Push progress/jobs to SSE clients. */
  broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const subscriber of [...this.subscribers]) subscriber(payload);
  }

  private isAuthorized(req: IncomingMessage): boolean {
    const auth = req.headers["authorization"];
    if (auth !== `Bearer ${this.token}`) return false;
    // B4 fix: the old checks used startsWith, so "127.0.0.1.evil.com"
    // and "http://127.0.0.1.evil.com" passed as loopback. Match the
    // hostname exactly (the bearer token is still the real gate).
    const hostHeader = req.headers["host"] ?? "";
    const hostname = hostHeader.startsWith("[")
      ? hostHeader.slice(1, hostHeader.indexOf("]"))
      : (hostHeader.split(":")[0] ?? "");
    if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") {
      return false;
    }
    // Reject cross-origin browser requests outright; loopback fetch
    // from Node tooling sends no Origin and is allowed with the token.
    const origin = req.headers["origin"];
    if (origin) {
      if (origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://")) {
        return true;
      }
      let originHost = "";
      try {
        originHost = new URL(origin).hostname;
      } catch {
        return false;
      }
      if (originHost !== "127.0.0.1" && originHost !== "localhost" && originHost !== "::1") {
        return false;
      }
    }
    return true;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers["host"] ?? "127.0.0.1"}`);
    const path = url.pathname;

    if (req.method === "GET" && path === "/health") {
      sendJson(res, 200, { ok: true, running: true, protocol: BRIDGE_PROTOCOL_VERSION });
      return;
    }

    if (!this.isAuthorized(req)) {
      sendJson(res, 401, {
        ok: false,
        code: "unauthorized",
        error: "Missing or invalid bearer token, Host, or Origin",
      });
      return;
    }

    if (req.method === "GET" && path === "/api/downloads") {
      sendJson(res, 200, { ok: true, jobs: this.manager.list() });
      return;
    }

    if (req.method === "GET" && path === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const send = (data: string) => {
        if (data === "close") {
          res.end();
          return;
        }
        res.write(data);
      };
      this.subscribers.add(send);
      req.on("close", () => this.subscribers.delete(send));
      res.write(`: connected\n\n`);
      res.write(`event: jobs\ndata: ${JSON.stringify(this.manager.list())}\n\n`);
      return;
    }

    if (req.method === "POST" && path === "/api/downloads") {
      const body = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body) as unknown;
      } catch {
        sendJson(res, 400, { ok: false, code: "invalid_json", error: "Body must be JSON" });
        return;
      }
      let request: BridgeRequest;
      try {
        request = parseBridgeMessage({
          type: "add_download",
          ...(parsed as Record<string, unknown>),
        });
      } catch (error) {
        if (error instanceof BridgeProtocolError) {
          sendJson(res, 400, { ok: false, code: error.code, error: error.message });
          return;
        }
        throw error;
      }
      if (request.type !== "add_download") {
        sendJson(res, 400, { ok: false, code: "invalid", error: "Expected add_download" });
        return;
      }
      // B5 fix: includes() misrouted URLs that merely mention
      // .m3u8/.mpd in a query string (e.g. ?format=mpd) to the stream
      // assembler. Only the URL path's extension counts.
      const isStream =
        request.stream === true || isStreamUrl(request.url);
      const job = isStream
        ? await this.manager.addStream(request.url, {
            ...(request.filename
              ? {
                  destination: join(
                    this.downloadsDir,
                    "Video",
                    request.filename.replace(/\.(m3u8|mpd)$/i, ".mp4"),
                  ),
                }
              : {}),
            ...(request.headers ? { headers: request.headers } : {}),
          })
        : await this.manager.add(request.url, {
            ...(request.filename
              ? {
                  destination: join(
                    this.downloadsDir,
                    categorize(request.filename, null),
                    request.filename,
                  ),
                }
              : {}),
            ...(request.headers ? { headers: request.headers } : {}),
          });
      sendJson(res, 201, { ok: true, job });
      this.broadcast("jobs", this.manager.list());
      return;
    }

    const actionMatch = /^\/api\/downloads\/([^/]+)\/(pause|resume|cancel)$/.exec(path);
    if (req.method === "POST" && actionMatch) {
      const id = decodeURIComponent(actionMatch[1]!);
      const action = actionMatch[2]!;
      let result: unknown;
      if (action === "pause") result = await this.manager.pause(id);
      else if (action === "resume") result = await this.manager.resume(id);
      else result = await this.manager.cancel(id);
      if (result === undefined || result === false) {
        sendJson(res, 404, { ok: false, code: "not_found", error: `No job: ${id}` });
        return;
      }
      sendJson(res, 200, { ok: true, job: result === true ? null : result });
      this.broadcast("jobs", this.manager.list());
      return;
    }

    sendJson(res, 404, { ok: false, code: "not_found", error: `Unknown route: ${path}` });
  }
}
