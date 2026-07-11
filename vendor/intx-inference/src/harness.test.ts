import { describe, test, expect } from "bun:test";

import {
  createDefaultScheduler,
  HarnessId,
  runInference,
  type Dependencies,
  type InferenceHarnessOptions,
} from "./harness";
import {
  createBuiltinRegistry,
  createDefaultDependencies,
  loadAdapterRegistry,
} from "./providers";
import { createAdapterRegistry, type AdapterFactory } from "./adapter";
import { ProtocolMismatchError } from "./errors";
import type {
  ConversationTurn,
  InferenceEvent,
  InferenceSource,
} from "@intx/types/runtime";

const SOURCE: InferenceSource = {
  id: "anthropic:claude-3-5-sonnet-20240620",
  provider: "anthropic",
  baseURL: "https://api.anthropic.com",
  apiKey: "test",
  model: "claude-3-5-sonnet-20240620",
};

function userTurn(text: string): ConversationTurn {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 0,
  };
}

async function collect(
  iter: AsyncIterable<InferenceEvent>,
): Promise<InferenceEvent[]> {
  const out: InferenceEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

// Only needed because `globalThis.fetch` reassignment must satisfy the
// Bun-augmented type (which carries a `preconnect` static). `deps.fetch`
// uses the narrow `Dependencies.fetch` shape and accepts a plain function.
function makeGlobalFetchStub(
  handler: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
): typeof globalThis.fetch {
  return Object.assign(handler, { preconnect: () => undefined });
}

describe("runInference — Dependencies parameter", () => {
  test("invokes deps.fetch instead of globalThis.fetch", async () => {
    const calls: { url: string; method: string | undefined }[] = [];

    const deps: Dependencies = {
      fetch: (input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        calls.push({ url, method: init?.method });
        return Promise.resolve(
          new Response("", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        );
      },
      scheduler: createDefaultScheduler(),
      adapters: createBuiltinRegistry(),
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeGlobalFetchStub(() => {
      throw new Error(
        "globalThis.fetch must not be called when deps.fetch is provided",
      );
    });

    let events: InferenceEvent[];
    try {
      let seq = 0;
      events = await collect(
        runInference({
          turns: [userTurn("hello")],
          source: SOURCE,
          nextSeq: () => ++seq,
          deps,
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls).toHaveLength(1);
    const firstCall = calls[0];
    if (firstCall === undefined) {
      throw new Error("expected one fetch call");
    }
    expect(firstCall.url).toBe("https://api.anthropic.com/v1/messages");
    expect(firstCall.method).toBe("POST");

    const startEvent = events.find((e) => e.type === "inference.start");
    const doneEvent = events.find((e) => e.type === "inference.done");
    if (startEvent === undefined) throw new Error("missing inference.start");
    if (doneEvent === undefined) throw new Error("missing inference.done");
  });

  test("propagates errors from deps.fetch without falling back to globalThis.fetch", async () => {
    const deps: Dependencies = {
      fetch: () => Promise.reject(new Error("simulated network failure")),
      scheduler: createDefaultScheduler(),
      adapters: createBuiltinRegistry(),
    };

    const originalFetch = globalThis.fetch;
    let globalFetchCalled = false;
    globalThis.fetch = makeGlobalFetchStub(() => {
      globalFetchCalled = true;
      throw new Error("globalThis.fetch must not be called");
    });

    let events: InferenceEvent[];
    try {
      let seq = 0;
      events = await collect(
        runInference({
          turns: [userTurn("hello")],
          source: SOURCE,
          nextSeq: () => ++seq,
          deps,
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(globalFetchCalled).toBe(false);
    const errorEvent = events.find((e) => e.type === "inference.error");
    if (errorEvent === undefined) throw new Error("missing inference.error");
    expect(errorEvent.data.error.category).toBe("retryable");
    expect(errorEvent.data.error.message).toContain(
      "simulated network failure",
    );
  });

  // The crash-loudly contract: a missing or malformed `deps.fetch` is a
  // programmer bug, not a transport failure. `runInference` must throw a
  // plain Error out of the generator (lazily, on first iteration — the
  // throw fires from inside `for await`, not at the `runInference(...)`
  // call site) and must not yield any event, including `inference.start`.

  test("throws plainly when deps.fetch is undefined", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- modeling a JS caller that assigned undefined to deps.fetch
    const deps = { fetch: undefined } as unknown as Dependencies;
    const iter = runInference({
      turns: [userTurn("hello")],
      source: SOURCE,
      nextSeq: () => 1,
      deps,
    });

    const events: InferenceEvent[] = [];
    let thrown: unknown;
    try {
      for await (const ev of iter) events.push(ev);
    } catch (e) {
      thrown = e;
    }

    if (!(thrown instanceof Error)) {
      throw new Error("expected runInference to throw an Error");
    }
    expect(thrown.message).toContain("deps.fetch must be a function");
    expect(thrown.message).toContain("undefined");
    expect(events).toEqual([]);
  });

  test("throws plainly when deps.fetch is a non-function value", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- modeling a JS caller that assigned a non-function value to deps.fetch
    const deps = { fetch: "not a function" } as unknown as Dependencies;
    const iter = runInference({
      turns: [userTurn("hello")],
      source: SOURCE,
      nextSeq: () => 1,
      deps,
    });

    const events: InferenceEvent[] = [];
    let thrown: unknown;
    try {
      for await (const ev of iter) events.push(ev);
    } catch (e) {
      thrown = e;
    }

    if (!(thrown instanceof Error)) {
      throw new Error("expected runInference to throw an Error");
    }
    expect(thrown.message).toContain("deps.fetch must be a function");
    expect(thrown.message).toContain("string");
    expect(events).toEqual([]);
  });

  test("throws plainly when deps is omitted entirely", async () => {
    const baseOpts: Omit<InferenceHarnessOptions, "deps"> = {
      turns: [userTurn("hello")],
      source: SOURCE,
      nextSeq: () => 1,
    };
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- modeling a JS caller that omitted the required `deps` field
    const opts = baseOpts as unknown as InferenceHarnessOptions;
    const iter = runInference(opts);

    const events: InferenceEvent[] = [];
    let thrown: unknown;
    try {
      for await (const ev of iter) events.push(ev);
    } catch (e) {
      thrown = e;
    }

    if (!(thrown instanceof Error)) {
      throw new Error("expected runInference to throw an Error");
    }
    expect(thrown.message).toContain("deps.fetch must be a function");
    expect(events).toEqual([]);
  });
});

describe("createDefaultDependencies", () => {
  test("delegates calls to globalThis.fetch as bound at factory-call time", async () => {
    const calls: { url: string; method: string | undefined }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeGlobalFetchStub((input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, method: init?.method });
      return Promise.resolve(new Response("", { status: 204 }));
    });

    try {
      const deps = createDefaultDependencies();
      const response = await deps.fetch("https://example.test/ping", {
        method: "POST",
      });
      expect(response.status).toBe(204);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls).toEqual([
      { url: "https://example.test/ping", method: "POST" },
    ]);
  });

  test("does not stamp the HarnessId tag", () => {
    const deps = createDefaultDependencies();
    expect(Object.getOwnPropertySymbols(deps)).toEqual([]);
  });
});

// `source.defaults` carries model-bound knobs that the harness merges
// into the per-call `InferenceOptions` at the top of `runInference`
// before the adapter sees anything. The contract: per-call wins over
// source-bound; source-bound applies when per-call omits the key.
//
// These tests use the openai-compatible adapter because it carries the
// fully-populated `max_tokens` floor through to the request body
// (anthropic's adapter only forwards `max_tokens` when set), so the
// merge result is observable at the wire.
describe("runInference — source.defaults merge precedence", () => {
  const OPENAI_SOURCE: InferenceSource = {
    id: "openai:gpt-test",
    provider: "openai",
    baseURL: "https://api.openai.test/v1",
    apiKey: "test",
    model: "gpt-test",
  };

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  async function captureMaxTokens(opts: {
    source: InferenceSource;
    perCallMaxTokens?: number;
  }): Promise<number | undefined> {
    let captured: Record<string, unknown> | undefined;
    const deps: Dependencies = {
      fetch: (_input, init) => {
        const body = typeof init?.body === "string" ? init.body : "";
        const parsed: unknown = body === "" ? {} : JSON.parse(body);
        if (isRecord(parsed)) {
          captured = parsed;
        }
        return Promise.resolve(
          new Response("", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        );
      },
      scheduler: createDefaultScheduler(),
      adapters: createBuiltinRegistry(),
    };
    let seq = 0;
    await collect(
      runInference({
        turns: [userTurn("hi")],
        source: opts.source,
        ...(opts.perCallMaxTokens !== undefined
          ? { inferenceOptions: { maxTokens: opts.perCallMaxTokens } }
          : {}),
        nextSeq: () => ++seq,
        deps,
      }),
    );
    if (captured === undefined) throw new Error("no request body captured");
    const value = captured["max_tokens"];
    return typeof value === "number" ? value : undefined;
  }

  test("source-bound default applies when the per-call option is absent", async () => {
    const sourceWithDefault: InferenceSource = {
      ...OPENAI_SOURCE,
      defaults: { maxTokens: 1024 },
    };
    const max = await captureMaxTokens({ source: sourceWithDefault });
    expect(max).toBe(1024);
  });

  test("per-call option overrides the source-bound default", async () => {
    const sourceWithDefault: InferenceSource = {
      ...OPENAI_SOURCE,
      defaults: { maxTokens: 1024 },
    };
    const max = await captureMaxTokens({
      source: sourceWithDefault,
      perCallMaxTokens: 8192,
    });
    expect(max).toBe(8192);
  });

  test("neither set: the adapter's compile-time floor applies", async () => {
    const max = await captureMaxTokens({ source: OPENAI_SOURCE });
    // Falls through to openai.ts's `options.maxTokens ?? 4096` floor.
    expect(max).toBe(4096);
  });
});

// providerOptions on InferenceSourceDefaults is the model-bound bag of
// provider-native knobs. Per-call InferenceOptions.providerOptions
// overrides via the same shallow-spread merge that handles maxTokens.
// The merge is shallow: a per-call providerOptions object wholesale
// replaces the source-bound one rather than deep-merging per key.
describe("runInference — providerOptions merge precedence", () => {
  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  async function captureAdapterOptions(opts: {
    sourceProviderOptions?: Record<string, unknown>;
    perCallProviderOptions?: Record<string, unknown>;
  }): Promise<Record<string, unknown> | undefined> {
    // A fresh provider name per call keeps independent runs isolated. The
    // custom adapter is injected through `deps.adapters`: a manifest entry
    // points at a synthetic module that `loadAdapterRegistry` resolves via
    // an injected importer, so nothing is loaded from disk.
    const providerName = `test-provideroptions-${Math.random().toString(36).slice(2)}`;
    let captured: Record<string, unknown> | undefined | "absent" = "absent";

    const make: AdapterFactory = () => ({
      buildRequest: (_messages, _model, options) => {
        captured = isRecord(options.providerOptions)
          ? options.providerOptions
          : undefined;
        return {
          url: "/test",
          headers: { "content-type": "application/json" },
          body: "{}",
        };
      },
      parseResponse: () => [],
    });
    const adapters = await loadAdapterRegistry(
      [{ provider: providerName, specifier: "x", export: "make" }],
      { import: () => Promise.resolve({ make }) },
    );

    const source: InferenceSource = {
      id: `${providerName}:test-model`,
      provider: providerName,
      baseURL: "https://test.invalid",
      apiKey: "test",
      model: "test-model",
      ...(opts.sourceProviderOptions !== undefined
        ? { defaults: { providerOptions: opts.sourceProviderOptions } }
        : {}),
    };

    const deps: Dependencies = {
      fetch: () =>
        Promise.resolve(
          new Response("", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      scheduler: createDefaultScheduler(),
      adapters,
    };

    let seq = 0;
    await collect(
      runInference({
        turns: [userTurn("hi")],
        source,
        ...(opts.perCallProviderOptions !== undefined
          ? {
              inferenceOptions: {
                providerOptions: opts.perCallProviderOptions,
              },
            }
          : {}),
        nextSeq: () => ++seq,
        deps,
      }),
    );

    if (captured === "absent")
      throw new Error("adapter buildRequest not called");
    return captured;
  }

  test("source-bound providerOptions reaches the adapter when no per-call override", async () => {
    const seen = await captureAdapterOptions({
      sourceProviderOptions: { user: "user_123", store: false },
    });
    expect(seen).toEqual({ user: "user_123", store: false });
  });

  test("per-call providerOptions wholesale replaces the source-bound bag", async () => {
    const seen = await captureAdapterOptions({
      sourceProviderOptions: { user: "user_123", store: false },
      perCallProviderOptions: { user: "user_999" },
    });
    // Shallow merge: per-call object wins entirely, source-bound `store`
    // does NOT survive the override.
    expect(seen).toEqual({ user: "user_999" });
  });

  test("neither set: the adapter sees options.providerOptions === undefined", async () => {
    const seen = await captureAdapterOptions({});
    expect(seen).toBeUndefined();
  });
});

// The JSDoc on `Dependencies` documents which reflective APIs leak the
// optional `[HarnessId]` tag. Pin those claims so a future refactor that
// makes the tag enumerable (e.g., renaming it to a string key) cannot
// silently turn a safe serializer into a leak.
describe("Dependencies — reflective exposure of HarnessId", () => {
  function stampedDeps(): Dependencies {
    return {
      fetch: () => Promise.resolve(new Response("")),
      scheduler: createDefaultScheduler(),
      adapters: createBuiltinRegistry(),
      [HarnessId]: Symbol("test-harness"),
    };
  }

  test("JSON.stringify ignores symbol-keyed fields", () => {
    // Probe with a serializable string value at the symbol key. If
    // `HarnessId` were ever changed from a symbol to a string key, the
    // serializer would walk it and the assertion would fail. The
    // string-keyed control proves the test isn't passing just because
    // `JSON.stringify` produced an empty object for unrelated reasons.
    const probe = {
      visible: "yes",
      [HarnessId]: "leaked-value",
    };
    expect(JSON.stringify(probe)).toBe('{"visible":"yes"}');
  });

  test("Object.getOwnPropertySymbols exposes the tag", () => {
    const deps = stampedDeps();
    expect(Object.getOwnPropertySymbols(deps)).toContain(HarnessId);
  });

  test("Reflect.ownKeys exposes the tag", () => {
    const deps = stampedDeps();
    expect(Reflect.ownKeys(deps)).toContain(HarnessId);
  });
});

// ---------------------------------------------------------------------------
// runInference — source-identity stamping on inference events
//
// The harness snapshots `{id, provider, model}` from the active source at
// the top of the call and stamps that descriptor onto every inference.usage
// and inference.done event for that call. The snapshot defends against
// `applyInferenceSourceFields` (or any other in-place mutation of the
// shared source object) firing between call start and inference.done: the
// identity stamped onto the events must reflect the source that *began*
// the call, not whatever the active source happens to be at done-time.
// ---------------------------------------------------------------------------

describe("runInference — source-identity stamping", () => {
  test("emits LastCycleSource on inference.done matching the call-start source", async () => {
    const deps: Dependencies = {
      fetch: () =>
        Promise.resolve(
          new Response("", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      scheduler: createDefaultScheduler(),
      adapters: createBuiltinRegistry(),
    };
    let seq = 0;
    const events = await collect(
      runInference({
        turns: [userTurn("hi")],
        source: SOURCE,
        nextSeq: () => ++seq,
        deps,
      }),
    );

    const doneEvent = events.find((e) => e.type === "inference.done");
    if (doneEvent === undefined) throw new Error("missing inference.done");
    expect(doneEvent.data.source).toEqual({
      sourceId: SOURCE.id,
      provider: SOURCE.provider,
      model: SOURCE.model,
    });
  });

  test("two calls with different sources stamp their own descriptor", async () => {
    const sourceA: InferenceSource = {
      id: "anthropic:claude-A",
      provider: "anthropic",
      baseURL: "https://api.anthropic.com",
      apiKey: "test",
      model: "claude-A",
    };
    const sourceB: InferenceSource = {
      id: "openai:gpt-B",
      provider: "openai",
      baseURL: "https://api.openai.test/v1",
      apiKey: "test",
      model: "gpt-B",
    };
    const deps: Dependencies = {
      fetch: () =>
        Promise.resolve(
          new Response("", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      scheduler: createDefaultScheduler(),
      adapters: createBuiltinRegistry(),
    };

    let seq = 0;
    const eventsA = await collect(
      runInference({
        turns: [userTurn("call-A")],
        source: sourceA,
        nextSeq: () => ++seq,
        deps,
      }),
    );
    const doneA = eventsA.find((e) => e.type === "inference.done");
    if (doneA === undefined) throw new Error("missing inference.done for A");
    expect(doneA.data.source).toEqual({
      sourceId: "anthropic:claude-A",
      provider: "anthropic",
      model: "claude-A",
    });

    seq = 0;
    const eventsB = await collect(
      runInference({
        turns: [userTurn("call-B")],
        source: sourceB,
        nextSeq: () => ++seq,
        deps,
      }),
    );
    const doneB = eventsB.find((e) => e.type === "inference.done");
    if (doneB === undefined) throw new Error("missing inference.done for B");
    expect(doneB.data.source).toEqual({
      sourceId: "openai:gpt-B",
      provider: "openai",
      model: "gpt-B",
    });
  });

  test("hot-swap mid-call: inference.done reflects the call-start source, not the post-mutation fields", async () => {
    // Simulate the harness's `setSource` pattern: a single InferenceSource
    // object is mutated in place via `applyInferenceSourceFields`. If the
    // call captured a reference to the live object instead of snapshotting
    // its identifying fields, the descriptor on inference.done would
    // observe whatever id/provider/model the swap mutated in.
    const activeSource: InferenceSource = {
      id: "anthropic:claude-pre",
      provider: "anthropic",
      baseURL: "https://api.anthropic.com",
      apiKey: "test",
      model: "claude-pre",
    };

    // Mutate the source between fetch invocation and stream consumption.
    // The Response body resolves synchronously here, but the harness still
    // reads `source.*` (model in the request body) on the way out; the
    // post-mutation values must NOT show up on the inference.done event
    // because the snapshot at call start already captured the pre-swap
    // identity.
    const deps: Dependencies = {
      fetch: () => {
        activeSource.id = "openai:gpt-post";
        activeSource.provider = "openai";
        activeSource.baseURL = "https://api.openai.test/v1";
        activeSource.apiKey = "test-post";
        activeSource.model = "gpt-post";
        return Promise.resolve(
          new Response("", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        );
      },
      scheduler: createDefaultScheduler(),
      adapters: createBuiltinRegistry(),
    };

    let seq = 0;
    const events = await collect(
      runInference({
        turns: [userTurn("hi")],
        source: activeSource,
        nextSeq: () => ++seq,
        deps,
      }),
    );

    const doneEvent = events.find((e) => e.type === "inference.done");
    if (doneEvent === undefined) throw new Error("missing inference.done");
    expect(doneEvent.data.source).toEqual({
      sourceId: "anthropic:claude-pre",
      provider: "anthropic",
      model: "claude-pre",
    });
  });
});

describe("runInference — adapter-signalled stream termination", () => {
  // A Responses-style protocol whose end-of-turn is a semantic event
  // (`response.completed`), not `[DONE]` or a socket close. The adapter reports
  // that event as terminal via `isStreamTerminal`; the harness must stop
  // reading once it is processed rather than blocking on the next read.
  const RESPONSES_SOURCE: InferenceSource = {
    id: "test-responses:model",
    provider: "test-responses",
    baseURL: "https://example.test",
    apiKey: "test",
    model: "model",
  };

  const responsesAdapterFactory: AdapterFactory = (source) => ({
    buildRequest: () => ({
      url: "https://example.test/responses",
      headers: {},
      body: "{}",
    }),
    parseResponse: (sseData) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(sseData);
      } catch (cause) {
        throw new ProtocolMismatchError(
          `test-responses: malformed JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
          sseData,
        );
      }
      const event = parsed as Record<string, unknown>;
      if (event["type"] === "response.output_text.delta") {
        return [
          {
            type: "inference.text.delta",
            seq: 0,
            data: {
              token: String(event["delta"]),
              partial: { text: "" },
              index: 0,
            },
          },
        ];
      }
      if (event["type"] === "response.completed") {
        return [
          {
            type: "inference.usage",
            seq: 0,
            data: {
              usage: {
                input: 3,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                thinking: 0,
              },
              source,
            },
          },
        ];
      }
      return [];
    },
    isStreamTerminal: (sseData) => {
      try {
        return (
          (JSON.parse(sseData) as Record<string, unknown>)["type"] ===
          "response.completed"
        );
      } catch {
        return false;
      }
    },
  });

  function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let i = 0;
    return new ReadableStream({
      pull(controller) {
        const chunk = chunks[i];
        if (chunk === undefined) {
          controller.close();
          return;
        }
        i += 1;
        controller.enqueue(encoder.encode(chunk));
      },
    });
  }

  test("stops reading after the terminal event and does not consume later chunks", async () => {
    // A poison chunk of malformed JSON sits AFTER `response.completed`. If the
    // harness kept reading past the terminal event it would parse the poison
    // and surface an `inference.error`; breaking on the terminal event means it
    // is never read, so the turn finishes clean. This is the regression guard
    // for the freeze: on the real Codex backend the post-completion chunk is an
    // open connection rather than poison, but the read discipline is identical.
    const deps: Dependencies = {
      fetch: () =>
        Promise.resolve(
          new Response(
            sseStream([
              `data: {"type":"response.output_text.delta","delta":"hi"}\n\n`,
              `data: {"type":"response.completed","response":{}}\n\n`,
              `data: {not valid json\n\n`,
            ]),
            {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            },
          ),
        ),
      scheduler: createDefaultScheduler(),
      adapters: createAdapterRegistry({
        "test-responses": responsesAdapterFactory,
      }),
    };

    let seq = 0;
    const events = await collect(
      runInference({
        turns: [userTurn("hello")],
        source: RESPONSES_SOURCE,
        nextSeq: () => ++seq,
        deps,
      }),
    );

    const errorEvent = events.find((e) => e.type === "inference.error");
    expect(errorEvent).toBeUndefined();

    const doneEvent = events.find((e) => e.type === "inference.done");
    if (doneEvent === undefined) throw new Error("missing inference.done");

    const textBlock = doneEvent.data.turn.content.find(
      (b) => b.type === "text",
    );
    if (textBlock === undefined || textBlock.type !== "text") {
      throw new Error("expected a text block in the finalized turn");
    }
    expect(textBlock.text).toBe("hi");
  });
});

// ---------------------------------------------------------------------------
// runInference — incremental delivery and memory-linear buffering
//
// The wrapper streams an attempt's committed content to the caller as it
// arrives rather than buffering the whole attempt and flushing at
// termination. Two consequences are pinned here:
//
//   * Memory: the wrapper's retained buffer holds only pre-commit
//     metadata, so the number of undelivered events in flight stays a
//     small constant regardless of output length. Under the old
//     buffer-everything model that gap scaled with the token count.
//
//   * Commitment: once a content delta has been delivered it cannot be
//     un-emitted, so a later failure is surfaced rather than retried; a
//     failure that lands before any content is still retried cleanly.
// ---------------------------------------------------------------------------

describe("runInference — incremental delivery and memory-linear buffering", () => {
  const STREAM_SOURCE: InferenceSource = {
    id: "test-stream:model",
    provider: "test-stream",
    baseURL: "https://example.test",
    apiKey: "test",
    model: "model",
  };

  // A minimal adapter that turns compact JSON lines into content deltas.
  // `partial` is stubbed on the raw events because the harness owns the
  // running partial state and re-snapshots it on every emit.
  const streamAdapterFactory: AdapterFactory = () => ({
    buildRequest: () => ({
      url: "https://example.test/stream",
      headers: {},
      body: "{}",
    }),
    parseResponse: (sseData) => {
      const msg = JSON.parse(sseData) as Record<string, unknown>;
      switch (msg["kind"]) {
        case "text":
          return [
            {
              type: "inference.text.delta",
              seq: 0,
              data: { token: String(msg["token"]), partial: { text: "" }, index: 0 },
            },
          ];
        case "thinking":
          return [
            {
              type: "inference.thinking.delta",
              seq: 0,
              data: { token: String(msg["token"]), partial: { text: "" }, index: 0 },
            },
          ];
        case "tool_start":
          return [
            {
              type: "inference.tool_call.start",
              seq: 0,
              data: {
                callId: String(msg["id"]),
                name: String(msg["name"]),
                partial: { text: "" },
                index: 0,
              },
            },
          ];
        case "tool_arg":
          return [
            {
              type: "inference.tool_call.delta",
              seq: 0,
              data: {
                callId: String(msg["id"]),
                argumentFragment: String(msg["frag"]),
                partial: { text: "" },
              },
            },
          ];
        default:
          return [];
      }
    },
  });

  function makeStream(opts: {
    chunks: string[];
    counters?: { produced: number };
    beforeProduce?: (index: number) => Promise<void> | void;
  }): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let i = 0;
    return new ReadableStream({
      async pull(controller) {
        if (i >= opts.chunks.length) {
          controller.close();
          return;
        }
        const index = i;
        if (opts.beforeProduce !== undefined) await opts.beforeProduce(index);
        const chunk = opts.chunks[index];
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(chunk));
        i += 1;
        if (opts.counters !== undefined) opts.counters.produced = i;
      },
    });
  }

  function streamDeps(body: ReadableStream<Uint8Array>): Dependencies {
    return {
      fetch: () =>
        Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      scheduler: createDefaultScheduler(),
      adapters: createAdapterRegistry({ "test-stream": streamAdapterFactory }),
    };
  }

  function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(msg)), ms),
      ),
    ]);
  }

  function textChunks(n: number, token = "x"): string[] {
    return Array.from(
      { length: n },
      () => `data: ${JSON.stringify({ kind: "text", token })}\n\n`,
    );
  }

  // Drive a long stream, tracking the largest gap between events produced
  // at the wire and events delivered to the caller. That gap is the depth
  // of the wrapper's retained buffer — the quantity CL-3259 makes linear.
  // The `done` event is kept for correctness assertions; per-delta events
  // are deliberately not retained so the test itself stays linear.
  async function runLongStream(opts: {
    chunks: string[];
    counters: { produced: number };
    isDelivered: (event: InferenceEvent) => boolean;
  }): Promise<{
    done: Extract<InferenceEvent, { type: "inference.done" }> | undefined;
    delivered: number;
    maxGap: number;
  }> {
    const deps = streamDeps(makeStream({ chunks: opts.chunks, counters: opts.counters }));
    let seq = 0;
    let delivered = 0;
    let maxGap = 0;
    let done: Extract<InferenceEvent, { type: "inference.done" }> | undefined;
    for await (const ev of runInference({
      turns: [userTurn("hi")],
      source: STREAM_SOURCE,
      nextSeq: () => ++seq,
      deps,
    })) {
      if (ev.type === "inference.done") done = ev;
      if (opts.isDelivered(ev)) {
        delivered += 1;
        const gap = opts.counters.produced - delivered;
        if (gap > maxGap) maxGap = gap;
      }
    }
    return { done, delivered, maxGap };
  }

  const GAP_BOUND = 20;

  test("retained buffer depth stays bounded as output length grows", async () => {
    const small = await runLongStream({
      chunks: textChunks(100),
      counters: { produced: 0 },
      isDelivered: (e) => e.type === "inference.text.delta",
    });
    const large = await runLongStream({
      chunks: textChunks(2000),
      counters: { produced: 0 },
      isDelivered: (e) => e.type === "inference.text.delta",
    });

    expect(small.delivered).toBe(100);
    expect(large.delivered).toBe(2000);
    // Old buffer-everything behavior held every delta event before
    // delivering the first, so this gap scaled with N (~100 then ~2000).
    // Streaming committed deltas keeps it a small constant either way —
    // the signature of memory linear (not quadratic) in output length.
    expect(small.maxGap).toBeLessThan(GAP_BOUND);
    expect(large.maxGap).toBeLessThan(GAP_BOUND);
  });

  test("long text stream assembles correctly with bounded buffering", async () => {
    const n = 1000;
    const { done, delivered, maxGap } = await runLongStream({
      chunks: textChunks(n, "x"),
      counters: { produced: 0 },
      isDelivered: (e) => e.type === "inference.text.delta",
    });
    expect(delivered).toBe(n);
    expect(maxGap).toBeLessThan(GAP_BOUND);
    if (done === undefined) throw new Error("missing inference.done");
    const block = done.data.turn.content.find((b) => b.type === "text");
    if (block === undefined || block.type !== "text") {
      throw new Error("expected a text block");
    }
    expect(block.text).toBe("x".repeat(n));
  });

  test("long reasoning stream assembles correctly with bounded buffering", async () => {
    const n = 1000;
    const chunks = Array.from(
      { length: n },
      () => `data: ${JSON.stringify({ kind: "thinking", token: "r" })}\n\n`,
    );
    const { done, delivered, maxGap } = await runLongStream({
      chunks,
      counters: { produced: 0 },
      isDelivered: (e) => e.type === "inference.thinking.delta",
    });
    expect(delivered).toBe(n);
    expect(maxGap).toBeLessThan(GAP_BOUND);
    if (done === undefined) throw new Error("missing inference.done");
    const block = done.data.turn.content.find((b) => b.type === "thinking");
    if (block === undefined || block.type !== "thinking") {
      throw new Error("expected a thinking block");
    }
    expect(block.thinking).toBe("r".repeat(n));
  });

  test("long tool-argument stream assembles correctly with bounded buffering", async () => {
    const bigValue = "a".repeat(4000);
    const inner = JSON.stringify({ data: bigValue });
    const argChunks: string[] = [];
    for (let p = 0; p < inner.length; p += 8) {
      const frag = inner.slice(p, p + 8);
      argChunks.push(
        `data: ${JSON.stringify({ kind: "tool_arg", id: "call_1", frag })}\n\n`,
      );
    }
    const chunks = [
      `data: ${JSON.stringify({ kind: "tool_start", id: "call_1", name: "do_thing" })}\n\n`,
      ...argChunks,
    ];
    const { done, delivered, maxGap } = await runLongStream({
      chunks,
      counters: { produced: 0 },
      isDelivered: (e) => e.type === "inference.tool_call.delta",
    });
    expect(delivered).toBe(argChunks.length);
    expect(maxGap).toBeLessThan(GAP_BOUND);
    if (done === undefined) throw new Error("missing inference.done");
    const block = done.data.turn.content.find((b) => b.type === "tool_call");
    if (block === undefined || block.type !== "tool_call") {
      throw new Error("expected a tool_call block");
    }
    expect(block.arguments["data"]).toBe(bigValue);
  });

  test("delivers committed deltas incrementally instead of buffering to the end", async () => {
    const n = 8;
    let delivered = 0;
    let notify: (() => void) | null = null;
    const waitUntilDelivered = (count: number): Promise<void> => {
      if (delivered >= count) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const check = (): void => {
          if (delivered >= count) {
            notify = null;
            resolve();
          } else {
            notify = check;
          }
        };
        notify = check;
      });
    };
    // Gate wire chunk `index` behind delivery of `index` deltas to the
    // caller. A wrapper that buffered the whole attempt before delivering
    // anything would never let `delivered` advance past 0, deadlocking the
    // producer — so completing at all proves deltas flow mid-stream.
    const deps = streamDeps(
      makeStream({
        chunks: textChunks(n, "z"),
        beforeProduce: (index) => waitUntilDelivered(index),
      }),
    );
    let seq = 0;
    const received = await withTimeout(
      (async () => {
        const tokens: string[] = [];
        for await (const ev of runInference({
          turns: [userTurn("hi")],
          source: STREAM_SOURCE,
          nextSeq: () => ++seq,
          deps,
        })) {
          if (ev.type === "inference.text.delta") {
            delivered += 1;
            notify?.();
            tokens.push(ev.data.token);
          }
        }
        return tokens;
      })(),
      2000,
      "incremental delivery deadlocked — the wrapper buffered instead of streaming",
    );
    expect(received.length).toBe(n);
  });

  test("retries an uncommitted failure and delivers exactly one clean stream", async () => {
    let calls = 0;
    const deps: Dependencies = {
      fetch: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve(
            new Response("upstream unavailable", { status: 503 }),
          );
        }
        return Promise.resolve(
          new Response(makeStream({ chunks: textChunks(1, "hello") }), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        );
      },
      scheduler: createDefaultScheduler(),
      adapters: createAdapterRegistry({ "test-stream": streamAdapterFactory }),
    };
    let seq = 0;
    const events = await collect(
      runInference({
        turns: [userTurn("hi")],
        source: STREAM_SOURCE,
        inferenceOptions: {
          retryPolicy: ({ attempt }) =>
            attempt < 2 ? { kind: "retry", delayMs: 0 } : { kind: "abort" },
        },
        nextSeq: () => ++seq,
        deps,
      }),
    );
    expect(calls).toBe(2);
    // The discarded attempt's inference.start does not leak: the caller
    // sees exactly one, no orphaned error, one retry marker.
    expect(events.filter((e) => e.type === "inference.start")).toHaveLength(1);
    expect(events.filter((e) => e.type === "inference.retry")).toHaveLength(1);
    expect(events.some((e) => e.type === "inference.error")).toBe(false);
    const done = events.find((e) => e.type === "inference.done");
    if (done === undefined) throw new Error("missing inference.done");
    const block = done.data.turn.content.find((b) => b.type === "text");
    expect(block !== undefined && block.type === "text" ? block.text : "").toBe(
      "hello",
    );
  });

  test("suppresses retry once output is committed and surfaces the error", async () => {
    let calls = 0;
    const deps: Dependencies = {
      fetch: () => {
        calls += 1;
        const encoder = new TextEncoder();
        let i = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (i < 2) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ kind: "text", token: `p${String(i)}` })}\n\n`,
                ),
              );
              i += 1;
              return;
            }
            controller.error(new Error("connection reset mid-stream"));
          },
        });
        return Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        );
      },
      scheduler: createDefaultScheduler(),
      adapters: createAdapterRegistry({ "test-stream": streamAdapterFactory }),
    };
    let seq = 0;
    const events = await collect(
      runInference({
        turns: [userTurn("hi")],
        source: STREAM_SOURCE,
        // A policy that would always retry — proving that commitment, not
        // the policy, is what suppresses the retry here.
        inferenceOptions: { retryPolicy: () => ({ kind: "retry", delayMs: 0 }) },
        nextSeq: () => ++seq,
        deps,
      }),
    );
    // No second attempt: the committed prefix cannot be un-emitted.
    expect(calls).toBe(1);
    const tokens = events
      .filter((e) => e.type === "inference.text.delta")
      .map((e) => (e.type === "inference.text.delta" ? e.data.token : ""));
    expect(tokens).toEqual(["p0", "p1"]);
    expect(events.some((e) => e.type === "inference.retry")).toBe(false);
    const errorIndex = events.findIndex((e) => e.type === "inference.error");
    expect(errorIndex).toBeGreaterThan(-1);
    const lastDeltaIndex = events
      .map((e) => e.type)
      .lastIndexOf("inference.text.delta");
    // The committed deltas precede the surfaced error in one clean stream.
    expect(lastDeltaIndex).toBeLessThan(errorIndex);
  });

  test("cancellation interrupts promptly after output has started", async () => {
    const controller = new AbortController();
    let delivered = 0;
    let notify: (() => void) | null = null;
    const waitUntilDelivered = (count: number): Promise<void> => {
      if (delivered >= count) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const check = (): void => {
          if (delivered >= count) {
            notify = null;
            resolve();
          } else {
            notify = check;
          }
        };
        notify = check;
      });
    };
    const n = 1000;
    const deps = streamDeps(
      makeStream({
        chunks: textChunks(n, "y"),
        beforeProduce: (index) => waitUntilDelivered(index),
      }),
    );
    let seq = 0;
    const received: InferenceEvent[] = [];
    await withTimeout(
      (async () => {
        for await (const ev of runInference({
          turns: [userTurn("hi")],
          source: STREAM_SOURCE,
          signal: controller.signal,
          nextSeq: () => ++seq,
          deps,
        })) {
          received.push(ev);
          if (ev.type === "inference.text.delta") {
            delivered += 1;
            notify?.();
            if (delivered === 1) controller.abort();
          }
        }
      })(),
      2000,
      "cancellation did not interrupt the stream",
    );
    const deltaCount = received.filter(
      (e) => e.type === "inference.text.delta",
    ).length;
    // The abort cut the stream far short of its full length.
    expect(deltaCount).toBeGreaterThanOrEqual(1);
    expect(deltaCount).toBeLessThan(n);
    const error = received.find((e) => e.type === "inference.error");
    if (error === undefined) throw new Error("missing aborted inference.error");
    expect(error.data.error.category).toBe("aborted");
  });
});
