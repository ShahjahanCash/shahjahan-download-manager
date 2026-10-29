import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { categorize, filenameFromUrl } from "../engine/categories.js";
import { computeHash, hashMatches } from "../engine/checksum.js";
import { applyProxy, parseProxyUrl } from "../engine/proxy.js";
import { FtpSession, parseFtpUrl } from "../ftp/session.js";
import { LiveHlsSession } from "../stream/live.js";
import {
  TorrentSession,
  createWebTorrentClient,
  isPathWithinDir,
  parseMagnetName,
  torrentDisplayName,
  type WebTorrentClientLike,
} from "../torrent/session.js";
import { isRetryableError, retryDelayMs } from "./retry.js";
import { shouldRunNow, type SchedulerPolicy } from "./scheduler.js";
import type { SmartLimitConfig } from "./smartLimit.js";
import { archiveKind, extractCommand, extractOutDir } from "./extract.js";
import { defenderCommand, parseDefenderOutput, type ScanResult } from "./defender.js";
import { localDay, StatsStore } from "./stats.js";
import { shouldStopSeeding, type SeedingPolicy } from "../torrent/trackers.js";
import {
  parseQueueFile,
  serializeJob,
  type SavedQueueDef,
} from "./persist.js";
import {
  resumeDownload,
  startDownload,
  type DownloadSession,
} from "../engine/downloader.js";
import { probe } from "../engine/probe.js";
import {
  downloadStream,
  resumeStream,
  type StreamSession,
} from "../stream/downloader.js";
import type {
  DownloadCategory,
  DownloadProgress,
  DownloadStatus,
} from "../engine/types.js";
import type { ToolPaths } from "../yt/locate.js";
import { buildYtDlpArgs, outputTemplateFor, type YoutubeOptions } from "../yt/options.js";
import {
  cleanupYoutubeFiles,
  YoutubeSession,
} from "../yt/session.js";

export interface AppJob {
  id: string;
  url: string;
  filename: string;
  category: DownloadCategory;
  destination: string;
  partPath: string;
  status: DownloadStatus;
  progress: DownloadProgress | null;
  error: string | null;
  createdAt: string;
  /** Per-download choices from the New Task form (B1 fix: these were
   * accepted by add() but silently ignored — pump always used the
   * manager defaults, so Segments/Speed limit in the UI did nothing). */
  segments?: number;
  speedLimitBytesPerSec?: number;
  /** YouTube job (yt-dlp) — separate from Range-segment jobs. */
  isYoutube?: boolean;
  youtubeOptions?: YoutubeOptions;
  youtubeOutDir?: string;
  youtubeVideoId?: string | null;
  /** Exact yt-dlp command line for this job (0.7.2 transparency: the
   * details dialog shows it). Runtime-only, never persisted. */
  ytCommand?: string;
  /** In-memory only, never persisted: forwarded by the browser extension. */
  headers?: Record<string, string>;
  isStream?: boolean;
  variantUrl?: string;
  representationId?: string;
  warning?: string | null;
  /** Multiple queues (feature 4): which queue this job belongs to. */
  queueId?: string;
  /** FTP job (feature 9). */
  isFtp?: boolean;
  /** Torrent job (feature 12): url holds the magnet link or .torrent URL. */
  isTorrent?: boolean;
  /** Folder the torrent downloads into (resume path). */
  torrentOutDir?: string;
  /** Live HLS capture (feature 15): pause finalises, never resumes. */
  isLiveStream?: boolean;
  /** Expected SHA-256 for post-download verification (feature 10). */
  expectedHash?: string;
  /** SHA-256 computed after completion (feature 10). */
  sha256?: string;
  checksumStatus?: "pass" | "mismatch" | null;
  /** Auto-retry bookkeeping (feature 12). */
  retryCount?: number;
  /** 0.7.0: mirror URLs for the same file (tried when primary fails). */
  mirrorUrls?: string[];
  /** 0.7.0: auto-extract outcome ("done", "skipped: …", error text). */
  extractStatus?: string | null;
  /** 0.7.0: Windows Defender scan result for the finished file. */
  scanStatus?: ScanResult | null;
  /** 0.7.0: torrent still seeding after completion. */
  seeding?: boolean;
  /** 0.7.0: when seeding started (ISO), for the seeding policy cap. */
  seedStartedAt?: string | null;
}

export interface ManagerOptions {
  downloadsDir?: string;
  maxConcurrent?: number;
  segments?: number;
  speedLimitBytesPerSec?: number;
  onProgress?: (progress: DownloadProgress) => void;
  onJobsChanged?: (jobs: AppJob[]) => void;
  /** Resolves yt-dlp/ffmpeg locations (main supplies Electron paths). */
  youtubeTools?: () => Promise<ToolPaths>;
  /** Persistent queue file (feature 1); unset = in-memory only. */
  queuePath?: string;
  /** Per-category folder overrides (feature 11). */
  categoryFolders?: Partial<Record<DownloadCategory, string>>;
  /** HTTP(S) proxy URL (feature 8); applied to fetch + yt-dlp. */
  proxyUrl?: string;
  /** Auto-retry (feature 12): attempts after the first failure. */
  retryAttempts?: number;
  /** Auto-retry base delay in seconds (doubles each attempt). */
  retryDelayBaseSec?: number;
  /** Fired once when every job is completed/failed (feature 3). */
  onQueueDrained?: () => void;
}

export interface QueueDef {
  id: string;
  name: string;
  maxConcurrent: number;
  /** Queue speed cap in bytes/s (0 = no cap; caps each job's limit). */
  speedLimitBytesPerSec?: number;
}

function uniquePath(path: string): string {
  if (!existsSync(path) && !existsSync(`${path}.part`)) return path;
  const dot = path.lastIndexOf(".");
  const base = dot > 0 ? path.slice(0, dot) : path;
  const ext = dot > 0 ? path.slice(dot) : "";
  let n = 1;
  while (existsSync(`${base} (${n})${ext}`)) n++;
  return `${base} (${n})${ext}`;
}

/**
 * Headless download manager: the Electron main process is a thin IPC
 * shell over this class, so the queue, pause/resume and progress logic
 * stays unit-testable without a GUI.
 */
/** Render a program + args as one pastable command line (0.7.2). */
export function quoteCommandLine(program: string, args: string[]): string {
  const quote = (a: string) =>
    /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
  return [program, ...args.map(quote)].join(" ");
}

export class AppDownloadManager {
  private downloadsDir: string;
  private maxConcurrent: number;
  private readonly segments: number;
  private readonly speedLimit: number;
  private readonly onProgress?: ManagerOptions["onProgress"];
  private readonly onJobsChanged?: ManagerOptions["onJobsChanged"];
  private readonly youtubeTools?: ManagerOptions["youtubeTools"];
  private readonly queuePath: string | undefined;
  private categoryFolders: Partial<Record<DownloadCategory, string>>;
  private proxyUrl: string | null;
  private retryAttempts: number;
  private retryDelayBaseSec: number;
  private readonly onQueueDrained?: ManagerOptions["onQueueDrained"];
  private jobs = new Map<string, AppJob>();
  private pending: string[] = [];
  private sessions = new Map<string, DownloadSession>();
  private streamSessions = new Map<string, StreamSession>();
  private ytSessions = new Map<string, YoutubeSession>();
  private ftpSessions = new Map<string, FtpSession>();
  private liveSessions = new Map<string, LiveHlsSession>();
  private torrentSessions = new Map<string, TorrentSession>();
  private torrentClient: WebTorrentClientLike | null = null;
  private queues = new Map<string, QueueDef>();
  private retryTimers = new Map<string, NodeJS.Timeout>();
  private drainNotified = false;

