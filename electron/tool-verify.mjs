// Tool-install checksum verification — Phase 2 of the 1.0.4 upgrade.
// Pure module (no Electron import) so it is unit-testable, like ipc-guard.
//
// Sources, verified live Oct 30, 2026:
// - yt-dlp: the same release that serves yt-dlp.exe also serves
//   SHA2-256SUMS, a GNU-style file ("<hash>  <filename>" per line).
//   URL: https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS
// - ffmpeg (gyan.dev): the builds page serves a .sha256 file next to the
//   zip, containing a single 64-hex hash (it redirects to a versioned
//   packages/...zip.sha256 URL, which the HTTPS downloader follows).
//   URL: https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256
//
// Fail-closed by design: if the expected hash cannot be found, or the
// downloaded hash does not match, verification throws and the caller must
// NOT install the file. The previously installed tool is only replaced
// after a successful verification, so a mismatch leaves it intact.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

// Parse a GNU-style sums file ("<hash>  file" or "<hash> *file") and
// return the hash for `filename`, or null when the entry is absent.
export function parseSha256Sums(text, filename) {
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = line.match(/^([0-9a-fA-F]{64})[ \t]+\*?(.+?)[ \t]*$/);
    if (!match) continue;
    const entry = match[2];
    if (entry === filename || entry.endsWith(`/${filename}`) || entry.endsWith(`\\${filename}`)) {
      return match[1].toLowerCase();
    }
  }
  return null;
}

// A gyan .sha256 file is a single 64-hex hash (plus whitespace/newline).
export function parseSingleSha256(text) {
  const match = String(text ?? "").match(/[0-9a-fA-F]{64}/);
  return match ? match[0].toLowerCase() : null;
}

export async function verifyFileSha256(path, expected, label) {
  if (!expected || typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected.toLowerCase())) {
    throw new Error(`No official SHA-256 available for ${label}; refusing to install an unverified file.`);
  }
  const actual = await sha256File(path);
  if (actual !== expected.toLowerCase()) {
    throw new Error(`Checksum mismatch for ${label}: the downloaded file does not match its official SHA-256. The previously installed tool was kept.`);
  }
}
