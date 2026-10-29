#!/usr/bin/env node
// Shahjahan Download Manager — standalone Native Messaging host (v1.0.2).
// Zero dependencies: only Node.js built-ins. This file is a faithful,
// minimal re-implementation of the protocol in src/bridge/ (framing.ts,
// protocol.ts, nativeHost.ts, bridgeInfo.ts) so Windows users with only
// the installed/portable app can register the Chrome host without the
// full project source tree.
//
// Modes:
//   node host.cjs                 -> run the native host (stdio, Chrome launches this)
//   node host.cjs install <id>    -> write the host manifest + registry key (Chrome)
//   node host.cjs install <id> --browser edge
//   node host.cjs uninstall       -> remove the registry key
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");

const BRIDGE_HOST_NAME = "com.downloadmanager.bridge";
const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;

// ---------- framing (Chrome native messaging: 4-byte LE length + JSON) ----------
function encodeNativeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_NATIVE_MESSAGE_BYTES) {
    throw new Error("Native message exceeds 1 MiB");
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

class NativeMessageDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > MAX_NATIVE_MESSAGE_BYTES) {
        throw new Error("Native message length exceeds 1 MiB");
      }
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length).toString("utf8");
      messages.push(JSON.parse(body));
      this.buffer = this.buffer.subarray(4 + length);
    }
    return messages;
  }
}

// ---------- protocol validation (mirrors src/bridge/protocol.ts) ----------
class BridgeProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function isHttpUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function sanitizeFilename(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) return null;
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

function parseHeaders(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > 20) return null;
  const out = {};
  for (const [key, entry] of entries) {
    if (typeof entry !== "string" || entry.length > 8192) return null;
    if (["host", "content-length", "connection"].includes(key.toLowerCase())) return null;
    out[key] = entry;
  }
  return out;
}

function parseBridgeMessage(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BridgeProtocolError("invalid_message", "Message must be a JSON object");
  }
  switch (value.type) {
    case "ping":
    case "get_bridge_info":
    case "list":
      return { type: value.type };
    case "add_download": {
      if (!isHttpUrl(value.url)) {
        throw new BridgeProtocolError("invalid_url", "url must be http: or https:");
      }
      const headers = parseHeaders(value.headers);
      if (headers === null) {
        throw new BridgeProtocolError("invalid_headers", "headers must be a flat string map");
      }
      let filename;
      if (value.filename !== undefined) {
        const clean = sanitizeFilename(value.filename);
        if (clean === null) {
          throw new BridgeProtocolError("invalid_filename", "filename must be a bare file name");
        }
        filename = clean;
      }
      return {
        type: "add_download",
        url: value.url,
        ...(filename ? { filename } : {}),
        ...(typeof value.referrer === "string" ? { referrer: value.referrer } : {}),
        ...(headers ? { headers } : {}),
        ...(value.stream === true ? { stream: true } : {}),
      };
    }
    case "pause":
    case "resume":
    case "cancel": {
      if (typeof value.id !== "string" || value.id.length === 0) {
        throw new BridgeProtocolError("invalid_id", "id must be a non-empty string");
      }
      return { type: value.type, id: value.id };
    }
    default:
      throw new BridgeProtocolError("unknown_type", `Unknown message type: ${String(value.type)}`);
  }
}

// ---------- bridge discovery (mirrors src/bridge/bridgeInfo.ts) ----------
function bridgeInfoPath() {
  if (process.env.DM_BRIDGE_INFO_PATH) return process.env.DM_BRIDGE_INFO_PATH;
  return path.join(os.homedir(), ".download-manager", "bridge.json");
}

