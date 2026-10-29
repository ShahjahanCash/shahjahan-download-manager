/**
 * Torrent / magnet downloads via WebTorrent (pure JS, TCP/UDP peers;
 * no WebRTC needed on desktop). One client per manager; each job is
 * a TorrentSession whose torrent object survives a pause, so resume
 * re-uses the same torrent and the partial files on disk. Cancel
 * destroys the torrent and deletes only that torrent's files.
 */

import { basename, join, resolve, sep } from "node:path";
import type { DownloadProgress } from "../engine/types.js";

/**
 * Structural WebTorrent types (no import of the package itself).
 * WebTorrent is ESM-only and ships no TypeScript declarations, so
 * the client is loaded with a dynamic import and cast to these
 * shapes, which match the v2 runtime behaviour verified by hand.
 */
export interface TorrentFileLike {
  path: string;
  name: string;
  length: number;
}

export interface TorrentLike {
  name: string;
  path: string;
  files: TorrentFileLike[];
  downloaded: number;
  /** Bytes uploaded (seeding ratio); WebTorrent provides this. */
  uploaded: number;
  length: number;
  progress: number;
  downloadSpeed: number;
  done: boolean;
  pause(): void;
  resume(): void;
  destroy(cb?: () => void): Promise<void> | void;
  on(
    event: "download" | "done" | "error" | "ready" | "metadata",
    listener: (...args: unknown[]) => void,
  ): void;
}

export interface WebTorrentClientLike {
  add(
    torrentId: string | Buffer,
    opts?: { path?: string },
    ontorrent?: (torrent: TorrentLike) => void,
  ): TorrentLike;
  destroy(cb?: () => void): void;
}

/** Load the WebTorrent client (dynamic import: the package is ESM-only). */
export async function createWebTorrentClient(): Promise<WebTorrentClientLike> {
  // @ts-expect-error — webtorrent ships no TypeScript declarations.
  const mod = await import("webtorrent");
  const Ctor = (mod.default ?? mod) as new (
    opts?: Record<string, unknown>,
  ) => WebTorrentClientLike;
  return new Ctor();
}

/**
 * True when `target` resolves inside `root` (or is `root` itself).
 * A plain string-prefix check is NOT enough here: "/a/b-evil/x"
 * starts with "/a/b" but is a different folder, so a crafted torrent
 * file entry like "../b-evil/x" would pass a prefix guard while
 * escaping the torrent's folder.
 */
export function isPathWithinDir(root: string, target: string): boolean {
  const base = resolve(root);
  const full = resolve(target);
  return full === base || full.startsWith(base + sep);
}

