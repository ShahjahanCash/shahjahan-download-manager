import { describe, expect, it } from "vitest";
import { planSegments } from "../src/engine/segments.js";
import { retryOnLock, isLockError } from "../src/engine/fileOps.js";
import { winLongPath, exceedsMaxPath, isWindowsLongPath } from "../src/engine/paths.js";
import { compareVersions, checkForUpdates } from "../src/app/updater.js";

describe("Windows hardening", () => {
  it("long paths get the extended-length prefix only on win32", () => {
    expect(winLongPath("C:\\Users\\test\\file.bin", "win32")).toBe("\\\\?\\C:\\Users\\test\\file.bin");
    expect(winLongPath("\\\\server\\share\\file.bin", "win32")).toBe("\\\\?\\UNC\\server\\share\\file.bin");
    expect(winLongPath("\\\\?\\C:\\already.bin", "win32")).toBe("\\\\?\\C:\\already.bin");
    expect(winLongPath("C:\\Users\\test\\file.bin", "linux")).toBe("C:\\Users\\test\\file.bin");
    expect(winLongPath("/tmp/file.bin", "win32")).toBe("/tmp/file.bin");
    expect(isWindowsLongPath("\\\\?\\C:\\x")).toBe(true);
    expect(exceedsMaxPath("a".repeat(260))).toBe(true);
    expect(exceedsMaxPath("short")).toBe(false);
  });

  it("retries AV-lock errors and fails fast on other errors", async () => {
    let attempts = 0;
    const result = await retryOnLock(async () => {
      attempts++;
      if (attempts < 3) {
        const error = new Error("locked") as Error & { code: string };
        error.code = "EBUSY";
        throw error;
      }
      return "ok";
    }, { delayMs: 1 });
    expect(result).toBe("ok");
    expect(attempts).toBe(3);

    await expect(
      retryOnLock(async () => {
        const error = new Error("not found") as Error & { code: string };
        error.code = "ENOENT";
        throw error;
      }, { delayMs: 1 }),
    ).rejects.toThrow("not found");
    expect(isLockError({ code: "EPERM" })).toBe(true);
    expect(isLockError({ code: "ENOENT" })).toBe(false);
  });

  it("segments plan correctly above 4 GiB without 32-bit truncation", () => {
    const total = 5 * 1024 * 1024 * 1024 + 123; // 5 GiB + 123 bytes
    const segments = planSegments(total, 8, 1024 * 1024);
    expect(segments.length).toBe(8);
    expect(segments[0]!.start).toBe(0);
    // Last segment start must be > 4 GiB, not wrapped to a 32-bit value.
    expect(segments[7]!.start).toBeGreaterThan(4 * 1024 * 1024 * 1024);
    expect(segments[7]!.end).toBe(total - 1);
    // Segments cover the whole file with no gaps.
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]!.start).toBe(segments[i - 1]!.end + 1);
    }
    const covered = segments.reduce((sum, s) => sum + (s.end - s.start + 1), 0);
    expect(covered).toBe(total);
  });

  it("compares versions and reports an update only when newer", async () => {
    expect(compareVersions("0.6.0", "0.5.0")).toBeGreaterThan(0);
    expect(compareVersions("v0.5.0", "0.5.0")).toBe(0);
    expect(compareVersions("0.5.0", "0.6.0")).toBeLessThan(0);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);

    const feed = async () => ({
      ok: true,
      json: async () => ({ version: "0.6.0", url: "https://example.com/setup.exe" }),
    });
    const newer = await checkForUpdates("0.5.0", "https://example.com/feed.json", feed as never);
    expect(newer.available).toBe(true);
    expect(newer.latestVersion).toBe("0.6.0");
    expect(newer.url).toBe("https://example.com/setup.exe");

    const older = await checkForUpdates("0.6.0", "https://example.com/feed.json", feed as never);
    expect(older.available).toBe(false);
    expect(older.url).toBeNull();

    const noFeed = await checkForUpdates("0.5.0", null);
    expect(noFeed.available).toBe(false);
    expect(noFeed.error).toBeNull();
  });

  it("rejects non-https update feed urls (0.7.8 audit fix)", async () => {
    // The dialog opens the feed url with shell.openExternal after a
    // user click, so http: — and especially file: — must never reach it.
    const httpFeed = async () => ({
      ok: true,
      json: async () => ({ version: "9.9.9", url: "http://example.com/setup.exe" }),
    });
    const httpResult = await checkForUpdates("0.5.0", "https://example.com/feed.json", httpFeed as never);
    expect(httpResult.available).toBe(false);
    expect(httpResult.url).toBeNull();
    expect(httpResult.error).toMatch(/https/);

    const fileFeed = async () => ({
      ok: true,
      json: async () => ({ version: "9.9.9", url: "file:///C:/Windows/setup.exe" }),
    });
    const fileResult = await checkForUpdates("0.5.0", "https://example.com/feed.json", fileFeed as never);
    expect(fileResult.available).toBe(false);
    expect(fileResult.url).toBeNull();
    expect(fileResult.error).toMatch(/https/);
  });
});
