/** Parse yt-dlp's --newline download lines into numbers. */

export interface YtProgress {
  percent: number;
  totalBytes: number | null;
  speedBytesPerSec: number;
  etaSeconds: number | null;
}

const SIZE_UNITS: Record<string, number> = {
  B: 1,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
};

function toBytes(value: number, unit: string): number {
  return Math.round(value * (SIZE_UNITS[unit] ?? 1));
}

function parseEta(text: string): number | null {
  const parts = text.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  return null;
}

/**
 * Example lines:
 *   [download]  42.3% of 123.45MiB at 1.23MiB/s ETA 00:30
 *   [download] 100% of 123.45MiB in 00:42
 * Returns null for non-progress lines (merger, post-processing…).
 */
export function parseYtProgressLine(line: string): YtProgress | null {
  const match = /\[download\]\s+(\d+(?:\.\d+)?)% of\s+~?\s*([\d.]+)\s*(B|KiB|MiB|GiB|TiB)(?:\s+at\s+([\d.]+)\s*(B|KiB|MiB|GiB|TiB)\/s)?(?:\s+ETA\s+(\d+:\d+(?::\d+)?))?/.exec(line);
  if (!match) return null;
  const percent = Number(match[1]);
  const totalBytes = toBytes(Number(match[2]), match[3]!);
  const speedBytesPerSec = match[4] && match[5] ? toBytes(Number(match[4]), match[5]) : 0;
  const etaSeconds = match[6] ? parseEta(match[6]) : null;
  return { percent, totalBytes, speedBytesPerSec, etaSeconds };
}

/** "[download] Destination: C:\…\file.mp4" → the file path, else null. */
export function parseDestinationLine(line: string): string | null {
  const match = /\[download\] Destination: (.+?)\s*$/.exec(line);
  return match ? match[1]! : null;
}
