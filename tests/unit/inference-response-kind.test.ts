/**
 * Regression coverage for Codex responses that omit the Content-Type header.
 * The live backend does this for some models (observed with gpt-5.6-sol /
 * gpt-5.6-luna): HTTP 200 with a valid SSE body and no Content-Type at all,
 * which the vendored harness's protocol detection treats as an unrecoverable
 * error. withCodexContentTypeRepair restores the header at the fetch boundary
 * from the protocol the request's accept header declared, scoped to Codex
 * responses requests only; everything else keeps the loud failure.
 */
import { describe, expect, test } from "bun:test";
import {
  createDefaultScheduler,
  runInference,
  type Dependencies,
} from "@intx/inference";
import type {
  ConversationTurn,
  InferenceEvent,
  InferenceSource,
} from "@intx/types/runtime";
import { createInferenceDependencies } from "../../src/provider/inference-dependencies.js";
import {
  CODEX_RESPONSES_PROVIDER,
  withCodexContentTypeRepair,
} from "../../src/provider/codex-responses-adapter.js";
import { CODEX_RESPONSES_PATH } from "../../src/auth/codex/constants.js";

const CODEX_URL = `https://chatgpt.com/backend-api${CODEX_RESPONSES_PATH}`;

const CODEX_SOURCE: InferenceSource = {
  id: "codex/default",
  provider: CODEX_RESPONSES_PROVIDER,
  baseURL: "https://chatgpt.com/backend-api",
  apiKey: "test-token",
  model: "gpt-5.6-sol",
};

function userTurn(text: string): ConversationTurn {
  return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

const SSE_PAYLOADS = [
  { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
  { type: "response.output_text.delta", item_id: "item_1", delta: "hello" },
  {
    type: "response.completed",
    response: {
      id: "resp_1",
      status: "completed",
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    },
  },
];

/** SSE wire body from data payloads, streamed so Response infers no Content-Type. */
function sseBody(payloads: readonly object[]): ReadableStream<Uint8Array> {
  const wire = payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join("");
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(wire));
      controller.close();
    },
  });
}

function headerlessResponse(body: BodyInit): Response {
  const response = new Response(body, { status: 200 });
  response.headers.delete("content-type");
  return response;
}

async function collect(iter: AsyncIterable<InferenceEvent>): Promise<InferenceEvent[]> {
  const out: InferenceEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

async function runCodexTurn(fetchImpl: Dependencies["fetch"]): Promise<InferenceEvent[]> {
  const base = await createInferenceDependencies();
  const deps: Dependencies = {
    ...base,
    fetch: withCodexContentTypeRepair(fetchImpl),
    scheduler: createDefaultScheduler(),
  };
  let seq = 0;
  return collect(
    runInference({
      turns: [userTurn("hi")],
      source: CODEX_SOURCE,
      nextSeq: () => ++seq,
      deps,
    }),
  );
}

describe("withCodexContentTypeRepair through the harness", () => {
  test("headerless 2xx SSE stream completes instead of failing the turn", async () => {
    const events = await runCodexTurn(() => {
      const response = headerlessResponse(sseBody(SSE_PAYLOADS));
      expect(response.headers.get("content-type")).toBeNull();
      return Promise.resolve(response);
    });
    const types = events.map((e) => e.type);

    expect(types).not.toContain("inference.error");
    expect(types).toContain("inference.text.delta");
    expect(types).toContain("inference.done");
  });

  test("declared unsupported Content-Type still fails loudly", async () => {
    const events = await runCodexTurn(() =>
      Promise.resolve(
        new Response("<html></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    const error = events.find((e) => e.type === "inference.error");

    expect(error).toBeDefined();
    expect(JSON.stringify(error)).toContain("Unsupported response Content-Type");
  });
});

describe("withCodexContentTypeRepair boundaries", () => {
  const sseInit: RequestInit = {
    method: "POST",
    headers: { accept: "text/event-stream", "content-type": "application/json" },
  };

  test("restores text/event-stream from an SSE accept header", async () => {
    const fetchImpl = withCodexContentTypeRepair(() =>
      Promise.resolve(headerlessResponse(sseBody(SSE_PAYLOADS))),
    );
    const response = await fetchImpl(CODEX_URL, sseInit);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
  });

  test("restores application/json from a JSON accept header", async () => {
    const fetchImpl = withCodexContentTypeRepair(() =>
      Promise.resolve(headerlessResponse(sseBody([]))),
    );
    const response = await fetchImpl(CODEX_URL, {
      method: "POST",
      headers: { accept: "application/json" },
    });
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  test("leaves an ambiguous accept header unrepaired", async () => {
    const fetchImpl = withCodexContentTypeRepair(() =>
      Promise.resolve(headerlessResponse(sseBody([]))),
    );
    for (const accept of ["*/*", "application/json, text/event-stream"]) {
      const response = await fetchImpl(CODEX_URL, {
        method: "POST",
        headers: { accept },
      });
      expect(response.headers.get("content-type")).toBeNull();
    }
  });

  test("reads the accept header from a Request-object input", async () => {
    const fetchImpl = withCodexContentTypeRepair(() =>
      Promise.resolve(headerlessResponse(sseBody(SSE_PAYLOADS))),
    );
    const response = await fetchImpl(
      new Request(CODEX_URL, {
        method: "POST",
        headers: { accept: "text/event-stream" },
      }),
    );
    expect(response.headers.get("content-type")).toBe("text/event-stream");
  });

  test("leaves non-Codex URLs untouched", async () => {
    const fetchImpl = withCodexContentTypeRepair(() =>
      Promise.resolve(headerlessResponse(sseBody([]))),
    );
    const response = await fetchImpl("https://api.example.com/v1/messages", sseInit);
    expect(response.headers.get("content-type")).toBeNull();
  });

  test("createInferenceDependencies wires the repair into its fetch", async () => {
    // A fresh module instance (cache-busted specifier) binds our stubbed
    // globalThis.fetch at creation time, so this exercises the production
    // wiring itself — the cached instance other tests share is untouched
    // and no test-order dependence is introduced.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      () => Promise.resolve(headerlessResponse(sseBody(SSE_PAYLOADS))),
      { preconnect: () => undefined },
    ) as typeof globalThis.fetch;
    try {
      const specifier =
        "../../src/provider/inference-dependencies.js" + "?wiring-regression";
      const mod = (await import(specifier)) as {
        createInferenceDependencies: () => Promise<Dependencies>;
      };
      const deps = await mod.createInferenceDependencies();
      const response = await deps.fetch(CODEX_URL, sseInit);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("leaves declared Content-Type and non-2xx responses untouched", async () => {
    const declared = withCodexContentTypeRepair(() =>
      Promise.resolve(
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      ),
    );
    const declaredResponse = await declared(CODEX_URL, sseInit);
    expect(declaredResponse.headers.get("content-type")).toBe("application/json");

    const failing = withCodexContentTypeRepair(() => {
      const response = new Response("nope", { status: 429 });
      response.headers.delete("content-type");
      return Promise.resolve(response);
    });
    const failingResponse = await failing(CODEX_URL, sseInit);
    expect(failingResponse.headers.get("content-type")).toBeNull();
    expect(failingResponse.status).toBe(429);
  });
});
