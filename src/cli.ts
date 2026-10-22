#!/usr/bin/env node
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { formatBytes, formatEta } from "./app/format.js";
import { categorize } from "./engine/categories.js";
import { resumeDownload, startDownload } from "./engine/downloader.js";
import { downloadStream } from "./stream/downloader.js";
import { loadJournal } from "./engine/journal.js";
import { probe } from "./engine/probe.js";
import type { DownloadProgress } from "./engine/types.js";

function renderProgress(p: DownloadProgress): string {
  const pct = p.percent === null ? "  ?%" : `${(p.percent * 100).toFixed(1)}%`;
  const total = p.totalBytes === null ? "?" : formatBytes(p.totalBytes);
  const chunks = p.segments
    .map((segment) => {
      const length = segment.end - segment.start + 1;
      const filled = Math.min(100, Math.round((segment.downloaded / length) * 100));
      return `${filled}%`;
    })
    .join(" ");
  return (
    `\r${pct} ${formatBytes(p.downloadedBytes)}/${total} ` +
    `${formatBytes(Math.round(p.speedBytesPerSec))}/s ETA ${formatEta(p.etaSeconds)} ` +
    `chunks [${chunks}]`
  );
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=");
      flags[key!] = inline ?? args[++i] ?? "";
    }
  }
  return flags;
}

function uniquePath(path: string): string {
  if (!existsSync(path) && !existsSync(`${path}.part`)) return path;
  const dot = path.lastIndexOf(".");
  const base = dot > 0 ? path.slice(0, dot) : path;
  const ext = dot > 0 ? path.slice(dot) : "";
  let n = 1;
  while (existsSync(`${base} (${n})${ext}`)) n++;
  return `${base} (${n})${ext}`;
}

async function cmdAdd(url: string, rest: string[]): Promise<void> {
  const flags = parseFlags(rest);
  const dir = flags["dir"] ?? "downloads";
  const segments = flags["segments"] ? Number(flags["segments"]) : 8;
  const speedLimit = flags["limit"] ? Number(flags["limit"]) : 0;
  const info = await probe(url);
  const filename = info.filename ?? basename(new URL(url).pathname) ?? "download";
  // Category follows the actual saved name, not the server name, when --out renames it.
  const category = categorize(
    flags["out"] ? basename(flags["out"]!) : filename,
    info.contentType,
  );
  const destination = flags["out"]
    ? flags["out"]!
    : uniquePath(join(dir, category, filename));
  // No mkdir here: the engine creates dirname(partPath) on start, so a
  // custom --out does not leave a stray empty category folder behind.
  console.log(`Downloading ${url}`);
  console.log(`  -> ${destination} (${category}, ${info.totalBytes === null ? "unknown size" : formatBytes(info.totalBytes)}, range: ${info.rangeSupported})`);

  const session = await startDownload(url, destination, {
    segments,
    speedLimitBytesPerSec: speedLimit,
    onProgress: (p) => process.stdout.write(renderProgress(p)),
  });
  let pausing = false;
  process.on("SIGINT", () => {
    if (pausing) process.exit(130);
    pausing = true;
    console.log("\nPausing… (press Ctrl+C again to force quit)");
    void session.pause().then(() => {
      console.log(`Paused. Resume with: npm run cli -- resume ${destination}.part`);
      process.exit(0);
    });
  });
  try {
    const job = await session.done;
    process.stdout.write("\n");
    console.log(`Done: ${job.destination} (${formatBytes(job.downloadedBytes)})`);
  } catch (error) {
    process.stdout.write("\n");
    console.error(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`Resume with: npm run cli -- resume ${destination}.part`);
    process.exitCode = 1;
  }
}

