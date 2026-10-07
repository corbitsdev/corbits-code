import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  saveGlobalSettings,
  saveLocalSettings,
  loadLocalSettings,
  loadSettings,
  type Settings,
} from "../config/settings.js";
import {
  loadCodexProfile,
  saveCodexProfile,
  listXaiProfiles,
  loadXaiProfile,
  saveXaiProfile,
} from "../config/oauth-stores.js";
import { clearSourceCredentials } from "../config/source-credentials.js";
import { refreshLiveProviderCatalog } from "../config/index.js";
import { buildMainSessionSources } from "../config/inference-sources.js";
import { createGlobalSettingsWriter } from "../mcp/add-server.js";
import { withMockedHomedir } from "../../testkit/mock-module.js";
import { modelOptionId } from "./model-catalog.js";
import { wireSettings } from "./runner/settings.js";
import type { RunnerState, RunnerServices } from "./runner/state.js";
import pkg from "../../package.json" with { type: "json" };

const SEED_TELEMETRY = { noticeShown: true } as const;
// Stamp the watermark the startup path would write so the harness owns every
// snapshotted byte; otherwise the async first-install stamp races the
// "zero writes" assertions.
const SEED_WATERMARKS = {
  telemetry: { ...SEED_TELEMETRY },
  lastChangelogVersion: typeof pkg.version === "string" ? pkg.version : "0.0.0",
} as const;

afterEach(() => {
  clearSourceCredentials();
});

function keeperEntry() {
  return {
    baseURL: "https://keeper/v1",
    apiKey: "keeper-key",
    models: ["k1"],
    defaultModel: "k1",
  };
}

interface RemoveHarness {
  readonly settingsPath: string;
  readonly localPath: string;
  readonly home: string;
  readonly notices: string[];
  readonly refreshed: unknown[][];
  readonly opened: (string | undefined)[];
  readonly wiring: Awaited<ReturnType<typeof wireSettings>>;
  readonly state: RunnerState;
  readonly cleanup: () => Promise<void>;
}

