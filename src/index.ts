import { getLogger } from "@intx/log";
import { LOG_NAMESPACE_ROOT } from "./branding.js";
import { loadConfig } from "./config/index.js";
import { ensureTelemetrySettings, globalSettingsPath } from "./config/settings.js";
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
  const config = await loadConfig(argv, { allowUnconfigured: true });
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

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
