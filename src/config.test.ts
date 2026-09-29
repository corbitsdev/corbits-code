import { defined } from "./testkit/defined.js";
import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  buildBifrostSource,
  buildGoSource,
  buildOpenAISource,
  buildXaiSource,
  buildProviderCatalog,
  catalogEntryAsProviderSettings,
  CliHelpError,
  CliUserError,
  CLI_HELP_TEXT,
  KEYLESS_API_KEY,
  loadConfig,
  providerCatalogToSettings,
  refreshLiveProviderCatalog,
  resolveMcpServers,
  runtimeSettingsWithCatalog,
  SOURCE_MAX_TOKENS,
} from "./config/index.js";
import { DIRECTOR_IDS } from "./agent/directors/types.js";
import {
  clearSourceCredentials,
  peekSourceCredentialSecret,
} from "./config/source-credentials.js";
import type { Config, UnconfiguredConfig } from "./config/index.js";
import {
  mergeProviderIntoSettings,
  type ResolvedProvider,
  type Settings,
} from "./config/settings.js";
import {
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_MODEL_IDS,
} from "../packages/opencode-go/src/index.js";
import {
  ZEN_DEFAULT_BASE_URL,
  ZEN_MODEL_IDS,
} from "../packages/zen/src/index.js";
import {
  prefetchGoModels,
  prefetchZenModels,
  resetGoModelDiscoveryForTests,
  resetZenModelDiscoveryForTests,
} from "./provider/model-catalogs.js";
import {
  generateSessionId,
  initSessionDir,
  sessionContextDir,
  sessionDir,
} from "./session/index.js";
import { saveState } from "./session/state.js";
import { createOptimizedContextStore } from "./session/optimized-context-store.js";
import { projectSessionsRoot } from "./session/project-key.js";
import { filterMcpServersForConnect } from "./trust/project-trust.js";
import { createExaMCPServerConfig } from "./mcp/exa.js";
import { withFileLogSink } from "./testkit/file-log-sink.js";
import { setProviderContextWindowOverrides } from "./provider/context-window.js";

const BUILTIN_EXA_MCP = createExaMCPServerConfig();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  resetGoModelDiscoveryForTests();
  resetZenModelDiscoveryForTests();
});

// Temp dirs created by emptyCwd/tempHome are registered here and removed
// after each test, so tests don't need their own try/finally cleanup.
const tempDirs: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  resetGoModelDiscoveryForTests();
  resetZenModelDiscoveryForTests();
  setProviderContextWindowOverrides(undefined);
  clearSourceCredentials();
  while (tempDirs.length > 0) {
    await rm(defined(tempDirs.pop()), { recursive: true, force: true });
  }
});

function assertConfigured(
  config: Config | UnconfiguredConfig,
): asserts config is Config {
  if (config.configured === false) {
    throw new Error(
      `Expected configured Config but got UnconfiguredConfig: ${config.providerError}`,
    );
  }
}

// A global settings path guaranteed not to exist, so resolution finds no
// provider — used by the "missing provider" cases.
const NO_SETTINGS = join(
  tmpdir(),
  "corbits-tests-missing",
  ".corbits",
  "settings.json",
);

// Writes a minimal valid global settings file with a single provider and
// returns its path. Provider resolution reads exclusively from such files.
// `extras` are merged as extra top-level settings fields.
async function writeGlobalSettings(
  cwd: string,
  extras?: Record<string, unknown>,
): Promise<string> {
  const path = join(cwd, "global.json");
  await writeFile(
    path,
    JSON.stringify({
      defaultProvider: "fireworks",
      providers: {
        fireworks: {
          baseURL: "https://api.fireworks.ai/inference",
          apiKey: "test-key",
          models: ["accounts/fireworks/routers/kimi-k2p6-turbo"],
        },
      },
      ...extras,
    }),
  );
  return path;
}

// A cwd with no per-repo settings file, so local resolution is inert.
async function emptyCwd(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ic-config-"));
  tempDirs.push(dir);
  return dir;
}

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ic-resume-home-"));
  tempDirs.push(dir);
  return dir;
}

// Shared "currently configured provider" fixture for the catalog tests.
const resolved: ResolvedProvider = {
  providerName: "fp",
  baseURL: "https://fp/v1",
  apiKey: "fp-key",
  model: "fp-large",
};

async function sessionIdsOnDisk(cwd: string, home: string): Promise<string[]> {
  try {
    const names = await readdir(projectSessionsRoot(cwd, home));
    return names.filter((name) => name !== "latest").sort();
  } catch {
    return [];
  }
}

async function expectCliHelp(argv: readonly string[]): Promise<void> {
  try {
    await loadConfig([...argv], { globalSettingsPath: NO_SETTINGS });
    expect.unreachable("expected CliHelpError");
  } catch (err) {
    expect(err).toBeInstanceOf(CliHelpError);
    const help = err as CliHelpError;
    expect(help.exitCode).toBe(0);
    expect(help.message).toBe(CLI_HELP_TEXT);
  }
}