async function readBridgeInfo() {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(bridgeInfoPath(), "utf8"));
    if (parsed.version !== 1 || typeof parsed.port !== "number" || typeof parsed.token !== "string" || parsed.token.length < 16) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function forwardToBridge(info, reqPath, method, body) {
  const fetchFn = globalThis.fetch;
  if (typeof fetchFn !== "function") throw new Error("This host needs Node.js 18+ (global fetch)");
  const response = await fetchFn(`http://${info.host}:${info.port}${reqPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${info.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

// ---------- host loop ----------
async function runHost() {
  const decoder = new NativeMessageDecoder();
  const respond = (response) => {
    try {
      process.stdout.write(encodeNativeMessage(response));
    } catch {}
  };

  const handle = async (raw) => {
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

    const info = await readBridgeInfo();
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
        const { status, json } = await forwardToBridge(info, "/api/downloads", "GET");
        if (status !== 200) {
          respond({ ok: false, code: "bridge_error", error: `Bridge returned ${status}` });
          return;
        }
        respond({ ok: true, type: "list", ...(json || {}) });
        return;
      }
      if (request.type === "add_download") {
        const { status, json } = await forwardToBridge(info, "/api/downloads", "POST", {
          url: request.url,
          ...(request.filename ? { filename: request.filename } : {}),
          ...(request.headers ? { headers: request.headers } : {}),
          ...(request.stream === true ? { stream: true } : {}),
        });
        if (status !== 201) {
          const body = json || {};
          respond({ ok: false, code: body.code || "bridge_error", error: body.error || `Bridge returned ${status}` });
          return;
        }
        respond({ ok: true, type: "add_download", ...(json || {}) });
        return;
      }
      // pause / resume / cancel
      const { status, json } = await forwardToBridge(
        info,
        `/api/downloads/${encodeURIComponent(request.id)}/${request.type}`,
        "POST",
      );
      if (status !== 200) {
        const body = json || {};
        respond({ ok: false, code: body.code || "bridge_error", error: body.error || `Bridge returned ${status}` });
        return;
      }
      respond({ ok: true, type: request.type, ...(json || {}) });
    } catch (error) {
      respond({ ok: false, code: "bridge_error", error: error && error.message ? error.message : String(error) });
    }
  };

  process.stdin.on("data", (chunk) => {
    let messages;
    try {
      messages = decoder.push(chunk);
    } catch (error) {
      respond({ ok: false, code: "invalid_message", error: error.message });
      return;
    }
    for (const message of messages) void handle(message);
  });
  process.stdin.on("end", () => process.exit(0));
}

// ---------- install / uninstall (Windows registry) ----------
function registryKey(browser) {
  if (browser === "edge") return "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.downloadmanager.bridge";
  if (browser === "firefox") return "HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.downloadmanager.bridge";
  return "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.downloadmanager.bridge";
}

function regAdd(key, value) {
  return new Promise((resolve, reject) => {
    execFile("reg", ["add", key, "/ve", "/d", value, "/f"], (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout);
    });
  });
}

function regDelete(key) {
  return new Promise((resolve, reject) => {
    execFile("reg", ["delete", key, "/f"], (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout);
    });
  });
}

async function install(extensionId, browser) {
  if (!/^[a-p]{32}$/.test(extensionId || "")) {
    console.error("Extension ID ghalat hai. chrome://extensions par card me jo 32-harf wali ID hai, wohi likho (sirf a-p huruf).");
    process.exitCode = 1;
    return;
  }
  const dir = __dirname;
  const hostJs = path.join(dir, "host.cjs");
  const nodeExe = process.execPath;
  const manifest = {
    name: BRIDGE_HOST_NAME,
    description: "Download Manager native messaging host",
    path: `"${nodeExe}" "${hostJs}"`,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
  const manifestPath = path.join(dir, `${BRIDGE_HOST_NAME}.json`);
  await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Manifest likh di: ${manifestPath}`);
  const key = registryKey(browser);
  await regAdd(key, manifestPath);
  console.log(`Registry key register ho gayi: ${key}`);
  console.log("");
  console.log("Ab ye karo:");
  console.log("1. Download Manager desktop app 1.0.2 kholo (bridge usi waqt chalta hai).");
  console.log("2. chrome://extensions par extension ko Reload karo.");
  console.log("3. Jis page par video/download chahiye, us tab ko Reload karo (content script naye load par lagta hai).");
  console.log("4. Extension popup kholo — 'Connected' likha aana chahiye.");
  console.log("");
  console.log("Note: ye folder mat delete karo aur mat move karo — manifest isi path par hai.");
}

async function uninstall(browser) {
  const key = registryKey(browser);
  await regDelete(key);
  console.log(`Registry key hata di: ${key}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "install") {
    const browserArg = args.indexOf("--browser");
    const browser = browserArg >= 0 ? args[browserArg + 1] : "chrome";
    await install(args[1], browser);
    return;
  }
  if (args[0] === "uninstall") {
    const browserArg = args.indexOf("--browser");
    const browser = browserArg >= 0 ? args[browserArg + 1] : "chrome";
    await uninstall(browser);
    return;
  }
  await runHost();
}

main().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exitCode = 1;
});
