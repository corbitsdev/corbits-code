import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { configureSync } from "@intx/log";

import { SETTINGS_DIR_NAME } from "../../branding.js";

// Matches LogTape's Sink shape structurally (see @logtape/logtape's
// sink.d.ts); not imported directly since only @intx/log is a declared
// dependency here. The real type is strictly wider than this — if LogTape
// ever renames or narrows one of these fields, nothing here will catch the
// drift, so keep this in sync by hand if @intx/log's pinned version moves.
type LogRecord = {
  readonly category: readonly string[];
  readonly level: string;
  readonly message: readonly unknown[];
  readonly timestamp: number;
  readonly properties: Record<string, unknown>;
};

export function corbitsLogFilePath(home: string = homedir()): string {
  return join(home, SETTINGS_DIR_NAME, "logs", "corbits.log");
}

function formatRecord(record: LogRecord): string {
  return (
    JSON.stringify({
      timestamp: new Date(record.timestamp).toISOString(),
      level: record.level,
      category: record.category.join("."),
      message: record.message.join(""),
      properties: record.properties,
    }) + "\n"
  );
}

/**
 * Routes every logger — including ones inside vendored dependencies, which
 * Corbits cannot edit — to a file instead of the console.
 *
 * `@intx/log` installs a console sink as a side effect of its first import
 * (see its `default-sink` module), so a bare `getLogger` import is enough
 * for a log call to reach stdout/stderr before Corbits does anything. This
 * must run before any other Corbits code executes — first statement in
 * `mainWithRunners` — so that race is never live: the TUI holds the
 * alternate screen for the rest of the process, and anything landing on
 * the real terminal mid-frame corrupts it.
 */
export function installFileLogSink(path: string = corbitsLogFilePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  configureSync({
    reset: true,
    sinks: {
      file: (record: LogRecord) => {
        appendFileSync(path, formatRecord(record));
      },
    },
    // "debug" (not "warning"): a file has no screen to corrupt, and several
    // teardown-race diagnostics (e.g. src/tui/runner.ts, src/exec/runner.ts)
    // are logger.debug calls that exist specifically to be readable here
    // after the fact. Filtering them out at the sink would silently disable
    // the diagnostics the file exists to capture.
    loggers: [
      { category: ["logtape", "meta"], lowestLevel: "warning", sinks: ["file"] },
      { category: [], lowestLevel: "debug", sinks: ["file"] },
    ],
  });
}