describe("loadConfig", () => {
  test("resolves provider from the global settings file", async () => {
    const cwd = await emptyCwd();
    const globalPath = await writeGlobalSettings(cwd);
    const config = await loadConfig(["--cwd", cwd, "add", "hello", "world"], {
      globalSettingsPath: globalPath,
    });
    assertConfigured(config);
    expect(config.task).toBe("add hello world");
    expect(config.apiKey).toBe("test-key");
    expect(config.baseURL).toBe("https://api.fireworks.ai/inference");
    expect(config.model).toBe("accounts/fireworks/routers/kimi-k2p6-turbo");
    expect(config.providerName).toBe("fireworks");
    expect(config.globalSettingsPath).toBe(globalPath);
    expect(config.globalDefaultProvider).toBe("fireworks");
  });

  test("injects the built-in Exa MCP server when no list disables or overrides it", async () => {
    expect(resolveMcpServers(undefined, undefined)).toEqual([BUILTIN_EXA_MCP]);

    const cwd = await emptyCwd();
    const globalPath = await writeGlobalSettings(cwd);
    const config = await loadConfig(["--cwd", cwd, "hello"], {
      globalSettingsPath: globalPath,
    });
    assertConfigured(config);
    expect(config.mcpServers).toEqual([BUILTIN_EXA_MCP]);
    expect(config.mcpServersSource).toBe("none");
    expect(config.mcpServerEntries).toEqual([]);
  });

  test("expands enabled Exa preset and honors explicit disable", () => {
    expect(
      resolveMcpServers([{ name: "exa", enabled: true }], undefined),
    ).toEqual([BUILTIN_EXA_MCP]);
    expect(
      resolveMcpServers([{ name: "exa", enabled: false }], undefined),
    ).toEqual([]);
  });

  test("keeps global and local MCP source at list level", async () => {
    const cwd = await emptyCwd();
    const globalPath = await writeGlobalSettings(cwd, {
      mcpServers: { exa: { enabled: true } },
    });
    const globalConfig = await loadConfig(["--cwd", cwd, "hello"], {
      globalSettingsPath: globalPath,
    });
    assertConfigured(globalConfig);
    expect(globalConfig.mcpServers).toEqual([BUILTIN_EXA_MCP]);
    expect(globalConfig.mcpServersSource).toBe("global");
    expect(globalConfig.mcpServerEntries).toEqual([
      { name: "exa", enabled: true },
    ]);

    await writeGlobalSettings(cwd, {
      mcpServers: { exa: { enabled: false } },
    });
    const disabledConfig = await loadConfig(["--cwd", cwd, "hello"], {
      globalSettingsPath: globalPath,
    });
    assertConfigured(disabledConfig);
    expect(disabledConfig.mcpServers).toEqual([]);
    expect(disabledConfig.mcpServersSource).toBe("global");
    expect(disabledConfig.mcpServerEntries).toEqual([
      { name: "exa", enabled: false },
    ]);

    await writeGlobalSettings(cwd, {
      mcpServers: { exa: { enabled: true } },
    });
    await mkdir(join(cwd, ".corbits"), { recursive: true });
    await writeFile(
      join(cwd, ".corbits", "settings.json"),
      JSON.stringify({ mcpServers: { local: { command: "local-mcp" } } }),
    );
    const localConfig = await loadConfig(["--cwd", cwd, "hello"], {
      globalSettingsPath: globalPath,
    });
    assertConfigured(localConfig);
    expect(localConfig.mcpServers).toEqual([
      BUILTIN_EXA_MCP,
      { name: "local", command: "local-mcp" },
    ]);
    expect(localConfig.mcpServersSource).toBe("local");
    expect(localConfig.mcpServerEntries).toEqual([
      { name: "local", command: "local-mcp" },
    ]);
  });

  test("preserves custom Exa and lets local omission inherit global disable", () => {
    // A transport-bearing exa row is a custom server: it wins over the preset
    // and is never duplicated alongside it, with or without enabled: true.
    expect(
      resolveMcpServers(
        [{ name: "exa", type: "http", url: "https://example.test/mcp" }],
        undefined,
      ),
    ).toEqual([{ name: "exa", type: "http", url: "https://example.test/mcp" }]);
    expect(
      resolveMcpServers(
        [
          {
            name: "exa",
            type: "http",
            url: "https://example.test/mcp",
            enabled: true,
          },
        ],
        undefined,
      ),
    ).toEqual([{ name: "exa", type: "http", url: "https://example.test/mcp" }]);
    expect(
      resolveMcpServers(
        [{ name: "exa", type: "http", url: "https://example.test/mcp" }],
        [{ name: "local", command: "local-mcp" }],
      ),
    ).toEqual([{ name: "local", command: "local-mcp" }]);
    expect(
      resolveMcpServers(
        [{ name: "exa", enabled: false }],
        [{ name: "local", command: "local-mcp" }],
      ),
    ).toEqual([{ name: "local", command: "local-mcp" }]);
    expect(
      resolveMcpServers(
        [{ name: "exa", enabled: false }],
        [{ name: "exa", enabled: true }],
      ),
    ).toEqual([BUILTIN_EXA_MCP]);
    expect(
      resolveMcpServers(
        [{ name: "exa", type: "http", url: "https://example.test/mcp" }],
        [{ name: "exa", enabled: false }],
      ),
    ).toEqual([]);
    expect(
      resolveMcpServers(
        [{ name: "exa", enabled: false }],
        [{ name: "exa", type: "http", url: "https://local.example.test/mcp" }],
      ),
    ).toEqual([
      { name: "exa", type: "http", url: "https://local.example.test/mcp" },
    ]);
  });

  test("drops disabled transport rows without expanding them to Exa", () => {
    expect(
      resolveMcpServers(
        [
          {
            name: "linear",
            type: "http",
            url: "https://mcp.linear.app/mcp",
            enabled: false,
          },
        ],
        undefined,
      ),
    ).toEqual([BUILTIN_EXA_MCP]);
    expect(
      resolveMcpServers(
        [
          {
            name: "linear",
            type: "http",
            url: "https://mcp.linear.app/mcp",
            enabled: false,
          },
          { name: "files", command: "files-mcp" },
        ],
        undefined,
      ),
    ).toEqual([BUILTIN_EXA_MCP, { name: "files", command: "files-mcp" }]);
  });

  test("loadConfig keeps disabled global transport rows in mcpServerEntries only", async () => {
    const cwd = await emptyCwd();
    const globalPath = await writeGlobalSettings(cwd, {
      mcpServers: {
        linear: {
          type: "http",
          url: "https://mcp.linear.app/mcp",
          enabled: false,
        },
      },
    });
    const config = await loadConfig(["--cwd", cwd, "hello"], {
      globalSettingsPath: globalPath,
    });
    assertConfigured(config);
    expect(config.mcpServersSource).toBe("global");
    expect(config.mcpServerEntries).toEqual([
      {
        name: "linear",
        type: "http",
        url: "https://mcp.linear.app/mcp",
        enabled: false,
      },
    ]);
    expect(config.mcpServers).toEqual([BUILTIN_EXA_MCP]);
  });

  test("local custom MCP requires trust while built-in Exa bypasses project trust", async () => {
    const servers = resolveMcpServers(undefined, [
      { name: "local", command: "local-mcp" },
    ]);

    expect(servers).toEqual([
      BUILTIN_EXA_MCP,
      { name: "local", command: "local-mcp" },
    ]);
    await expect(
      filterMcpServersForConnect(servers, {
        source: "local",
        cwd: "/repo/without-trust-grant",
        store: {
          trustedPluginPaths: [],
          trustedMcpFingerprints: [],
          trustedGrantFingerprints: [],
        },
      }),
    ).resolves.toEqual([BUILTIN_EXA_MCP]);
  });

  test("throws when no provider can be resolved (allowUnconfigured false)", async () => {
    const cwd = await emptyCwd();
    await expect(
      loadConfig(["--cwd", cwd, "do it"], {
        globalSettingsPath: NO_SETTINGS,
      }),
    ).rejects.toThrow(/missing/);
  });

  test("returns UnconfiguredConfig when allowUnconfigured is true and provider is missing", async () => {
    const cwd = await emptyCwd();
    const result = await loadConfig(["--cwd", cwd, "do it"], {
      globalSettingsPath: NO_SETTINGS,
      allowUnconfigured: true,
    });
    expect(result.configured).toBe(false);
    if (result.configured === false) {
      expect(result.cwd).toBe(cwd);
      expect(result.task).toBe("do it");
      expect(result.providerError).toMatch(/missing/);
      expect(result.globalSettingsPath).toBe(NO_SETTINGS);
      expect(result.cliConfigPath).toBeUndefined();
      expect(result.programmaticSettingsPath).toBe(true);
    }
  });

  test("threads local settings diagnostics on unconfigured early return", async () => {
    const cwd = await emptyCwd();
    await mkdir(join(cwd, ".corbits"), { recursive: true });
    await writeFile(
      join(cwd, ".corbits", "settings.json"),
      JSON.stringify({ unknownKey: true, anotherJunk: 1 }),
    );
    const result = await loadConfig(["--cwd", cwd, "do it"], {
      globalSettingsPath: NO_SETTINGS,
      allowUnconfigured: true,
    });
    expect(result.configured).toBe(false);
    if (result.configured === false) {
      expect(result.settingsDiagnostics).toBeDefined();
      expect(defined(result.settingsDiagnostics).length).toBeGreaterThan(0);
      expect(
        defined(result.settingsDiagnostics).some((d) =>
          /unknown/i.test(d.message),
        ),
      ).toBe(true);
    }
  });

  test("UnconfiguredConfig.globalSettingsPath reflects --config path, not the global default", async () => {
    const cwd = await emptyCwd();
    const configPath = join(cwd, "custom.json");
    await writeFile(configPath, JSON.stringify({ providers: {} }));
    const result = await loadConfig(
      ["--cwd", cwd, "--config", configPath, "task"],
      {
        allowUnconfigured: true,
      },
    );
    expect(result.configured).toBe(false);
    if (result.configured === false) {
      expect(result.globalSettingsPath).toBe(configPath);
      expect(result.cliConfigPath).toBe(configPath);
      expect(result.programmaticSettingsPath).toBe(false);
    }
  });

  test.each([
    (cwd: string) => ["--cwd", cwd, "--force", "run task"],
    (cwd: string) => ["exec", "--cwd", cwd, "--force", "ship it"],
    (cwd: string, id: string) => ["resume", id, "--force", "--cwd", cwd],
  ])("rejects --force as unrecognized (%#)", async (argv) => {
    const cwd = await emptyCwd();
    const globalPath = await writeGlobalSettings(cwd);
    await expect(
      loadConfig(argv(cwd, generateSessionId()), {
        globalSettingsPath: globalPath,
      }),
    ).rejects.toThrow("unrecognized flag: --force");
  });

  test.each([
    {
      argv: ["exec", "--auto", "ship it"],
      expected: { task: "ship it", auto: true },
    },
    { argv: ["run", "alias task"], expected: { task: "alias task" } },
    {
      argv: ["exec", "--director", "builder", "ship it"],
      expected: { task: "ship it", director: "builder" },
    },
    // No --director leaves it undefined (skywalker default).
    { argv: ["exec", "ship it"], expected: { task: "ship it" } },
  ] as const)("parses %j as exec", async ({ argv, expected }) => {
    const cwd = await emptyCwd();
    const globalPath = await writeGlobalSettings(cwd);
    const config = await loadConfig([...argv, "--cwd", cwd], {
      globalSettingsPath: globalPath,
    });
    assertConfigured(config);
    expect(config.command).toBe("exec");
    expect(config).toMatchObject(expected);
    if (!("director" in expected)) {
      expect(config.director).toBeUndefined();
    }
  });

  test("unknown --director id errors listing DIRECTOR_IDS", async () => {
    await expect(
      loadConfig(["exec", "--director", "nope", "ship it"], {
        globalSettingsPath: NO_SETTINGS,
      }),
    ).rejects.toThrow(
      new RegExp(`Unknown director "nope".*${DIRECTOR_IDS.join(", ")}`),
    );
  });

  test("--director without a value errors", async () => {
    await expect(
      loadConfig(["exec", "--director"], { globalSettingsPath: NO_SETTINGS }),
    ).rejects.toThrow("--director requires a value");
  });

  test("--director without exec/run is rejected", async () => {
    await expect(
      loadConfig(["--director", "implement", "ship it"], {
        globalSettingsPath: NO_SETTINGS,
      }),
    ).rejects.toThrow("--director is only available in exec mode");
  });

  test.each([
    // --pick flag, bare resume, and the continue --list alias all land on the
    // picker without requiring prior sessions.
    { argv: ["resume", "--pick"] },
    { argv: ["resume"] },
    { argv: ["continue", "--list"] },
  ] as const)("$argv opens the session picker", async ({ argv }) => {
    const cwd = await emptyCwd();
    const globalPath = await writeGlobalSettings(cwd);
    const config = await loadConfig([...argv, "--cwd", cwd], {
      globalSettingsPath: globalPath,
      home: await tempHome(),
    });
    assertConfigured(config);
    expect(config.command).toBe("tui");
    expect(config.resumeMode).toBe("pick");
    expect(config.resumePicker).toBe(true);
    expect(config.skipInitialTask).toBe(true);
  });

  test("resume <id> reopens a known session and skips the initial task", async () => {
    const cwd = await emptyCwd();
    const home = await tempHome();
    const globalPath = await writeGlobalSettings(cwd);
    const sessionId = generateSessionId();
    await initSessionDir(cwd, sessionId, home);
    await saveState(
      cwd,
      sessionId,
      {
        status: "done",
        turnsUsed: 2,
        task: "ship resume",
        startedAt: Date.now() - 1_000,
        finishedAt: Date.now(),
      },
      home,
    );
    const config = await loadConfig(["resume", sessionId, "--cwd", cwd], {
      globalSettingsPath: globalPath,
      home,
    });
    assertConfigured(config);
    expect(config.resumeMode).toBe("id");
    expect(config.sessionId).toBe(sessionId);
    expect(config.skipInitialTask).toBe(true);
    expect(config.task).toBe("ship resume");
  });

  test("resume <id> among failed siblings stays silent and reopens the target", async () => {
    const cwd = await emptyCwd();
    const home = await tempHome();
    const globalPath = await writeGlobalSettings(cwd);
    const targetId = generateSessionId();
    for (let i = 0; i < 6; i++) {
      const id = i === 0 ? targetId : generateSessionId();
      await initSessionDir(cwd, id, home);
      await saveState(
        cwd,
        id,
        {
          status: "failed",
          turnsUsed: 2,
          task: i === 0 ? "target failed session" : `sibling failed ${i}`,
          startedAt: Date.now() - 1_000 - i,
          finishedAt: Date.now() - i,
          error: "Cycle commit failed\nhook dump: pre-commit rejected",
        },
        home,
      );
    }

    let config: Awaited<ReturnType<typeof loadConfig>> | undefined;
    const logged = await withFileLogSink(async () => {
      config = await loadConfig(["resume", targetId, "--cwd", cwd], {
        globalSettingsPath: globalPath,
        home,
      });
    });
    const loaded = defined(config, "config");
    assertConfigured(loaded);
    expect(loaded.sessionId).toBe(targetId);
    expect(loaded.task).toBe("target failed session");
    expect(logged).not.toContain("unreadable session state");
    expect(logged).not.toContain(home);
  });

  test("-p is the exec one-shot path in either flag order", async () => {
    const cwd = await emptyCwd();
    const globalPath = await writeGlobalSettings(cwd);
    const model = "accounts/fireworks/routers/kimi-k2p6-turbo";
    const viaExec = await loadConfig(["exec", "--cwd", cwd, "do the thing"], {
      globalSettingsPath: globalPath,
    });
    const viaP = await loadConfig(["-p", "--cwd", cwd, "do the thing"], {
      globalSettingsPath: globalPath,
    });
    const providerFirst = await loadConfig(
      ["-p", "--provider", "fireworks", "--cwd", cwd, "hello"],
      { globalSettingsPath: globalPath },
    );
    const modelFirst = await loadConfig(
      ["--model", model, "-p", "--cwd", cwd, "hello"],
      { globalSettingsPath: globalPath },
    );
    const directorFirst = await loadConfig(
      ["--director", "skywalker", "-p", "--cwd", cwd, "ship it"],
      { globalSettingsPath: globalPath },
    );
    assertConfigured(viaExec);
    assertConfigured(viaP);
    assertConfigured(providerFirst);
    assertConfigured(modelFirst);
    assertConfigured(directorFirst);
    expect(viaP.command).toBe("exec");
    expect(viaP.task).toBe(viaExec.task);
    expect(viaP.providerName).toBe(viaExec.providerName);
    expect(viaP.model).toBe(viaExec.model);
    expect(providerFirst.command).toBe("exec");
    expect(providerFirst.providerName).toBe("fireworks");
    expect(providerFirst.task).toBe("hello");
    expect(modelFirst.command).toBe("exec");
    expect(modelFirst.model).toBe(model);
    expect(modelFirst.task).toBe("hello");
    expect(directorFirst.command).toBe("exec");
    expect(directorFirst.director).toBe("skywalker");
    expect(directorFirst.task).toBe("ship it");
  });

  test("exec --resume and -p --resume send the new prompt on that session", async () => {
    const cwd = await emptyCwd();
    const home = await tempHome();
    const globalPath = await writeGlobalSettings(cwd);
    const sessionId = generateSessionId();
    await initSessionDir(cwd, sessionId, home);
    await saveState(
      cwd,
      sessionId,
      {
        status: "done",
        turnsUsed: 2,
        task: "original task",
        startedAt: Date.now() - 1_000,
        finishedAt: Date.now(),
      },
      home,
    );
    const viaExec = await loadConfig(
      ["exec", "--resume", sessionId, "--cwd", cwd, "follow up"],
      { globalSettingsPath: globalPath, home },
    );
    const viaP = await loadConfig(
      ["-p", "--resume", sessionId, "--cwd", cwd, "follow up from p"],
      { globalSettingsPath: globalPath, home },
    );
    const flagOrder = await loadConfig(
      ["--resume", sessionId, "-p", "--cwd", cwd, "flag order"],
      { globalSettingsPath: globalPath, home },
    );
    assertConfigured(viaExec);
    assertConfigured(viaP);
    assertConfigured(flagOrder);
    expect(viaExec.command).toBe("exec");
    expect(viaExec.resumeMode).toBe("id");
    expect(viaExec.sessionId).toBe(sessionId);
    expect(viaExec.skipInitialTask).toBeUndefined();
    expect(viaExec.resumePicker).toBeUndefined();
    expect(viaExec.task).toBe("follow up");
    expect(viaP.command).toBe("exec");
    expect(viaP.sessionId).toBe(sessionId);
    expect(viaP.skipInitialTask).toBeUndefined();
    expect(viaP.task).toBe("follow up from p");
    expect(flagOrder.command).toBe("exec");
    expect(flagOrder.sessionId).toBe(sessionId);
    expect(flagOrder.task).toBe("flag order");
  });

  test("exec --resume without an id errors and does not open a picker", async () => {
    const cwd = await emptyCwd();
    const globalPath = await writeGlobalSettings(cwd);
    await expect(
      loadConfig(["exec", "--resume", "--cwd", cwd], {
        globalSettingsPath: globalPath,
      }),
    ).rejects.toThrow("--resume requires a session id in exec mode");
    await expect(
      loadConfig(["-p", "--resume", "--cwd", cwd, "orphan prompt"], {
        globalSettingsPath: globalPath,
      }),
    ).rejects.toThrow("--resume requires a session id in exec mode");
  });

  test("exec --resume with a missing or unreadable id does not create a session", async () => {
    const cwd = await emptyCwd();
    const home = await tempHome();
    const globalPath = await writeGlobalSettings(cwd);
    const missing = generateSessionId();
    await expect(
      loadConfig(["exec", "--resume", missing, "--cwd", cwd, "follow up"], {
        globalSettingsPath: globalPath,
        home,
      }),
    ).rejects.toThrow(new RegExp(`No session ${missing}`));
    expect(await sessionIdsOnDisk(cwd, home)).toEqual([]);

    const unreadable = generateSessionId();
    await initSessionDir(cwd, unreadable, home);
    await writeFile(join(sessionDir(cwd, unreadable, home), "run.json"), "{");
    await expect(
      loadConfig(["-p", "--resume", unreadable, "--cwd", cwd, "follow up"], {
        globalSettingsPath: globalPath,
        home,
      }),
    ).rejects.toBeInstanceOf(CliUserError);
    expect(await sessionIdsOnDisk(cwd, home)).toEqual([unreadable]);
  });

  test("a headless follow-up reopens the same context store and keeps prior turns", async () => {
    const cwd = await emptyCwd();
    const home = await tempHome();
    const globalPath = await writeGlobalSettings(cwd);
    const sessionId = generateSessionId();
    await initSessionDir(cwd, sessionId, home);
    await saveState(
      cwd,
      sessionId,
      {
        status: "done",
        turnsUsed: 1,
        task: "first task",
        startedAt: Date.now() - 1_000,
        finishedAt: Date.now(),
      },
      home,
    );
    const contextDir = sessionContextDir(cwd, sessionId, home);
    const first = await createOptimizedContextStore(contextDir);
    await first.writeTurns([
      {
        role: "user",
        content: [{ type: "text", text: "first task" }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "first answer" }],
        model: "test",
        timestamp: 2,
      },
    ]);
    await first.writeMetadata({
      pendingOperations: [],
      tokenUsage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        thinking: 0,
      },
    });
    await first.commit({ message: "cycle" });

    const config = await loadConfig(
      ["exec", "--resume", sessionId, "--cwd", cwd, "second prompt"],
      { globalSettingsPath: globalPath, home },
    );
    assertConfigured(config);
    expect(config.command).toBe("exec");
    expect(config.sessionId).toBe(sessionId);
    expect(config.task).toBe("second prompt");
    expect(config.skipInitialTask).toBeUndefined();

    const reopened = await createOptimizedContextStore(
      sessionContextDir(cwd, config.sessionId, home),
    );
    const loaded = await reopened.load();
    expect(
      loaded.turns.map((turn) => {
        const block = turn.content[0];
        return block?.type === "text" ? block.text : "";
      }),
    ).toEqual(["first task", "first answer"]);
  });

  // A free-form token must error rather than leak into task text or be
  // treated as "resume the last session".
  test.each([
    { argv: ["--resume", "not-a-session"] },
    { argv: ["resume", "not-a-uuid"] },
  ] as const)("$argv rejects a non-session-id token", async ({ argv }) => {
    const cwd = await emptyCwd();
    const globalPath = await writeGlobalSettings(cwd);
    await expect(
      loadConfig([...argv, "--cwd", cwd], {
        globalSettingsPath: globalPath,
      }),
    ).rejects.toThrow(/not a session id/);
  });

  test("plain corbits always creates fresh state even when a previous session exists", async () => {
    const cwd = await emptyCwd();
    const home = await tempHome();
    const globalPath = await writeGlobalSettings(cwd);
    const subdir = join(cwd, "nested");
    await mkdir(subdir);
    const previousId = generateSessionId();
    await initSessionDir(cwd, previousId, home);
    await saveState(
      cwd,
      previousId,
      {
        status: "running",
        turnsUsed: 10,
        task: "old conversation",
        startedAt: Date.now() - 500,
      },
      home,
    );

    const first = await loadConfig(["--cwd", cwd], {
      globalSettingsPath: globalPath,
      home,
    });
    const second = await loadConfig(["--cwd", cwd], {
      globalSettingsPath: globalPath,
      home,
    });
    const nested = await loadConfig(["--cwd", subdir], {
      globalSettingsPath: globalPath,
      home,
    });
    assertConfigured(first);
    assertConfigured(second);
    assertConfigured(nested);
    expect(first.resumeMode).toBeUndefined();
    expect(second.resumeMode).toBeUndefined();
    expect(nested.resumeMode).toBeUndefined();
    expect(first.sessionId).not.toBe(previousId);
    expect(second.sessionId).not.toBe(previousId);
    expect(nested.sessionId).not.toBe(previousId);
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(nested.sessionId).not.toBe(first.sessionId);
    expect(nested.sessionId).not.toBe(second.sessionId);
    expect(first.task).toBe("");
    expect(second.task).toBe("");
    expect(nested.task).toBe("");
  });

  test("resume <id> rejects an unknown session id for this project", async () => {
    const cwd = await emptyCwd();
    const home = await tempHome();
    const globalPath = await writeGlobalSettings(cwd);
    const missing = generateSessionId();
    await expect(
      loadConfig(["resume", missing, "--cwd", cwd], {
        globalSettingsPath: globalPath,
        home,
      }),
    ).rejects.toThrow(new RegExp(`No session ${missing}`));
  });

  test("resume <id> of an unreadable session throws a short recovery line", async () => {
    const cwd = await emptyCwd();
    const home = await tempHome();
    const globalPath = await writeGlobalSettings(cwd);
    const sessionId = generateSessionId();
    await initSessionDir(cwd, sessionId, home);
    const runPath = join(sessionDir(cwd, sessionId, home), "run.json");
    await writeFile(runPath, "{ not json");

    let thrown: unknown;
    const logged = await withFileLogSink(async () => {
      try {
        await loadConfig(["resume", sessionId, "--cwd", cwd], {
          globalSettingsPath: globalPath,
          home,
        });
      } catch (err) {
        thrown = err;
      }
    });

    expect(thrown).toBeInstanceOf(CliUserError);
    if (thrown instanceof CliUserError) {
      expect(thrown.exitCode).toBe(1);
    }
    expect(logged).toContain(runPath);
    expect(logged).toContain("corrupt JSON");
  });

  test("resume rejects combining a session id with --pick", async () => {
    const cwd = await emptyCwd();
    const globalPath = await writeGlobalSettings(cwd);
    const id = generateSessionId();
    await expect(
      loadConfig(["resume", id, "--pick", "--cwd", cwd], {
        globalSettingsPath: globalPath,
      }),
    ).rejects.toThrow(/cannot combine a session id with --pick/);
  });

  test.each([
    [["--help"]],
    [["-h"]],
    [["--auto", "--help"]],
    [["--auto", "-h"]],
    [["ship it", "--help"]],
    [["ship", "it", "--help"]],
    [["--cwd", ".", "--help"]],
    [["--provider", "fireworks", "--help"]],
    [["exec", "--help"]],
    [["exec", "--director", "--help"]],
    [["resume", "--pick", "--help"]],
    [["resume", "-h"]],
    [["resume", "--help"]],
    [["continue", "-h"]],
    // Value flags must not swallow --help / -h as their value.
    [["--provider", "--help"]],
    [["--provider", "-h"]],
    [["--model", "--help"]],
    [["--model", "-h"]],
    [["--cwd", "--help"]],
    [["--cwd", "-h"]],
    [["--config", "--help"]],
    [["--config", "-h"]],
    [["--profile", "--help"]],
    [["--profile", "-h"]],
  ])(
    "%j throws CliHelpError with exitCode 0 and full help text",
    async (argv) => {
      await expectCliHelp(argv);
    },
  );

  test.each([
    // Other flag-shaped tokens are not accepted as values.
    [["--provider", "--auto"], "--provider requires a value"],
    [["--model", "--cwd"], "--model requires a value"],
    [["--cwd", "--tmp"], "--cwd requires a value"],
    [
      ["exec", "--director", "--auto", "ship it"],
      "--director requires a value",
    ],
    // An omitted value errors the same way.
    [["--provider"], "--provider requires a value"],
    [["--model"], "--model requires a value"],
    [["--cwd"], "--cwd requires a value"],
    [["--config"], "--config requires a value"],
    [["--profile"], "--profile requires a value"],
  ] as const)("%j rejects with %s", async (argv, message) => {
    await expect(
      loadConfig([...argv], { globalSettingsPath: NO_SETTINGS }),
    ).rejects.toThrow(message);
  });

  test("value flags accept a POSIX path that starts with a single dash", async () => {
    const config = await loadConfig(["--cwd", "-my-dir", "do something"], {
      allowUnconfigured: true,
      globalSettingsPath: NO_SETTINGS,
    });
    expect(config.cwd).toBe(resolve("-my-dir"));
  });

  test("rejects unknown flags", async () => {
    await expect(
      loadConfig(["--unknown"], { globalSettingsPath: NO_SETTINGS }),
    ).rejects.toThrow(/unrecognized flag/);
  });

  // Precedence matrix. `skipPermissionsFromSettings` is true only when the
  // persisted default is what caused the skip (the startup-notice condition):
  // an explicit CLI flag wins over any settings value and never notices.
  test.each([
    {
      settings: undefined,
      flag: false,
      expected: false,
      fromSettings: false,
    },
    { settings: undefined, flag: true, expected: true, fromSettings: false },
    { settings: false, flag: true, expected: true, fromSettings: false },
    { settings: true, flag: true, expected: true, fromSettings: false },
    { settings: true, flag: false, expected: true, fromSettings: true },
  ])(
    "skip-permissions precedence: settings %j + CLI flag %j → skip %j, notice %j",
    async ({ settings, flag, expected, fromSettings }) => {
      const cwd = await emptyCwd();
      const globalPath = await writeGlobalSettings(
        cwd,
        settings === undefined
          ? undefined
          : { dangerouslySkipPermissions: settings },
      );
      const config = await loadConfig(
        [
          "--cwd",
          cwd,
          ...(flag ? ["--dangerously-skip-permissions"] : []),
          "do something",
        ],
        { globalSettingsPath: globalPath },
      );
      expect(config.dangerouslySkipPermissions).toBe(expected);
      expect(config.skipPermissionsFromSettings).toBe(fromSettings);
    },
  );

  test("seeds dangerouslySkipPermissions from global settings without the CLI flag", async () => {
    const cwd = await emptyCwd();
    const globalPath = await writeGlobalSettings(cwd, {
      dangerouslySkipPermissions: true,
    });
    const config = await loadConfig(["--cwd", cwd, "do something"], {
      globalSettingsPath: globalPath,
    });
    expect(config.dangerouslySkipPermissions).toBe(true);
    // Origin is the persisted default, not this invocation's flag — the
    // startup notice should fire.
    expect(config.skipPermissionsFromSettings).toBe(true);
  });

  test("exec --auto --yolo enables process-only skip without changing settings", async () => {
    const cwd = await emptyCwd();
    const globalPath = await writeGlobalSettings(cwd);
    const settingsBefore = await readFile(globalPath);
    const config = await loadConfig(
      ["exec", "--cwd", cwd, "--auto", "--yolo", "ship", "it"],
      { globalSettingsPath: globalPath },
    );

    assertConfigured(config);
    expect(config.command).toBe("exec");
    expect(config.task).toBe("ship it");
    expect(config.auto).toBe(true);
    expect(config.dangerouslySkipPermissions).toBe(true);
    expect(config.skipPermissionsFromSettings).toBe(false);
    expect(await readFile(globalPath)).toEqual(settingsBefore);
  });

  test("persisted skip-permissions default applies regardless of cwd (machine-wide scope)", async () => {
    // The global settings file is machine-wide: a session opened against a
    // completely different cwd still inherits the same default. This is the
    // exact silent-everywhere behavior the startup notice exists to surface.
    const globalCwd = await emptyCwd();
    const otherCwd = await emptyCwd();
    const globalPath = await writeGlobalSettings(globalCwd, {
      dangerouslySkipPermissions: true,
    });
    const config = await loadConfig(["--cwd", otherCwd, "do something"], {
      globalSettingsPath: globalPath,
    });
    expect(config.cwd).toBe(otherCwd);
    expect(config.dangerouslySkipPermissions).toBe(true);
    expect(config.skipPermissionsFromSettings).toBe(true);
  });

  test("reads provider and model from a --config settings file, --model wins over defaultModel", async () => {
    const cwd = await emptyCwd();
    const settingsPath = join(cwd, "settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({
        defaultProvider: "firepass",
        providers: {
          firepass: {
            baseURL: "https://firepass.example/v1",
            apiKey: "fp-key",
            models: ["fp-large", "fp-small"],
            defaultModel: "fp-large",
          },
        },
      }),
    );
    const config = await loadConfig([
      "--cwd",
      cwd,
      "--config",
      settingsPath,
      "task",
    ]);
    assertConfigured(config);
    expect(config.providerName).toBe("firepass");
    expect(config.baseURL).toBe("https://firepass.example/v1");
    expect(config.apiKey).toBe("fp-key");
    expect(config.model).toBe("fp-large");
    expect(config.globalDefaultProvider).toBe("firepass");

    const overridden = await loadConfig([
      "--cwd",
      cwd,
      "--config",
      settingsPath,
      "--model",
      "fp-small",
      "task",
    ]);
    assertConfigured(overridden);
    expect(overridden.model).toBe("fp-small");
  });

  test("--config pointing at a missing file throws", async () => {
    const cwd = await emptyCwd();
    await expect(
      loadConfig(["--cwd", cwd, "--config", join(cwd, "nope.json"), "task"]),
    ).rejects.toThrow(/not found or empty/);
  });

  test("--profile flag surfaces profile name and model from project profile.json", async () => {
    const cwd = await emptyCwd();
    const globalPath = await writeGlobalSettings(cwd);
    await mkdir(join(cwd, ".corbits"), { recursive: true });
    await writeFile(
      join(cwd, ".corbits", "profile.json"),
      JSON.stringify({
        model: "profile-model",
        systemPromptExtensions: ["ext1"],
      }),
    );
    const config = await loadConfig(["--cwd", cwd, "task"], {
      globalSettingsPath: globalPath,
    });
    assertConfigured(config);
    expect(config.model).toBe("profile-model");
    expect(config.systemPromptExtensions).toEqual(["ext1"]);
  });

  test("--model flag overrides profile model", async () => {
    const cwd = await emptyCwd();
    const globalPath = await writeGlobalSettings(cwd);
    await mkdir(join(cwd, ".corbits"), { recursive: true });
    await writeFile(
      join(cwd, ".corbits", "profile.json"),
      JSON.stringify({ model: "profile-model" }),
    );
    const config = await loadConfig(
      [
        "--cwd",
        cwd,
        "--model",
        "accounts/fireworks/routers/kimi-k2p6-turbo",
        "task",
      ],
      {
        globalSettingsPath: globalPath,
      },
    );
    assertConfigured(config);
    expect(config.model).toBe("accounts/fireworks/routers/kimi-k2p6-turbo");
  });

  test("per-repo local settings select the provider", async () => {
    const cwd = await emptyCwd();
    await mkdir(join(cwd, ".corbits"), { recursive: true });
    await writeFile(
      join(cwd, ".corbits", "settings.json"),
      JSON.stringify({ provider: "b", model: "b-model" }),
    );
    const globalPath = join(cwd, "global.json");
    await writeFile(
      globalPath,
      JSON.stringify({
        defaultProvider: "a",
        providers: {
          a: {
            baseURL: "https://a/v1",
            apiKey: "a-key",
            models: ["a-model"],
          },
          b: {
            baseURL: "https://b/v1",
            apiKey: "b-key",
            models: ["b-model"],
          },
        },
      }),
    );
    const config = await loadConfig(["--cwd", cwd, "task"], {
      globalSettingsPath: globalPath,
    });
    assertConfigured(config);
    expect(config.providerName).toBe("b");
    expect(config.model).toBe("b-model");
    expect(config.apiKey).toBe("b-key");
  });

  test("rejects a local reasoningEffort unsupported by the selected model", async () => {
    const cwd = await emptyCwd();
    await mkdir(join(cwd, ".corbits"), { recursive: true });
    await writeFile(
      join(cwd, ".corbits", "settings.json"),
      JSON.stringify({
        provider: "a",
        model: "a-model",
        reasoningEffort: "xhigh",
      }),
    );
    const globalPath = join(cwd, "global.json");
    await writeFile(
      globalPath,
      JSON.stringify({
        providers: {
          a: {
            baseURL: "https://a/v1",
            apiKey: "a-key",
            models: ["a-model"],
          },
        },
      }),
    );
    await expect(
      loadConfig(["--cwd", cwd, "task"], { globalSettingsPath: globalPath }),
    ).rejects.toThrow(/reasoningEffort/);
  });
});

