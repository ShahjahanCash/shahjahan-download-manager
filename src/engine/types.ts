export type DownloadStatus =
  | "queued"
  | "downloading"
  | "paused"
  | "completed"
  | "failed"
  /** Failed, but the manager will re-queue it after a backoff delay. */
  | "retrying";

export type DownloadCategory =
  | "Video"
  | "Audio"
  | "Documents"
  | "Compressed"
  | "Programs"
  | "General";

export interface SegmentState {
  /** Inclusive start byte. */
  start: number;
  /** Inclusive end byte. */
  end: number;
  /** Bytes already written for this segment. */
  downloaded: number;
  done: boolean;
}

export interface JobState {
  version: 1;
  id: string;
  url: string;
  finalUrl: string;
  destination: string;
  /** Path of the in-progress file, before rename to destination. */
  partPath: string;
  filename: string;
  category: DownloadCategory;
  totalBytes: number | null;
  /** True when the server honoured a Range request with 206. */
  rangeSupported: boolean;
  etag: string | null;
  lastModified: string | null;
  segments: SegmentState[];
  downloadedBytes: number;
  status: DownloadStatus;
  createdAt: string;
  updatedAt: string;
  error: string | null;
}

export interface DownloadOptions {
  /** Maximum concurrent segment workers. Default 8. */
  segments?: number;
  /** Minimum bytes per segment. Default 256 KiB. */
  minSegmentBytes?: number;
  /** Global speed cap in bytes/second. 0 / omitted = unlimited. */
  speedLimitBytesPerSec?: number;
  /** Extra request headers, e.g. forwarded by the browser extension. */
  headers?: Record<string, string>;
  /** Per-segment attempts before failing. Default 4. */
  maxAttempts?: number;
  /** Split a straggler segment when this many bytes remain. Default 1 MiB. */
  dynamicSplitThresholdBytes?: number;
  /** Mirror URLs for the same file (0.7.0): tried in order when the
   * primary URL fails a segment; the first working mirror becomes the
   * job's finalUrl for the remaining segments. */
  mirrorUrls?: string[];
  /** Called roughly every 250 ms (and on completion) with live progress. */
  onProgress?: (progress: DownloadProgress) => void;
}

export interface DownloadProgress {
  jobId: string;
  status: DownloadStatus;
  downloadedBytes: number;
  totalBytes: number | null;
  /** 0..1 when total is known, otherwise null. */
  percent: number | null;
  /** Exponentially smoothed bytes/second. */
  speedBytesPerSec: number;
  /** Seconds remaining, when speed and total are known. */
  etaSeconds: number | null;
  segments: SegmentState[];
  error: string | null;
}

export interface ProbeResult {
  finalUrl: string;
  totalBytes: number | null;
  rangeSupported: boolean;
  etag: string | null;
  lastModified: string | null;
  contentType: string | null;
  filename: string | null;
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
