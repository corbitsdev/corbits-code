import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defined } from "../../../testkit/defined.js";
import { withMockedModuleDuring } from "../../../testkit/mock-module.js";
import {
  contextWindowFor,
  setModelContextWindows,
  setProviderContextWindowOverrides,
} from "../../provider/context-window.js";
import { refreshCatalogAfterPrefetch } from "./catalog-refresh.js";
import type { RunnerServices, RunnerState } from "./state.js";

const dirs: string[] = [];
afterEach(() => {
  setModelContextWindows(undefined);
  setProviderContextWindowOverrides(undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function settingsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "catalog-refresh-"));
  dirs.push(dir);
  const path = join(dir, "settings.json");
  writeFileSync(
    path,
    JSON.stringify({
      providers: {
        first: {
          baseURL: "https://first.example/v1",
          keyless: true,
          models: ["shared-model"],
          contextWindow: 32_000,
        },
        second: {
          baseURL: "https://second.example/v1",
          keyless: true,
          models: ["shared-model"],
          contextWindow: 64_000,
        },
      },
    }),
  );
  return path;
}

function fixture(withHost: boolean) {
  const calls: unknown[][] = [];
  const host = {
    refreshModels: (...args: unknown[]) => {
      calls.push(args);
    },
  };
  const state = {
    trueGlobalSettingsPath: settingsFile(),
    config: {
      apiKey: "",
      baseURL: "https://first.example/v1",
      model: "shared-model",
      providerName: "first",
      keyless: true,
      providers: [],
    },
  } as unknown as RunnerState;
  const services = {
    hostHolder: withHost ? { instance: host } : {},
  } as unknown as RunnerServices;
  return { state, services, calls };
}

function withNoOAuthProfiles<T>(run: () => Promise<T>): Promise<T> {
  return withMockedModuleDuring(
    import.meta.resolve("../../config/oauth-stores.js"),
    (real: typeof import("../../config/oauth-stores.js")) => ({
      ...real,
      listCodexProfiles: async () => [],
      listXaiProfiles: async () => [],
      listMetaProfiles: async () => [],
    }),
    run,
  );
}

const flush = () => new Promise((r) => setTimeout(r, 50));

describe("refreshCatalogAfterPrefetch", () => {
  test("rebuilds the catalog from disk and hands it to the host after the prefetch settles", async () => {
    const { state, services, calls } = fixture(true);
    const prefetch = Promise.withResolvers<undefined>();
    await withNoOAuthProfiles(async () => {
      refreshCatalogAfterPrefetch(
        state,
        services,
        "go",
        () => prefetch.promise,
      );
      await flush();
      expect(calls).toHaveLength(0);
      prefetch.resolve(undefined);
      await flush();
    });
    expect(calls).toHaveLength(1);
    expect(defined(calls[0])[2]).toBe(state.config.providers);
    expect(state.config.providers.map((p) => p.name).sort()).toEqual([
      "first",
      "second",
    ]);
    expect(state.config.settings).toBeDefined();
  });

  test("a model switch while the prefetch is in flight is the selection the refresh keeps", async () => {
    const { state, services } = fixture(true);
    const prefetch = Promise.withResolvers<undefined>();
    await withNoOAuthProfiles(async () => {
      refreshCatalogAfterPrefetch(
        state,
        services,
        "zen",
        () => prefetch.promise,
      );
      state.config = { ...state.config, providerName: "second" };
      prefetch.resolve(undefined);
      await flush();
    });
    expect(contextWindowFor("shared-model")).toBe(64_000);
  });

  test("does nothing when no host is mounted", async () => {
    const { state, services } = fixture(false);
    const before = state.config;
    await withNoOAuthProfiles(async () => {
      refreshCatalogAfterPrefetch(state, services, "go", async () => undefined);
      await flush();
    });
    expect(state.config).toBe(before);
  });

  test("a failed prefetch leaves state and the host untouched", async () => {
    const { state, services, calls } = fixture(true);
    const before = state.config;
    await withNoOAuthProfiles(async () => {
      refreshCatalogAfterPrefetch(state, services, "go", () =>
        Promise.reject(new Error("offline")),
      );
      await flush();
    });
    expect(calls).toHaveLength(0);
    expect(state.config).toBe(before);
  });

  test("a model switch during the post-prefetch credential discovery is the selection the refresh keeps", async () => {
    const { state, services } = fixture(true);
    const discovery = Promise.withResolvers<[]>();
    const discoveryStarted = Promise.withResolvers<undefined>();
    await withMockedModuleDuring(
      import.meta.resolve("../../config/oauth-stores.js"),
      (real: typeof import("../../config/oauth-stores.js")) => ({
        ...real,
        listCodexProfiles: () => {
          discoveryStarted.resolve(undefined);
          return discovery.promise;
        },
        listXaiProfiles: async () => [],
        listMetaProfiles: async () => [],
      }),
      async () => {
        refreshCatalogAfterPrefetch(
          state,
          services,
          "go",
          async () => undefined,
        );
        await discoveryStarted.promise;
        state.config = { ...state.config, providerName: "second" };
        discovery.resolve([]);
        await flush();
      },
    );
    expect(contextWindowFor("shared-model")).toBe(64_000);
  });
});
