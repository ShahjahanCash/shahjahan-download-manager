import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractLinks } from "../src/app/grabber.js";
import { parseQueueFile, serializeJob } from "../src/app/persist.js";
import { isRetryableError, retryDelayMs } from "../src/app/retry.js";
import { AppDownloadManager } from "../src/app/manager.js";
import { computeHash, hashMatches } from "../src/engine/checksum.js";
import { parseProxyUrl } from "../src/engine/proxy.js";
import { parseFtpUrl } from "../src/ftp/session.js";
import { newLiveSegments } from "../src/stream/live.js";
import { buildYtDlpArgs } from "../src/yt/options.js";
import { EventEmitter } from "node:events";
import {
  TorrentSession,
  parseMagnetName,
  torrentDisplayName,
  type TorrentLike,
  type WebTorrentClientLike,
} from "../src/torrent/session.js";

describe("site grabber extraction", () => {
  it("resolves relative URLs, dedupes, and skips navigation links", () => {
    const html = `
      <a href="/files/movie.mp4">movie</a>
      <a href="/files/movie.mp4">movie again</a>
      <a href="https://cdn.example.com/song.mp3">song</a>
      <a href="#section">anchor</a>
      <a href="javascript:void(0)">js</a>
      <a href="/about">plain page link</a>
      <img src="/img/poster.jpg" />`;
    const links = extractLinks(html, "https://example.com/page");
    expect(links.map((l) => l.url)).toEqual([
      "https://example.com/files/movie.mp4",
      "https://cdn.example.com/song.mp3",
      "https://example.com/img/poster.jpg",
    ]);
    expect(links[0]!.kind).toBe("media");
    expect(links[2]!.kind).toBe("image");
  });
});

describe("auto-retry classification", () => {
  it("retries transient errors but never permanent ones", () => {
    expect(isRetryableError("HTTP 500 for https://x")).toBe(true);
    expect(isRetryableError("socket hang up")).toBe(true);
    expect(isRetryableError("HTTP 404 for https://x")).toBe(false);
    expect(isRetryableError("HTTP 403 for https://x")).toBe(false);
    expect(isRetryableError("Probe failed: HTTP 416")).toBe(false);
  });
  it("doubles the delay and caps at 5 minutes", () => {
    expect(retryDelayMs(1, 10)).toBe(10_000);
    expect(retryDelayMs(3, 10)).toBe(40_000);
    expect(retryDelayMs(99, 10)).toBe(300_000);
  });
});

describe("proxy parsing", () => {
  it("accepts http(s) proxies with auth and rejects the rest", () => {
    expect(parseProxyUrl("http://127.0.0.1:8080")).toContain("127.0.0.1:8080");
    expect(parseProxyUrl("http://user:pass@proxy.local:3128")).toContain("proxy.local:3128");
    expect(parseProxyUrl("socks5://127.0.0.1:1080")).toBeNull();
    expect(parseProxyUrl("not a url")).toBeNull();
    expect(parseProxyUrl("")).toBeNull();
  });
});

describe("FTP URL parsing", () => {
  it("parses credentials, ports and ftps", () => {
    expect(parseFtpUrl("ftp://user:pass@host.example.com:2121/dir/file.zip")).toEqual({
      host: "host.example.com",
      port: 2121,
      username: "user",
      password: "pass",
      remotePath: "/dir/file.zip",
      secure: false,
    });
    const anonymous = parseFtpUrl("ftps://host.example.com/file.zip")!;
    expect(anonymous.port).toBe(21);
    expect(anonymous.username).toBe("anonymous");
    expect(anonymous.secure).toBe(true);
    expect(parseFtpUrl("https://example.com/file.zip")).toBeNull();
  });
});

