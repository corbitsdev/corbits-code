import { describe, expect, mock, test } from "bun:test";

import type { InferenceSource } from "@intx/types/runtime";

const baseSource = (id: string, apiKey = "stale"): InferenceSource => ({
  id,
  provider: "openai",
  baseURL: "https://api.openai.com/v1",
  apiKey,
  model: "gpt-4o",
});

describe("refresh-inference-source", () => {
  test("ensureFreshInferenceSource replaces stale Codex apiKey after refresh", async () => {
    mock.module("../auth/codex/session.js", () => ({
      getValidCodexToken: mock(async () => ({ access: "fresh-codex-token" })),
    }));
    mock.module("../auth/xai/session.js", () => ({
      getValidXaiToken: mock(async () => ({ access: "fresh-xai-token" })),
    }));
    const { ensureFreshInferenceSource } = await import("./refresh-inference-source.js");
    const source = baseSource("codex/default", "stale");
    const out = await ensureFreshInferenceSource(source, []);
    expect(out.apiKey).toBe("fresh-codex-token");
  });

  test("refreshInferenceSourceBundle refreshes each leg", async () => {
    const { refreshInferenceSourceBundle } = await import("./refresh-inference-source.js");
    const bundle = await refreshInferenceSourceBundle(
      [baseSource("openai"), baseSource("other")],
      "openai",
      [],
    );
    expect(bundle.sources).toHaveLength(2);
    expect(bundle.defaultSource).toBe("openai");
  });

  test("ensureFreshInferenceSource leaves non-OAuth sources unchanged", async () => {
    const { ensureFreshInferenceSource } = await import("./refresh-inference-source.js");
    const source = baseSource("custom-gateway", "key-abc");
    const out = await ensureFreshInferenceSource(source, [
      { name: "custom-gateway", baseURL: "https://example.com/v1", models: ["gpt-4o"], apiKey: "key-abc" },
    ]);
    expect(out.apiKey).toBe("key-abc");
  });
});