import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config/index.js";
import { CliHelpError, CliUserError } from "../../src/config/index.js";
import {
  resetPricingMetadataRefreshForTests,
  schedulePricingMetadataRefresh,
} from "../../src/cost/pricing-metadata.js";
import { cliCaughtExit, mainWithRunners } from "../../src/index.js";

const envVars = {
  // Unit tests must never export telemetry or write an installationId into
  // the developer's real global settings file.
  CORBITS_TELEMETRY: "0",
};

// Configuration resolution reads a settings file and the local settings file
// under the run cwd. Both are pinned to a temp sandbox (--config and --cwd) so
// the run is identical on a developer machine and on a clean runner: os.homedir()
// is snapshotted at process start in Bun, so mutating HOME here would not work.
// --config also suppresses the home-level OAuth profile merge.
let sandbox: string;

function writeSandboxSettings(root: string): void {
  const settingsDir = join(root, "home", ".corbits");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(
    join(settingsDir, "settings.json"),
    JSON.stringify({
      providers: {
        "test-provider": {
          baseURL: "http://localhost:1234",
          apiKey: "test-key",
          models: ["test-model"],
          defaultModel: "test-model",
        },
      },
      defaultProvider: "test-provider",
    }),
  );
  mkdirSync(join(root, "project"), { recursive: true });
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "corbits-index-test-"));
  writeSandboxSettings(sandbox);
  // Claim the one-shot pricing refresh guard with a sandboxed cache and a
  // fetch that never fires, so loadConfig's bootstrap cannot reach the network
  // or write into the real home cache directory.
  resetPricingMetadataRefreshForTests();
  schedulePricingMetadataRefresh({
    cachePath: join(sandbox, "home", ".corbits", "cache", "models-pricing.json"),
    fetchImpl: () => Promise.reject(new Error("network disabled in tests")),
  });
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// The subcommand must stay at argv[0]; flags go after it.
function sandboxArgs(subcommand: readonly string[], rest: readonly string[] = []): string[] {
  return [
    ...subcommand,
    "--cwd",
    join(sandbox, "project"),
    "--config",
    join(sandbox, "home", ".corbits", "settings.json"),
    ...rest,
  ];
}

async function withEnv(fn: () => void | Promise<void>): Promise<void> {
  const original: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(envVars)) {
    original[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
}

test("main launches TUI when configured", async () => {
  await withEnv(async () => {
    const runTUI = mock((_config: Config) => Promise.resolve(0));
    const runExec = mock((_config: Config) => Promise.resolve(0));
    const runOnboarding = mock(() => Promise.resolve(0));
    const code = await mainWithRunners(sandboxArgs([]), {
      runTUI,
      runExec,
      runOnboarding,
    });
    expect(code).toBe(0);
    expect(runTUI).toHaveBeenCalled();
    expect(runExec).not.toHaveBeenCalled();
  });
});

test("main launches exec when configured with exec subcommand", async () => {
  await withEnv(async () => {
    const runTUI = mock((_config: Config) => Promise.resolve(0));
    const runExec = mock((_config: Config) => Promise.resolve(0));
    const runOnboarding = mock(() => Promise.resolve(0));
    const code = await mainWithRunners(sandboxArgs(["exec"], ["say hello"]), {
      runTUI,
      runExec,
      runOnboarding,
    });
    expect(code).toBe(0);
    expect(runExec).toHaveBeenCalled();
    expect(runTUI).not.toHaveBeenCalled();
    const cfg = runExec.mock.calls[0]![0];
    expect(cfg.command).toBe("exec");
    expect(cfg.task).toBe("say hello");
  });
});

test("main launches exec for run alias", async () => {
  await withEnv(async () => {
    const runTUI = mock((_config: Config) => Promise.resolve(0));
    const runExec = mock((_config: Config) => Promise.resolve(0));
    const runOnboarding = mock(() => Promise.resolve(0));
    const code = await mainWithRunners(sandboxArgs(["run"], ["do the thing"]), {
      runTUI,
      runExec,
      runOnboarding,
    });
    expect(code).toBe(0);
    expect(runExec).toHaveBeenCalled();
    const cfg = runExec.mock.calls[0]![0];
    expect(cfg.command).toBe("exec");
    expect(cfg.task).toBe("do the thing");
  });
});

test("CliUserError prints one line to stderr without a stack", () => {
  const err = new CliUserError(
    "Session abc is unreadable. Use `corbits resume` to choose another.",
  );
  const exit = cliCaughtExit(err);
  expect(exit.stream).toBe("stderr");
  expect(exit.code).toBe(1);
  expect(exit.text).toBe(`${err.message}\n`);
  expect(exit.text).not.toContain("    at ");
  expect(exit.text.trimEnd().split("\n")).toHaveLength(1);
});

test("CliHelpError prints help to stdout and exits 0", () => {
  const err = new CliHelpError("usage: corbits");
  const exit = cliCaughtExit(err);
  expect(exit.stream).toBe("stdout");
  expect(exit.code).toBe(0);
  expect(exit.text).toBe("usage: corbits\n");
});

test("generic Error still dumps a stack to stderr", () => {
  const err = new Error("No session abc for this project");
  const exit = cliCaughtExit(err);
  expect(exit.stream).toBe("stderr");
  expect(exit.code).toBe(1);
  expect(exit.text).toContain("No session abc for this project");
  expect(exit.text).toContain("    at ");
});
