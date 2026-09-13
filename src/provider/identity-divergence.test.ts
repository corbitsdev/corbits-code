import { beforeEach, describe, expect, test } from "bun:test";
import { XAI_OAUTH_PROXY_BASE_URL } from "@corbits/xai-provider";
import {
  FIRST_CLASS_PROVIDERS,
  OPENAI_API_MAX_COMPLETION_TOKENS_MODELS,
  firstClassProviderById,
} from "../../packages/first-class-providers/src/index.js";
import {
  OPENCODE_GO_DEFAULT_MODEL,
  OPENCODE_GO_MODEL_IDS,
  isKnownGoModel,
} from "../../packages/opencode-go/src/index.js";
import {
  ZEN_DEFAULT_MODEL,
  ZEN_MODEL_IDS,
  isKnownZenModel,
} from "../../packages/zen/src/index.js";
import {
  CODEX_BASE_URL,
  CODEX_DEFAULT_MODELS,
} from "../auth/codex/constants.js";
import type { CodexProfile } from "../auth/codex/store.js";
import type { XaiProfile } from "../auth/xai/store.js";
import { XAI_BASE_URL, XAI_DEFAULT_MODELS } from "../auth/xai/constants.js";
import {
  codexProfilesToCatalogEntries,
  codexProviderName,
} from "../config/codex-providers.js";
import {
  xaiProfilesToCatalogEntries,
  xaiProviderName,
} from "../config/xai-providers.js";
import { OAUTH_SURFACES } from "../tui/provider/choices.js";
import {
  resetGoModelDiscoveryForTests,
  selectableGoModelIds,
} from "./opencode-go-models.js";
import {
  resetZenModelDiscoveryForTests,
  selectableZenModelIds,
} from "./zen-models.js";

// CL-5691: provider/model identity unification. FIRST_CLASS_PROVIDERS is the
// canonical static registry; the Codex/xAI live-fetch fallbacks stay separate
// (they back live calls) but every auth path serving the same provider must
// agree on identity metadata. These tests fail loudly on drift instead of
// letting another list quietly diverge.
describe("provider identity divergence", () => {
  beforeEach(() => {
    resetZenModelDiscoveryForTests();
    resetGoModelDiscoveryForTests();
  });

  test("OpenAI API-key default and ChatGPT-OAuth fallback default agree", () => {
    const apiPath = firstClassProviderById("openai")?.paths?.find(
      (p) => p.id === "api",
    );
    if (apiPath?.defaultModel === undefined)
      throw new Error("Expected the OpenAI API path to declare a defaultModel");
    // Both auth paths serve OpenAI models, so the shared model must lead both
    // lists — the fallback default is models[0] by construction.
    const codexFallbacks: readonly string[] = CODEX_DEFAULT_MODELS;
    const codexDefault: string | undefined = codexFallbacks[0];
    expect(codexDefault).toBe(apiPath.defaultModel);
    expect(codexFallbacks).toContain(apiPath.defaultModel);
  });

  test("OpenAI API-key entry is self-consistent", () => {
    const apiPath = firstClassProviderById("openai")?.paths?.find(
      (p) => p.id === "api",
    );
    expect(apiPath?.models).toContain(apiPath?.defaultModel);
    for (const model of apiPath?.maxCompletionTokensModels ?? []) {
      expect(apiPath?.models).toContain(model);
    }
    // The quirks reader resolves through the registry entry, so the exported
    // list must stay identical to it — never a second copy.
    expect([...OPENAI_API_MAX_COMPLETION_TOKENS_MODELS]).toEqual([
      ...(apiPath?.maxCompletionTokensModels ?? []),
    ]);
  });

  test("every first-class api-key default is a member of its models", () => {
    for (const def of FIRST_CLASS_PROVIDERS) {
      // Keyless entries (e.g. Ollama) carry an empty default and no models.
      if (def.defaultModel === undefined || def.defaultModel === "") continue;
      expect(def.models ?? []).toContain(def.defaultModel);
    }
  });

  test("Codex OAuth projection and surfaces track the live-fetch fallback", () => {
    expect(OAUTH_SURFACES.codex.baseURL).toBe(CODEX_BASE_URL);
    expect([...OAUTH_SURFACES.codex.models]).toEqual([...CODEX_DEFAULT_MODELS]);
    expect(OAUTH_SURFACES.codex.providerName("probe")).toBe(
      codexProviderName("probe"),
    );
    const profile = {
      name: "probe",
      tokens: { access: "probe", refresh: "probe", expiresAt: 0 },
    } as CodexProfile;
    const [entry] = codexProfilesToCatalogEntries([profile]);
    expect(entry?.baseURL).toBe(CODEX_BASE_URL);
    expect(entry?.models).toEqual([...CODEX_DEFAULT_MODELS]);
    expect(entry?.defaultModel).toBe(CODEX_DEFAULT_MODELS[0]);
  });

  test("xAI OAuth projection and surfaces track the vendor fallback", () => {
    expect(XAI_BASE_URL).toBe(XAI_OAUTH_PROXY_BASE_URL);
    expect(OAUTH_SURFACES.xai.baseURL).toBe(XAI_OAUTH_PROXY_BASE_URL);
    expect([...OAUTH_SURFACES.xai.models]).toEqual([...XAI_DEFAULT_MODELS]);
    expect(OAUTH_SURFACES.xai.providerName("probe")).toBe(
      xaiProviderName("probe"),
    );
    const profile = {
      name: "probe",
      tokens: { access: "probe", refresh: "probe", expiresAt: 0 },
    } as XaiProfile;
    const [entry] = xaiProfilesToCatalogEntries([profile]);
    expect(entry?.baseURL).toBe(XAI_OAUTH_PROXY_BASE_URL);
    expect(entry?.models).toEqual([...XAI_DEFAULT_MODELS]);
    expect(entry?.defaultModel).toBe(XAI_DEFAULT_MODELS[0]);
  });

  test("Zen registry entry tracks the packaged seed catalog", () => {
    const zen = firstClassProviderById("zen");
    expect([...(zen?.models ?? [])]).toEqual([...ZEN_MODEL_IDS]);
    expect(zen?.defaultModel).toBe(ZEN_DEFAULT_MODEL);
    expect(ZEN_MODEL_IDS).toContain(ZEN_DEFAULT_MODEL);
    // Cold picker (no live snapshot yet) falls back to the same seed.
    expect([...selectableZenModelIds()]).toEqual([...ZEN_MODEL_IDS]);
    for (const id of ZEN_MODEL_IDS) {
      expect(isKnownZenModel(id)).toBe(true);
    }
  });

  test("OpenCode Go registry entry tracks the packaged seed catalog", () => {
    const go = firstClassProviderById("opencode-go");
    expect([...(go?.models ?? [])]).toEqual([...OPENCODE_GO_MODEL_IDS]);
    expect(go?.defaultModel).toBe(OPENCODE_GO_DEFAULT_MODEL);
    expect(OPENCODE_GO_MODEL_IDS).toContain(OPENCODE_GO_DEFAULT_MODEL);
    expect([...selectableGoModelIds()]).toEqual([...OPENCODE_GO_MODEL_IDS]);
    for (const id of OPENCODE_GO_MODEL_IDS) {
      expect(isKnownGoModel(id)).toBe(true);
    }
  });
});
