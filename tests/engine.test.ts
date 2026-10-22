import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { categorize } from "../src/engine/categories.js";
import { resumeDownload, startDownload } from "../src/engine/downloader.js";
import { planSegments } from "../src/engine/segments.js";
import { DownloadQueue } from "../src/engine/queue.js";
import type { QueueItem } from "../src/engine/queue.js";

const PAYLOAD = Buffer.alloc(2 * 1024 * 1024);
for (let i = 0; i < PAYLOAD.length; i++) PAYLOAD[i] = i % 251;
const PAYLOAD_HASH = createHash("sha256").update(PAYLOAD).digest("hex");

let baseUrl = "";
let flakyFirstRequest = true;
let server: ReturnType<typeof createServer>;

function rangeHandler(data: Buffer, supportRange: boolean) {
  return (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    const url = req.url ?? "/";
    if (url === "/redirect") {
      res.writeHead(302, { Location: "/file" });
      res.end();
      return;
    }
    if (req.method === "HEAD") {
      res.writeHead(200, {
        "Content-Length": String(data.length),
        ...(supportRange ? { "Accept-Ranges": "bytes" } : {}),
        "Content-Type": "application/octet-stream",
      });
      res.end();
      return;
    }
    if (url === "/flaky" && flakyFirstRequest) {
      flakyFirstRequest = false;
      // Send part, then destroy mid-stream to simulate a broken connection.
      res.writeHead(200, { "Content-Length": String(data.length) });
      res.write(data.subarray(0, 100_000));
      res.destroy();
      return;
    }
    const range = req.headers["range"];
    if (supportRange && range) {
      const match = /bytes=(\d+)-(\d+)/.exec(range);
      if (match) {
        const start = Number(match[1]);
        const end = Math.min(Number(match[2]), data.length - 1);
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${data.length}`,
          "Content-Length": String(end - start + 1),
          "Accept-Ranges": "bytes",
        });
        res.end(data.subarray(start, end + 1));
        return;
      }
    }
    res.writeHead(200, { "Content-Length": String(data.length) });
    res.end(data);
  };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/slow") {
      if (req.method === "HEAD") {
        res.writeHead(200, {
          "Content-Length": String(PAYLOAD.length),
          "Accept-Ranges": "bytes",
          "Content-Type": "application/octet-stream",
        });
        res.end();
        return;
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
      // Drip-feed 32 KiB chunks so a pause test can interrupt mid-download.
      let offset = start;
      const timer = setInterval(() => {
        if (offset > end || res.destroyed) {
          clearInterval(timer);
          if (!res.destroyed) res.end();
          return;
        }
        const next = Math.min(offset + 32 * 1024, end + 1);
        res.write(PAYLOAD.subarray(offset, next));
        offset = next;
      }, 60);
      return;
    }
    if ((req.url ?? "").startsWith("/fakerange")) {
      // Advertises Accept-Ranges on HEAD but ignores Range on GET.
      if (req.method === "HEAD") {
        res.writeHead(200, {
          "Content-Length": String(PAYLOAD.length),
          "Accept-Ranges": "bytes",
          "Content-Type": "application/octet-stream",
        });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Length": String(PAYLOAD.length) });
      res.end(PAYLOAD);
      return;
    }
    if ((req.url ?? "").startsWith("/norange")) {
      rangeHandler(PAYLOAD, false)(req, res);
    } else {
      rangeHandler(PAYLOAD, true)(req, res);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "dm-test-"));
}

describe("segments and categories", () => {
  it("plans segments that cover the file exactly once", () => {
    const segments = planSegments(1_000_001, 8, 1024);
    expect(segments.length).toBe(8);
    expect(segments[0]!.start).toBe(0);
    expect(segments.at(-1)!.end).toBe(1_000_000);
    const covered = segments.reduce((sum, s) => sum + (s.end - s.start + 1), 0);
    expect(covered).toBe(1_000_001);
  });

  it("categorises by extension and MIME", () => {
    expect(categorize("movie.mp4", null)).toBe("Video");
    expect(categorize("song.flac", null)).toBe("Audio");
    expect(categorize("report.pdf", null)).toBe("Documents");
    expect(categorize("archive.zip", null)).toBe("Compressed");
    expect(categorize("setup.exe", null)).toBe("Programs");
    expect(categorize("unknown.xyz", "video/mp4")).toBe("Video");
  });
});

describe("download engine (local server)", () => {
  it("downloads a segmented file byte-for-byte", async () => {
    const dir = await tempDir();
    const dest = join(dir, "file.bin");
    const session = await startDownload(`${baseUrl}/file`, dest, { segments: 4 });
    const job = await session.done;
    expect(job.status).toBe("completed");
    expect(job.segments.length).toBeGreaterThanOrEqual(4);
    const bytes = await readFile(dest);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(PAYLOAD_HASH);
    await rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("falls back to a single stream when Range is unsupported", async () => {
    const dir = await tempDir();
    const dest = join(dir, "norange.bin");
    const session = await startDownload(`${baseUrl}/norange`, dest, { segments: 4 });
    const job = await session.done;
    expect(job.status).toBe("completed");
    expect(job.rangeSupported).toBe(false);
    const bytes = await readFile(dest);
    expect(bytes.equals(PAYLOAD)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("falls back to a single stream when a server advertises ranges but ignores Range requests", async () => {
    const dir = await tempDir();
    const dest = join(dir, "fake.bin");
    const session = await startDownload(`${baseUrl}/fakerange`, dest, { segments: 4 });
    const job = await session.done;
    expect(job.status).toBe("completed");
    expect(job.rangeSupported).toBe(false);
    const bytes = await readFile(dest);
    expect(bytes.equals(PAYLOAD)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("follows redirects", async () => {
    const dir = await tempDir();
    const dest = join(dir, "redirect.bin");
    const session = await startDownload(`${baseUrl}/redirect`, dest, { segments: 2 });
    const job = await session.done;
    expect(job.status).toBe("completed");
    expect((await readFile(dest)).equals(PAYLOAD)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("retries after a mid-stream disconnect", async () => {
    flakyFirstRequest = true;
    const dir = await tempDir();
    const dest = join(dir, "flaky.bin");
    const session = await startDownload(`${baseUrl}/flaky`, dest, { segments: 1 });
    const job = await session.done;
    expect(job.status).toBe("completed");
    expect((await readFile(dest)).equals(PAYLOAD)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("Auto segments (0) runs all segment workers, not one", async () => {
    const dir = await tempDir();
    const dest = join(dir, "auto.bin");
    // /slow drip-feeds 32 KiB/60 ms per connection. A 2 MiB payload on
    // Auto resolves to 2 segments; with the old workerCount bug
    // (min(0, n) = 1) only the first segment would ever move, so the
    // second segment staying at 0 is the regression signal.
    const session = await startDownload(`${baseUrl}/slow`, dest, { segments: 0 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const moving = session
      .progress()
      .segments.filter((segment) => segment.downloaded > 0);
    expect(session.job.segments.length).toBeGreaterThanOrEqual(2);
    expect(moving.length).toBeGreaterThanOrEqual(2);
    const paused = await session.pause();
    expect(paused.status).toBe("paused");
    await rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("pauses and resumes from the journal", async () => {
    const dir = await tempDir();
    const dest = join(dir, "big.bin");
    const part = `${dest}.part`;
    // /slow drip-feeds the payload, so pausing here is genuinely mid-download.
    const session = await startDownload(`${baseUrl}/slow`, dest, { segments: 8 });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const paused = await session.pause();
    expect(paused.status).toBe("paused");
    expect(paused.downloadedBytes).toBeGreaterThanOrEqual(0);
    const resumed = await resumeDownload(part);
    const job = await resumed.done;
    expect(job.status).toBe("completed");
    expect((await readFile(dest)).equals(PAYLOAD)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  }, 30_000);
});

describe("queue and scheduler", () => {
  it("orders by priority and defers future scheduled items", () => {
    // maxConcurrent 0 keeps items queued so dueItems() ordering is pure.
    const queue = new DownloadQueue(async () => undefined, 0);
    const future: QueueItem = {
      id: "future", url: "https://example.com/a", destination: "/tmp/a",
      category: "General", priority: 99,
      scheduledAt: new Date(Date.now() + 60_000).toISOString(), status: "queued",
    };
    const low: QueueItem = {
      id: "low", url: "https://example.com/b", destination: "/tmp/b",
      category: "General", priority: 1, status: "queued",
    };
    const high: QueueItem = {
      id: "high", url: "https://example.com/c", destination: "/tmp/c",
      category: "General", priority: 10, status: "queued",
    };
    queue.add(future);
    queue.add(low);
    queue.add(high);
    const due = queue.dueItems().map((item) => item.id);
    expect(due).toEqual(["high", "low"]);
    expect(queue.remove("future")).toBe(true);
  });
});
