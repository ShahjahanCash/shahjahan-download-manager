import type { SegmentState } from "./types.js";

/**
 * Segment planning uses plain JS numbers (IEEE 754 doubles), which are
 * exact for integers up to 2^53 — far above any real file. No 32-bit
 * truncation (no `| 0`, `>>>`, or Int32Array) is used anywhere in the
 * engine, so files over 4 GiB plan and seek correctly. The only
 * >4 GiB caveat is disk space, not arithmetic.
 */
export function planSegments(
  totalBytes: number,
  requestedCount: number,
  minSegmentBytes: number,
): SegmentState[] {
  if (totalBytes <= 0) return [];
  const maxBySize = Math.max(
    1,
    Math.floor(totalBytes / Math.max(1, minSegmentBytes)),
  );
  const count = Math.max(1, Math.min(requestedCount, maxBySize));
  const base = Math.floor(totalBytes / count);
  const segments: SegmentState[] = [];
  for (let i = 0; i < count; i++) {
    const start = i * base;
    const end = i === count - 1 ? totalBytes - 1 : start + base - 1;
    segments.push({ start, end, downloaded: 0, done: false });
  }
  return segments;
}

export function segmentLength(segment: SegmentState): number {
  return segment.end - segment.start + 1;
}

/**
 * Recommended segment count for a file of this size (0.7.0 "Auto"
 * mode, raised in 0.7.2 for speed). Small files gain nothing from
 * many connections, but on high-latency links — and against servers
 * that throttle per connection — more parallel connections raise
 * the aggregate speed well past what 4-8 segments reach. A 37 MiB
 * file now gets 8 segments instead of 4; a 500 MiB file gets 16.
 * planSegments() still caps the count by minSegmentBytes, so a
 * tiny file on a fast server never gets more segments than it can use.
 */
export function recommendSegments(totalBytes: number): number {
  const MiB = 1024 * 1024;
  if (totalBytes <= 1 * MiB) return 1;
  if (totalBytes <= 10 * MiB) return 2;
  if (totalBytes <= 100 * MiB) return 8;
  if (totalBytes <= 1024 * MiB) return 16;
  return 32;
}

export function segmentRemaining(segment: SegmentState): number {
  return Math.max(0, segmentLength(segment) - segment.downloaded);
}
