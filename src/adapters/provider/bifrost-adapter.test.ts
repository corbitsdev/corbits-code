import { describe, test, expect } from "bun:test";
import { CREDENTIAL_SENTINEL } from "@intx/inference";
import type { ConversationTurn, InferenceOptions } from "@intx/types/runtime";
import { createBifrostAdapter } from "./bifrost-adapter.js";

const source = {
  id: "test",
  provider: "bifrost",
  baseURL: "https://gateway.test",
  apiKey: "vk-test",
  model: "gpt-5.1",
} as unknown as Parameters<typeof createBifrostAdapter>[0];

const messages: ConversationTurn[] = [
  { role: "user", content: [{ type: "text", text: "hi" }] } as unknown as ConversationTurn,
];

function requestFor(options: InferenceOptions) {
  const adapter = createBifrostAdapter(source);
  return adapter.buildRequest(messages, "gpt-5.1", options);
}

describe("bifrost adapter", () => {
  test("sends Accept: text/event-stream so the gateway does not reject the stream with 426", () => {
    const built = requestFor({} as InferenceOptions);
    const accept = built.headers.Accept ?? built.headers.accept;
    expect(accept).toBe("text/event-stream");
  });

  test("injects the x-bf-vk virtual-key sentinel", () => {
    const built = requestFor({} as InferenceOptions);
    expect(built.headers["x-bf-vk"]).toBe(CREDENTIAL_SENTINEL);
  });

  test("merges providerOptions into the request body", () => {
    const built = requestFor({ providerOptions: { reasoning_effort: "high" } } as InferenceOptions);
    const body = JSON.parse(built.body) as Record<string, unknown>;
    expect(body["reasoning_effort"]).toBe("high");
  });
});
