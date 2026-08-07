import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config/index.js";
import {
  resetPricingMetadataRefreshForTests,
  schedulePricingMetadataRefresh,
} from "../../src/cost/pricing-metadata.js";
import { mainWithRunners } from "../../src/index.js";

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
      if (value === undefined) delete process.env[key];
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
