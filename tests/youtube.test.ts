import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildYtDlpArgs } from "../src/yt/options.js";
import { parseYtProgressLine, parseDestinationLine } from "../src/yt/progress.js";
import { YoutubeSession } from "../src/yt/session.js";

const URL = "https://www.youtube.com/watch?v=abc12345678";

describe("yt-dlp argument building", () => {
  it("builds a best-quality video command", () => {
    const { args, warnings } = buildYtDlpArgs(URL, { kind: "video" }, "out/%(title)s.%(ext)s", "/ffmpeg");
    expect(args).toContain("-f");
    expect(args).toContain("bv*+ba/b");
    expect(args).toContain("--no-playlist");
    expect(args).toContain("--ffmpeg-location");
    expect(warnings).toHaveLength(0);
  });

  it("caps video quality and remuxes to MP4 when ffmpeg exists", () => {
    const { args } = buildYtDlpArgs(URL, { kind: "video", quality: "1080", container: "mp4" }, "out/x", "/ffmpeg");
    expect(args).toContain("bv*[height<=1080]+ba/b[height<=1080]");
    expect(args).toContain("--remux-video");
    expect(args[args.indexOf("--remux-video") + 1]).toBe("mp4");
  });

  it("skips ffmpeg-gated features with a warning when ffmpeg is missing", () => {
    const { args, warnings } = buildYtDlpArgs(URL, { kind: "video", quality: "1080", container: "mp4" }, "out/x", null);
    expect(args).not.toContain("--remux-video");
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("builds an audio-extraction command", () => {
    const { args } = buildYtDlpArgs(URL, { kind: "audio", audioFormat: "mp3", audioQuality: "192" }, "out/x", "/ffmpeg");
    expect(args).toContain("-x");
    expect(args).toContain("--audio-format");
    expect(args).toContain("mp3");
    expect(args).toContain("192K");
  });

  it("adds subtitles, playlist range and SponsorBlock", () => {
    const { args } = buildYtDlpArgs(
      URL,
      {
        kind: "video",
        subtitles: ["en"],
        autoSubtitles: true,
        embedSubtitles: true,
        playlist: true,
        playlistStart: 3,
        playlistEnd: 7,
        sponsorBlock: true,
      },
      "out/x",
      "/ffmpeg",
    );
    expect(args).toContain("--write-subs");
    expect(args).toContain("--write-auto-subs");
    expect(args).toContain("--embed-subs");
    expect(args).toContain("--yes-playlist");
    expect(args).toContain("3-7");
    expect(args).toContain("--sponsorblock-remove");
  });
});

describe("yt-dlp progress parsing", () => {
  it("parses percent, size, speed and ETA", () => {
    const parsed = parseYtProgressLine("[download]  42.3% of 123.45MiB at 1.23MiB/s ETA 00:30");
    expect(parsed).not.toBeNull();
    expect(parsed!.percent).toBe(42.3);
    expect(parsed!.totalBytes).toBe(129446707);
    expect(parsed!.speedBytesPerSec).toBe(1289748);
    expect(parsed!.etaSeconds).toBe(30);
  });

  it("parses a finished line and ignores post-processing lines", () => {
    expect(parseYtProgressLine("[download] 100% of 10.00MiB in 00:05")?.percent).toBe(100);
    expect(parseYtProgressLine("[Merger] Merging formats into \"x.mp4\"")).toBeNull();
    expect(parseDestinationLine("[download] Destination: C:\\Videos\\song [abc].mp4")).toBe("C:\\Videos\\song [abc].mp4");
  });
});

async function fakeYtDlp(dir: string, slow: boolean): Promise<string> {
  const script = join(dir, "fake-ytdlp");
  const body = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const oIndex = args.indexOf("-o");
const out = oIndex >= 0 ? args[oIndex + 1] : "out.bin";
const slow = process.env.YT_FAKE_SLOW === "1";
const steps = slow ? [5, 10, 15, 20] : [10, 50, 100];
for (const p of steps) {
  console.log("[download]  " + p + ".0% of 10.00MiB at 1.00MiB/s ETA 00:05");
  await new Promise((r) => setTimeout(r, slow ? 300 : 20));
}
console.log("[download] Destination: " + out);
writeFileSync(out, "hello-youtube");
`;
  await writeFile(script, body);
  await chmod(script, 0o755);
  void slow;
  return script;
}

describe("YoutubeSession (fake yt-dlp)", () => {
  it("completes and reports the finished file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dm-yt-"));
    const fake = await fakeYtDlp(dir, false);
    const outTemplate = join(dir, "video [abc123].mp4");
    const { args } = buildYtDlpArgs(URL, { kind: "video" }, outTemplate, null);
    const session = new YoutubeSession({
      jobId: "job-1",
      ytDlp: fake,
      args,
      outDir: dir,
      expectedFilename: null,
      videoId: "abc123",
    });
    session.start();
    const result = await session.done;
    expect(result.status).toBe("completed");
    expect(await readFile(result.destination, "utf8")).toBe("hello-youtube");
    await rm(dir, { recursive: true, force: true });
  });

  it("pauses when killed mid-download", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dm-yt-"));
    const fake = await fakeYtDlp(dir, true);
    const outTemplate = join(dir, "video [abc123].mp4");
    const { args } = buildYtDlpArgs(URL, { kind: "video" }, outTemplate, null);
    const session = new YoutubeSession({
      jobId: "job-2",
      ytDlp: fake,
      args,
      outDir: dir,
      expectedFilename: null,
      videoId: "abc123",
    });
    process.env.YT_FAKE_SLOW = "1";
    try {
      session.start();
      await new Promise((resolve) => setTimeout(resolve, 500));
      session.pause();
      const result = await session.done;
      expect(result.status).toBe("paused");
    } finally {
      delete process.env.YT_FAKE_SLOW;
    }
    await rm(dir, { recursive: true, force: true });
  });
});
