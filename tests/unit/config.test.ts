import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/index.js";
import { resetPricingMetadataRefreshForTests } from "../../src/cost/pricing-metadata.js";
import { withMockedModuleDuring } from "../helpers/mock-module.js";

// Rejects immediately instead of touching the network. loadConfig's pricing
// refresh is fire-and-forget, so a resolved run proves only that the injected
// impl was reached — which is exactly the regression this file guards against:
// the default impl performs a real fetch of models.dev from inside the suite.
function offlineFetch(): { impl: typeof fetch; calls: () => number } {
  let count = 0;
  const impl = (() => {
    count++;
    return Promise.reject(new Error("offline"));
  }) as unknown as typeof fetch;
  return { impl, calls: () => count };
}

// Writes a minimal valid global settings file with a single provider so that
// provider resolution succeeds; these tests only exercise flag parsing.
async function withSettings(
  fn: (opts: { cwd: string; globalSettingsPath: string }) => void | Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "ic-unit-config-"));
  const globalSettingsPath = join(cwd, "global.json");
  await writeFile(
    globalSettingsPath,
    JSON.stringify({
      defaultProvider: "test-provider",
      providers: {
        "test-provider": {
          baseURL: "http://localhost:1234",
          apiKey: "test-key",
          models: ["test-model"],
        },
      },
    }),
  );
  try {
    await fn({ cwd, globalSettingsPath });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("loadConfig defaults auto mode on", async () => {
  await withSettings(async ({ cwd, globalSettingsPath }) => {
    const { impl } = offlineFetch();
    const config = await loadConfig(["--cwd", cwd, "do something"], {
      globalSettingsPath,
      pricing: { fetchImpl: impl },
    });
    expect(config.auto).toBe(true);
  });
});

test("loadConfig --no-auto disables auto mode", async () => {
  await withSettings(async ({ cwd, globalSettingsPath }) => {
    const { impl } = offlineFetch();
    const config = await loadConfig(["--cwd", cwd, "--no-auto", "do something"], {
      globalSettingsPath,
      pricing: { fetchImpl: impl },
    });
    expect(config.auto).toBe(false);
  });
});

test("loadConfig uses the injected pricing fetchImpl instead of the network", async () => {
  await withSettings(async ({ cwd, globalSettingsPath }) => {
    resetPricingMetadataRefreshForTests();
    const { impl, calls } = offlineFetch();
    await loadConfig(["--cwd", cwd, "do something"], {
      globalSettingsPath,
      pricing: { fetchImpl: impl },
    });
    // The refresh is scheduled fire-and-forget; yield so it kicks off.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls()).toBeGreaterThan(0);
  });
});

test("local settings target is omitted when it aliases global settings", async () => {
  const { globalSettingsPath, resolveLocalSettingsPath } =
    await import("../../src/config/settings.js");
  const home = await mkdtemp(join(tmpdir(), "ic-unit-config-home-alias-"));
  try {
    const globalPath = globalSettingsPath(home);
    expect(resolveLocalSettingsPath(home, globalPath)).toBeNull();
    expect(
      resolveLocalSettingsPath(home, join(home, "nested", "..", ".corbits", "settings.json")),
    ).toBeNull();
    expect(resolveLocalSettingsPath(home, join(home, "explicit.json"))).toBe(
      join(home, ".corbits", "settings.json"),
    );
    expect(resolveLocalSettingsPath(join(home, "repo"), globalPath)).toBe(
      join(home, "repo", ".corbits", "settings.json"),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("loadSettings recovers only an exact clobbered local selection", async () => {
  const { loadSettings } = await import("../../src/config/settings.js");
  const cwd = await mkdtemp(join(tmpdir(), "ic-unit-config-recovery-"));
  try {
    const clobberedPath = join(cwd, "clobbered.json");
    await writeFile(clobberedPath, JSON.stringify({ provider: "openai", model: "gpt-5" }));
    expect(await loadSettings(clobberedPath)).toEqual({ providers: {} });
    expect(await loadSettings(clobberedPath)).toEqual({ providers: {} });

    const malformedPath = join(cwd, "malformed.json");
    await writeFile(
      malformedPath,
      JSON.stringify({ provider: "openai", model: "gpt-5", apiKey: "not-recoverable" }),
    );
    await expect(loadSettings(malformedPath)).rejects.toThrow(/Invalid settings schema/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("loadConfig does not load an aliased global file as local settings", async () => {
  const { globalSettingsPath } = await import("../../src/config/settings.js");
  const home = await mkdtemp(join(tmpdir(), "ic-unit-config-load-alias-"));
  const path = globalSettingsPath(home);
  try {
    await mkdir(join(home, ".corbits"), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        defaultProvider: "openai",
        providers: {
          openai: {
            baseURL: "https://api.openai.com/v1",
            apiKey: "test-key",
            models: ["gpt-5"],
          },
        },
      }),
    );
    const { impl } = offlineFetch();
    const config = await loadConfig(["--cwd", home, "hello"], {
      globalSettingsPath: path,
      pricing: { fetchImpl: impl },
    });
    expect(config.settingsDiagnostics).toBeUndefined();
    expect(config.providerName).toBe("openai");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("global settings round-trip the telemetry block", async () => {
  const { loadSettings, saveGlobalSettings } = await import("../../src/config/settings.js");
  const cwd = await mkdtemp(join(tmpdir(), "ic-unit-config-telemetry-"));
  const path = join(cwd, "global.json");
  try {
    await saveGlobalSettings(path, {
      providers: {},
      telemetry: { enabled: false, installationId: "test-id", noticeShown: true },
    });
    const loaded = await loadSettings(path);
    expect(loaded?.telemetry).toEqual({
      enabled: false,
      installationId: "test-id",
      noticeShown: true,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// Guard: a new optional Settings field forgotten in the load reconstruction
// must fail this test (or the compile-time OptionalSettingsFields map), not
// silently vanish on the next load/save cycle.
test("loadSettings cannot silently drop a known optional key", async () => {
  const {
    loadSettings,
    loadLocalSettings,
    GLOBAL_SETTINGS_OPTIONAL_KEYS,
    LOCAL_SETTINGS_OPTIONAL_KEYS,
  } = await import("../../src/config/settings.js");
  const cwd = await mkdtemp(join(tmpdir(), "ic-unit-config-nodrop-"));
  try {
    const globalPath = join(cwd, "global.json");
    const fixture = {
      providers: {
        p: { baseURL: "http://localhost:1", apiKey: "k", models: ["m"] },
      },
      defaultProvider: "p",
      mcpServers: [{ name: "s", command: "echo" }],
      tiers: { fast: { provider: "p", model: "m" } },
      workflowProfiles: { default: { implement: "m" } },
      plugins: { "plug-a": { enabled: true } },
      pluginPaths: ["/tmp/plugin"],
      hooks: { "/tmp/hook.ts": { enabled: false } },
      discoverClaudePlugins: true,
      web: "plug-a",
      hiddenCommands: ["/help"],
      onboarded: true,
      lastChangelogVersion: "0.1.0",
      compactionMode: "pruning" as const,
      subagentMaxTurns: 20,
      sessionMode: "orchestrator" as const,
      agentModelFallback: "none" as const,
      shell: { timeoutMs: 1000, maxTimeoutMs: 5000 },
      tools: { timeoutMs: 2000, waitForApproval: false },
      telemetry: { enabled: false, installationId: "id", noticeShown: true },
      otel: { endpoint: "http://localhost:4318", serviceName: "corbits-test" },
      recentModels: [{ provider: "p", model: "m" }],
      favoriteModels: [{ provider: "p", model: "m" }],
      dangerouslySkipPermissions: true,
    };
    await writeFile(globalPath, JSON.stringify(fixture));
    const loaded = await loadSettings(globalPath);
    expect(loaded).not.toBeNull();
    for (const key of GLOBAL_SETTINGS_OPTIONAL_KEYS) {
      expect(loaded).toHaveProperty(key);
      expect((loaded as unknown as Record<string, unknown>)[key]).not.toBeUndefined();
    }
    // Undefined optionals stay absent (not { foo: undefined }).
    const minimalPath = join(cwd, "minimal.json");
    await writeFile(minimalPath, JSON.stringify({ providers: {} }));
    const minimal = await loadSettings(minimalPath);
    expect(minimal).toEqual({ providers: {} });
    expect(Object.prototype.hasOwnProperty.call(minimal, "telemetry")).toBe(false);

    // Transforms still apply: discoverClaudePlugins only survives when true.
    const falseDiscoverPath = join(cwd, "false-discover.json");
    await writeFile(
      falseDiscoverPath,
      JSON.stringify({ providers: {}, discoverClaudePlugins: false }),
    );
    const falseDiscover = await loadSettings(falseDiscoverPath);
    expect(falseDiscover).toEqual({ providers: {} });
    expect(Object.prototype.hasOwnProperty.call(falseDiscover, "discoverClaudePlugins")).toBe(
      false,
    );

    // Local settings — including env, which the old hand-spread path dropped.
    const localPath = join(cwd, "local.json");
    const localFixture = {
      provider: "p",
      model: "m",
      reasoningEffort: "high" as const,
      mcpServers: [{ name: "s", command: "echo" }],
      sessionMode: "orchestrator" as const,
      env: { FOO: "bar" },
    };
    await writeFile(localPath, JSON.stringify(localFixture));
    const local = await loadLocalSettings(localPath);
    expect(local).not.toBeNull();
    for (const key of LOCAL_SETTINGS_OPTIONAL_KEYS) {
      expect(local).toHaveProperty(key);
      expect((local as Record<string, unknown>)[key]).not.toBeUndefined();
    }
    expect(local?.env).toEqual({ FOO: "bar" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// Regression: an OAuth-profile provider (xai/<profile>) is never written to
// settings.json — home-level auth stores are the source of truth, and
// loadConfig merges them into the catalog it hands to resolveProvider (see
// "OAuth profiles live in home-level auth stores" in src/config/index.ts).
// --config only overrides where provider *definitions* come from (CL-6973);
// it must still merge in the OAuth catalog, or every codex/xai OAuth run
// through --config reaches the provider unauthenticated. Only the
// programmatic `globalSettingsPath` test override (never exposed as a CLI
// flag) opts out, for full test isolation. This proves loadConfig picks an
// OAuth-ish catalog provider that exists in no settings file at all, using a
// synthetic profile written straight to the home-level auth store loadConfig
// actually reads.
test("loadConfig resolves an OAuth-profile provider absent from any settings file", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "ic-unit-config-oauth-home-"));
  const cwd = await mkdtemp(join(tmpdir(), "ic-unit-config-oauth-cwd-"));
  try {
    await mkdir(join(fakeHome, ".corbits"), { recursive: true });
    await writeFile(
      join(fakeHome, ".corbits", "xai-auth.json"),
      JSON.stringify({
        profiles: {
          synthetic: {
            name: "synthetic",
            tokens: {
              access: "test-access-token",
              refresh: "test-refresh",
              expiresAt: Date.now() + 3_600_000,
            },
            createdAt: Date.now(),
          },
        },
      }),
    );

    // Bun's os.homedir() does not observe process.env.HOME changed after
    // startup (unlike Node's documented behavior), and loadConfig's OAuth
    // profile merge always reads the real homedir() with no override
    // parameter — so the only way to point it at a synthetic auth store
    // without touching the real one is to stub node:os for the duration of
    // this call.
    await withMockedModuleDuring(
      import.meta.resolve("node:os"),
      (real: typeof import("node:os")) => ({ ...real, homedir: () => fakeHome }),
      async () => {
        const { impl } = offlineFetch();
        const config = await loadConfig(
          ["exec", "--cwd", cwd, "--provider", "xai/synthetic", "do something"],
          { pricing: { fetchImpl: impl } },
        );

        expect(config.configured).toBe(true);
        if (config.configured) {
          expect(config.providerName).toBe("xai/synthetic");
          expect(config.providers.some((p) => p.name === "xai/synthetic")).toBe(true);
        }
      },
    );
  } finally {
    await rm(fakeHome, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

// CL-6973: --config <path> passes a settings-file override for provider
// *definitions*, but credentials for OAuth-profile providers (codex/<name>,
// xai/<name>) live in separate home-level auth stores that --config never
// touches. Before this fix, an explicit --config unconditionally suppressed
// the OAuth catalog merge, so any codex/xai run through --config resolved to
// an unauthenticated provider (HTTP 426/404 on the first turn). This proves
// --config composes with auth: the OAuth profile still resolves even though
// a --config file is also given, and the file's own settings still apply.
test("--config composes with OAuth profile auth instead of suppressing it", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "ic-unit-config-oauth-compose-home-"));
  const cwd = await mkdtemp(join(tmpdir(), "ic-unit-config-oauth-compose-cwd-"));
  try {
    await mkdir(join(fakeHome, ".corbits"), { recursive: true });
    await writeFile(
      join(fakeHome, ".corbits", "xai-auth.json"),
      JSON.stringify({
        profiles: {
          synthetic: {
            name: "synthetic",
            tokens: {
              access: "test-access-token",
              refresh: "test-refresh",
              expiresAt: Date.now() + 3_600_000,
            },
            createdAt: Date.now(),
          },
        },
      }),
    );
    const configPath = join(cwd, "settings-override.json");
    await writeFile(configPath, JSON.stringify({ providers: {} }));

    await withMockedModuleDuring(
      import.meta.resolve("node:os"),
      (real: typeof import("node:os")) => ({ ...real, homedir: () => fakeHome }),
      async () => {
        const { impl } = offlineFetch();
        const config = await loadConfig(
          [
            "exec",
            "--cwd",
            cwd,
            "--config",
            configPath,
            "--provider",
            "xai/synthetic",
            "do something",
          ],
          { pricing: { fetchImpl: impl } },
        );

        expect(config.configured).toBe(true);
        if (config.configured) {
          expect(config.providerName).toBe("xai/synthetic");
          expect(config.providers.some((p) => p.name === "xai/synthetic")).toBe(true);
          expect(config.globalSettingsPath).toBe(configPath);
        }
      },
    );
  } finally {
    await rm(fakeHome, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});
