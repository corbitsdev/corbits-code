import { getLogger } from "@intx/log";
import { loadSettings, saveGlobalSettings, type Settings } from "../config/settings.js";
import { createTelemetry, type CreateTelemetryOptions, type Telemetry } from "./index.js";
import { getTelemetry, setTelemetry } from "./singleton.js";

const logger = getLogger(["intercode", "telemetry", "toggle"]);

export type TelemetryToggleDeps = {
  getTelemetry: () => Telemetry;
  setTelemetry: (telemetry: Telemetry) => void;
  loadSettings: (path: string) => Promise<Settings | null>;
  saveGlobalSettings: (path: string, settings: Settings) => Promise<void>;
  createTelemetry: (options: CreateTelemetryOptions) => Telemetry;
};

const defaultDeps: TelemetryToggleDeps = {
  getTelemetry,
  setTelemetry,
  loadSettings,
  saveGlobalSettings,
  createTelemetry,
};

// Builds the /settings > Telemetry toggle handler, bound to the true global
// settings path (never a --config override — see index.ts / runner.tsx for
// why). Returned as a plain function so it can be wired into onChange props
// without an inline closure, and so tests can call it directly with fake deps.
export function createTelemetryToggleHandler(
  globalSettingsPath: string,
  deps: TelemetryToggleDeps = defaultDeps,
): (enabled: boolean) => void {
  return (enabled: boolean): void => {
    if (!enabled) {
      // Opt-out must be immediate and absolute: swap the in-memory singleton
      // synchronously, before any await, so no capture in flight during the
      // persistence step below can land on a still-enabled instance, and so
      // an unhandled rejection from disk I/O can never leave telemetry on.
      deps.setTelemetry(
        deps.createTelemetry({ settings: { providers: {}, telemetry: { enabled: false } } }),
      );
    }

    void (async () => {
      const current = await deps.loadSettings(globalSettingsPath).catch((err: unknown) => {
        logger.warn("Failed to load global settings for telemetry toggle: {error}", { error: err });
        return undefined;
      });
      if (current === undefined) {
        // Load failed (corrupt file, I/O error): never persist over it — a
        // bare `{ providers: {} }` write would wipe unrelated settings. The
        // synchronous in-memory disable above (if this was an opt-out) still
        // holds; a re-enable during an outage just won't persist until the
        // file is readable again.
        return;
      }
      const base: Settings = current ?? { providers: {} };
      const next: Settings = { ...base, telemetry: { ...base.telemetry, enabled } };
      try {
        await deps.saveGlobalSettings(globalSettingsPath, next);
      } catch (err) {
        // Persistence failure only threatens durability across restarts, not
        // the in-memory state already set above — swallow, per telemetry's
        // fail-silent contract.
        logger.warn("Failed to persist telemetry setting: {error}", { error: err });
      }
      // Re-create so this session's remaining captures honor the change (and,
      // on the load-succeeded path, carry forward the real installationId).
      deps.setTelemetry(deps.createTelemetry({ settings: next }));
    })();
  };
}