/** Torrent display name from a magnet link's dn parameter, if any. */
export function parseMagnetName(magnet: string): string | null {
  try {
    const parsed = new URL(magnet);
    if (parsed.protocol !== "magnet:") return null;
    const dn = parsed.searchParams.get("dn");
    return dn ? dn.replace(/[\\/:\*\?"<>\|]/g, " ").trim() || null : null;
  } catch {
    return null;
  }
}

export interface TorrentSessionResult {
  status: "completed" | "paused" | "failed";
  destination: string;
  error: string | null;
}

export class TorrentSession {
  readonly sessionId: string;
  private readonly jobId: string;
  private readonly source: string | Buffer;
  private readonly outDir: string;
  private readonly client: WebTorrentClientLike;
  private readonly onProgress: ((progress: DownloadProgress) => void) | undefined;
  private torrent: TorrentLike | null = null;
  private runResolve: ((result: TorrentSessionResult) => void) | null = null;
  private runSettled = false;
  private lastEmit = 0;

  /** App job id, for the manager's progress matching. */
  get appJobId(): string {
    return this.jobId;
  }

  constructor(opts: {
    jobId: string;
    sessionId: string;
    source: string | Buffer;
    outDir: string;
    client: WebTorrentClientLike;
    onProgress?: (progress: DownloadProgress) => void;
  }) {
    this.jobId = opts.jobId;
    this.sessionId = opts.sessionId;
    this.source = opts.source;
    this.outDir = opts.outDir;
    this.client = opts.client;
    this.onProgress = opts.onProgress;
  }

  /**
   * Files this torrent owns (for cancel cleanup), within outDir.
   * Entries whose path escapes outDir (a crafted torrent can list
   * "../" entries — WebTorrent joins them verbatim) are dropped,
   * so cleanup can never delete files outside the torrent's folder.
   */
  filePaths(): string[] {
    if (!this.torrent) return [];
    return this.torrent.files
      .map((file) => join(this.outDir, file.path))
      .filter((file) => isPathWithinDir(this.outDir, file));
  }

  /** Final destination: single file, or the torrent folder. */
  destination(): string {
    if (!this.torrent) return this.outDir;
    const dest =
      this.torrent.files.length === 1
        ? join(this.outDir, this.torrent.files[0]!.path)
        : join(this.outDir, this.torrent.name);
    return isPathWithinDir(this.outDir, dest) ? dest : this.outDir;
  }

  progress(): DownloadProgress {
    const torrent = this.torrent;
    const total = torrent ? torrent.length : null;
    const downloaded = torrent ? torrent.downloaded : 0;
    return {
      jobId: this.jobId,
      status: "downloading",
      downloadedBytes: downloaded,
      totalBytes: total,
      percent: torrent ? torrent.progress : null,
      speedBytesPerSec: torrent ? torrent.downloadSpeed : 0,
      etaSeconds:
        torrent && total && torrent.downloadSpeed > 0
          ? Math.max(0, (total - downloaded) / torrent.downloadSpeed)
          : null,
      segments: [
        {
          start: 0,
          end: Math.max(0, (total ?? 1) - 1),
          downloaded,
          done: torrent ? torrent.progress >= 1 : false,
        },
      ],
      error: null,
    };
  }

  /**
   * Start (or resume) this torrent and wait for this run to end:
   * completed, paused, or failed. A later startRun() re-uses the
   * same torrent object, so partial files keep working.
   */
  startRun(): Promise<TorrentSessionResult> {
    this.runSettled = false;
    const promise = new Promise<TorrentSessionResult>((resolve) => {
      this.runResolve = resolve;
    });
    promise.catch(() => undefined);
    if (this.torrent) {
      try {
        this.torrent.resume();
      } catch {
        // Already resumed or destroyed; the events below still apply.
      }
      return promise;
    }
    try {
      const torrent = this.client.add(this.source, { path: this.outDir }, (ready) => {
        void ready;
      });
      this.torrent = torrent;
      torrent.on("download", () => {
        const now = Date.now();
        if (now - this.lastEmit >= 250) {
          this.lastEmit = now;
          this.onProgress?.(this.progress());
        }
      });
      torrent.on("done", () => this.finish({ status: "completed" }));
      torrent.on("error", (error: unknown) => {
        this.finish({
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      });
      // A crafted torrent can list file paths that escape the download
      // folder (WebTorrent joins them verbatim, so its writes would
      // land outside the folder). Reject such torrents as soon as
      // their metadata is known — "ready" fires for .torrent files and
      // magnets alike, "metadata" covers magnets — and once more right
      // now in case metadata was already present when we attached.
      const validatePaths = () => {
        const current = this.torrent;
        if (!current) return;
        const escapes =
          current.files.some(
            (file) => !isPathWithinDir(this.outDir, join(this.outDir, file.path)),
          ) || !isPathWithinDir(this.outDir, join(this.outDir, current.name));
        if (escapes) {
          void this.destroy().catch(() => undefined);
          this.finish({
            status: "failed",
            error: "Torrent contains file paths outside its download folder and was stopped.",
          });
        }
      };
      torrent.on("ready", validatePaths);
      torrent.on("metadata", validatePaths);
      validatePaths();
    } catch (error) {
      this.finish({
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return promise;
  }

  /** Pause transfers; the torrent and its partial files stay. */
  pause(): void {
    try {
      this.torrent?.pause();
    } catch {
      // Already paused/destroyed.
    }
    this.finish({ status: "paused" });
  }

  /** Destroy the torrent in the client (cancel path). */
  /** Upload/download totals for the seeding policy (0.7.0). */
  seedingStats(): { uploadedBytes: number; downloadedBytes: number } | null {
    const torrent = this.torrent;
    if (!torrent) return null;
    return {
      uploadedBytes: torrent.uploaded ?? 0,
      downloadedBytes: torrent.downloaded ?? 0,
    };
  }

  async destroy(): Promise<void> {
    const torrent = this.torrent;
    this.torrent = null;
    if (!torrent) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      try {
        const returned = torrent.destroy(finish) as unknown;
        if (returned && typeof (returned as { then?: unknown }).then === "function") {
          (returned as Promise<void>).then(finish, finish);
        }
      } catch {
        finish();
      }
    });
  }

  private finish(partial: { status: TorrentSessionResult["status"]; error?: string | null }): void {
    if (this.runSettled || !this.runResolve) return;
    this.runSettled = true;
    const resolve = this.runResolve;
    this.runResolve = null;
    resolve({
      status: partial.status,
      destination: this.destination(),
      error: partial.error ?? null,
    });
  }
}

/** Display name for a torrent source (magnet dn, else URL basename). */
export function torrentDisplayName(source: string): string {
  return parseMagnetName(source) ?? basename(source.split(/[?#]/)[0]!) ?? "Torrent";
}
