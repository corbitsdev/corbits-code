import type { WebProvider } from "../types.js";
import { scrubSecrets } from "../secret-scrub.js";
import { createLocalProvider, type LocalProviderOptions } from "./local.js";

export type ProviderResolutionOptions = {
  localOptions?: LocalProviderOptions;
  // A pre-resolved provider injected by the caller. When set, it is used
  // verbatim; otherwise the built-in local provider is used.
  provider?: WebProvider;
};

// Lazy provider holder. Resolved on first use so we don't pay a startup network
// tax for local-only or offline runs.
type ProviderHolder = {
  provider: WebProvider | undefined;
  resolved: boolean;
};

const holder: ProviderHolder = {
  provider: undefined,
  resolved: false,
};

function resolveProvider(options: ProviderResolutionOptions = {}): WebProvider {
  if (options.provider !== undefined) {
    process.stderr.write(`web-provider: resolved to "${options.provider.name}"\n`);
    return options.provider;
  }
  const provider = createLocalProvider(options.localOptions);
  process.stderr.write(`web-provider: resolved to "${provider.name}"\n`);
  return provider;
}

export function getWebProvider(options: ProviderResolutionOptions = {}): WebProvider {
  if (!holder.resolved) {
    holder.provider = resolveProvider(options);
    holder.resolved = true;
  }
  return holder.provider!;
}

export function resetWebProvider(): void {
  holder.provider = undefined;
  holder.resolved = false;
}

// Bounded retry with logged degradation. Transient failures (network timeout,
// 5xx, 429) are retried up to 3 times with exponential backoff. After the
// final attempt, the error is propagated (the caller may degrade to local).
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
