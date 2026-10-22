/**
 * Post-download auto-extract (0.7.0) — command builders only.
 *
 * ZIP uses PowerShell's built-in Expand-Archive (no third-party tool
 * needed on Windows). RAR needs 7-Zip on PATH; when it is absent the
 * builder returns null and the job records "extractor missing" instead
 * of failing. Nothing here runs anything: the manager spawns the
 * returned command on Windows only, so this module is safe to import
 * and test on Linux.
 */

export type ArchiveKind = "zip" | "rar" | null;

/** Archive kind from a filename, or null when not an archive we handle. */
export function archiveKind(filename: string): ArchiveKind {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".rar")) return "rar";
  return null;
}

export interface ExtractCommand {
  command: string;
  args: string[];
  /** Human label shown on the job, e.g. "PowerShell Expand-Archive". */
  tool: string;
}

/**
 * Build the extraction command for a downloaded archive. Returns null
 * for unsupported archives, or for RAR when 7-Zip availability is
 * unknown (pass has7Zip: true once the caller checked PATH).
 */
export function extractCommand(
  archivePath: string,
  outDir: string,
  opts: { has7Zip?: boolean } = {},
): ExtractCommand | null {
  const kind = archiveKind(archivePath);
  if (kind === "zip") {
    return {
      command: "powershell",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Expand-Archive",
        "-LiteralPath",
        archivePath,
        "-DestinationPath",
        outDir,
        "-Force",
      ],
      tool: "PowerShell Expand-Archive",
    };
  }
  if (kind === "rar") {
    if (!opts.has7Zip) return null;
    return {
      command: "7z",
      args: ["x", archivePath, `-o${outDir}`, "-y"],
      tool: "7-Zip",
    };
  }
  return null;
}

/** Folder an archive extracts into: <name> next to the download. */
export function extractOutDir(destination: string): string {
  const dot = destination.lastIndexOf(".");
  const base = dot > 0 ? destination.slice(0, dot) : destination;
  return `${base} (extracted)`;
}
