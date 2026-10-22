/**
 * Windows path hardening (Phase 7).
 *
 * Windows historically caps paths at 260 characters (MAX_PATH) unless
 * the extended-length prefix `\\?\` is used. Node's fs on Windows
 * understands that prefix, so long download destinations must be
 * passed through winLongPath() before any fs call on win32.
 *
 * On other platforms this is a no-op, so the same code and tests run
 * everywhere. Callers should pass the result of winLongPath() to fs,
 * but keep the original path for display, journals, and the UI.
 */
export function isWindowsLongPath(path: string): boolean {
  return path.startsWith("\\\\?\\");
}

export function winLongPath(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return path;
  if (isWindowsLongPath(path)) return path;
  // UNC paths get the \\?\UNC\ form; drive-letter paths get \\?\C:\...
  if (path.startsWith("\\\\")) {
    return `\\\\?\\UNC\\${path.slice(2)}`;
  }
  const driveMatch = /^[A-Za-z]:[\\/]/.exec(path);
  if (driveMatch) {
    return `\\\\?\\${path}`;
  }
  return path;
}

/** True when a path would exceed the classic Windows MAX_PATH limit. */
export function exceedsMaxPath(path: string): boolean {
  return path.length >= 260;
}
