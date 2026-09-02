import { describe, expect, test } from "bun:test";
import { ProtocolMismatchError } from "@intx/inference";
import type { InferenceOptions } from "@intx/types/runtime";
import { OPENCODE_GO_PROVIDER_ID } from "../../packages/opencode-go/src/index.js";
import { createInferenceDependencies } from "./inference-dependencies.js";
import { createOpenCodeGoAdapter } from "./opencode-go-adapter.js";

const source = {
  sourceId: OPENCODE_GO_PROVIDER_ID,
  provider: OPENCODE_GO_PROVIDER_ID,
  model: "corbits",
};

describe("OpenCode Go adapter", () => {
  test("normalizes null role and tool_calls through the runtime registry", async () => {
    const deps = await createInferenceDependencies();
    const adapter = deps.adapters.resolve(source);
    const chunk = JSON.stringify({
      choices: [{ index: 0, delta: { content: "hello", role: null, tool_calls: null } }],
    });

    expect(adapter.parseResponse(chunk)).toContainEqual({
      type: "inference.text.delta",
      seq: 0,
      data: { token: "hello", partial: { text: "" }, index: 0 },
    });
  });

  test("keeps malformed non-null roles strict", () => {
    const adapter = createOpenCodeGoAdapter(source);
    const malformedChunk = JSON.stringify({
      choices: [{ index: 0, delta: { content: "hello", role: 42 } }],
    });

    expect(() => adapter.parseResponse(malformedChunk)).toThrow(ProtocolMismatchError);
  });

  test("keeps malformed non-null tool_calls strict", () => {
    const adapter = createOpenCodeGoAdapter(source);
    const malformedChunk = JSON.stringify({
      choices: [{ index: 0, delta: { content: "hello", tool_calls: "invalid" } }],
    });

    expect(() => adapter.parseResponse(malformedChunk)).toThrow(ProtocolMismatchError);
  });

  test("delegates request construction to the OpenAI-compatible adapter", () => {
    const adapter = createOpenCodeGoAdapter(source);
    const request = adapter.buildRequest(
      [{ role: "user", timestamp: 0, content: [{ type: "text", text: "hi" }] }],
      "corbits",
      { providerOptions: { reasoning_effort: "high" } } as InferenceOptions,
    );

    expect(JSON.parse(request.body)).toMatchObject({
      model: "corbits",
      reasoning_effort: "high",
      stream: true,
    });
  });
});
