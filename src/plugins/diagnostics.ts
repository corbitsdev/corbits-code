// Collector for plugin load/discovery diagnostics. Callers (especially the
// interactive TUI) accumulate warnings and emit a single summary instead of
// writing one stderr line per miss mid-frame.

import { getLogger } from "@intx/log";
import { LOG_NAMESPACE_ROOT } from "../branding.js";

const pluginDiagnosticsLogger = getLogger([LOG_NAMESPACE_ROOT, "plugins"]);

export type PluginLoadDiagnostics = {
  warnings: string[];
};

export function createPluginLoadDiagnostics(): PluginLoadDiagnostics {
  return { warnings: [] };
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
 * Resolve the warning sink for a load call. Prefer a diagnostics collector when
 * provided (so batch callers can emit one summary); else an explicit onWarning;
 * else one stderr line per message.
 */
export function resolvePluginWarningHandler(opts: {
  diagnostics?: PluginLoadDiagnostics;
  onWarning?: (msg: string) => void;
}): (msg: string) => void {
  if (opts.diagnostics !== undefined) return pluginWarningSink(opts.diagnostics);
  if (opts.onWarning !== undefined) return opts.onWarning;
  return pluginWarningSink(undefined);
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

/**
 * Format + emit a diagnostics summary in one call. Default write is one stderr
 * line; pass a custom sink for logger-backed callers (e.g. headless exec).
 */
export function emitPluginWarningSummary(
  diag: PluginLoadDiagnostics,
  write: (line: string) => void = (line) => {
    process.stderr.write(`${line}\n`);
  },
): void {
  const summary = formatPluginWarningsSummary(diag.warnings);
  if (summary !== undefined) write(summary);
}

/**
 * Emit a diagnostics summary through the structured logger instead of raw
 * stderr. Interactive callers (the TUI holds the alternate screen for the
 * whole session) must use this, not the raw-stderr default above — a bare
 * write lands mid-frame and corrupts the rendered transcript. The logger is
 * already routed to `~/.corbits/logs/corbits.log` by `installFileLogSink`
 * (first statement of `mainWithRunners`), so this reuses that sink rather
 * than adding a second suppression path.
 */
export function emitPluginWarningLog(diag: PluginLoadDiagnostics): void {
  emitPluginWarningSummary(diag, (line) => pluginDiagnosticsLogger.warn(line));
}
