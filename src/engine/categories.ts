import { extname } from "node:path";
import type { DownloadCategory } from "./types.js";

const BY_EXTENSION: Record<string, DownloadCategory> = {
  // Video
  mp4: "Video", mkv: "Video", webm: "Video", mov: "Video", avi: "Video",
  m3u8: "Video", mpd: "Video", ts: "Video", flv: "Video", wmv: "Video",
  // Audio
  mp3: "Audio", wav: "Audio", flac: "Audio", ogg: "Audio", m4a: "Audio",
  opus: "Audio", aac: "Audio",
  // Documents
  pdf: "Documents", doc: "Documents", docx: "Documents", xls: "Documents",
  xlsx: "Documents", ppt: "Documents", pptx: "Documents", txt: "Documents",
  epub: "Documents", md: "Documents",
  // Compressed
  zip: "Compressed", rar: "Compressed", "7z": "Compressed", tar: "Compressed",
  gz: "Compressed", bz2: "Compressed", xz: "Compressed",
  // Programs
  exe: "Programs", msi: "Programs", dmg: "Programs", apk: "Programs",
  deb: "Programs", rpm: "Programs", iso: "Programs", bin: "Programs",
};

export function categorize(
  filename: string,
  contentType: string | null,
): DownloadCategory {
  const ext = extname(filename).replace(/^\./, "").toLowerCase();
  if (ext && BY_EXTENSION[ext]) return BY_EXTENSION[ext]!;
  if (contentType) {
    if (contentType.startsWith("video/")) return "Video";
    if (contentType.startsWith("audio/")) return "Audio";
    if (contentType.startsWith("application/pdf")) return "Documents";
    if (contentType.includes("zip") || contentType.includes("compressed"))
      return "Compressed";
  }
  return "General";
}

export function filenameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const base = decodeURIComponent(pathname.split("/").filter(Boolean).pop() ?? "");
    return base || "download";
  } catch {
    return "download";
  }
}

export function filenameFromContentDisposition(
  header: string | null,
): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      return star[1].trim();
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i.exec(header);
  const value = plain?.[1] ?? plain?.[2];
  return value ? value.trim() : null;
}
