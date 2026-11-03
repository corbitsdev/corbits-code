// Drives wireSettings().onConnectProvider with the setup surface, focus
// repaint and catalog prefetches replaced, and asserts which connects refresh
// the ChatGPT catalog. The gate keys on the connected provider's name rather
// than the provider the connect started from, unlike the Go/Zen gates.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { saveGlobalSettings } from "../config/settings.js";
import {
  withMockedHomedir,
  withMockedModule,
} from "../../testkit/mock-module.js";
import type { RunnerServices, RunnerState } from "./runner/state.js";
import { createGlobalSettingsWriter } from "../mcp/add-server.js";
import pkg from "../../package.json" with { type: "json" };
import type { ConnectProviderResult } from "./provider/connect.js";
import type { ProductHostConnectRequest } from "./product-host.js";

let nextResult: ConnectProviderResult = { connected: false };
let codexPrefetches = 0;
let goPrefetches = 0;
let zenPrefetches = 0;

{
  await withMockedModule(
    import.meta.resolve("./provider/connect.js"),
    (real: object) => ({
      ...real,
      connectProviderInline: async () => nextResult,
    }),
  );
  await withMockedModule(
    import.meta.resolve("./shell/chrome.js"),
    (real: object) => ({ ...real, applyFocus: () => undefined }),
  );
  await withMockedModule(
    import.meta.resolve("../provider/codex-model-catalog.js"),
    (real: object) => ({
      ...real,
      prefetchCodexModels: async () => {
        codexPrefetches += 1;
      },
    }),
  );
  await withMockedModule(
    import.meta.resolve("../provider/model-catalogs.js"),
    (real: object) => ({
      ...real,
      prefetchGoModels: async () => {
        goPrefetches += 1;
        return [];
      },
      prefetchZenModels: async () => {
        zenPrefetches += 1;
        return [];
      },
    }),
  );
}

afterEach(() => {
  codexPrefetches = 0;
  goPrefetches = 0;
  zenPrefetches = 0;
  nextResult = { connected: false };
});

async function runConnect(
  providerArg: string,
  result: ConnectProviderResult,
): Promise<void> {
  // Imported after the module mocks above install, so settings.ts binds to
  // the replaced connect flow and prefetches.
  const { wireSettings } = await import("./runner/settings.js");
  const dir = await mkdtemp(join(tmpdir(), "connect-catalog-refresh-"));
  const home = join(dir, "home");
  await mkdir(home, { recursive: true });
  const settingsPath = join(dir, "settings.json");
  await saveGlobalSettings(settingsPath, {
    providers: {},
    telemetry: { noticeShown: true },
    lastChangelogVersion:
      typeof pkg.version === "string" ? pkg.version : "0.0.0",
  });
  nextResult = result;
  const finished = Promise.withResolvers<undefined>();
  const state = {
    config: {
      cwd: dir,
      globalSettingsPath: settingsPath,
      providers: [],
      apiKey: "live-key",
      baseURL: "https://live/v1",
      model: "k1",
      providerName: "keeper",
      settings: { providers: {} },
    },
    localSettingsFile: join(dir, "local.json"),
    trueGlobalSettingsPath: settingsPath,
    host: {
      shell: {},
      renderer: {},
      refreshModels: () => undefined,
      // A successful connect reopens the picker on the new account in the
      // same synchronous step that schedules the catalog refreshes.
      openModels: () => finished.resolve(undefined),
    },
    systemNotice: () => undefined,
  } as unknown as RunnerState;
  const services = {
    hookManager: { getStatuses: () => [] },
    globalSettingsWriter: createGlobalSettingsWriter(settingsPath),
    permissionGate: { setProviderIdentity: () => undefined },
    buildSessionSources: () => ({ sources: [], defaultSource: "" }),
    directorHolder: {},
    computeAdvertised: () => [],
    toolset: { dynamicRunner: { currentDefinitions: () => [] } },
    hostHolder: { instance: undefined },
  } as unknown as RunnerServices;
  const request: ProductHostConnectRequest = {
    onComplete: (connected) => {
      if (!connected) finished.resolve(undefined);
    },
  };
  try {
    await withMockedHomedir(home, async () => {
      const wiring = await wireSettings(state, services);
      wiring.onConnectProvider(providerArg, request);
      await finished.promise;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("post-connect ChatGPT catalog refresh gate", () => {
  test("connecting ChatGPT from the codex row refreshes the codex catalog", async () => {
    await runConnect("codex", {
      connected: true,
      providerName: "codex/work",
      model: "gpt-5.5",
    });
    expect(codexPrefetches).toBe(1);
    expect(goPrefetches).toBe(0);
    expect(zenPrefetches).toBe(0);
  });

  test("a ChatGPT account reached from a non-codex entry still refreshes", async () => {
    // /connect openai -> Esc back to the provider list -> ChatGPT row.
    await runConnect("openai", {
      connected: true,
      providerName: "codex/work",
      model: "gpt-5.5",
    });
    expect(codexPrefetches).toBe(1);
  });

  test("an API-key OpenAI connect does not refresh the codex catalog", async () => {
    await runConnect("openai", {
      connected: true,
      providerName: "openai",
      model: "gpt-5",
    });
    expect(codexPrefetches).toBe(0);
  });

  test("a cancelled connect does not refresh the codex catalog", async () => {
    await runConnect("codex", { connected: false });
    expect(codexPrefetches).toBe(0);
  });
});
