/**
 * Live HLS capture. The VOD downloader rejects playlists without
 * EXT-X-ENDLIST; this session instead polls the playlist, downloads
 * each new segment as it appears, and appends it to a growing .ts
 * file. Stopping (pause) finalises the capture: ffmpeg remuxes to
 * .mp4 when available, otherwise the .ts file is kept. AES-128
 * segments are decrypted with the same IV rules as the VOD path.
 * Live DASH is still unsupported (dynamic MPD timing is a separate
 * problem) and fails with a clear error at add time.
 */

import { randomUUID, createDecipheriv } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { parseHls } from "./hls.js";
import { ffmpegAvailable, ffmpegCopy } from "./ffmpeg.js";
import { sleep } from "../engine/types.js";
import type { DownloadProgress } from "../engine/types.js";
import type { StreamSegment } from "./types.js";

export interface LiveSessionResult {
  status: "completed" | "paused" | "failed";
  destination: string;
  segmentsDownloaded: number;
  downloadedBytes: number;
  warning: string | null;
  error: string | null;
}

/** Segments in `playlist` whose URLs have not been seen yet. Pure. */
export function newLiveSegments(
  seen: Set<string>,
  playlist: StreamSegment[],
): StreamSegment[] {
  return playlist.filter((segment) => !seen.has(segment.url));
}

export class LiveHlsSession {
  readonly sessionId = randomUUID();
  readonly done: Promise<LiveSessionResult>;

  /** App job id, for the manager's progress matching. */
  get appJobId(): string {
    return this.jobId;
  }
  private readonly jobId: string;
  private readonly url: string;
  private readonly destination: string;
  private readonly headers: Record<string, string>;
  private readonly onProgress: ((progress: DownloadProgress) => void) | undefined;
  private readonly pollMs: number;
  private readonly abortController = new AbortController();
  private readonly seen = new Set<string>();
  private readonly keyCache = new Map<string, Buffer>();
  private readonly segmentSizes: number[] = [];
  private stopping = false;
  private downloadedBytes = 0;
  private segmentsDownloaded = 0;
  private speedBytesPerSec = 0;
  private lastBytes = 0;
  private lastAt = Date.now();
  private resolveDone!: (result: LiveSessionResult) => void;

  constructor(opts: {
    jobId: string;
    url: string;
    destination: string;
    headers?: Record<string, string>;
    pollMs?: number;
    onProgress?: (progress: DownloadProgress) => void;
  }) {
    this.jobId = opts.jobId;
    this.url = opts.url;
    this.destination = opts.destination;
    this.headers = opts.headers ?? {};
    this.pollMs = opts.pollMs ?? 3000;
    this.onProgress = opts.onProgress;
    this.done = new Promise<LiveSessionResult>((resolve) => {
      this.resolveDone = resolve;
    });
    this.done.catch(() => undefined);
  }

  start(): void {
    void this.run().then(
      (result) => this.resolveDone(result),
      (error: unknown) => {
        this.resolveDone({
          status: this.stopping ? "paused" : "failed",
          destination: this.destination,
          segmentsDownloaded: this.segmentsDownloaded,
          downloadedBytes: this.downloadedBytes,
          warning: null,
          error: this.stopping ? null : error instanceof Error ? error.message : String(error),
        });
      },
    );
  }

  /** Stop capturing and finalise the file. Live captures cannot resume. */
  pause(): Promise<LiveSessionResult> {
    this.stopping = true;
    this.abortController.abort();
    return this.done;
  }

  progress(): DownloadProgress {
    const shown = this.segmentSizes.slice(-64);
    return {
      jobId: this.jobId,
      status: "downloading",
      downloadedBytes: this.downloadedBytes,
      totalBytes: null,
      percent: null,
      speedBytesPerSec: this.speedBytesPerSec,
      etaSeconds: null,
      segments: shown.map((size, i) => ({
        start: i,
        end: i,
        downloaded: size,
        done: true,
      })),
      error: null,
    };
  }

  private async fetchText(url: string): Promise<string> {
    const response = await fetch(url, {
      headers: this.headers,
      signal: this.abortController.signal,
    });
    if (!response.ok) throw new Error(`Playlist HTTP ${response.status} for ${url}`);
    return response.text();
  }