describe("YouTube cookies and proxy args", () => {
  it("adds cookies-from-browser, prefers a cookies file, and adds --proxy", () => {
    const browser = buildYtDlpArgs("https://youtube.com/watch?v=x", { kind: "video", cookiesFromBrowser: "chrome" }, "/tmp/out", null);
    expect(browser.args).toContain("--cookies-from-browser");
    expect(browser.args).toContain("chrome");
    const file = buildYtDlpArgs("https://youtube.com/watch?v=x", { kind: "video", cookiesFromBrowser: "chrome", cookiesFile: "/tmp/cookies.txt" }, "/tmp/out", null);
    expect(file.args).toContain("--cookies");
    expect(file.args).not.toContain("--cookies-from-browser");
    const proxy = buildYtDlpArgs("https://youtube.com/watch?v=x", { kind: "video", proxy: "http://127.0.0.1:8080" }, "/tmp/out", null);
    expect(proxy.args).toContain("--proxy");
  });
});

describe("live HLS segment diffing", () => {
  it("only returns segments whose URLs are unseen", () => {
    const seen = new Set(["https://cdn/x/seg1.ts"]);
    const playlist = [
      { index: 1, url: "https://cdn/x/seg1.ts", durationSeconds: 6, keyUri: null, keyIv: null, downloaded: 0, done: false },
      { index: 2, url: "https://cdn/x/seg2.ts", durationSeconds: 6, keyUri: null, keyIv: null, downloaded: 0, done: false },
    ];
    expect(newLiveSegments(seen, playlist).map((s) => s.index)).toEqual([2]);
  });
});

