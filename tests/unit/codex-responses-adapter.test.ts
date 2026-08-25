import { test, expect, describe } from "bun:test";
import {
  createCodexResponsesAdapter,
  tagSignature,
  signatureForModel,
  CODEX_ACCOUNT_ID_OPTION,
  CODEX_SESSION_ID_OPTION,
  CODEX_RESPONSES_PROVIDER,
} from "../../src/provider/codex-responses-adapter.js";
import { GROK_RESPONSES_PROVIDER } from "../../src/provider/grok-responses-adapter.js";
import { BEARER_CREDENTIAL_SENTINEL } from "@intx/inference";
import type { ConversationTurn, InferenceOptions, LastCycleSource } from "@intx/types/runtime";

const SOURCE: LastCycleSource = {
  sourceId: "codex/personal",
  provider: "codex-responses",
  model: "gpt-5-codex",
};

function adapter() {
  return createCodexResponsesAdapter(SOURCE);
}

function userTurn(text: string): ConversationTurn {
  return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

describe("codex-responses buildRequest", () => {
  const baseOptions: InferenceOptions = {
    providerOptions: { [CODEX_ACCOUNT_ID_OPTION]: "acct-1", [CODEX_SESSION_ID_OPTION]: "sess-1" },
  };

  test("targets the Responses path with the required Codex headers", () => {
    const req = adapter().buildRequest([userTurn("hi")], "gpt-5-codex", baseOptions);
    expect(req.url).toBe("/codex/responses");
    expect(req.headers["authorization"]).toBe(BEARER_CREDENTIAL_SENTINEL);
    expect(req.headers["openai-beta"]).toBe("responses=experimental");
    expect(req.headers["chatgpt-account-id"]).toBe("acct-1");
    expect(req.headers["session_id"]).toBe("sess-1");
    expect(req.headers["originator"]).toBe("codex_cli_rs");
    expect(req.headers["accept"]).toBe("text/event-stream");
  });

  test("builds a Responses body with input items, store off, and reasoning encrypted include", () => {
    const req = adapter().buildRequest([userTurn("hello")], "gpt-5-codex", baseOptions);
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body["model"]).toBe("gpt-5-codex");
    expect(body["stream"]).toBe(true);
    expect(body["store"]).toBe(false);
    expect(body["include"]).toEqual(["reasoning.encrypted_content"]);
    expect(body["prompt_cache_key"]).toBe("sess-1");
    expect(body["input"]).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    ]);
  });

  test("pins instructions to the Codex prompt and carries the system prompt as a leading developer message", () => {
    const options: InferenceOptions = {
      ...baseOptions,
      systemPrompt: "be terse",
      tools: [
        {
          name: "read_file",
          description: "read a file",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    };
    const body = JSON.parse(
      adapter().buildRequest([userTurn("x")], "gpt-5-codex", options).body,
    ) as Record<string, unknown>;
    // The backend pins instructions to the official Codex prompt; the app prompt
    // must not be sent here.
    expect(typeof body["instructions"]).toBe("string");
    expect(body["instructions"]).not.toBe("be terse");
    expect(body["instructions"]).toContain("You are Codex");
    const input = body["input"] as Record<string, unknown>[];
    expect(input[0]).toMatchObject({ type: "message", role: "developer" });
    const leadText = (input[0]!["content"] as { text: string }[])[0]!.text;
    expect(leadText).toContain("be terse");
    expect(leadText).toContain("Corbits Code");
    expect(input[1]).toMatchObject({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "x" }],
    });
    expect(body["tools"]).toEqual([
      {
        type: "function",
        name: "read_file",
        description: "read a file",
        parameters: { type: "object", properties: {} },
      },
    ]);
    expect(body["tool_choice"]).toBe("auto");
  });

  test("encodes assistant tool calls and tool results as Responses items", () => {
    const turns: ConversationTurn[] = [
      userTurn("run it"),
      {
        role: "assistant",
        timestamp: 0,
        content: [
          { type: "text", text: "calling" },
          { type: "tool_call", id: "call_1", name: "read_file", arguments: { path: "a.ts" } },
        ],
      },
      {
        role: "user",
        timestamp: 0,
        content: [
          { type: "tool_result", callId: "call_1", content: [{ type: "text", text: "contents" }] },
        ],
      },
    ];
    const body = JSON.parse(
      adapter().buildRequest(turns, "gpt-5-codex", baseOptions).body,
    ) as Record<string, unknown>;
    expect(body["input"]).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "run it" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "calling" }] },
      { type: "function_call", name: "read_file", arguments: '{"path":"a.ts"}', call_id: "call_1" },
      { type: "function_call_output", call_id: "call_1", output: "contents" },
    ]);
  });

  test("maps reasoning_effort to the Responses reasoning config", () => {
    const options: InferenceOptions = {
      providerOptions: { ...baseOptions.providerOptions, reasoning_effort: "high" },
    };
    const body = JSON.parse(
      adapter().buildRequest([userTurn("x")], "gpt-5-codex", options).body,
    ) as Record<string, unknown>;
    expect(body["reasoning"]).toEqual({ effort: "high" });
  });

  // CL-6893: ChatGPT Codex rejects reasoning.summary "auto" for the gpt-5.6-terra /
  // gpt-5.3-codex family (HTTP 400). Codex CLI catalog default is none — omit summary
  // (effort only) so Terra/Luna request bodies never send summary:"auto".
  test.each(["gpt-5.6-terra", "gpt-5.6-luna"] as const)(
    "omits reasoning.summary auto for %s (CL-6893)",
    (model) => {
      const options: InferenceOptions = {
        providerOptions: { ...baseOptions.providerOptions, reasoning_effort: "high" },
      };
      const body = JSON.parse(
        adapter().buildRequest([userTurn("x")], model, options).body,
      ) as Record<string, unknown>;
      expect(body["reasoning"]).toEqual({ effort: "high" });
      expect(body["reasoning"]).not.toHaveProperty("summary");
    },
  );

  test("roundtrips encrypted reasoning signature from prior assistant turn into Responses reasoning item", () => {
    // Prior turn's assistant content included a thinking block with signature.
    // buildRequest must emit the "reasoning" item (with encrypted_content) before
    // the assistant message so the backend can continue its hidden reasoning state.
    const turns: ConversationTurn[] = [
      userTurn("solve the hard problem"),
      {
        role: "assistant",
        model: "gpt-5-codex",
        timestamp: 0,
        content: [
          {
            type: "thinking",
            thinking: "internal steps...",
            signature: tagSignature(CODEX_RESPONSES_PROVIDER, "ENC_BLOB_123"),
          },
          { type: "text", text: "The answer is 42." },
        ],
      },
    ];
    const body = JSON.parse(
      adapter().buildRequest(turns, "gpt-5-codex", baseOptions).body,
    ) as Record<string, unknown>;
    expect(body["input"]).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "solve the hard problem" }],
      },
      { type: "reasoning", summary: [], encrypted_content: "ENC_BLOB_123" },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "The answer is 42." }],
      },
    ]);
  });

  test("a second account on the same provider still replays the signature", () => {
    // codex/personal and codex/work are two ChatGPT accounts routed through the
    // same Codex backend (same provider, different InferenceSource.id). The
    // backend can decrypt a signature issued to either account, so a live
    // account switch must not poison reasoning continuity.
    const turns: ConversationTurn[] = [
      userTurn("solve the hard problem"),
      {
        role: "assistant",
        model: "gpt-5-codex",
        timestamp: 0,
        content: [
          {
            type: "thinking",
            thinking: "internal steps...",
            signature: tagSignature(CODEX_RESPONSES_PROVIDER, "ENC_BLOB_123"),
          },
          { type: "text", text: "The answer is 42." },
        ],
      },
    ];
    const workAdapter = createCodexResponsesAdapter({
      sourceId: "codex/work",
      provider: "codex-responses",
      model: "gpt-5-codex",
    });
    const body = JSON.parse(
      workAdapter.buildRequest(turns, "gpt-5-codex", baseOptions).body,
    ) as Record<string, unknown>;
    expect(body["input"]).toContainEqual({
      type: "reasoning",
      summary: [],
      encrypted_content: "ENC_BLOB_123",
    });
  });

  test("drops a reasoning signature issued for a different model after a provider switch", () => {
    // The signature was minted by grok-4.5; the request now targets a Codex
    // model. Replaying it would 400 with an undecryptable-content error, so
    // the reasoning item must be omitted while the surrounding turn survives.
    const turns: ConversationTurn[] = [
      userTurn("solve the hard problem"),
      {
        role: "assistant",
        model: "grok-4.5",
        timestamp: 0,
        content: [
          {
            type: "thinking",
            thinking: "internal steps...",
            signature: tagSignature(GROK_RESPONSES_PROVIDER, "FOREIGN_BLOB"),
          },
          { type: "text", text: "The answer is 42." },
        ],
      },
    ];
    const body = JSON.parse(
      adapter().buildRequest(turns, "gpt-5-codex", baseOptions).body,
    ) as Record<string, unknown>;
    expect(body["input"]).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "solve the hard problem" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "The answer is 42." }],
      },
    ]);
  });

  test("drops a reasoning signature issued by a different provider even when the model string matches", () => {
    // Two distinct backends (e.g. proxy aliases) can declare the identical
    // literal model name. Nothing but the tagged provider on the signature
    // itself distinguishes them, since InferenceSource.model is arbitrary
    // catalog text and turn.model alone cannot tell them apart.
    const turns: ConversationTurn[] = [
      userTurn("solve the hard problem"),
      {
        role: "assistant",
        model: "gpt-5-codex",
        timestamp: 0,
        content: [
          {
            type: "thinking",
            thinking: "internal steps...",
            signature: tagSignature(GROK_RESPONSES_PROVIDER, "FOREIGN_BLOB"),
          },
          { type: "text", text: "The answer is 42." },
        ],
      },
    ];
    const body = JSON.parse(
      adapter().buildRequest(turns, "gpt-5-codex", baseOptions).body,
    ) as Record<string, unknown>;
    expect(body["input"]).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "solve the hard problem" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "The answer is 42." }],
      },
    ]);
  });

  test("recovers an already-poisoned session: a foreign signature is dropped on every subsequent request", () => {
    const poisonedHistory: ConversationTurn[] = [
      userTurn("turn 1"),
      {
        role: "assistant",
        model: "grok-4.5",
        timestamp: 0,
        content: [
          {
            type: "thinking",
            thinking: "...",
            signature: tagSignature(GROK_RESPONSES_PROVIDER, "FOREIGN_BLOB"),
          },
          { type: "text", text: "ok" },
        ],
      },
      userTurn("turn 2"),
    ];
    const firstRetry = JSON.parse(
      adapter().buildRequest(poisonedHistory, "gpt-5-codex", baseOptions).body,
    ) as Record<string, unknown>;
    const secondRetry = JSON.parse(
      adapter().buildRequest(poisonedHistory, "gpt-5-codex", baseOptions).body,
    ) as Record<string, unknown>;
    for (const body of [firstRetry, secondRetry]) {
      const input = body["input"] as Record<string, unknown>[];
      expect(input.some((item) => item["type"] === "reasoning")).toBe(false);
    }
  });

  test("drops a bare, untagged legacy signature instead of misparsing it as ciphertext", () => {
    // Signatures captured before this change carry no "<provider>:" prefix.
    // untagSignature must recognize the absence of a separator and refuse to
    // treat any part of the raw string as ciphertext, rather than replaying
    // a truncated or garbled blob the backend cannot decrypt.
    const turns: ConversationTurn[] = [
      userTurn("solve the hard problem"),
      {
        role: "assistant",
        model: "gpt-5-codex",
        timestamp: 0,
        content: [
          {
            type: "thinking",
            thinking: "internal steps...",
            signature: "QUJDREVGRzEyMzQ1Njc4OTAtXy8rPQ==",
          },
          { type: "text", text: "The answer is 42." },
        ],
      },
    ];
    const body = JSON.parse(
      adapter().buildRequest(turns, "gpt-5-codex", baseOptions).body,
    ) as Record<string, unknown>;
    const input = body["input"] as Record<string, unknown>[];
    expect(input.some((item) => item["type"] === "reasoning")).toBe(false);
  });

  test("signatureForModel returns undefined for an untagged signature", () => {
    const turn: ConversationTurn = {
      role: "assistant",
      model: "gpt-5-codex",
      timestamp: 0,
      content: [],
    };
    expect(
      signatureForModel(
        turn,
        "gpt-5-codex",
        CODEX_RESPONSES_PROVIDER,
        "QUJDREVGRzEyMzQ1Njc4OTAtXy8rPQ==",
      ),
    ).toBeUndefined();
  });

  test("tagSignature/signatureForModel round-trips ciphertext containing embedded colons byte-exact", () => {
    // untagSignature splits on the FIRST colon (indexOf, not split(":")),
    // so ciphertext that itself contains colons must survive intact. A
    // naive split(":")[1] would truncate this to "part2".
    const ciphertext = "part1:part2:part3==";
    const turn: ConversationTurn = {
      role: "assistant",
      model: "gpt-5-codex",
      timestamp: 0,
      content: [],
    };
    const tagged = tagSignature(CODEX_RESPONSES_PROVIDER, ciphertext);
    expect(signatureForModel(turn, "gpt-5-codex", CODEX_RESPONSES_PROVIDER, tagged)).toBe(
      ciphertext,
    );
  });

  test("omits the account-id header when no account id is supplied", () => {
    const req = adapter().buildRequest([userTurn("x")], "gpt-5-codex", {
      providerOptions: { [CODEX_SESSION_ID_OPTION]: "s" },
    });
    expect(req.headers["chatgpt-account-id"]).toBeUndefined();
  });
});

