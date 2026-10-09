import { defined } from "../../testkit/defined.js";
import { describe, test, expect } from "bun:test";
import { ProtocolMismatchError } from "@intx/inference";
import { createOpenAIAdapter } from "@intx/inference/providers";
import type { ConversationTurn, InferenceOptions } from "@intx/types/runtime";
import { createOpenAICompatibleAdapter } from "./openai-compatible-adapter.js";

const source = {
  id: "test",
  provider: "openai-compatible",
  baseURL: "https://example.test",
  apiKey: "sk-test",
  model: "gpt-5.1",
} as unknown as Parameters<typeof createOpenAICompatibleAdapter>[0];

const messages: ConversationTurn[] = [
  {
    role: "user",
    content: [{ type: "text", text: "hi" }],
  } as unknown as ConversationTurn,
];

function bodyFor(options: InferenceOptions): Record<string, unknown> {
  const adapter = createOpenAICompatibleAdapter(source);
  const built = adapter.buildRequest(messages, "gpt-5.1", options);
  return JSON.parse(built.body) as Record<string, unknown>;
}

describe("openai-compatible adapter image input", () => {
  test("preserves user image blocks as OpenAI image_url content", () => {
    const adapter = createOpenAICompatibleAdapter(source);
    const turns: ConversationTurn[] = [
      {
        role: "user",
        timestamp: 0,
        content: [
          { type: "text", text: "what is this?" },
          {
            type: "image",
            source: { kind: "base64", mimeType: "image/png", data: "aW1hZ2U=" },
          },
        ],
      },
    ];
    const built = adapter.buildRequest(
      turns,
      "gpt-5.1",
      {} as InferenceOptions,
    );
    const body = JSON.parse(built.body) as { messages: { content: unknown }[] };

    expect(body.messages[0]?.content).toEqual([
      { type: "text", text: "what is this?" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,aW1hZ2U=" },
      },
    ]);
  });
});

describe("openai-compatible adapter providerOptions passthrough", () => {
  test("merges reasoning_effort from providerOptions into the request body", () => {
    const body = bodyFor({
      providerOptions: { reasoning_effort: "high" },
    } as InferenceOptions);
    expect(body["reasoning_effort"]).toBe("high");
  });

  test("merges temperature and top_p together from providerOptions", () => {
    const body = bodyFor({
      providerOptions: { temperature: 0.7, top_p: 0.9 },
    } as InferenceOptions);
    expect(body["temperature"]).toBe(0.7);
    expect(body["top_p"]).toBe(0.9);
  });

  test("leaves the body untouched when no providerOptions are present", () => {
    const body = bodyFor({} as InferenceOptions);
    expect("reasoning_effort" in body).toBe(false);
    expect(body["model"]).toBe("gpt-5.1");
  });
});

describe("openai-compatible adapter SSE parse count", () => {
  test("parses a non-DeepSeek frame with JSON.parse exactly once", () => {
    const adapter = createOpenAICompatibleAdapter(source);
    adapter.buildRequest(messages, "gpt-5.1", {} as InferenceOptions);

    const sseData = JSON.stringify({
      choices: [{ delta: { role: "assistant", content: "hi" } }],
    });
    const originalParse = JSON.parse;
    let calls = 0;
    JSON.parse = ((text: string, reviver?: unknown) => {
      calls += 1;
      return (originalParse as (t: string, r?: unknown) => unknown)(
        text,
        reviver,
      );
    }) as typeof JSON.parse;
    try {
      adapter.parseResponse(sseData);
    } finally {
      JSON.parse = originalParse;
    }

    expect(calls).toBe(1);
  });
});

describe("openai-compatible adapter null delta fields", () => {
  test.each(["role", "tool_calls"])("rejects null %s", (field) => {
    const adapter = createOpenAICompatibleAdapter(source);
    expect(() =>
      adapter.parseResponse(
        JSON.stringify({
          choices: [{ index: 0, delta: { content: "hello", [field]: null } }],
        }),
      ),
    ).toThrow(ProtocolMismatchError);
  });
});

