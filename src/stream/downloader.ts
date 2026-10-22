import { randomUUID, createDecipheriv } from "node:crypto";
import { mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseDash } from "./dash.js";
import { ffmpegAvailable, ffmpegCopy } from "./ffmpeg.js";
import { parseHls } from "./hls.js";
import type {
  StreamDownloadOptions,
  StreamDownloadResult,
  StreamSegment,
} from "./types.js";
import type { DownloadProgress } from "../engine/types.js";
import { retryOnLock } from "../engine/fileOps.js";
import { winLongPath } from "../engine/paths.js";
import { sleep } from "../engine/types.js";

export interface StreamSession {
  readonly sessionId: string;
  readonly done: Promise<StreamDownloadResult>;
  pause(): Promise<StreamDownloadResult>;
  progress(): DownloadProgress;
}

interface Track {
  name: string;
  initUrl: string | null;
  initDone: boolean;
  segments: StreamSegment[];
}

interface StreamJournal {
  version: 1;
  kind: "hls" | "dash";
  url: string;
  destination: string;
  partDir: string;
  tracks: Track[];
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message.includes("aborted"))
  );
}

function journalPath(destination: string): string {
  return `${destination}.stream.json`;
}

function partDirFor(destination: string): string {
  return `${destination}.stream-parts`;
}

function segmentPath(partDir: string, track: string, index: number): string {
  return join(partDir, `${track}-${index}.bin`);
}

function replaceExtension(path: string, newExt: string): string {
  const dot = path.lastIndexOf(".");
  if (dot <= 0) return `${path}${newExt}`;
  return `${path.slice(0, dot)}${newExt}`;
}

async function saveJournalFile(destination: string, journal: StreamJournal): Promise<void> {
  const tmp = `${journalPath(destination)}.tmp`;
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(tmp, JSON.stringify(journal, null, 2), "utf8");
  await retryOnLock(() => rename(winLongPath(tmp), winLongPath(journalPath(destination))));
}

async function loadJournalFile(destination: string): Promise<StreamJournal | null> {
  try {
    const raw = await readFile(journalPath(destination), "utf8");
    const parsed = JSON.parse(raw) as StreamJournal;
    if (parsed.version !== 1 || !Array.isArray(parsed.tracks)) return null;
    return parsed;
  } catch {
    return null;
  }
}

class StreamSessionImpl implements StreamSession {
  readonly sessionId = randomUUID();
  readonly done: Promise<StreamDownloadResult>;
  private readonly abortController = new AbortController();
  private readonly options: Required<Pick<StreamDownloadOptions, "concurrency" | "maxAttempts">> & StreamDownloadOptions;
  private readonly journal: StreamJournal;
  private readonly claimed = new Set<StreamSegment>();
  private readonly keyCache = new Map<string, Buffer>();
  private timer: NodeJS.Timeout | null = null;
  private lastBytes = 0;
  private lastAt = Date.now();
  private speed = 0;
  private resolveDone!: (result: StreamDownloadResult) => void;
  private rejectDone!: (error: unknown) => void;
  private warning: string | null = null;

  constructor(journal: StreamJournal, options: StreamDownloadOptions = {}) {
    this.journal = journal;
    this.options = {
      ...options,
      concurrency: options.concurrency ?? 4,
      maxAttempts: options.maxAttempts ?? 3,
    };
    this.done = new Promise<StreamDownloadResult>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    this.done.catch(() => undefined);
  }

  async start(): Promise<StreamDownloadResult> {
    try {
      const result = await this.run();
      this.resolveDone(result);
      return result;
    } catch (error) {
      if (isAbort(error)) {
        const result = await this.finishPaused();
        this.resolveDone(result);
        return result;
      }
      const result: StreamDownloadResult = {
        status: "failed",
        destination: this.journal.destination,
        extraOutputs: [],
        segmentsDownloaded: this.completedCount(),
        totalSegments: this.totalCount(),
        downloadedBytes: this.downloadedBytes(),
        remuxed: false,
        warning: this.warning,
        error: error instanceof Error ? error.message : String(error),
      };
      await this.save().catch(() => undefined);
      if (this.timer) clearInterval(this.timer);
      this.rejectDone(error);
      throw error;
    }
  }

