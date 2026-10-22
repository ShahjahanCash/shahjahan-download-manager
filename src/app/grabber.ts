/**
 * Site grabber: fetch a page and list every downloadable link it
 * contains, so the user can tick the ones they want instead of
 * copying URLs one by one. Pure extraction (unit-testable) is kept
 * separate from the fetch, which caps page size and time.
 */

export interface GrabbedLink {
  url: string;
  filename: string;
  kind: "media" | "image" | "document" | "archive" | "other";
}

const KIND_BY_EXT: Record<string, GrabbedLink["kind"]> = {
  mp4: "media", mkv: "media", webm: "media", mov: "media", avi: "media",
  flv: "media", mp3: "media", wav: "media", flac: "media", ogg: "media",
  jpg: "image", jpeg: "image", png: "image", gif: "image", webp: "image", svg: "image",
  pdf: "document", doc: "document", docx: "document", txt: "document",
  xls: "document", xlsx: "document", ppt: "document", pptx: "document",
  zip: "archive", rar: "archive", "7z": "archive", tar: "archive", gz: "archive",
  exe: "other", apk: "other", dmg: "other", iso: "other",
};

function kindFor(url: string): GrabbedLink["kind"] {
  const match = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url);
  if (!match) return "other";
  return KIND_BY_EXT[match[1]!.toLowerCase()] ?? "other";
}

function filenameFor(url: string): string {
  try {
    const path = new URL(url).pathname;
    const name = decodeURIComponent(path.split("/").pop() ?? "");
    return name || url;
  } catch {
    return url;
  }
}

/**
 * Extract candidate download links from HTML. Looks at href and src
 * attributes, resolves relative URLs against the page, drops
 * javascript:/mailto:/anchor links, and dedupes.
 */
export function extractLinks(html: string, pageUrl: string): GrabbedLink[] {
  const seen = new Set<string>();
  const out: GrabbedLink[] = [];
  const re = /(?:href|src)\s*=\s*"([^"]+)"|(?:href|src)\s*=\s*'([^']+)'/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const raw = (match[1] ?? match[2] ?? "").trim();
    if (!raw || raw.startsWith("#") || /^(javascript|mailto|tel|data):/i.test(raw)) continue;
    let absolute: string;
    try {
      absolute = new URL(raw, pageUrl).toString();
    } catch {
      continue;
    }
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    const filename = filenameFor(absolute);
    // Skip bare page links with no file extension — they are
    // navigation, not downloads — unless they look like media.
    const hasExt = /\.[a-z0-9]{2,5}(?:[?#]|$)/i.test(absolute);
    if (!hasExt) continue;
    out.push({ url: absolute, filename, kind: kindFor(absolute) });
  }
  return out;
}

/** Fetch a page (max 5 MiB, 20 s) and extract its links. */
export async function grabPageLinks(pageUrl: string): Promise<GrabbedLink[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(pageUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ShahjahanDM/1.0" },
    });
    if (!response.ok) throw new Error(`Page HTTP ${response.status} for ${pageUrl}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("html") && !contentType.includes("text")) {
      throw new Error("That URL is not a web page (no HTML content).");
    }
    const reader = response.body?.getReader();
    if (!reader) return [];
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > 5 * 1024 * 1024) throw new Error("Page is larger than 5 MiB; refusing to parse it.");
      chunks.push(chunk.value);
    }
    const html = Buffer.concat(chunks, total).toString("utf8");
    return extractLinks(html, response.url);
  } finally {
    clearTimeout(timer);
  }
}