  /** Torrent sessions stay registered while paused (resume re-uses
   * them), so only downloading ones count as active slots. */
  private torrentActiveCount(queueId?: string): number {
    let count = 0;
    for (const id of this.torrentSessions.keys()) {
      const job = this.jobs.get(id);
      if (!job || job.status !== "downloading") continue;
      if (queueId !== undefined && job.queueId !== queueId) continue;
      count++;
    }
    return count;
  }

  private activeCount(): number {
    return (
      this.sessions.size +
      this.streamSessions.size +
      this.ytSessions.size +
      this.ftpSessions.size +
      this.liveSessions.size +
      this.torrentActiveCount()
    );
  }

  /** Active downloads in one queue (for per-queue concurrency). */
  private queueActiveCount(queueId: string): number {
    let count = 0;
    const tally = (map: Map<string, unknown>) => {
      for (const id of map.keys()) {
        if (this.jobs.get(id)?.queueId === queueId) count++;
      }
    };
    tally(this.sessions);
    tally(this.streamSessions);
    tally(this.ytSessions);
    tally(this.ftpSessions);
    tally(this.liveSessions);
    return count + this.torrentActiveCount(queueId);
  }

  /** Effective speed limit for a job: a queue cap, when set, caps
   * the job's own limit (a per-download limit still wins below it). */
  private effectiveSpeedLimit(job: AppJob): number {
    const queue = this.queues.get(job.queueId ?? "main");
    const queueLimit = queue?.speedLimitBytesPerSec ?? 0;
    const jobLimit = job.speedLimitBytesPerSec ?? this.speedLimit;
    let limit: number;
    if (queueLimit > 0 && jobLimit > 0) limit = Math.min(jobLimit, queueLimit);
    else if (queueLimit > 0) limit = queueLimit;
    else limit = jobLimit;
    // Smart limit (0.7.0): a watched process caps new jobs; a 0 smart
    // limit is handled by the pump gate, not here (0 = unlimited).
    if (this.smartActive && this.smartConfig.enabled && this.smartConfig.smartLimitBytesPerSec > 0) {
      limit = limit === 0 ? this.smartConfig.smartLimitBytesPerSec : Math.min(limit, this.smartConfig.smartLimitBytesPerSec);
    }
    return limit;
  }

  constructor(options: ManagerOptions = {}) {
    this.downloadsDir = options.downloadsDir ?? "downloads";
    this.maxConcurrent = options.maxConcurrent ?? 3;
    this.segments = options.segments ?? 8;
    this.speedLimit = options.speedLimitBytesPerSec ?? 0;
    this.onProgress = options.onProgress;
    this.onJobsChanged = options.onJobsChanged;
    this.youtubeTools = options.youtubeTools;
    this.queuePath = options.queuePath;
    this.categoryFolders = { ...(options.categoryFolders ?? {}) };
    this.proxyUrl = options.proxyUrl ? parseProxyUrl(options.proxyUrl) : null;
    if (this.proxyUrl) applyProxy(this.proxyUrl);
    this.retryAttempts = options.retryAttempts ?? 3;
    this.retryDelayBaseSec = options.retryDelayBaseSec ?? 10;
    this.onQueueDrained = options.onQueueDrained;
    this.statsStore = new StatsStore(
      options.queuePath ? join(dirname(options.queuePath), "stats.json") : null,
    );
    this.queues.set("main", { id: "main", name: "Main Queue", maxConcurrent: this.maxConcurrent });
  }

  // ---- 0.7.0 settings (set from main's set-settings; persisted there) ----
  private schedulerPolicy: SchedulerPolicy = { enabled: false, windows: [] };
  private readonly schedulerPaused = new Set<string>();
  private smartConfig: SmartLimitConfig = { enabled: false, smartLimitBytesPerSec: 0, watchlist: [] };
  private smartActive = false;
  private autoExtract = false;
  private defenderScan = false;
  private seedingPolicy: SeedingPolicy = { enabled: false, ratioLimit: 0, maxMinutes: 0 };
  private readonly statsStore: StatsStore;
  private readonly jobStartedAt = new Map<string, number>();

  setSchedulerPolicy(policy: SchedulerPolicy): void {
    this.schedulerPolicy = policy;
    this.applySchedulerTick();
  }
  setSmartConfig(config: SmartLimitConfig): void {
    this.smartConfig = config;
  }
  /** Main polls tasklist and reports whether a watched process runs. */
  setSmartActive(active: boolean): void {
    this.smartActive = active;
  }
  getSmartState(): { active: boolean; enabled: boolean } {
    return { active: this.smartActive, enabled: this.smartConfig.enabled };
  }
  setAutoExtract(enabled: boolean): void {
    this.autoExtract = enabled;
  }
  setDefenderScan(enabled: boolean): void {
    this.defenderScan = enabled;
  }
  setSeedingPolicy(policy: SeedingPolicy): void {
    this.seedingPolicy = policy;
  }
  async getStats(): Promise<ReturnType<StatsStore["summary"]>> {
    await this.statsStore.load();
    return this.statsStore.summary();
  }
  /** Stop seeding one torrent (renderer button); destroys the session. */
  async stopSeeding(id: string): Promise<boolean> {
    const session = this.torrentSessions.get(id);
    const job = this.jobs.get(id);
    if (!session || !job || !job.seeding) return false;
    await session.destroy().catch(() => undefined);
    this.torrentSessions.delete(id);
    job.seeding = false;
    this.emitJobs();
    return true;
  }
  /** Periodic policy check: stop seeding jobs past ratio/time caps. */
  async checkSeeding(): Promise<void> {
    for (const job of [...this.jobs.values()]) {
      if (!job.seeding || !job.seedStartedAt) continue;
      const session = this.torrentSessions.get(job.id);
      const stats = session?.seedingStats();
      if (!stats) continue;
      const seededMs = Date.now() - new Date(job.seedStartedAt).getTime();
      if (shouldStopSeeding(this.seedingPolicy, stats.uploadedBytes, stats.downloadedBytes, seededMs)) {
        await this.stopSeeding(job.id);
      }
    }
  }

  /**
   * Scheduler tick (0.7.0): outside a window, pause running/queued
   * jobs and remember them; when a window opens, resume exactly those
   * jobs. Manual pauses are never auto-resumed (they're not in the set).
   */
  applySchedulerTick(now = new Date()): void {
    if (!this.schedulerPolicy.enabled) {
      if (this.schedulerPaused.size) {
        const ids = [...this.schedulerPaused];
        this.schedulerPaused.clear();
        for (const id of ids) void this.resume(id);
      }
      return;
    }
    if (shouldRunNow(this.schedulerPolicy, now)) {
      if (this.schedulerPaused.size) {
        const ids = [...this.schedulerPaused];
        this.schedulerPaused.clear();
        for (const id of ids) {
          const job = this.jobs.get(id);
          if (job && job.status === "paused") void this.resume(id);
        }
      }
      return;
    }
    for (const job of this.jobs.values()) {
      if (
        (job.status === "downloading" || job.status === "queued") &&
        !this.schedulerPaused.has(job.id)
      ) {
        this.schedulerPaused.add(job.id);
        void this.pause(job.id);
      }
    }
  }

