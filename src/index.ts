import { loadConfig } from "./config/index.js";
import { ensureTelemetrySettings, globalSettingsPath } from "./config/settings.js";
import { createTelemetry, telemetryDisabledByEnv } from "./telemetry/index.js";
import { getTelemetry, setTelemetry } from "./telemetry/singleton.js";
import { runOnboarding } from "./tui/onboarding.js";
import { runTUI } from "./tui/runner.js";

export type Runners = {
  runTUI: (config: import("./config/index.js").Config) => Promise<number>;
  runOnboarding: (config: import("./config/index.js").UnconfiguredConfig) => Promise<number>;
};

export async function mainWithRunners(
  argv: readonly string[],
  runners: Runners,
): Promise<number> {
  const config = await loadConfig(argv, { allowUnconfigured: true });
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
    const settings = await ensureTelemetrySettings(globalSettingsPath()).catch(() => null);
    const telemetry = createTelemetry({ settings });
    setTelemetry(telemetry);
    telemetry.capture("cli_start");
  }
  const exitCode = config.configured
    ? await runners.runTUI(config)
    : await runners.runOnboarding(config);
  // Bound against process.exit dropping in-flight captures for short
  // sessions; each request is already capped at 3s via AbortSignal.
  await getTelemetry().flush();
  return exitCode;
}

export async function main(argv: readonly string[]): Promise<number> {
  return mainWithRunners(argv, { runTUI, runOnboarding });
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}