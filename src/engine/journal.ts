import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { retryOnLock } from "./fileOps.js";
import { winLongPath } from "./paths.js";
import type { JobState } from "./types.js";

/** Journal lives next to the .part file, so resume works by destination. */
export function journalPath(partPath: string): string {
  return `${partPath}.json`;
}

export async function saveJournal(job: JobState): Promise<void> {
  job.updatedAt = new Date().toISOString();
  job.downloadedBytes = job.segments.reduce(
    (sum, segment) => sum + segment.downloaded,
    0,
  );
  const tmp = `${journalPath(job.partPath)}.tmp`;
  await mkdir(dirname(winLongPath(job.partPath)), { recursive: true });
  await writeFile(winLongPath(tmp), JSON.stringify(job, null, 2), "utf8");
  await retryOnLock(() =>
    rename(winLongPath(tmp), winLongPath(journalPath(job.partPath))),
  );
}

export async function loadJournal(
  partPath: string,
): Promise<JobState | null> {
  try {
    const raw = await readFile(journalPath(partPath), "utf8");
    const parsed = JSON.parse(raw) as JobState;
    if (parsed.version !== 1 || !Array.isArray(parsed.segments)) return null;
    return parsed;
  } catch {
    return null;
  }
}
