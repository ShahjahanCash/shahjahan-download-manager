// Stream parsers for the Download Manager extension.
// Classic script (no imports/exports) so it can load in MAIN world,
// ISOLATED content scripts, and Node tests (via vm) alike.
// It attaches to globalThis as DMParsers and never touches chrome/DOM.
(function () {
  function resolveUrl(uri, base) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(uri)) return uri;
    try {
      return new URL(uri, base).toString();
    } catch {
      // Fallback for environments without a URL global (e.g. vm tests):
      // join against the base directory, preserving the origin for
      // root-relative URIs.
      const cleanBase = String(base || "").split("?")[0].split("#")[0];
      if (uri.startsWith("/")) {
        const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/]+/i.exec(cleanBase);
        return (origin ? origin[0] : "") + uri;
      }
      const dir = cleanBase.endsWith("/")
        ? cleanBase
        : cleanBase.slice(0, cleanBase.lastIndexOf("/") + 1);
      return dir + uri;
    }
  }

  function parseAttributes(line) {
    const attrs = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]+)/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      attrs[m[1]] = m[2].replace(/^"|"$/g, "");
    }
    return attrs;
  }

  function labelFor({ width, height, bandwidth, format }) {
    const parts = [];
    if (width && height) parts.push(`${width}x${height}`);
    if (bandwidth) parts.push(`${(bandwidth / 1_000_000).toFixed(1)} Mbps`);
    if (format) parts.push(format.toUpperCase());
    return parts.length ? parts.join(" · ") : "Stream";
  }

  // Parse an HLS master playlist. Media playlists (with #EXTINF) return
  // a single variant pointing at the playlist itself.
  function parseM3U8Master(text, baseUrl) {
    if (!text || typeof text !== "string") return [];
    const lines = text.split(/\r?\n/);
    if (lines.some((l) => l.trim().startsWith("#EXTINF"))) {
      return [{ url: baseUrl, format: "hls", label: "HLS stream", bandwidth: null, width: null, height: null }];
    }
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
      const attrs = parseAttributes(line.slice("#EXT-X-STREAM-INF:".length));
      const uri = (lines[i + 1] || "").trim();
      if (!uri || uri.startsWith("#")) continue;
      const bandwidth = attrs.BANDWIDTH ? Number(attrs.BANDWIDTH) : null;
      let width = null;
      let height = null;
      if (attrs.RESOLUTION) {
        const parts = attrs.RESOLUTION.split("x");
        width = Number(parts[0]) || null;
        height = Number(parts[1]) || null;
      }
      variants.push({
        url: resolveUrl(uri, baseUrl),
        format: "hls",
        bandwidth: Number.isFinite(bandwidth) ? bandwidth : null,
        width,
        height,
        label: labelFor({ width, height, bandwidth, format: "hls" }),
      });
    }
    // Sort best first so the picker shows the highest quality at top.
    variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    return variants;
  }

  // Parse a DASH MPD. Representation blocks carry bandwidth/size; the
  // BaseURL inside (or just after) the block is the media URL. If
  // nothing parseable is found, fall back to the MPD itself.
  function parseMpdVariants(xml, baseUrl) {
    if (!xml || typeof xml !== "string") return [];
    const variants = [];
    const repRe = /<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/g;
    let m;
    while ((m = repRe.exec(xml)) !== null) {
      const attrText = m[1] || "";
      const body = m[2] || "";
      const get = (name) => {
        // Anchor to a word boundary: "width" must not match inside
        // "bandwidth" (which contains "width" as a substring).
        const found = new RegExp(`(?:^|\\s)${name}="([^"]+)"`).exec(attrText);
        return found ? found[1] : null;
      };
      const bandwidth = get("bandwidth") ? Number(get("bandwidth")) : null;
      const width = get("width") ? Number(get("width")) : null;
      const height = get("height") ? Number(get("height")) : null;
      const mimeType = get("mimeType") || "";
      const baseUrlMatch = /<BaseURL[^>]*>([^<]+)<\/BaseURL>/.exec(body);
      const url = baseUrlMatch ? resolveUrl(baseUrlMatch[1].trim(), baseUrl) : baseUrl;
      const format = mimeType.includes("video") || !mimeType ? "dash" : "dash";
      variants.push({
        url,
        format,
        bandwidth: Number.isFinite(bandwidth) ? bandwidth : null,
        width: Number.isFinite(width) ? width : null,
        height: Number.isFinite(height) ? height : null,
        label: labelFor({ width, height, bandwidth, format: "dash" }),
      });
    }
    variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    if (variants.length) return variants;
    return [{ url: baseUrl, format: "dash", label: "DASH stream", bandwidth: null, width: null, height: null }];
  }

  function isStreamUrl(url) {
    if (typeof url !== "string") return null;
    const clean = url.split(/[?#]/)[0].toLowerCase();
    if (clean.endsWith(".m3u8")) return "hls";
    if (clean.endsWith(".mpd")) return "dash";
    if (/\.(mp4|webm|mov|mkv|avi)$/.test(clean)) return "progressive";
    return null;
  }

  globalThis.DMParsers = {
    resolveUrl,
    parseM3U8Master,
    parseMpdVariants,
    isStreamUrl,
  };
})();
