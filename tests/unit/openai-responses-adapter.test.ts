import { test, expect, describe } from "bun:test";
import {
  createOpenAIResponsesAdapter,
  OPENAI_SESSION_ID_OPTION,
} from "../../src/provider/openai-responses.js";
import { OPENCODE_SESSION_ID_OPTION } from "../../src/provider/opencode-session.js";
import { BEARER_CREDENTIAL_SENTINEL } from "@intx/inference";
import type {
  ConversationTurn,
  InferenceOptions,
  LastCycleSource,
} from "@intx/types/runtime";

const SOURCE: LastCycleSource = {
  sourceId: "go/default",
  provider: "openai-responses",
  model: "gpt-5.6-luna",
};

function adapter() {
  return createOpenAIResponsesAdapter(SOURCE);
}

function userTurn(text: string): ConversationTurn {
  return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

describe("openai-responses buildRequest", () => {
  test("targets the Responses path with store off and streaming on", () => {
    const req = adapter().buildRequest([userTurn("hi")], "gpt-5.6-luna", {});
    expect(req.url).toBe("/responses");
    expect(req.headers["authorization"]).toBe(BEARER_CREDENTIAL_SENTINEL);
    expect(req.headers["accept"]).toBe("text/event-stream");
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body["model"]).toBe("gpt-5.6-luna");
    expect(body["stream"]).toBe(true);
    expect(body["store"]).toBe(false);
  });

  test("sets prompt_cache_key from the session id, stable across builds", () => {
    const options: InferenceOptions = {
      providerOptions: { [OPENAI_SESSION_ID_OPTION]: "sess-1" },
    };
    const first = JSON.parse(
      adapter().buildRequest([userTurn("a")], "gpt-5.6-luna", options).body,
    ) as Record<string, unknown>;
    const second = JSON.parse(
      adapter().buildRequest([userTurn("b")], "gpt-5.6-luna", options).body,
    ) as Record<string, unknown>;
    expect(first["prompt_cache_key"]).toBe("sess-1");
    expect(second["prompt_cache_key"]).toBe("sess-1");
  });

  test("distinct session ids yield distinct prompt_cache_keys", () => {
    const bodyFor = (sessionId: string): Record<string, unknown> =>
      JSON.parse(
        adapter().buildRequest([userTurn("hi")], "gpt-5.6-luna", {
          providerOptions: { [OPENAI_SESSION_ID_OPTION]: sessionId },
        }).body,
      ) as Record<string, unknown>;
    expect(bodyFor("sess-1")["prompt_cache_key"]).toBe("sess-1");
    expect(bodyFor("sess-2")["prompt_cache_key"]).toBe("sess-2");
  });

  test("omits prompt_cache_key when no session id is present", () => {
    const body = JSON.parse(
      adapter().buildRequest([userTurn("hi")], "gpt-5.6-luna", {}).body,
    ) as Record<string, unknown>;
    expect(body).not.toHaveProperty("prompt_cache_key");
  });
});

describe("openai-responses x-opencode-session header", () => {
  test("sets the header from the opencode session id without leaking it into the body", () => {
    const req = adapter().buildRequest([userTurn("hi")], "gpt-5.6-luna", {
      providerOptions: { [OPENCODE_SESSION_ID_OPTION]: "sess-1" },
    });
    expect(req.headers["x-opencode-session"]).toBe("sess-1");
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body).not.toHaveProperty("opencodeSessionId");
    expect(body).not.toHaveProperty("prompt_cache_key");
  });

  test("omits the header when no opencode session id is present", () => {
    const req = adapter().buildRequest([userTurn("hi")], "gpt-5.6-luna", {
      providerOptions: { [OPENAI_SESSION_ID_OPTION]: "sess-1" },
    });
    expect(req.headers["x-opencode-session"]).toBeUndefined();
  });

  test("omits the header when no options are present", () => {
    const req = adapter().buildRequest([userTurn("hi")], "gpt-5.6-luna", {});
    expect(req.headers["x-opencode-session"]).toBeUndefined();
  });
});

describe("openai-responses Retry-After extraction", () => {
  test("extracts Retry-After pacing from response headers", () => {
    const responses = adapter();
    expect(
      responses.extractRetryAfterMs?.(new Headers({ "retry-after": "7" })),
    ).toBe(7_000);
    expect(
      responses.extractRetryAfterMs?.(
        new Headers({ "retry-after-ms": "1500" }),
      ),
    ).toBe(1_500);
    expect(responses.extractRetryAfterMs?.(new Headers({}))).toBeUndefined();
  });
});
