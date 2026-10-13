import { describe, expect, test } from "bun:test";

import { META_BASE_URL } from "../auth/meta/constants.js";
import { assignMetaOAuthProviderRow } from "./meta-api-key.js";
import type { ProviderSettings, Settings } from "./settings.js";

function settingsWith(providers: Record<string, ProviderSettings>): Settings {
  return { providers };
}

const placeholder = (): ProviderSettings => ({
  baseURL: META_BASE_URL,
  models: ["muse-spark-1.3"],
  defaultModel: "muse-spark-1.3",
});

describe("assignMetaOAuthProviderRow", () => {
  test("moves an API key off meta/<slug> instead of clearing it", () => {
    const next = assignMetaOAuthProviderRow(
      settingsWith({
        "meta/work": {
          baseURL: META_BASE_URL,
          apiKey: "LLM|work-key",
          models: ["muse-spark-1.3"],
        },
      }),
      "meta/work",
      placeholder(),
    );
    expect(next.providers["meta/work"]?.apiKey).toBeUndefined();
    expect(next.providers["meta-api/work"]?.apiKey).toBe("LLM|work-key");
    expect(next.defaultProvider).toBe("meta/work");
  });

  test("a free OAuth slug still writes a credential-less row", () => {
    const next = assignMetaOAuthProviderRow(
      settingsWith({}),
      "meta/default",
      placeholder(),
    );
    expect(next.providers["meta/default"]).toEqual(placeholder());
    expect(next.providers["meta-api/default"]).toBeUndefined();
  });
});
