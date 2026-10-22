import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface ToolPaths {
  ytDlp: string | null;
  ffmpeg: string | null;
}

export interface ToolSearchDirs {
  /** Packaged Electron resources dir (process.resourcesPath). */
  resourcesPath?: string;
  /** Electron userData dir (for on-demand installs). */
  userData?: string;
  /** Dev fallback: the electron/ folder (main.mjs lives there). */
  devDir?: string;
  /** True when running from the installed app (asar). */
  isPackaged?: boolean;
}

function exeName(base: string): string {
  return process.platform === "win32" ? `${base}.exe` : base;
}

function firstExisting(paths: string[]): string | null {
  for (const candidate of paths) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

function onPath(tool: string): Promise<string | null> {
  return new Promise((resolve) => {
    const command = process.platform === "win32" ? "where" : "which";
    execFile(command, [tool], { timeout: 5000 }, (error, stdout) => {
      if (error) return resolve(null);
      const first = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      resolve(first ?? null);
    });
  });
}

/**
 * Locate yt-dlp and ffmpeg, in priority order:
 * bundled (asar.unpacked when packaged, electron/build/bin in dev) →
 * userData/bin (on-demand installs) → system PATH → null.
 */
export async function findTools(dirs: ToolSearchDirs = {}): Promise<ToolPaths> {
  const ytExe = exeName("yt-dlp");
  const ffExe = exeName("ffmpeg");
  const bundled: string[] = [];
  if (dirs.isPackaged && dirs.resourcesPath) {
    bundled.push(join(dirs.resourcesPath, "app.asar.unpacked", "electron", "build", "bin"));
  }
  if (dirs.devDir) bundled.push(join(dirs.devDir, "build", "bin"));
  const userBin = dirs.userData ? join(dirs.userData, "bin") : null;

  const ytDlp =
    firstExisting(bundled.map((dir) => join(dir, ytExe))) ??
    (userBin ? firstExisting([join(userBin, ytExe)]) : null) ??
    (await onPath(ytExe));
  const ffmpeg =
    firstExisting(bundled.map((dir) => join(dir, ffExe))) ??
    (userBin ? firstExisting([join(userBin, ffExe)]) : null) ??
    (await onPath(ffExe));
  return { ytDlp, ffmpeg };
}
