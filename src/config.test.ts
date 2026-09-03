import { describe, test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
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
  resolveMcpServers,
  runtimeSettingsWithCatalog,
  SOURCE_MAX_TOKENS,
} from "./config/index.js";
import { DIRECTOR_IDS } from "./agent/directors/types.js";
import type { Config, UnconfiguredConfig } from "./config/index.js";
import {
  mergeProviderIntoSettings,
  type ResolvedProvider,
  type Settings,
} from "./config/settings.js";
import { OPENCODE_GO_BASE_URL } from "../packages/opencode-go/src/index.js";
import { generateSessionId, initSessionDir, sessionDir } from "./session/index.js";
import { saveState } from "./session/state.js";
import { filterMcpServersForConnect } from "./trust/project-trust.js";
import { createExaMCPServerConfig } from "./mcp/exa.js";
import { withFileLogSink } from "../tests/helpers/file-log-sink.js";

const BUILTIN_EXA_MCP = createExaMCPServerConfig();

function assertConfigured(config: Config | UnconfiguredConfig): asserts config is Config {
  if (config.configured === false) {
    throw new Error(
      `Expected configured Config but got UnconfiguredConfig: ${config.providerError}`,
    );
  }
}

// A global settings path guaranteed not to exist, so resolution finds no
// provider — used by the "missing provider" cases.
const NO_SETTINGS = join(tmpdir(), "corbits-tests-missing", ".corbits", "settings.json");

// Writes a minimal valid global settings file with a single provider and
// returns its path. Provider resolution reads exclusively from such files.
async function writeGlobalSettings(cwd: string, mcpServers?: unknown): Promise<string> {
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
      ...(mcpServers !== undefined ? { mcpServers } : {}),
    }),
  );
  return path;
}