async function wireRemoveHarness(opts: {
  readonly seed: Settings;
  readonly local?: { provider: string; model: string } | null;
  readonly liveProvider: string;
}): Promise<RemoveHarness> {
  const dir = await mkdtemp(join(tmpdir(), "provider-remove-"));
  const home = join(dir, "home");
  await mkdir(home, { recursive: true });
  const settingsPath = join(dir, "settings.json");
  const localPath = join(dir, "local.json");
  await saveGlobalSettings(settingsPath, opts.seed);
  if (opts.local !== undefined && opts.local !== null) {
    await saveLocalSettings(localPath, opts.local);
  }
  const notices: string[] = [];
  const refreshed: unknown[][] = [];
  const opened: (string | undefined)[] = [];
  const state = {
    config: {
      cwd: dir,
      globalSettingsPath: settingsPath,
      providers: [],
      apiKey: "live-key",
      baseURL: "https://live/v1",
      model: "k1",
      providerName: opts.liveProvider,
      settings: opts.seed,
    },
    localSettingsFile: localPath,
    trueGlobalSettingsPath: settingsPath,
    host: {
      refreshModels: (...args: unknown[]) => {
        refreshed.push(args);
      },
      openModels: (focusId?: string) => {
        opened.push(focusId);
      },
    },
    systemNotice: (msg: string) => {
      notices.push(msg);
    },
  } as unknown as RunnerState;
  const services = {
    hookManager: { getStatuses: () => [] },
    globalSettingsWriter: createGlobalSettingsWriter(settingsPath),
    permissionGate: { setProviderIdentity: () => undefined },
    buildSessionSources: () => ({ sources: [], defaultSource: "" }),
    directorHolder: {},
    computeAdvertised: () => [],
    toolset: { dynamicRunner: { currentDefinitions: () => [] } },
  } as unknown as RunnerServices;
  const wiring = await wireSettings(state, services);
  return {
    settingsPath,
    localPath,
    home,
    notices,
    refreshed,
    opened,
    wiring,
    state,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** Run the remove flow with a hermetic home dir, waiting for its notice. */
async function executeRemove(
  harness: RemoveHarness,
  itemId: string,
): Promise<void> {
  // The runner resolves auth stores via os.homedir() (Bun ignores a
  // late process.env.HOME assignment), so mock the home for the run.
  await withMockedHomedir(harness.home, async () => {
    harness.wiring.onRemoveProvider(itemId);
    const deadline = Date.now() + 5000;
    while (
      harness.notices.length === 0 &&
      harness.refreshed.length === 0 &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // Let trailing refresh/notice writes land.
    await new Promise((r) => setTimeout(r, 50));
  });
}

async function refreshCatalog(harness: RemoveHarness): Promise<void> {
  await withMockedHomedir(harness.home, async () => {
    const config = harness.state.config;
    config.providers = await refreshLiveProviderCatalog(
      config.settings ?? null,
      {
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        model: config.model,
        providerName: config.providerName,
        ...(config.keyless !== undefined ? { keyless: config.keyless } : {}),
      },
    );
  });
}

const PROFILE_TOKENS = {
  access: "a",
  refresh: "r",
  expiresAt: 10_000_000,
};

describe("provider removal execute path", () => {
  test("removes an API-key provider: entry, secret, refs, and local selection", async () => {
    const seed: Settings = {
      ...SEED_WATERMARKS,
      defaultProvider: "keeper",
      providers: {
        keeper: keeperEntry(),
        "openai/work": {
          baseURL: "https://api.openai.com/v1",
          apiKey: "SECRET-WORK-KEY",
          models: ["m1", "m2"],
          defaultModel: "m1",
        },
      },
      recentModels: [
        { provider: "openai/work", model: "m1" },
        { provider: "keeper", model: "k1" },
      ],
      favoriteModels: [{ provider: "openai/work", model: "m2" }],
    };
    const harness = await wireRemoveHarness({
      seed,
      local: { provider: "openai/work", model: "m1" },
      liveProvider: "keeper",
    });
    try {
      await executeRemove(harness, modelOptionId("openai/work", "m1"));
      const onDisk = await loadSettings(harness.settingsPath);
      expect(onDisk?.providers["openai/work"]).toBeUndefined();
      expect(onDisk?.providers["keeper"]).toBeDefined();
      expect(onDisk?.defaultProvider).toBe("keeper");
      expect(onDisk?.recentModels).toEqual([
        { provider: "keeper", model: "k1" },
      ]);
      expect(onDisk?.favoriteModels).toEqual([]);
      // The secret dies with the entry: absent on disk, not just parsed-absent.
      const raw = await readFile(harness.settingsPath, "utf8");
      expect(raw).not.toContain("SECRET-WORK-KEY");
      expect(raw).toContain("keeper-key");
      // The dangling per-repo pick is cleared (selection-only rewrite).
      expect(await loadLocalSettings(harness.localPath)).toEqual({});
      // Picker refreshed and reopened at the surviving default's model.
      expect(harness.refreshed.length).toBe(1);
      expect(harness.opened).toEqual([modelOptionId("keeper", "k1")]);
      expect(harness.notices.length).toBe(1);
      expect(harness.notices[0]).toContain(
        "Removed openai/work (catalog entry + stored key forgotten).",
      );
      expect(harness.notices[0]).toContain(
        "Dropped 1 recent + 1 favorite refs.",
      );
      expect(harness.notices[0]).not.toContain("SECRET-WORK-KEY");
    } finally {
      await harness.cleanup();
    }
  });

  test("refuses the live session's provider with zero writes", async () => {
    const seed: Settings = {
      ...SEED_WATERMARKS,
      defaultProvider: "openai/work",
      providers: {
        keeper: keeperEntry(),
        "openai/work": {
          baseURL: "https://api.openai.com/v1",
          apiKey: "SECRET-WORK-KEY",
          models: ["m1"],
          defaultModel: "m1",
        },
      },
    };
    const harness = await wireRemoveHarness({
      seed,
      local: { provider: "keeper", model: "k1" },
      liveProvider: "openai/work",
    });
    try {
      const beforeSettings = await readFile(harness.settingsPath, "utf8");
      const beforeLocal = await readFile(harness.localPath, "utf8");
      await executeRemove(harness, modelOptionId("openai/work", "m1"));
      expect(harness.notices).toEqual([
        "openai/work is running this session — switch with /model first.",
      ]);
      expect(await readFile(harness.settingsPath, "utf8")).toBe(beforeSettings);
      expect(await readFile(harness.localPath, "utf8")).toBe(beforeLocal);
      expect(harness.refreshed).toEqual([]);
      expect(harness.opened).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  test("removes an inactive OAuth provider without source registration", async () => {
    const seed: Settings = {
      ...SEED_WATERMARKS,
      defaultProvider: "keeper",
      providers: {
        keeper: keeperEntry(),
        "xai/work": {
          baseURL: "https://api.x.ai/v1",
          models: ["grok-4"],
          defaultModel: "grok-4",
        },
      },
      recentModels: [
        { provider: "xai/work", model: "grok-4" },
        { provider: "keeper", model: "k1" },
      ],
    };
    const harness = await wireRemoveHarness({
      seed,
      local: null,
      liveProvider: "keeper",
    });
    try {
      clearSourceCredentials();
      await saveXaiProfile(
        { name: "work", createdAt: 0, tokens: PROFILE_TOKENS },
        harness.home,
      );
      await saveXaiProfile(
        { name: "personal", createdAt: 0, tokens: PROFILE_TOKENS },
        harness.home,
      );
      await refreshCatalog(harness);
      await executeRemove(harness, modelOptionId("xai/work", "grok-4"));
      const onDisk = await loadSettings(harness.settingsPath);
      expect(onDisk?.providers["xai/work"]).toBeUndefined();
      expect(await loadXaiProfile("work", harness.home)).toBeUndefined();
      expect((await listXaiProfiles(harness.home)).map((p) => p.name)).toEqual([
        "personal",
      ]);
      expect(harness.notices.length).toBe(1);
      expect(harness.notices[0]).toContain(
        "Removed xai/work (auth profile 'work' + catalog entry forgotten).",
      );
      expect(harness.notices[0]).toContain("Dropped 1 recent refs.");
    } finally {
      await harness.cleanup();
    }
  });

  test("a ghost name is a notice plus a no-op, never a write", async () => {
    const seed: Settings = {
      ...SEED_WATERMARKS,
      providers: { keeper: keeperEntry() },
    };
    const harness = await wireRemoveHarness({
      seed,
      local: null,
      liveProvider: "keeper",
    });
    try {
      const before = await readFile(harness.settingsPath, "utf8");
      await executeRemove(harness, modelOptionId("ghost", "m"));
      expect(harness.notices).toEqual(["ghost is already gone."]);
      expect(await readFile(harness.settingsPath, "utf8")).toBe(before);
      expect(harness.refreshed).toEqual([]);
      expect(harness.opened).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  test("orphan retry clears a lingering auth profile with no catalog row", async () => {
    const seed: Settings = {
      ...SEED_WATERMARKS,
      providers: { keeper: keeperEntry() },
    };
    const harness = await wireRemoveHarness({
      seed,
      local: null,
      liveProvider: "keeper",
    });
    try {
      clearSourceCredentials();
      await saveXaiProfile(
        { name: "work", createdAt: 0, tokens: PROFILE_TOKENS },
        harness.home,
      );
      await saveXaiProfile(
        { name: "personal", createdAt: 0, tokens: PROFILE_TOKENS },
        harness.home,
      );
      await refreshCatalog(harness);
      expect(
        harness.wiring.describeRemoveProvider(
          modelOptionId("xai/work", "grok-4"),
        ),
      ).toContain("auth profile 'work'");
      const before = await readFile(harness.settingsPath, "utf8");
      await executeRemove(harness, modelOptionId("xai/work", "grok-4"));
      // The orphaned credential is gone; siblings are untouched.
      expect(await loadXaiProfile("work", harness.home)).toBeUndefined();
      expect((await listXaiProfiles(harness.home)).map((p) => p.name)).toEqual([
        "personal",
      ]);
      // The catalog row was already gone, so settings are untouched.
      expect(await readFile(harness.settingsPath, "utf8")).toBe(before);
      expect(harness.notices).toEqual([
        "Removed xai/work (auth profile 'work' forgotten).",
      ]);
      expect(harness.refreshed).toEqual([]);
      expect(harness.opened).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  test("custom namespaced providers ignore stale OAuth source provenance", async () => {
    for (const provider of ["xai/manual", "codex/manual"] as const) {
      const oauthSeed: Settings = {
        ...SEED_WATERMARKS,
        providers: {
          keeper: keeperEntry(),
          [provider]: {
            baseURL: "https://oauth-placeholder.invalid/v1",
            models: ["manual-model"],
            defaultModel: "manual-model",
          },
        },
      };
      const harness = await wireRemoveHarness({
        seed: oauthSeed,
        local: null,
        liveProvider: "keeper",
      });
      try {
        clearSourceCredentials();
        if (provider.startsWith("xai/")) {
          await saveXaiProfile(
            { name: "manual", createdAt: 0, tokens: PROFILE_TOKENS },
            harness.home,
          );
        } else {
          await saveCodexProfile(
            { name: "manual", createdAt: 0, tokens: PROFILE_TOKENS },
            harness.home,
          );
        }
        await refreshCatalog(harness);
        buildMainSessionSources({
          settings: harness.state.config.settings,
          catalog: harness.state.config.providers,
          activeProvider: provider,
          activeModel: "manual-model",
          sessionId: "stale-provenance",
        });

        const customSettings: Settings = {
          ...SEED_WATERMARKS,
          providers: {
            keeper: keeperEntry(),
            [provider]: {
              baseURL: "https://manual.example/v1",
              apiKey: "manual-key",
              models: ["manual-model"],
              defaultModel: "manual-model",
            },
          },
        };
        await saveGlobalSettings(harness.settingsPath, customSettings);
        harness.state.config.settings = customSettings;
        await refreshCatalog(harness);
        await executeRemove(harness, modelOptionId(provider, "manual-model"));
        const profile = provider.startsWith("xai/")
          ? await loadXaiProfile("manual", harness.home)
          : await loadCodexProfile("manual", harness.home);
        expect(profile).toBeDefined();
      } finally {
        await harness.cleanup();
      }
    }
  });

  test("cannot switch to a provider while its removal is pending", async () => {
    const seed: Settings = {
      ...SEED_WATERMARKS,
      providers: {
        keeper: keeperEntry(),
        victim: {
          baseURL: "https://victim/v1",
          apiKey: "victim-key",
          models: ["v1"],
          defaultModel: "v1",
        },
      },
    };
    const harness = await wireRemoveHarness({
      seed,
      local: null,
      liveProvider: "keeper",
    });
    try {
      const victim = modelOptionId("victim", "v1");
      harness.wiring.onRemoveProvider(victim);
      harness.wiring.onModelSelect(victim);
      expect(harness.state.config.providerName).toBe("keeper");
    } finally {
      await harness.cleanup();
    }
  });

  test("removing the default repoints it and says where it went", async () => {
    const seed: Settings = {
      ...SEED_WATERMARKS,
      defaultProvider: "victim",
      providers: {
        keeper: keeperEntry(),
        victim: {
          baseURL: "https://victim/v1",
          apiKey: "victim-key",
          models: ["v1"],
          defaultModel: "v1",
        },
      },
      recentModels: [{ provider: "keeper", model: "k1" }],
    };
    const harness = await wireRemoveHarness({
      seed,
      local: null,
      liveProvider: "keeper",
    });
    try {
      await executeRemove(harness, modelOptionId("victim", "v1"));
      const onDisk = await loadSettings(harness.settingsPath);
      expect(onDisk?.defaultProvider).toBe("keeper");
      expect(harness.notices.length).toBe(1);
      expect(harness.notices[0]).toContain("Default moved to keeper.");
      expect(harness.opened).toEqual([modelOptionId("keeper", "k1")]);
    } finally {
      await harness.cleanup();
    }
  });

  test("removing the sole provider warns that none are left", async () => {
    const seed: Settings = {
      ...SEED_WATERMARKS,
      defaultProvider: "only",
      providers: {
        only: {
          baseURL: "https://only/v1",
          apiKey: "only-key",
          models: ["o1"],
          defaultModel: "o1",
        },
      },
    };
    const harness = await wireRemoveHarness({
      seed,
      local: null,
      // The session runs on a provider the catalog no longer names, so the
      // live-session guard passes and the sole entry can still be removed.
      liveProvider: "elsewhere",
    });
    try {
      await executeRemove(harness, modelOptionId("only", "o1"));
      const onDisk = await loadSettings(harness.settingsPath);
      expect(onDisk?.providers).toEqual({});
      expect(onDisk?.defaultProvider).toBeUndefined();
      expect(harness.notices.length).toBe(1);
      expect(harness.notices[0]).toContain("No default provider set.");
      expect(harness.notices[0]).toContain(
        "No providers left — /connect to add one.",
      );
    } finally {
      await harness.cleanup();
    }
  });
});

describe("describeRemoveProvider", () => {
  async function wireLines(seed: Settings): Promise<RemoveHarness> {
    return wireRemoveHarness({ seed, local: null, liveProvider: "keeper" });
  }

  test("names the credential kind and the repair preview, never key material", async () => {
    const seed: Settings = {
      ...SEED_WATERMARKS,
      defaultProvider: "openai/work",
      providers: {
        keeper: keeperEntry(),
        "openai/work": {
          baseURL: "https://api.openai.com/v1",
          apiKey: "SECRET-WORK-KEY",
          models: ["m1", "m2"],
          defaultModel: "m1",
        },
        "xai/work": {
          baseURL: "https://api.x.ai/v1",
          models: ["grok-4"],
          defaultModel: "grok-4",
        },
        local: {
          baseURL: "http://localhost:11434/v1",
          models: ["llama"],
          keyless: true,
        },
      },
      recentModels: [{ provider: "keeper", model: "k1" }],
    };
    const harness = await wireLines(seed);
    try {
      clearSourceCredentials();
      await saveXaiProfile(
        { name: "work", createdAt: 0, tokens: PROFILE_TOKENS },
        harness.home,
      );
      await refreshCatalog(harness);
      const keyLine = harness.wiring.describeRemoveProvider(
        modelOptionId("openai/work", "m1"),
      );
      expect(keyLine).toContain("Remove openai/work (2 models)?");
      expect(keyLine).toContain("catalog entry + stored key");
      expect(keyLine).toContain("Default moves to keeper.");
      expect(keyLine).toContain("Alt+R again to confirm");
      expect(keyLine).not.toContain("SECRET-WORK-KEY");

      const oauthLine = harness.wiring.describeRemoveProvider(
        modelOptionId("xai/work", "grok-4"),
      );
      expect(oauthLine).toContain("Remove xai/work (1 model)?");
      expect(oauthLine).toContain("auth profile 'work'");

      const keylessLine = harness.wiring.describeRemoveProvider(
        modelOptionId("local", "llama"),
      );
      expect(keylessLine).toContain("catalog entry (no stored secret)");
    } finally {
      await harness.cleanup();
    }
  });

  test("returns null for ghost rows and non-model ids", async () => {
    const seed: Settings = {
      ...SEED_WATERMARKS,
      providers: { keeper: keeperEntry() },
    };
    const harness = await wireLines(seed);
    try {
      expect(
        harness.wiring.describeRemoveProvider(modelOptionId("ghost", "m")),
      ).toBeNull();
      expect(harness.wiring.describeRemoveProvider("")).toBeNull();
      expect(
        harness.wiring.describeRemoveProvider("not-a-model-id"),
      ).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });
});
