import type { HlsPlaylist, HlsVariant, StreamSegment } from "./types.js";

export function resolveUrl(uri: string, base: string): string {
  try {
    return new URL(uri, base).toString();
  } catch {
    return uri;
  }
}

function parseAttributes(line: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    attrs[m[1]!] = m[2]!.replace(/^"|"$/g, "");
  }
  return attrs;
}

/** Parse an HLS playlist, master or media. */
export function parseHls(text: string, baseUrl: string): HlsPlaylist {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const isMaster = lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"));
  const variants: HlsVariant[] = [];
  const segments: StreamSegment[] = [];
  let initSegmentUrl: string | null = null;
  let isVod = false;
  let currentKeyUri: string | null = null;
  let currentKeyIv: string | null = null;
  let pendingDuration: number | null = null;
  let mediaSequence = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequence = Number(line.split(":")[1]) || 0;
    } else if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const attrs = parseAttributes(line.slice("#EXT-X-STREAM-INF:".length));
      const uri = lines[i + 1] ?? "";
      if (uri && !uri.startsWith("#")) {
        const bandwidth = attrs["BANDWIDTH"] ? Number(attrs["BANDWIDTH"]) : null;
        let width: number | null = null;
        let height: number | null = null;
        if (attrs["RESOLUTION"]) {
          const parts = attrs["RESOLUTION"].split("x");
          width = Number(parts[0]) || null;
          height = Number(parts[1]) || null;
        }
        variants.push({
          url: resolveUrl(uri, baseUrl),
          bandwidth: Number.isFinite(bandwidth) ? bandwidth : null,
          width,
          height,
        });
      }
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const attrs = parseAttributes(line.slice("#EXT-X-MAP:".length));
      if (attrs["URI"]) initSegmentUrl = resolveUrl(attrs["URI"], baseUrl);
    } else if (line.startsWith("#EXT-X-KEY:")) {
      const attrs = parseAttributes(line.slice("#EXT-X-KEY:".length));
      if (attrs["METHOD"] === "AES-128" && attrs["URI"]) {
        currentKeyUri = resolveUrl(attrs["URI"], baseUrl);
        currentKeyIv = attrs["IV"] ?? null;
      } else if (attrs["METHOD"] === "NONE") {
        currentKeyUri = null;
        currentKeyIv = null;
      } else if (attrs["METHOD"] && attrs["METHOD"] !== "AES-128") {
        // SAMPLE-AES and other methods are DRM-adjacent and unsupported.
        throw new Error(`Unsupported HLS encryption method: ${attrs["METHOD"]}`);
      }
    } else if (line.startsWith("#EXTINF:")) {
      pendingDuration = Number(line.slice("#EXTINF:".length).split(",")[0]) || null;
    } else if (line.startsWith("#EXT-X-ENDLIST")) {
      isVod = true;
    } else if (line && !line.startsWith("#")) {
      // Index is the media sequence number, which is also the AES-128
      // IV fallback when EXT-X-KEY has no explicit IV.
      const index = mediaSequence + segments.length;
      segments.push({
        index,
        url: resolveUrl(line, baseUrl),
        durationSeconds: pendingDuration,
        keyUri: currentKeyUri,
        keyIv: currentKeyIv,
        downloaded: 0,
        done: false,
      });
      pendingDuration = null;
      void mediaSequence;
    }
  }

  return {
    kind: "hls",
    isMaster,
    variants: variants.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0)),
    segments,
    initSegmentUrl,
    isVod: isMaster ? true : isVod,
  };
}
