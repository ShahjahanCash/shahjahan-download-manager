/**
 * Torrent tracker management + seeding policy (0.7.0).
 *
 * Trackers are just &tr= parameters on a magnet link, so adding or
 * removing them is pure string work — no WebTorrent client needed.
 * Seeding policy is equally pure: after a torrent completes, the
 * manager keeps it alive (seeding) until the ratio or time cap is
 * hit, or the user cancels it. Ratio = uploaded / downloaded.
 */

export interface SeedingPolicy {
  /** Keep seeding after completion. */
  enabled: boolean;
  /** Stop seeding at this upload/download ratio (0 = no ratio cap). */
  ratioLimit: number;
  /** Stop seeding after this many minutes (0 = no time cap). */
  maxMinutes: number;
}

/** Append trackers to a magnet link, skipping duplicates. */
export function appendTrackers(magnet: string, trackers: string[]): string {
  let url: URL;
  try {
    url = new URL(magnet);
  } catch {
    return magnet;
  }
  if (url.protocol !== "magnet:") return magnet;
  const existing = new Set(url.searchParams.getAll("tr"));
  for (const tracker of trackers) {
    const clean = tracker.trim();
    if (clean && !existing.has(clean)) {
      url.searchParams.append("tr", clean);
      existing.add(clean);
    }
  }
  return url.toString();
}

/** Remove trackers from a magnet link (empty list = remove all). */
export function removeTrackers(magnet: string, trackers: string[]): string {
  let url: URL;
  try {
    url = new URL(magnet);
  } catch {
    return magnet;
  }
  if (url.protocol !== "magnet:") return magnet;
  const keep = url.searchParams.getAll("tr").filter((tr) => {
    if (trackers.length === 0) return false;
    return !trackers.includes(tr);
  });
  url.searchParams.delete("tr");
  for (const tr of keep) url.searchParams.append("tr", tr);
  return url.toString();
}

/** True when seeding should stop under the policy. */
export function shouldStopSeeding(
  policy: SeedingPolicy,
  uploadedBytes: number,
  downloadedBytes: number,
  seededMs: number,
): boolean {
  if (!policy.enabled) return true;
  if (policy.ratioLimit > 0 && downloadedBytes > 0) {
    if (uploadedBytes / downloadedBytes >= policy.ratioLimit) return true;
  }
  if (policy.maxMinutes > 0 && seededMs >= policy.maxMinutes * 60_000) {
    return true;
  }
  return false;
}