describe("buildGoSource", () => {
  test("propagates the session marker through all protocol variants", () => {
    for (const model of ["kimi-k2.7-code", "gpt-5.6-luna", "minimax-m3"]) {
      const source = buildGoSource({
        id: "opencode-go",
        apiKey: "sk-go",
        model,
        sessionId: "sess-1",
      });
      expect(source.defaults?.providerOptions).toMatchObject({
        opencodeSessionId: "sess-1",
      });
    }
  });
});

describe("buildOpenAISource", () => {
  test("normalizes the runtime source baseURL", () => {
    const source = buildOpenAISource({
      id: "fp",
      baseURL: "https://fp/v1/chat/completions",
      apiKey: "fp-key",
      model: "fp-large",
    });
    expect(source.baseURL).toBe("https://fp/v1");
  });

  test("stays above the reasoning truncation floor", () => {
    // Reasoning tokens consume max_output_tokens before any answer text is
    // emitted. Measured on muse-spark-1.3-contributor, a 512-token cap at
    // medium effort spent 397 tokens reasoning and returned 3 tokens of
    // answer; 1024 was the lowest cap that answered on every rung. 4096 is
    // the floor we will not drop below. See CL-7867.
    expect(SOURCE_MAX_TOKENS).toBeGreaterThanOrEqual(4096);
  });

  test("omits reasoning_effort when effort is absent", () => {
    const source = buildOpenAISource({
      id: "fp",
      baseURL: "https://fp/v1",
      apiKey: "k",
      model: "m",
    });
    expect(source.defaults).toEqual({ maxTokens: SOURCE_MAX_TOKENS });
  });

  test("sets providerOptions.reasoning_effort when effort is present", () => {
    const source = buildOpenAISource({
      id: "fp",
      baseURL: "https://fp/v1",
      apiKey: "k",
      model: "gpt-5.1",
      reasoningEffort: "high",
    });
    expect(source.defaults).toEqual({
      maxTokens: SOURCE_MAX_TOKENS,
      providerOptions: { reasoning_effort: "high" },
    });
  });

  test("projects an Ollama root URL to the OpenAI-compatible /v1 endpoint", () => {
    const source = buildOpenAISource({
      id: "ollama/default",
      baseURL: "http://localhost:11434",
      model: "qwen3",
    });

    expect(source.provider).toBe("openai-compatible");
    expect(source.baseURL).toBe("http://localhost:11434/v1");
  });

  test("projects a legacy Ollama /v1 URL without doubling the path", () => {
    const source = buildOpenAISource({
      id: "ollama",
      baseURL: "http://localhost:11434/v1",
      model: "llama3",
    });

    expect(source.baseURL).toBe("http://localhost:11434/v1");
  });

  test("registers the keyless placeholder in the credential cell when none is provided", () => {
    const source = buildOpenAISource({
      id: "local",
      baseURL: "http://localhost:8080/v1",
      model: "local-model",
    });
    expect(source.credentialId).toBe("local");
    expect(peekSourceCredentialSecret(source.credentialId)).toBe(
      KEYLESS_API_KEY,
    );
  });
});

