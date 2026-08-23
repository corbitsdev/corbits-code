import { test, expect, describe } from "bun:test";
import {
  createGrokResponsesAdapter,
  GROK_SESSION_ID_OPTION,
  GROK_USER_ID_OPTION,
} from "../../src/provider/grok-responses-adapter.js";
import { BEARER_CREDENTIAL_SENTINEL } from "@intx/inference";
import type { ConversationTurn, InferenceOptions, LastCycleSource } from "@intx/types/runtime";

const SOURCE: LastCycleSource = {
  sourceId: "xai/default",
  provider: "grok-responses",
  model: "grok-4.5",
};

function adapter() {
  return createGrokResponsesAdapter(SOURCE);
}

function userTurn(text: string): ConversationTurn {
  return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

describe("grok-responses buildRequest", () => {
  const baseOptions: InferenceOptions = {
    providerOptions: { [GROK_USER_ID_OPTION]: "user-123" },
  };

  test("targets the Responses path with the grok-cli client headers", () => {
    const req = adapter().buildRequest([userTurn("hi")], "grok-4.5", baseOptions);
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
    expect(input[1]).toEqual({ type: "message", role: "user", content: "hello" });
  });

  test("maps tool calls and results to function_call items with flat tools", () => {
    const turns: ConversationTurn[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "call-1", name: "read_file", arguments: { path: "a.ts" } },
        ],
        timestamp: 0,
      },
      {
        role: "user",
        content: [
          { type: "tool_result", callId: "call-1", content: [{ type: "text", text: "ok" }] },
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
    expect(input[1]).toEqual({ type: "function_call_output", call_id: "call-1", output: "ok" });
    const tools = body["tools"] as Record<string, unknown>[];
    expect(tools[0]).toMatchObject({ type: "function", name: "read_file" });
    expect(body["tool_choice"]).toBe("auto");
  });

  test("sets prompt_cache_key from the session id, stable across builds", () => {
    const options: InferenceOptions = {
      ...baseOptions,
      providerOptions: { ...baseOptions.providerOptions, [GROK_SESSION_ID_OPTION]: "sess-1" },
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

  test("distinct session ids yield distinct prompt_cache_keys", () => {
    const bodyFor = (sessionId: string): Record<string, unknown> =>
      JSON.parse(
        adapter().buildRequest([userTurn("hi")], "grok-4.5", {
          providerOptions: { [GROK_SESSION_ID_OPTION]: sessionId },
        }).body,
      ) as Record<string, unknown>;
    expect(bodyFor("sess-1")["prompt_cache_key"]).toBe("sess-1");
    expect(bodyFor("sess-2")["prompt_cache_key"]).toBe("sess-2");
  });

  test("omits prompt_cache_key when no session id is present", () => {
    const body = JSON.parse(
      adapter().buildRequest([userTurn("hi")], "grok-4.5", baseOptions).body,
    ) as Record<string, unknown>;
    expect(body).not.toHaveProperty("prompt_cache_key");
  });

  test("keeps the latest tool result for a duplicated call id", () => {
    const turns: ConversationTurn[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "call-1", name: "read_file", arguments: { path: "a.ts" } },
        ],
        timestamp: 0,
      },
      {
        role: "user",
        content: [
          { type: "tool_result", callId: "call-1", content: [{ type: "text", text: "first" }] },
        ],
        timestamp: 0,
      },
      {
        role: "user",
        content: [
          { type: "tool_result", callId: "call-1", content: [{ type: "text", text: "duplicate" }] },
        ],
        timestamp: 0,
      },
    ];
    const body = JSON.parse(adapter().buildRequest(turns, "grok-4.5", baseOptions).body) as Record<
      string,
      unknown
    >;
    expect(body["input"]).toEqual([
      {
        type: "function_call",
        name: "read_file",
        arguments: JSON.stringify({ path: "a.ts" }),
        call_id: "call-1",
      },
      { type: "function_call_output", call_id: "call-1", output: "duplicate" },
    ]);
  });
});
