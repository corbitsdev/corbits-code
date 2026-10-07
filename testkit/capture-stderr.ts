export const GIT_FATAL = "fatal: not a git repository";

export interface CapturedStderr {
  output(): string;
  restore(): void;
}

/**
 * Redirects `process.stderr.write` into a buffer. Callers must invoke
 * `restore()` themselves — typically from `afterEach` — so an assertion
 * failure cannot leak the hook into the next test.
 */
export function captureStderr(): CapturedStderr {
  const original = process.stderr.write.bind(process.stderr);
  let wrote = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    wrote +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  return {
    output: () => wrote,
    restore: () => {
      process.stderr.write = original;
    },
  };
}
