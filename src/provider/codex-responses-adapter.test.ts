import { describe, expect, test } from "bun:test";
import type { ConversationTurn, LastCycleSource, TokenUsage } from "@intx/types/runtime";
import { PRODUCT_NAME } from "../branding.js";
import {
  createCodexResponsesAdapter,
  isResponsesStreamTerminal,
  signatureForModel,
  tagSignature,
} from "./codex-responses-adapter.js";
import { contextTokensFromUsage } from "./context-window.js";

const source: LastCycleSource = {
  sourceId: "codex/test",
  provider: "codex-responses",
  model: "gpt-5.1-codex",
};

describe("createCodexResponsesAdapter", () => {
  test("sends user image blocks as Responses input_image parts", () => {
    const adapter = createCodexResponsesAdapter(source);
    const turns: ConversationTurn[] = [
      {
        role: "user",
        timestamp: 0,
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", source: { kind: "base64", mimeType: "image/png", data: "aW1hZ2U=" } },
        ],
      },
    ];

    const request = adapter.buildRequest(turns, "gpt-5.1-codex", {});
    const body = JSON.parse(request.body) as {
      input: { type: string; role?: string; content?: unknown }[];
    };

    expect(body.input[0]).toEqual({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "what is this?" },
        { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" },
      ],
    });
  });

  test("keeps text-only messages as Responses text parts", () => {
    const adapter = createCodexResponsesAdapter(source);
    const turns: ConversationTurn[] = [
      {
        role: "user",
        timestamp: 0,
        content: [{ type: "text", text: "hello" }],
      },
    ];

    const request = adapter.buildRequest(turns, "gpt-5.1-codex", {});
    const body = JSON.parse(request.body) as { input: { content?: unknown }[] };

    expect(body.input[0]?.content).toEqual([{ type: "input_text", text: "hello" }]);
  });

  test("reports the adapter as terminating on response.completed", () => {
    const adapter = createCodexResponsesAdapter(source);
    expect(adapter.isStreamTerminal).toBe(isResponsesStreamTerminal);
  });

  test("bridge message points at Codex tool proxies instead of neutralizing them", () => {
    const adapter = createCodexResponsesAdapter(source);
    const turns: ConversationTurn[] = [
      { role: "user", timestamp: 0, content: [{ type: "text", text: "hi" }] },
    ];

    const request = adapter.buildRequest(turns, "gpt-5.1-codex", {
      systemPrompt: "operating prompt body",
    });
    const body = JSON.parse(request.body) as {
      input: { role?: string; content?: { text?: string }[] }[];
    };
    const bridgeText = body.input[0]?.content?.[0]?.text ?? "";

    expect(bridgeText).toContain(`${PRODUCT_NAME} is the harness, not the Codex CLI.`);
    expect(bridgeText).toContain("apply_patch, update_plan, shell");
    expect(bridgeText).toContain("proxy onto");
    expect(bridgeText).toContain("prefer whichever name appears in the current tool list");
    expect(bridgeText).toContain("operating prompt body");
    expect(bridgeText).not.toContain("DO NOT EXIST");
    expect(bridgeText).not.toContain("Ignore every tool reference");
  });
});

