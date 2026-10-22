import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppDownloadManager } from "../src/app/manager.js";
import { BridgeServer } from "../src/bridge/server.js";
import { encodeNativeMessage, NativeMessageDecoder } from "../src/bridge/framing.js";
import { runNativeHost } from "../src/bridge/nativeHost.js";
import {
  chromeHostManifest,
  firefoxHostManifest,
  windowsRegFile,
} from "../src/bridge/manifests.js";
import {
  parseBridgeMessage,
  sanitizeFilename,
} from "../src/bridge/protocol.js";

const PAYLOAD = Buffer.alloc(512 * 1024);
for (let i = 0; i < PAYLOAD.length; i++) PAYLOAD[i] = i % 251;

let fileUrl = "";
let fileServer: ReturnType<typeof createServer>;

beforeAll(async () => {
  fileServer = createServer((req, res) => {
    if (req.method === "HEAD") {
      res.writeHead(200, {
        "Content-Length": String(PAYLOAD.length),
        "Accept-Ranges": "bytes",
        "Content-Type": "application/octet-stream",
      });
      return res.end();
    }
    const range = req.headers["range"];
    const match = range ? /bytes=(\d+)-(\d+)/.exec(range) : null;
    const start = match ? Number(match[1]) : 0;
    const end = match ? Math.min(Number(match[2]), PAYLOAD.length - 1) : PAYLOAD.length - 1;
    res.writeHead(match ? 206 : 200, {
      "Content-Range": `bytes ${start}-${end}/${PAYLOAD.length}`,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
    });
    res.end(PAYLOAD.subarray(start, end + 1));
  });
  await new Promise<void>((resolve) => fileServer.listen(0, "127.0.0.1", resolve));
  fileUrl = `http://127.0.0.1:${(fileServer.address() as AddressInfo).port}/file.bin`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => fileServer.close(() => resolve()));
});

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("bridge protocol", () => {
  it("accepts valid messages and rejects traversal, bad URLs and unknown types", () => {
    expect(parseBridgeMessage({ type: "ping" })).toEqual({ type: "ping" });
    expect(parseBridgeMessage({ type: "add_download", url: fileUrl })).toMatchObject({
      type: "add_download",
    });
    expect(() => parseBridgeMessage({ type: "add_download", url: "ftp://x/y" })).toThrow();
    expect(() => parseBridgeMessage({ type: "add_download", url: fileUrl, filename: "../evil" })).toThrow();
    expect(() => parseBridgeMessage({ type: "explode" })).toThrow();
    expect(sanitizeFilename("a/b")).toBeNull();
    expect(sanitizeFilename("ok.zip")).toBe("ok.zip");
  });

  it("round-trips native framing, including split chunks", () => {
    const encoded = encodeNativeMessage({ type: "ping" });
    const decoder = new NativeMessageDecoder();
    const first = decoder.push(encoded.subarray(0, 3));
    expect(first).toEqual([]);
    const rest = decoder.push(encoded.subarray(3));
    expect(rest).toEqual([{ type: "ping" }]);
  });

  it("generates Chrome, Firefox and Windows registry manifests", () => {
    const chrome = chromeHostManifest({ hostPath: "/tmp/host", extensionId: "abcdefgh123456" });
    expect(chrome["allowed_origins"]).toEqual(["chrome-extension://abcdefgh123456/"]);
    const firefox = firefoxHostManifest({ hostPath: "/tmp/host", extensionId: "ext@x" });
    expect(firefox["allowed_extensions"]).toEqual(["ext@x"]);
    const reg = windowsRegFile("chrome", "C:\\dm\\host.json");
    expect(reg).toContain("Google\\Chrome\\NativeMessagingHosts");
    expect(reg).toContain("C:\\\\dm\\\\host.json");
  });
});

