import { describe, expect, test } from "bun:test";
import type { LastCycleSource } from "@intx/types/runtime";
import { createGoogleGenAIAdapter } from "./google-genai";

const TEST_SOURCE: LastCycleSource = {
  sourceId: "test-google-genai",
  provider: "google-genai",
  model: "test-gemini-model",
};

describe("google-genai adapter — finishReason forwarding (CL-7783)", () => {
  test("terminal finishReason surfaces on the usage event", () => {
    const adapter = createGoogleGenAIAdapter(TEST_SOURCE);
    const events = adapter.parseResponse(
      JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: "partial" }], role: "model" },
            finishReason: "MAX_TOKENS",
            index: 0,
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
      }),
    );
    const usage = events.filter((e) => e.type === "inference.usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]?.data.stopReason).toBe("MAX_TOKENS");
  });

  test("non-terminal event without finishReason emits no usage", () => {
    const adapter = createGoogleGenAIAdapter(TEST_SOURCE);
    const events = adapter.parseResponse(
      JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: "partial" }], role: "model" },
            index: 0,
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
      }),
    );
    expect(events.some((e) => e.type === "inference.usage")).toBe(false);
  });
});