describe("createCodexResponsesAdapter usage parsing", () => {
  // The Responses API reports `input_tokens` as the full prompt count with
  // `cached_tokens` as a subset. Downstream consumers (context meter,
  // compaction governor, faremeter) sum input + cacheRead + cacheWrite, so
  // emitting the raw wire counts would double-count every cached token.
  const completedUsage = (
    adapter: ReturnType<typeof createCodexResponsesAdapter>,
    sseData: string,
  ): { usage: TokenUsage; source: LastCycleSource } => {
    const event = adapter.parseResponse(sseData).find((e) => e.type === "inference.usage");
    if (event === undefined) throw new Error("stream carried no inference.usage event");
    return event.data as { usage: TokenUsage; source: LastCycleSource };
  };

  test("subtracts cached_tokens from input_tokens so usage fields do not overlap", () => {
    const adapter = createCodexResponsesAdapter(source);
    const sseData = JSON.stringify({
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 1000,
          input_tokens_details: { cached_tokens: 800 },
          output_tokens: 50,
          output_tokens_details: { reasoning_tokens: 5 },
        },
      },
    });

    expect(completedUsage(adapter, sseData)).toEqual({
      usage: { input: 200, output: 50, cacheRead: 800, cacheWrite: 0, thinking: 5 },
      source,
    });
  });

  test("keeps the context occupancy sum equal to the wire prompt token count", () => {
    const adapter = createCodexResponsesAdapter(source);
    const sseData = JSON.stringify({
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 1000,
          input_tokens_details: { cached_tokens: 940 },
          output_tokens: 50,
        },
      },
    });

    const { usage } = completedUsage(adapter, sseData);

    expect(contextTokensFromUsage(usage)).toBe(1000);
  });

  test("reports input unchanged when the provider omits input_tokens_details", () => {
    const adapter = createCodexResponsesAdapter(source);
    const sseData = JSON.stringify({
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 100,
          output_tokens: 50,
        },
      },
    });

    expect(completedUsage(adapter, sseData)).toEqual({
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      source,
    });
  });

  test("clamps input to zero when cached_tokens exceeds input_tokens", () => {
    const adapter = createCodexResponsesAdapter(source);
    const sseData = JSON.stringify({
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 25 },
          output_tokens: 50,
        },
      },
    });

    expect(completedUsage(adapter, sseData)).toEqual({
      usage: { input: 0, output: 50, cacheRead: 25, cacheWrite: 0, thinking: 0 },
      source,
    });
  });

  test("maps a nonzero cache_creation_tokens count through to cacheWrite", () => {
    const adapter = createCodexResponsesAdapter(source);
    const sseData = JSON.stringify({
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 20, cache_creation_tokens: 15 },
          output_tokens: 50,
          output_tokens_details: { reasoning_tokens: 5 },
        },
      },
    });

    expect(completedUsage(adapter, sseData)).toEqual({
      usage: { input: 80, output: 50, cacheRead: 20, cacheWrite: 15, thinking: 5 },
      source,
    });
  });
});

describe("signatureForModel", () => {
  const turnWithModel = (model: string | undefined): ConversationTurn =>
    ({
      role: "assistant",
      model,
      content: [],
      timestamp: 0,
    }) as unknown as ConversationTurn;

  test("replays a signature on a turn with no persisted model", () => {
    const signature = tagSignature("codex-responses", "cipher");
    const result = signatureForModel(
      turnWithModel(undefined),
      "gpt-5.1-codex",
      "codex-responses",
      signature,
    );
    expect(result).toBe("cipher");
  });

  test("drops a signature when the turn's model genuinely differs", () => {
    const signature = tagSignature("codex-responses", "cipher");
    const result = signatureForModel(
      turnWithModel("gpt-5.0-codex"),
      "gpt-5.1-codex",
      "codex-responses",
      signature,
    );
    expect(result).toBeUndefined();
  });

  test("replays a signature when the model matches", () => {
    const signature = tagSignature("codex-responses", "cipher");
    const result = signatureForModel(
      turnWithModel("gpt-5.1-codex"),
      "gpt-5.1-codex",
      "codex-responses",
      signature,
    );
    expect(result).toBe("cipher");
  });
});

describe("createCodexResponsesAdapter orphaned function_call suppression", () => {
  test("drops a function_call whose reasoning signature could not be replayed", () => {
    const adapter = createCodexResponsesAdapter(source);
    const turns: ConversationTurn[] = [
      { role: "user", timestamp: 0, content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        model: "gpt-5.0-codex",
        timestamp: 0,
        content: [
          { type: "thinking", thinking: "ponder", signature: tagSignature("codex-responses", "c") },
          { type: "tool_call", id: "call_1", name: "shell", arguments: {} },
        ],
      },
    ] as unknown as ConversationTurn[];

    const request = adapter.buildRequest(turns, "gpt-5.1-codex", {});
    const body = JSON.parse(request.body) as { input: { type: string }[] };

    expect(body.input.some((item) => item.type === "reasoning")).toBe(false);
    expect(body.input.some((item) => item.type === "function_call")).toBe(false);
  });

  test("keeps the function_call when its reasoning signature replays cleanly", () => {
    const adapter = createCodexResponsesAdapter(source);
    const turns: ConversationTurn[] = [
      { role: "user", timestamp: 0, content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        model: "gpt-5.1-codex",
        timestamp: 0,
        content: [
          { type: "thinking", thinking: "ponder", signature: tagSignature("codex-responses", "c") },
          { type: "tool_call", id: "call_1", name: "shell", arguments: {} },
        ],
      },
    ] as unknown as ConversationTurn[];

    const request = adapter.buildRequest(turns, "gpt-5.1-codex", {});
    const body = JSON.parse(request.body) as { input: { type: string }[] };

    expect(body.input.some((item) => item.type === "reasoning")).toBe(true);
    expect(body.input.some((item) => item.type === "function_call")).toBe(true);
  });
});