// A cwd with no per-repo settings file, so local resolution is inert.
async function emptyCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ic-config-"));
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
    try {
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
      expect(config.force).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("injects the built-in Exa MCP server when no list disables or overrides it", async () => {
    expect(resolveMcpServers(undefined, undefined)).toEqual([BUILTIN_EXA_MCP]);

    const cwd = await emptyCwd();
    try {
      const globalPath = await writeGlobalSettings(cwd);
      const config = await loadConfig(["--cwd", cwd, "hello"], { globalSettingsPath: globalPath });
      assertConfigured(config);
      expect(config.mcpServers).toEqual([BUILTIN_EXA_MCP]);
      expect(config.mcpServersSource).toBe("none");
      expect(config.mcpServerEntries).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("expands enabled Exa preset and honors explicit disable", () => {
    expect(resolveMcpServers([{ name: "exa", enabled: true }], undefined)).toEqual([
      BUILTIN_EXA_MCP,
    ]);
    expect(resolveMcpServers([{ name: "exa", enabled: false }], undefined)).toEqual([]);
  });

  test("keeps global and local MCP source at list level", async () => {
    const cwd = await emptyCwd();
    try {
      const globalPath = await writeGlobalSettings(cwd, { exa: { enabled: true } });
      const globalConfig = await loadConfig(["--cwd", cwd, "hello"], {
        globalSettingsPath: globalPath,
      });
      assertConfigured(globalConfig);
      expect(globalConfig.mcpServers).toEqual([BUILTIN_EXA_MCP]);
      expect(globalConfig.mcpServersSource).toBe("global");
      expect(globalConfig.mcpServerEntries).toEqual([{ name: "exa", enabled: true }]);

      await writeGlobalSettings(cwd, { exa: { enabled: false } });
      const disabledConfig = await loadConfig(["--cwd", cwd, "hello"], {
        globalSettingsPath: globalPath,
      });
      assertConfigured(disabledConfig);
      expect(disabledConfig.mcpServers).toEqual([]);
      expect(disabledConfig.mcpServersSource).toBe("global");
      expect(disabledConfig.mcpServerEntries).toEqual([{ name: "exa", enabled: false }]);

      await writeGlobalSettings(cwd, { exa: { enabled: true } });
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
      expect(localConfig.mcpServerEntries).toEqual([{ name: "local", command: "local-mcp" }]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("preserves custom Exa and lets local omission inherit global disable", () => {
    expect(
      resolveMcpServers(
        [{ name: "exa", type: "http", url: "https://example.test/mcp" }],
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
      resolveMcpServers([{ name: "exa", enabled: false }], [{ name: "exa", enabled: true }]),
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
    ).toEqual([{ name: "exa", type: "http", url: "https://local.example.test/mcp" }]);
  });

  test("drops disabled transport rows without expanding them to Exa", () => {
    expect(
      resolveMcpServers(
        [{ name: "linear", type: "http", url: "https://mcp.linear.app/mcp", enabled: false }],
        undefined,
      ),
    ).toEqual([BUILTIN_EXA_MCP]);
    expect(
      resolveMcpServers(
        [
          { name: "linear", type: "http", url: "https://mcp.linear.app/mcp", enabled: false },
          { name: "files", command: "files-mcp" },
        ],
        undefined,
      ),
    ).toEqual([BUILTIN_EXA_MCP, { name: "files", command: "files-mcp" }]);
  });

  test("resolves custom enabled Exa HTTP without duplicating the builtin", () => {
    expect(
      resolveMcpServers(
        [{ name: "exa", type: "http", url: "https://example.test/mcp", enabled: true }],
        undefined,
      ),
    ).toEqual([{ name: "exa", type: "http", url: "https://example.test/mcp" }]);
  });

  test("loadConfig keeps disabled global transport rows in mcpServerEntries only", async () => {
    const cwd = await emptyCwd();
    try {
      const globalPath = await writeGlobalSettings(cwd, {
        linear: { type: "http", url: "https://mcp.linear.app/mcp", enabled: false },
      });
      const config = await loadConfig(["--cwd", cwd, "hello"], { globalSettingsPath: globalPath });
      assertConfigured(config);
      expect(config.mcpServersSource).toBe("global");
      expect(config.mcpServerEntries).toEqual([
        { name: "linear", type: "http", url: "https://mcp.linear.app/mcp", enabled: false },
      ]);
      expect(config.mcpServers).toEqual([BUILTIN_EXA_MCP]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("loadConfig with no mcp list uses empty mcpServerEntries and source none", async () => {
    const cwd = await emptyCwd();
    try {
      const globalPath = await writeGlobalSettings(cwd);
      const config = await loadConfig(["--cwd", cwd, "hello"], { globalSettingsPath: globalPath });
      assertConfigured(config);
      expect(config.mcpServerEntries).toEqual([]);
      expect(config.mcpServersSource).toBe("none");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("local custom MCP requires trust while built-in Exa bypasses project trust", async () => {
    const servers = resolveMcpServers(undefined, [{ name: "local", command: "local-mcp" }]);

    expect(servers).toEqual([BUILTIN_EXA_MCP, { name: "local", command: "local-mcp" }]);
    await expect(
      filterMcpServersForConnect(servers, {
        source: "local",
        cwd: "/repo/without-trust-grant",
        store: { trustedPluginPaths: [], trustedMcpFingerprints: [] },
      }),
    ).resolves.toEqual([BUILTIN_EXA_MCP]);
  });

  test("throws when no provider can be resolved (allowUnconfigured false)", async () => {
    const cwd = await emptyCwd();
    try {
      await expect(
        loadConfig(["--cwd", cwd, "do it"], { globalSettingsPath: NO_SETTINGS }),
      ).rejects.toThrow(/missing/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("returns UnconfiguredConfig when allowUnconfigured is true and provider is missing", async () => {
    const cwd = await emptyCwd();
    try {
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
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("threads local settings diagnostics on unconfigured early return", async () => {
    const cwd = await emptyCwd();
    try {
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
        expect(result.settingsDiagnostics!.length).toBeGreaterThan(0);
        expect(result.settingsDiagnostics!.some((d) => /unknown/i.test(d.message))).toBe(true);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("UnconfiguredConfig.globalSettingsPath reflects --config path, not the global default", async () => {
    const cwd = await emptyCwd();
    try {
      const configPath = join(cwd, "custom.json");
      await writeFile(configPath, JSON.stringify({ providers: {} }));
      const result = await loadConfig(["--cwd", cwd, "--config", configPath, "task"], {
        allowUnconfigured: true,
      });
      expect(result.configured).toBe(false);
      if (result.configured === false) {
        expect(result.globalSettingsPath).toBe(configPath);
        expect(result.cliConfigPath).toBe(configPath);
        expect(result.programmaticSettingsPath).toBe(false);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("parses --force", async () => {
    const cwd = await emptyCwd();
    try {
      const globalPath = await writeGlobalSettings(cwd);
      const config = await loadConfig(["--cwd", cwd, "--force", "run task"], {
        globalSettingsPath: globalPath,
      });
      expect(config.force).toBe(true);
      expect(config.task).toBe("run task");
      expect(config.command).toBe("tui");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("parses exec subcommand and keeps flags", async () => {
    const cwd = await emptyCwd();
    try {
      const globalPath = await writeGlobalSettings(cwd);
      const config = await loadConfig(["exec", "--cwd", cwd, "--force", "ship it"], {
        globalSettingsPath: globalPath,
      });
      assertConfigured(config);
      expect(config.command).toBe("exec");
      expect(config.task).toBe("ship it");
      expect(config.force).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("parses run as exec alias", async () => {
    const cwd = await emptyCwd();
    try {
      const globalPath = await writeGlobalSettings(cwd);
      const config = await loadConfig(["run", "--cwd", cwd, "alias task"], {
        globalSettingsPath: globalPath,
      });
      assertConfigured(config);
      expect(config.command).toBe("exec");
      expect(config.task).toBe("alias task");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("parses exec --director builder", async () => {
    const cwd = await emptyCwd();
    try {
      const globalPath = await writeGlobalSettings(cwd);
      const config = await loadConfig(["exec", "--cwd", cwd, "--director", "builder", "ship it"], {
        globalSettingsPath: globalPath,
      });
      assertConfigured(config);
      expect(config.command).toBe("exec");
      expect(config.director).toBe("builder");
      expect(config.task).toBe("ship it");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("omits director as undefined (skywalker default)", async () => {
    const cwd = await emptyCwd();
    try {
      const globalPath = await writeGlobalSettings(cwd);
      const config = await loadConfig(["exec", "--cwd", cwd, "ship it"], {
        globalSettingsPath: globalPath,
      });
      assertConfigured(config);
      expect(config.command).toBe("exec");
      expect(config.director).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("unknown --director id errors listing DIRECTOR_IDS", async () => {
    await expect(
      loadConfig(["exec", "--director", "nope", "ship it"], { globalSettingsPath: NO_SETTINGS }),
    ).rejects.toThrow(new RegExp(`Unknown director "nope".*${DIRECTOR_IDS.join(", ")}`));
  });

  test("--director implement is unknown and lists closed-fleet ids including builder", async () => {
    await expect(
      loadConfig(["exec", "--director", "implement", "ship it"], {
        globalSettingsPath: NO_SETTINGS,
      }),
    ).rejects.toThrow(new RegExp(`Unknown director "implement".*${DIRECTOR_IDS.join(", ")}`));
    expect(DIRECTOR_IDS).toContain("builder");
    expect(DIRECTOR_IDS).not.toContain("implement");
  });

  test("--director without a value errors", async () => {
    await expect(
      loadConfig(["exec", "--director"], { globalSettingsPath: NO_SETTINGS }),
    ).rejects.toThrow("--director requires a value");
  });

  test("--director without exec/run is rejected", async () => {
    await expect(
      loadConfig(["--director", "implement", "ship it"], { globalSettingsPath: NO_SETTINGS }),
    ).rejects.toThrow("--director is only available in exec mode");
  });

  test("resume --pick opens the session picker without requiring prior sessions", async () => {
    const cwd = await emptyCwd();
    try {
      const globalPath = await writeGlobalSettings(cwd);
      const config = await loadConfig(["resume", "--pick", "--cwd", cwd], {
        globalSettingsPath: globalPath,
      });
      assertConfigured(config);
      expect(config.command).toBe("tui");
      expect(config.resumeMode).toBe("pick");
      expect(config.resumePicker).toBe(true);
      expect(config.skipInitialTask).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("continue is an alias of resume", async () => {
    const cwd = await emptyCwd();
    try {
      const globalPath = await writeGlobalSettings(cwd);
      const config = await loadConfig(["continue", "--list", "--cwd", cwd], {
        globalSettingsPath: globalPath,
      });
      assertConfigured(config);
      expect(config.resumeMode).toBe("pick");
      expect(config.resumePicker).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("bare resume opens the picker without requiring prior sessions", async () => {
    const cwd = await emptyCwd();
    const home = await mkdtemp(join(tmpdir(), "ic-resume-home-"));
    try {
      const globalPath = await writeGlobalSettings(cwd);
      const config = await loadConfig(["resume", "--cwd", cwd], {
        globalSettingsPath: globalPath,
        home,
      });
      assertConfigured(config);
      expect(config.resumeMode).toBe("pick");
      expect(config.resumePicker).toBe(true);
      expect(config.skipInitialTask).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test("resume <id> reopens a known session and skips the initial task", async () => {
    const cwd = await emptyCwd();
    const home = await mkdtemp(join(tmpdir(), "ic-resume-home-"));
    try {
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
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test("resume <id> --force reopens a failed session that recorded an error", async () => {
    const cwd = await emptyCwd();
    const home = await mkdtemp(join(tmpdir(), "ic-resume-home-"));
    try {
      const globalPath = await writeGlobalSettings(cwd);
      const sessionId = generateSessionId();
      await initSessionDir(cwd, sessionId, home);
      await saveState(
        cwd,
        sessionId,
        {
          status: "failed",
          turnsUsed: 4,
          task: "ship resume after failure",
          startedAt: Date.now() - 1_000,
          finishedAt: Date.now(),
          error: "Cycle commit failed\nhook dump: pre-commit rejected",
        },
        home,
      );
      const config = await loadConfig(["resume", sessionId, "--force", "--cwd", cwd], {
        globalSettingsPath: globalPath,
        home,
      });
      assertConfigured(config);
      expect(config.resumeMode).toBe("id");
      expect(config.sessionId).toBe(sessionId);
      expect(config.skipInitialTask).toBe(true);
      expect(config.task).toBe("ship resume after failure");
      expect(config.force).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test("resume <id> --force among failed siblings stays silent and reopens the target", async () => {
    const cwd = await emptyCwd();
    const home = await mkdtemp(join(tmpdir(), "ic-resume-home-"));
    try {
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

      let config: Awaited<ReturnType<typeof loadConfig>>;
      const logged = await withFileLogSink(async () => {
        config = await loadConfig(["resume", targetId, "--force", "--cwd", cwd], {
          globalSettingsPath: globalPath,
          home,
        });
      });
      assertConfigured(config!);
      expect(config!.sessionId).toBe(targetId);
      expect(config!.task).toBe("target failed session");
      expect(logged).not.toContain("unreadable session state");
      expect(logged).not.toContain(home);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test("--resume opens the picker", async () => {
    const cwd = await emptyCwd();
    const home = await mkdtemp(join(tmpdir(), "ic-resume-home-"));
    try {
      const globalPath = await writeGlobalSettings(cwd);
      const config = await loadConfig(["--resume", "--cwd", cwd], {
        globalSettingsPath: globalPath,
        home,
      });
      assertConfigured(config);
      expect(config.resumeMode).toBe("pick");
      expect(config.resumePicker).toBe(true);
      expect(config.skipInitialTask).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test("plain corbits always creates fresh state even when a previous session exists", async () => {
    const cwd = await emptyCwd();
    const home = await mkdtemp(join(tmpdir(), "ic-resume-home-"));
    try {
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
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test("resume <id> rejects an unknown session id for this project", async () => {
    const cwd = await emptyCwd();
    const home = await mkdtemp(join(tmpdir(), "ic-resume-home-"));
    try {
      const globalPath = await writeGlobalSettings(cwd);
      const missing = generateSessionId();
      await expect(
        loadConfig(["resume", missing, "--cwd", cwd], {
          globalSettingsPath: globalPath,
          home,
        }),
      ).rejects.toThrow(new RegExp(`No session ${missing}`));
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test("resume <id> of an unreadable session throws a short recovery line", async () => {
    const cwd = await emptyCwd();
    const home = await mkdtemp(join(tmpdir(), "ic-resume-home-"));
    try {
      const globalPath = await writeGlobalSettings(cwd);
      const sessionId = generateSessionId();
      await initSessionDir(cwd, sessionId, home);
      const runPath = join(sessionDir(cwd, sessionId, home), "run.json");
      await writeFile(runPath, "{ not json");

      let thrown: unknown;
      const logged = await withFileLogSink(async () => {
        try {
          await loadConfig(["resume", sessionId, "--force", "--cwd", cwd], {
            globalSettingsPath: globalPath,
            home,
          });
        } catch (err) {
          thrown = err;
        }
      });

      expect(thrown).toBeInstanceOf(CliUserError);
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      expect(message).toBe(
        `Session ${sessionId} is unreadable. Use \`corbits resume\` to choose another.`,
      );
      expect(message).not.toMatch(/No session/);
      expect(message).not.toContain("ignoring unreadable");
      expect(message).not.toContain("invalid shape");
      expect(message).not.toContain(home);
      expect(message.split("\n")).toHaveLength(1);
      if (thrown instanceof CliUserError) {
        expect(thrown.exitCode).toBe(1);
      }
      expect(logged).toContain(runPath);
      expect(logged).toContain("corrupt JSON");
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test("resume rejects a non-id positional instead of treating it as last", async () => {
    const cwd = await emptyCwd();
    try {
      const globalPath = await writeGlobalSettings(cwd);
      await expect(
        loadConfig(["resume", "not-a-uuid", "--cwd", cwd], {
          globalSettingsPath: globalPath,
        }),
      ).rejects.toThrow(/not a session id/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("resume rejects combining a session id with --pick", async () => {
    const cwd = await emptyCwd();
    try {
      const globalPath = await writeGlobalSettings(cwd);
      const id = generateSessionId();
      await expect(
        loadConfig(["resume", id, "--pick", "--cwd", cwd], {
          globalSettingsPath: globalPath,
        }),
      ).rejects.toThrow(/cannot combine a session id with --pick/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("resume accepts --pick after other flags", async () => {
    const cwd = await emptyCwd();
    try {
      const globalPath = await writeGlobalSettings(cwd);
      const config = await loadConfig(["resume", "--cwd", cwd, "--pick"], {
        globalSettingsPath: globalPath,
      });
      assertConfigured(config);
      expect(config.resumeMode).toBe("pick");
      expect(config.resumePicker).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("--help throws CliHelpError with exitCode 0 and full help text", async () => {
    await expectCliHelp(["--help"]);
    await expectCliHelp(["-h"]);
  });

  test("--help after flags throws CliHelpError", async () => {
    await expectCliHelp(["--force", "--help"]);
    await expectCliHelp(["--force", "-h"]);
  });

  test("--help after a positional throws CliHelpError", async () => {
    await expectCliHelp(["ship it", "--help"]);
    await expectCliHelp(["ship", "it", "--help"]);
  });

  test("--help after a bound flag value throws CliHelpError", async () => {
    await expectCliHelp(["--cwd", ".", "--help"]);
    await expectCliHelp(["--provider", "fireworks", "--help"]);
  });

  test("exec --help throws CliHelpError", async () => {
    await expectCliHelp(["exec", "--help"]);
    await expectCliHelp(["exec", "--director", "--help"]);
  });

  test("resume --pick --help throws CliHelpError", async () => {
    await expectCliHelp(["resume", "--pick", "--help"]);
  });

  test("resume -h / --help throws CliHelpError instead of treating it as a session id", async () => {
    await expectCliHelp(["resume", "-h"]);
    await expectCliHelp(["resume", "--help"]);
    await expectCliHelp(["continue", "-h"]);
  });

  test("value flags do not swallow --help / -h as their value", async () => {
    for (const flag of ["--provider", "--model", "--cwd", "--config", "--profile"] as const) {
      await expectCliHelp([flag, "--help"]);
      await expectCliHelp([flag, "-h"]);
    }
  });

  test("value flags reject other flag-shaped tokens as values", async () => {
    await expect(
      loadConfig(["--provider", "--force"], { globalSettingsPath: NO_SETTINGS }),
    ).rejects.toThrow("--provider requires a value");
    await expect(
      loadConfig(["--model", "--cwd"], { globalSettingsPath: NO_SETTINGS }),
    ).rejects.toThrow("--model requires a value");
    await expect(
      loadConfig(["--cwd", "--tmp"], { globalSettingsPath: NO_SETTINGS }),
    ).rejects.toThrow("--cwd requires a value");
    await expect(
      loadConfig(["exec", "--director", "--force", "ship it"], {
        globalSettingsPath: NO_SETTINGS,
      }),
    ).rejects.toThrow("--director requires a value");
  });

  test("value flags still error clearly when the value is omitted", async () => {
    await expect(loadConfig(["--provider"], { globalSettingsPath: NO_SETTINGS })).rejects.toThrow(
      "--provider requires a value",
    );
    await expect(loadConfig(["--model"], { globalSettingsPath: NO_SETTINGS })).rejects.toThrow(
      "--model requires a value",
    );
    await expect(loadConfig(["--cwd"], { globalSettingsPath: NO_SETTINGS })).rejects.toThrow(
      "--cwd requires a value",
    );
    await expect(loadConfig(["--config"], { globalSettingsPath: NO_SETTINGS })).rejects.toThrow(
      "--config requires a value",
    );
    await expect(loadConfig(["--profile"], { globalSettingsPath: NO_SETTINGS })).rejects.toThrow(
      "--profile requires a value",
    );
  });

  test("value flags accept a POSIX path that starts with a single dash", async () => {
    const config = await loadConfig(["--cwd", "-my-dir", "do something"], {
      allowUnconfigured: true,
      globalSettingsPath: NO_SETTINGS,
    });
    expect(config.cwd).toBe(resolve("-my-dir"));
  });

  test("rejects unknown flags", async () => {
    await expect(loadConfig(["--unknown"], { globalSettingsPath: NO_SETTINGS })).rejects.toThrow(
      /unrecognized flag/,
    );
  });

  test("defaults dangerouslySkipPermissions to false", async () => {
    const cwd = await emptyCwd();
    try {
      const globalPath = await writeGlobalSettings(cwd);
      const config = await loadConfig(["--cwd", cwd, "do something"], {
        globalSettingsPath: globalPath,
      });
      expect(config.dangerouslySkipPermissions).toBe(false);
      expect(config.skipPermissionsFromSettings).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("parses --dangerously-skip-permissions", async () => {
    const cwd = await emptyCwd();
    try {
      const globalPath = await writeGlobalSettings(cwd);
      const config = await loadConfig(
        ["--cwd", cwd, "--dangerously-skip-permissions", "do something"],
        { globalSettingsPath: globalPath },
      );
      expect(config.dangerouslySkipPermissions).toBe(true);
      // Came from the CLI flag, not the persisted default — no startup notice.
      expect(config.skipPermissionsFromSettings).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("seeds dangerouslySkipPermissions from global settings without the CLI flag", async () => {
    const cwd = await emptyCwd();
    try {
      const globalPath = join(cwd, "global.json");
      await writeFile(
        globalPath,
        JSON.stringify({
          defaultProvider: "fireworks",
          providers: {
            fireworks: {
              baseURL: "https://api.fireworks.ai/inference",
              apiKey: "test-key",
              models: ["accounts/fireworks/routers/kimi-k2p6-turbo"],
            },
          },
          dangerouslySkipPermissions: true,
        }),
      );
      const config = await loadConfig(["--cwd", cwd, "do something"], {
        globalSettingsPath: globalPath,
      });
      expect(config.dangerouslySkipPermissions).toBe(true);
      // Origin is the persisted default, not this invocation's flag — the
      // startup notice should fire.
      expect(config.skipPermissionsFromSettings).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("settings dangerouslySkipPermissions false without the CLI flag stays false", async () => {
    const cwd = await emptyCwd();
    try {
      const globalPath = join(cwd, "global.json");
      await writeFile(
        globalPath,
        JSON.stringify({
          defaultProvider: "fireworks",
          providers: {
            fireworks: {
              baseURL: "https://api.fireworks.ai/inference",
              apiKey: "test-key",
              models: ["accounts/fireworks/routers/kimi-k2p6-turbo"],
            },
          },
          dangerouslySkipPermissions: false,
        }),
      );
      const config = await loadConfig(["--cwd", cwd, "do something"], {
        globalSettingsPath: globalPath,
      });
      expect(config.dangerouslySkipPermissions).toBe(false);
      expect(config.skipPermissionsFromSettings).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("CLI --dangerously-skip-permissions still wins over settings false", async () => {
    const cwd = await emptyCwd();
    try {
      const globalPath = join(cwd, "global.json");
      await writeFile(
        globalPath,
        JSON.stringify({
          defaultProvider: "fireworks",
          providers: {
            fireworks: {
              baseURL: "https://api.fireworks.ai/inference",
              apiKey: "test-key",
              models: ["accounts/fireworks/routers/kimi-k2p6-turbo"],
            },
          },
          dangerouslySkipPermissions: false,
        }),
      );
      const config = await loadConfig(
        ["--cwd", cwd, "--dangerously-skip-permissions", "do something"],
        { globalSettingsPath: globalPath },
      );
      expect(config.dangerouslySkipPermissions).toBe(true);
      // CLI flag wins over settings — no notice is warranted here.
      expect(config.skipPermissionsFromSettings).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("exec inherits persisted skip-permissions without the CLI flag", async () => {
    const cwd = await emptyCwd();
    try {
      const globalPath = join(cwd, "global.json");
      await writeFile(
        globalPath,
        JSON.stringify({
          defaultProvider: "fireworks",
          providers: {
            fireworks: {
              baseURL: "https://api.fireworks.ai/inference",
              apiKey: "test-key",
              models: ["accounts/fireworks/routers/kimi-k2p6-turbo"],
            },
          },
          dangerouslySkipPermissions: true,
        }),
      );
      const config = await loadConfig(["exec", "--cwd", cwd, "ship it"], {
        globalSettingsPath: globalPath,
      });
      assertConfigured(config);
      expect(config.command).toBe("exec");
      expect(config.dangerouslySkipPermissions).toBe(true);
      expect(config.skipPermissionsFromSettings).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("persisted skip-permissions default applies regardless of cwd (machine-wide scope)", async () => {
    // The global settings file is machine-wide: a session opened against a
    // completely different cwd still inherits the same default. This is the
    // exact silent-everywhere behavior the startup notice exists to surface.
    const globalCwd = await emptyCwd();
    const otherCwd = await emptyCwd();
    try {
      const globalPath = join(globalCwd, "global.json");
      await writeFile(
        globalPath,
        JSON.stringify({
          defaultProvider: "fireworks",
          providers: {
            fireworks: {
              baseURL: "https://api.fireworks.ai/inference",
              apiKey: "test-key",
              models: ["accounts/fireworks/routers/kimi-k2p6-turbo"],
            },
          },
          dangerouslySkipPermissions: true,
        }),
      );
      const config = await loadConfig(["--cwd", otherCwd, "do something"], {
        globalSettingsPath: globalPath,
      });
      expect(config.cwd).toBe(otherCwd);
      expect(config.dangerouslySkipPermissions).toBe(true);
      expect(config.skipPermissionsFromSettings).toBe(true);
    } finally {
      await rm(globalCwd, { recursive: true, force: true });
      await rm(otherCwd, { recursive: true, force: true });
    }
  });

  test("reads provider and model from a --config settings file", async () => {
    const cwd = await emptyCwd();
    try {
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
      const config = await loadConfig(["--cwd", cwd, "--config", settingsPath, "task"]);
      assertConfigured(config);
      expect(config.providerName).toBe("firepass");
      expect(config.baseURL).toBe("https://firepass.example/v1");
      expect(config.apiKey).toBe("fp-key");
      expect(config.model).toBe("fp-large");
      expect(config.globalDefaultProvider).toBe("firepass");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("--model overrides the provider default model", async () => {
    const cwd = await emptyCwd();
    try {
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
        "--model",
        "fp-small",
        "task",
      ]);
      assertConfigured(config);
      expect(config.model).toBe("fp-small");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("--config pointing at a missing file throws", async () => {
    const cwd = await emptyCwd();
    try {
      await expect(
        loadConfig(["--cwd", cwd, "--config", join(cwd, "nope.json"), "task"]),
      ).rejects.toThrow(/not found or empty/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("--profile flag surfaces profile name and model from project profile.json", async () => {
    const cwd = await emptyCwd();
    try {
      const globalPath = await writeGlobalSettings(cwd);
      await mkdir(join(cwd, ".corbits"), { recursive: true });
      await writeFile(
        join(cwd, ".corbits", "profile.json"),
        JSON.stringify({ model: "profile-model", systemPromptExtensions: ["ext1"] }),
      );
      const config = await loadConfig(["--cwd", cwd, "task"], { globalSettingsPath: globalPath });
      assertConfigured(config);
      expect(config.model).toBe("profile-model");
      expect(config.systemPromptExtensions).toEqual(["ext1"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("--model flag overrides profile model", async () => {
    const cwd = await emptyCwd();
    try {
      const globalPath = await writeGlobalSettings(cwd);
      await mkdir(join(cwd, ".corbits"), { recursive: true });
      await writeFile(
        join(cwd, ".corbits", "profile.json"),
        JSON.stringify({ model: "profile-model" }),
      );
      const config = await loadConfig(
        ["--cwd", cwd, "--model", "accounts/fireworks/routers/kimi-k2p6-turbo", "task"],
        {
          globalSettingsPath: globalPath,
        },
      );
      assertConfigured(config);
      expect(config.model).toBe("accounts/fireworks/routers/kimi-k2p6-turbo");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("per-repo local settings select the provider", async () => {
    const cwd = await emptyCwd();
    try {
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
            a: { baseURL: "https://a/v1", apiKey: "a-key", models: ["a-model"] },
            b: { baseURL: "https://b/v1", apiKey: "b-key", models: ["b-model"] },
          },
        }),
      );
      const config = await loadConfig(["--cwd", cwd, "task"], { globalSettingsPath: globalPath });
      assertConfigured(config);
      expect(config.providerName).toBe("b");
      expect(config.model).toBe("b-model");
      expect(config.apiKey).toBe("b-key");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("rejects a local reasoningEffort unsupported by the selected model", async () => {
    const cwd = await emptyCwd();
    try {
      await mkdir(join(cwd, ".corbits"), { recursive: true });
      await writeFile(
        join(cwd, ".corbits", "settings.json"),
        JSON.stringify({ provider: "a", model: "a-model", reasoningEffort: "xhigh" }),
      );
      const globalPath = join(cwd, "global.json");
      await writeFile(
        globalPath,
        JSON.stringify({
          providers: { a: { baseURL: "https://a/v1", apiKey: "a-key", models: ["a-model"] } },
        }),
      );
      await expect(
        loadConfig(["--cwd", cwd, "task"], { globalSettingsPath: globalPath }),
      ).rejects.toThrow(/reasoningEffort/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("buildGoSource", () => {
  test("routes chat-completions models through the OpenCode Go adapter", () => {
    const source = buildGoSource({
      id: "opencode-go",
      apiKey: "sk-go",
      model: "kimi-k2.7-code",
    });

    expect(source.provider).toBe("opencode-go");
    expect(source.quirks).toBeUndefined();
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

  test("substitutes a placeholder apiKey when none is provided (keyless)", () => {
    const source = buildOpenAISource({
      id: "local",
      baseURL: "http://localhost:8080/v1",
      model: "local-model",
    });
    expect(source.apiKey).toBe(KEYLESS_API_KEY);
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
    expect(source.defaults?.providerOptions).toEqual({ reasoning_effort: "low" });
  });
});

describe("buildXaiSource", () => {
  test("omits reasoning_effort when effort is absent", () => {
    const source = buildXaiSource({
      id: "xai/work",
      apiKey: "tok",
      model: "grok-4.6",
      sessionId: "sess-1",
    });
    expect(source.provider).toBe("grok-responses");
    expect(source.defaults?.providerOptions).not.toHaveProperty("reasoning_effort");
  });

  test("sets providerOptions.reasoning_effort when effort is present", () => {
    const source = buildXaiSource({
      id: "xai/work",
      apiKey: "tok",
      model: "grok-4.6",
      sessionId: "sess-1",
      reasoningEffort: "low",
    });
    expect(source.defaults?.providerOptions).toMatchObject({ reasoning_effort: "low" });
  });

  test("does not invent high when effort is absent", () => {
    const source = buildXaiSource({
      id: "xai/work",
      apiKey: "tok",
      model: "grok-4.6",
      sessionId: "sess-1",
    });
    expect(source.defaults?.providerOptions?.["reasoning_effort"]).toBeUndefined();
  });

  test("stashes the session id for the adapter's prompt_cache_key", () => {
    const source = buildXaiSource({
      id: "xai/work",
      apiKey: "tok",
      model: "grok-4.6",
      sessionId: "sess-1",
    });
    expect(source.defaults?.providerOptions).toMatchObject({ grokSessionId: "sess-1" });
  });
});

describe("buildProviderCatalog", () => {
  const resolved: ResolvedProvider = {
    providerName: "fp",
    baseURL: "https://fp/v1",
    apiKey: "fp-key",
    model: "fp-large",
  };

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
    const fp = catalog.find((c) => c.name === "fp")!;
    expect(fp.models).toEqual(["fp-large", "fp-small"]);
    expect(fp.defaultModel).toBe("fp-large");
    expect(catalog.find((c) => c.name === "oa")!.defaultModel).toBeUndefined();
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
    const bf = catalog.find((c) => c.name === "bf")!;
    expect(bf.bifrostVirtualKey).toBe(true);
  });

  test("falls back to the single resolved provider when there is no settings file", () => {
    const catalog = buildProviderCatalog(null, resolved);
    expect(catalog).toEqual([
      { name: "fp", baseURL: "https://fp/v1", apiKey: "fp-key", models: ["fp-large"] },
    ]);
  });

  test("preserves keyless flag and omits apiKey for keyless providers", () => {
    const settings: Settings = {
      providers: {
        ollama: { baseURL: "http://localhost:11434/v1", keyless: true, models: ["llama3"] },
        fp: { baseURL: "https://fp/v1", apiKey: "fp-key", models: ["fp-large"] },
      },
    };
    const catalog = buildProviderCatalog(settings, resolved);
    const ollama = catalog.find((c) => c.name === "ollama")!;
    expect(ollama.keyless).toBe(true);
    expect(ollama.apiKey).toBeUndefined();
    const fp = catalog.find((c) => c.name === "fp")!;
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
        { name: "oa", baseURL: "https://oa/v1", apiKey: "oa-key", models: ["o-1"] },
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
        openai: { baseURL: "https://api.openai.com/v1", apiKey: "sk", models: ["gpt-4o"] },
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
        [{ name: "fp", baseURL: "fp/v1", apiKey: "fp-key", models: ["fp-large"] }],
        undefined,
      ),
    ).toThrow(/Invalid OpenAI-compatible baseURL/);
  });

  test("omits defaultProvider when no global default is known", () => {
    const settings = providerCatalogToSettings(
      [{ name: "fp", baseURL: "https://fp/v1", apiKey: "fp-key", models: ["fp-large"] }],
      undefined,
    );
    expect(settings).toEqual({
      providers: {
        fp: { baseURL: "https://fp/v1", apiKey: "fp-key", models: ["fp-large"] },
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
      providers: { fp: { baseURL: "https://fp/v1", apiKey: "old-key", models: ["fp-small"] } },
      mcpServers: [{ name: "linear", type: "http", url: "https://mcp.linear.app/mcp" }],
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
        { name: "oa", baseURL: "https://oa/v1", apiKey: "oa-key", models: ["o-1"] },
      ],
      "oa",
      existing,
    );
    const { providers: _ep, defaultProvider: _ed, ...restExisting } = existing;
    const { providers: outProviders, defaultProvider: outDefault, ...restOut } = settings;
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
    const entry = catalog.find((c) => c.name === "fp")!;
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
    const entry = catalog.find((c) => c.name === "an")!;
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
    const entry = catalog.find((c) => c.name === "go")!;
    const roundTripped = { go: catalogEntryAsProviderSettings(entry) };
    expect(roundTripped).toEqual({ go: provider });
  });
});

describe("mergeProviderIntoSettings", () => {
  test("preserves plugins and non-provider fields when upserting a provider", () => {
    const existing: Settings = {
      providers: { old: { baseURL: "https://old/v1", apiKey: "k", models: ["m"] } },
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
