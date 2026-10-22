import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function ffmpegAvailable(): Promise<boolean> {
  try {
    await execFileAsync("ffmpeg", ["-version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Remux/mux with ffmpeg, stream-copy only (no re-encode).
 * Returns false on any failure — callers fall back to concatenated
 * output instead of failing the whole download because of remux.
 */
export async function ffmpegCopy(inputs: string[], output: string): Promise<boolean> {
  const args: string[] = ["-y"];
  for (const input of inputs) args.push("-i", input);
  args.push("-c", "copy", output);
  try {
    await execFileAsync("ffmpeg", args, { timeout: 10 * 60 * 1000 });
    return true;
  } catch {
    return false;
  }
}