describe("createCodexResponsesAdapter tool-name codec", () => {
  test("encodes a non-wire-safe tool name on the outgoing function tool definition", () => {
    const adapter = createCodexResponsesAdapter(source);
    const turns: ConversationTurn[] = [
      { role: "user", timestamp: 0, content: [{ type: "text", text: "hi" }] },
    ];

    const request = adapter.buildRequest(turns, "gpt-5.1-codex", {
      tools: [
        {
          name: "@intx/tools-posix/sidecar-bundle:run_shell",
          description: "run a shell command",
          inputSchema: {},
        },
      ],
    } as never);
    const body = JSON.parse(request.body) as { tools: { name: string }[] };

    expect(body.tools[0]?.name).toMatch(/^[A-Za-z_][A-Za-z0-9_-]*$/);
    expect(body.tools[0]?.name).not.toBe("@intx/tools-posix/sidecar-bundle:run_shell");
  });

  test("decodes an encoded tool_call.start name back to the internal id", () => {
    const adapter = createCodexResponsesAdapter(source);
    const encoded = "IX_-40intx-2Ftools-2Dposix-2Fsidecar-2Dbundle-3Arun_shell";
    const sseData = JSON.stringify({
      type: "response.output_item.added",
      item: { type: "function_call", id: "item_1", call_id: "call_1", name: encoded },
    });

    const events = adapter.parseResponse(sseData);
    const start = events.find((e) => e.type === "inference.tool_call.start");

    expect((start?.data as { name?: string })?.name).not.toBe(encoded);
  });
});

describe("createCodexResponsesAdapter block indexer reset", () => {
  test("resets block indices on a new buildRequest instead of accumulating across requests", () => {
    const adapter = createCodexResponsesAdapter(source);
    const turns: ConversationTurn[] = [
      { role: "user", timestamp: 0, content: [{ type: "text", text: "hi" }] },
    ];

    adapter.buildRequest(turns, "gpt-5.1-codex", {});
    adapter.parseResponse(
      JSON.stringify({ type: "response.output_text.delta", item_id: "item_1", delta: "a" }),
    );
    adapter.parseResponse(
      JSON.stringify({ type: "response.output_text.delta", item_id: "item_2", delta: "b" }),
    );

    // A new request (a fresh HTTP round trip) with a brand-new item id should
    // start indexing from 0 again, not continue accumulating from the prior
    // request's indexer state.
    adapter.buildRequest(turns, "gpt-5.1-codex", {});
    const secondRequestDelta = adapter.parseResponse(
      JSON.stringify({ type: "response.output_text.delta", item_id: "item_3", delta: "c" }),
    );
    expect((secondRequestDelta[0]?.data as { index?: number })?.index).toBe(0);
  });
});

describe("isResponsesStreamTerminal", () => {
  test("is true for the Responses end-of-turn events", () => {
    for (const type of ["response.completed", "response.incomplete", "response.done"]) {
      expect(isResponsesStreamTerminal(JSON.stringify({ type }))).toBe(true);
    }
  });

  test("is false for streaming and lifecycle events", () => {
    for (const type of ["response.output_text.delta", "response.created", "response.in_progress"]) {
      expect(isResponsesStreamTerminal(JSON.stringify({ type }))).toBe(false);
    }
  });

  test("is false for malformed or non-object payloads", () => {
    expect(isResponsesStreamTerminal("{not json")).toBe(false);
    expect(isResponsesStreamTerminal("null")).toBe(false);
    expect(isResponsesStreamTerminal('"just a string"')).toBe(false);
  });
});
