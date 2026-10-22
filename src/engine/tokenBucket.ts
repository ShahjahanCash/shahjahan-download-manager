/**
 * Token-bucket speed limiter. Unlimited when bytesPerSec is 0/omitted.
 * Callers ask for tokens before writing a chunk; the bucket refills
 * continuously, so short bursts stay smooth instead of stop-start.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  private readonly capacity: number;

  constructor(private readonly bytesPerSec: number) {
    this.capacity = Math.max(bytesPerSec, 1);
    this.tokens = this.capacity;
    this.lastRefillMs = Date.now();
  }

  get unlimited(): boolean {
    return this.bytesPerSec <= 0;
  }

  async acquire(bytes: number): Promise<void> {
    if (this.unlimited) return;
    let remaining = bytes;
    while (remaining > 0) {
      this.refill();
      if (this.tokens >= remaining) {
        this.tokens -= remaining;
        return;
      }
      remaining -= this.tokens;
      this.tokens = 0;
      const deficitMs = Math.ceil((remaining / this.bytesPerSec) * 1000);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(deficitMs, 100)),
      );
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefillMs) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(
      this.capacity,
      this.tokens + elapsedSec * this.bytesPerSec,
    );
    this.lastRefillMs = now;
  }
}
