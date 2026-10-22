import { execFile } from "node:child_process";

export interface YoutubeInfo {
  id: string | null;
  title: string;
  uploader: string | null;
  thumbnail: string | null;
  durationSeconds: number | null;
  isPlaylist: boolean;
  playlistCount: number | null;
  /** Available video heights, descending (e.g. [1080, 720]). */
  heights: number[];
  hasAudio: boolean;
}

interface RawFormat {
  height?: number | null;
  vcodec?: string | null;
  acodec?: string | null;
}

interface RawInfo {
  id?: string | null;
  _type?: string;
  title?: string;
  uploader?: string | null;
  thumbnail?: string | null;
  duration?: number | null;
  formats?: RawFormat[];
  entries?: unknown[];
  playlist_count?: number | null;
}

function runJson(ytDlp: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(ytDlp, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(new Error(`yt-dlp info fetch failed: ${error.message}`));
        return;
      }
      resolve(stdout);
    });
    child.on("error", (error) => reject(new Error(`Could not run yt-dlp: ${error.message}`)));
  });
}

/**
 * Fetch a video/playlist's metadata without downloading anything.
 * --flat-playlist keeps playlist entries light (title/id only).
 */
export async function fetchYoutubeInfo(ytDlp: string, url: string): Promise<YoutubeInfo> {
  const stdout = await runJson(
    ytDlp,
    ["--dump-single-json", "--flat-playlist", "--no-warnings", "--no-playlist", url],
    90_000,
  ).catch(async () => {
    // --no-playlist rejects pure playlist URLs; retry as a playlist.
    return runJson(
      ytDlp,
      ["--dump-single-json", "--flat-playlist", "--no-warnings", "--yes-playlist", url],
      90_000,
    );
  });
  let raw: RawInfo;
  try {
    raw = JSON.parse(stdout) as RawInfo;
  } catch {
    throw new Error("yt-dlp returned metadata that could not be read.");
  }
  const isPlaylist = raw._type === "playlist";
  const heights = new Set<number>();
  let hasAudio = false;
  for (const format of raw.formats ?? []) {
    if (format.height && format.vcodec && format.vcodec !== "none") heights.add(format.height);
    if (format.acodec && format.acodec !== "none") hasAudio = true;
  }
  return {
    id: raw.id ?? null,
    title: raw.title ?? "YouTube video",
    uploader: raw.uploader ?? null,
    thumbnail: raw.thumbnail ?? null,
    durationSeconds: typeof raw.duration === "number" ? Math.round(raw.duration) : null,
    isPlaylist,
    playlistCount: isPlaylist
      ? (typeof raw.playlist_count === "number" ? raw.playlist_count : (raw.entries?.length ?? null))
      : null,
    heights: [...heights].sort((a, b) => b - a),
    hasAudio,
  };
}
