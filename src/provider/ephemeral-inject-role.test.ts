import { describe, expect, test } from "bun:test";
import { createBuiltinRegistry } from "@intx/inference/providers";
import type {
  ConversationTurn,
  InferenceOptions,
  LastCycleSource,
} from "@intx/types/runtime";
import {
  adapterPreservesMidSystem,
  ephemeralInjectRole,
  midConversationSystemSupported,
} from "./ephemeral-inject-role.js";

function sourceFor(provider: string): LastCycleSource {
  return { sourceId: `test-${provider}`, provider, model: "test-model" };
}

function userTurn(text: string): ConversationTurn {
  return {
    role: "user",
    timestamp: 0,
    content: [{ type: "text", text }],
  };
}

function assistantTurn(text: string): ConversationTurn {
  return {
    role: "assistant",
    timestamp: 0,
    content: [{ type: "text", text }],
  };
}

function systemTurn(text: string): ConversationTurn {
  return {
    role: "system",
    timestamp: 0,
    content: [{ type: "text", text }],
  };
}

type WireBody = {
  messages: { role: string; content: { text?: string }[] }[];
  system?: { text?: string }[];
};

function wireBody(body: string): WireBody {
  return JSON.parse(body) as WireBody;
}

function systemText(body: WireBody): string {
  return (body.system ?? []).map((block) => block.text ?? "").join("\n\n");
}

describe("midConversationSystemSupported", () => {
  const providers = ["anthropic", "zen-messages", "opencode-go-messages"];
  const models = [
    "fable",
    "mythos",
    "claude-opus-4-8",
    "claude-opus-4.8",
    "claude-opus-5",
  ];
  for (const provider of providers) {
    for (const model of models) {
      test(`supports ${provider} / ${model}`, () => {
        expect(midConversationSystemSupported(provider, model)).toBe(true);
      });
    }
  }

  test("rejects non-anthropic providers even on new models", () => {
    expect(midConversationSystemSupported("openai", "fable")).toBe(false);
    expect(midConversationSystemSupported("openai", "claude-opus-5")).toBe(
      false,
    );
  });

  test("rejects older models on anthropic providers", () => {
    expect(
      midConversationSystemSupported("anthropic", "claude-sonnet-4-5"),
    ).toBe(false);
    expect(
      midConversationSystemSupported("zen-messages", "claude-opus-4-6"),
    ).toBe(false);
  });
});

describe("ephemeralInjectRole", () => {
  test("adapter does not preserve mid-conversation system turns", () => {
    expect(adapterPreservesMidSystem()).toBe(false);
  });

  test("never returns system, even where mid-conversation system is supported", () => {
    for (const provider of [
      "anthropic",
      "zen-messages",
      "opencode-go-messages",
      "openai",
    ]) {
      for (const model of ["fable", "mythos", "claude-opus-4-8", "other"]) {
        expect(ephemeralInjectRole(provider, model)).toBe("user");
      }
    }
  });
});

describe("builtin anthropic adapter vs system-role inject (real registry, no stubs)", () => {
  const persisted = [userTurn("q1"), assistantTurn("a1")];
  const injectText = "wrap up soon";

  test("mid-conversation system turn is hoisted to the head system block", () => {
    const request = createBuiltinRegistry()
      .resolve(sourceFor("anthropic"))
      .buildRequest(
        [...persisted, systemTurn(injectText)],
        "claude-opus-4-8",
        {},
      );
    const body = wireBody(request.body);
    expect(body.messages.some((m) => m.role === "system")).toBe(false);
    expect(systemText(body)).toContain(injectText);
  });

  test("with systemPrompt set, a system-role inject is dropped", () => {
    const options = { systemPrompt: "STABLE PROMPT" } as InferenceOptions;
    const request = createBuiltinRegistry()
      .resolve(sourceFor("anthropic"))
      .buildRequest(
        [...persisted, systemTurn(injectText)],
        "claude-opus-4-8",
        options,
      );
    const body = wireBody(request.body);
    expect(systemText(body)).toBe("STABLE PROMPT");
    expect(JSON.stringify(body.messages)).not.toContain(injectText);
  });
});