  private async decrypt(segment: StreamSegment, encrypted: Buffer): Promise<Buffer> {
    if (!segment.keyUri) return encrypted;
    let key = this.keyCache.get(segment.keyUri);
    if (!key) {
      const response = await fetch(segment.keyUri, {
        headers: this.headers,
        signal: this.abortController.signal,
      });
      if (!response.ok) throw new Error(`Key HTTP ${response.status}`);
      key = Buffer.from(await response.arrayBuffer());
      this.keyCache.set(segment.keyUri, key);
    }
    if (key.length !== 16) throw new Error("AES-128 key must be 16 bytes");
    let iv: Buffer;
    if (segment.keyIv) {
      iv = Buffer.from(segment.keyIv.replace(/^0x/i, "").padStart(32, "0"), "hex");
    } else {
      iv = Buffer.alloc(16);
      iv.writeBigUInt64BE(BigInt(segment.index), 8);
    }
    const decipher = createDecipheriv("aes-128-cbc", key, iv);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }

  private async run(): Promise<LiveSessionResult> {
    await mkdir(dirname(this.destination), { recursive: true });
    const tsPath = this.destination.replace(/(\.[^.]+)$/, "") + ".live.ts";
    const handle = await open(tsPath, "w");
    let initDone = false;
    let consecutiveFailures = 0;
    try {
      while (!this.stopping) {
        let playlistText: string;
        try {
          playlistText = await this.fetchText(this.url);
          consecutiveFailures = 0;
        } catch (error) {
          if (this.stopping) break;
          if (error instanceof Error && error.name === "AbortError") break;
          consecutiveFailures++;
          if (consecutiveFailures >= 10) {
            throw new Error(`Live playlist unreachable after 10 tries: ${error instanceof Error ? error.message : String(error)}`);
          }
          await sleep(this.pollMs);
          continue;
        }
        let playlist = parseHls(playlistText, this.url);
        if (playlist.isMaster) {
          const variant = playlist.variants[0];
          if (!variant) throw new Error("Live master playlist has no variants");
          playlist = parseHls(await this.fetchText(variant.url), variant.url);
        }
        if (!initDone && playlist.initSegmentUrl) {
          const response = await fetch(playlist.initSegmentUrl, {
            headers: this.headers,
            signal: this.abortController.signal,
          });
          if (response.ok) {
            await handle.write(Buffer.from(await response.arrayBuffer()));
            initDone = true;
          }
        }
        const fresh = newLiveSegments(this.seen, playlist.segments);
        for (const segment of fresh) {
          if (this.stopping) break;
          this.seen.add(segment.url);
          const response = await fetch(segment.url, {
            headers: this.headers,
            signal: this.abortController.signal,
          });
          if (!response.ok) continue;
          let bytes: Buffer = Buffer.from(await response.arrayBuffer());
          if (segment.keyUri) bytes = await this.decrypt(segment, bytes);
          await handle.write(Uint8Array.from(bytes));
          this.downloadedBytes += bytes.byteLength;
          this.segmentsDownloaded++;
          this.segmentSizes.push(bytes.byteLength);
          const now = Date.now();
          const elapsed = Math.max(0.001, (now - this.lastAt) / 1000);
          const instant = (this.downloadedBytes - this.lastBytes) / elapsed;
          this.speedBytesPerSec = this.speedBytesPerSec === 0 ? instant : this.speedBytesPerSec * 0.7 + instant * 0.3;
          this.lastBytes = this.downloadedBytes;
          this.lastAt = now;
          this.onProgress?.(this.progress());
        }
        if (playlist.isVod) break;
        await sleep(this.pollMs);
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    if (this.segmentsDownloaded === 0) {
      await rm(tsPath, { force: true }).catch(() => undefined);
      return {
        status: this.stopping ? "paused" : "failed",
        destination: this.destination,
        segmentsDownloaded: 0,
        downloadedBytes: 0,
        warning: null,
        error: this.stopping ? "Live capture stopped before any segment arrived." : "No live segments arrived.",
      };
    }
    // Finalise: prefer .mp4 via ffmpeg, else keep the .ts capture.
    if (this.destination.endsWith(".mp4") && (await ffmpegAvailable())) {
      if (await ffmpegCopy([tsPath], this.destination)) {
        await rm(tsPath, { force: true }).catch(() => undefined);
        return {
          status: "completed",
          destination: this.destination,
          segmentsDownloaded: this.segmentsDownloaded,
          downloadedBytes: this.downloadedBytes,
          warning: null,
          error: null,
        };
      }
    }
    const tsDest = existsSync(this.destination) ? this.destination : tsPath;
    if (tsDest !== tsPath) await rename(tsPath, tsDest).catch(() => undefined);
    return {
      status: "completed",
      destination: tsDest,
      segmentsDownloaded: this.segmentsDownloaded,
      downloadedBytes: this.downloadedBytes,
      warning: "ffmpeg remux to MP4 failed or ffmpeg is not installed; live capture saved as MPEG-TS.",
      error: null,
    };
  }
}
