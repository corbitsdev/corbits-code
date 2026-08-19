import { test, expect } from "bun:test";
import { getTelemetry, setTelemetry } from "../../src/adapters/telemetry/singleton.js";
import { NOOP_TELEMETRY } from "../../src/adapters/telemetry/index.js";

test("getTelemetry defaults to a disabled no-op that never throws", () => {
  const telemetry = getTelemetry();
  expect(telemetry.enabled).toBe(false);
  expect(() => telemetry.capture("cli_start")).not.toThrow();
  expect(telemetry.captureIntentional("survey sent")).toBe(false);
});

test("setTelemetry replaces the process-wide instance", () => {
  let captured: string | undefined;
  setTelemetry({
    enabled: true,
    installationId: "test-install",
    capture: (event) => {
      captured = event;
    },
    captureIntentional: () => false,
    flush: async () => {},
    discard: () => {},
  });
  getTelemetry().capture("session_end");
  expect(captured).toBe("session_end");
  // Reset so other tests in this process see the default again.
  setTelemetry(NOOP_TELEMETRY);
});
