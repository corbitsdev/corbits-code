// Regression coverage for the locally patched OpenAI delta schema (see
// vendor/intx-inference/PATCHES.md#providers-ts-openai-null-delta-tolerance).
// vLLM serializers behind OpenAI-compatible relays emit `"role": null` on
// streamed deltas and `"tool_calls": null` on non-tool chunks; the patch
// tolerates them (null ≡ absent) while wrong types stay rejected.
import { describe, expect, test } from "bun:test";
import { ProtocolMismatchError } from "@intx/inference";
import { createOpenAIAdapter } from "@intx/inference/providers";
import type { LastCycleSource } from "@intx/types/runtime";
import { createOpenAICompatibleAdapter } from "./openai-compatible-adapter.js";
import { defined } from "../../testkit/defined.js";

const source: LastCycleSource = {
  sourceId: "null-delta-test",
  provider: "openai-compatible",
  model: "null-delta-fixture",
};

const builtin = createOpenAIAdapter(source);

describe("chat completions null delta tolerance", () => {
  test("(a) null role is equivalent to an absent role", () => {
    const withNull = builtin.parseResponse(
      JSON.stringify({
        choices: [{ index: 0, delta: { role: null, content: "hi" } }],
      }),
    );
    const absent = builtin.parseResponse(
      JSON.stringify({ choices: [{ index: 0, delta: { content: "hi" } }] }),
    );
    expect(withNull).toEqual(absent);
    const textDelta = withNull.find(
      (event) => event.type === "inference.text.delta",
    );
    expect(
      (textDelta as unknown as { data: Record<string, unknown> } | undefined)
        ?.data,
    ).toEqual({
      token: "hi",
      partial: { text: "" },
      index: 0,
    });
  });

  test("(b) tool_calls null and empty array are equivalent to absent", () => {
    const frames = [{ tool_calls: null }, { tool_calls: [] }, {}] as const;
    const shapes = frames.map((delta) =>
      builtin.parseResponse(JSON.stringify({ choices: [{ index: 0, delta }] })),
    );
    expect(shapes[0]).toEqual(shapes[2]);
    expect(shapes[1]).toEqual(shapes[2]);
    expect(shapes[2]).toEqual([]);
  });

  test("(c) wrong-type role still throws ProtocolMismatchError", () => {
    expect(() =>
      builtin.parseResponse(
        JSON.stringify({ choices: [{ index: 0, delta: { role: 42 } }] }),
      ),
    ).toThrow(ProtocolMismatchError);
  });

  test("(c) wrong-type tool_calls still throws ProtocolMismatchError", () => {
    for (const tool_calls of [42, "nope"]) {
      expect(() =>
        builtin.parseResponse(
          JSON.stringify({ choices: [{ index: 0, delta: { tool_calls } }] }),
        ),
      ).toThrow(ProtocolMismatchError);
    }
  });

  test("(d) incident-shape first chunk with null role and tool_calls parses", () => {
    const events = builtin
      .parseResponse(
        JSON.stringify({
          choices: [
            {
              index: 0,
              delta: { role: null, tool_calls: null, content: "hello" },
            },
          ],
        }),
      )
      .concat(
        builtin.parseResponse(
          JSON.stringify({
            choices: [
              {
                index: 0,
                delta: { role: null, tool_calls: null, content: " world" },
              },
            ],
          }),
        ),
      );
    const textDeltas = events.filter(
      (event) => event.type === "inference.text.delta",
    );
    expect(
      textDeltas.map((event) => {
        const { token, index, partial } = event.data as unknown as {
          token: string;
          index: number;
          partial: { text: string };
        };
        return { token, index, partial };
      }),
    ).toEqual([
      { token: "hello", partial: { text: "" }, index: 0 },
      { token: " world", partial: { text: "" }, index: 0 },
    ]);
  });

  test("(e1) non-streaming null role is equivalent to absent role", () => {
    const wireUsage = {
      prompt_tokens: 10,
      completion_tokens: 5,
    };
    const withNull = defined(builtin.parseJSONResponse)(
      JSON.stringify({
        object: "chat.completion",
        choices: [{ message: { role: null, content: "done" } }],
        usage: wireUsage,
      }),
    );
    const absent = defined(builtin.parseJSONResponse)(
      JSON.stringify({
        object: "chat.completion",
        choices: [{ message: { content: "done" } }],
        usage: wireUsage,
      }),
    );
    expect(withNull).toEqual(absent);
    expect(
      withNull.some((event) => event.type === "inference.text.delta"),
    ).toBe(true);
    expect(withNull.some((event) => event.type === "inference.usage")).toBe(
      true,
    );
  });

  test("(e2) non-streaming null tool_calls is equivalent to absent tool_calls", () => {
    const wireUsage = {
      prompt_tokens: 10,
      completion_tokens: 5,
    };
    const withNull = defined(builtin.parseJSONResponse)(
      JSON.stringify({
        object: "chat.completion",
        choices: [
          { message: { role: null, tool_calls: null, content: "done" } },
        ],
        usage: wireUsage,
      }),
    );
    const absent = defined(builtin.parseJSONResponse)(
      JSON.stringify({
        object: "chat.completion",
        choices: [{ message: { content: "done" } }],
        usage: wireUsage,
      }),
    );
    expect(withNull).toEqual(absent);
  });

  test("(e3) non-streaming wrong-type role still throws ProtocolMismatchError", () => {
    expect(() =>
      defined(builtin.parseJSONResponse)(
        JSON.stringify({
          object: "chat.completion",
          choices: [{ message: { role: 42, content: "done" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      ),
    ).toThrow(ProtocolMismatchError);
  });
});

describe("openai-compatible adapter null delta wiring parity", () => {
  const wrapperSource = {
    id: "test",
    provider: "openai-compatible",
    baseURL: "https://example.test",
    apiKey: "sk-test",
    model: "gpt-5.1",
  } as unknown as Parameters<typeof createOpenAICompatibleAdapter>[0];

  test("(a) null role is equivalent to an absent role", () => {
    const adapter = createOpenAICompatibleAdapter(wrapperSource);
    expect(
      adapter.parseResponse(
        JSON.stringify({
          choices: [{ index: 0, delta: { role: null, content: "hi" } }],
        }),
      ),
    ).toEqual(
      adapter.parseResponse(
        JSON.stringify({ choices: [{ index: 0, delta: { content: "hi" } }] }),
      ),
    );
  });

  test("(b) tool_calls null is equivalent to absent", () => {
    const adapter = createOpenAICompatibleAdapter(wrapperSource);
    expect(
      adapter.parseResponse(
        JSON.stringify({
          choices: [{ index: 0, delta: { tool_calls: null } }],
        }),
      ),
    ).toEqual(
      adapter.parseResponse(
        JSON.stringify({ choices: [{ index: 0, delta: {} }] }),
      ),
    );
  });

  test("(c) wrong-type role still throws ProtocolMismatchError", () => {
    const adapter = createOpenAICompatibleAdapter(wrapperSource);
    expect(() =>
      adapter.parseResponse(
        JSON.stringify({ choices: [{ index: 0, delta: { role: 42 } }] }),
      ),
    ).toThrow(ProtocolMismatchError);
  });
});