async function cmdResume(arg: string): Promise<void> {
  const partPath = arg.endsWith(".part") ? arg : `${arg}.part`;
  console.log(`Resuming ${partPath}`);
  const session = await resumeDownload(partPath, {
    onProgress: (p) => process.stdout.write(renderProgress(p)),
  });
  let pausing = false;
  process.on("SIGINT", () => {
    if (pausing) process.exit(130);
    pausing = true;
    console.log("\nPausing…");
    void session.pause().then(() => process.exit(0));
  });
  try {
    const job = await session.done;
    process.stdout.write("\n");
    console.log(`Done: ${job.destination}`);
  } catch (error) {
    process.stdout.write("\n");
    console.error(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

async function cmdStatus(arg: string): Promise<void> {
  const partPath = arg.endsWith(".part") ? arg : `${arg}.part`;
  const job = await loadJournal(partPath);
  if (!job) {
    if (existsSync(arg)) {
      console.log(`Completed: ${arg} exists, no resume journal left.`);
      return;
    }
    console.log(`No job found for ${arg}`);
    return;
  }
  console.log(`${job.filename} [${job.category}] — ${job.status}`);
  console.log(`  URL: ${job.url}`);
  console.log(`  Destination: ${job.destination}`);
  console.log(
    `  Progress: ${formatBytes(job.downloadedBytes)} / ${job.totalBytes === null ? "?" : formatBytes(job.totalBytes)} (range: ${job.rangeSupported})`,
  );
  console.log(
    `  Chunks: ${job.segments.map((s) => `${Math.round((s.downloaded / Math.max(1, s.end - s.start + 1)) * 100)}%`).join(" ")}`,
  );
  if (job.error) console.log(`  Error: ${job.error}`);
}

async function cmdBridge(rest: string[]): Promise<void> {
  const flags = parseFlags(rest);
  const { AppDownloadManager } = await import("./app/manager.js");
  const { BridgeServer } = await import("./bridge/server.js");
  const { writeBridgeInfo, deleteBridgeInfo } = await import("./bridge/bridgeInfo.js");
  const downloadsDir = flags["dir"] ?? "downloads";
  let server: {
    broadcast: (event: string, data: unknown) => void;
    start: () => Promise<{ port: number; token: string; host: string; version: 1 }>;
    stop: () => Promise<void>;
  } | null = null;
  const manager = new AppDownloadManager({
    downloadsDir,
    onProgress: (p) => server?.broadcast("progress", p),
    onJobsChanged: (jobs) => server?.broadcast("jobs", jobs),
  });
  server = new BridgeServer(manager, {
    downloadsDir,
    ...(flags["port"] ? { port: Number(flags["port"]) } : {}),
  });
  const info = await server.start();
  await writeBridgeInfo(info);
  const { bridgeInfoPath } = await import("./bridge/bridgeInfo.js");
  console.log(`Bridge running on http://127.0.0.1:${info.port} (token in ${bridgeInfoPath()})`);
  console.log("Press Ctrl+C to stop.");
  const shutdown = async () => {
    await server.stop().catch(() => undefined);
    await deleteBridgeInfo().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  // Keep the process alive; the HTTP server holds the event loop.
  await new Promise(() => undefined);
}

async function cmdNativeHost(): Promise<void> {
  const { runNativeHost } = await import("./bridge/nativeHost.js");
  await runNativeHost();
}

async function cmdBridgeInfo(): Promise<void> {
  const { readBridgeInfo, bridgeInfoPath } = await import("./bridge/bridgeInfo.js");
  const info = await readBridgeInfo();
  if (!info) {
    console.log(`No bridge running (no file at ${bridgeInfoPath()})`);
    return;
  }
  console.log(`Bridge: http://${info.host}:${info.port} (token present, not printed)`);
}

async function cmdInstallHost(rest: string[]): Promise<void> {
  const flags = parseFlags(rest);
  const browser = flags["browser"] ?? "chrome";
  if (!["chrome", "edge", "firefox"].includes(browser)) {
    throw new Error("--browser must be chrome, edge, or firefox");
  }
  const extensionId = flags["extension-id"];
  const outDir = flags["out"] ?? ".";
  const { chromeHostManifest, firefoxHostManifest, windowsRegFile } =
    await import("./bridge/manifests.js");
  const { BRIDGE_HOST_NAME } = await import("./bridge/protocol.js");
  // The host entry point is this CLI itself: `node dist/cli.js native-host`.
  // Electron's packaged app would point here to its bundled Node instead.
  const hostPath = `${process.execPath} ${join(process.cwd(), "dist", "cli.js")} native-host`;
  const manifest =
    browser === "firefox"
      ? firefoxHostManifest({ hostPath, ...(extensionId ? { extensionId } : {}) })
      : chromeHostManifest({ hostPath, extensionId: extensionId ?? "REPLACE_WITH_EXTENSION_ID" });
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(outDir, { recursive: true });
  const manifestPath = join(outDir, `${BRIDGE_HOST_NAME}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  const regPath = join(outDir, `${BRIDGE_HOST_NAME}.reg`);
  await writeFile(
    regPath,
    windowsRegFile(browser as "chrome" | "edge" | "firefox", manifestPath),
  );
  console.log(`Wrote manifest: ${manifestPath}`);
  console.log(`Wrote Windows registry file: ${regPath} (double-click it on Windows to register)`);
  if (browser !== "firefox" && !extensionId) {
    console.log("Warning: re-run with --extension-id <id> once the Phase 5 extension id is known.");
  }
}

async function cmdStream(url: string, rest: string[]): Promise<void> {
  const flags = parseFlags(rest);
  const out = flags["out"] ?? join("downloads", "Video", "stream.mp4");
  const session = await downloadStream(url, out, {
    ...(flags["variant"] ? { variantUrl: flags["variant"] } : {}),
    ...(flags["concurrency"] ? { concurrency: Number(flags["concurrency"]) } : {}),
    onProgress: (p) => {
      const pct = p.percent === null ? "  ?%" : `${(p.percent * 100).toFixed(1)}%`;
      process.stdout.write(
        `\r${pct} segments ${p.segments.filter((s) => s.done).length}/${p.segments.length} ` +
          `${formatBytes(p.downloadedBytes)} ${formatBytes(Math.round(p.speedBytesPerSec))}/s`,
      );
    },
  });
  const result = await session.done;
  console.log(`\nStream ${result.status}: ${result.destination}`);
  if (result.remuxed) console.log("Remuxed/muxed with ffmpeg.");
  if (result.warning) console.log(`Note: ${result.warning}`);
  if (result.extraOutputs.length) console.log(`Extra outputs: ${result.extraOutputs.join(", ")}`);
}

function usage(): void {
  console.log(`Usage:
  dm add <url> [--out <path>] [--dir <dir>] [--segments <n>] [--limit <bytes/sec>]
  dm stream <manifest-url> [--out <path>] [--variant <url>] [--concurrency <n>]
  dm resume <destination-or-.part>
  dm status <destination-or-.part>
  dm bridge [--dir <dir>] [--port <n>]
  dm native-host
  dm bridge-info
  dm install-host --browser chrome|edge|firefox [--extension-id <id>] [--out <dir>]`);
}

async function main(): Promise<void> {
  // FIX (audit): flag-only commands (bridge, install-host) were losing
  // their first flag, because the old dispatch treated argv[3] as a
  // positional arg for every command. add/resume/status take a
  // positional; the others take only flags.
  const [command, ...rest] = process.argv.slice(2);
  if (command === "add" && rest[0]) await cmdAdd(rest[0], rest.slice(1));
  else if (command === "stream" && rest[0]) await cmdStream(rest[0], rest.slice(1));
  else if (command === "resume" && rest[0]) await cmdResume(rest[0]);
  else if (command === "status" && rest[0]) await cmdStatus(rest[0]);
  else if (command === "bridge") await cmdBridge(rest);
  else if (command === "native-host") await cmdNativeHost();
  else if (command === "bridge-info") await cmdBridgeInfo();
  else if (command === "install-host") await cmdInstallHost(rest);
  else usage();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
