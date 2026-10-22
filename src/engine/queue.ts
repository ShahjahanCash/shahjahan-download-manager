import type { DownloadCategory, DownloadStatus } from "./types.js";

export interface QueueItem {
  id: string;
  url: string;
  destination: string;
  category: DownloadCategory;
  /** Higher runs first. Default 0. */
  priority?: number;
  /** Do not start before this time (scheduler). */
  scheduledAt?: string;
  status: DownloadStatus;
}

/**
 * In-memory queue + scheduler. The engine (or Electron main process)
 * supplies the runner; the queue only decides *when* and *in what order*
 * jobs start. That keeps it unit-testable without network access.
 *
 * Rules: due items first (scheduledAt <= now), then priority desc,
 * then insertion order. At most maxConcurrent runners at once.
 */
export class DownloadQueue {
  private items: QueueItem[] = [];
  private running = new Set<string>();
  private readonly runner: (item: QueueItem) => Promise<void>;

  constructor(
    runner: (item: QueueItem) => Promise<void>,
    private maxConcurrent = 3,
  ) {
    this.runner = runner;
  }

  add(item: QueueItem): void {
    if (this.items.some((existing) => existing.id === item.id)) {
      throw new Error(`Queue item already exists: ${item.id}`);
    }
    this.items.push(item);
    void this.pump();
  }

  remove(id: string): boolean {
    if (this.running.has(id)) return false;
    const before = this.items.length;
    this.items = this.items.filter((item) => item.id !== id);
    return this.items.length !== before;
  }

  list(): QueueItem[] {
    return [...this.items];
  }

  runningCount(): number {
    return this.running.size;
  }

  setMaxConcurrent(n: number): void {
    this.maxConcurrent = Math.max(1, n);
    void this.pump();
  }

  /** Items eligible to start right now, in start order. */
  dueItems(now = new Date()): QueueItem[] {
    return this.items
      .filter(
        (item) =>
          item.status === "queued" &&
          !this.running.has(item.id) &&
          (!item.scheduledAt || new Date(item.scheduledAt).getTime() <= now.getTime()),
      )
      .sort(
        (a, b) =>
          (b.priority ?? 0) - (a.priority ?? 0) ||
          this.items.indexOf(a) - this.items.indexOf(b),
      );
  }

  private async pump(): Promise<void> {
    while (this.running.size < this.maxConcurrent) {
      const next = this.dueItems()[0];
      if (!next) return;
      next.status = "downloading";
      this.running.add(next.id);
      void this.runner(next)
        .then(() => {
          next.status = "completed";
        })
        .catch(() => {
          next.status = "failed";
        })
        .finally(() => {
          this.running.delete(next.id);
          void this.pump();
        });
    }
  }
}
