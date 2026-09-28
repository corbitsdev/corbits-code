import { describe, expect, test } from "bun:test";
import type { CodexProfile } from "../auth/codex/store.js";
import { CODEX_BASE_URL } from "../auth/codex/constants.js";
import type { XaiProfile } from "../auth/xai/store.js";
import { XAI_BASE_URL } from "../auth/xai/constants.js";
import {
  codexProfilesToCatalogEntries,
  codexProvidersAsSettings,
} from "./codex-providers.js";
import {
  dropOrphanedOAuthEntries,
  mergeOAuthCatalog,
  overlayOAuthProjections,
  providerCatalogToSettings,
  runtimeSettingsWithCatalog,
} from "./index.js";
import type {
  ProviderSettings,
  ResolvedProvider,
  Settings,
} from "./settings.js";

// Regression tests for CL-5606: after a successful ChatGPT browser login the
// merged catalog must not list a separately-added legacy bare `codex` row
// alongside the credential-backed `codex/<profile>` entry.
//
// CL-7929: the drop only applies when the bare row points at the OAuth
// endpoint. A bare row pointed at a proxy/mirror is a distinct provider and
// stays alongside the credential-backed entries.

const resolved: ResolvedProvider = {
  providerName: "openai",
  baseURL: "https://api.openai.com/v1",
  apiKey: "sk-test",
  model: "gpt-5",
};

function settingsWith(providers: Record<string, ProviderSettings>): Settings {
  return { providers } as Settings;
}

const codexEntry = (): ProviderSettings => ({
  baseURL: CODEX_BASE_URL,
  models: ["gpt-5.1-codex-max"],
});

const xaiEntry = (): ProviderSettings => ({
  baseURL: XAI_BASE_URL,
  models: ["grok-4-1"],
});

const codexDefault: CodexProfile = {
  name: "default",
  tokens: { access: "codex-access", refresh: "r", expiresAt: 1 },
  createdAt: 0,
};
const xaiWork: XaiProfile = {
  name: "work",
  tokens: { access: "xai-access", refresh: "r", expiresAt: 1 },
  createdAt: 0,
};

describe("mergeOAuthCatalog legacy bare-row dedupe (CL-5606)", () => {
  test("a legacy bare codex row is dropped once codex/default is connected", () => {
    const merged = mergeOAuthCatalog(
      settingsWith({ codex: codexEntry(), "codex/default": codexEntry() }),
      resolved,
      [codexDefault],
      [],
    );
    expect(merged.map((p) => p.name)).toEqual(["codex/default"]);
  });

  test("a legacy bare xai row is dropped once xai/work is connected", () => {
    const merged = mergeOAuthCatalog(
      settingsWith({ xai: xaiEntry() }),
      resolved,
      [],
      [xaiWork],
    );
    expect(merged.map((p) => p.name)).toEqual(["xai/work"]);
  });

  test("a bare codex row survives when nothing credential-backed exists", () => {
    // Not connected: no auth-store profile and no qualified entry. The legacy
    // single-instance row is the only ChatGPT access — keep it.
    const merged = mergeOAuthCatalog(
      settingsWith({ codex: codexEntry() }),
      resolved,
      [],
      [],
    );
    expect(merged.map((p) => p.name)).toEqual(["codex"]);
  });

  test("unrelated and API-key rows are untouched by the dedupe", () => {
    const merged = mergeOAuthCatalog(
      settingsWith({
        openai: {
          baseURL: "https://api.openai.com/v1",
          apiKey: "sk-test",
          models: ["gpt-5"],
        },
        codex: codexEntry(),
      }),
      resolved,
      [codexDefault],
      [],
    );
    expect(merged.map((p) => p.name)).toEqual(["openai", "codex/default"]);
  });

  test("a bare codex row pointed at a proxy survives alongside codex/default (CL-7929)", () => {
    const merged = mergeOAuthCatalog(
      settingsWith({
        codex: {
          baseURL: "https://proxy.example.com/v1",
          apiKey: "sk-proxy",
          models: ["gpt-5.1-codex-max"],
        },
      }),
      resolved,
      [codexDefault],
      [],
    );
    expect(merged.map((p) => p.name)).toEqual(["codex", "codex/default"]);
  });

  test("a bare xai row pointed at a mirror survives alongside xai/work (CL-7929)", () => {
    const merged = mergeOAuthCatalog(
      settingsWith({
        xai: {
          baseURL: "https://mirror.example.com/v1",
          apiKey: "sk-mirror",
          models: ["grok-4-1"],
        },
      }),
      resolved,
      [],
      [xaiWork],
    );
    expect(merged.map((p) => p.name)).toEqual(["xai", "xai/work"]);
  });
});