describe("buildBifrostSource", () => {
  test("sets provider to bifrost and normalizes baseURL", () => {
    const source = buildBifrostSource({
      id: "bf",
      baseURL: "http://localhost:8080/v1/chat/completions",
      apiKey: "sk-bf-abc",
      model: "gpt-4o",
    });
    expect(source.provider).toBe("bifrost");
    expect(source.baseURL).toBe("http://localhost:8080/v1");
    expect(source.model).toBe("gpt-4o");
  });

  test("embeds reasoning effort", () => {
    const source = buildBifrostSource({
      id: "bf",
      baseURL: "https://b/v1",
      apiKey: "k",
      model: "m",
      reasoningEffort: "low",
    });
    expect(source.defaults?.providerOptions).toEqual({
      reasoning_effort: "low",
    });
  });
});

describe("buildXaiSource", () => {
  test("omits reasoning_effort when effort is absent", () => {
    const source = buildXaiSource({
      id: "xai/work",
      profile: "work",
      apiKey: "tok",
      model: "grok-4.6",
      sessionId: "sess-1",
    });
    expect(source.provider).toBe("grok-responses");
    expect(source.defaults?.providerOptions).not.toHaveProperty(
      "reasoning_effort",
    );
  });

  test("sets providerOptions.reasoning_effort when effort is present", () => {
    const source = buildXaiSource({
      id: "xai/work",
      profile: "work",
      apiKey: "tok",
      model: "grok-4.6",
      sessionId: "sess-1",
      reasoningEffort: "low",
    });
    expect(source.defaults?.providerOptions).toMatchObject({
      reasoning_effort: "low",
    });
  });

  test("stashes the session id for the adapter's prompt_cache_key", () => {
    const source = buildXaiSource({
      id: "xai/work",
      profile: "work",
      apiKey: "tok",
      model: "grok-4.6",
      sessionId: "sess-1",
    });
    expect(source.defaults?.providerOptions).toMatchObject({
      grokSessionId: "sess-1",
    });
  });
});