  /** Post-download pipeline (0.7.0): stats, extract, Defender scan. */
  private async postDownload(job: AppJob): Promise<void> {
    const startedAt = this.jobStartedAt.get(job.id);
    const bytes = job.progress?.downloadedBytes ?? job.progress?.totalBytes ?? 0;
    await this.statsStore.record({
      day: localDay(),
      bytes,
      durationMs: startedAt ? Math.max(0, Date.now() - startedAt) : 0,
      jobId: job.id,
    });
    if (this.autoExtract && !job.isTorrent && archiveKind(job.filename)) {
      if (process.platform !== "win32") {
        job.extractStatus = "skipped: Windows only";
      } else {
        const cmd = extractCommand(
          job.destination,
          extractOutDir(job.destination),
          { has7Zip: archiveKind(job.filename) !== "rar" },
        );
        if (!cmd) {
          job.extractStatus = "skipped: install 7-Zip for RAR extraction";
        } else {
          try {
            const { execFile } = await import("node:child_process");
            const { mkdir } = await import("node:fs/promises");
            await mkdir(extractOutDir(job.destination), { recursive: true });
            await new Promise<void>((resolve, reject) => {
              execFile(cmd.command, cmd.args, { windowsHide: true }, (error) => {
                if (error) reject(error);
                else resolve();
              });
            });
            job.extractStatus = "done";
          } catch (error) {
            job.extractStatus = `failed: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
      }
      this.emitJobs();
    }
    if (this.defenderScan && !job.isTorrent) {
      if (process.platform !== "win32") {
        job.scanStatus = "unknown";
      } else {
        try {
          const { execFile } = await import("node:child_process");
          const { join: joinPath } = await import("node:path");
          const defenderDir = process.env.ProgramFiles
            ? joinPath(process.env.ProgramFiles, "Windows Defender")
            : undefined;
          const cmd = defenderCommand(job.destination, defenderDir);
          const { code, stdout } = await new Promise<{ code: number | null; stdout: string }>(
            (resolve) => {
              execFile(cmd.command, cmd.args, { windowsHide: true }, (error, stdoutText) => {
                resolve({ code: error ? (error as { code?: number }).code ?? null : 0, stdout: stdoutText });
              });
            },
          );
          job.scanStatus = parseDefenderOutput(code, stdout);
        } catch {
          job.scanStatus = "error";
        }
      }
      this.emitJobs();
    }
  }

  /** Settings the UI can change at runtime (persisted by main). */
  getSettings(): {
    downloadsDir: string;
    maxConcurrent: number;
    categoryFolders: Partial<Record<DownloadCategory, string>>;
    proxyUrl: string | null;
    retryAttempts: number;
    retryDelayBaseSec: number;
    schedulerPolicy: SchedulerPolicy;
    smartConfig: SmartLimitConfig;
    autoExtract: boolean;
    defenderScan: boolean;
    seedingPolicy: SeedingPolicy;
  } {
    return {
      downloadsDir: this.downloadsDir,
      maxConcurrent: this.maxConcurrent,
      categoryFolders: { ...this.categoryFolders },
      proxyUrl: this.proxyUrl,
      retryAttempts: this.retryAttempts,
      retryDelayBaseSec: this.retryDelayBaseSec,
      schedulerPolicy: this.schedulerPolicy,
      smartConfig: this.smartConfig,
      autoExtract: this.autoExtract,
      defenderScan: this.defenderScan,
      seedingPolicy: this.seedingPolicy,
    };
  }

  /** Folder for a category: override wins, else downloads/<Category>. */
  private outDirFor(category: DownloadCategory): string {
    const override = this.categoryFolders[category]?.trim();
    return override ? override : join(this.downloadsDir, category);
  }

  setCategoryFolders(folders: Partial<Record<DownloadCategory, string>>): void {
    this.categoryFolders = { ...folders };
  }

  setProxy(proxyUrl: string | null): void {
    this.proxyUrl = proxyUrl ? parseProxyUrl(proxyUrl) : null;
    applyProxy(this.proxyUrl);
  }

  setRetryConfig(attempts: number, delayBaseSec: number): void {
    this.retryAttempts = Math.max(0, Math.min(10, Math.floor(attempts)));
    this.retryDelayBaseSec = Math.max(1, Math.min(300, Math.floor(delayBaseSec)));
  }

  /* ---- Multiple queues (feature 4) ---- */

  listQueues(): QueueDef[] {
    return [...this.queues.values()];
  }

  createQueue(name: string): QueueDef {
    const clean = name.trim().slice(0, 40) || "Queue";
    const def: QueueDef = { id: randomUUID(), name: clean, maxConcurrent: this.maxConcurrent };
    this.queues.set(def.id, def);
    this.saveQueue().catch(() => undefined);
    this.emitJobs();
    return def;
  }

  renameQueue(id: string, name: string): boolean {
    const queue = this.queues.get(id);
    if (!queue || id === "main") return false;
    queue.name = name.trim().slice(0, 40) || queue.name;
    this.saveQueue().catch(() => undefined);
    this.emitJobs();
    return true;
  }

  deleteQueue(id: string): boolean {
    if (id === "main" || !this.queues.has(id)) return false;
    if ([...this.jobs.values()].some((job) => job.queueId === id)) return false;
    this.queues.delete(id);
    this.saveQueue().catch(() => undefined);
    this.emitJobs();
    return true;
  }

  moveToQueue(jobId: string, queueId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || !this.queues.has(queueId)) return false;
    job.queueId = queueId;
    this.saveQueue().catch(() => undefined);
    this.emitJobs();
    void this.pump();
    return true;
  }

  /** Per-queue speed cap (feature 11). 0 = no cap. */
  setQueueSpeedLimit(queueId: string, bytesPerSec: number): boolean {
    const queue = this.queues.get(queueId);
    if (!queue) return false;
    const value = Math.max(0, Math.floor(bytesPerSec));
    if (value > 0) queue.speedLimitBytesPerSec = value;
    else delete queue.speedLimitBytesPerSec;
    this.saveQueue().catch(() => undefined);
    this.emitJobs();
    return true;
  }

  /* ---- Persistent queue (feature 1) ---- */

  /** Serialises saveQueue calls: concurrent saves used to share one
   * tmp path, so an older write could rename over a newer one and
   * lose the latest state (flaky queue-limit test). */
  private saveChain: Promise<void> = Promise.resolve();

  async saveQueue(): Promise<void> {
    if (!this.queuePath) return;
    const run = this.saveChain.then(() => this.writeQueueFile());
    this.saveChain = run.catch(() => undefined);
    return run;
  }

  private async writeQueueFile(): Promise<void> {
    if (!this.queuePath) return;
    const file = {
      version: 1 as const,
      queues: this.listQueues().map((queue) => ({ ...queue })),
      jobs: this.list().map((job) => serializeJob(job)),
    };
    try {
      await mkdir(dirname(this.queuePath), { recursive: true });
      const tmp = `${this.queuePath}.tmp`;
      await writeFile(tmp, JSON.stringify(file, null, 2), "utf8");
      await rename(tmp, this.queuePath);
    } catch {
      // Queue persistence must never break downloads.
    }
  }

  async restoreQueue(): Promise<number> {
    if (!this.queuePath) return 0;
    let parsed: ReturnType<typeof parseQueueFile>;
    try {
      parsed = parseQueueFile(await readFile(this.queuePath, "utf8"));
    } catch {
      return 0;
    }
    if (!parsed) return 0;
    for (const saved of parsed.queues) {
      if (saved.id && saved.name) {
        this.queues.set(saved.id, {
          id: saved.id,
          name: saved.name,
          maxConcurrent: Math.max(1, saved.maxConcurrent || this.maxConcurrent),
          ...(saved.speedLimitBytesPerSec ? { speedLimitBytesPerSec: saved.speedLimitBytesPerSec } : {}),
        });
      }
    }
    if (!this.queues.has("main")) {
      this.queues.set("main", { id: "main", name: "Main Queue", maxConcurrent: this.maxConcurrent });
    }
    let restored = 0;
    for (const saved of parsed.jobs) {
      if (this.jobs.has(saved.id)) continue;
      const status: AppJob["status"] =
        saved.status === "completed" || saved.status === "failed" || saved.status === "paused"
          ? saved.status
          : "paused";
      const job: AppJob = {
        id: saved.id,
        url: saved.url,
        filename: saved.filename,
        category: saved.category,
        destination: saved.destination,
        partPath: saved.partPath,
        status,
        ...(saved.isTorrent ? { isTorrent: true } : {}),
        ...(saved.torrentOutDir ? { torrentOutDir: saved.torrentOutDir } : {}),
        progress: null,
        error: null,
        createdAt: saved.createdAt,
        ...(saved.segments !== undefined ? { segments: saved.segments } : {}),
        ...(saved.speedLimitBytesPerSec !== undefined ? { speedLimitBytesPerSec: saved.speedLimitBytesPerSec } : {}),
        ...(saved.isYoutube ? { isYoutube: true } : {}),
        ...(saved.youtubeOptions ? { youtubeOptions: saved.youtubeOptions } : {}),
        ...(saved.youtubeOutDir ? { youtubeOutDir: saved.youtubeOutDir } : {}),
        ...(saved.youtubeVideoId !== undefined ? { youtubeVideoId: saved.youtubeVideoId } : {}),
        ...(saved.isStream ? { isStream: true } : {}),
        ...(saved.variantUrl ? { variantUrl: saved.variantUrl } : {}),
        ...(saved.representationId ? { representationId: saved.representationId } : {}),
        ...(saved.isFtp ? { isFtp: true } : {}),
        ...(saved.isLiveStream ? { isLiveStream: true } : {}),
        queueId: saved.queueId && this.queues.has(saved.queueId) ? saved.queueId : "main",
        ...(saved.expectedHash ? { expectedHash: saved.expectedHash } : {}),
        ...(saved.sha256 ? { sha256: saved.sha256 } : {}),
        ...(saved.checksumStatus ? { checksumStatus: saved.checksumStatus } : {}),
        ...(saved.mirrorUrls?.length ? { mirrorUrls: saved.mirrorUrls } : {}),
        ...(saved.extractStatus ? { extractStatus: saved.extractStatus } : {}),
        ...(saved.scanStatus ? { scanStatus: saved.scanStatus } : {}),
        retryCount: 0,
      };
      this.jobs.set(job.id, job);
      restored++;
    }
    // Restore is read-only: notify listeners directly instead of
    // emitJobs(), whose saveQueue() side effect raced with teardown
    // (fire-and-forget writes landing during directory cleanup).
    this.onJobsChanged?.(this.list());
    return restored;
  }

  /* ---- Auto-retry (feature 12) + drain (feature 3) helpers ---- */

  private clearRetry(id: string): void {
    const timer = this.retryTimers.get(id);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(id);
  }

  /**
   * Schedule a retry when the failure looks transient. Returns true
   * when a retry was scheduled (caller must NOT mark failed).
   */
  private maybeRetry(job: AppJob, errorMessage: string): boolean {
    const attempts = job.retryCount ?? 0;
    if (attempts >= this.retryAttempts || !isRetryableError(errorMessage)) return false;
    job.retryCount = attempts + 1;
    job.status = "retrying";
    job.error = `Retry ${job.retryCount}/${this.retryAttempts} in ${Math.round(retryDelayMs(job.retryCount, this.retryDelayBaseSec) / 1000)}s: ${errorMessage}`;
    const delay = retryDelayMs(job.retryCount, this.retryDelayBaseSec);
    this.clearRetry(job.id);
    const timer = setTimeout(() => {
      this.retryTimers.delete(job.id);
      const current = this.jobs.get(job.id);
      if (!current || current.status !== "retrying") return;
      current.status = "queued";
      current.error = null;
      this.pending.push(current.id);
      this.emitJobs();
      void this.pump();
    }, delay);
    this.retryTimers.set(job.id, timer);
    this.emitJobs();
    return true;
  }

  /** Fire onQueueDrained once when nothing is left unfinished. */
  private checkDrained(): void {
    if (this.drainNotified || this.jobs.size === 0) return;
    const unfinished = [...this.jobs.values()].some(
      (job) => job.status !== "completed" && job.status !== "failed",
    );
    if (unfinished) return;
    this.drainNotified = true;
    this.onQueueDrained?.();
  }

  /** Verify a finished file's SHA-256 (feature 10). Never throws. */
  private async verifyChecksum(job: AppJob): Promise<void> {
    try {
      const hash = await computeHash(job.destination, "sha256");
      const current = this.jobs.get(job.id);
      if (!current) return;
      current.sha256 = hash;
      if (current.expectedHash) {
        current.checksumStatus = hashMatches(current.expectedHash, hash) ? "pass" : "mismatch";
        if (current.checksumStatus === "mismatch") {
          current.warning = "Checksum mismatch: the downloaded file does not match the expected SHA-256.";
        }
      }
      this.emitJobs();
      void this.saveQueue();
    } catch {
      // Hashing failure is informational only.
    }
  }

  setMaxConcurrent(n: number): void {
    const floored = Math.floor(n);
    const value = Number.isFinite(floored) ? Math.max(1, Math.min(10, floored)) : 3;
    this.maxConcurrent = value;
    void this.pump();
  }

  setDownloadsDir(dir: string): void {
    const value = dir.trim();
    if (value) this.downloadsDir = value;
  }

  list(): AppJob[] {
    return [...this.jobs.values()].map((job) => ({
      ...job,
      progress: job.progress
        ? { ...job.progress, segments: [...job.progress.segments] }
        : null,
    }));
  }

  get(id: string): AppJob | undefined {
    return this.jobs.get(id);
  }

  async add(
    url: string,
    opts: {
      destination?: string;
      segments?: number;
      speedLimitBytesPerSec?: number;
      headers?: Record<string, string>;
      /** Behance-style New Task category picker: overrides auto-detect. */
      category?: DownloadCategory;
      queueId?: string;
      expectedHash?: string;
      /** 0.7.0: mirror URLs for the same file. */
      mirrorUrls?: string[];
    } = {},
  ): Promise<AppJob> {
    // FTP (feature 9) skips the HTTP probe entirely.
    const ftpTarget = parseFtpUrl(url);
    let filename: string;
    let category: DownloadCategory;
    if (ftpTarget) {
      filename = filenameFromUrl(url);
      category = opts.category ?? categorize(filename, null);
    } else {
      const info = await probe(url);
      filename = info.filename ?? filenameFromUrl(url);
      category = opts.category
        ?? categorize(
          opts.destination ? basename(opts.destination) : filename,
          info.contentType,
        );
    }
    const destination = opts.destination
      ? opts.destination
      : uniquePath(join(this.outDirFor(category), filename));
    // No mkdir here: the engine creates dirname(partPath) on start.
    const job: AppJob = {
      id: randomUUID(),
      url,
      filename: basename(destination),
      category,
      destination,
      partPath: `${destination}.part`,
      status: "queued",
      progress: null,
      error: null,
      createdAt: new Date().toISOString(),
      segments: opts.segments ?? this.segments,
      speedLimitBytesPerSec: opts.speedLimitBytesPerSec ?? this.speedLimit,
      ...(opts.headers ? { headers: opts.headers } : {}),
      queueId: opts.queueId && this.queues.has(opts.queueId) ? opts.queueId : "main",
      ...(opts.expectedHash ? { expectedHash: opts.expectedHash } : {}),
      ...(opts.mirrorUrls?.length ? { mirrorUrls: opts.mirrorUrls } : {}),
      ...(ftpTarget ? { isFtp: true } : {}),
      retryCount: 0,
    };
    this.jobs.set(job.id, job);
    this.pending.push(job.id);
    this.emitJobs();
    void this.pump();
    return job;
  }

  /** YouTube download via yt-dlp. The UI fetches info first and passes
   * the title/video id; the manager only runs yt-dlp and tracks it. */
  async addYoutube(
    url: string,
    opts: {
      options: YoutubeOptions;
      title?: string;
      videoId?: string | null;
      queueId?: string;
    },
  ): Promise<AppJob> {
    const kind = opts.options.kind;
    const category: DownloadCategory = kind === "audio" ? "Audio" : "Video";
    const clean = (opts.title ?? "YouTube video")
      .replace(/[\\/:\*\?"<>\|\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || "YouTube video";
    const outDir = this.outDirFor(category);
    const job: AppJob = {
      id: randomUUID(),
      url,
      filename: clean,
      category,
      destination: join(outDir, clean),
      partPath: join(outDir, `${clean}.ytpart`),
      status: "queued",
      progress: null,
      error: null,
      createdAt: new Date().toISOString(),
      isYoutube: true,
      youtubeOptions: opts.options,
      youtubeOutDir: outDir,
      youtubeVideoId: opts.videoId ?? null,
      queueId: opts.queueId && this.queues.has(opts.queueId) ? opts.queueId : "main",
      retryCount: 0,
    };
    this.jobs.set(job.id, job);
    this.pending.push(job.id);
    this.emitJobs();
    void this.pump();
    return job;
  }

  /** Stream (HLS/DASH) download: segments are assembled, not Range-split. */
  async addStream(
    url: string,
    opts: {
      destination?: string;
      variantUrl?: string;
      representationId?: string;
      headers?: Record<string, string>;
      /** Live HLS capture (feature 15): poll until stopped. */
      live?: boolean;
      queueId?: string;
    } = {},
  ): Promise<AppJob> {
    const rawName = opts.destination ? basename(opts.destination) : filenameFromUrl(url);
    const filename = rawName.replace(/\.(m3u8|mpd)$/i, ".mp4");
    const destination = opts.destination
      ? opts.destination.replace(/\.(m3u8|mpd)$/i, ".mp4")
      : uniquePath(join(this.outDirFor("Video"), filename));
    const job: AppJob = {
      id: randomUUID(),
      url,
      filename: basename(destination),
      category: "Video",
      destination,
      partPath: `${destination}.stream-parts`,
      status: "queued",
      progress: null,
      error: null,
      createdAt: new Date().toISOString(),
      ...(opts.headers ? { headers: opts.headers } : {}),
      isStream: true,
      ...(opts.variantUrl ? { variantUrl: opts.variantUrl } : {}),
      ...(opts.representationId ? { representationId: opts.representationId } : {}),
      ...(opts.live ? { isLiveStream: true } : {}),
      queueId: opts.queueId && this.queues.has(opts.queueId) ? opts.queueId : "main",
      retryCount: 0,
    };
    this.jobs.set(job.id, job);
    this.pending.push(job.id);
    this.emitJobs();
    void this.pump();
    return job;
  }

  /** Torrent / magnet download (feature 12). A .torrent URL is
   * fetched first; a magnet link is used as-is. Files land in the
   * General folder (or its per-category override). */
  async addTorrent(
    url: string,
    opts: { queueId?: string } = {},
  ): Promise<AppJob> {
    let source: string | Buffer = url;
    let filename = torrentDisplayName(url);
    if (!url.startsWith("magnet:")) {
      // 0.7.0: a local .torrent path from the Explorer context menu.
      if (existsSync(url) && url.toLowerCase().endsWith(".torrent")) {
        source = await readFile(url);
        filename = basename(url).replace(/\.torrent$/i, "") || filename;
      } else {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Torrent file HTTP ${response.status} for ${url}`);
        source = Buffer.from(await response.arrayBuffer());
        filename = filenameFromUrl(url).replace(/\.torrent$/i, "") || filename;
      }
    } else {
      filename = parseMagnetName(url) ?? "Torrent";
    }
    const outDir = this.outDirFor("General");
    const job: AppJob = {
      id: randomUUID(),
      url,
      filename,
      category: "General",
      destination: outDir,
      partPath: join(outDir, `${filename}.torrent`),
      status: "queued",
      progress: null,
      error: null,
      createdAt: new Date().toISOString(),
      isTorrent: true,
      torrentOutDir: outDir,
      queueId: opts.queueId && this.queues.has(opts.queueId) ? opts.queueId : "main",
      retryCount: 0,
    };
    this.jobs.set(job.id, job);
    this.pending.push(job.id);
    this.emitJobs();
    void this.pump();
    return job;
  }

  async pause(id: string): Promise<AppJob | undefined> {
    const job = this.jobs.get(id);
    if (!job || (job.status !== "downloading" && job.status !== "queued" && job.status !== "retrying")) {
      return job;
    }
    this.clearRetry(id);
    const torrentSession = this.torrentSessions.get(id);
    if (torrentSession) {
      torrentSession.pause();
      job.status = "paused";
      job.progress = { ...torrentSession.progress(), status: "paused" };
      this.emitJobs();
      void this.pump();
      return job;
    }
    // Live capture: pause means "stop and save what arrived".
    const liveSession = this.liveSessions.get(id);
    if (liveSession) {
      const result = await liveSession.pause();
      this.liveSessions.delete(id);
      job.status = result.status === "completed" ? "completed" : "paused";
      job.destination = result.destination;
      job.filename = basename(result.destination);
      job.warning = result.warning;
      job.progress = { ...liveSession.progress(), status: job.status };
      this.emitJobs();
      void this.pump();
      return job;
    }
    const ftpSession = this.ftpSessions.get(id);
    if (ftpSession) {
      await ftpSession.pause();
      this.ftpSessions.delete(id);
      job.status = "paused";
      job.progress = { ...ftpSession.progress(), status: "paused" };
      this.emitJobs();
      void this.pump();
      return job;
    }
    const ytSession = this.ytSessions.get(id);
    if (ytSession) {
      ytSession.pause();
      await ytSession.done.catch(() => undefined);
      this.ytSessions.delete(id);
      job.status = "paused";
      job.progress = { ...ytSession.progress(), status: "paused" };
      this.emitJobs();
      void this.pump();
      return job;
    }
    const streamSession = this.streamSessions.get(id);
    if (streamSession) {
      const paused = await streamSession.pause();
      this.streamSessions.delete(id);
      job.status = paused.status;
      job.progress = { ...streamSession.progress(), status: paused.status };
    } else {
      const session = this.sessions.get(id);
      if (session) {
        const paused = await session.pause();
        this.sessions.delete(id);
        job.status = paused.status;
        job.progress = session.progress();
      } else {
        // Queued, not started yet: remove from pending.
        this.pending = this.pending.filter((pendingId) => pendingId !== id);
        job.status = "paused";
      }
    }
    this.emitJobs();
    void this.pump();
    return job;
  }

  async resume(id: string): Promise<AppJob | undefined> {
    const job = this.jobs.get(id);
    if (!job || (job.status !== "paused" && job.status !== "failed")) return job;
    // 0.8.0: a failed job retries from here too. Previously resume was
    // a no-op for failed jobs, so the UI had no way to retry a failure
    // except deleting and re-adding it by hand. Clearing the auto-retry
    // timer first keeps a scheduled retry from double-queueing it.
    this.clearRetry(id);
    job.status = "queued";
    job.error = null;
    job.retryCount = 0;
    this.pending.push(id);
    this.emitJobs();
    void this.pump();
    return job;
  }

  async cancel(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job) return false;
    this.clearRetry(id);
    const torrentSession = this.torrentSessions.get(id);
    if (torrentSession) {
      const owned = torrentSession.filePaths();
      await torrentSession.destroy().catch(() => undefined);
      this.torrentSessions.delete(id);
      const base = job.torrentOutDir ?? "";
      for (const file of owned) {
        // Resolved containment, not a string prefix: "/a/b-evil/x"
        // starts with "/a/b" but is a different folder.
        if (base && isPathWithinDir(base, file)) await unlink(file).catch(() => undefined);
      }
    }
    const liveSession = this.liveSessions.get(id);
    if (liveSession) {
      await liveSession.pause().catch(() => undefined);
      this.liveSessions.delete(id);
      const tsPath = job.destination.replace(/(\.[^.]+)$/, "") + ".live.ts";
      await unlink(tsPath).catch(() => undefined);
      await unlink(job.destination).catch(() => undefined);
    }
    const ftpSession = this.ftpSessions.get(id);
    if (ftpSession) {
      await ftpSession.pause().catch(() => undefined);
      this.ftpSessions.delete(id);
    }
    const ytSession = this.ytSessions.get(id);
    if (ytSession) {
      ytSession.pause();
      await ytSession.done.catch(() => undefined);
      this.ytSessions.delete(id);
      // Unfinished only: a completed YouTube file must survive
      // "Clear Completed" (which uses cancel to drop the list row).
      if (job.status !== "completed") {
        await cleanupYoutubeFiles(
          job.youtubeOutDir ?? dirname(job.destination),
          job.youtubeVideoId ?? null,
        );
      }
    }
    const streamSession = this.streamSessions.get(id);
    if (streamSession) {
      await streamSession.pause().catch(() => undefined);
      this.streamSessions.delete(id);
      await rm(`${job.destination}.stream-parts`, { recursive: true, force: true }).catch(() => undefined);
      await unlink(`${job.destination}.stream.json`).catch(() => undefined);
    }
    const session = this.sessions.get(id);
    if (session) {
      await session.pause().catch(() => undefined);
      this.sessions.delete(id);
    }
    this.pending = this.pending.filter((pendingId) => pendingId !== id);
    await unlink(job.partPath).catch(() => undefined);
    await unlink(`${job.partPath}.json`).catch(() => undefined);
    this.jobs.delete(id);
    this.emitJobs();
    void this.pump();
    return true;
  }

