import { randomUUID } from "node:crypto";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { FileHandle } from "node:fs/promises";
import { categorize, filenameFromUrl } from "./categories.js";
import { retryOnLock } from "./fileOps.js";
import { loadJournal, saveJournal } from "./journal.js";
import { winLongPath } from "./paths.js";
import { probe } from "./probe.js";
import { planSegments, recommendSegments, segmentRemaining } from "./segments.js";
import { TokenBucket } from "./tokenBucket.js";
import type {
  DownloadOptions,
  DownloadProgress,
  DownloadStatus,
  JobState,
  SegmentState,
} from "./types.js";
import { sleep } from "./types.js";

export interface DownloadSession {
  readonly job: JobState;
  readonly done: Promise<JobState>;
  pause(): Promise<JobState>;
  progress(): DownloadProgress;
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message.includes("aborted"))
  );
}

export class DownloadSessionImpl implements DownloadSession {
  readonly job: JobState;
  readonly done: Promise<JobState>;
  private readonly abortController = new AbortController();
  private readonly bucket: TokenBucket;
  private readonly options: Required<
    Pick<
      DownloadOptions,
      | "segments"
      | "minSegmentBytes"
      | "maxAttempts"
      | "dynamicSplitThresholdBytes"
    >
  > &
    DownloadOptions;
  private readonly claimed = new Set<SegmentState>();
  private handle: FileHandle | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastBytes = 0;
  private lastAt = Date.now();
  private speed = 0;
  /** Mirror failover (0.7.0): candidates in try order; the active one
   * serves the current segment, and a successful mirror becomes the
   * job's finalUrl for the remaining segments. */
  private readonly urlCandidates: string[];
  private candidateIndex = 0;
  private resolveDone!: (job: JobState) => void;
  private rejectDone!: (error: unknown) => void;

  constructor(job: JobState, options: DownloadOptions = {}) {
    this.job = job;
    this.options = {
      ...options,
      segments: options.segments ?? 8,
      minSegmentBytes: options.minSegmentBytes ?? 256 * 1024,
      maxAttempts: options.maxAttempts ?? 4,
      dynamicSplitThresholdBytes:
        options.dynamicSplitThresholdBytes ?? 512 * 1024,
    };
    this.bucket = new TokenBucket(options.speedLimitBytesPerSec ?? 0);
    this.urlCandidates = [
      job.finalUrl,
      ...(options.mirrorUrls ?? []).filter(
        (url) => url && url !== job.finalUrl,
      ),
    ];
    this.done = new Promise<JobState>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    // Attach a no-op handler so an un-awaited `done` in tests does not
    // surface as an unhandled rejection before the caller awaits it.
    this.done.catch(() => undefined);
  }

  async start(): Promise<JobState> {
    try {
      await this.run();
      return this.job;
    } catch (error) {
      if (isAbort(error)) {
        this.job.status = "paused";
        await this.finish().catch(() => undefined);
        this.resolveDone(this.job);
        return this.job;
      }
      this.job.status = "failed";
      this.job.error = error instanceof Error ? error.message : String(error);
      await this.finish().catch(() => undefined);
      this.rejectDone(error);
      throw error;
    }
  }

  async pause(): Promise<JobState> {
    if (this.job.status !== "downloading") return this.job;
    this.abortController.abort();
    return this.done;
  }

  progress(): DownloadProgress {
    const downloaded = this.job.segments.reduce(
      (sum, segment) => sum + segment.downloaded,
      0,
    );
    const total = this.job.totalBytes;
    return {
      jobId: this.job.id,
      status: this.job.status,
      downloadedBytes: downloaded,
      totalBytes: total,
      percent: total ? downloaded / total : null,
      speedBytesPerSec: this.speed,
      etaSeconds:
        total && this.speed > 0
          ? Math.max(0, (total - downloaded) / this.speed)
          : null,
      segments: this.job.segments.map((segment) => ({ ...segment })),
      error: this.job.error,
    };
  }

