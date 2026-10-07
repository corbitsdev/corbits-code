import { describe, test, expect } from "bun:test";
import { BEARER_CREDENTIAL_SENTINEL } from "@intx/inference";
import type {
  ConversationTurn,
  InferenceOptions,
  LastCycleSource,
  ToolDefinition,
} from "@intx/types/runtime";
import {
  createOpenAIResponsesAdapter,
  hostQuirks,
  OPENAI_SESSION_ID_OPTION,
} from "./openai-responses.js";
import { OPENCODE_SESSION_ID_OPTION } from "./opencode-session.js";
import { createAdvertisedToolset } from "../session/assemble-runtime.js";

describe("OpenCode Go Responses quirks", () => {
  // Muse Spark batches independent tool calls into one turn by default —
  // three reads in a single response. Sending parallel_tool_calls: false
  // collapses that to one call per turn and triples the turn count on a
  // bounded task, so leaving the quirk unset keeps the gateway default.
  test("leaves parallel_tool_calls unset so the gateway default stands", () => {
    expect(hostQuirks.parallelToolCalls).toBeUndefined();
  });
});

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

  test("omits prompt_cache_key when no session id is present", () => {
    const body = JSON.parse(
      adapter().buildRequest([userTurn("hi")], "gpt-5.6-luna", {}).body,
    ) as Record<string, unknown>;
    expect(body).not.toHaveProperty("prompt_cache_key");
  });
});

describe("openai-responses promotion cache safety", () => {
  function def(name: string): ToolDefinition {
    return {
      name,
      description: `${name} tool`,
      inputSchema: { type: "object", properties: {} },
    };
  }

  // The tools array is the head of the provider's cached prefix, so a
  // mid-session activation must not change the serialized request body —
  // the turns differ only in activated tools.
  test("activating a tool mid-session leaves the serialized wire body byte-identical", () => {
    const advertised = createAdvertisedToolset({
      sessionMode: "orchestrator",
      toolAvailability: { languageServerAvailable: false },
      getProvider: () => ({ providerName: "openai", model: "gpt-5.6-luna" }),
    });
    const defs = [
      def("read_file"),
      def("write_file"),
      def("tool_search"),
      def("mcp__linear__list_issues"),
    ];
    const bodyFor = (tools: ToolDefinition[]): string =>
      adapter().buildRequest([userTurn("hi")], "gpt-5.6-luna", { tools }).body;
    const before = bodyFor(advertised.computeAdvertised(defs));
    expect(JSON.parse(before)).toHaveProperty("tools");

    advertised.activated.activate(["mcp__linear__list_issues"]);

    const after = bodyFor(advertised.computeAdvertised(defs));
    expect(after).toBe(before);
    expect(advertised.isAdvertised("mcp__linear__list_issues")).toBe(true);
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
