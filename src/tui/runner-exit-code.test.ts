import { describe, test, expect } from "bun:test";
import { resolveLocalSettingsPath } from "../config/settings.js";
import { resolveExitCode } from "./runner/exit.js";

describe("resolveExitCode", () => {
  const clean = { runError: undefined, sinkError: undefined };
  const cases: [string, Parameters<typeof resolveExitCode>[0], number][] = [
    ["clean run exits 0", { ...clean, status: "done" }, 0],
    ["runError exits 1", { ...clean, runError: "boom", status: "failed" }, 1],
    ["sinkError exits 1", { ...clean, sinkError: "boom", status: "failed" }, 1],
    ["failed status exits 1", { ...clean, status: "failed" }, 1],
    ["cancelled status exits 1", { ...clean, status: "cancelled" }, 1],
    [
      "both errors exit 1",
      { runError: "a", sinkError: "b", status: "failed" },
      1,
    ],
    // Teardown failure overrides a clean status; the run must not report success.
    [
      "teardown failure exits 1",
      { ...clean, status: "done", teardownFailed: true },
      1,
    ],
  ];

  test.each(cases)("%s", (_name, input, expected) => {
    expect(resolveExitCode(input)).toBe(expected);
  });
});

describe("resolveLocalSettingsPath", () => {
  test("treats an aliased --config path as the global settings target", () => {
    expect(
      resolveLocalSettingsPath("/repo", "/repo/.corbits/settings.json"),
    ).toBeNull();
  });

  test("preserves the normal distinct global and project settings paths", () => {
    expect(
      resolveLocalSettingsPath(
        "/tmp/repo",
        "/tmp/home/user/.corbits/settings.json",
      ),
    ).toBe("/tmp/repo/.corbits/settings.json");
  });
});