  private async run(): Promise<void> {
    this.job.status = "downloading";
    this.job.error = null;
    await mkdir(dirname(winLongPath(this.job.partPath)), { recursive: true });
    // Open mode: a resume (any segment already has bytes) must never
    // truncate the .part file — the old "w+" branch for unknown totals
    // wiped a partial unknown-length download on resume. A fresh
    // download keeps the old behaviour (w+ for unknown totals, so no
    // stale bytes trail the new file).
    const isResume = this.job.segments.some((s) => s.downloaded > 0);
    const openMode =
      this.job.totalBytes !== null || isResume ? "r+" : "w+";
    this.handle = await open(
      winLongPath(this.job.partPath),
      openMode,
    ).catch(async () => open(winLongPath(this.job.partPath), "w+"));
    if (this.job.totalBytes !== null) {
      await this.handle.truncate(this.job.totalBytes);
    }
    this.lastBytes = this.job.downloadedBytes;
    this.lastAt = Date.now();
    this.timer = setInterval(() => {
      void this.tick();
    }, 250);
    this.timer.unref?.();

    // segments: 0 means "Auto" (the UI default): newJobFromProbe already
    // resolved it into the segment count, so 0 here must mean "use all
    // segments" — NOT one worker. Before this fix, min(0, n) = 1, so
    // every Auto download silently ran single-stream — the classic
    // "why is it so slow" shape on throttled servers.
    const requested =
      this.options.segments > 0
        ? this.options.segments
        : this.job.segments.length;
    const workerCount = this.job.rangeSupported
      ? Math.max(1, Math.min(requested, this.job.segments.length))
      : 1;
    const workers = Array.from({ length: workerCount }, () => this.worker());
    await Promise.all(workers);
    if (this.abortController.signal.aborted) throw new Error("aborted");

    // Every segment must be done; a worker only exits when none remain.
    if (!this.job.segments.every((segment) => segment.done)) {
      throw new Error("Download ended with unfinished segments");
    }
    this.job.downloadedBytes = this.job.segments.reduce(
      (sum, segment) => sum + segment.downloaded,
      0,
    );
    // Never report "completed" for a short file: segment completion
    // alone is not proof when the total is known (§8).
    if (
      this.job.totalBytes !== null &&
      this.job.downloadedBytes !== this.job.totalBytes
    ) {
      throw new Error(
        `Download ended with ${this.job.downloadedBytes} bytes, expected ${this.job.totalBytes}`,
      );
    }
    if (this.job.totalBytes === null) {
      this.job.totalBytes = this.job.downloadedBytes;
      const only = this.job.segments[0];
      if (only) only.end = this.job.downloadedBytes - 1;
    }
    await this.handle.close();
    this.handle = null;
    // Rename over an existing destination (Windows rename would fail).
    // AV locks can also block rename briefly — retry, don't fail.
    await retryOnLock(() => unlink(winLongPath(this.job.destination))).catch(() => undefined);
    await retryOnLock(() =>
      rename(winLongPath(this.job.partPath), winLongPath(this.job.destination)),
    );
    this.job.status = "completed";
    await this.finish();
    this.resolveDone(this.job);
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const downloaded = this.job.segments.reduce(
      (sum, segment) => sum + segment.downloaded,
      0,
    );
    const elapsedSec = Math.max(0.001, (now - this.lastAt) / 1000);
    const instant = (downloaded - this.lastBytes) / elapsedSec;
    this.speed =
      this.speed === 0 ? instant : this.speed * 0.7 + instant * 0.3;
    this.lastBytes = downloaded;
    this.lastAt = now;
    this.job.downloadedBytes = downloaded;
    try {
      await saveJournal(this.job);
    } catch {
      // Journal failure must not kill the download; next tick retries.
    }
    this.options.onProgress?.(this.progress());
  }

