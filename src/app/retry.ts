/**
 * Job-level auto-retry: when a download fails for a transient reason,
 * the manager re-queues it a few times with growing delays instead of
 * leaving it failed. Permanent failures (404, auth, bad range) are
 * never retried — retrying them can only waste time.
 */

const PERMANENT_PATTERNS = [
  /HTTP 400\b/,
  /HTTP 401\b/,
  /HTTP 403\b/,
  /HTTP 404\b/,
  /HTTP 410\b/,
  /HTTP 416\b/,
  /not found/i,
  /unauthorized/i,
  /forbidden/i,
  /invalid url/i,
  /unsupported/i,
  /no .* found/i,
];

/** True when a failure message looks transient (network / server side). */
export function isRetryableError(message: string): boolean {
  const text = message || "";
  if (PERMANENT_PATTERNS.some((re) => re.test(text))) return false;
  return (
    /timeout|timed out|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network|HTTP 408\b|HTTP 429\b|HTTP 5\d\d\b|aborted|reset|unreachable/i.test(
      text,
    ) || text.length === 0
  );
}

/** Backoff delay for attempt N (1-based): base * 2^(N-1), capped at 5 min. */
export function retryDelayMs(attempt: number, baseSec: number): number {
  const base = Math.max(1, baseSec);
  return Math.min(300_000, base * 1000 * 2 ** Math.max(0, attempt - 1));
}