describe("buildProviderCatalog", () => {
  test("lists every provider from the settings file", () => {
    const settings: Settings = {
      defaultProvider: "fp",
      providers: {
        fp: {
          baseURL: "https://fp/v1",
          apiKey: "fp-key",
          models: ["fp-large", "fp-small"],
          defaultModel: "fp-large",
        },
        oa: { baseURL: "https://oa/v1", apiKey: "oa-key", models: ["o-1"] },
      },
    };
    const catalog = buildProviderCatalog(settings, resolved);
    expect(catalog.map((c) => c.name).sort()).toEqual(["fp", "oa"]);
    const fp = defined(catalog.find((c) => c.name === "fp"));
    expect(fp.models).toEqual(["fp-large", "fp-small"]);
    expect(fp.defaultModel).toBe("fp-large");
    expect(
      defined(catalog.find((c) => c.name === "oa")).defaultModel,
    ).toBeUndefined();
  });

  test("normalizes provider base URLs from the settings file", () => {
    const settings: Settings = {
      providers: {
        fp: {
          baseURL: "https://fp/v1/chat/completions/",
          apiKey: "fp-key",
          models: ["fp-large"],
        },
      },
    };
    const catalog = buildProviderCatalog(settings, resolved);
    expect(catalog[0]?.baseURL).toBe("https://fp/v1");
  });

  test("preserves bifrostVirtualKey flag from settings", () => {
    const settings: Settings = {
      providers: {
        bf: {
          baseURL: "http://b:8080/v1",
          apiKey: "sk-bf-k",
          models: ["m"],
          bifrostVirtualKey: true,
        },
      },
    };
    const catalog = buildProviderCatalog(settings, resolved);
    const bf = defined(catalog.find((c) => c.name === "bf"));
    expect(bf.bifrostVirtualKey).toBe(true);
  });

  test("falls back to the single resolved provider when there is no settings file", () => {
    const catalog = buildProviderCatalog(null, resolved);
    expect(catalog).toEqual([
      {
        name: "fp",
        baseURL: "https://fp/v1",
        apiKey: "fp-key",
        models: ["fp-large"],
      },
    ]);
  });

  test("preserves keyless flag and omits apiKey for keyless providers", () => {
    const settings: Settings = {
      providers: {
        ollama: {
          baseURL: "http://localhost:11434/v1",
          keyless: true,
          models: ["llama3"],
        },
        fp: {
          baseURL: "https://fp/v1",
          apiKey: "fp-key",
          models: ["fp-large"],
        },
      },
    };
    const catalog = buildProviderCatalog(settings, resolved);
    const ollama = defined(catalog.find((c) => c.name === "ollama"));
    expect(ollama.keyless).toBe(true);
    expect(ollama.apiKey).toBeUndefined();
    const fp = defined(catalog.find((c) => c.name === "fp"));
    expect(fp.keyless).toBeUndefined();
    expect(fp.apiKey).toBe("fp-key");
  });

  test("converts a provider catalog back to global settings", () => {
    const settings = providerCatalogToSettings(
      [
        {
          name: "fp",
          baseURL: "https://fp/v1",
          apiKey: "fp-key",
          models: ["fp-large", "fp-small"],
          defaultModel: "fp-large",
        },
        {
          name: "oa",
          baseURL: "https://oa/v1",
          apiKey: "oa-key",
          models: ["o-1"],
        },
      ],
      "oa",
    );
    expect(settings).toEqual({
      defaultProvider: "oa",
      providers: {
        fp: {
          baseURL: "https://fp/v1",
          apiKey: "fp-key",
          models: ["fp-large", "fp-small"],
          defaultModel: "fp-large",
        },
        oa: { baseURL: "https://oa/v1", apiKey: "oa-key", models: ["o-1"] },
      },
    });
  });

  test("runtimeSettingsWithCatalog overlays OAuth catalog entries for provider resolution", () => {
    const disk = {
      providers: {
        openai: {
          baseURL: "https://api.openai.com/v1",
          apiKey: "sk",
          models: ["gpt-4o"],
        },
      },
    };
    const catalog = [
      {
        name: "openai",
        baseURL: "https://api.openai.com/v1",
        apiKey: "sk",
        models: ["gpt-4o"],
      },
      {
        name: "xai/work",
        baseURL: "https://api.x.ai/v1",
        apiKey: "xai-token",
        models: ["grok-4"],
        xaiProfile: "work",
      },
    ];
    const runtime = runtimeSettingsWithCatalog(disk, catalog);
    expect(runtime.providers["xai/work"]).toEqual({
      baseURL: "https://api.x.ai/v1",
      apiKey: "xai-token",
      models: ["grok-4"],
    });
    // Disk persist path still strips OAuth.
    expect(
      providerCatalogToSettings(catalog, "openai", disk).providers["xai/work"],
    ).toBeUndefined();
  });

  test("normalizes provider catalog URLs when converting back to settings", () => {
    const settings = providerCatalogToSettings(
      [
        {
          name: "fp",
          baseURL: "https://fp/v1/chat/completions",
          apiKey: "fp-key",
          models: ["fp-large"],
        },
      ],
      undefined,
    );
    expect(settings.providers.fp?.baseURL).toBe("https://fp/v1");
  });

  test("rejects invalid provider catalog URLs when converting back to settings", () => {
    expect(() =>
      providerCatalogToSettings(
        [
          {
            name: "fp",
            baseURL: "fp/v1",
            apiKey: "fp-key",
            models: ["fp-large"],
          },
        ],
        undefined,
      ),
    ).toThrow(/Invalid OpenAI-compatible baseURL/);
  });

  test("omits defaultProvider when no global default is known", () => {
    const settings = providerCatalogToSettings(
      [
        {
          name: "fp",
          baseURL: "https://fp/v1",
          apiKey: "fp-key",
          models: ["fp-large"],
        },
      ],
      undefined,
    );
    expect(settings).toEqual({
      providers: {
        fp: {
          baseURL: "https://fp/v1",
          apiKey: "fp-key",
          models: ["fp-large"],
        },
      },
    });
  });

  test("persists bifrostVirtualKey flag for virtual-key providers", () => {
    const catalog = [
      {
        name: "bf-prod",
        baseURL: "http://b:8080/v1",
        apiKey: "sk-bf-xyz",
        models: ["m1"],
        bifrostVirtualKey: true as const,
      },
    ];
    const settings = providerCatalogToSettings(catalog, "bf-prod");
    expect(settings.providers["bf-prod"]).toEqual({
      baseURL: "http://b:8080/v1",
      apiKey: "sk-bf-xyz",
      models: ["m1"],
      bifrostVirtualKey: true,
    });
  });

  test("preserves non-provider fields from existing settings", () => {
    // Full non-provider surface: provider saves must not re-own a subset of
    // Settings keys (an allowlist previously dropped sessionMode/shell/tools/…).
    const existing: Settings = {
      defaultProvider: "fp",
      providers: {
        fp: {
          baseURL: "https://fp/v1",
          apiKey: "old-key",
          models: ["fp-small"],
        },
      },
      mcpServers: [
        { name: "linear", type: "http", url: "https://mcp.linear.app/mcp" },
      ],
      plugins: { exa: { enabled: true, credentials: { apiKey: "k" } } },
      pluginPaths: ["/abs/plugins/exa"],
      web: "exa",
      hiddenCommands: ["help"],
      onboarded: true,
      compactionMode: "pruning",
      sessionMode: "orchestrator",
      agentModelFallback: "none",
      shell: { timeoutMs: 30_000, maxTimeoutMs: 120_000 },
      tools: { timeoutMs: 60_000 },
      workflowProfiles: { fast: { implement: "fp-large" } },
    };
    const settings = providerCatalogToSettings(
      [
        {
          name: "fp",
          baseURL: "https://fp/v1",
          apiKey: "fp-key",
          models: ["fp-large", "fp-small"],
          defaultModel: "fp-large",
        },
        {
          name: "oa",
          baseURL: "https://oa/v1",
          apiKey: "oa-key",
          models: ["o-1"],
        },
      ],
      "oa",
      existing,
    );
    const { providers: _ep, defaultProvider: _ed, ...restExisting } = existing;
    const {
      providers: outProviders,
      defaultProvider: outDefault,
      ...restOut
    } = settings;
    expect(outDefault).toBe("oa");
    expect(outProviders).toEqual({
      fp: {
        baseURL: "https://fp/v1",
        apiKey: "fp-key",
        models: ["fp-large", "fp-small"],
        defaultModel: "fp-large",
      },
      oa: { baseURL: "https://oa/v1", apiKey: "oa-key", models: ["o-1"] },
    });
    expect(restOut).toEqual(restExisting);
  });

  test("round-trips every ProviderSettings field a catalog entry can carry through buildProviderCatalog and back", () => {
    // ProviderCatalogEntry is defined as Omit<ProviderSettings, "name" | "contextWindow">.
    // This exercises every field that relationship carries over, so a field
    // added to ProviderSettings and forgotten in the two conversion sites
    // below fails here instead of being silently dropped at runtime.
    // `anthropic` and `opencodeGo` are exercised separately below: both are
    // protocol markers that also normalize `baseURL` in buildProviderCatalog,
    // so a provider combining them with an arbitrary baseURL isn't a real
    // round trip (the healing logic rewrites baseURL by design).
    const provider: Settings["providers"][string] = {
      baseURL: "https://fp/v1",
      apiKey: "fp-key",
      models: ["fp-large"],
      defaultModel: "fp-large",
      free: true,
      keyless: true,
      bifrostVirtualKey: true,
    };
    const settings: Settings = { providers: { fp: provider } };
    const catalog = buildProviderCatalog(settings, {
      providerName: "fp",
      baseURL: provider.baseURL,
      apiKey: "fp-key",
      model: "fp-large",
    } as ResolvedProvider);
    const entry = defined(catalog.find((c) => c.name === "fp"));
    const roundTripped = { fp: catalogEntryAsProviderSettings(entry) };
    expect(roundTripped).toEqual({ fp: provider });
  });

  test("round-trips the anthropic protocol marker", () => {
    const provider: Settings["providers"][string] = {
      baseURL: "https://api.anthropic.com/v1",
      apiKey: "an-key",
      models: ["claude"],
      anthropic: true,
    };
    const settings: Settings = { providers: { an: provider } };
    const catalog = buildProviderCatalog(settings, {
      providerName: "an",
      baseURL: provider.baseURL,
      apiKey: "an-key",
      model: "claude",
    } as ResolvedProvider);
    const entry = defined(catalog.find((c) => c.name === "an"));
    const roundTripped = { an: catalogEntryAsProviderSettings(entry) };
    expect(roundTripped).toEqual({ an: provider });
  });

  test("round-trips the opencodeGo protocol marker", () => {
    const provider: Settings["providers"][string] = {
      baseURL: OPENCODE_GO_BASE_URL,
      apiKey: "go-key",
      models: ["go-model"],
      opencodeGo: true,
    };
    const settings: Settings = { providers: { go: provider } };
    const catalog = buildProviderCatalog(settings, {
      providerName: "go",
      baseURL: provider.baseURL,
      apiKey: "go-key",
      model: "go-model",
    } as ResolvedProvider);
    const entry = defined(catalog.find((c) => c.name === "go"));
    const roundTripped = { go: catalogEntryAsProviderSettings(entry) };
    expect(roundTripped).toEqual({ go: provider });
  });
});