describe("openai-compatible adapter reasoning_content handling", () => {
  const withThinking: ConversationTurn[] = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      model: "deepseek-v4",
      content: [
        { type: "thinking", thinking: "ponder" },
        { type: "text", text: "hello" },
      ],
    },
    { role: "user", content: [{ type: "text", text: "again" }] },
  ] as unknown as ConversationTurn[];

  function messagesFor(model: string): Record<string, unknown>[] {
    const adapter = createOpenAICompatibleAdapter({
      ...source,
      model,
    } as typeof source);
    const built = adapter.buildRequest(
      withThinking,
      model,
      {} as InferenceOptions,
    );
    return (JSON.parse(built.body) as { messages: Record<string, unknown>[] })
      .messages;
  }

  test("strips reasoning_content from input messages for pre-V4 DeepSeek models", () => {
    const assistant = messagesFor("deepseek-v3").find(
      (m) => m["role"] === "assistant",
    );
    expect(assistant).toBeDefined();
    expect("reasoning_content" in defined(assistant)).toBe(false);
  });

  test.each([
    "deepseek-v4",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "deepseek-v4-flash-vision-exp",
  ])("V4 keeps reasoning_content on replayed assistant turns (%s)", (model) => {
    const assistant = messagesFor(model).find((m) => m["role"] === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant?.["reasoning_content"]).toBe("ponder");
  });

  test("keeps reasoning_content for non-DeepSeek models", () => {
    const assistant = messagesFor("kimi-k2").find(
      (m) => m["role"] === "assistant",
    );
    expect(assistant?.["reasoning_content"]).toBe("ponder");
  });

  test("non-V4/non-DeepSeek models are byte-identical on reasoning_content", () => {
    for (const model of [
      "gpt-5",
      "gpt-5.1",
      "kimi-k2",
      "grok-4.6",
      "claude-sonnet-4.5",
      "glm-5.3",
      "openai-compatible-generic",
    ]) {
      const assistant = messagesFor(model).find(
        (m) => m["role"] === "assistant",
      );
      expect(assistant?.["reasoning_content"]).toBe("ponder");
    }
  });

  test("pre-V4 DeepSeek ids still strip reasoning_content (byte-identical)", () => {
    for (const model of ["deepseek-v3", "deepseek-r1"]) {
      const assistant = messagesFor(model).find(
        (m) => m["role"] === "assistant",
      );
      expect(assistant).toBeDefined();
      expect("reasoning_content" in defined(assistant)).toBe(false);
    }
  });
});

