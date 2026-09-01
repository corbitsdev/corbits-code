import { describe, expect, test } from "bun:test";
import {
  FIRST_CLASS_PROVIDERS,
  connectListProviders,
  firstClassPathAsProvider,
  firstClassProviderById,
} from "./providers.js";

describe("FIRST_CLASS_PROVIDERS", () => {
  test("lists Tier A providers in product order", () => {
    expect(FIRST_CLASS_PROVIDERS.map((p) => p.id)).toEqual([
      "openai",
      "xai",
      "opencode-go",
      "zen",
      "zai",
      "anthropic",
      "google",
      "ollama",
      "custom",
    ]);
  });

  test("connectListProviders matches FIRST_CLASS_PROVIDERS", () => {
    expect(connectListProviders()).toBe(FIRST_CLASS_PROVIDERS);
  });

  test("has no separate Codex connect row", () => {
    expect(FIRST_CLASS_PROVIDERS.some((p) => p.id === "codex")).toBe(false);
    expect(FIRST_CLASS_PROVIDERS.map((p) => p.label)).not.toContain("OpenAI Codex");
  });

  test("Custom is last and uses custom auth", () => {
    const last = FIRST_CLASS_PROVIDERS[FIRST_CLASS_PROVIDERS.length - 1];
    expect(last?.id).toBe("custom");
    expect(last?.auth).toBe("custom");
  });

  test("OpenAI is a chooser with ChatGPT oauth and API key paths", () => {
    const openai = firstClassProviderById("openai");
    expect(openai?.auth).toBe("chooser");
    expect(openai?.paths?.map((p) => p.id)).toEqual(["chatgpt", "api"]);

    const chatgpt = openai?.paths?.find((p) => p.id === "chatgpt");
    expect(chatgpt?.auth).toBe("oauth");
    expect(chatgpt?.oauth).toBe("codex");
    expect(chatgpt?.providerId).toBe("codex");

    const api = openai?.paths?.find((p) => p.id === "api");
    expect(api?.auth).toBe("api-key");
    expect(api?.providerId).toBe("openai");
    expect(api?.baseURL).toBe("https://api.openai.com/v1");
    expect((api?.models ?? []).length).toBeGreaterThan(0);
    expect(api?.models).toContain(api?.defaultModel);
  });

  test("xAI is OAuth; Go/Zen/Z.AI/Anthropic/Google are API key", () => {
    expect(firstClassProviderById("xai")?.auth).toBe("oauth");
    expect(firstClassProviderById("xai")?.oauth).toBe("xai");
    for (const id of ["opencode-go", "zen", "zai", "anthropic", "google"] as const) {
      expect(firstClassProviderById(id)?.auth).toBe("api-key");
    }
  });

  test("API-key providers ship baseURL, models, and defaultModel", () => {
    for (const def of FIRST_CLASS_PROVIDERS) {
      if (def.auth !== "api-key") continue;
      expect(def.baseURL?.length ?? 0).toBeGreaterThan(0);
      expect((def.models ?? []).length).toBeGreaterThan(0);
      expect(def.defaultModel?.length ?? 0).toBeGreaterThan(0);
      expect(def.models).toContain(def.defaultModel);
    }
  });

  test("Ollama is explicitly keyless and ships its root URL with no static model fallback", () => {
    const ollama = firstClassProviderById("ollama");
    expect(ollama?.auth).toBe("keyless");
    expect(ollama?.baseURL).toBe("http://localhost:11434");
    expect(ollama?.models).toEqual([]);
  });

  test("Z.AI Coding Plan uses coding paas base URL", () => {
    const zai = firstClassProviderById("zai");
    expect(zai?.label).toBe("Z.AI Coding Plan");
    expect(zai?.baseURL).toBe("https://api.z.ai/api/coding/paas/v4");
    expect(zai?.defaultModel).toBe("glm-5.2");
    expect(zai?.models).toContain("glm-5.2");
  });

  test("OpenCode Go is flagged with subscription billing", () => {
    const go = firstClassProviderById("opencode-go");
    expect(go?.opencodeGo).toBe(true);
    expect(go?.billingProduct).toBe("subscription");
    expect(go?.authHint?.toLowerCase()).toContain("subscription");
    expect(go?.authHint).toContain("https://opencode.ai/auth");
  });

  test("OpenCode Zen uses credits billing and auth page hint", () => {
    const zen = firstClassProviderById("zen");
    expect(zen?.billingProduct).toBe("credits");
    expect(zen?.authHint?.toLowerCase()).toMatch(/credit|pay-as-you-go/);
    expect(zen?.authHint).toContain("https://opencode.ai/auth");
  });

  test("Anthropic is flagged for messages adapter", () => {
    expect(firstClassProviderById("anthropic")?.anthropic).toBe(true);
  });

  test("firstClassPathAsProvider seeds OpenAI API path", () => {
    const openai = firstClassProviderById("openai");
    if (openai === undefined) throw new Error("openai missing");
    const seeded = firstClassPathAsProvider(openai, "api");
    expect(seeded?.id).toBe("openai");
    expect(seeded?.auth).toBe("api-key");
    expect(seeded?.baseURL).toBe("https://api.openai.com/v1");
    expect(firstClassPathAsProvider(openai, "chatgpt")).toBeUndefined();
  });
});