describe("refreshLiveProviderCatalog", () => {
  const fpProvider: Settings["providers"][string] = {
    baseURL: "https://fp/v1",
    apiKey: "fp-key",
    models: ["fp-large"],
  };

  test.each([
    {
      name: "go",
      provider: {
        baseURL: OPENCODE_GO_BASE_URL,
        apiKey: "go-key",
        models: ["go-model"],
        opencodeGo: true,
      } satisfies Settings["providers"][string],
      coldIds: OPENCODE_GO_MODEL_IDS,
      prefetch: prefetchGoModels,
    },
    {
      name: "zen",
      provider: {
        baseURL: ZEN_DEFAULT_BASE_URL,
        apiKey: "zen-key",
        models: ["zen-model"],
      } satisfies Settings["providers"][string],
      coldIds: ZEN_MODEL_IDS,
      prefetch: prefetchZenModels,
    },
  ])(
    "overlays the $name row's models with live discovery without changing other rows",
    async ({ name, provider, coldIds, prefetch }) => {
      const settings: Settings = {
        providers: { fp: fpProvider, [name]: provider },
      };
      const storedModel = `${name}-model`;

      const cold = await refreshLiveProviderCatalog(settings, resolved);
      const coldRow = cold.find((c) => c.name === name);
      expect(coldRow?.models).toEqual([...coldIds]);
      expect(coldRow?.models).not.toContain(storedModel);
      expect(cold.find((c) => c.name === "fp")?.models).toEqual(["fp-large"]);
      // Discovery overlay is runtime-only: the on-disk catalog keeps the
      // stored model list.
      expect(
        buildProviderCatalog(settings, resolved).find((c) => c.name === name)
          ?.models,
      ).toEqual([storedModel]);

      globalThis.fetch = (async () =>
        Response.json({
          data: [{ id: "grok-4.5" }, { id: "live-only-fixture-model" }],
        })) as unknown as typeof fetch;
      await prefetch();

      const warm = await refreshLiveProviderCatalog(settings, resolved);
      expect(warm.find((c) => c.name === name)?.models).toContain(
        "live-only-fixture-model",
      );
      expect(warm.find((c) => c.name === "fp")?.models).toEqual(["fp-large"]);
      expect(
        buildProviderCatalog(settings, resolved).find((c) => c.name === name)
          ?.models,
      ).toEqual([storedModel]);
    },
  );
});