  /**
   * 0.8.0: pause every active job in one queue. This is deliberately
   * just per-job pause — there is no separate paused-queue state in
   * the pump, so "queue stopped" here means its jobs are paused.
   */
  async pauseQueue(queueId: string): Promise<number> {
    let count = 0;
    for (const job of this.list()) {
      if ((job.queueId ?? "main") !== queueId) continue;
      if (job.status !== "downloading" && job.status !== "queued") continue;
      await this.pause(job.id);
      count++;
    }
    return count;
  }

  /** 0.8.0: resume every paused job in one queue (failed jobs are not
   *  swept up here — they have their own per-card / retry-all path). */
  async resumeQueue(queueId: string): Promise<number> {
    let count = 0;
    for (const job of this.list()) {
      if ((job.queueId ?? "main") !== queueId) continue;
      if (job.status !== "paused") continue;
      await this.resume(job.id);
      count++;
    }
    return count;
  }

  /**
   * 0.8.0: remove a COMPLETED job and its file from disk. This is
   * separate from cancel() on purpose: cancel() deliberately keeps
   * completed files (Clear Completed must not delete downloads).
   * The file is unlinked only when its resolved destination is inside
   * the downloads dir — anything outside it is left untouched, and
   * the list entry is still removed. Non-completed jobs are refused
   * outright (returns false, job untouched) so an in-progress file
   * can never be deleted through this path. YouTube jobs have no
   * single destination file (yt-dlp adds the extension), so their
   * files are removed by the same video-id cleanup cancel() uses
   * for unfinished jobs.
   */
  async deleteWithFile(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job || job.status !== "completed") return false;
    const destination = job.destination;
    const youtubeOutDir = job.youtubeOutDir;
    const youtubeVideoId = job.youtubeVideoId ?? null;
    const inside = Boolean(destination) &&
      destination !== this.downloadsDir &&
      isPathWithinDir(this.downloadsDir, destination);
    const removed = await this.cancel(id);
    if (!removed) return false;
    if (job.isYoutube && youtubeOutDir && youtubeVideoId) {
      await cleanupYoutubeFiles(youtubeOutDir, youtubeVideoId).catch(() => undefined);
      return true;
    }
    if (inside) await unlink(destination).catch(() => undefined);
    return true;
  }

  private emitJobs(): void {
    this.onJobsChanged?.(this.list());
    void this.saveQueue();
  }

  private emitProgress(progress: DownloadProgress): void {
    const job = [...this.jobs.values()].find((candidate) => {
      const session = this.sessions.get(candidate.id);
      if (session?.job.id === progress.jobId) return true;
      const streamSession = this.streamSessions.get(candidate.id);
      if (streamSession?.sessionId === progress.jobId) return true;
      const ytSession = this.ytSessions.get(candidate.id);
      if (ytSession?.jobId === progress.jobId) return true;
      const ftpSession = this.ftpSessions.get(candidate.id);
      if (ftpSession?.appJobId === progress.jobId) return true;
      const liveSession = this.liveSessions.get(candidate.id);
      if (liveSession?.appJobId === progress.jobId) return true;
      const torrentSession = this.torrentSessions.get(candidate.id);
      return torrentSession?.appJobId === progress.jobId;
    });
    if (job) {
      job.progress = progress;
      job.status = progress.status;
      job.error = progress.error;
    }
    this.onProgress?.(progress);
  }

  /** First pending job whose queue still has a free slot (-1 = none). */
  private nextPendingIndex(): number {
    return this.pending.findIndex((id) => {
      const job = this.jobs.get(id);
      if (!job) return true;
      const queue = this.queues.get(job.queueId ?? "main") ?? this.queues.get("main")!;
      return this.queueActiveCount(queue.id) < queue.maxConcurrent;
    });
  }

  private async pump(): Promise<void> {
    // 0.7.0 gates: scheduler window closed, or smart limit 0 while a
    // watched process runs — don't start new downloads either way.
    if (!shouldRunNow(this.schedulerPolicy)) return;
    if (this.smartActive && this.smartConfig.enabled && this.smartConfig.smartLimitBytesPerSec === 0) return;
    while (this.activeCount() < this.maxConcurrent && this.pending.length > 0) {
      const index = this.nextPendingIndex();
      if (index < 0) return;
      const id = this.pending.splice(index, 1)[0]!;
      const job = this.jobs.get(id);
      if (!job) continue;
      this.drainNotified = false;
      this.jobStartedAt.set(id, Date.now());
      if (job.isYoutube) {
        await this.pumpYoutube(job);
        continue;
      }
      if (job.isFtp) {
        await this.pumpFtp(job);
        continue;
      }
      if (job.isLiveStream) {
        await this.pumpLive(job);
        continue;
      }
      if (job.isTorrent) {
        await this.pumpTorrent(job);
        continue;
      }
      if (job.isStream) {
        await this.pumpStream(job);
        continue;
      }
      const isResume = existsSync(job.partPath) || existsSync(`${job.partPath}.json`);
      job.status = "downloading";
      this.emitJobs();
      try {
        const session = isResume
          ? await resumeDownload(job.partPath, {
              segments: job.segments ?? this.segments,
              speedLimitBytesPerSec: this.effectiveSpeedLimit(job),
              // Headers are intentionally not persisted in the journal;
              // a resumed bridge download re-uses only in-memory headers.
              ...(job.headers ? { headers: job.headers } : {}),
              ...(job.mirrorUrls?.length ? { mirrorUrls: job.mirrorUrls } : {}),
              onProgress: (p) => this.emitProgress(p),
            })
          : await startDownload(job.url, job.destination, {
              segments: job.segments ?? this.segments,
              speedLimitBytesPerSec: this.effectiveSpeedLimit(job),
              ...(job.headers ? { headers: job.headers } : {}),
              ...(job.mirrorUrls?.length ? { mirrorUrls: job.mirrorUrls } : {}),
              onProgress: (p) => this.emitProgress(p),
            });
        // FIX (audit): pause()/cancel() may have run while start/resume
        // was awaiting its probe. Without this check the download would
        // silently continue and overwrite the paused/cancelled state.
        const current = this.jobs.get(id);
        if (!current || current.status === "paused") {
          await session.pause().catch(() => undefined);
          if (!current) {
            await unlink(job.partPath).catch(() => undefined);
            await unlink(`${job.partPath}.json`).catch(() => undefined);
          } else {
            current.progress = session.progress();
          }
          this.emitJobs();
          continue;
        }
        this.sessions.set(id, session);
        void session.done
          .then((finished) => {
            if (!this.jobs.has(id)) return;
            this.sessions.delete(id);
            job.status = finished.status;
            job.progress = session.progress();
            if (finished.status === "completed") {
              job.progress = {
                ...job.progress,
                status: "completed",
                percent: 1,
                etaSeconds: 0,
              };
              void this.verifyChecksum(job);
              void this.postDownload(job);
              this.checkDrained();
            }
            this.emitJobs();
            this.onProgress?.(job.progress);
            void this.pump();
          })
          .catch((error: unknown) => {
            if (!this.jobs.has(id)) return;
            this.sessions.delete(id);
            const message = error instanceof Error ? error.message : String(error);
            if (this.maybeRetry(job, message)) {
              void this.pump();
              return;
            }
            job.status = "failed";
            job.error = message;
            this.emitJobs();
            void this.pump();
          });
      } catch (error) {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        this.emitJobs();
      }
    }
  }

  private async pumpTorrent(job: AppJob): Promise<void> {
    const id = job.id;
    job.status = "downloading";
    this.emitJobs();
    let session = this.torrentSessions.get(id);
    if (!session) {
      if (!this.torrentClient) this.torrentClient = await createWebTorrentClient();
      let source: string | Buffer = job.url;
      if (!job.url.startsWith("magnet:")) {
        try {
          // 0.7.0: resume a context-menu .torrent from its local path.
          if (existsSync(job.url) && job.url.toLowerCase().endsWith(".torrent")) {
            source = await readFile(job.url);
          } else {
            const response = await fetch(job.url);
            if (!response.ok) throw new Error(`Torrent file HTTP ${response.status} for ${job.url}`);
            source = Buffer.from(await response.arrayBuffer());
          }
        } catch (error) {
          job.status = "failed";
          job.error = error instanceof Error ? error.message : String(error);
          this.emitJobs();
          return;
        }
      }
      session = new TorrentSession({
        jobId: id,
        sessionId: randomUUID(),
        source,
        outDir: job.torrentOutDir ?? this.outDirFor("General"),
        client: this.torrentClient,
        onProgress: (p) => this.emitProgress(p),
      });
      this.torrentSessions.set(id, session);
    }
    const current = this.jobs.get(id);
    if (!current || current.status === "paused") return;
    const result = await session.startRun();
    if (!this.jobs.has(id)) return;
    job.status = result.status;
    if (result.status === "completed") {
      job.destination = result.destination;
      job.filename = basename(result.destination);
      job.progress = { ...session.progress(), status: "completed", percent: 1, etaSeconds: 0 };
      // 0.7.0 seeding: keep the torrent alive instead of destroying
      // it; checkSeeding()/stopSeeding() end it per policy or on demand.
      if (this.seedingPolicy.enabled) {
        job.seeding = true;
        job.seedStartedAt = new Date().toISOString();
      } else {
        this.torrentSessions.delete(id);
      }
      void this.postDownload(job);
      this.checkDrained();
    } else if (result.status === "paused") {
      job.progress = { ...session.progress(), status: "paused" };
      // Session stays registered: resume re-uses the torrent object.
    } else {
      // Torrent failures are not auto-retried: re-adding would restart
      // peer discovery from scratch and can duplicate partial data.
      job.error = result.error;
      this.torrentSessions.delete(id);
    }
    this.emitJobs();
    if (job.progress) this.onProgress?.(job.progress);
    void this.pump();
  }

  private async pumpYoutube(job: AppJob): Promise<void> {
    const id = job.id;
    job.status = "downloading";
    this.emitJobs();
    try {
      const tools = this.youtubeTools
        ? await this.youtubeTools()
        : { ytDlp: null, ffmpeg: null };
      const current = this.jobs.get(id);
      if (!current || current.status === "paused") return;
      if (!tools.ytDlp) {
        job.status = "failed";
        job.error =
          "yt-dlp is not installed. Open the YouTube card and press “Download yt-dlp”, or put yt-dlp on your PATH.";
        this.emitJobs();
        return;
      }
      const ytLimit = this.effectiveSpeedLimit(job);
      const options = {
        ...(job.youtubeOptions ?? { kind: "video" }),
        ...(this.proxyUrl && !job.youtubeOptions?.proxy ? { proxy: this.proxyUrl } : {}),
        ...(ytLimit > 0 && !job.youtubeOptions?.limitRate ? { limitRate: ytLimit } : {}),
      };
      const outDir = job.youtubeOutDir ?? this.outDirFor("Video");
      const template = outputTemplateFor(outDir, options.playlist === true);
      const { args, warnings } = buildYtDlpArgs(job.url, options, template, tools.ffmpeg);
      if (tools.ytDlp) job.ytCommand = quoteCommandLine(tools.ytDlp, args);
      const session = new YoutubeSession({
        jobId: id,
        ytDlp: tools.ytDlp,
        args,
        outDir,
        expectedFilename: null,
        videoId: job.youtubeVideoId ?? null,
        onProgress: (p) => this.emitProgress(p),
      });
      this.ytSessions.set(id, session);
      session.start();
      const result = await session.done;
      if (!this.jobs.has(id)) return;
      this.ytSessions.delete(id);
      job.status = result.status;
      if (warnings.length) job.warning = warnings.join(" ");
      if (result.status === "completed") {
        job.destination = result.destination;
        job.filename = basename(result.destination);
        job.progress = {
          ...session.progress(),
          status: "completed",
          percent: 1,
          etaSeconds: 0,
        };
        void this.postDownload(job);
        this.checkDrained();
      } else if (result.status === "paused") {
        job.progress = { ...session.progress(), status: "paused" };
      } else {
        job.error = result.error;
        if (result.error && this.maybeRetry(job, result.error)) {
          this.emitJobs();
          void this.pump();
          return;
        }
      }
      this.emitJobs();
      if (job.progress) this.onProgress?.(job.progress);
      void this.pump();
    } catch (error) {
      if (!this.jobs.has(id)) return;
      const message = error instanceof Error ? error.message : String(error);
      if (this.maybeRetry(job, message)) {
        void this.pump();
        return;
      }
      job.status = "failed";
      job.error = message;
      this.emitJobs();
    }
  }

  private async pumpFtp(job: AppJob): Promise<void> {
    const id = job.id;
    job.status = "downloading";
    this.emitJobs();
    const session = new FtpSession({
      jobId: id,
      url: job.url,
      destination: job.destination,
      onProgress: (p) => this.emitProgress(p),
    });
    const current = this.jobs.get(id);
    if (!current || current.status === "paused") return;
    this.ftpSessions.set(id, session);
    session.start();
    const result = await session.done;
    if (!this.jobs.has(id)) return;
    this.ftpSessions.delete(id);
    job.status = result.status;
    if (result.status === "completed") {
      job.progress = { ...session.progress(), status: "completed", percent: 1, etaSeconds: 0 };
      void this.verifyChecksum(job);
      this.checkDrained();
    } else if (result.status === "paused") {
      job.progress = { ...session.progress(), status: "paused" };
    } else {
      job.error = result.error;
      if (result.error && this.maybeRetry(job, result.error)) {
        this.emitJobs();
        void this.pump();
        return;
      }
    }
    this.emitJobs();
    if (job.progress) this.onProgress?.(job.progress);
    void this.pump();
  }

  private async pumpLive(job: AppJob): Promise<void> {
    const id = job.id;
    if (job.url.includes(".mpd")) {
      job.status = "failed";
      job.error = "Live DASH streams are not supported; only live HLS (.m3u8) can be captured.";
      this.emitJobs();
      return;
    }
    job.status = "downloading";
    this.emitJobs();
    const session = new LiveHlsSession({
      jobId: id,
      url: job.url,
      destination: job.destination,
      ...(job.headers ? { headers: job.headers } : {}),
      onProgress: (p) => this.emitProgress(p),
    });
    const current = this.jobs.get(id);
    if (!current || current.status === "paused") return;
    this.liveSessions.set(id, session);
    session.start();
    const result = await session.done;
    if (!this.jobs.has(id)) return;
    this.liveSessions.delete(id);
    job.status = result.status;
    if (result.status === "completed") {
      job.destination = result.destination;
      job.filename = basename(result.destination);
      job.warning = result.warning;
      job.progress = { ...session.progress(), status: "completed", percent: 1, etaSeconds: 0 };
      this.checkDrained();
    } else if (result.status === "paused") {
      job.progress = { ...session.progress(), status: "paused" };
    } else {
      // Live captures are never auto-retried: restarting would
      // truncate the capture file and lose what was already saved.
      job.error = result.error;
    }
    this.emitJobs();
    if (job.progress) this.onProgress?.(job.progress);
    void this.pump();
  }

  private async pumpStream(job: AppJob): Promise<void> {
    const id = job.id;
    const isResume = existsSync(`${job.destination}.stream.json`);
    job.status = "downloading";
    this.emitJobs();
    try {
      const session = isResume
        ? await resumeStream(job.destination, {
            ...(job.headers ? { headers: job.headers } : {}),
            onProgress: (p) => this.emitProgress(p),
          })
        : await downloadStream(job.url, job.destination, {
            ...(job.variantUrl ? { variantUrl: job.variantUrl } : {}),
            ...(job.representationId ? { representationId: job.representationId } : {}),
            ...(job.headers ? { headers: job.headers } : {}),
            onProgress: (p) => this.emitProgress(p),
          });
      const current = this.jobs.get(id);
      if (!current || current.status === "paused") {
        await session.pause().catch(() => undefined);
        if (!current) {
          await rm(`${job.destination}.stream-parts`, { recursive: true, force: true }).catch(() => undefined);
          await unlink(`${job.destination}.stream.json`).catch(() => undefined);
        } else {
          current.progress = session.progress();
        }
        this.emitJobs();
        return;
      }
      this.streamSessions.set(id, session);
      void session.done
        .then((finished) => {
          if (!this.jobs.has(id)) return;
          this.streamSessions.delete(id);
          job.status = finished.status;
          // Assembled output may differ from the requested path on fallback.
          job.destination = finished.destination;
          job.filename = basename(finished.destination);
          job.warning = finished.warning;
          job.progress = {
            ...session.progress(),
            status: finished.status,
            percent: finished.status === "completed" ? 1 : session.progress().percent,
            etaSeconds: finished.status === "completed" ? 0 : null,
          };
          if (finished.status === "completed") {
            void this.verifyChecksum(job);
            this.checkDrained();
          } else if (finished.status === "failed" && finished.error && this.maybeRetry(job, finished.error)) {
            void this.pump();
            return;
          }
          this.emitJobs();
          this.onProgress?.(job.progress);
          void this.pump();
        })
        .catch((error: unknown) => {
          if (!this.jobs.has(id)) return;
          this.streamSessions.delete(id);
          const message = error instanceof Error ? error.message : String(error);
          if (this.maybeRetry(job, message)) {
            void this.pump();
            return;
          }
          job.status = "failed";
          job.error = message;
          this.emitJobs();
          void this.pump();
        });
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      this.emitJobs();
    }
  }
}

