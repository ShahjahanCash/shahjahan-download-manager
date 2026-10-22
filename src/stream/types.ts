export interface StreamSegment {
  index: number;
  url: string;
  durationSeconds: number | null;
  /** AES-128 key URI, when the segment is encrypted. */
  keyUri: string | null;
  /** IV as hex (with or without 0x), or null to use the segment sequence. */
  keyIv: string | null;
  /** Bytes downloaded so far (streaming count, for progress). */
  downloaded: number;
  done: boolean;
}

export interface HlsVariant {
  url: string;
  bandwidth: number | null;
  width: number | null;
  height: number | null;
}

export interface HlsPlaylist {
  kind: "hls";
  isMaster: boolean;
  variants: HlsVariant[];
  segments: StreamSegment[];
  initSegmentUrl: string | null;
  /** False when the playlist has no EXT-X-ENDLIST (live) — not supported. */
  isVod: boolean;
}

export interface DashRepresentation {
  id: string | null;
  bandwidth: number | null;
  width: number | null;
  height: number | null;
  mimeType: string | null;
  codecs: string | null;
  /** Full media segment URLs, in order, plus init URL when present. */
  segmentUrls: string[];
  initUrl: string | null;
}

export interface DashManifest {
  kind: "dash";
  durationSeconds: number | null;
  video: DashRepresentation[];
  audio: DashRepresentation[];
}

export type StreamPlaylist = HlsPlaylist | DashManifest;

export interface StreamDownloadOptions {
  /** Explicit variant/media playlist URL (from the extension picker). */
  variantUrl?: string;
  /** DASH representation id to prefer, when present. */
  representationId?: string;
  /** Parallel segment workers. Default 4. */
  concurrency?: number;
  headers?: Record<string, string>;
  maxAttempts?: number;
  onProgress?: (progress: import("../engine/types.js").DownloadProgress) => void;
}

export interface StreamDownloadResult {
  status: "completed" | "paused" | "failed";
  /** Final output path (may differ from the requested destination on fallback). */
  destination: string;
  /** Extra outputs, e.g. separate DASH audio file when ffmpeg is absent. */
  extraOutputs: string[];
  segmentsDownloaded: number;
  totalSegments: number;
  downloadedBytes: number;
  remuxed: boolean;
  warning: string | null;
  error: string | null;
}