describe("codex-responses parseResponse", () => {
  function parse(events: object[]): ReturnType<ReturnType<typeof adapter>["parseResponse"]> {
    const a = adapter();
    return events.flatMap((e) => a.parseResponse(JSON.stringify(e)));
  }

  test("emits text deltas", () => {
    const out = parse([
      { type: "response.output_text.delta", delta: "hel" },
      { type: "response.output_text.delta", delta: "lo" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      type: "inference.text.delta",
      data: { token: "hel", index: 0 },
    });
    expect(out[1]).toMatchObject({ type: "inference.text.delta", data: { token: "lo", index: 0 } });
  });

  test("emits thinking deltas for reasoning summary text", () => {
    const out = parse([{ type: "response.reasoning_summary_text.delta", delta: "ponder" }]);
    expect(out[0]).toMatchObject({ type: "inference.thinking.delta", data: { token: "ponder" } });
  });

  test("emits tool_call start then argument deltas with a shared block index", () => {
    const out = parse([
      {
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc_1", call_id: "call_9", name: "read_file" },
      },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"path":' },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"a.ts"}' },
    ]);
    expect(out[0]).toMatchObject({
      type: "inference.tool_call.start",
      data: { callId: "call_9", name: "read_file", index: 0 },
    });
    expect(out[1]).toMatchObject({
      type: "inference.tool_call.delta",
      data: { callId: "0", argumentFragment: '{"path":', index: 0 },
    });
    expect(out[2]).toMatchObject({
      type: "inference.tool_call.delta",
      data: { argumentFragment: '"a.ts"}', index: 0 },
    });
  });

  test("text then tool call get distinct block indices", () => {
    const out = parse([
      { type: "response.output_text.delta", delta: "hi" },
      {
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc_1", call_id: "c1", name: "t" },
      },
    ]);
    expect(out[0]).toMatchObject({ data: { index: 0 } });
    expect(out[1]).toMatchObject({ data: { index: 1 } });
  });

  test("emits usage from response.completed only", () => {
    const out = parse([
      {
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            input_tokens_details: { cached_tokens: 64 },
            output_tokens_details: { reasoning_tokens: 8 },
          },
        },
      },
    ]);
    expect(out[0]).toMatchObject({
      type: "inference.usage",
      data: { usage: { input: 36, output: 20, cacheRead: 64, cacheWrite: 0, thinking: 8 } },
    });
  });

  test("captures encrypted reasoning content as a thinking signature for round-trip", () => {
    const out = parse([
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "thinking..." },
      {
        type: "response.output_item.done",
        item: { type: "reasoning", id: "rs_1", encrypted_content: "ENC_BLOB" },
      },
    ]);
    expect(out[0]).toMatchObject({ type: "inference.thinking.delta", data: { index: 0 } });
    expect(out[1]).toMatchObject({
      type: "inference.block.signature",
      data: { signature: tagSignature(CODEX_RESPONSES_PROVIDER, "ENC_BLOB"), index: 0 },
    });
  });

  test("emits empty thinking delta + signature when done provides encrypted_content with no prior delta (pure-encrypted reasoning)", () => {
    // This supports the case where the backend surfaces only the encrypted blob
    // (no reasoning_text or summary deltas) and we must still round-trip the
    // signature for follow-up turns.
    const out = parse([
      {
        type: "response.output_item.done",
        item: { type: "reasoning", id: "rs_solo", encrypted_content: "ENC" },
      },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      type: "inference.thinking.delta",
      data: { token: "", index: 0 },
    });
    expect(out[1]).toMatchObject({
      type: "inference.block.signature",
      data: { signature: tagSignature(CODEX_RESPONSES_PROVIDER, "ENC"), index: 0 },
    });
  });

  test("keys blocks by item_id so interleaved reasoning and tool calls keep distinct indices", () => {
    const out = parse([
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "a" },
      {
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc_1", call_id: "c1", name: "t" },
      },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_2", delta: "b" },
    ]);
    expect(out[0]).toMatchObject({ type: "inference.thinking.delta", data: { index: 0 } });
    expect(out[1]).toMatchObject({ type: "inference.tool_call.start", data: { index: 1 } });
    // A second distinct reasoning item gets its own index, not merged into the first.
    expect(out[2]).toMatchObject({ type: "inference.thinking.delta", data: { index: 2 } });
  });

  test("omits max_output_tokens (the Codex backend rejects it)", () => {
    const body = JSON.parse(
      adapter().buildRequest([userTurn("x")], "gpt-5-codex", {
        maxTokens: 4096,
        providerOptions: { [CODEX_SESSION_ID_OPTION]: "s" },
      }).body,
    ) as Record<string, unknown>;
    expect(body["max_output_tokens"]).toBeUndefined();
  });

  test("ignores lifecycle envelopes", () => {
    expect(
      parse([{ type: "response.created", response: {} }, { type: "response.in_progress" }]),
    ).toHaveLength(0);
  });

  test("throws ProtocolMismatchError on a failed response", () => {
    const a = adapter();
    expect(() =>
      a.parseResponse(
        JSON.stringify({ type: "response.failed", response: { error: { message: "boom" } } }),
      ),
    ).toThrow(/boom/);
  });

  test("throws on malformed JSON", () => {
    expect(() => adapter().parseResponse("{not json")).toThrow();
  });
});