  async pause(): Promise<StreamDownloadResult> {
    this.abortController.abort();
    return this.done;
  }

  progress(): DownloadProgress {
    const total = this.totalCount();
    const completed = this.completedCount();
    const downloaded = this.downloadedBytes();
    const segments = this.journal.tracks.flatMap((track) =>
      track.segments.map((segment) => ({
        start: segment.index,
        end: segment.index,
        downloaded: segment.done ? 1 : 0,
        done: segment.done,
      })),
    );
    return {
      jobId: this.sessionId,
      status: "downloading",
      downloadedBytes: downloaded,
      totalBytes: null,
      percent: total ? completed / total : null,
      speedBytesPerSec: this.speed,
      etaSeconds: null,
      segments,
      error: null,
    };
  }

  private totalCount(): number {
    return this.journal.tracks.reduce((sum, track) => sum + track.segments.length, 0);
  }

  private completedCount(): number {
    return this.journal.tracks.reduce(
      (sum, track) => sum + track.segments.filter((s) => s.done).length,
      0,
    );
  }

  private downloadedBytes(): number {
    return this.journal.tracks.reduce(
      (sum, track) => sum + track.segments.reduce((s, seg) => s + seg.downloaded, 0),
      0,
    );
  }

  private async save(): Promise<void> {
    await saveJournalFile(this.journal.destination, this.journal);
  }

