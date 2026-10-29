/**
 * YouTube download options and yt-dlp argument building.
 * Pure functions (no spawning) so the UI, manager and tests share
 * exactly the same command line. Format strings use yt-dlp's
 * documented selector syntax.
 */

export type YoutubeKind = "video" | "audio";

export interface YoutubeOptions {
  kind: YoutubeKind;
  /** Video quality cap, e.g. "best", "2160", "1080", "720". Ignored for audio. */
  quality?: string;
  /** Frame rate: "best" (any) | "60" (prefer 60 fps, fall back to best
   * at or below the height cap when the video offers no 60 fps format)
   * | "30" (cap at 30 fps). Ignored for audio. */
  fps?: string;
  /** Preferred container for merged video: "mp4" | "webm" | "best". */
  container?: string;
  /** Audio format for audio-only: "mp3" | "m4a" | "opus" | "wav" | "flac". */
  audioFormat?: string;
  /** Audio quality: "best" | "320" | "192" | "128" (kbps). */
  audioQuality?: string;
  /** Subtitle languages, e.g. ["en"]; ["all"] = every language. */
  subtitles?: string[];
  /** Also fetch auto-generated subtitles. */
  autoSubtitles?: boolean;
  /** Embed subtitles into the video file (needs ffmpeg). */
  embedSubtitles?: boolean;
  /** Download the full playlist instead of one video. */
  playlist?: boolean;
  /** Playlist range, 1-based, e.g. { start: 3, end: 7 }. */
  playlistStart?: number;
  playlistEnd?: number;
  /** Embed the video thumbnail (needs ffmpeg; otherwise saved beside). */
  embedThumbnail?: boolean;
  /** Embed metadata and chapters (needs ffmpeg). */
  embedMetadata?: boolean;
  /** Remove sponsor segments via SponsorBlock (needs ffmpeg). */
  sponsorBlock?: boolean;
  /** Parallel fragment downloads for HLS/DASH (default 4; 1 = off).
   * The default matters: callers that don't set it (extension,
   * bridge) used to get sequential fragments, which is the classic
   * slow-YouTube-download shape. */
  concurrentFragments?: number;
  /** Browser to read cookies from (yt-dlp --cookies-from-browser),
   * e.g. "chrome" | "edge" | "firefox" | "brave". Unlocks
   * age-restricted / login-only videos the browser can play. */
  cookiesFromBrowser?: string;
  /** Path to a Netscape-format cookies.txt file (--cookies). */
  cookiesFile?: string;
  /** HTTP(S) proxy URL passed to yt-dlp (--proxy). */
  proxy?: string;
  /** Download speed cap in bytes/s (yt-dlp --limit-rate). */
  limitRate?: number;
}

function videoFormat(quality: string | undefined, fps: string | undefined): string {
  const height = quality && quality !== "best" ? Number(quality) : NaN;
  const h = Number.isFinite(height) && height > 0 ? `[height<=${height}]` : "";
  if (fps === "60") {
    // Prefer an exact 60 fps format; the "/" fallback keeps the
    // download working on videos that only offer lower frame rates.
    return `bv*${h}[fps=60]+ba/bv*${h}+ba/b${h}`;
  }
  if (fps === "30") return `bv*${h}[fps<=30]+ba/b${h}`;
  return `bv*${h}+ba/b${h}`;
}

/**
 * Build the yt-dlp argument list for a download. `ffmpegPath` is null
 * when ffmpeg is unavailable: ffmpeg-gated features (remux, embed,
 * SponsorBlock) are then skipped rather than failing the download,
 * and the caller reports that in the job warning.
 */
export function buildYtDlpArgs(
  url: string,
  options: YoutubeOptions,
  outputTemplate: string,
  ffmpegPath: string | null,
): { args: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const args: string[] = ["--newline", "--no-warnings", "-o", outputTemplate];
  const hasFfmpeg = ffmpegPath !== null;
  if (hasFfmpeg) args.push("--ffmpeg-location", ffmpegPath);
  if (options.proxy) args.push("--proxy", options.proxy);
  if (options.limitRate && options.limitRate > 0) {
    args.push("--limit-rate", String(Math.floor(options.limitRate)));
  }
  // Cookies unlock age-restricted / login-only videos. A cookies file
  // wins over the browser (explicit export beats the browser store).
  if (options.cookiesFile) args.push("--cookies", options.cookiesFile);
  else if (options.cookiesFromBrowser && options.cookiesFromBrowser !== "none") {
    args.push("--cookies-from-browser", options.cookiesFromBrowser);
  }

  if (options.playlist) {
    args.push("--yes-playlist", "--ignore-errors");
    if (options.playlistStart !== undefined || options.playlistEnd !== undefined) {
      const start = options.playlistStart ?? 1;
      const end = options.playlistEnd ?? "";
      args.push("--playlist-items", `${start}-${end}`);
    }
  } else {
    args.push("--no-playlist");
  }

  if (options.kind === "audio") {
    args.push("-x", "--audio-format", options.audioFormat ?? "mp3");
    const quality = options.audioQuality;
    if (quality && quality !== "best") args.push("--audio-quality", `${quality}K`);
    else args.push("--audio-quality", "0");
  } else {
    args.push("-f", videoFormat(options.quality, options.fps));
    const container = options.container;
    if (container && container !== "best") {
      if (hasFfmpeg) args.push("--remux-video", container);
      else warnings.push(`Container ${container} needs ffmpeg; keeping the source container.`);
    }
  }

  const fragments = options.concurrentFragments ?? 4;
  if (fragments > 1) args.push("--concurrent-fragments", String(Math.floor(fragments)));

  if (options.subtitles && options.subtitles.length > 0) {
    args.push("--write-subs", "--sub-langs", options.subtitles.join(","));
    if (options.autoSubtitles) args.push("--write-auto-subs");
    if (options.embedSubtitles) {
      if (hasFfmpeg) args.push("--embed-subs");
      else warnings.push("Embedding subtitles needs ffmpeg; subtitles are saved as separate files.");
    }
  }

  if (options.embedThumbnail) {
    if (hasFfmpeg) args.push("--embed-thumbnail");
    else args.push("--write-thumbnail");
  }
  if (options.embedMetadata) {
    if (hasFfmpeg) args.push("--embed-metadata", "--embed-chapters");
    else warnings.push("Embedding metadata/chapters needs ffmpeg; skipped.");
  }
  if (options.sponsorBlock) {
    if (hasFfmpeg) args.push("--sponsorblock-remove", "sponsor");
    else warnings.push("SponsorBlock removal needs ffmpeg; skipped.");
  }

  args.push(url);
  return { args, warnings };
}

/** Filename template inside a folder (playlist gets an index prefix). */
export function outputTemplateFor(outDir: string, playlist: boolean): string {
  const name = playlist
    ? "%(playlist_index)02d - %(title)s [%(id)s].%(ext)s"
    : "%(title)s [%(id)s].%(ext)s";
  return `${outDir}/${name}`;
}

/** Video quality choices shown in the UI (heights the info fetch refines). */
export const VIDEO_QUALITIES = ["best", "2160", "1440", "1080", "720", "480", "360"] as const;
export const SUBTITLE_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "ur", label: "Urdu" },
  { code: "hi", label: "Hindi" },
  { code: "ar", label: "Arabic" },
  { code: "all", label: "All languages" },
] as const;