describe("catalog credential-removal convergence", () => {
  const credentialed: Settings = {
    providers: {
      fp: { baseURL: "https://fp/v1", apiKey: "fp-key", models: ["fp-large"] },
    },
  };
  const credentialRemoved: Settings = {
    providers: {
      fp: { baseURL: "https://fp/v1", models: ["fp-large"] },
    },
  };

  test("rebuild preserves the manual row across removal and restore", async () => {
    expect(
      buildProviderCatalog(credentialed, resolved).find((c) => c.name === "fp")
        ?.apiKey,
    ).toBe("fp-key");

    const converged = await refreshLiveProviderCatalog(
      credentialRemoved,
      resolved,
    );
    const row = converged.find((c) => c.name === "fp");
    expect(row?.models).toEqual(["fp-large"]);
    expect(row?.baseURL).toBe("https://fp/v1");
    expect(row?.apiKey).toBeUndefined();

    const restored = await refreshLiveProviderCatalog(credentialed, resolved);
    expect(restored.find((c) => c.name === "fp")?.apiKey).toBe("fp-key");
  });

  test("persisting the converged catalog keeps the manual row", async () => {
    const converged = await refreshLiveProviderCatalog(
      credentialRemoved,
      resolved,
    );
    const persisted = providerCatalogToSettings(
      converged,
      undefined,
      credentialRemoved,
    );
    expect(persisted.providers.fp?.models).toEqual(["fp-large"]);
    expect(persisted.providers.fp?.baseURL).toBe("https://fp/v1");
  });
});

