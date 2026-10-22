import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { DownloadProgress } from "../engine/types.js";
import { parseDestinationLine, parseYtProgressLine } from "./progress.js";

export interface YoutubeSessionResult {
  status: "completed" | "paused" | "failed";
  destination: string;
  warning: string | null;
  error: string | null;
}

export interface YoutubeSessionOptions {
  /** App job id, carried into progress so the manager can match it. */
  jobId: string;
  ytDlp: string;
  args: string[];
  /** Folder the download lands in (for destination resolution). */
  outDir: string;
  /** Expected filename from --get-filename, when known. */
  expectedFilename: string | null;
  /** Video id in [id] form, used to find the finished file. */
  videoId: string | null;
  onProgress?: (progress: DownloadProgress) => void;
}

function segmentFor(progress: { percent: number; totalBytes: number | null }): DownloadProgress["segments"] {
  const total = progress.totalBytes ?? 0;
  const downloaded = total ? Math.round((progress.percent / 100) * total) : 0;
  return [{ start: 0, end: Math.max(0, total - 1), downloaded, done: progress.percent >= 100 }];
}

/** Find the finished file: expected name first, else newest *[id]* file. */
export async function resolveFinishedFile(
  outDir: string,
  expectedFilename: string | null,
  videoId: string | null,
): Promise<string | null> {
  if (expectedFilename) {
    const candidate = join(outDir, expectedFilename);
    if (existsSync(candidate)) return candidate;
  }
  if (!videoId) return null;
  let entries: { name: string; mtime: number }[] = [];
  try {
    const names = await readdir(outDir, { withFileTypes: true });
    for (const entry of names) {
      if (!entry.isFile() || !entry.name.includes(`[${videoId}]`)) continue;
      const { mtimeMs } = await import("node:fs/promises").then((fs) => fs.stat(join(outDir, entry.name)));
      entries.push({ name: entry.name, mtime: mtimeMs });
    }
  } catch {
    return null;
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  return entries.length ? join(outDir, entries[0]!.name) : null;
}

/**
 * One yt-dlp run. Pause kills the process (yt-dlp keeps .part files,
 * so a fresh run with the same args resumes). The manager creates a
 * new session on resume, mirroring the stream downloader.
 */
export class YoutubeSession {
  readonly jobId: string;
  readonly done: Promise<YoutubeSessionResult>;
  private child: ChildProcess | null = null;
  private killed = false;
  private lastProgress: { percent: number; totalBytes: number | null; speedBytesPerSec: number; etaSeconds: number | null } = {
    percent: 0,
    totalBytes: null,
    speedBytesPerSec: 0,
    etaSeconds: null,
  };
  private destination: string | null = null;
  private stderrTail: string[] = [];
  private resolveDone!: (result: YoutubeSessionResult) => void;

  constructor(private readonly options: YoutubeSessionOptions) {
    this.jobId = options.jobId;
    this.done = new Promise<YoutubeSessionResult>((resolve) => {
      this.resolveDone = resolve;
    });
    this.done.catch(() => undefined);
  }

  start(): void {
    const child = spawn(this.options.ytDlp, this.options.args, {
      windowsHide: true,
    });
    this.child = child;
    let buffer = "";
    const feed = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        this.handleLine(buffer.slice(0, newline).replace(/\r$/, ""));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    };
    child.stdout?.on("data", feed);
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 5) this.stderrTail.shift();
        this.handleLine(line);
      }
    });
    child.on("error", (error) => {
      this.finish({
        status: this.killed ? "paused" : "failed",
        error: this.killed ? null : `Could not run yt-dlp: ${error.message}`,
      });
    });
    child.on("close", async (code) => {
      if (this.killed) {
        this.finish({ status: "paused" });
        return;
      }
      if (code === 0) {
        const found = await resolveFinishedFile(
          this.options.outDir,
          this.options.expectedFilename,
          this.options.videoId,
        );
        this.finish({
          status: "completed",
          destination: found ?? this.destination ?? this.options.outDir,
        });
        return;
      }
      this.finish({
        status: "failed",
        error: this.stderrTail.join(" ").slice(-500) || `yt-dlp exited with code ${code}`,
      });
    });
  }

  pause(): void {
    if (!this.child || this.child.exitCode !== null) return;
    this.killed = true;
    this.child.kill();
  }

  progress(): DownloadProgress {
    const total = this.lastProgress.totalBytes;
    const downloaded = total ? Math.round((this.lastProgress.percent / 100) * total) : 0;
    return {
      jobId: this.jobId,
      status: "downloading",
      downloadedBytes: downloaded,
      totalBytes: total,
      percent: total ? this.lastProgress.percent / 100 : null,
      speedBytesPerSec: this.lastProgress.speedBytesPerSec,
      etaSeconds: this.lastProgress.etaSeconds,
      segments: segmentFor(this.lastProgress),
      error: null,
    };
  }

  private handleLine(line: string): void {
    const parsed = parseYtProgressLine(line);
    if (parsed) {
      this.lastProgress = parsed;
      this.options.onProgress?.(this.progress());
      return;
    }
    const destination = parseDestinationLine(line);
    if (destination) this.destination = destination;
  }

  private finish(partial: Partial<YoutubeSessionResult>): void {
    const result: YoutubeSessionResult = {
      status: partial.status ?? "failed",
      destination: partial.destination ?? this.destination ?? this.options.outDir,
      warning: partial.warning ?? null,
      error: partial.error ?? null,
    };
    this.resolveDone(result);
  }
}

/** Delete a cancelled YouTube job's files (finished file + .part files). */
export async function cleanupYoutubeFiles(outDir: string, videoId: string | null): Promise<void> {
  if (!videoId) return;
  try {
    const names = await readdir(outDir);
    for (const name of names) {
      if (name.includes(`[${videoId}]`)) {
        await unlink(join(outDir, name)).catch(() => undefined);
      }
    }
  } catch {
    // Best effort: a missing folder is already clean.
  }
}
