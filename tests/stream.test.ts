import { createCipheriv, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppDownloadManager } from "../src/app/manager.js";
import { parseHls } from "../src/stream/hls.js";
import { parseDash } from "../src/stream/dash.js";
import { downloadStream, resumeStream } from "../src/stream/downloader.js";

function segmentBytes(label: string, size = 32): Buffer {
  const buf = Buffer.alloc(size);
  buf.write(label);
  return buf;
}

describe("stream parsers", () => {
  it("parses an HLS master and picks the best variant first", () => {
    const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
high.m3u8
`;
    const parsed = parseHls(master, "https://example.com/hls/master.m3u8");
    expect(parsed.isMaster).toBe(true);
    expect(parsed.variants[0]!.url).toBe("https://example.com/hls/high.m3u8");
    expect(parsed.variants[0]!.width).toBe(1920);
  });

  it("parses DASH SegmentTemplate into segment URLs", () => {
    const mpd = `<?xml version="1.0"?>
<MPD mediaPresentationDuration="PT30S" type="static">
<Period><AdaptationSet mimeType="video/mp4">
<Representation id="v1" bandwidth="2000000" width="1280" height="720">
<SegmentTemplate timescale="1" duration="10" startNumber="1" media="video-$Number$.m4s" initialization="video-init.mp4"/>
</Representation>
</AdaptationSet></Period></MPD>`;
    const parsed = parseDash(mpd, "https://example.com/dash/manifest.mpd");
    expect(parsed.video.length).toBe(1);
    expect(parsed.video[0]!.segmentUrls).toEqual([
      "https://example.com/dash/video-1.m4s",
      "https://example.com/dash/video-2.m4s",
      "https://example.com/dash/video-3.m4s",
    ]);
    expect(parsed.video[0]!.initUrl).toBe("https://example.com/dash/video-init.mp4");
  });
});

describe("stream downloads (local server)", () => {
  it("assembles HLS TS segments, fMP4 segments, AES-128 segments, and DASH fallbacks", async () => {
    const key = Buffer.from("0123456789abcdef");
    const iv = Buffer.alloc(16, 0x11);
    const encrypt = (plain: Buffer): Buffer => {
      const cipher = createCipheriv("aes-128-cbc", key, iv);
      return Buffer.concat([cipher.update(plain), cipher.final()]);
    };

    const server = createServer((req, res) => {
      const url = req.url ?? "";
      if (url === "/hls/master.m3u8") {
        res.end("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720\nmedia.m3u8\n");
      } else if (url === "/hls/media.m3u8") {
        res.end("#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nseg0.ts\n#EXTINF:10,\nseg1.ts\n#EXTINF:10,\nseg2.ts\n#EXT-X-ENDLIST\n");
      } else if (url.startsWith("/hls/seg")) {
        const n = url.match(/seg(\d)\.ts/)?.[1];
        res.end(segmentBytes(`HLS-SEG${n}-`));
      } else if (url === "/fmp4/media.m3u8") {
        res.end("#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:10,\npart0.m4s\n#EXTINF:10,\npart1.m4s\n#EXT-X-ENDLIST\n");
      } else if (url === "/fmp4/init.mp4") {
        res.end(segmentBytes("FMP4-INIT-"));
      } else if (url.startsWith("/fmp4/part")) {
        const n = url.match(/part(\d)\.m4s/)?.[1];
        res.end(segmentBytes(`FMP4-PART${n}-`));
      } else if (url === "/enc/media.m3u8") {
        res.end("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\",IV=0x11111111111111111111111111111111\n#EXTINF:10,\nenc0.ts\n#EXTINF:10,\nenc1.ts\n#EXT-X-ENDLIST\n");
      } else if (url === "/enc/key.bin") {
        res.end(key);
      } else if (url.startsWith("/enc/enc")) {
        const n = url.match(/enc(\d)\.ts/)?.[1];
        res.end(encrypt(segmentBytes(`PLAIN-SEG${n}-`)));
      } else if (url === "/dash/manifest.mpd") {
        res.end(`<?xml version="1.0"?>
<MPD mediaPresentationDuration="PT20S" type="static"><Period>
<AdaptationSet mimeType="video/mp4"><Representation id="v1" bandwidth="2000000" width="1280" height="720">
<SegmentTemplate timescale="1" duration="10" startNumber="1" media="v-$Number$.m4s" initialization="v-init.mp4"/>
</Representation></AdaptationSet>
<AdaptationSet mimeType="audio/mp4"><Representation id="a1" bandwidth="128000">
<SegmentTemplate timescale="1" duration="10" startNumber="1" media="a-$Number$.m4s" initialization="a-init.mp4"/>
</Representation></AdaptationSet>
</Period></MPD>`);
      } else if (url === "/dash/v-init.mp4") {
        res.end(segmentBytes("DASH-V-INIT-"));
      } else if (url === "/dash/a-init.mp4") {
        res.end(segmentBytes("DASH-A-INIT-"));
      } else if (url.startsWith("/dash/v-")) {
        const n = url.match(/v-(\d)\.m4s/)?.[1];
        res.end(segmentBytes(`DASH-V${n}-`));
      } else if (url.startsWith("/dash/a-")) {
        const n = url.match(/a-(\d)\.m4s/)?.[1];
        res.end(segmentBytes(`DASH-A${n}-`));
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const dir = join(tmpdir(), `dm-stream-${randomBytes(4).toString("hex")}`);
    try {
      // HLS TS: dummy bytes are not valid TS, so ffmpeg remux must fail
      // and the downloader must fall back to a .ts file, not fail.
      const hls = await downloadStream(`${base}/hls/master.m3u8`, join(dir, "hls.mp4"));
      const hlsResult = await hls.done;
      expect(hlsResult.status).toBe("completed");
      expect(hlsResult.destination.endsWith(".ts")).toBe(true);
      expect(hlsResult.warning).toContain("ffmpeg");
      const hlsBytes = await readFile(hlsResult.destination);
      expect(hlsBytes.equals(Buffer.concat([
        segmentBytes("HLS-SEG0-"),
        segmentBytes("HLS-SEG1-"),
        segmentBytes("HLS-SEG2-"),
      ]))).toBe(true);

      // HLS fMP4: init + segments, no remux needed.
      const fmp4 = await downloadStream(`${base}/fmp4/media.m3u8`, join(dir, "fmp4.mp4"));
      const fmp4Result = await fmp4.done;
      expect(fmp4Result.status).toBe("completed");
      expect(fmp4Result.destination.endsWith(".mp4")).toBe(true);
      const fmp4Bytes = await readFile(fmp4Result.destination);
      expect(fmp4Bytes.equals(Buffer.concat([
        segmentBytes("FMP4-INIT-"),
        segmentBytes("FMP4-PART0-"),
        segmentBytes("FMP4-PART1-"),
      ]))).toBe(true);

      // AES-128: decrypted plaintext must equal the original segments.
      const enc = await downloadStream(`${base}/enc/media.m3u8`, join(dir, "enc.ts"));
      const encResult = await enc.done;
      expect(encResult.status).toBe("completed");
      const encBytes = await readFile(encResult.destination);
      expect(encBytes.equals(Buffer.concat([
        segmentBytes("PLAIN-SEG0-"),
        segmentBytes("PLAIN-SEG1-"),
      ]))).toBe(true);

      // DASH: dummy fMP4 bytes fail ffmpeg mux, so video+audio fall back
      // to separate files.
      const dash = await downloadStream(`${base}/dash/manifest.mpd`, join(dir, "dash.mp4"));
      const dashResult = await dash.done;
      expect(dashResult.status).toBe("completed");
      expect(dashResult.extraOutputs.length).toBe(1);
      const videoBytes = await readFile(dashResult.destination);
      expect(videoBytes.equals(Buffer.concat([
        segmentBytes("DASH-V-INIT-"),
        segmentBytes("DASH-V1-"),
        segmentBytes("DASH-V2-"),
      ]))).toBe(true);
      const audioBytes = await readFile(dashResult.extraOutputs[0]!);
      expect(audioBytes.equals(Buffer.concat([
        segmentBytes("DASH-A-INIT-"),
        segmentBytes("DASH-A1-"),
        segmentBytes("DASH-A2-"),
      ]))).toBe(true);

      // Manager integration: addStream completes and reports the job.
      const manager = new AppDownloadManager({ downloadsDir: dir });
      const job = await manager.addStream(`${base}/hls/media.m3u8`, {});
      const finished = await new Promise((resolve) => {
        const timer = setInterval(() => {
          const current = manager.get(job.id);
          if (current && (current.status === "completed" || current.status === "failed")) {
            clearInterval(timer);
            resolve(current);
          }
        }, 50);
      }) as ReturnType<typeof manager.get>;
      expect(finished?.status).toBe("completed");
    } finally {
      server.close();
    }
  });

  it("pauses and resumes an HLS stream from its journal", async () => {
    const server = createServer((req, res) => {
      const url = req.url ?? "";
      if (url === "/slow/media.m3u8") {
        res.end("#EXTM3U\n#EXTINF:10,\nslow0.ts\n#EXTINF:10,\nslow1.ts\n#EXT-X-ENDLIST\n");
      } else if (url === "/slow/slow0.ts") {
        // Drip-feed the first segment so pause can land mid-download.
        res.write(segmentBytes("SLOW0-", 8));
        setTimeout(() => {
          res.end(segmentBytes("SLOW0-", 8));
        }, 400);
      } else if (url === "/slow/slow1.ts") {
        res.end(segmentBytes("SLOW1-"));
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const dest = join(tmpdir(), `dm-stream-${randomBytes(4).toString("hex")}`, "slow.ts");
    try {
      const session = await downloadStream(`${base}/slow/media.m3u8`, dest);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const paused = await session.pause();
      expect(paused.status).toBe("paused");
      const resumed = await resumeStream(dest);
      const result = await resumed.done;
      expect(result.status).toBe("completed");
      const bytes = await readFile(result.destination);
      expect(bytes.equals(Buffer.concat([segmentBytes("SLOW0-", 8), segmentBytes("SLOW0-", 8), segmentBytes("SLOW1-")]))).toBe(true);
    } finally {
      server.close();
    }
  });
});
