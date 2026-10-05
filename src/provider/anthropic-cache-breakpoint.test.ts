import { describe, expect, test } from "bun:test";
import type { AdapterRegistry, ProviderAdapter } from "@intx/inference";
import { createBuiltinRegistry } from "@intx/inference/providers";
import type {
  ConversationTurn,
  InferenceOptions,
  LastCycleSource,
} from "@intx/types/runtime";
import { withAnthropicCacheBreakpoint } from "./anthropic-cache-breakpoint.js";
import { createZenAnthropicAdapter } from "./anthropic-session-adapter.js";

function sourceFor(provider: string): LastCycleSource {
  return { sourceId: `test-${provider}`, provider, model: "test-model" };
}

const inner: AdapterRegistry = {
  has: (provider) => createBuiltinRegistry().has(provider),
  resolve: (source) => {
    if (source.provider === "zen-messages") {
      return createZenAnthropicAdapter(source);
    }
    return createBuiltinRegistry().resolve(source);
  },
};

const adapters = withAnthropicCacheBreakpoint(inner);

// Builtin Anthropic still hoists `role: "system"` into `body.system`. Newer
// models keep mid-conversation system in `messages`; this stub is that wire.
function preservingSystemAdapter(): ProviderAdapter {
  return {
    buildRequest(turns) {
      const messages = turns.map((turn, index) => {
        const content: WireBlock[] = turn.content.flatMap((block) => {
          if (block.type !== "text") return [];
          return [{ text: block.text }];
        });
        const isLastNonAssistant =
          turn.role !== "assistant" &&
          turns.slice(index + 1).every((rest) => rest.role === "assistant");
        const last = content[content.length - 1];
        if (isLastNonAssistant && last !== undefined) {
          last.cache_control = { type: "ephemeral" };
        }
        return { role: turn.role, content };
      });
      return {
        url: "https://example.test/messages",
        headers: {},
        body: JSON.stringify({ messages }),
      };
    },
    parseResponse: () => [],
    parseJSONResponse: () => [],
  };
}

const systemWireAdapters = withAnthropicCacheBreakpoint({
  has: (provider) => provider === "anthropic" || provider === "zen-messages",
  resolve: () => preservingSystemAdapter(),
});

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

type WireBlock = {
  cache_control?: unknown;
  text?: string;
  name?: string;
};

type WireBody = {
  messages: { role: string; content: WireBlock[] }[];
  system?: WireBlock[];
  tools?: WireBlock[];
};

function wireBody(body: string): WireBody {
  return JSON.parse(body) as WireBody;
}

function build(provider: string, options: InferenceOptions): WireBody {
  const persisted = [userTurn("q1"), assistantTurn("a1"), userTurn("q2")];
  const nudge = userTurn("wrap up soon");
  const request = adapters
    .resolve(sourceFor(provider))
    .buildRequest([...persisted, nudge], "test-model", {
      ...options,
      ephemeralTurns: [nudge],
    } as InferenceOptions);
  return wireBody(request.body);
}

describe("anthropic cache breakpoint with ephemeral turns", () => {
  // anthropic = builtin adapter path; zen-messages = session-header wrapper
  // path. opencode-go-messages shares the wrapper shape with zen-messages.
  for (const provider of ["anthropic", "zen-messages"]) {
    test(`${provider}: breakpoint lands on the last persisted user turn, not the ephemeral tail`, () => {
      const body = build(provider, {});

      expect(body.messages).toHaveLength(4);
      expect(body.messages[3]?.content[0]?.text).toBe("wrap up soon");
      expect(
        body.messages[2]?.content[body.messages[2].content.length - 1]
          ?.cache_control,
      ).toEqual({ type: "ephemeral" });
      expect(
        body.messages[3]?.content.filter(
          (block) => block.cache_control !== undefined,
        ),
      ).toEqual([]);
    });
  }

  for (const provider of ["anthropic", "zen-messages"]) {
    test(`${provider}: system-role ephemeral stays in messages and off the cached prefix`, () => {
      const persisted = [userTurn("q1"), assistantTurn("a1"), userTurn("q2")];
      const inject = systemTurn("inject");
      const request = systemWireAdapters
        .resolve(sourceFor(provider))
        .buildRequest([...persisted, inject], "test-model", {
          ephemeralTurns: [inject],
        } as InferenceOptions);
      const body = wireBody(request.body);

      expect(body.messages).toHaveLength(4);
      expect(body.messages[3]?.role).toBe("system");
      expect(body.messages[3]?.content[0]?.text).toBe("inject");
      expect(
        body.messages[2]?.content[body.messages[2].content.length - 1]
          ?.cache_control,
      ).toEqual({ type: "ephemeral" });
      expect(
        body.messages[3]?.content.filter(
          (block) => block.cache_control !== undefined,
        ),
      ).toEqual([]);
    });
  }

  test("builtin adapter + systemPrompt drops system-role ephemeral from messages", () => {
    const persisted = [userTurn("q1"), assistantTurn("a1"), userTurn("q2")];
    const inject = systemTurn("inject");
    const request = adapters
      .resolve(sourceFor("anthropic"))
      .buildRequest([...persisted, inject], "test-model", {
        systemPrompt: "stable prompt",
        ephemeralTurns: [inject],
      } as InferenceOptions);
    const body = wireBody(request.body);

    expect(body.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(
      body.messages.flatMap((message) =>
        message.content.map((block) => block.text),
      ),
    ).not.toContain("inject");
    expect(body.system?.[0]?.text).toBe("stable prompt");
  });

  test("system and tools breakpoints stay untouched while the nudge is attached", () => {
    const persisted = [
      { ...userTurn("sys"), role: "system" as const },
      userTurn("q1"),
      assistantTurn("a1"),
      userTurn("q2"),
    ];
    const nudge = userTurn("wrap up soon");
    const request = adapters
      .resolve(sourceFor("anthropic"))
      .buildRequest([...persisted, nudge], "test-model", {
        ephemeralTurns: [nudge],
        tools: [{ name: "run_shell", description: "run", inputSchema: {} }],
      } as InferenceOptions);
    const body = wireBody(request.body);

    expect(body.system?.[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools?.[body.tools.length - 1]?.cache_control).toEqual({
      type: "ephemeral",
    });
    expect(
      body.messages[2]?.content[body.messages[2].content.length - 1]
        ?.cache_control,
    ).toEqual({ type: "ephemeral" });
    expect(
      body.messages[3]?.content.filter(
        (block) => block.cache_control !== undefined,
      ),
    ).toEqual([]);
  });

  test("without ephemeral turns the request is byte-identical to the base adapter", () => {
    const turns = [userTurn("q1"), assistantTurn("a1"), userTurn("q2")];
    const base = inner
      .resolve(sourceFor("anthropic"))
      .buildRequest(turns, "test-model", {});
    const wrapped = adapters
      .resolve(sourceFor("anthropic"))
      .buildRequest(turns, "test-model", {});
    expect(wrapped.body).toBe(base.body);
  });

  test("non-anthropic providers pass through untouched", () => {
    const persisted = [userTurn("q1"), assistantTurn("a1"), userTurn("q2")];
    const nudge = userTurn("wrap up soon");
    const options = { ephemeralTurns: [nudge] } as InferenceOptions;
    const base = inner
      .resolve(sourceFor("openai"))
      .buildRequest([...persisted, nudge], "test-model", options);
    const wrapped = adapters
      .resolve(sourceFor("openai"))
      .buildRequest([...persisted, nudge], "test-model", options);
    expect(wrapped.body).toBe(base.body);
    expect(wrapped.body).not.toContain("cache_control");
  });
});
