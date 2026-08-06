// Collects a ripgrep run's stdout and decides its outcome. `data`, `close` and
// the timeout fire in a platform-dependent order, so the decision lives here
// rather than in the handlers: the collector owns the accumulated bytes and
// settles exactly once, whichever handler gets there first. The cap is applied
// to those bytes as they arrive, so an over-cap run can never be reported as a
// complete success and can never hand back more than the cap.

export type RgOutcome =
  | { kind: "output"; stdout: string }
  | { kind: "no-match" }
  | { kind: "error"; message: string }
  | { kind: "partial"; stdout: string; notice: string };

export type RgCollector = {
  /** Returns an outcome once the cap is breached, otherwise undefined. */
  push: (chunk: string) => RgOutcome | undefined;
  close: (code: number | null, stderr: string) => RgOutcome | undefined;
  timeout: (timeoutMs: number) => RgOutcome | undefined;
};

// Cutting at the cap can land mid-line; drop the trailing fragment so callers
// never see a half-formed match.
function truncateToWholeLines(text: string, maxBytes: number): string {
  if (text.length <= maxBytes) return text;
  const clipped = text.slice(0, maxBytes);
  const lastBreak = clipped.lastIndexOf("\n");
  return lastBreak === -1 ? clipped : clipped.slice(0, lastBreak);
}

export function createRgCollector(maxOutputBytes: number): RgCollector {
  let stdout = "";
  let settled = false;

  const settle = (outcome: RgOutcome): RgOutcome | undefined => {
    if (settled) return undefined;
    settled = true;
    return outcome;
  };

  const overCap = (): RgOutcome | undefined => {
    if (stdout.length <= maxOutputBytes) return undefined;
    return settle({
      kind: "partial",
      stdout: truncateToWholeLines(stdout, maxOutputBytes),
      notice: `ripgrep output exceeded ${maxOutputBytes} bytes — showing partial results; narrow path/glob or pattern`,
    });
  };

  return {
    push: (chunk) => {
      if (settled) return undefined;
      stdout += chunk;
      return overCap();
    },
    close: (code, stderr) => {
      if (settled) return undefined;
      if (code === 0) return settle({ kind: "output", stdout });
      if (code === 1) return settle({ kind: "no-match" });
      return settle({
        kind: "error",
        message: stderr.trim() || `ripgrep exited with code ${code}`,
      });
    },
    timeout: (timeoutMs) => {
      if (settled) return undefined;
      return settle({
        kind: "partial",
        stdout,
        notice: `ripgrep timed out after ${timeoutMs}ms — showing partial results; narrow path/glob`,
      });
    },
  };
}
