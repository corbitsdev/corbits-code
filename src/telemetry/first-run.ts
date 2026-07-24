import { getLogger } from "@intx/log";
import { LOG_NAMESPACE_ROOT } from "../branding.js";
import { loadSettings, markTelemetryNoticeShown, type Settings } from "../config/settings.js";
import {
  createTelemetry,
  resolveTelemetryEnabled,
  type CreateTelemetryOptions,
  type Telemetry,
} from "./index.js";
import { setTelemetry } from "./singleton.js";

const logger = getLogger([LOG_NAMESPACE_ROOT, "telemetry", "first-run"]);

// True while telemetry would run but the disclosure has never been shown.
// Startup holds the disabled no-op singleton for the whole launch in this
// state; nothing is ever sent before the user has had the notice in front
// of them and taken an affirmative action (see activateHeldTelemetry).
export function telemetryFirstRunPending(
  settings: Settings | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveTelemetryEnabled(settings, env) && settings?.telemetry?.noticeShown !== true;
}

export type FirstRunDeps = {
  loadSettings: (path: string) => Promise<Settings | null>;
  markTelemetryNoticeShown: (path: string) => Promise<void>;
  createTelemetry: (options: CreateTelemetryOptions) => Telemetry;
  setTelemetry: (telemetry: Telemetry) => void;
};

const defaultDeps: FirstRunDeps = {
  loadSettings,
  markTelemetryNoticeShown,
  createTelemetry,
  setTelemetry,
};

// Consent by proceeding: called from the first affirmative user action taken
// with the disclosure visible (onboarding submit, or the first interactively
// submitted TUI prompt). Stamps the notice, swaps the held no-op singleton
// for a real instance built from the settings on disk, and fires the held
// cli_start. An opt-out that landed before this point (settings tab, env
// kill) makes the new instance resolve disabled, so capture stays a no-op
// and nothing is ever sent.
//
// confirmIntent is re-checked immediately before the swap: an opt-out that
// arrives during the awaits above swaps in a disabled singleton
// synchronously (see toggle.ts), and completing the activation would clobber
// it with an enabled instance. Callers with a live opt-out surface pass
// their current intent; onboarding has none, so it uses the default.
export async function activateHeldTelemetry(
  globalSettingsPath: string,
  confirmIntent: () => boolean = () => true,
  deps: FirstRunDeps = defaultDeps,
): Promise<void> {
  try {
    await deps.markTelemetryNoticeShown(globalSettingsPath);
  } catch (err) {
    // Stamp failure only threatens durability (the notice may show again
    // next launch); the user still acknowledged this session, so continue.
    // On the onboarding path a failed stamp means the TUI banner reappears
    // in the same launch and its first prompt fires a second cli_start —
    // accepted: only under disk failure, and it fails toward disclosure.
    logger.warn("Failed to stamp telemetry notice as shown: {error}", { error: err });
  }
  const settings = await deps.loadSettings(globalSettingsPath).catch((err: unknown) => {
    logger.warn("Failed to load settings for telemetry activation: {error}", { error: err });
    return undefined;
  });
  if (settings === undefined) {
    // Unreadable settings: the persisted opt-in state is unknown, so stay
    // held rather than guess toward sending.
    return;
  }
  if (!confirmIntent()) return;
  const telemetry = deps.createTelemetry({ settings });
  deps.setTelemetry(telemetry);
  telemetry.capture("cli_start");
}