describe("loopback bridge server", () => {
  it("requires a token, rejects hostile origins, and serves downloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dm-bridge-"));
    const manager = new AppDownloadManager({ downloadsDir: dir, maxConcurrent: 2 });
    const server = new BridgeServer(manager, { downloadsDir: dir });
    const info = await server.start();
    const base = `http://127.0.0.1:${info.port}`;
    try {
      // No token -> 401
      const unauth = await fetch(`${base}/api/downloads`);
      expect(unauth.status).toBe(401);
      // Wrong token + hostile origin -> 401/403 family, never data
      const hostile = await fetch(`${base}/api/downloads`, {
        headers: { Authorization: `Bearer ${info.token}`, Origin: "https://evil.example" },
      });
      expect(hostile.status).toBe(401);
      // Health is public but reveals nothing about jobs
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      expect((await health.json() as { running: boolean }).running).toBe(true);
      // Add via bridge
      const added = await fetch(`${base}/api/downloads`, {
        method: "POST",
        headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url: fileUrl, filename: "via-bridge.bin" }),
      });
      expect(added.status).toBe(201);
      const addedJson = (await added.json()) as { job: { id: string } };
      await waitFor(() => manager.get(addedJson.job.id)?.status === "completed");
      expect((await readFile(join(dir, "Programs", "via-bridge.bin"))).equals(PAYLOAD)).toBe(true);
      // Invalid filename via HTTP is rejected, not written
      const bad = await fetch(`${base}/api/downloads`, {
        method: "POST",
        headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url: fileUrl, filename: "../../evil.bin" }),
      });
      expect(bad.status).toBe(400);
    } finally {
      await server.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects loopback-lookalike Host and Origin headers even with a valid token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dm-bridge-"));
    const manager = new AppDownloadManager({ downloadsDir: dir, maxConcurrent: 2 });
    const server = new BridgeServer(manager, { downloadsDir: dir });
    const info = await server.start();
    try {
      const statusWith = (headers: Record<string, string>): Promise<number> =>
        new Promise((resolve, reject) => {
          const req = httpRequest(
            { host: "127.0.0.1", port: info.port, path: "/api/downloads", method: "GET", headers },
            (res) => {
              res.resume();
              res.on("end", () => resolve(res.statusCode ?? 0));
            },
          );
          req.on("error", reject);
          req.end();
        });
      // Host "127.0.0.1.evil.com" used to pass the startsWith check.
      expect(
        await statusWith({ Authorization: `Bearer ${info.token}`, Host: "127.0.0.1.evil.com" }),
      ).toBe(401);
      expect(
        await statusWith({ Authorization: `Bearer ${info.token}`, Origin: "http://127.0.0.1.evil.com" }),
      ).toBe(401);
      // Genuine loopback Host still works.
      expect(await statusWith({ Authorization: `Bearer ${info.token}` })).toBe(200);
    } finally {
      await server.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("native host forwards to the bridge and reports app_not_running when absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dm-bridge-"));
    const manager = new AppDownloadManager({ downloadsDir: dir, maxConcurrent: 2 });
    const server = new BridgeServer(manager, { downloadsDir: dir });
    const info = await server.start();
    try {
      // Host with a live bridge
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const chunks: Buffer[] = [];
      stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      const hostPromise = runNativeHost({
        stdin,
        stdout,
        readInfo: async () => info,
      });
      stdin.write(encodeNativeMessage({ type: "ping" }));
      stdin.write(encodeNativeMessage({ type: "add_download", url: fileUrl, filename: "via-host.bin" }));
      await waitFor(() => {
        const all = Buffer.concat(chunks).toString("utf8");
        return all.includes("pong") && all.includes("via-host");
      });
      // Decode responses
      const decoder = new NativeMessageDecoder();
      const messages = decoder.push(Buffer.concat(chunks));
      expect(messages.some((m) => (m as { type?: string }).type === "pong")).toBe(true);
      stdin.end();
      await hostPromise;
      await waitFor(() => manager.list().some((job) => job.status === "completed"));
    } finally {
      await server.stop();
      await rm(dir, { recursive: true, force: true });
    }

    // Host with no bridge
    const stdin2 = new PassThrough();
    const stdout2 = new PassThrough();
    const chunks2: Buffer[] = [];
    stdout2.on("data", (chunk: Buffer) => chunks2.push(chunk));
    const hostPromise2 = runNativeHost({
      stdin: stdin2,
      stdout: stdout2,
      readInfo: async () => null,
    });
    stdin2.write(encodeNativeMessage({ type: "add_download", url: fileUrl }));
    await waitFor(() => Buffer.concat(chunks2).length > 0);
    const decoder2 = new NativeMessageDecoder();
    const messages2 = decoder2.push(Buffer.concat(chunks2));
    expect((messages2[0] as { code?: string }).code).toBe("app_not_running");
    stdin2.end();
    await hostPromise2;
  }, 30_000);
});
