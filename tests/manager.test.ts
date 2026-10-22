import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppDownloadManager, quoteCommandLine } from "../src/app/manager.js";

const PAYLOAD = Buffer.alloc(1024 * 1024);
for (let i = 0; i < PAYLOAD.length; i++) PAYLOAD[i] = i % 251;

let baseUrl = "";
let server: ReturnType<typeof createServer>;

beforeAll(async () => {
  server = createServer((req, res) => {
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
    // Drip-feed so pause/resume and queue tests can observe mid-flight state.
    let offset = start;
    const timer = setInterval(() => {
      if (offset > end || res.destroyed) {
        clearInterval(timer);
        if (!res.destroyed) res.end();
        return;
      }
      const next = Math.min(offset + 64 * 1024, end + 1);
      res.write(PAYLOAD.subarray(offset, next));
      offset = next;
    }, 50);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function waitFor(
  check: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("AppDownloadManager", () => {
  it("runs one job at a time when maxConcurrent is 1, then the next", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dm-manager-"));
    const manager = new AppDownloadManager({ downloadsDir: dir, maxConcurrent: 1, segments: 4 });
    const first = await manager.add(`${baseUrl}/a.bin`);
    const second = await manager.add(`${baseUrl}/b.bin`);
    await waitFor(() => manager.get(first.id)?.status === "completed");
    await waitFor(() => manager.get(second.id)?.status === "completed");
    expect((await readFile(join(dir, "Programs", "a.bin"))).equals(PAYLOAD)).toBe(true);
    expect((await readFile(join(dir, "Programs", "b.bin"))).equals(PAYLOAD)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("pausing immediately after add does not get overwritten by startup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dm-manager-"));
    const manager = new AppDownloadManager({ downloadsDir: dir, maxConcurrent: 1, segments: 4 });
    const job = await manager.add(`${baseUrl}/slow.bin`);
    // Pause in the startup window (probe in flight): without the
    // pump guard, the download would silently continue to completed.
    const paused = await manager.pause(job.id);
    expect(paused?.status).toBe("paused");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(manager.get(job.id)?.status).toBe("paused");
    await manager.resume(job.id);
    await waitFor(() => manager.get(job.id)?.status === "completed");
    await rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("settings setters change folder and concurrency (Settings panel)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dm-manager-"));
    const manager = new AppDownloadManager({ downloadsDir: dir, maxConcurrent: 1, segments: 4 });
    expect(manager.getSettings()).toEqual({
      downloadsDir: dir,
      maxConcurrent: 1,
      categoryFolders: {},
      proxyUrl: null,
      retryAttempts: 3,
      retryDelayBaseSec: 10,
      schedulerPolicy: { enabled: false, windows: [] },
      smartConfig: { enabled: false, smartLimitBytesPerSec: 0, watchlist: [] },
      autoExtract: false,
      defenderScan: false,
      seedingPolicy: { enabled: false, ratioLimit: 0, maxMinutes: 0 },
    });
    manager.setMaxConcurrent(5);
    manager.setDownloadsDir(join(dir, "Custom"));
    expect(manager.getSettings()).toEqual({
      downloadsDir: join(dir, "Custom"),
      maxConcurrent: 5,
      categoryFolders: {},
      proxyUrl: null,
      retryAttempts: 3,
      retryDelayBaseSec: 10,
      schedulerPolicy: { enabled: false, windows: [] },
      smartConfig: { enabled: false, smartLimitBytesPerSec: 0, watchlist: [] },
      autoExtract: false,
      defenderScan: false,
      seedingPolicy: { enabled: false, ratioLimit: 0, maxMinutes: 0 },
    });
    manager.setMaxConcurrent(0);
    expect(manager.getSettings().maxConcurrent).toBe(1);
    manager.setDownloadsDir("   ");
    expect(manager.getSettings().downloadsDir).toBe(join(dir, "Custom"));
    await rm(dir, { recursive: true, force: true });
  });

  it("honours per-download segments and speed limit from the New Task form", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dm-manager-"));
    const manager = new AppDownloadManager({ downloadsDir: dir, maxConcurrent: 1, segments: 8 });
    const job = await manager.add(`${baseUrl}/slow.bin`, {
      segments: 2,
      speedLimitBytesPerSec: 5000,
    });
    await waitFor(() => (manager.get(job.id)?.progress?.segments.length ?? 0) === 2);
    const stored = manager.get(job.id)!;
    expect(stored.segments).toBe(2);
    expect(stored.speedLimitBytesPerSec).toBe(5000);
    await manager.pause(job.id);
    await manager.cancel(job.id);
    await rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("pauses and resumes a job through the manager", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dm-manager-"));
    const manager = new AppDownloadManager({ downloadsDir: dir, maxConcurrent: 1, segments: 4 });
    const job = await manager.add(`${baseUrl}/slow.bin`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const paused = await manager.pause(job.id);
    expect(paused?.status).toBe("paused");
    await manager.resume(job.id);
    await waitFor(() => manager.get(job.id)?.status === "completed");
    expect((await readFile(join(dir, "Programs", "slow.bin"))).equals(PAYLOAD)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  }, 30_000);
});

describe("quoteCommandLine (0.7.2)", () => {
  it("quotes args with spaces and leaves plain args bare", () => {
    expect(quoteCommandLine("yt-dlp", ["--newline", "-o", "C:\\My Videos\\out.mp4", "https://example.com/v"])).toBe(
      'yt-dlp --newline -o "C:\\My Videos\\out.mp4" https://example.com/v',
    );
    expect(quoteCommandLine("yt-dlp", [])).toBe("yt-dlp");
  });
});

describe("pumpYoutube tool guard (0.7.2)", () => {
  it("fails fast with a clear message when yt-dlp is missing, without spawning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dm-manager-"));
    const manager = new AppDownloadManager({
      downloadsDir: dir,
      maxConcurrent: 1,
      youtubeTools: async () => ({ ytDlp: null, ffmpeg: null }),
    });
    const job = await manager.addYoutube("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
      options: { kind: "video" },
    });
    await waitFor(() => manager.get(job.id)?.status === "failed");
    expect(manager.get(job.id)?.error ?? "").toContain("yt-dlp is not installed");
    await rm(dir, { recursive: true, force: true });
  }, 30_000);
});
