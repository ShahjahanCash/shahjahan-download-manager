import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

const EXT = new URL("../extension/", import.meta.url).pathname;

function read(name: string): string {
  return readFileSync(join(EXT, name), "utf8");
}

// parsers.js assigns to globalThis, so evaluating it in a fresh vm
// context and reading the context's DMParsers is the correct path.
function parsers() {
  const context = createContext({ console, URL });
  runInContext(read("lib/parsers.js"), context);
  return (context as unknown as {
    DMParsers: {
      parseM3U8Master: (text: string, base: string) => Array<Record<string, unknown>>;
      parseMpdVariants: (xml: string, base: string) => Array<Record<string, unknown>>;
      isStreamUrl: (url: string) => string | null;
    };
  }).DMParsers;
}

describe("extension manifests", () => {
  it("Chrome manifest is MV3 with the required permissions and scripts", () => {
    const manifest = JSON.parse(read("manifest.json")) as Record<string, unknown>;
    expect(manifest["manifest_version"]).toBe(3);
    const permissions = manifest["permissions"] as string[];
    expect(permissions).toContain("downloads");
    expect(permissions).toContain("nativeMessaging");
    expect(permissions).toContain("cookies");
    const background = manifest["background"] as { service_worker: string };
    expect(background.service_worker).toBe("background.js");
    const contentScripts = manifest["content_scripts"] as Array<{ js: string[] }>;
    const allScripts = contentScripts.flatMap((cs) => cs.js);
    expect(allScripts).toContain("content.js");
    expect(allScripts).toContain("injected.js");
    expect(allScripts).toContain("lib/parsers.js");
    for (const script of allScripts) expect(existsSync(join(EXT, script))).toBe(true);
    const icons = manifest["icons"] as Record<string, string>;
    for (const icon of Object.values(icons)) expect(existsSync(join(EXT, icon))).toBe(true);
    expect(existsSync(join(EXT, "popup.html"))).toBe(true);
  });

  it("Firefox manifest has a gecko id and MV3", () => {
    const manifest = JSON.parse(read("manifest.firefox.json")) as Record<string, unknown>;
    expect(manifest["manifest_version"]).toBe(3);
    const gecko = (manifest["browser_specific_settings"] as { gecko: { id: string } }).gecko;
    expect(gecko.id).toBe("download-manager@local");
  });
});

describe("extension behaviour (static + parsers)", () => {
  it("background intercepts downloads only after a successful ping", () => {
    const background = read("background.js");
    expect(background).toContain("connectNative");
    expect(background).toContain("downloads.onCreated");
    expect(background).toContain("downloads.cancel");
    expect(background).toContain("blob:");
    expect(background).toContain("contextMenus");
  });

  it("content script draws a Shadow DOM overlay with a quality menu", () => {
    const content = read("content.js");
    expect(content).toContain("Download this video");
    expect(content).toContain("attachShadow");
    expect(content).toContain("MutationObserver");
    expect(content).toContain("dm_list_videos");
  });

  it("injected script hooks fetch/XHR and detects HLS/DASH", () => {
    const injected = read("injected.js");
    expect(injected).toContain(".m3u8");
    expect(injected).toContain(".mpd");
    expect(injected).toContain("window.fetch");
    expect(injected).toContain("XMLHttpRequest");
  });

  it("parses an HLS master playlist into sorted variants", () => {
    const p = parsers();
    const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.64001f,mp4a.40.2"
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
high.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
mid.m3u8
`;
    const variants = p.parseM3U8Master(master, "https://example.com/hls/master.m3u8");
    expect(variants.length).toBe(3);
    expect(variants[0]!.url).toBe("https://example.com/hls/high.m3u8");
    expect(variants[0]!.width).toBe(1920);
    expect(variants[0]!.height).toBe(1080);
    expect(variants[2]!.url).toBe("https://example.com/hls/low.m3u8");
    expect(p.isStreamUrl("https://example.com/a.m3u8")).toBe("hls");
    expect(p.isStreamUrl("https://example.com/a.mp4")).toBe("progressive");
    expect(p.isStreamUrl("https://example.com/page.html")).toBeNull();
  });

  it("parses a DASH MPD into representations", () => {
    const p = parsers();
    const mpd = `<?xml version="1.0"?>
<MPD><Period><AdaptationSet mimeType="video/mp4">
<Representation id="1" bandwidth="1000000" width="1280" height="720"><BaseURL>720.mp4</BaseURL></Representation>
<Representation id="2" bandwidth="5000000" width="1920" height="1080"><BaseURL>1080.mp4</BaseURL></Representation>
</AdaptationSet></Period></MPD>`;
    const variants = p.parseMpdVariants(mpd, "https://example.com/dash/manifest.mpd");
    expect(variants.length).toBe(2);
    expect(variants[0]!.url).toBe("https://example.com/dash/1080.mp4");
    expect(variants[0]!.width).toBe(1920);
  });

  it("media playlists fall back to a single variant", () => {
    const p = parsers();
    const media = "#EXTM3U\n#EXTINF:10,\nsegment0.ts\n";
    const variants = p.parseM3U8Master(media, "https://example.com/hls/media.m3u8");
    expect(variants.length).toBe(1);
    expect(variants[0]!.url).toBe("https://example.com/hls/media.m3u8");
  });
});
