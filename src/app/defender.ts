/**
 * Post-download Windows Defender scan hook (0.7.0) — command builder
 * and output parser only. The real scan runs MpCmdRun.exe, which ships
 * with Windows Defender at:
 *   %ProgramFiles%\Windows Defender\MpCmdRun.exe
 * Nothing here executes anything, so this module is safe to import and
 * test on Linux; the manager only spawns it on win32.
 */

export type ScanResult = "clean" | "threat" | "error" | "unknown";

export interface DefenderCommand {
  command: string;
  args: string[];
}

/** MpCmdRun command for a single-file scan. */
export function defenderCommand(
  filePath: string,
  defenderDir?: string,
): DefenderCommand {
  const exe = defenderDir
    ? `${defenderDir.replace(/[/\\]$/, "")}\\MpCmdRun.exe`
    : "%ProgramFiles%\\Windows Defender\\MpCmdRun.exe";
  return {
    command: exe,
    args: ["-Scan", "-ScanType", "3", "-File", filePath],
  };
}

/**
 * Parse MpCmdRun output. MpCmdRun exits 0 for clean, 2 when a threat
 * is found; the text also says "found no threats" / "Threat detected".
 * Anything else is "unknown" (e.g. Defender disabled) so the UI never
 * claims a file is clean on ambiguous output.
 */
export function parseDefenderOutput(
  exitCode: number | null,
  stdout: string,
): ScanResult {
  const text = stdout.toLowerCase();
  if (text.includes("threat") && !text.includes("no threat")) return "threat";
  if (exitCode === 2) return "threat";
  if (exitCode === 0 && text.includes("no threat")) return "clean";
  if (exitCode === 0 && text.includes("scan finished")) return "clean";
  if (exitCode !== null && exitCode !== 0) return "error";
  return "unknown";
}