  private async finishPaused(): Promise<StreamDownloadResult> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.save().catch(() => undefined);
    return {
      status: "paused",
      destination: this.journal.destination,
      extraOutputs: [],
      segmentsDownloaded: this.completedCount(),
      totalSegments: this.totalCount(),
      downloadedBytes: this.downloadedBytes(),
      remuxed: false,
      warning: this.warning,
      error: null,
    };
  }

  private async run(): Promise<StreamDownloadResult> {
    await mkdir(this.journal.partDir, { recursive: true });
    this.timer = setInterval(() => {
      void this.tick();
    }, 250);
    this.timer.unref?.();

    // Download init segments first (small, needed for fMP4).
    for (const track of this.journal.tracks) {
      if (track.initUrl && !track.initDone) {
        await this.downloadInit(track);
      }
    }

    const workers = Array.from({ length: this.options.concurrency }, () => this.worker());
    await Promise.all(workers);
    if (this.abortController.signal.aborted) throw new Error("aborted");
    if (!this.journal.tracks.every((track) => track.segments.every((s) => s.done))) {
      throw new Error("Stream ended with unfinished segments");
    }

    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this.assemble();
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const downloaded = this.downloadedBytes();
    const elapsedSec = Math.max(0.001, (now - this.lastAt) / 1000);
    const instant = (downloaded - this.lastBytes) / elapsedSec;
    this.speed = this.speed === 0 ? instant : this.speed * 0.7 + instant * 0.3;
    this.lastBytes = downloaded;
    this.lastAt = now;
    await this.save().catch(() => undefined);
    this.options.onProgress?.(this.progress());
  }

  private async worker(): Promise<void> {
    while (!this.abortController.signal.aborted) {
      let segment: StreamSegment | null = null;
      let track: Track | null = null;
      for (const candidateTrack of this.journal.tracks) {
        const found = candidateTrack.segments.find((s) => !s.done && !this.claimed.has(s));
        if (found) {
          segment = found;
          track = candidateTrack;
          break;
        }
      }
      if (!segment || !track) return;
      this.claimed.add(segment);
      try {
        await this.downloadSegment(track, segment);
      } finally {
        this.claimed.delete(segment);
      }
    }
  }

  private async downloadInit(track: Track): Promise<void> {
    if (!track.initUrl) return;
    const path = join(this.journal.partDir, `${track.name}-init.bin`);
    if (existsSync(path)) {
      track.initDone = true;
      return;
    }
    const response = await fetch(track.initUrl, {
      headers: this.options.headers ?? {},
      signal: this.abortController.signal,
    });
    if (!response.ok) throw new Error(`Init segment HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    await writeFile(path, bytes);
    track.initDone = true;
  }

  private async downloadSegment(track: Track, segment: StreamSegment): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt++) {
      if (this.abortController.signal.aborted) throw new Error("aborted");
      try {
        await this.downloadSegmentOnce(track, segment);
        segment.done = true;
        return;
      } catch (error) {
        if (isAbort(error)) throw error;
        lastError = error;
        if (attempt < this.options.maxAttempts) await sleep(500 * 2 ** (attempt - 1));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Segment download failed");
  }

  private async downloadSegmentOnce(track: Track, segment: StreamSegment): Promise<void> {
    const response = await fetch(segment.url, {
      headers: this.options.headers ?? {},
      signal: this.abortController.signal,
    });
    if (!response.ok) throw new Error(`Segment HTTP ${response.status} for ${segment.url}`);
    if (response.body === null) throw new Error("Segment has no body");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        chunks.push(chunk.value);
        total += chunk.value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    let bytes: Buffer<ArrayBufferLike> = Buffer.concat(chunks, total);
    if (segment.keyUri) {
      bytes = await this.decryptSegment(segment, bytes);
    }
    const path = segmentPath(this.journal.partDir, track.name, segment.index);
    await writeFile(path, bytes);
    segment.downloaded = bytes.byteLength;
  }

  private async decryptSegment(segment: StreamSegment, encrypted: Buffer): Promise<Buffer> {
    if (!segment.keyUri) return encrypted;
    let key = this.keyCache.get(segment.keyUri);
    if (!key) {
      const response = await fetch(segment.keyUri, {
        headers: this.options.headers ?? {},
        signal: this.abortController.signal,
      });
      if (!response.ok) throw new Error(`Key HTTP ${response.status}`);
      key = Buffer.from(await response.arrayBuffer());
      this.keyCache.set(segment.keyUri, key);
    }
    if (key.length !== 16) throw new Error("AES-128 key must be 16 bytes");
    let iv: Buffer;
    if (segment.keyIv) {
      const hex = segment.keyIv.replace(/^0x/i, "").padStart(32, "0");
      iv = Buffer.from(hex, "hex");
    } else {
      iv = Buffer.alloc(16);
      iv.writeBigUInt64BE(BigInt(segment.index), 8);
    }
    const decipher = createDecipheriv("aes-128-cbc", key, iv);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }

  private async concatTrack(track: Track, outputPath: string): Promise<void> {
    const handle = await open(outputPath, "w");
    try {
      // FileHandle.write appends at the current position, in order.
      // (writeFile would truncate/replace on each call — do not use it here.)
      if (track.initUrl) {
        const initPath = join(this.journal.partDir, `${track.name}-init.bin`);
        const initBytes = await readFile(initPath);
        await handle.write(initBytes);
      }
      for (const segment of [...track.segments].sort((a, b) => a.index - b.index)) {
        const bytes = await readFile(segmentPath(this.journal.partDir, track.name, segment.index));
        await handle.write(bytes);
      }
    } finally {
      await handle.close();
    }
  }

  private async assemble(): Promise<StreamDownloadResult> {
    const destination = this.journal.destination;
    const isDash = this.journal.kind === "dash";
    const hasInit = this.journal.tracks.some((t) => t.initUrl);

    if (!isDash) {
      const track = this.journal.tracks[0]!;
      if (hasInit) {
        // fMP4: init + segments is already a valid MP4, no remux needed.
        const finalDest = destination.endsWith(".m3u8") || destination.endsWith(".mpd")
          ? replaceExtension(destination, ".mp4")
          : destination;
        await this.concatTrack(track, finalDest);
        await this.cleanup();
        return {
          status: "completed",
          destination: finalDest,
          extraOutputs: [],
          segmentsDownloaded: this.completedCount(),
          totalSegments: this.totalCount(),
          downloadedBytes: this.downloadedBytes(),
          remuxed: false,
          warning: null,
          error: null,
        };
      }
      // MPEG-TS: concat, then try remux to MP4 if the user asked for .mp4.
      const concatPath = join(this.journal.partDir, "concat.ts");
      await this.concatTrack(track, concatPath);
      if (destination.endsWith(".mp4")) {
        if (await ffmpegAvailable()) {
          const ok = await ffmpegCopy([concatPath], destination);
          if (ok) {
            await this.cleanup();
            return {
              status: "completed",
              destination,
              extraOutputs: [],
              segmentsDownloaded: this.completedCount(),
              totalSegments: this.totalCount(),
              downloadedBytes: this.downloadedBytes(),
              remuxed: true,
              warning: null,
              error: null,
            };
          }
        }
        const tsDest = replaceExtension(destination, ".ts");
        await retryOnLock(() => rename(winLongPath(concatPath), winLongPath(tsDest)));
        await this.cleanup();
        return {
          status: "completed",
          destination: tsDest,
          extraOutputs: [],
          segmentsDownloaded: this.completedCount(),
          totalSegments: this.totalCount(),
          downloadedBytes: this.downloadedBytes(),
          remuxed: false,
          warning: "ffmpeg remux to MP4 failed or ffmpeg is not installed; saved as MPEG-TS instead.",
          error: null,
        };
      }
      await retryOnLock(() => rename(winLongPath(concatPath), winLongPath(destination)));
      await this.cleanup();
      return {
        status: "completed",
        destination,
        extraOutputs: [],
        segmentsDownloaded: this.completedCount(),
        totalSegments: this.totalCount(),
        downloadedBytes: this.downloadedBytes(),
        remuxed: false,
        warning: null,
        error: null,
      };
    }

    // DASH: video + optional audio.
    const videoTrack = this.journal.tracks[0]!;
    const audioTrack = this.journal.tracks[1];
    const videoTemp = join(this.journal.partDir, "video.mp4");
    await this.concatTrack(videoTrack, videoTemp);
    if (!audioTrack) {
      await retryOnLock(() => rename(winLongPath(videoTemp), winLongPath(destination)));
      await this.cleanup();
      return {
        status: "completed",
        destination,
        extraOutputs: [],
        segmentsDownloaded: this.completedCount(),
        totalSegments: this.totalCount(),
        downloadedBytes: this.downloadedBytes(),
        remuxed: false,
        warning: null,
        error: null,
      };
    }
    const audioTemp = join(this.journal.partDir, "audio.m4a");
    await this.concatTrack(audioTrack, audioTemp);
    if (await ffmpegAvailable()) {
      const ok = await ffmpegCopy([videoTemp, audioTemp], destination);
      if (ok) {
        await this.cleanup();
        return {
          status: "completed",
          destination,
          extraOutputs: [],
          segmentsDownloaded: this.completedCount(),
          totalSegments: this.totalCount(),
          downloadedBytes: this.downloadedBytes(),
          remuxed: true,
          warning: null,
          error: null,
        };
      }
    }
    const audioDest = destination.replace(/(\.[^.]+)$/, "_audio$1");
    await retryOnLock(() => rename(winLongPath(videoTemp), winLongPath(destination)));
    await retryOnLock(() => rename(winLongPath(audioTemp), winLongPath(audioDest)));
    await this.cleanup();
    return {
      status: "completed",
      destination,
      extraOutputs: [audioDest],
      segmentsDownloaded: this.completedCount(),
      totalSegments: this.totalCount(),
      downloadedBytes: this.downloadedBytes(),
      remuxed: false,
      warning: "ffmpeg mux failed or ffmpeg is not installed; video and audio saved as separate files.",
      error: null,
    };
  }

  private async cleanup(): Promise<void> {
    await retryOnLock(() => rm(winLongPath(this.journal.partDir), { recursive: true, force: true }));
    await unlink(journalPath(this.journal.destination)).catch(() => undefined);
  }
}

async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`Manifest HTTP ${response.status} for ${url}`);
  return response.text();
}

/** Build a stream plan from a URL, then start downloading it. */
export async function downloadStream(
  url: string,
  destination: string,
  options: StreamDownloadOptions = {},
): Promise<StreamSession> {
  const headers = options.headers ?? {};
  const manifestUrl = options.variantUrl ?? url;
  const manifestText = await fetchText(manifestUrl, headers);
  const isHls = manifestUrl.includes(".m3u8") || manifestText.trimStart().startsWith("#EXTM3U");
  const isDash = manifestUrl.includes(".mpd") || manifestText.includes("<MPD");

  let journal: StreamJournal;
  if (isHls) {
    let playlist = parseHls(manifestText, manifestUrl);
    if (playlist.isMaster) {
      const variant = options.variantUrl
        ? playlist.variants.find((v) => v.url === options.variantUrl)
        : playlist.variants[0];
      if (!variant) throw new Error("No HLS variant found in master playlist");
      const mediaText = await fetchText(variant.url, headers);
      playlist = parseHls(mediaText, variant.url);
    }
    if (!playlist.isVod) throw new Error("Live HLS streams are not supported (no EXT-X-ENDLIST)");
    if (playlist.segments.length === 0) throw new Error("HLS playlist has no segments");
    journal = {
      version: 1,
      kind: "hls",
      url,
      destination,
      partDir: partDirFor(destination),
      tracks: [{ name: "main", initUrl: playlist.initSegmentUrl, initDone: false, segments: playlist.segments }],
    };
  } else if (isDash) {
    if (/type="dynamic"/.test(manifestText)) {
      throw new Error("Live DASH streams are not supported");
    }
    const manifest = parseDash(manifestText, manifestUrl);
    if (manifest.video.length === 0) throw new Error("DASH manifest has no video representation");
    const video = options.representationId
      ? manifest.video.find((r) => r.id === options.representationId) ?? manifest.video[0]!
      : manifest.video[0]!;
    const audio = manifest.audio[0];
    const tracks: Track[] = [
      {
        name: "video",
        initUrl: video.initUrl,
        initDone: false,
        segments: video.segmentUrls.map((segmentUrl, i) => ({
          index: i,
          url: segmentUrl,
          durationSeconds: null,
          keyUri: null,
          keyIv: null,
          downloaded: 0,
          done: false,
        })),
      },
    ];
    if (audio) {
      tracks.push({
        name: "audio",
        initUrl: audio.initUrl,
        initDone: false,
        segments: audio.segmentUrls.map((segmentUrl, i) => ({
          index: i,
          url: segmentUrl,
          durationSeconds: null,
          keyUri: null,
          keyIv: null,
          downloaded: 0,
          done: false,
        })),
      });
    }
    journal = { version: 1, kind: "dash", url, destination, partDir: partDirFor(destination), tracks };
  } else {
    throw new Error("URL is neither an HLS (.m3u8) nor DASH (.mpd) manifest");
  }

  const session = new StreamSessionImpl(journal, options);
  session.start().catch(() => undefined);
  return session;
}

/** Resume a stream from its .stream.json journal. */
export async function resumeStream(
  destination: string,
  options: StreamDownloadOptions = {},
): Promise<StreamSession> {
  const journal = await loadJournalFile(destination);
  if (!journal) throw new Error(`No resumable stream journal found for ${destination}`);
  // Mark segments whose part files are missing as not done.
  for (const track of journal.tracks) {
    if (track.initUrl && !existsSync(join(journal.partDir, `${track.name}-init.bin`))) {
      track.initDone = false;
    }
    for (const segment of track.segments) {
      if (segment.done && !existsSync(segmentPath(journal.partDir, track.name, segment.index))) {
        segment.done = false;
        segment.downloaded = 0;
      }
    }
  }
  const session = new StreamSessionImpl(journal, options);
  session.start().catch(() => undefined);
  return session;
}

export function streamJournalPath(destination: string): string {
  return journalPath(destination);
}