  private async finish(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.handle) {
      await this.handle.close().catch(() => undefined);
      this.handle = null;
    }
    if (this.job.status === "completed") {
      // No stale journal: destination existence is the completed signal.
      await unlink(`${this.job.partPath}.json`).catch(() => undefined);
    } else {
      await saveJournal(this.job).catch(() => undefined);
      this.options.onProgress?.(this.progress());
    }
  }

  private pickSegment(): SegmentState | null {
    for (const segment of this.job.segments) {
      if (!segment.done && !this.claimed.has(segment)) return segment;
    }
    // Dynamic segmentation: split the largest remaining claimed segment
    // so an idle worker helps a straggler instead of waiting for it.
    let straggler: SegmentState | null = null;
    for (const segment of this.claimed) {
      if (segment.done) continue;
      if (
        segmentRemaining(segment) >
        this.options.dynamicSplitThresholdBytes * 2
      ) {
        if (!straggler || segmentRemaining(segment) > segmentRemaining(straggler)) {
          straggler = segment;
        }
      }
    }
    if (!straggler) return null;
    const position = straggler.start + straggler.downloaded;
    const remaining = segmentRemaining(straggler);
    const splitAt = position + Math.floor(remaining / 2);
    if (splitAt <= position || splitAt > straggler.end) return null;
    const tail: SegmentState = {
      start: splitAt,
      end: straggler.end,
      downloaded: 0,
      done: false,
    };
    straggler.end = splitAt - 1;
    this.job.segments.push(tail);
    return tail;
  }

  private async worker(): Promise<void> {
    while (!this.abortController.signal.aborted) {
      const segment = this.pickSegment();
      if (!segment) return;
      this.claimed.add(segment);
      try {
        await this.downloadSegment(segment);
      } finally {
        this.claimed.delete(segment);
      }
    }
  }

  private async downloadSegment(segment: SegmentState): Promise<void> {
    const maxAttempts = this.options.maxAttempts;
    let lastError: unknown = null;
    // Try the active URL first, then each mirror in order. A mirror
    // that serves a segment becomes the job's URL from then on.
    for (
      let candidate = this.candidateIndex;
      candidate < this.urlCandidates.length;
      candidate++
    ) {
      const url = this.urlCandidates[candidate]!;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (this.abortController.signal.aborted) throw new Error("aborted");
        try {
          await this.downloadSegmentOnce(segment, url);
          if (segment.done) {
            this.candidateIndex = candidate;
            this.job.finalUrl = url;
            return;
          }
          if (segment.downloaded >= segment.end - segment.start + 1) {
            segment.done = true;
            this.candidateIndex = candidate;
            this.job.finalUrl = url;
            return;
          }
          throw new Error("Server closed the stream before the segment finished");
        } catch (error) {
          if (isAbort(error)) throw error;
          lastError = error;
          if (attempt < maxAttempts) {
            await sleep(500 * 2 ** (attempt - 1));
          }
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Segment download failed");
  }

  private async downloadSegmentOnce(segment: SegmentState, url: string): Promise<void> {
    if (!this.handle) throw new Error("File handle is not open");
    const start = segment.start + segment.downloaded;
    if (start > segment.end && this.job.totalBytes !== null) {
      segment.done = true;
      return;
    }
    const headers: Record<string, string> = { ...(this.options.headers ?? {}) };
    if (this.job.rangeSupported) {
      headers["Range"] = `bytes=${start}-${segment.end}`;
    }
    const response = await fetch(url, {
      headers,
      redirect: "follow",
      signal: this.abortController.signal,
    });
    // B3 fix: the 416 branch used to sit AFTER the "expected 206"
    // check, so it was dead code — a server answering 416 for an
    // already-complete segment failed the download after retries.
    // Only honour 416 when the segment is already fully downloaded;
    // otherwise it means the file shrank, and failing is correct.
    if (response.status === 416) {
      await response.body?.cancel().catch(() => undefined);
      if (segment.downloaded >= segment.end - segment.start + 1) {
        segment.done = true;
        return;
      }
      throw new Error(
        `Range request rejected: HTTP 416 (segment not complete)`,
      );
    }
    if (this.job.rangeSupported && response.status !== 206) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(
        `Range request rejected: HTTP ${response.status} (expected 206)`,
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    if (response.body === null) {
      segment.done = true;
      return;
    }
    const reader = response.body.getReader();
    try {
      while (true) {
        if (this.abortController.signal.aborted) throw new Error("aborted");
        const chunk = await reader.read();
        if (chunk.done) return;
        const value = chunk.value;
        // The segment may have been split while this stream was in flight.
        const writable = Math.min(
          value.byteLength,
          segment.end - (segment.start + segment.downloaded) + 1,
        );
        if (writable <= 0) return;
        const slice = writable === value.byteLength ? value : value.subarray(0, writable);
        await this.bucket.acquire(slice.byteLength);
        await this.handle.write(
          slice,
          0,
          slice.byteLength,
          segment.start + segment.downloaded,
        );
        segment.downloaded += slice.byteLength;
        if (segment.downloaded >= segment.end - segment.start + 1) {
          await reader.cancel().catch(() => undefined);
          return;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

export function newJobFromProbe(
  url: string,
  probeResult: Awaited<ReturnType<typeof probe>>,
  destination: string,
  options: DownloadOptions = {},
): JobState {
  const filename = basename(destination);
  const total = probeResult.totalBytes;
  // segments: 0 means "Auto" (0.7.0): size-based recommendation.
  const requested =
    options.segments === 0 && total !== null
      ? recommendSegments(total)
      : (options.segments ?? 8);
  const segments =
    total !== null && probeResult.rangeSupported
      ? planSegments(total, requested, options.minSegmentBytes ?? 256 * 1024)
      : [{ start: 0, end: total !== null ? total - 1 : Number.MAX_SAFE_INTEGER, downloaded: 0, done: false }];
  const partPath = `${destination}.part`;
  return {
    version: 1,
    id: randomUUID(),
    url,
    finalUrl: probeResult.finalUrl,
    destination,
    partPath,
    filename,
    category: categorize(filename, probeResult.contentType),
    totalBytes: total,
    rangeSupported: probeResult.rangeSupported,
    etag: probeResult.etag,
    lastModified: probeResult.lastModified,
    segments,
    downloadedBytes: 0,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    error: null,
  };
}

/** Start a fresh download. Probe first, then segment. */
export async function startDownload(
  url: string,
  destination: string,
  options: DownloadOptions = {},
): Promise<DownloadSession> {
  // 0.7.0 mirror failover starts at the probe: a dead primary must
  // not fail the job when a mirror answers. The working candidate
  // becomes the job's URL; segment fetches still retry the remaining
  // mirrors if this one dies mid-download.
  const candidates = [
    url,
    ...(options.mirrorUrls ?? []).filter((mirror) => mirror && mirror !== url),
  ];
  let probeResult: Awaited<ReturnType<typeof probe>> | null = null;
  let probedUrl = url;
  let lastProbeError: unknown = null;
  for (const candidate of candidates) {
    try {
      probeResult = await probe(candidate, options.headers ?? {});
      probedUrl = candidate;
      break;
    } catch (error) {
      lastProbeError = error;
    }
  }
  if (!probeResult) {
    throw lastProbeError instanceof Error
      ? lastProbeError
      : new Error("Probe failed for all URLs");
  }
  const filename = probeResult.filename ?? filenameFromUrl(probedUrl);
  const finalDestination =
    destination.endsWith("/") || destination.endsWith("\\")
      ? `${destination.replace(/[/\\]$/, "")}/${filename}`
      : destination;
  const job = newJobFromProbe(probedUrl, probeResult, finalDestination, options);
  const session = new DownloadSessionImpl(job, options);
  session.start().catch(() => undefined);
  return session;
}

/**
 * Resume from a .part journal. If the server file changed size/ETag, or
 * the .part file is gone, or Range is unsupported, restart from scratch
 * rather than silently producing a corrupt file.
 */
export async function resumeDownload(
  partPath: string,
  options: DownloadOptions = {},
): Promise<DownloadSession> {
  const existing = await loadJournal(partPath);
  if (!existing) {
    throw new Error(`No resumable journal found for ${partPath}`);
  }
  if (existing.status === "completed") return startDownload(existing.url, existing.destination, options);

  let job = existing;
  let needsRestart = false;
  try {
    const probeResult = await probe(existing.url, options.headers ?? existingHeaders(existing));
    if (
      existing.totalBytes !== null &&
      probeResult.totalBytes !== null &&
      probeResult.totalBytes !== existing.totalBytes
    ) {
      needsRestart = true;
    }
    if (
      existing.etag &&
      probeResult.etag &&
      probeResult.etag !== existing.etag
    ) {
      needsRestart = true;
    }
    if (!existing.rangeSupported) needsRestart = true;
    if (probeResult.rangeSupported !== existing.rangeSupported && existing.totalBytes !== null) {
      // Server behaviour changed; trust the fresh probe.
      job = { ...existing, rangeSupported: probeResult.rangeSupported, finalUrl: probeResult.finalUrl };
    }
  } catch {
    // Offline / probe failed: resume from the journal as-is, segment
    // fetches will surface the real error with retries.
  }
  const partSize = await stat(partPath)
    .then((info) => info.size)
    .catch(() => null);
  if (partSize === null) needsRestart = true;

  if (needsRestart) {
    await unlink(partPath).catch(() => undefined);
    await unlink(`${partPath}.json`).catch(() => undefined);
    const session = await startDownload(existing.url, existing.destination, options);
    return session;
  }
  // §8 reconciliation: the journal alone is not proof the bytes are
  // on disk. A .part file truncated after a crash used to be padded
  // with zeros by run()'s truncate() while the journal still claimed
  // those bytes downloaded — a silently corrupt "completed" file.
  // Clamp every segment to what the file actually contains, so the
  // missing bytes are re-downloaded instead of being skipped.
  for (const segment of job.segments) {
    if (
      !Number.isFinite(segment.start) ||
      !Number.isFinite(segment.end) ||
      !Number.isFinite(segment.downloaded) ||
      segment.start < 0 ||
      segment.end < segment.start ||
      segment.downloaded < 0
    ) {
      // Corrupt journal geometry cannot be repaired by clamping;
      // restart from scratch rather than produce a corrupt file.
      await unlink(partPath).catch(() => undefined);
      await unlink(`${partPath}.json`).catch(() => undefined);
      return startDownload(existing.url, existing.destination, options);
    }
    const length = segment.end - segment.start + 1;
    if (segment.downloaded > length) segment.downloaded = length;
    const required = segment.start + segment.downloaded;
    if (partSize !== null && required > partSize) {
      segment.downloaded = Math.max(0, partSize - segment.start);
    }
    segment.done = segment.downloaded >= length;
  }
  job.downloadedBytes = job.segments.reduce(
    (sum, segment) => sum + segment.downloaded,
    0,
  );
  job.status = "queued";
  job.error = null;
  const session = new DownloadSessionImpl(job, options);
  session.start().catch(() => undefined);
  return session;
}

function existingHeaders(job: JobState): Record<string, string> {
  // Headers are not persisted (they may contain auth). The extension
  // re-supplies them on resume; plain URL downloads need none.
  void job;
  return {};
}

export type { DownloadStatus };
