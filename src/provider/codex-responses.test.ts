import { describe, expect, test } from "bun:test";
import { BEARER_CREDENTIAL_SENTINEL } from "@intx/inference";
import type { ConversationTurn, LastCycleSource } from "@intx/types/runtime";
import { ENVIRONMENT_TAG_NAME, PRODUCT_NAME } from "../branding.js";
import {
  CODEX_ACCOUNT_ID_OPTION,
  CODEX_RESPONSES_PROVIDER,
  CODEX_SESSION_ID_OPTION,
  createCodexResponsesAdapter,
} from "./codex-responses.js";

const source: LastCycleSource = {
  sourceId: "codex/test",
  provider: CODEX_RESPONSES_PROVIDER,
  model: "gpt-5.1-codex",
};

function userTurn(text: string): ConversationTurn {
  return { role: "user", timestamp: 0, content: [{ type: "text", text }] };
}

describe("createCodexResponsesAdapter", () => {
  test("forwards providerOptions.reasoning_effort onto reasoning.effort", () => {
    const adapter = createCodexResponsesAdapter(source);
    const request = adapter.buildRequest([userTurn("hello")], "gpt-5.1-codex", {
      providerOptions: { reasoning_effort: "high" },
    });
    const body = JSON.parse(request.body) as {
      reasoning?: { effort?: string };
    };
    expect(body.reasoning).toEqual({ effort: "high" });
  });

  test("omits reasoning when effort is none or unset", () => {
    const adapter = createCodexResponsesAdapter(source);
    const unset = JSON.parse(
      adapter.buildRequest([userTurn("hello")], "gpt-5.1-codex", {}).body,
    ) as { reasoning?: unknown };
    const none = JSON.parse(
      adapter.buildRequest([userTurn("hello")], "gpt-5.1-codex", {
        providerOptions: { reasoning_effort: "none" },
      }).body,
    ) as { reasoning?: unknown };
    expect(unset.reasoning).toBeUndefined();
    expect(none.reasoning).toBeUndefined();
  });

  test("lifts host account and session option keys into Codex headers", () => {
    const adapter = createCodexResponsesAdapter(source);
    const request = adapter.buildRequest([userTurn("hi")], "gpt-5.1-codex", {
      providerOptions: {
        [CODEX_ACCOUNT_ID_OPTION]: "acct-1",
        [CODEX_SESSION_ID_OPTION]: "sess-1",
      },
    });
    expect(request.url).toBe("/codex/responses");
    expect(request.headers["authorization"]).toBe(BEARER_CREDENTIAL_SENTINEL);
    expect(request.headers["chatgpt-account-id"]).toBe("acct-1");
    expect(request.headers["session_id"]).toBe("sess-1");
    const body = JSON.parse(request.body) as { prompt_cache_key?: string };
    expect(body.prompt_cache_key).toBe("sess-1");
  });

  test("wraps the system prompt with host product identity as a developer item", () => {
    const adapter = createCodexResponsesAdapter(source);
    const request = adapter.buildRequest([userTurn("x")], "gpt-5.1-codex", {
      systemPrompt: "be terse",
    });
    const body = JSON.parse(request.body) as {
      instructions?: unknown;
      input: { role?: string; content?: { text?: string }[] }[];
    };
    expect(body.instructions).toBeUndefined();
    expect(body.input[0]?.role).toBe("developer");
    const wrapped = body.input[0]?.content?.[0]?.text ?? "";
    expect(wrapped).toContain(`<${ENVIRONMENT_TAG_NAME} priority="0">`);
    expect(wrapped).toContain(`${PRODUCT_NAME} is the harness`);
    expect(wrapped).toContain("be terse");
    expect(body.input[1]?.role).toBe("user");
  });
});
