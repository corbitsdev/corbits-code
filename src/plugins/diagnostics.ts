// Collector for plugin load/discovery diagnostics. Callers (especially the
// interactive TUI) accumulate warnings and emit a single summary instead of
// writing one stderr line per miss mid-frame.

export type PluginLoadDiagnostics = {
  warnings: string[];
};

export function createPluginLoadDiagnostics(): PluginLoadDiagnostics {
  return { warnings: [] };
}

/** Push a warning into the collector (no-op sink when diag is undefined). */
export function collectPluginWarning(
  diag: PluginLoadDiagnostics | undefined,
  msg: string,
): void {
  diag?.warnings.push(msg);
}

/**
 * Build an onWarning callback that records into `diag` when provided, else
 * falls back to the given sink (default: one stderr line per message).
 */
export function pluginWarningSink(
  diag: PluginLoadDiagnostics | undefined,
  fallback: (msg: string) => void = (msg) => process.stderr.write(`plugins: ${msg}\n`),
): (msg: string) => void {
  if (diag !== undefined) {
    return (msg) => {
      diag.warnings.push(msg);
    };
  }
  return fallback;
}

/**
 * One-line summary for a batch of load warnings. Skill-miss messages are
 * collapsed to `N skills missing: a, b, c`; mixed warnings get a count line.
 * Returns undefined when there is nothing to report.
 */
export function formatPluginWarningsSummary(
  warnings: readonly string[],
): string | undefined {
  if (warnings.length === 0) return undefined;

  const skillMisses: string[] = [];
  for (const w of warnings) {
    const m = /skill "([^"]+)" referenced but not found/.exec(w);
    if (m?.[1] !== undefined) skillMisses.push(m[1]);
  }

  if (skillMisses.length > 0 && skillMisses.length === warnings.length) {
    const n = skillMisses.length;
    return `plugins: ${n} skill${n === 1 ? "" : "s"} missing: ${skillMisses.join(", ")}`;
  }

  if (skillMisses.length > 0) {
    const n = skillMisses.length;
    const other = warnings.length - n;
    return `plugins: ${n} skill${n === 1 ? "" : "s"} missing (${skillMisses.join(", ")}); ${other} other warning${other === 1 ? "" : "s"}`;
  }

  const n = warnings.length;
  return `plugins: ${n} warning${n === 1 ? "" : "s"} during load`;
}
