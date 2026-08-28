import { describe, test, expect } from "bun:test";
import { resolveLocalSettingsPath } from "../config/settings.js";
import { resolveExitCode } from "./runner.js";

describe("resolveExitCode", () => {
  test("returns 0 when run completes successfully with no errors", () => {
    const code = resolveExitCode({
      runError: undefined,
      sinkError: undefined,
      status: "done",
    });
    expect(code).toBe(0);
  });

  test("returns 1 when runError is set", () => {
    const code = resolveExitCode({
      runError: "Agent encountered an error",
      sinkError: undefined,
      status: "failed",
    });
    expect(code).toBe(1);
  });

  test("returns 1 when sinkError is set", () => {
    const code = resolveExitCode({
      runError: undefined,
      sinkError: "Reactor error occurred",
      status: "failed",
    });
    expect(code).toBe(1);
  });

  test("returns 1 when status is failed", () => {
    const code = resolveExitCode({
      runError: undefined,
      sinkError: undefined,
      status: "failed",
    });
    expect(code).toBe(1);
  });

  test("returns 1 when status is cancelled", () => {
    const code = resolveExitCode({
      runError: undefined,
      sinkError: undefined,
      status: "cancelled",
    });
    expect(code).toBe(1);
  });

  test("returns 1 when both runError and sinkError are set", () => {
    const code = resolveExitCode({
      runError: "Agent error",
      sinkError: "Sink error",
      status: "failed",
    });
    expect(code).toBe(1);
  });

  test("returns 0 when status is done despite other fields being undefined", () => {
    const code = resolveExitCode({
      runError: undefined,
      sinkError: undefined,
      status: "done",
    });
    expect(code).toBe(0);
  });
});

describe("resolveLocalSettingsPath", () => {
  test("treats an aliased --config path as the global settings target", () => {
    expect(resolveLocalSettingsPath("/repo", "/repo/.corbits/settings.json")).toBeNull();
  });

  test("preserves the normal distinct global and project settings paths", () => {
    expect(resolveLocalSettingsPath("/tmp/repo", "/tmp/home/user/.corbits/settings.json")).toBe(
      "/tmp/repo/.corbits/settings.json",
    );
  });
});
