/**
 * Persistent queue: the job list (including completed history) is
 * saved to a JSON file in the app's userData folder on every state
 * change, and restored on startup. Jobs that were downloading or
 * queued come back paused — the user resumes them, and the engine
 * journals (.part / .stream.json / yt-dlp .part files) pick up
 * where they stopped. Auth headers are never persisted.
 */

import type { DownloadCategory, DownloadStatus } from "../engine/types.js";
import type { YoutubeOptions } from "../yt/options.js";

export interface SavedQueueDef {
  id: string;
  name: string;
  maxConcurrent: number;
  /** Queue speed cap in bytes/s (0 / omitted = no cap). Feature 11. */
  speedLimitBytesPerSec?: number;
}

export interface SavedJob {
  version: 1;
  id: string;
  url: string;
  filename: string;
  category: DownloadCategory;
  destination: string;
  partPath: string;
  status: DownloadStatus;
  createdAt: string;
  segments?: number;
  speedLimitBytesPerSec?: number;
  isYoutube?: boolean;
  youtubeOptions?: YoutubeOptions;
  youtubeOutDir?: string;
  youtubeVideoId?: string | null;
  isStream?: boolean;
  variantUrl?: string;
  representationId?: string;
  isFtp?: boolean;
  isLiveStream?: boolean;
  isTorrent?: boolean;
  torrentOutDir?: string;
  queueId?: string;
  expectedHash?: string;
  sha256?: string;
  checksumStatus?: "pass" | "mismatch" | null;
  /** 0.7.0: mirror URLs, extract outcome, Defender scan result. */
  mirrorUrls?: string[];
  extractStatus?: string | null;
  scanStatus?: "clean" | "threat" | "error" | "unknown" | null;
}

export interface SavedQueueFile {
  version: 1;
  queues: SavedQueueDef[];
  jobs: SavedJob[];
}

/** Minimal structural view of a manager job, so this module never
 * imports the manager (which imports this file). */
export interface PersistableJob {
  id: string;
  url: string;
  filename: string;
  category: DownloadCategory;
  destination: string;
  partPath: string;
  status: DownloadStatus;
  createdAt: string;
  segments?: number;
  speedLimitBytesPerSec?: number;
  isYoutube?: boolean;
  youtubeOptions?: YoutubeOptions;
  youtubeOutDir?: string;
  youtubeVideoId?: string | null;
  isStream?: boolean;
  variantUrl?: string;
  representationId?: string;
  isFtp?: boolean;
  isLiveStream?: boolean;
  isTorrent?: boolean;
  torrentOutDir?: string;
  queueId?: string;
  expectedHash?: string;
  sha256?: string;
  checksumStatus?: "pass" | "mismatch" | null;
  mirrorUrls?: string[];
  extractStatus?: string | null;
  scanStatus?: "clean" | "threat" | "error" | "unknown" | null;
}

export function serializeJob(job: PersistableJob): SavedJob {
  const saved: SavedJob = {
    version: 1,
    id: job.id,
    url: job.url,
    filename: job.filename,
    category: job.category,
    destination: job.destination,
    partPath: job.partPath,
    status: job.status,
    createdAt: job.createdAt,
  };
  if (job.segments !== undefined) saved.segments = job.segments;
  if (job.speedLimitBytesPerSec !== undefined) saved.speedLimitBytesPerSec = job.speedLimitBytesPerSec;
  if (job.isYoutube) saved.isYoutube = true;
  if (job.youtubeOptions) saved.youtubeOptions = job.youtubeOptions;
  if (job.youtubeOutDir) saved.youtubeOutDir = job.youtubeOutDir;
  if (job.youtubeVideoId !== undefined) saved.youtubeVideoId = job.youtubeVideoId;
  if (job.isStream) saved.isStream = true;
  if (job.variantUrl) saved.variantUrl = job.variantUrl;
  if (job.representationId) saved.representationId = job.representationId;
  if (job.isFtp) saved.isFtp = true;
  if (job.isLiveStream) saved.isLiveStream = true;
  if (job.isTorrent) saved.isTorrent = true;
  if (job.torrentOutDir) saved.torrentOutDir = job.torrentOutDir;
  if (job.queueId) saved.queueId = job.queueId;
  if (job.expectedHash) saved.expectedHash = job.expectedHash;
  if (job.sha256) saved.sha256 = job.sha256;
  if (job.checksumStatus) saved.checksumStatus = job.checksumStatus;
  if (job.mirrorUrls?.length) saved.mirrorUrls = job.mirrorUrls;
  if (job.extractStatus) saved.extractStatus = job.extractStatus;
  if (job.scanStatus) saved.scanStatus = job.scanStatus;
  return saved;
}

export function parseQueueFile(raw: string): SavedQueueFile | null {
  try {
    const parsed = JSON.parse(raw) as SavedQueueFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.jobs)) return null;
    return {
      version: 1,
      queues: Array.isArray(parsed.queues) ? parsed.queues : [],
      jobs: parsed.jobs.filter((job) => job && typeof job.id === "string" && typeof job.url === "string"),
    };
  } catch {
    return null;
  }
}
