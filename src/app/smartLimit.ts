/**
 * Smart speed limit (0.7.0) — lower the global cap while a watched
 * program runs (a game, a stream, a call), restore it afterwards.
 *
 * The decision itself is pure: given the list of running process names
 * and the user's watchlist, it returns the effective limit. Process
 * enumeration lives in Electron main (tasklist on Windows) and is
 * injected here only as data, so this module stays unit-testable on
 * any platform. Matching is case-insensitive and accepts either a
 * bare name ("eldenring.exe") or a substring ("eldenring").
 */

export interface SmartLimitConfig {
  enabled: boolean;
  /** Bytes/second while a watched process runs. 0 = pause downloads. */
  smartLimitBytesPerSec: number;
  /** Process names to watch, e.g. ["eldenring.exe", "obs64.exe"]. */
  watchlist: string[];
}

export function normalizeWatchlist(text: string): string[] {
  return text
    .split(/[,\n;]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function matchesWatchlist(processName: string, watchlist: string[]): boolean {
  const lower = processName.toLowerCase();
  return watchlist.some(
    (entry) => lower === entry || lower.includes(entry) || entry.includes(lower),
  );
}

/** True when any running process is on the watchlist. */
export function isWatchedProcessRunning(
  runningProcesses: string[],
  watchlist: string[],
): boolean {
  if (watchlist.length === 0) return false;
  return runningProcesses.some((name) => matchesWatchlist(name, watchlist));
}

/**
 * Effective global limit for jobs started right now: the smart cap
 * wins while a watched process runs, otherwise the normal limit.
 * A 0 normal limit means unlimited. A 0 smart limit means "don't
 * start new downloads while a watched process runs" (running jobs
 * are left alone); the manager gates pump() on it.
 */
export function decideSmartLimit(
  config: SmartLimitConfig,
  runningProcesses: string[],
  normalLimitBytesPerSec: number,
): { limited: boolean; limitBytesPerSec: number } {
  if (!config.enabled) {
    return { limited: false, limitBytesPerSec: normalLimitBytesPerSec };
  }
  if (isWatchedProcessRunning(runningProcesses, config.watchlist)) {
    return { limited: true, limitBytesPerSec: config.smartLimitBytesPerSec };
  }
  return { limited: false, limitBytesPerSec: normalLimitBytesPerSec };
}
