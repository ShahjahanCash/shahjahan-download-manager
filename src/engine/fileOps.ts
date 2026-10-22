/**
 * Antivirus-lock retry (Phase 7).
 *
 * On Windows, an antivirus scanner (or Explorer/indexer) can briefly
 * lock a just-written file, so rename/unlink/close fail with EPERM,
 * EBUSY, ENOTEMPTY, or EACCES even though the operation is legitimate.
 * The correct response is a short retry with backoff, not an immediate
 * failure — and not an infinite loop. Non-lock errors fail immediately.
 */
export const LOCK_ERROR_CODES = new Set(["EPERM", "EBUSY", "ENOTEMPTY", "EACCES"]);

export function isLockError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && LOCK_ERROR_CODES.has(code);
}

export async function retryOnLock<T>(
  fn: () => Promise<T>,
  options: { attempts?: number; delayMs?: number; onRetry?: (attempt: number, error: unknown) => void } = {},
): Promise<T> {
  const attempts = options.attempts ?? 6;
  const delayMs = options.delayMs ?? 100;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isLockError(error) || attempt === attempts) throw error;
      options.onRetry?.(attempt, error);
      // Backoff: 100, 200, 400, 800, 1600 ms (total ~3.1 s for 6 attempts).
      await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}
