import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AppDownloadManager,
  isYoutubeImportUrl,
  jobsToCsv,
  parseImportUrls,
  type AppJob,
} from "../src/app/manager.js";

const PAYLOAD = Buffer.alloc(256 * 1024);
for (let i = 0; i < PAYLOAD.length; i++) PAYLOAD[i] = i % 251;

// When true, /fail.bin answers 500 to GET (HEAD still succeeds, so the
// job is created and then fails in the pump — the retry path).
let failMode = true;
let baseUrl = "";
let server: ReturnType<typeof createServer>;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? "";
    if (req.method === "HEAD") {
      res.writeHead(200, {
        "Content-Length": String(PAYLOAD.length),
        "Accept-Ranges": "bytes",
        "Content-Type": "application/octet-stream",
      });
      return res.end();
    }
    if (path === "/fail.bin" && failMode) {
      res.writeHead(500);
      return res.end("boom");
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
    }, 25);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("parseImportUrls (0.8.0)", () => {
  it("keeps http/https/magnet/ftp/ftps, dedupes, and counts invalid lines as skipped", () => {
    const result = parseImportUrls(
      [
        "https://example.com/a.zip",
        "  https://example.com/a.zip  ",
        "magnet:?xt=urn:btih:abc",
        "ftp://example.com/file.bin",
        "ftps://example.com/secure.bin",
        "",
        "not a url",
        "https://",
        "https://example.com/two words.zip",
        "file:///etc/passwd",
      ].join("\n"),
    );
    expect(result.urls).toEqual([
      "https://example.com/a.zip",
      "magnet:?xt=urn:btih:abc",
      "ftp://example.com/file.bin",
      "ftps://example.com/secure.bin",
    ]);
    // 1 duplicate + 4 invalid (not-a-url, bare scheme, internal space,
    // file://) — blank lines are ignored, not skipped.
    expect(result.skipped).toBe(5);
  });

  it("handles CRLF line endings", () => {
    const result = parseImportUrls("https://example.com/a.zip\r\nhttps://example.com/b.zip\r\n");
    expect(result.urls).toHaveLength(2);
    expect(result.skipped).toBe(0);
  });
});

describe("isYoutubeImportUrl (0.8.0)", () => {
  it("matches youtube hosts and youtu.be only", () => {
    expect(isYoutubeImportUrl("https://www.youtube.com/watch?v=x")).toBe(true);
    expect(isYoutubeImportUrl("https://music.youtube.com/watch?v=x")).toBe(true);
    expect(isYoutubeImportUrl("https://youtu.be/x")).toBe(true);
    expect(isYoutubeImportUrl("https://www.notyoutube.com/watch?v=x")).toBe(false);
    expect(isYoutubeImportUrl("https://example.com/video.mp4")).toBe(false);
    expect(isYoutubeImportUrl("not a url")).toBe(false);
  });
});

describe("jobsToCsv (0.8.0)", () => {
  const fakeJob = (over: Partial<AppJob>): AppJob =>
    ({
      id: "1",
      url: "https://example.com/x",
      filename: "x",
      category: "General",
      destination: "/tmp/x",
      partPath: "/tmp/x.part",
      status: "completed",
      progress: null,
      error: null,
      createdAt: "2026-01-01",
      retryCount: 0,
      ...over,
    }) as unknown as AppJob;

  it("quotes commas, quotes and newlines, and appends a stats summary", () => {
    const csv = jobsToCsv([
      fakeJob({
        id: "a",
        filename: 'a, "quoted"\nname.bin',
        url: "https://example.com/a",
        status: "completed",
        progress: {
          jobId: "a",
          status: "completed",
          downloadedBytes: 100,
          totalBytes: 100,
          percent: 1,
          speedBytesPerSec: 0,
          etaSeconds: 0,
          segments: [],
          error: null,
        },
      }),
      fakeJob({ id: "b", filename: "b.bin", url: "https://example.com/b", status: "failed", queueId: "second" }),
    ]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("name,url,status,size,downloaded,category,queue");
    expect(lines[1]).toBe('"a, ""quoted""\nname.bin",https://example.com/a,completed,100,100,General,main');
    expect(lines[2]).toBe("b.bin,https://example.com/b,failed,,,General,second");
    expect(lines).toContain("metric,value");
    expect(lines).toContain("total_jobs,2");
    expect(lines).toContain("completed_jobs,1");
    expect(lines).toContain("failed_jobs,1");
    expect(lines).toContain("total_downloaded_bytes,100");
  });
});

describe("resume() restarts failed jobs (0.8.0)", () => {
  it("fails on HTTP 500, then completes after the server recovers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dm-080-"));
    const manager = new AppDownloadManager({ downloadsDir: dir, maxConcurrent: 1, segments: 1 });
    manager.setRetryConfig(0, 1);
    failMode = true;
    const job = await manager.add(`${baseUrl}/fail.bin`);
    await waitFor(() => manager.get(job.id)?.status === "failed");
    expect(manager.get(job.id)?.error ?? "").toContain("500");
    failMode = false;
    await manager.resume(job.id);
    await waitFor(() => manager.get(job.id)?.status === "completed");
    expect((await readFile(join(dir, "Programs", "fail.bin"))).equals(PAYLOAD)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  }, 30_000);
});

