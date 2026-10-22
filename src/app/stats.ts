/**
 * Download history & stats (0.7.0) — append-only per-day records.
 *
 * The store keeps one entry per completed job: bytes, duration and
 * date. Aggregation (monthly usage, totals, average speed) is pure so
 * it is unit-testable; persistence is a single JSON file next to the
 * queue file, written with the same tmp+rename discipline. Stats are
 * informational only and never block a download.
 */

export interface StatEntry {
  /** ISO date (local) "YYYY-MM-DD". */
  day: string;
  bytes: number;
  /** Milliseconds the download ran. */
  durationMs: number;
  jobId: string;
}

export interface StatsSummary {
  totalBytes: number;
  totalJobs: number;
  /** Bytes downloaded in the current local month. */
  monthBytes: number;
  /** Bytes downloaded in the last 30 days. */
  last30DaysBytes: number;
  /** Mean bytes/second across jobs with a duration, or null. */
  averageSpeedBytesPerSec: number | null;
  /** Per-day bytes for the last 30 days, oldest first. */
  daily: { day: string; bytes: number }[];
}

export function localDay(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function aggregateStats(
  entries: StatEntry[],
  now = new Date(),
): StatsSummary {
  const monthPrefix = localDay(now).slice(0, 7);
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffDay = localDay(cutoff);
  let totalBytes = 0;
  let monthBytes = 0;
  let last30DaysBytes = 0;
  let speedSum = 0;
  let speedCount = 0;
  const byDay = new Map<string, number>();
  for (const entry of entries) {
    totalBytes += entry.bytes;
    if (entry.day.startsWith(monthPrefix)) monthBytes += entry.bytes;
    if (entry.day >= cutoffDay) {
      last30DaysBytes += entry.bytes;
      byDay.set(entry.day, (byDay.get(entry.day) ?? 0) + entry.bytes);
    }
    if (entry.durationMs > 0) {
      speedSum += entry.bytes / (entry.durationMs / 1000);
      speedCount++;
    }
  }
  const daily = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, bytes]) => ({ day, bytes }));
  return {
    totalBytes,
    totalJobs: entries.length,
    monthBytes,
    last30DaysBytes,
    averageSpeedBytesPerSec: speedCount > 0 ? speedSum / speedCount : null,
    daily,
  };
}

/** Tiny JSON-file store; the manager owns one instance. */
export class StatsStore {
  private entries: StatEntry[] = [];
  private loaded = false;

  constructor(private readonly filePath: string | null) {}

  async load(): Promise<void> {
    if (this.loaded || !this.filePath) return;
    this.loaded = true;
    try {
      const { readFile } = await import("node:fs/promises");
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      if (Array.isArray(parsed?.entries)) {
        this.entries = parsed.entries.filter(
          (e: unknown): e is StatEntry =>
            !!e && typeof e === "object" && typeof (e as StatEntry).day === "string",
        );
      }
    } catch {
      this.entries = [];
    }
  }

  async record(entry: StatEntry): Promise<void> {
    await this.load();
    this.entries.push(entry);
    if (this.entries.length > 5000) {
      this.entries = this.entries.slice(-5000);
    }
    if (!this.filePath) return;
    try {
      const { mkdir, rename, writeFile } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      await writeFile(tmp, JSON.stringify({ entries: this.entries }), "utf8");
      await rename(tmp, this.filePath);
    } catch {
      // Stats must never break downloads.
    }
  }

  summary(now = new Date()): StatsSummary {
    return aggregateStats(this.entries, now);
  }
}
