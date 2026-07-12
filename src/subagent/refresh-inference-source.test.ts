import { describe, expect, test } from "bun:test";

import type { InferenceSource } from "@intx/types/runtime";

import { ensureFreshInferenceSource, refreshInferenceSourceBundle } from "./refresh-inference-source.js";

const baseSource = (id: string, apiKey = "stale"): InferenceSource => ({
  id,
  provider: "openai",
  baseURL: "https://api.openai.com/v1",
  apiKey,
  model: "gpt-4o",
});

describe("refresh-inference-source", () => {
  test("refreshInferenceSourceBundle refreshes each leg", async () => {
    const bundle = await refreshInferenceSourceBundle(
      [baseSource("openai"), baseSource("other")],
      "openai",
      [],
    );
    expect(bundle.sources).toHaveLength(2);
    expect(bundle.defaultSource).toBe("openai");
  });

  test("ensureFreshInferenceSource leaves non-OAuth sources unchanged", async () => {
    const source = baseSource("custom-gateway", "key-abc");
    const out = await ensureFreshInferenceSource(source, [
      { name: "custom-gateway", baseURL: "https://example.com/v1", models: ["gpt-4o"], apiKey: "key-abc" },
    ]);
    expect(out.apiKey).toBe("key-abc");
  });
});