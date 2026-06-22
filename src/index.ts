import { loadConfig } from "./config/index.js";
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