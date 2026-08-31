import { getLogger } from "@intx/log";
import { LOG_NAMESPACE_ROOT } from "../branding.js";
import {
  ensureTelemetrySettings,
  loadSettings,
  saveGlobalSettings,
  type Settings,
} from "../config/settings.js";
import {
  createTelemetry,
  TELEMETRY_ENV,
  telemetryDisabledByEnv,
  type CreateTelemetryOptions,
  type Telemetry,
} from "./index.js";
import { getTelemetry, setTelemetry } from "./singleton.js";

const logger = getLogger([LOG_NAMESPACE_ROOT, "telemetry", "toggle"]);

export interface TelemetryToggleDeps {
  getTelemetry: () => Telemetry;
  setTelemetry: (telemetry: Telemetry) => void;
  loadSettings: (path: string) => Promise<Settings | null>;
  telemetryDisabledByEnv: () => boolean;
  ensureTelemetrySettings: (path: string) => Promise<Settings>;
  saveGlobalSettings: (path: string, settings: Settings) => Promise<void>;
  createTelemetry: (options: CreateTelemetryOptions) => Telemetry;
}

const defaultDeps: TelemetryToggleDeps = {
  getTelemetry,
  setTelemetry,
  loadSettings,
  telemetryDisabledByEnv,
  ensureTelemetrySettings,
  saveGlobalSettings,
  createTelemetry,
};

// Builds the /settings > Telemetry toggle handler, bound to the true global
// settings path (never a --config override — see index.ts / runner.ts for
// why). Returns whether the requested value was accepted so the UI can refuse
// a flip that would be a silent no-op (env kill switch).
export function createTelemetryToggleHandler(
  globalSettingsPath: string,
  deps: TelemetryToggleDeps = defaultDeps,
  enqueue: <T>(job: () => Promise<T>) => Promise<T> = (job) => job(),
): (enabled: boolean) => boolean {
  let intentGeneration = 0;
  return (enabled: boolean): boolean => {
    if (enabled && deps.telemetryDisabledByEnv()) {
      // Env kills own the "disabled means no settings writes" constraint
      // (see index.ts); honoring the enable here would generate and persist
      // an installationId while the env override keeps telemetry off — a
      // silent no-op that also breaks that invariant. Refuse instead.
      logger.warn(
        `Telemetry re-enable ignored: disabled by environment (DO_NOT_TRACK or ${TELEMETRY_ENV})`,
      );
      return false;
    }
    const generation = ++intentGeneration;
    if (!enabled) {
      // Opt-out must be immediate and absolute: discard whatever the outgoing
      // instance has queued (dropping the singleton alone would leave its
      // batch timer armed to send it anyway), then swap the in-memory
      // singleton synchronously, before any await, so no capture in flight
      // during the persistence step below can land on a still-enabled
      // instance, and so an unhandled rejection from disk I/O can never
      // leave telemetry on.
      //
      // Preserve installationId so intentional /feedback can still ship while
      // ambient product events are off. Env kill switches remain the hard stop.
      const previous = deps.getTelemetry();
      previous.discard();
      deps.setTelemetry(
        deps.createTelemetry({
          settings: {
            providers: {},
            telemetry: {
              enabled: false,
              ...(previous.installationId.length > 0
                ? { installationId: previous.installationId }
                : {}),
            },
          },
        }),
      );
    }

    void enqueue(async () => {
      // Re-enable goes through ensureTelemetrySettings so an installationId
      // always exists — writing { enabled: true } without one would leave the
      // re-created instance resolving disabled and the toggle a silent no-op.
      // Opt-out keeps plain loadSettings: disabling must never generate an id.
      const current = enabled
        ? await deps.ensureTelemetrySettings(globalSettingsPath).catch((err: unknown) => {
            logger.warn("Failed to ensure telemetry settings for re-enable: {error}", {
              error: err,
            });
            return undefined;
          })
        : await deps.loadSettings(globalSettingsPath).catch((err: unknown) => {
            logger.warn("Failed to load global settings for telemetry toggle: {error}", {
              error: err,
            });
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
      if (generation !== intentGeneration) return;
      const previous = deps.getTelemetry();
      const base: Settings = current ?? { providers: {} };
      // Keep installation identity across ambient opt-out so /feedback still
      // works. Prefer the on-disk id; fall back to the live instance when the
      // disk row never got one (first-run race).
      const installationId =
        (typeof base.telemetry?.installationId === "string" &&
        base.telemetry.installationId.length > 0
          ? base.telemetry.installationId
          : undefined) ??
        (previous.installationId.length > 0 ? previous.installationId : undefined);
      const next: Settings = {
        ...base,
        telemetry: {
          ...base.telemetry,
          enabled,
          ...(installationId !== undefined ? { installationId } : {}),
        },
      };
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
      if (generation !== intentGeneration) return;
      deps.setTelemetry(deps.createTelemetry({ settings: next }));
    });
    return true;
  };
}
