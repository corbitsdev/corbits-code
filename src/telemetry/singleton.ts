import { NOOP_TELEMETRY, type Telemetry } from "./index.js";
import { createPluginLoadReporter } from "./product-events.js";

// Process-wide telemetry handle. index.ts constructs the real instance once
// at startup; runner.ts and the /settings Telemetry tab read it from here rather
// than threading it through every intermediate call site. Defaults to a
// disabled no-op so any code path that runs before index.ts sets it (or in
// tests) never throws.
let instance: Telemetry = NOOP_TELEMETRY;

export const runtimePluginLoadReporter = createPluginLoadReporter();

export function setTelemetry(telemetry: Telemetry): void {
  instance = telemetry;
}

export function getTelemetry(): Telemetry {
  return instance;
}

// A stable handle to whatever the current instance is. Modules that take
// Telemetry as a constructor dependency hold this rather than the instance
// itself: the /settings toggle replaces the underlying client on enable and
// disable, and a captured instance would keep emitting into (or staying
// silent in) the client that existed at startup.
export const liveTelemetry: Telemetry = {
  get enabled() {
    return instance.enabled;
  },
  get installationId() {
    return instance.installationId;
  },
  capture: (event, properties) => instance.capture(event, properties),
  captureIntentional: (event, properties) => instance.captureIntentional(event, properties),
  flush: () => instance.flush(),
  discard: () => instance.discard(),
};
