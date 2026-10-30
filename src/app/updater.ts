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
 * Feed URL resolution (1.0.4 Phase 3): DM_UPDATE_URL wins when set (the
 * testing override), otherwise DEFAULT_UPDATE_FEED_URL is used. That
 * constant points at the public feed repo chosen Oct 30, 2026
 * (ShahjahanCash/shahjahan-download-manager-updates, feed.json on main)
 * — a stable public https URL the publisher controls (see
 * UPGRADE-PLAN-1.0.4.md Decision 1). IMPORTANT: the live feed.json
 * currently reports version 1.0.3 as a placeholder; Phase 6 must update
 * it to 1.0.4 with the real installer URL before the 1.0.4 release, or
 * 1.0.4 users will simply see no update.
 *
 * The feed's download URL must be https: — the dialog opens it with
 * shell.openExternal after a user click, so a non-https URL (http, or
 * worse file:) from a compromised or mistyped feed must never reach it.
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

// Baked-in default feed URL: the public feed repo chosen Oct 30, 2026
// (UPGRADE-PLAN-1.0.4.md Decision 1). DM_UPDATE_URL always overrides it
// for testing. NOTE: live feed.json currently reports 1.0.3 as a
// placeholder; Phase 6 must set it to 1.0.4 + the real installer URL
// before release.
export const DEFAULT_UPDATE_FEED_URL: string =
  "https://raw.githubusercontent.com/ShahjahanCash/shahjahan-download-manager-updates/main/feed.json";

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
  feedUrl: string | null | undefined = process.env["DM_UPDATE_URL"] ?? DEFAULT_UPDATE_FEED_URL,
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
    let feedDownloadUrl: URL;
    try {
      feedDownloadUrl = new URL(feed.url);
    } catch {
      return {
        available: false,
        currentVersion,
        latestVersion: null,
        url: null,
        error: "Update feed url is not a valid URL",
      };
    }
    if (feedDownloadUrl.protocol !== "https:") {
      return {
        available: false,
        currentVersion,
        latestVersion: null,
        url: null,
        error: "Update feed url must use https",
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
