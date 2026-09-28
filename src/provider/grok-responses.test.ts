import { describe, expect, test } from "bun:test";
import { BEARER_CREDENTIAL_SENTINEL } from "@intx/inference";
import type {
  ConversationTurn,
  InferenceOptions,
  LastCycleSource,
} from "@intx/types/runtime";
import {
  createGrokResponsesAdapter,
  GROK_SESSION_ID_OPTION,
  GROK_USER_ID_OPTION,
} from "./grok-responses.js";

const source: LastCycleSource = {
  sourceId: "xai/test",
  provider: "grok-responses",
  model: "grok-4.5",
};

describe("createGrokResponsesAdapter", () => {
  test("sends user image blocks as Responses input_image parts", () => {
    const adapter = createGrokResponsesAdapter(source);
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

    const request = adapter.buildRequest(turns, "grok-4.5", {});
    const body = JSON.parse(request.body) as {
      input: { type: string; role?: string; content?: unknown }[];
    };

    expect(body.input).toHaveLength(1);
    expect(body.input[0]).toEqual({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "what is this?" },
        { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" },
      ],
    });
  });

  test("keeps text-only messages in the string content shape", () => {
    const adapter = createGrokResponsesAdapter(source);
    const turns: ConversationTurn[] = [
      {
        role: "user",
        timestamp: 0,
        content: [{ type: "text", text: "hello" }],
      },
    ];

    const request = adapter.buildRequest(turns, "grok-4.5", {});
    const body = JSON.parse(request.body) as { input: { content?: unknown }[] };

    expect(body.input[0]?.content).toBe("hello");
  });

  test("requests detailed reasoning summaries so thinking activity streams", () => {
    const adapter = createGrokResponsesAdapter(source);
    const turns: ConversationTurn[] = [
      {
        role: "user",
        timestamp: 0,
        content: [{ type: "text", text: "hello" }],
      },
    ];

    const request = adapter.buildRequest(turns, "grok-4.6", {});
    const body = JSON.parse(request.body) as {
      reasoning?: { summary?: string };
      include?: string[];
      store?: boolean;
      stream?: boolean;
    };

    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(body.reasoning).toEqual({ summary: "detailed" });
  });

  test("forwards providerOptions.reasoning_effort onto reasoning.effort", () => {
    const adapter = createGrokResponsesAdapter(source);
    const turns: ConversationTurn[] = [
      {
        role: "user",
        timestamp: 0,
        content: [{ type: "text", text: "hello" }],
      },
    ];

    const request = adapter.buildRequest(turns, "grok-4.6", {
      providerOptions: { reasoning_effort: "low" },
    });
    const body = JSON.parse(request.body) as {
      reasoning?: { effort?: string; summary?: string };
    };

    expect(body.reasoning).toEqual({ effort: "low", summary: "detailed" });
  });

  test("keeps the latest function_call_output on a duplicate call_id", () => {
    const adapter = createGrokResponsesAdapter(source);
    const turns: ConversationTurn[] = [
      {
        role: "user",
        timestamp: 0,
        content: [
          {
            type: "tool_result",
            callId: "call_1",
            content: [{ type: "text", text: "stale" }],
          },
          {
            type: "tool_result",
            callId: "call_1",
            content: [{ type: "text", text: "fresh" }],
          },
        ],
      },
    ] as unknown as ConversationTurn[];

    const request = adapter.buildRequest(turns, "grok-4.5", {});
    const body = JSON.parse(request.body) as {
      input: { type: string; call_id?: string; output?: string }[];
    };
    const outputs = body.input.filter(
      (item) => item.type === "function_call_output",
    );

    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.output).toBe("fresh");
  });

  test("dedupes a duplicate function_call on the same call_id", () => {
    const adapter = createGrokResponsesAdapter(source);
    const turns: ConversationTurn[] = [
      {
        role: "assistant",
        timestamp: 0,
        content: [
          {
            type: "tool_call",
            id: "call_1",
            name: "shell",
            arguments: { a: 1 },
          },
          {
            type: "tool_call",
            id: "call_1",
            name: "shell",
            arguments: { a: 2 },
          },
        ],
      },
    ] as unknown as ConversationTurn[];

    const request = adapter.buildRequest(turns, "grok-4.5", {});
    const body = JSON.parse(request.body) as {
      input: { type: string; call_id?: string; arguments?: string }[];
    };
    const calls = body.input.filter((item) => item.type === "function_call");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.arguments).toBe(JSON.stringify({ a: 2 }));
  });

  test("does not invent high when no reasoning_effort is set", () => {
    const adapter = createGrokResponsesAdapter(source);
    const turns: ConversationTurn[] = [
      {
        role: "user",
        timestamp: 0,
        content: [{ type: "text", text: "hello" }],
      },
    ];

    const request = adapter.buildRequest(turns, "grok-4.6", {});
    const body = JSON.parse(request.body) as {
      reasoning?: { effort?: string; summary?: string };
    };

    expect(body.reasoning).toEqual({ summary: "detailed" });
    expect(body.reasoning?.effort).toBeUndefined();
  });

  test("extracts Retry-After pacing from response headers", () => {
    const adapter = createGrokResponsesAdapter(source);
    expect(
      adapter.extractRetryAfterMs?.(new Headers({ "retry-after": "7" })),
    ).toBe(7_000);
    expect(
      adapter.extractRetryAfterMs?.(new Headers({ "retry-after-ms": "1500" })),
    ).toBe(1_500);
    expect(adapter.extractRetryAfterMs?.(new Headers({}))).toBeUndefined();
  });

  test("treats Responses completed, incomplete, and done events as stream-terminal", () => {
    const adapter = createGrokResponsesAdapter(source);
    const isStreamTerminal = adapter.isStreamTerminal;
    expect(typeof isStreamTerminal).toBe("function");
    if (typeof isStreamTerminal !== "function") {
      throw new Error("expected isStreamTerminal to be a function");
    }
    for (const type of [
      "response.completed",
      "response.incomplete",
      "response.done",
    ]) {
      expect(isStreamTerminal(JSON.stringify({ type }))).toBe(true);
    }
    for (const type of [
      "response.output_text.delta",
      "response.created",
      "response.in_progress",
    ]) {
      expect(isStreamTerminal(JSON.stringify({ type }))).toBe(false);
    }
    expect(isStreamTerminal("{not json")).toBe(false);
    expect(isStreamTerminal("null")).toBe(false);
    expect(isStreamTerminal('"just a string"')).toBe(false);
  });
});

