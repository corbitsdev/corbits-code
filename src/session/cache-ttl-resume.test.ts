import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createInboundMessage } from "@intx/mime";
import { createReactor, type ReactorEmittedEvent } from "@intx/inference";
import { createDefaultDependencies } from "@intx/inference/providers";
import type {
  ConversationTurn,
  InferenceEvent,
  InferenceSource,
  ReactorAction,
} from "@intx/types/runtime";
import { createChatDirector } from "../agent/director.js";
import {
  COMPACTION_CONTINUATION_EVENT,
  lastCycleSourceFromRunModel,
} from "../agent/compaction.js";
import {
  buildAnthropicSource,
  buildGoSource,
  buildOpenAISource,
  buildZenSource,
} from "../config/index.js";
import { resumeCacheWriteSeed } from "../provider/cache-ttl.js";
import { HANDOFF_LATEST_KEY } from "./compaction-handoff.js";
import { createPruningCompactor } from "./compactor.js";
import { createOptimizedContextStore } from "./optimized-context-store.js";
import { buildCompactionContinuationMessage } from "./runtime-assembly.js";

const MINUTE_MS = 60_000;
const USAGE = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  thinking: 0,
};

function userTurn(text: string, timestamp: number): ConversationTurn {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function texts(turns: readonly ConversationTurn[]): string[] {
  return turns.flatMap((turn) =>
    turn.content.flatMap((block) =>
      block.type === "text" ? [block.text] : [],
    ),
  );
}

function seedTurns(): ConversationTurn[] {
  const filler = "prior-detail ".repeat(400);
  return Array.from({ length: 12 }, (_, index) =>
    userTurn(`turn-${index} ${filler}`, index + 1),
  );
}

function actionsOf(result: ReactorAction | ReactorAction[]): ReactorAction[] {
  return Array.isArray(result) ? result : [result];
}

async function resumeAndInfer(args: {
  at: number;
  source: InferenceSource;
}): Promise<{
  first: ReactorAction[];
  stored: ConversationTurn[];
  prompt: ConversationTurn[];
  handoff: string | undefined;
  seed: ConversationTurn[];
}> {
  const seed = seedTurns();
  const dir = await mkdtemp(join(tmpdir(), "cache-ttl-resume-"));
  try {
    const store = await createOptimizedContextStore(dir);
    await store.writeTurns(seed);
    await store.writeMetadata({
      pendingOperations: [],
      tokenUsage: USAGE,
    });
    await store.commit({ message: "seed" });

    const storedModel = `${args.source.id}:${args.source.model}`;
    const cacheSeed = resumeCacheWriteSeed({
      at: args.at,
      storedModel,
      liveProvider: args.source.id,
      liveProtocol: args.source.provider,
    });
    const source =
      cacheSeed === undefined
        ? undefined
        : lastCycleSourceFromRunModel(cacheSeed.model);
    const director = createChatDirector("test", [], {});
    if (cacheSeed !== undefined && source !== undefined) {
      director.restoreCacheWrite({ at: cacheSeed.at, source, turns: seed });
    }
    const original = director.decide.bind(director);
    let first: ReactorAction[] | undefined;
    director.decide = async (event, state, capabilities) => {
      const result = await original(event, state, capabilities);
      if (first === undefined) first = actionsOf(result);
      return result;
    };

    let prompt: ConversationTurn[] | undefined;
    let storedAtInfer: ConversationTurn[] | undefined;
    let handoff: string | undefined;
    const events: ReactorEmittedEvent[] = [];
    let resolveDone: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const reactor = createReactor({
      sessionId: "cache-ttl-resume",
      director,
      source: args.source,
      toolRunner: {
        async run(call) {
          return { callId: call.id, content: "ok" };
        },
      },
      contextStore: store,
      deps: createDefaultDependencies(),
      doomLoopThreshold: false,
      compactors: {
        "pruning-compactor": createPruningCompactor({
          summarize: async (turns) => {
            const body = texts(turns);
            return `${(body[0] ?? "").slice(0, 400)}\n${(body.at(-1) ?? "").slice(0, 200)}`;
          },
        }),
      },
      inferenceRunner(opts) {
        return (async function* () {
          prompt = opts.turns;
          const loaded = await store.load();
          storedAtInfer = loaded.turns;
          try {
            const bytes = await store.readBlob(HANDOFF_LATEST_KEY);
            handoff = new TextDecoder().decode(bytes);
          } catch {
            handoff = undefined;
          }
          const event: InferenceEvent = {
            type: "inference.done",
            seq: opts.nextSeq(),
            data: {
              turn: {
                role: "assistant",
                content: [{ type: "text", text: "ok" }],
                model: "claude-opus-4-6",
                timestamp: 2,
              },
              usage: USAGE,
              source: {
                sourceId: args.source.id,
                provider: args.source.provider,
                model: args.source.model,
              },
            },
          };
          yield event;
        })();
      },
      onEvent(event) {
        events.push(event);
        if (event.type === COMPACTION_CONTINUATION_EVENT) {
          reactor.deliver(buildCompactionContinuationMessage());
        }
        if (event.type === "inference.done" || event.type === "reactor.error") {
          resolveDone?.();
        }
      },
    });

    reactor.start();
    const started = events.some((event) => event.type === "reactor.start");
    if (!started) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("reactor did not start")),
          5_000,
        );
        const poll = (): void => {
          if (events.some((event) => event.type === "reactor.start")) {
            clearTimeout(timer);
            resolve();
            return;
          }
          setTimeout(poll, 10);
        };
        poll();
      });
    }
    reactor.deliver(
      createInboundMessage({
        from: "user@local",
        to: "agent@local",
        content: "continue the task",
      }),
    );
    await Promise.race([
      done,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("resume infer timed out")), 15_000);
      }),
    ]);
    reactor.abort("admin_kill");
    if (first === undefined) throw new Error("director never decided");
    if (prompt === undefined || storedAtInfer === undefined) {
      throw new Error(
        `infer did not run: ${events.map((event) => event.type).join(",")}`,
      );
    }
    return { first, stored: storedAtInfer, prompt, handoff, seed };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("resumed Anthropic cache write does not compact", () => {
  const native = buildAnthropicSource({
    id: "anthropic",
    baseURL: "https://example.invalid",
    model: "claude-opus-4-6",
  });

  test("an expired Anthropic stamp does not rewrite the stored turns", async () => {
    const result = await resumeAndInfer({
      at: Date.now() - 6 * MINUTE_MS,
      source: native,
    });

    expect(result.first.some((action) => action.type === "compact")).toBe(
      false,
    );
    expect(texts(result.stored)).toEqual(texts(result.seed));
    expect(result.handoff).toBeUndefined();
  });

  test("a write inside 5 minutes leaves the stored turns in place", async () => {
    const result = await resumeAndInfer({
      at: Date.now() - 2 * MINUTE_MS,
      source: native,
    });

    expect(result.first.some((action) => action.type === "compact")).toBe(
      false,
    );
    expect(texts(result.stored)).toEqual(texts(result.seed));
    expect(result.handoff).toBeUndefined();
  });

  test("a non-Anthropic stored stamp does not compact", async () => {
    const result = await resumeAndInfer({
      at: Date.now() - 6 * MINUTE_MS,
      source: buildOpenAISource({
        id: "openai",
        baseURL: "https://example.invalid/v1",
        model: "gpt-5.6",
      }),
    });

    expect(result.first.some((action) => action.type === "compact")).toBe(
      false,
    );
    expect(texts(result.stored)).toEqual(texts(result.seed));
    expect(result.handoff).toBeUndefined();
  });

  test("expired Zen, OpenCode Go, and custom Anthropic catalog ids do not compact", async () => {
    const sources = [
      buildZenSource({
        id: "zen",
        model: "claude-opus-4-6",
        sessionId: "sess-zen",
      }),
      buildGoSource({
        id: "opencode-go",
        model: "minimax-m3",
        sessionId: "sess-go",
      }),
      buildAnthropicSource({
        id: "acme",
        baseURL: "https://example.invalid",
        model: "claude-opus-4-6",
      }),
    ];
    for (const source of sources) {
      expect(source.id).not.toBe(source.provider);
      const result = await resumeAndInfer({
        at: Date.now() - 6 * MINUTE_MS,
        source,
      });
      expect(result.first.some((action) => action.type === "compact")).toBe(
        false,
      );
      expect(texts(result.stored)).toEqual(texts(result.seed));
    }
  });
});
