import { scrubSecrets } from "../secret-scrub.js";

// Bounded retry with logged degradation. Transient failures (network timeout,
// 5xx, 429) are retried up to 3 times with exponential backoff. After the
// final attempt, the error is propagated to the caller.
export async function withRetry<T>(
  operation: () => Promise<T>,
  label: string,
  maxAttempts = 3,
): Promise<T> {
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxAttempts) {
        const delayMs = 500 * 2 ** (attempt - 1);
        process.stderr.write(`web-retry: ${label} attempt ${attempt} failed, retrying in ${delayMs}ms: ${scrubSecrets(lastErr.message)}\n`);
        await sleep(delayMs);
      }
    }
  }
  process.stderr.write(`web-retry: ${label} failed after ${maxAttempts} attempts: ${scrubSecrets(lastErr?.message ?? "")}\n`);
  throw lastErr ?? new Error(`${label} failed after ${maxAttempts} attempts`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
