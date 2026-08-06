import type { Telemetry } from "./index.js";

// Process-wide telemetry handle. index.ts constructs the real instance once
// at startup; runner.ts and the /settings Telemetry tab read it from here rather
// than threading it through every intermediate call site. Defaults to a
// disabled no-op so any code path that runs before index.ts sets it (or in
// tests) never throws.
let instance: Telemetry = { enabled: false, capture: () => {}, flush: async () => {} };

export function setTelemetry(telemetry: Telemetry): void {
  instance = telemetry;
}

export function getTelemetry(): Telemetry {
  return instance;
}
