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

function isWebProvider(value: unknown): value is WebProvider {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { search?: unknown }).search === "function" &&
    typeof (value as { fetch?: unknown }).fetch === "function"
  );
}

// Dynamically load a web provider from a module specifier. The module must
// export a factory as either its default export or a named `createWebProvider`
// export: `(options: unknown) => WebProvider | Promise<WebProvider>`. This
// loader has no knowledge of any specific provider implementation.
export async function loadWebProvider(specifier: string, options: unknown): Promise<WebProvider> {
  let mod: unknown;
  // Relative specifiers in settings are expressed from CWD, not from this
  // module's location. Resolve them before handing to dynamic import.
  const resolved = specifier.startsWith(".") ? new URL(specifier, `file://${process.cwd()}/`).href : specifier;
  try {
    mod = await import(resolved);
  } catch (err) {
    throw new Error(`Failed to load web provider "${specifier}"`, { cause: err });
  }

  const record = mod as Record<string, unknown>;
  const factory =
    typeof record.default === "function"
      ? record.default
      : typeof record.createWebProvider === "function"
        ? record.createWebProvider
        : undefined;

  if (factory === undefined) {
    throw new Error(
      `Web provider "${specifier}" must export a factory as "createWebProvider" or as the default export.`,
    );
  }

  const provider = await (factory as (options: unknown) => WebProvider | Promise<WebProvider>)(
    options,
  );

  if (!isWebProvider(provider)) {
    throw new Error(
      `Web provider "${specifier}" did not return a WebProvider (expected { name, search, fetch }).`,
    );
  }

  return provider;
}

// Resolve a web provider from optional settings. Loads the configured provider
// module when a specifier is given; on failure logs to stderr and returns
// undefined so the caller falls back to the built-in local provider rather than
// crashing the run.
export async function resolveWebProviderFromSettings(
  specifier: string | undefined,
  options: unknown,
): Promise<WebProvider | undefined> {
  if (specifier === undefined || specifier.length === 0) return undefined;
  try {
    return await loadWebProvider(specifier, options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `web-provider: failed to load "${specifier}", falling back to local: ${scrubSecrets(message)}\n`,
    );
    return undefined;
  }
}

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