/* ---- 0.8.0: .txt import + CSV export (pure, unit-tested) ---- */

/** Is this line a downloadable link? http/https, magnet, ftp/ftps. */
const IMPORT_URL = /^(https?:\/\/|magnet:|ftps?:\/\/)/i;

/**
 * Parse a .txt import file: one URL per line. Blank lines are ignored;
 * every other line that is not a valid, non-duplicate link counts as
 * skipped (invalid lines and exact duplicates alike), so the UI can
 * report "added / skipped / failed" with nothing silently dropped.
 */
export function parseImportUrls(text: string): { urls: string[]; skipped: number } {
  const seen = new Set<string>();
  const urls: string[] = [];
  let skipped = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/\s/.test(line)) {
      skipped++;
      continue;
    }
    const match = IMPORT_URL.exec(line);
    if (!match || !line.slice(match[0].length)) {
      skipped++;
      continue;
    }
    if (seen.has(line)) {
      skipped++;
      continue;
    }
    seen.add(line);
    urls.push(line);
  }
  return { urls, skipped };
}

/** YouTube watch/shorts links must go through yt-dlp, never plain HTTP
 * (a plain download of a watch page would save the page as a file). */
export function isYoutubeImportUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be";
  } catch {
    return false;
  }
}

function csvField(value: string): string {
  if (/[",\n\r]/.test(value) || value !== value.trim()) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * The current job list as CSV (CRLF, so Windows tools open it cleanly),
 * followed by a small stats summary computed from the same list.
 * Columns: name, url, status, size, downloaded, category, queue.
 * size/downloaded are bytes from the job's latest progress, or blank
 * when the job has never reported progress.
 */
export function jobsToCsv(jobs: AppJob[]): string {
  const rows: string[][] = [["name", "url", "status", "size", "downloaded", "category", "queue"]];
  for (const job of jobs) {
    rows.push([
      job.filename,
      job.url,
      job.status,
      job.progress?.totalBytes != null ? String(job.progress.totalBytes) : "",
      job.progress?.downloadedBytes != null ? String(job.progress.downloadedBytes) : "",
      job.category,
      job.queueId ?? "main",
    ]);
  }
  rows.push([]);
  rows.push(["metric", "value"]);
  rows.push(["total_jobs", String(jobs.length)]);
  rows.push(["completed_jobs", String(jobs.filter((job) => job.status === "completed").length)]);
  rows.push(["failed_jobs", String(jobs.filter((job) => job.status === "failed").length)]);
  rows.push(["total_downloaded_bytes", String(
    jobs.reduce((sum, job) => sum + (job.progress?.downloadedBytes ?? 0), 0),
  )]);
  return rows.map((row) => row.map(csvField).join(",")).join("\r\n") + "\r\n";
}
