// Shared hunter for the "best-effort step failed" debug catch: callers keep
// their message; the helper owns the caught-value normalization-and-append
// shape so that boilerplate exists once, not per site.
interface DebugSink {
  debug: (message: string, properties?: Record<string, unknown>) => void;
}

export function caughtDebug(
  logger: DebugSink,
  message: string,
  sanitize?: (error: string) => string,
): (err: unknown) => void {
  return (err) => {
    const error = err instanceof Error ? err.message : String(err);
    logger.debug(`${message}: {error}`, { error: (sanitize ?? String)(error) });
  };
}
