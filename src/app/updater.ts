/**
 * Update check (Phase 7) — deliberately simple and user-confirmed.
 *
 * The app fetches a JSON feed the publisher controls, e.g. a GitHub
 * release asset or a static file:
 *   { "version": "0.6.0", "url": "https://example.com/DownloadManager-Setup-0.6.0.exe" }
 * If the feed version is newer than the running version, the caller
 * (Electron main) shows a dialog and only opens the download URL if
 * the user clicks "Download". Nothing is downloaded or installed
 * automatically, and no code runs from the feed — the URL is opened
 * in the user's browser.
 *
 * No feed URL is baked in: set DM_UPDATE_URL, or pass one explicitly.
 * Without a URL, checkForUpdates() returns { available: false }.
 */

export interface UpdateFeed {
  version: string;
  url: string;
}

export interface UpdateCheckResult {
  available: boolean;
  currentVersion: string;
  latestVersion: string | null;
  url: string | null;
  error: string | null;
}

/** Compare semver-ish versions ("1.2.3", "v1.2.3", "1.2"). */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] =>
    value
      .replace(/^v/i, "")
      .split(".")
      .map((part) => {
        const n = Number(part.replace(/[^0-9].*$/, ""));
        return Number.isFinite(n) ? n : 0;
      });
  const pa = parse(a);
  const pb = parse(b);
  const length = Math.max(pa.length, pb.length);
  for (let i = 0; i < length; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function checkForUpdates(
  currentVersion: string,
  feedUrl: string | null = process.env["DM_UPDATE_URL"] ?? null,
  fetchFn: typeof fetch = fetch,
): Promise<UpdateCheckResult> {
  if (!feedUrl) {
    return {
      available: false,
      currentVersion,
      latestVersion: null,
      url: null,
      error: null,
    };
  }
  try {
    const response = await fetchFn(feedUrl, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      return {
        available: false,
        currentVersion,
        latestVersion: null,
        url: null,
        error: `Update feed HTTP ${response.status}`,
      };
    }
    const feed = (await response.json()) as UpdateFeed;
    if (typeof feed.version !== "string" || typeof feed.url !== "string") {
      return {
        available: false,
        currentVersion,
        latestVersion: null,
        url: null,
        error: "Update feed is missing version or url",
      };
    }
    const available = compareVersions(feed.version, currentVersion) > 0;
    return {
      available,
      currentVersion,
      latestVersion: feed.version,
      url: available ? feed.url : null,
      error: null,
    };
  } catch (error) {
    return {
      available: false,
      currentVersion,
      latestVersion: null,
      url: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