describe("grok-responses buildRequest", () => {
  const baseOptions: InferenceOptions = {
    providerOptions: { [GROK_USER_ID_OPTION]: "user-123" },
  };

  const userTurn = (text: string): ConversationTurn => ({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 0,
  });

  const adapter = () => createGrokResponsesAdapter(source);

  test("targets the Responses path with the grok-cli client headers", () => {
    const req = adapter().buildRequest(
      [userTurn("hi")],
      "grok-4.5",
      baseOptions,
    );
    expect(req.url).toBe("/responses");
    expect(req.headers["authorization"]).toBe(BEARER_CREDENTIAL_SENTINEL);
    expect(req.headers["x-grok-client-identifier"]).toBe("grok-shell");
    expect(req.headers["x-grok-client-version"]).toBe("0.2.93");
    expect(req.headers["x-grok-model-override"]).toBe("grok-4.5");
    expect(req.headers["x-grok-user-id"]).toBe("user-123");
    expect(req.headers["accept"]).toBe("text/event-stream");
  });

  test("builds a Responses body with string-content input, store off, reasoning summary", () => {
    const req = adapter().buildRequest([userTurn("hello")], "grok-4.5", {
      ...baseOptions,
      systemPrompt: "You are a coding agent.",
    });
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body["model"]).toBe("grok-4.5");
    expect(body["stream"]).toBe(true);
    expect(body["store"]).toBe(false);
    expect(body["include"]).toEqual(["reasoning.encrypted_content"]);
    expect(body["reasoning"]).toEqual({ summary: "detailed" });
    // No `instructions` field — the system prompt rides as a system input message.
    expect(body["instructions"]).toBeUndefined();
    const input = body["input"] as Record<string, unknown>[];
    expect(input[0]).toEqual({
      type: "message",
      role: "system",
      content: "You are a coding agent.",
    });
    expect(input[1]).toEqual({
      type: "message",
      role: "user",
      content: "hello",
    });
  });

  test("maps tool calls and results to function_call items with flat tools", () => {
    const turns: ConversationTurn[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call-1",
            name: "read_file",
            arguments: { path: "a.ts" },
          },
        ],
        timestamp: 0,
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            callId: "call-1",
            content: [{ type: "text", text: "ok" }],
          },
        ],
        timestamp: 0,
      },
    ];
    const req = adapter().buildRequest(turns, "grok-4.5", {
      ...baseOptions,
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
      ],
    });
    const body = JSON.parse(req.body) as Record<string, unknown>;
    const input = body["input"] as Record<string, unknown>[];
    expect(input[0]).toEqual({
      type: "function_call",
      name: "read_file",
      arguments: JSON.stringify({ path: "a.ts" }),
      call_id: "call-1",
    });
    expect(input[1]).toEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: "ok",
    });
    const tools = body["tools"] as Record<string, unknown>[];
    expect(tools[0]).toMatchObject({ type: "function", name: "read_file" });
    expect(body["tool_choice"]).toBe("auto");
  });

  test("sets prompt_cache_key from the session id, stable across builds", () => {
    const options: InferenceOptions = {
      ...baseOptions,
      providerOptions: {
        ...baseOptions.providerOptions,
        [GROK_SESSION_ID_OPTION]: "sess-1",
      },
    };
    const first = JSON.parse(
      adapter().buildRequest([userTurn("a")], "grok-4.5", options).body,
    ) as Record<string, unknown>;
    const second = JSON.parse(
      adapter().buildRequest([userTurn("b")], "grok-4.5", options).body,
    ) as Record<string, unknown>;
    expect(first["prompt_cache_key"]).toBe("sess-1");
    expect(second["prompt_cache_key"]).toBe("sess-1");
  });

  test("omits prompt_cache_key when no session id is present", () => {
    const body = JSON.parse(
      adapter().buildRequest([userTurn("hi")], "grok-4.5", baseOptions).body,
    ) as Record<string, unknown>;
    expect(body).not.toHaveProperty("prompt_cache_key");
  });
});
