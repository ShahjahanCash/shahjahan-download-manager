import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkForUpdates, DEFAULT_UPDATE_FEED_URL } from "../src/app/updater.js";

// 1.0.4 Phase 3: the updater is exercised against a REAL local HTTP
// server serving real feed JSON — not a mocked fetch. This proves the
// available / not-available / bad-feed cases end to end. Since Oct 30,
// 2026 the public feed URL is baked in (see DEFAULT_UPDATE_FEED_URL);
// the live feed itself is verified separately, not in this suite, so
// these tests never depend on network access.
let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const send = (status: number, body: string) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body);
    };
    if (req.url === "/available.json") {
      send(200, JSON.stringify({ version: "1.0.4", url: "https://example.com/Shahjahan-Download-Manager-1.0.4-Setup.exe" }));
    } else if (req.url === "/same.json") {
      send(200, JSON.stringify({ version: "1.0.3", url: "https://example.com/Shahjahan-Download-Manager-1.0.3-Setup.exe" }));
    } else if (req.url === "/bad.json") {
      send(200, "this is not json");
    } else if (req.url === "/missing.json") {
      send(200, JSON.stringify({ version: "1.0.4" }));
    } else if (req.url === "/http-url.json") {
      send(200, JSON.stringify({ version: "1.0.4", url: "http://example.com/setup.exe" }));
    } else {
      send(404, JSON.stringify({ error: "not found" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("updater against a real local feed server (1.0.4 Phase 3)", () => {
  it("bakes in the public GitHub feed URL", () => {
    expect(DEFAULT_UPDATE_FEED_URL).toBe(
      "https://raw.githubusercontent.com/ShahjahanCash/shahjahan-download-manager-updates/main/feed.json",
    );
  });

  it("reports an update when the feed is newer", async () => {
    const result = await checkForUpdates("1.0.3", `${base}/available.json`);
    expect(result.available).toBe(true);
    expect(result.latestVersion).toBe("1.0.4");
    expect(result.url).toBe("https://example.com/Shahjahan-Download-Manager-1.0.4-Setup.exe");
    expect(result.error).toBeNull();
  });

  it("reports no update when the feed version matches", async () => {
    const result = await checkForUpdates("1.0.3", `${base}/same.json`);
    expect(result.available).toBe(false);
    expect(result.url).toBeNull();
    expect(result.error).toBeNull();
  });

  it("fails cleanly on bad JSON, a missing field, an http download URL, and a 404", async () => {
    for (const path of ["/bad.json", "/missing.json", "/http-url.json", "/nope.json"]) {
      const result = await checkForUpdates("1.0.3", `${base}${path}`);
      expect(result.available).toBe(false);
      expect(result.url).toBeNull();
      expect(result.error).not.toBeNull();
    }
  });

  it("returns no update when no feed URL is configured at all", async () => {
    const result = await checkForUpdates("1.0.3", null);
    expect(result.available).toBe(false);
    expect(result.error).toBeNull();
  });
});