describe("deleteWithFile (0.8.0)", () => {
  it("removes a completed job and its file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dm-080-"));
    const manager = new AppDownloadManager({ downloadsDir: dir, maxConcurrent: 1, segments: 1 });
    const job = await manager.add(`${baseUrl}/ok.bin`);
    await waitFor(() => manager.get(job.id)?.status === "completed");
    const dest = join(dir, "Programs", "ok.bin");
    expect(await exists(dest)).toBe(true);
    expect(await manager.deleteWithFile(job.id)).toBe(true);
    expect(manager.get(job.id)).toBeUndefined();
    expect(await exists(dest)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("removes the list entry but NEVER unlinks a destination outside the downloads dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dm-080-"));
    const outside = await mkdtemp(join(tmpdir(), "dm-080-outside-"));
    const manager = new AppDownloadManager({ downloadsDir: dir, maxConcurrent: 1, segments: 1 });
    const dest = join(outside, "ok.bin");
    const job = await manager.add(`${baseUrl}/ok.bin`, { destination: dest });
    await waitFor(() => manager.get(job.id)?.status === "completed");
    expect(await exists(dest)).toBe(true);
    expect(await manager.deleteWithFile(job.id)).toBe(true);
    expect(manager.get(job.id)).toBeUndefined();
    expect(await exists(dest)).toBe(true);
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }, 30_000);

  it("refuses non-completed jobs and leaves them untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dm-080-"));
    const manager = new AppDownloadManager({ downloadsDir: dir, maxConcurrent: 1, segments: 1 });
    const job = await manager.add(`${baseUrl}/ok.bin`);
    // Pause immediately, before the 256 KiB drip can finish (the same
    // pattern as the existing pause test, without its 100 ms sleep).
    const paused = await manager.pause(job.id);
    expect(paused?.status).toBe("paused");
    expect(await manager.deleteWithFile(job.id)).toBe(false);
    expect(manager.get(job.id)?.status).toBe("paused");
    await rm(dir, { recursive: true, force: true });
  }, 30_000);
});

describe("pauseQueue / resumeQueue (0.8.0)", () => {
  it("pauses and resumes only the named queue's jobs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dm-080-"));
    const manager = new AppDownloadManager({ downloadsDir: dir, maxConcurrent: 1, segments: 1 });
    const queue = manager.createQueue("second");
    const first = await manager.add(`${baseUrl}/ok.bin`);
    const second = await manager.add(`${baseUrl}/ok.bin`, { queueId: queue.id });
    await waitFor(() => manager.get(first.id)?.status === "downloading");
    expect(await manager.pauseQueue(queue.id)).toBe(1);
    expect(manager.get(second.id)?.status).toBe("paused");
    expect(manager.get(first.id)?.status).toBe("downloading");
    expect(await manager.resumeQueue(queue.id)).toBe(1);
    await waitFor(() => manager.get(first.id)?.status === "completed");
    await waitFor(() => manager.get(second.id)?.status === "completed");
    await rm(dir, { recursive: true, force: true });
  }, 30_000);
});
