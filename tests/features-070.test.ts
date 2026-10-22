/**
 * 0.7.0 feature tests (pure modules + mirror failover end-to-end).
 * No Windows-only APIs are exercised: extract/defender tests cover
 * command builders and output parsing only; the manager spawns the
 * real commands on win32.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isInWindow, shouldRunNow, validateWindow } from "../src/app/scheduler.js";
import {
  decideSmartLimit,
  isWatchedProcessRunning,
  normalizeWatchlist,
} from "../src/app/smartLimit.js";
import { archiveKind, extractCommand, extractOutDir } from "../src/app/extract.js";
import { defenderCommand, parseDefenderOutput } from "../src/app/defender.js";
import { aggregateStats, localDay } from "../src/app/stats.js";
import {
  appendTrackers,
  removeTrackers,
  shouldStopSeeding,
} from "../src/torrent/trackers.js";
import { recommendSegments } from "../src/engine/segments.js";
import { startDownload } from "../src/engine/downloader.js";

describe("scheduler windows", () => {
  const at = (hours: number, minutes = 0) => {
    const date = new Date(2026, 9, 22, hours, minutes);
    return date;
  };
  it("matches a daytime window", () => {
    expect(isInWindow(at(23, 0), { start: "22:00", end: "06:00" })).toBe(true);
    expect(isInWindow(at(3, 0), { start: "22:00", end: "06:00" })).toBe(true);
    expect(isInWindow(at(12, 0), { start: "22:00", end: "06:00" })).toBe(false);
    expect(isInWindow(at(6, 0), { start: "22:00", end: "06:00" })).toBe(false);
  });
  it("disabled policy always allows", () => {
    expect(shouldRunNow({ enabled: false, windows: [] }, at(12))).toBe(true);
    expect(shouldRunNow({ enabled: true, windows: [] }, at(12))).toBe(true);
  });
  it("rejects bad times", () => {
    expect(validateWindow("25:00", "06:00")).toMatch(/Invalid start/);
    expect(validateWindow("22:00", "6:00")).toMatch(/Invalid end/);
    expect(validateWindow("22:00", "06:00")).toBeNull();
  });
});

describe("smart speed limit", () => {
  it("caps while a watched process runs, restores after", () => {
    const config = { enabled: true, smartLimitBytesPerSec: 100_000, watchlist: ["eldenring.exe"] };
    expect(isWatchedProcessRunning(["ELDENRING.EXE", "explorer.exe"], config.watchlist)).toBe(true);
    expect(isWatchedProcessRunning(["explorer.exe"], config.watchlist)).toBe(false);
    expect(decideSmartLimit(config, ["eldenring.exe"], 0)).toEqual({ limited: true, limitBytesPerSec: 100_000 });
    expect(decideSmartLimit(config, [], 0)).toEqual({ limited: false, limitBytesPerSec: 0 });
    expect(decideSmartLimit({ ...config, enabled: false }, ["eldenring.exe"], 0).limited).toBe(false);
  });
  it("normalizes comma/newline watchlists", () => {
    expect(normalizeWatchlist(" EldenRing.exe,\nobs64.exe ")).toEqual(["eldenring.exe", "obs64.exe"]);
  });
});

describe("auto-extract commands", () => {
  it("detects archives and builds the ZIP command", () => {
    expect(archiveKind("setup.ZIP")).toBe("zip");
    expect(archiveKind("game.rar")).toBe("rar");
    expect(archiveKind("movie.mp4")).toBeNull();
    const cmd = extractCommand("C:\\dl\\setup.zip", "C:\\dl\\setup (extracted)");
    expect(cmd?.command).toBe("powershell");
    expect(cmd?.args).toContain("Expand-Archive");
    expect(extractCommand("C:\\dl\\game.rar", "C:\\dl\\game (extracted)")).toBeNull();
    expect(extractCommand("C:\\dl\\game.rar", "C:\\dl\\game (extracted)", { has7Zip: true })?.command).toBe("7z");
    expect(extractOutDir("C:\\dl\\setup.zip")).toBe("C:\\dl\\setup (extracted)");
  });
});

describe("defender scan parsing", () => {
  it("parses clean/threat/error output", () => {
    expect(parseDefenderOutput(0, "Scan finished, found no threats")).toBe("clean");
    expect(parseDefenderOutput(2, "Threat detected")).toBe("threat");
    expect(parseDefenderOutput(1, "error")).toBe("error");
    expect(parseDefenderOutput(null, "")).toBe("unknown");
    expect(defenderCommand("C:\\dl\\a.exe").args).toContain("-Scan");
  });
});

describe("history & stats aggregation", () => {
  it("totals, month, last-30-days and average speed", () => {
    const now = new Date(2026, 9, 22, 12, 0);
    const summary = aggregateStats(
      [
        { day: "2026-10-22", bytes: 1000, durationMs: 1000, jobId: "a" },
        { day: "2026-10-01", bytes: 2000, durationMs: 1000, jobId: "b" },
        { day: "2026-09-01", bytes: 4000, durationMs: 1000, jobId: "c" },
      ],
      now,
    );
    expect(summary.totalBytes).toBe(7000);
    expect(summary.monthBytes).toBe(3000);
    expect(summary.last30DaysBytes).toBe(3000);
    expect(summary.totalJobs).toBe(3);
    expect(summary.averageSpeedBytesPerSec).toBeCloseTo(2333.33, 1);
    expect(localDay(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("torrent trackers & seeding policy", () => {
  const magnet = "magnet:?xt=urn:btih:abc&dn=demo";
  it("appends trackers without duplicates", () => {
    const withTrackers = appendTrackers(magnet, ["wss://t1.example", "wss://t1.example"]);
    expect(withTrackers).toContain("tr=wss%3A%2F%2Ft1.example");
    expect(withTrackers.match(/tr=/g)).toHaveLength(1);
    // URL re-encodes ":" in xt on round-trip; compare parsed params.
    const removed = new URL(removeTrackers(withTrackers, ["wss://t1.example"]));
    expect(removed.searchParams.getAll("tr")).toEqual([]);
    expect(removed.searchParams.get("xt")).toBe("urn:btih:abc");
    expect(removed.searchParams.get("dn")).toBe("demo");
  });
  it("stops seeding at ratio or time cap", () => {
    const policy = { enabled: true, ratioLimit: 1, maxMinutes: 60 };
    expect(shouldStopSeeding(policy, 1500, 1000, 0)).toBe(true);
    expect(shouldStopSeeding(policy, 500, 1000, 61 * 60_000)).toBe(true);
    expect(shouldStopSeeding(policy, 500, 1000, 1000)).toBe(false);
    expect(shouldStopSeeding({ ...policy, enabled: false }, 9999, 1, 0)).toBe(true);
  });
});

describe("dynamic segments", () => {
  it("recommends more segments for bigger files", () => {
    expect(recommendSegments(512 * 1024)).toBe(1);
    expect(recommendSegments(5 * 1024 * 1024)).toBe(2);
    expect(recommendSegments(50 * 1024 * 1024)).toBe(8);
    expect(recommendSegments(500 * 1024 * 1024)).toBe(16);
    expect(recommendSegments(2 * 1024 * 1024 * 1024)).toBe(32);
  });
});

describe("mirror failover end-to-end", () => {
  let server: ReturnType<typeof createServer>;
  let base = "";
  const DATA = Buffer.from("mirror-failover-payload-".repeat(200));
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/primary") {
        res.writeHead(500);
        res.end("primary is down");
        return;
      }
      // /mirror serves Range requests.
      const range = req.headers.range;
      if (req.method === "HEAD") {
        res.writeHead(200, { "Content-Length": DATA.length, "Accept-Ranges": "bytes" });
        res.end();
        return;
      }
      if (range) {
        const match = /bytes=(\d+)-(\d*)/.exec(range);
        const start = Number(match?.[1] ?? 0);
        const end = match?.[2] ? Number(match[2]) : DATA.length - 1;
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${DATA.length}`,
          "Content-Length": end - start + 1,
          "Accept-Ranges": "bytes",
        });
        res.end(DATA.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, { "Content-Length": DATA.length, "Accept-Ranges": "bytes" });
      res.end(DATA);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  it("completes from the mirror when the primary fails every segment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dm-mirror-"));
    try {
      const session = await startDownload(`${base}/primary`, join(dir, "file.bin"), {
        segments: 2,
        mirrorUrls: [`${base}/mirror`],
        maxAttempts: 1,
        onProgress: () => undefined,
      });
      const result = await session.done;
      expect(result.status).toBe("completed");
      expect(await readFile(join(dir, "file.bin"))).toEqual(DATA);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
