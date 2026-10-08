// Collector for plugin load/discovery diagnostics. Callers (especially the
// interactive TUI) accumulate warnings and emit a single summary instead of
// writing one stderr line per miss mid-frame.

import { getLogger } from "@intx/log";
import { LOG_NAMESPACE_ROOT } from "../branding.js";

const pluginDiagnosticsLogger = getLogger([LOG_NAMESPACE_ROOT, "plugins"]);

export interface PluginLoadDiagnostics {
  warnings: string[];
}

export function createPluginLoadDiagnostics(): PluginLoadDiagnostics {
  return { warnings: [] };
}

/** Build an onWarning callback that records into `diag`. */
export function pluginWarningSink(
  diag: PluginLoadDiagnostics,
): (msg: string) => void {
  return (msg) => {
    diag.warnings.push(msg);
  };
}

/**
 * Resolve the warning sink for a load call. There is no default: callers
 * must decide between a diagnostics collector (batched into one summary,
 * safe mid-frame) and an explicit onWarning (e.g. a raw stderr writer for
 * headless paths where no frame is being held).
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

/** Named raw-stderr choice: `{ onWarning: stderrPluginWarning }`. */
export function stderrPluginWarning(msg: string): void {
  process.stderr.write(`plugins: ${msg}\n`);
}

/**
 * One-line summary for a batch of load warnings. Skill-miss messages are
 * collapsed to `N skills missing: a, b, c`; mixed warnings get a count line.
 * Returns undefined when there is nothing to report.
 *
 * Skill names are deduplicated: a skill is missing once however many plugins
 * referenced it, and the count matches the printed names.
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
 * stderr. The TUI holds the alternate screen for the whole session, so a
 * bare write lands mid-frame and corrupts the rendered transcript. The
 * logger already routes to the file-log sink installed at startup, so this
 * reuses it rather than adding a second path.
 */
export function emitPluginWarningLog(diag: PluginLoadDiagnostics): void {
  emitPluginWarningSummary(diag, (line) => pluginDiagnosticsLogger.warn(line));
}

/**
 * Extract a plugin or agent id a warning names, when present. Skill-miss lines
 * lead with `agent <id>:`; tool-plugin start failures quote the candidate id.
 */
export function pluginWarningSubjectId(warning: string): string | undefined {
  const agent = /^agent ([^:]+):/.exec(warning)?.[1];
  if (agent !== undefined) return agent;
  const tool = /tool-plugin: failed to start "([^"]+)"/.exec(warning)?.[1];
  if (tool !== undefined) return tool;
  return undefined;
}

/**
 * Warnings attributable to one plugin: subject id matches the plugin id or any
 * of its agent profile ids.
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
