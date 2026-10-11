import { getLogger } from "@intx/log";
import { LOG_NAMESPACE_ROOT } from "./branding.js";
import { primeCrashReporting } from "./crash/report.js";
import {
  loadConfig,
  CliHelpError,
  CliUserError,
  CliVersionError,
} from "./config/index.js";
import {
  ensureTelemetrySettings,
  globalSettingsPath,
} from "./config/settings.js";
import { installFileLogSink } from "./logging/sink.js";
import { flushPerfToOtel } from "./perf/index.js";
import { createTelemetry, telemetryDisabledByEnv } from "./telemetry/index.js";
import { getTelemetry, setTelemetry } from "./telemetry/singleton.js";
import {
  installCrashHandlers,
  installSignalHandlers,
} from "./process-handlers.js";
import { runExec } from "./exec/runner.js";
import { runOnboarding } from "./tui/onboarding.js";
import { runTUI } from "./tui/runner/index.js";
import { applyStartupTheme } from "./tui/theme-startup.js";

export interface Runners {
  runTUI: (config: import("./config/index.js").Config) => Promise<number>;
  runExec: (config: import("./config/index.js").Config) => Promise<number>;
  runOnboarding: (
    config: import("./config/index.js").UnconfiguredConfig,
  ) => Promise<number>;
}

export async function mainWithRunners(
  argv: readonly string[],
  runners: Runners,
): Promise<number> {
  // Must run first: @intx/log installs a console sink on import, and
  // loadConfig can log (e.g. healed settings). This replaces that default so
  // nothing — including vendored loggers — reaches the terminal the TUI owns.
  installFileLogSink();
  const config = await loadConfig(argv, { allowUnconfigured: true });
  // Resolve the crash-report directory up front, while healthy. This is the
  // only crash-path place project-key resolution (git) may happen — the
  // handler must never call it, or a hung git would block the exit it forces.
  primeCrashReporting(config.cwd);
  // Exec and unconfigured TUI have no banner; surface fail-open diagnostics
  // on stderr so junk local files are never silent.
  const surfaceDiagnosticsOnStderr =
    config.command === "exec" || !config.configured;
  if (surfaceDiagnosticsOnStderr && config.settingsDiagnostics !== undefined) {
    for (const d of config.settingsDiagnostics) {
      process.stderr.write(`settings: ${d.message}\n  fix: ${d.fix}\n`);
    }
  }
  // Always the true global settings file, never config.globalSettingsPath
  // (the --config override): splitting telemetry across two files would drop
  // installationId where the toggle never looks. Persistence is awaited (local
  // disk I/O); capture is fire-and-forget per createTelemetry's contract. The
  // env kill short-circuits first so a disabled run never touches the file.
  if (!telemetryDisabledByEnv()) {
    const settings = await ensureTelemetrySettings(globalSettingsPath()).catch(
      (err: unknown) => {
        getLogger([LOG_NAMESPACE_ROOT, "telemetry"]).warn(
          "Failed to ensure telemetry settings at startup: {error}",
          { error: err },
        );
        return null;
      },
    );
    // Consent by proceeding: until the disclosure is shown, the disabled
    // no-op singleton stays so no event leaves the process; the disclosure
    // activates telemetry on the first affirmative action (first-run.ts).
    if (settings?.telemetry?.noticeShown === true) {
      const telemetry = createTelemetry({ settings });
      setTelemetry(telemetry);
      telemetry.capture("cli_start", {
        surface: config.command === "exec" ? "exec" : "tui",
      });
    }
  }

  let exitCode: number;
  // Welcome, setup, and the product host read `UI` at construction time.
  if (config.command === "tui") {
    applyStartupTheme(
      config.configured ? config.settings?.theme : config.theme,
    );
  }
  if (!config.configured) {
    if (config.command === "exec") {
      // Exec needs a provider; onboarding is TUI-only. Fail closed with a
      // clear message.
      process.stderr.write(
        "No provider configured. Run `corbits` (interactive) once to complete setup, " +
          "or pass --provider / --model with credentials.\n",
      );
      // cli_start already emitted above; emit a minimal failed session_end
      // so the funnel stays paired instead of orphaning the start.
      const { execSessionEndProperties } = await import("./exec/runner.js");
      getTelemetry().capture(
        "session_end",
        execSessionEndProperties(undefined, Date.now(), 0),
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

  // Opt-in OTEL export of the PerfSpan tree; no-op when OTEL is disabled.
  const otelSettings = config.configured ? config.settings : null;
  await flushPerfToOtel(otelSettings);

  // Keep process.exit from dropping in-flight captures; the flush itself is
  // deadline-capped so exit stays snappy.
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

export function cliCaughtExit(err: unknown): {
  stream: "stdout" | "stderr";
  text: string;
  code: number;
} {
  if (err instanceof CliHelpError || err instanceof CliVersionError) {
    return { stream: "stdout", text: `${err.message}\n`, code: err.exitCode };
  }
  if (err instanceof CliUserError) {
    return { stream: "stderr", text: `${err.message}\n`, code: err.exitCode };
  }
  return {
    stream: "stderr",
    text: `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    code: 1,
  };
}

if (import.meta.main) {
  installCrashHandlers();
  installSignalHandlers();

  let code: number;
  try {
    code = await main(process.argv.slice(2));
  } catch (err: unknown) {
    const exit = cliCaughtExit(err);
    const dest = exit.stream === "stdout" ? process.stdout : process.stderr;
    dest.write(exit.text);
    code = exit.code;
  }
  process.exit(code);
}