describe("checksum helpers", () => {
  it("hashes a file and matches normalised expectations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sdm-hash-"));
    try {
      const path = join(dir, "a.txt");
      await writeFile(path, "abc");
      expect(await computeHash(path, "sha256")).toBe(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      );
      expect(hashMatches("BA78-16BF-8F01-CFEA-4141-40DE-5DAE-2223-B003-61A3-9617-7A9C-B410-FF61-F200-15AD", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")).toBe(true);
      expect(hashMatches("deadbeef", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("torrent helpers", () => {
  it("parses magnet names and falls back for plain links", () => {
    expect(parseMagnetName("magnet:?xt=urn:btih:abc&dn=Big+Movie+2024")).toBe("Big Movie 2024");
    expect(parseMagnetName("magnet:?xt=urn:btih:abc")).toBeNull();
    expect(parseMagnetName("not a magnet")).toBeNull();
    expect(torrentDisplayName("magnet:?xt=urn:btih:abc&dn=Show")).toBe("Show");
  });
  it("adds --limit-rate for queue/global speed caps", () => {
    const args = buildYtDlpArgs("https://youtube.com/watch?v=x", { kind: "video", limitRate: 500_000 }, "/tmp/out", null);
    expect(args.args).toContain("--limit-rate");
    expect(args.args).toContain("500000");
  });
});

describe("torrent session plumbing (stub client, no swarm)", () => {
  function stubClient() {
    const emitter = new EventEmitter();
    const torrent: TorrentLike = Object.assign(emitter, {
      name: "demo",
      path: "/tmp/demo",
      files: [{ path: "demo.bin", name: "demo.bin", length: 100 }],
      downloaded: 100,
      uploaded: 0,
      length: 100,
      progress: 1,
      downloadSpeed: 0,
      done: true,
      pause: () => undefined,
      resume: () => undefined,
      destroy: (cb?: () => void) => {
        cb?.();
        return Promise.resolve();
      },
    }) as TorrentLike;
    const client: WebTorrentClientLike = {
      add: (_id, _opts, cb) => {
        // Metadata arrives, then the torrent completes.
        setTimeout(() => {
          cb?.(torrent);
          emitter.emit("done");
        }, 10);
        return torrent;
      },
      destroy: () => undefined,
    };
    return { client, torrent };
  }

  it("completes when the torrent fires done", async () => {
    const { client } = stubClient();
    const session = new TorrentSession({
      jobId: "t1",
      sessionId: "s1",
      source: "magnet:?xt=urn:btih:abc&dn=demo",
      outDir: "/tmp/demo",
      client,
    });
    const result = await session.startRun();
    expect(result.status).toBe("completed");
    expect(result.destination).toContain("demo.bin");
    expect(session.progress().percent).toBe(1);
  });

  it("pause resolves the run as paused and keeps the torrent", async () => {
    const { client, torrent } = stubClient();
    const session = new TorrentSession({
      jobId: "t2",
      sessionId: "s2",
      source: "magnet:?xt=urn:btih:abc&dn=demo",
      outDir: "/tmp/demo",
      client,
    });
    const run = session.startRun();
    session.pause();
    const result = await run;
    expect(result.status).toBe("paused");
    expect(session.filePaths()).toContain("/tmp/demo/demo.bin");
    void torrent;
  });
});

describe("extension site grabber (static)", () => {
  it("content script collects page links and popup sends a selection", async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "extension");
    const content = await readFile(join(root, "content.js"), "utf8");
    const popup = await readFile(join(root, "popup.js"), "utf8");
    expect(content).toContain("dm_grab_links");
    expect(content).toContain("grabLinks");
    expect(popup).toContain("grab-send");
    expect(popup).toContain("dm_download");
  });
});

describe("per-queue speed limits persist", () => {
  it("setQueueSpeedLimit survives save/restore", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sdm-qlimit-"));
    try {
      const queuePath = join(dir, "queue.json");
      const manager = new AppDownloadManager({ downloadsDir: dir, queuePath });
      const queue = manager.createQueue("Slow");
      expect(manager.setQueueSpeedLimit(queue.id, 250_000)).toBe(true);
      expect(manager.setQueueSpeedLimit("nope", 100)).toBe(false);
      await manager.saveQueue();
      const parsed = parseQueueFile(await readFile(queuePath, "utf8"));
      expect(parsed?.queues.find((q) => q.id === queue.id)?.speedLimitBytesPerSec).toBe(250_000);
      const second = new AppDownloadManager({ downloadsDir: dir, queuePath });
      await second.restoreQueue();
      expect(second.listQueues().find((q) => q.id === queue.id)?.speedLimitBytesPerSec).toBe(250_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("persistent queue", () => {
  it("serializes and restores jobs, mapping active jobs to paused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sdm-queue-"));
    let manager: AppDownloadManager | null = null;
    try {
      const queuePath = join(dir, "queue.json");
      const file = {
        version: 1 as const,
        queues: [{ id: "main", name: "Main Queue", maxConcurrent: 3 }],
        jobs: [
          serializeJob({
            id: "job-1",
            url: "https://example.com/file.zip",
            filename: "file.zip",
            category: "Compressed",
            destination: join(dir, "file.zip"),
            partPath: join(dir, "file.zip.part"),
            status: "downloading",
            createdAt: new Date().toISOString(),
            queueId: "main",
            expectedHash: "abc123",
          }),
        ],
      };
      await writeFile(queuePath, JSON.stringify(file));
      manager = new AppDownloadManager({ downloadsDir: dir, queuePath });
      const restored = await manager.restoreQueue();
      expect(restored).toBe(1);
      const jobs = manager.list();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.status).toBe("paused");
      expect(jobs[0]!.expectedHash).toBe("abc123");
      expect(parseQueueFile("not json")).toBeNull();
    } finally {
      // Flush any pending queue write before removing the directory.
      await manager?.saveQueue();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("saveQueue writes a file restoreQueue can read back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sdm-queue-"));
    let manager: AppDownloadManager | null = null;
    try {
      const queuePath = join(dir, "queue.json");
      manager = new AppDownloadManager({ downloadsDir: dir, queuePath });
      manager.createQueue("Movies");
      await manager.saveQueue();
      const raw = await readFile(queuePath, "utf8");
      const parsed = parseQueueFile(raw);
      expect(parsed?.queues.map((q) => q.name)).toContain("Movies");
    } finally {
      await manager?.saveQueue();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
