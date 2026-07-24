import { test, expect } from "bun:test";
import { getTelemetry, setTelemetry } from "../../src/telemetry/singleton.js";

test("getTelemetry defaults to a disabled no-op that never throws", () => {
  const telemetry = getTelemetry();
  expect(telemetry.enabled).toBe(false);
  expect(() => telemetry.capture("cli_start")).not.toThrow();
});

test("setTelemetry replaces the process-wide instance", () => {
  let captured: string | undefined;
  setTelemetry({
    enabled: true,
    capture: (event) => {
      captured = event;
    },
    flush: async () => {},
  });
  getTelemetry().capture("session_end");
  expect(captured).toBe("session_end");
  // Reset so other tests in this process see the default again.
  setTelemetry({ enabled: false, capture: () => {}, flush: async () => {} });
});