describe("CL-6728: OAuth projections do not overwrite hand-named provider entries", () => {
  const handNamed = (): ProviderSettings => ({
    baseURL: "https://hand-named.example.com/v1",
    apiKey: "hand-named-key",
    models: ["hand-model"],
  });
  const liveMine: CodexProfile = {
    name: "mine",
    tokens: { access: "live-token", refresh: "r", expiresAt: 1 },
    createdAt: 0,
  };
  const liveProjected = () => codexProvidersAsSettings([liveMine]);
  const liveCatalog = () => codexProfilesToCatalogEntries([liveMine]);

  test("overlayOAuthProjections keeps a hand-named codex/<slug> API-key entry", () => {
    const overlaid = overlayOAuthProjections(
      settingsWith({ "codex/mine": handNamed() }),
      liveProjected(),
    );
    expect(overlaid?.providers["codex/mine"]?.apiKey).toBe("hand-named-key");
  });

  test("overlayOAuthProjections still applies the live token over a credential-less OAuth placeholder", () => {
    const overlaid = overlayOAuthProjections(
      settingsWith({ "codex/mine": codexEntry() }),
      liveProjected(),
    );
    expect(overlaid?.providers["codex/mine"]?.apiKey).toBe("live-token");
  });

  test("dropOrphanedOAuthEntries never drops a hand-named API-key entry", () => {
    const kept = dropOrphanedOAuthEntries(
      settingsWith({ "codex/mine": handNamed() }),
      {},
    );
    expect(kept?.providers["codex/mine"]?.apiKey).toBe("hand-named-key");
  });

  test("dropOrphanedOAuthEntries still drops a credential-less orphan", () => {
    const dropped = dropOrphanedOAuthEntries(
      settingsWith({ "codex/mine": codexEntry() }),
      {},
    );
    expect(dropped?.providers["codex/mine"]).toBeUndefined();
  });

  test("runtimeSettingsWithCatalog keeps a hand-named codex/<slug> API-key entry", () => {
    const runtime = runtimeSettingsWithCatalog(
      settingsWith({ "codex/mine": handNamed() }),
      liveCatalog(),
    );
    expect(runtime.providers["codex/mine"]?.apiKey).toBe("hand-named-key");
  });

  test("runtimeSettingsWithCatalog still overlays the live token over a placeholder", () => {
    const runtime = runtimeSettingsWithCatalog(
      settingsWith({ "codex/mine": codexEntry() }),
      liveCatalog(),
    );
    expect(runtime.providers["codex/mine"]?.apiKey).toBe("live-token");
  });

  test("mergeOAuthCatalog keeps a hand-named codex/<slug> entry when its profile is live", () => {
    const merged = mergeOAuthCatalog(
      settingsWith({ "codex/mine": handNamed() }),
      resolved,
      [liveMine],
      [],
    );
    const rows = merged.filter((p) => p.name === "codex/mine");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.apiKey).toBe("hand-named-key");
    expect(rows[0]?.codexProfile).toBeUndefined();
  });

  test("mergeOAuthCatalog keeps a hand-named codex/<slug> entry with no live profile", () => {
    const merged = mergeOAuthCatalog(
      settingsWith({ "codex/mine": handNamed() }),
      resolved,
      [],
      [],
    );
    expect(merged.find((p) => p.name === "codex/mine")?.apiKey).toBe(
      "hand-named-key",
    );
  });

  test("mergeOAuthCatalog keeps the marked live entry when settings is null and resolved is codex/<slug>", () => {
    const resolvedCodexMine: ResolvedProvider = {
      providerName: "codex/mine",
      baseURL: CODEX_BASE_URL,
      apiKey: "live-token",
      model: "gpt-5.1-codex-max",
    };
    const merged = mergeOAuthCatalog(null, resolvedCodexMine, [liveMine], []);
    const rows = merged.filter((p) => p.name === "codex/mine");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.codexProfile).toBe("mine");
    expect(rows[0]?.apiKey).toBe("live-token");
  });

  test("persist round-trip from the null-settings merge contains no live token", () => {
    const resolvedCodexMine: ResolvedProvider = {
      providerName: "codex/mine",
      baseURL: CODEX_BASE_URL,
      apiKey: "live-token",
      model: "gpt-5.1-codex-max",
    };
    const merged = mergeOAuthCatalog(null, resolvedCodexMine, [liveMine], []);
    const persisted = providerCatalogToSettings(merged, undefined);
    expect(JSON.stringify(persisted)).not.toContain("live-token");
  });

  test("mergeOAuthCatalog keeps a hand-named xai/<slug> entry when its profile is live", () => {
    const handNamedXai = (): ProviderSettings => ({
      baseURL: "https://hand-named-xai.example.com/v1",
      apiKey: "hand-named-xai-key",
      models: ["hand-xai-model"],
    });
    const merged = mergeOAuthCatalog(
      settingsWith({ "xai/work": handNamedXai() }),
      resolved,
      [],
      [xaiWork],
    );
    const rows = merged.filter((p) => p.name === "xai/work");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.apiKey).toBe("hand-named-xai-key");
    expect(rows[0]?.xaiProfile).toBeUndefined();
  });

  test("mergeOAuthCatalog keeps a keyless codex/<slug> entry when its profile is live", () => {
    const merged = mergeOAuthCatalog(
      settingsWith({
        "codex/mine": {
          baseURL: "https://hand-named.example.com/v1",
          keyless: true,
          models: ["hand-model"],
        },
      }),
      resolved,
      [liveMine],
      [],
    );
    const rows = merged.filter((p) => p.name === "codex/mine");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.keyless).toBe(true);
    expect(rows[0]?.codexProfile).toBeUndefined();
  });

  test("runtimeSettingsWithCatalog keeps a keyless codex/<slug> entry", () => {
    const runtime = runtimeSettingsWithCatalog(
      settingsWith({
        "codex/mine": {
          baseURL: "https://hand-named.example.com/v1",
          keyless: true,
          models: ["hand-model"],
        },
      }),
      liveCatalog(),
    );
    expect(runtime.providers["codex/mine"]?.keyless).toBe(true);
    expect(runtime.providers["codex/mine"]?.apiKey).toBeUndefined();
  });

  test("overlayOAuthProjections treats a whitespace apiKey as hand-named", () => {
    const overlaid = overlayOAuthProjections(
      settingsWith({
        "codex/mine": {
          baseURL: "https://hand-named.example.com/v1",
          apiKey: "   ",
          models: ["hand-model"],
        },
      }),
      liveProjected(),
    );
    expect(overlaid?.providers["codex/mine"]?.apiKey).toBe("   ");
  });

  test("overlayOAuthProjections treats an empty-string apiKey as a placeholder", () => {
    const overlaid = overlayOAuthProjections(
      settingsWith({
        "codex/mine": {
          baseURL: "https://hand-named.example.com/v1",
          apiKey: "",
          models: ["hand-model"],
        },
      }),
      liveProjected(),
    );
    expect(overlaid?.providers["codex/mine"]?.apiKey).toBe("live-token");
  });
});
