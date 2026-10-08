// Collect load/discovery warnings and emit one summary instead of writing
// one stderr line per miss mid-frame.

import { getLogger } from "@intx/log";
import { LOG_NAMESPACE_ROOT } from "../branding.js";

const pluginDiagnosticsLogger = getLogger([LOG_NAMESPACE_ROOT, "plugins"]);

export interface PluginLoadDiagnostics {
  warnings: string[];
}

export function createPluginLoadDiagnostics(): PluginLoadDiagnostics {
  return { warnings: [] };
}

/** onWarning callback recording into `diag`. */
export function pluginWarningSink(
  diag: PluginLoadDiagnostics,
): (msg: string) => void {
  return (msg) => {
    diag.warnings.push(msg);
  };
}

/**
 * Resolve the sink for a load call. No default: callers choose a collector
 * (batched, safe mid-frame) or an explicit onWarning (raw stderr where no
 * frame is held).
 */
export function resolvePluginWarningHandler(
  opts:
    | { diagnostics: PluginLoadDiagnostics }
    | { onWarning: (msg: string) => void },
): (msg: string) => void {
  return "diagnostics" in opts
    ? pluginWarningSink(opts.diagnostics)
    : opts.onWarning;
}

/** Raw-stderr choice: `{ onWarning: stderrPluginWarning }`. */
export function stderrPluginWarning(msg: string): void {
  process.stderr.write(`plugins: ${msg}\n`);
}

/**
 * One-line load-warning summary. Skill misses collapse to `N skills
 * missing: a, b, c`; mixed warnings get a count line; nothing to report
 * yields undefined. Skill names dedupe: listed once however many plugins
 * referenced them, so the count matches the printed names.
 */
export function formatPluginWarningsSummary(
  warnings: readonly string[],
): string | undefined {
  if (warnings.length === 0) return undefined;

  const missedSkills = new Set<string>();
  let skillMissWarnings = 0;
  for (const w of warnings) {
    const m = /skill "([^"]+)" referenced but not found/.exec(w);
    if (m?.[1] === undefined) continue;
    skillMissWarnings += 1;
    missedSkills.add(m[1]);
  }

  const names = [...missedSkills];
  const n = names.length;

  if (n > 0 && skillMissWarnings === warnings.length) {
    return `plugins: ${n} skill${n === 1 ? "" : "s"} missing: ${names.join(", ")}`;
  }

  if (n > 0) {
    const other = warnings.length - skillMissWarnings;
    return `plugins: ${n} skill${n === 1 ? "" : "s"} missing (${names.join(", ")}); ${other} other warning${other === 1 ? "" : "s"}`;
  }

  const total = warnings.length;
  return `plugins: ${total} warning${total === 1 ? "" : "s"} during load`;
}

/**
 * Format and emit a summary in one call. Default writes one stderr line;
 * pass a sink for logger-backed callers (headless exec).
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
 * Emit the summary via the structured logger, not raw stderr. The TUI
 * holds the alternate screen the whole session, so a bare write lands
 * mid-frame and corrupts the transcript. The logger already routes to the
 * startup file-log sink, so this reuses it.
 */
export function emitPluginWarningLog(diag: PluginLoadDiagnostics): void {
  emitPluginWarningSummary(diag, (line) => pluginDiagnosticsLogger.warn(line));
}

/**
 * Extract the plugin or agent id a warning names. Skill-miss lines lead
 * with `agent <id>:`; tool-plugin start failures quote the candidate id.
 */
export function pluginWarningSubjectId(warning: string): string | undefined {
  const agent = /^agent ([^:]+):/.exec(warning)?.[1];
  if (agent !== undefined) return agent;
  const tool = /tool-plugin: failed to start "([^"]+)"/.exec(warning)?.[1];
  if (tool !== undefined) return tool;
  return undefined;
}

/**
 * Warnings whose subject id matches the plugin id or an agent profile id.
 */
export function warningsForPluginEntry(
  warnings: readonly string[],
  plugin: {
    readonly id: string;
    readonly agentProfiles?: readonly { readonly id: string }[];
  },
): string[] {
  const ids = new Set<string>([plugin.id]);
  for (const profile of plugin.agentProfiles ?? []) ids.add(profile.id);
  return warnings.filter((w) => {
    const subject = pluginWarningSubjectId(w);
    return subject !== undefined && ids.has(subject);
  });
}
