import { getLogger } from "@intx/log";
import { LOG_NAMESPACE_ROOT } from "./branding.js";
import { primeCrashReporting, writeCrashReport, type CrashKind } from "./crash/report.js";
import { loadConfig } from "./config/index.js";
import { ensureTelemetrySettings, globalSettingsPath } from "./config/settings.js";
import { installFileLogSink } from "./logging/sink.js";
import { flushPerfToOtel } from "./perf/index.js";
import { createTelemetry, telemetryDisabledByEnv } from "./telemetry/index.js";
import { getTelemetry, setTelemetry } from "./telemetry/singleton.js";
import { runExec } from "./exec/runner.js";
import { runOnboarding } from "./tui/onboarding.js";
import { runTUI } from "./tui/runner.js";

export type Runners = {
  runTUI: (config: import("./config/index.js").Config) => Promise<number>;
  runExec: (config: import("./config/index.js").Config) => Promise<number>;
  runOnboarding: (config: import("./config/index.js").UnconfiguredConfig) => Promise<number>;
};

export async function mainWithRunners(
  argv: readonly string[],
  runners: Runners,
): Promise<number> {
  // Must run before any other line: @intx/log installs a console sink as a
  // side effect of import, and loadConfig itself can log (e.g. healed
  // settings). Once installed, this replaces that default so nothing —
  // including a vendored dependency's logger — reaches the terminal the
  // TUI is about to own.
  installFileLogSink();
  const config = await loadConfig(argv, { allowUnconfigured: true });
  // Resolve the crash-report directory once, up front, while the process is
  // healthy. This is the only place project-key resolution (which shells
  // out to git) may happen on the crash path — the handler itself must
  // never call it, or a hung git would block the exit it exists to force.
  primeCrashReporting(config.cwd);
  // Exec has no Ink banner; unconfigured TUI goes to onboarding without the
  // main-screen notice. Surface fail-open diagnostics on stderr for those
  // paths so junk local files are never silent.
  const surfaceDiagnosticsOnStderr =
    config.command === "exec" || !config.configured;
  if (surfaceDiagnosticsOnStderr && config.settingsDiagnostics !== undefined) {
    for (const d of config.settingsDiagnostics) {
      process.stderr.write(`settings: ${d.message}\n  fix: ${d.fix}\n`);
    }
  }
  // Always the TRUE global settings file, never config.globalSettingsPath —
  // that's the --config override file when one was given, and splitting
  // telemetry across two files means the installationId lands somewhere the
  // toggle (which also uses the true global path) never looks, silently
  // breaking re-enable. Never let telemetry setup delay or crash startup:
  // settings persistence is awaited (it's local disk I/O), but the capture
  // call itself is fire-and-forget per createTelemetry's contract.
  // Env kills short-circuit before ensureTelemetrySettings so a disabled run
  // never touches the settings file (no installationId generation).
  if (!telemetryDisabledByEnv()) {
    const settings = await ensureTelemetrySettings(globalSettingsPath()).catch((err: unknown) => {
      getLogger([LOG_NAMESPACE_ROOT, "telemetry"]).warn(
        "Failed to ensure telemetry settings at startup: {error}",
        { error: err },
      );
      return null;
    });
    // Consent by proceeding: until the disclosure has been shown, the
    // default disabled no-op singleton stays in place so no event of any
    // kind can leave the process. The disclosure surfaces activate telemetry
    // (and fire the held cli_start) on the first affirmative user action —
    // see telemetry/first-run.ts.
    if (settings?.telemetry?.noticeShown === true) {
      const telemetry = createTelemetry({ settings });
      setTelemetry(telemetry);
      telemetry.capture("cli_start");
    }
  }

  let exitCode: number;
  if (!config.configured) {
    if (config.command === "exec") {
      // Exec needs a provider; onboarding is TUI-only. Fail closed with a
      // clear message rather than launching Ink.
      process.stderr.write(
        "No provider configured. Run `corbits` (interactive) once to complete setup, "
          + "or pass --provider / --model with credentials.\n",
      );
      exitCode = 2;
    } else {
      exitCode = await runners.runOnboarding(config);
    }
  } else if (config.command === "exec") {
    exitCode = await runners.runExec(config);
  } else {
    exitCode = await runners.runTUI(config);
  }

  // Opt-in OTEL export of the PerfSpan tree (session/process boundary).
  // No-op when OTEL is disabled — zero network on the export path.
  const otelSettings = config.configured ? config.settings : null;
  await flushPerfToOtel(otelSettings);

  // Bound against process.exit dropping in-flight captures for short
  // sessions; flush itself is deadline-capped so exit stays snappy.
  await getTelemetry().flush();
  return exitCode;
}

export async function main(argv: readonly string[]): Promise<number> {
  return mainWithRunners(argv, {
    runTUI,
    runExec: async (config) => {
      const result = await runExec(config);
      return result.exitCode;
    },
    runOnboarding,
  });
}

async function handleFatal(kind: CrashKind, error: unknown): Promise<void> {
  process.stderr.write(`${kind}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  const file = await writeCrashReport(kind, error);
  if (file !== null) {
    process.stderr.write(`crash report written to ${file}\n`);
  } else {
    process.stderr.write("failed to write crash report\n");
  }
  process.exit(1);
}

if (import.meta.main) {
  // OpenTUI installs a process-global uncaughtException/unhandledRejection
  // handler that only logs (opentui/core's Renderer.handleError), which
  // suppresses Bun's default print-and-exit. Combined with raw-mode stdin
  // holding the event loop open, an escaped throw would otherwise hang the
  // process forever with the terminal still in the alternate screen. Node
  // invokes every registered listener for the event regardless of order, so
  // these still run and terminate the process even though OpenTUI's own
  // listener never exits or rethrows.
  process.on("uncaughtException", (err) => {
    void handleFatal("uncaughtException", err);
  });
  process.on("unhandledRejection", (reason) => {
    void handleFatal("unhandledRejection", reason);
  });

  let code: number;
  try {
    code = await main(process.argv.slice(2));
  } catch (err: unknown) {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    code = 1;
  }
  process.exit(code);
}