describe("openai-compatible adapter V4 effort wiring", () => {
  function bodyForModel(
    model: string,
    options: InferenceOptions,
  ): Record<string, unknown> {
    const adapter = createOpenAICompatibleAdapter({
      ...source,
      model,
    } as typeof source);
    const built = adapter.buildRequest(messages, model, options);
    return JSON.parse(built.body) as Record<string, unknown>;
  }

  test.each(["xhigh", "max"] as const)(
    "wires V4 effort %s through raw and turns thinking on",
    (effort) => {
      const body = bodyForModel("deepseek-v4-pro", {
        providerOptions: { reasoning_effort: effort },
      } as InferenceOptions);
      expect(body["reasoning_effort"]).toBe(effort);
      expect(body["chat_template_kwargs"]).toEqual({ thinking: true });
    },
  );

  describe("V4 request settings (PR4)", () => {
    test("none → chat_template_kwargs.thinking false and NO reasoning_effort", () => {
      const body = bodyForModel("deepseek-v4-pro", {
        providerOptions: { reasoning_effort: "none" },
      } as InferenceOptions);
      expect(body["chat_template_kwargs"]).toEqual({ thinking: false });
      expect("reasoning_effort" in body).toBe(false);
    });

    test("stream_options include_usage is true", () => {
      const body = bodyForModel("deepseek-v4-pro", {} as InferenceOptions);
      expect(body["stream_options"]).toEqual({ include_usage: true });
      // An unset effort must not force the encoder's thinking pass on nor
      // inject an empty chat_template_kwargs object.
      expect(body["chat_template_kwargs"]).toBeUndefined();
    });

    test("top_p 0.95 and temperature 1.0 defaulted when absent", () => {
      const body = bodyForModel("deepseek-v4-pro", {} as InferenceOptions);
      expect(body["top_p"]).toBe(0.95);
      expect(body["temperature"]).toBe(1.0);
      // An unset effort must not force the encoder's thinking pass on nor
      // inject an empty chat_template_kwargs object.
      expect(body["chat_template_kwargs"]).toBeUndefined();
    });

    test("top_p and temperature preserved when providerOptions set them", () => {
      const body = bodyForModel("deepseek-v4-pro", {
        providerOptions: { temperature: 0.7, top_p: 0.9 },
      } as InferenceOptions);
      expect(body["top_p"]).toBe(0.9);
      expect(body["temperature"]).toBe(0.7);
    });

    test("chat_template_kwargs merge preserves existing keys", () => {
      const body = bodyForModel("deepseek-v4-pro", {
        providerOptions: {
          reasoning_effort: "xhigh",
          chat_template_kwargs: { some: "existing" },
        },
      } as InferenceOptions);
      expect(body["chat_template_kwargs"]).toEqual({
        thinking: true,
        some: "existing",
      });
    });

    test("off-ladder effort is left untouched (no high→xhigh coercion)", () => {
      const body = bodyForModel("deepseek-v4-pro", {
        providerOptions: { reasoning_effort: "high" },
      } as InferenceOptions);
      expect(body["reasoning_effort"]).toBe("high");
      expect("chat_template_kwargs" in body).toBe(false);
    });

    test("none merges thinking off into, never replaces, existing kwargs", () => {
      const body = bodyForModel("deepseek-v4-pro", {
        providerOptions: {
          reasoning_effort: "none",
          chat_template_kwargs: { some: "existing" },
        },
      } as InferenceOptions);
      expect(body["chat_template_kwargs"]).toEqual({
        thinking: false,
        some: "existing",
      });
    });

    test("provider-set thinking is preserved (absent-only thinking)", () => {
      // A provider-supplied thinking value beats the V4 effort's implied one:
      // `none` normally forces thinking off, but an explicit thinking:true
      // must be kept (never force-stamped), and vice versa.
      const noneThenTrue = bodyForModel("deepseek-v4-pro", {
        providerOptions: {
          reasoning_effort: "none",
          chat_template_kwargs: { thinking: true },
        },
      } as InferenceOptions);
      expect(noneThenTrue["chat_template_kwargs"]).toEqual({ thinking: true });

      const xhighThenFalse = bodyForModel("deepseek-v4-pro", {
        providerOptions: {
          reasoning_effort: "xhigh",
          chat_template_kwargs: { thinking: false },
        },
      } as InferenceOptions);
      expect(xhighThenFalse["chat_template_kwargs"]).toEqual({
        thinking: false,
      });
    });

    test("unset effort does not inject empty chat_template_kwargs", () => {
      const body = bodyForModel("deepseek-v4-pro", {} as InferenceOptions);
      expect("chat_template_kwargs" in body).toBe(false);
      expect(body["reasoning_effort"]).toBeUndefined();
    });

    test("provider-set stream_options is preserved (absent-only)", () => {
      const body = bodyForModel("deepseek-v4-pro", {
        providerOptions: {
          stream_options: { include_usage: false },
        },
      } as InferenceOptions);
      expect(body["stream_options"]).toEqual({ include_usage: false });
    });
  });

  describe("v4-effort is no-op for non-V4", () => {
    const models = [
      "gpt-5",
      "gpt-5.1",
      "kimi-k2",
      "grok-4.6",
      "claude-sonnet-4.5",
      "glm-5.3",
      "some-openai-compatible-model",
      "deepseek-r1",
      "deepseek-v3",
    ];

    test.each(
      models.flatMap((model) =>
        (["high", "none", "max"] as const).map((effort) => [model, effort]),
      ),
    )(
      "merged body for %s with effort %s is byte-identical to a manual base+merge (V4 step no-op)",
      (model, effort) => {
        const base = bodyForModel(model, {} as InferenceOptions);
        const withEffort = bodyForModel(model, {
          providerOptions: { reasoning_effort: effort },
        } as InferenceOptions);
        // For a non-V4 model the V4 step must not run: the output body equals
        // the base body shallow-merged with providerOptions verbatim (no
        // effort mapping, no chat_template_kwargs injection) — including V4
        // ladder values like none (delete + thinking:false) and max (verbatim),
        // so a regression routing any V4 rung through the V4 branch is caught.
        const expected = {
          ...base,
          ...({ reasoning_effort: effort } as const),
        };
        expect(withEffort).toEqual(expected);
      },
    );

    test.each(models)(
      "V4 settings (top_p/temperature/stream_options/chat_template_kwargs) not injected for %s",
      (model) => {
        const body = bodyForModel(model, {} as InferenceOptions);
        // Full-body equality against the raw base OpenAI adapter output: for a
        // non-V4 model the wrapper must short-circuit the V4 step entirely, so
        // the body matches the base build byte-for-byte (a regression that
        // injects a 5th field or mutates an existing one would fail here).
        const baseAdapter = createOpenAIAdapter({
          ...source,
          model,
        } as typeof source);
        const baseBuilt = baseAdapter.buildRequest(
          messages,
          model,
          {} as InferenceOptions,
        );
        expect(body).toEqual(
          JSON.parse(baseBuilt.body) as Record<string, unknown>,
        );
      },
    );
  });
});