describe("mergeProviderIntoSettings", () => {
  test("preserves plugins and non-provider fields when upserting a provider", () => {
    const existing: Settings = {
      providers: {
        old: { baseURL: "https://old/v1", apiKey: "k", models: ["m"] },
      },
      plugins: { cmd: { enabled: true } },
      pluginPaths: ["/abs/cmd"],
      sessionMode: "orchestrator",
      shell: { timeoutMs: 10_000 },
      onboarded: true,
    };
    const merged = mergeProviderIntoSettings(existing, "new", {
      baseURL: "https://new/v1",
      apiKey: "nk",
      models: ["n1"],
      defaultModel: "n1",
    });
    expect(merged.defaultProvider).toBe("new");
    expect(merged.providers.old).toEqual(existing.providers.old);
    expect(merged.providers.new).toEqual({
      baseURL: "https://new/v1",
      apiKey: "nk",
      models: ["n1"],
      defaultModel: "n1",
    });
    expect(merged.plugins).toEqual({ cmd: { enabled: true } });
    expect(merged.pluginPaths).toEqual(["/abs/cmd"]);
    expect(merged.sessionMode).toBe("orchestrator");
    expect(merged.shell).toEqual({ timeoutMs: 10_000 });
    expect(merged.onboarded).toBe(true);
  });

  test("creates settings from null existing", () => {
    const merged = mergeProviderIntoSettings(null, "only", {
      baseURL: "https://only/v1",
      keyless: true,
      models: ["m"],
    });
    expect(merged).toEqual({
      defaultProvider: "only",
      providers: {
        only: { baseURL: "https://only/v1", keyless: true, models: ["m"] },
      },
    });
  });
});
