import { loadConfig } from "./config/index.js";
import { ensureTelemetrySettings } from "./config/settings.js";
import { createTelemetry } from "./telemetry/index.js";
import { setTelemetry } from "./telemetry/singleton.js";
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
  // Never let telemetry setup delay or crash startup: settings persistence
  // is awaited (it's local disk I/O), but the capture call itself is
  // fire-and-forget per createTelemetry's contract.
  const settings = await ensureTelemetrySettings(config.globalSettingsPath).catch(() => null);
  const telemetry = createTelemetry({ settings });
  setTelemetry(telemetry);
  telemetry.capture("cli_start");
  if (!config.configured) {
    return runners.runOnboarding(config);
  }
  return runners.runTUI(config);
}

export async function main(argv: readonly string[]): Promise<number> {
  return mainWithRunners(argv, { runTUI, runOnboarding });
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}