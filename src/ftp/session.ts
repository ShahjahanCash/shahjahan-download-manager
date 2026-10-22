/**
 * FTP / FTPS downloads (basic-ftp). Single-stream with resume: the
 * partial file keeps growing across pauses, and a fresh run starts
 * at the partial file's size via REST. Segmented FTP is deliberately
 * not attempted — most FTP servers throttle parallel data channels
 * and resume already covers the interrupted-download case.
 */

import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { rename, stat } from "node:fs/promises";
import { Client } from "basic-ftp";
import type { DownloadProgress } from "../engine/types.js";

export interface FtpTarget {
  host: string;
  port: number;
  username: string;
  password: string;
  remotePath: string;
  secure: boolean;
}

/** Parse ftp:// or ftps:// URLs (credentials may be embedded). */
export function parseFtpUrl(url: string): FtpTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "ftp:" && parsed.protocol !== "ftps:") return null;
  if (!parsed.hostname || !parsed.pathname || parsed.pathname === "/") return null;
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 21,
    username: parsed.username ? decodeURIComponent(parsed.username) : "anonymous",
    password: parsed.password ? decodeURIComponent(parsed.password) : "anonymous@",
    remotePath: decodeURIComponent(parsed.pathname),
    secure: parsed.protocol === "ftps:",
  };
}

export interface FtpSessionResult {
  status: "completed" | "paused" | "failed";
  destination: string;
  error: string | null;
}

export class FtpSession {
  readonly sessionId = randomUUID();
  readonly done: Promise<FtpSessionResult>;

  /** App job id, for the manager's progress matching. */
  get appJobId(): string {
    return this.jobId;
  }
  private readonly jobId: string;
  private readonly url: string;
  private readonly destination: string;
  private readonly partPath: string;
  private readonly onProgress: ((progress: DownloadProgress) => void) | undefined;
  private client: Client | null = null;
  private stream: WriteStream | null = null;
  private stopped = false;
  private totalBytes: number | null = null;
  private downloadedBytes = 0;
  private speedBytesPerSec = 0;
  private lastBytes = 0;
  private lastAt = Date.now();
  private resolveDone!: (result: FtpSessionResult) => void;

  constructor(opts: {
    jobId: string;
    url: string;
    destination: string;
    onProgress?: (progress: DownloadProgress) => void;
  }) {
    this.jobId = opts.jobId;
    this.url = opts.url;
    this.destination = opts.destination;
    this.partPath = `${opts.destination}.part`;
    this.onProgress = opts.onProgress;
    this.done = new Promise<FtpSessionResult>((resolve) => {
      this.resolveDone = resolve;
    });
    this.done.catch(() => undefined);
  }

  start(): void {
    void this.run().then(
      (result) => this.resolveDone(result),
      (error: unknown) => {
        this.resolveDone({
          status: this.stopped ? "paused" : "failed",
          destination: this.destination,
          error: this.stopped ? null : error instanceof Error ? error.message : String(error),
        });
      },
    );
  }

  /** Stop mid-transfer; the .part file stays for resume. */
  pause(): Promise<FtpSessionResult> {
    this.stopped = true;
    try {
      this.client?.close();
    } catch {
      // Already closed.
    }
    return this.done;
  }

  progress(): DownloadProgress {
    const total = this.totalBytes;
    return {
      jobId: this.jobId,
      status: "downloading",
      downloadedBytes: this.downloadedBytes,
      totalBytes: total,
      percent: total ? Math.min(1, this.downloadedBytes / total) : null,
      speedBytesPerSec: this.speedBytesPerSec,
      etaSeconds:
        total && this.speedBytesPerSec > 0
          ? Math.max(0, (total - this.downloadedBytes) / this.speedBytesPerSec)
          : null,
      segments: [
        {
          start: 0,
          end: Math.max(0, (total ?? 1) - 1),
          downloaded: this.downloadedBytes,
          done: false,
        },
      ],
      error: null,
    };
  }

  private async run(): Promise<FtpSessionResult> {
    const target = parseFtpUrl(this.url);
    if (!target) throw new Error(`Not an FTP URL: ${this.url}`);
    let startAt = 0;
    try {
      const existing = await stat(this.partPath);
      startAt = existing.size;
    } catch {
      startAt = 0;
    }
    this.downloadedBytes = startAt;
    this.lastBytes = startAt;
    const client = new Client();
    client.ftp.verbose = false;
    this.client = client;
    try {
      await client.access({
        host: target.host,
        port: target.port,
        user: target.username,
        password: target.password,
        secure: target.secure,
      });
      try {
        this.totalBytes = await client.size(target.remotePath);
      } catch {
        this.totalBytes = null;
      }
      if (this.totalBytes !== null && startAt >= this.totalBytes && this.totalBytes > 0) {
        await rename(this.partPath, this.destination);
        return { status: "completed", destination: this.destination, error: null };
      }
      client.trackProgress((info) => {
        this.downloadedBytes = startAt + info.bytesOverall;
        const now = Date.now();
        const elapsed = Math.max(0.001, (now - this.lastAt) / 1000);
        const instant = (this.downloadedBytes - this.lastBytes) / elapsed;
        this.speedBytesPerSec = this.speedBytesPerSec === 0 ? instant : this.speedBytesPerSec * 0.7 + instant * 0.3;
        this.lastBytes = this.downloadedBytes;
        this.lastAt = now;
        this.onProgress?.(this.progress());
      });
      this.stream = createWriteStream(this.partPath, { flags: startAt > 0 ? "a" : "w" });
      await client.downloadTo(this.stream, target.remotePath, startAt);
      await new Promise<void>((resolve, reject) => {
        this.stream!.on("finish", resolve);
        this.stream!.on("error", reject);
        this.stream!.end();
      });
      this.stream = null;
      if (this.stopped) return { status: "paused", destination: this.destination, error: null };
      await rename(this.partPath, this.destination);
      return { status: "completed", destination: this.destination, error: null };
    } finally {
      try {
        this.stream?.destroy();
      } catch {
        // Ignore.
      }
      this.stream = null;
      client.close();
      if (this.client === client) this.client = null;
    }
  }
}
