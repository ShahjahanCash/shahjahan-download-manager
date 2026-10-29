import { describe, expect, it } from "vitest";
import {
  TorrentSession,
  isPathWithinDir,
  type TorrentFileLike,
  type TorrentLike,
  type WebTorrentClientLike,
} from "../src/torrent/session.js";

/**
 * Regression tests for the torrent path-traversal audit finding
 * (0.7.8): a crafted torrent can list file entries whose paths escape
 * the download folder — WebTorrent joins them verbatim — which used to
 * let a cancel delete files outside the folder (the old cancel guard
 * was a string-prefix check, and "/a/b-evil/x" starts with "/a/b").
 * The session now drops escaping entries from cleanup, fails the run
 * as soon as such metadata is known, and contains the cancel guard.
 */

const OUT_DIR = "/tmp/sdm-torrent-audit/out";

function makeFakeTorrent(files: TorrentFileLike[], name = "My Torrent"): TorrentLike & {
  handlers: Record<string, (...args: unknown[]) => void>;
  destroyCalled: boolean;
} {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const torrent = {
    name,
    path: OUT_DIR,
    files,
    downloaded: 0,
    uploaded: 0,
    length: 100,
    progress: 0,
    downloadSpeed: 0,
    done: false,
    handlers,
    destroyCalled: false,
    pause() {},
    resume() {},
    destroy(cb?: () => void) {
      torrent.destroyCalled = true;
      if (cb) cb();
      return Promise.resolve();
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      handlers[event] = listener;
    },
  };
  return torrent as unknown as TorrentLike & {
    handlers: Record<string, (...args: unknown[]) => void>;
    destroyCalled: boolean;
  };
}

function makeSession(torrent: TorrentLike): TorrentSession {
  const client: WebTorrentClientLike = {
    add() {
      return torrent;
    },
    destroy(cb?: () => void) {
      if (cb) cb();
    },
  };
  return new TorrentSession({
    jobId: "job-1",
    sessionId: "session-1",
    source: "magnet:?xt=urn:btih:deadbeef",
    outDir: OUT_DIR,
    client,
  });
}

describe("torrent path containment", () => {
  it("isPathWithinDir rejects escapes and sibling-prefix lookalikes", () => {
    expect(isPathWithinDir("/a/b", "/a/b/file.mp4")).toBe(true);
    expect(isPathWithinDir("/a/b", "/a/b")).toBe(true);
    expect(isPathWithinDir("/a/b", "/a/b-evil/x")).toBe(false);
    expect(isPathWithinDir("/a/b", "/a/evil")).toBe(false);
    expect(isPathWithinDir("/a/b", "/a/b/../evil")).toBe(false);
    expect(isPathWithinDir("/a/b", "/a/b/sub/../file.mp4")).toBe(true);
  });

  it("fails the run immediately when metadata already lists escaping files", async () => {
    const torrent = makeFakeTorrent([
      { path: "movie.mp4", name: "movie.mp4", length: 50 },
      { path: "../evil.txt", name: "evil.txt", length: 10 },
    ]);
    const session = makeSession(torrent);
    const result = await session.startRun();
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/outside its download folder/);
    expect(torrent.destroyCalled).toBe(true);
  });

  it("fails the run when a metadata event reveals an escaping torrent name", async () => {
    const torrent = makeFakeTorrent([
      { path: "movie.mp4", name: "movie.mp4", length: 50 },
    ]);
    const session = makeSession(torrent);
    const run = session.startRun();
    // Clean at start, so the run is still pending; then the torrent
    // name turns hostile and the metadata event fires.
    torrent.name = "../evil-folder";
    torrent.handlers["metadata"]!();
    const result = await run;
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/outside its download folder/);
  });

  it("filePaths drops escaping entries and destination falls back inside the folder", () => {
    const torrent = makeFakeTorrent([
      { path: "movie.mp4", name: "movie.mp4", length: 50 },
    ]);
    const session = makeSession(torrent);
    const run = session.startRun();
    // Mutate without firing a metadata event: cleanup must still be safe.
    torrent.files.push(
      { path: "../evil.txt", name: "evil.txt", length: 10 },
      { path: "../out-evil/payload.exe", name: "payload.exe", length: 10 },
    );
    expect(session.filePaths()).toEqual([`${OUT_DIR}/movie.mp4`]);
    // A single escaping file must not move the destination outside.
    torrent.files.splice(0, torrent.files.length, {
      path: "../evil.mp4",
      name: "evil.mp4",
      length: 10,
    });
    expect(session.destination()).toBe(OUT_DIR);
    session.pause();
    return run;
  });

  it("a clean torrent keeps running until paused", async () => {
    const torrent = makeFakeTorrent([
      { path: "movie.mp4", name: "movie.mp4", length: 50 },
    ]);
    const session = makeSession(torrent);
    const run = session.startRun();
    expect(session.filePaths()).toEqual([`${OUT_DIR}/movie.mp4`]);
    session.pause();
    const result = await run;
    expect(result.status).toBe("paused");
  });
});
