import { describe, test, expect } from "bun:test";

import { createReactor } from "./reactor";
import { createDefaultScheduler } from "./harness";
import type { Dependencies } from "./harness";
import type { ReactorEmittedEvent } from "./reactor";
import type {
  AssistantTurn,
  ContextStore,
  ContextCommit,
  ConversationTurn,
  InboundMessage,
  InferenceEvent,
  ReactorAction,
  ReactorCapabilities,
  ReactorDirector,
  ReactorInboundEvent,
  ReactorState,
  TokenUsage,
  ToolRunner,
  LastCycleSource,
} from "@intx/types/runtime";

// Regression guard for CL-3478: the reactor committed context only at cycle
// terminals (wait/reply/done/suspend). A tool-call turn continued to the next
// inference without committing, so an interrupt that rebuilt the agent from the
// persisted store between the tool batch and the follow-up inference erased the
// assistant tool_call turn and its tool results. The reactor must checkpoint
// after each completed tool cycle (inference + tool results).

function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 };
}

const TEST_SOURCE: LastCycleSource = {
  sourceId: "test-source",
  provider: "test-provider",
  model: "test-model",
};

function stubDeps(): Dependencies {
  // The reactor drives inference through the injected `inferenceRunner`, so the
  // HTTP path is never touched — these are inert placeholders satisfying the
  // required shape.
  return {
    fetch: () => Promise.reject(new Error("fetch must not be called")),
    scheduler: createDefaultScheduler(),
    adapters: {
      resolve() {
        throw new Error("adapters.resolve must not be called");
      },
    },
  };
}

function inboundMessage(): InboundMessage {
  return {
    ref: { uid: 0, mailbox: "inbox" },
    headers: {
      from: "user@local",
      to: ["agent@local"],
      date: new Date(0).toISOString(),
      messageId: "msg-1@local",
    },
    flags: [],
    content: "do the thing",
    signatureStatus: "missing",
  };
}

function assistantToolCallTurn(callId: string, name: string): AssistantTurn {
  return {
    role: "assistant",
    content: [{ type: "tool_call", id: callId, name, arguments: {} }],
    model: "mock-model",
    timestamp: 1000,
  };
}

function assistantTextTurn(text: string): AssistantTurn {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model: "mock-model",
    timestamp: 1000,
  };
}

function noopToolRunner(): ToolRunner {
  return {
    async run(call) {
      return { callId: call.id, content: "ok" };
    },
  };
}

// Records a deep snapshot of history at every commit so we can assert the tool
// cycle was made durable before the follow-up inference ran.
function capturingContextStore(commits: ConversationTurn[][]): ContextStore {
  let latestTurns: ConversationTurn[] = [];
  const notImplemented = () => {
    throw new Error("not implemented");
  };
  return {
    async load() {
      return {
        turns: [],
        pendingOperations: [],
        tokenUsage: emptyUsage(),
        connectorState: null,
      };
    },
    setConnectorState() {
      /* noop */
    },
    async commit(options: { message: string }): Promise<ContextCommit> {
      commits.push([...latestTurns]);
      return { hash: "abc", message: options.message, timestamp: Date.now() };
    },
    async branch() {
      /* noop */
    },
    async log() {
      return [];
    },
    async readAt() {
      return [];
    },
    async writeBlob() {
      /* noop */
    },
    async readBlob() {
      return notImplemented();
    },
    async writePrompt() {
      /* noop */
    },
    async writeResponse() {
      /* noop */
    },
    async writeManifest() {
      /* noop */
    },
    async writeTurns(turns: ConversationTurn[]) {
      latestTurns = [...turns];
    },
    async writeMetadata() {
      /* noop */
    },
    async readManifestHistory() {
      return notImplemented();
    },
  };
}

// Mirrors the real conversational flow: infer, run the emitted tool calls, then
// re-infer with the results, then reply-terminal. The tool-execution and
// tool-done edges each carry a checkpoint, exactly like DefaultDirector.
function conversationalToolDirector(): ReactorDirector {
  return {
    async decide(
      event: ReactorInboundEvent,
      _state: ReactorState,
      caps: ReactorCapabilities,
    ): Promise<ReactorAction | ReactorAction[]> {
      switch (event.type) {
        case "message.received":
          return caps.infer();
        case "inference.done": {
          const hasToolCall = event.turn.content.some(
            (b) => b.type === "tool_call",
          );
          if (hasToolCall) {
            return [
              caps.checkpoint("tool-execution"),
              caps.executeTools([{ id: "c1", name: "probe", arguments: {} }], true),
            ];
          }
          return [caps.checkpoint("final"), caps.done()];
        }
        case "tool.done":
          return [caps.checkpoint("tool-done"), caps.infer()];
        default:
          return caps.done();
      }
    },
  };
}

describe("createReactor — mid-cycle tool checkpoint durability", () => {
  test("commits the inference + tool results before the next inference", async () => {
    const commits: ConversationTurn[][] = [];
    let inferenceCount = 0;

    const events: ReactorEmittedEvent[] = [];
    const reactor = createReactor({
      sessionId: "test-checkpoint",
      director: conversationalToolDirector(),
      source: {
        id: "test:model",
        provider: "test",
        baseURL: "https://example.test",
        apiKey: "test",
        model: "model",
      },
      toolRunner: noopToolRunner(),
      contextStore: capturingContextStore(commits),
      onEvent: (e) => events.push(e),
      deps: stubDeps(),
      shutdownTimeoutMs: 100,
      inferenceRunner: async function* (opts) {
        inferenceCount += 1;
        const turn =
          inferenceCount === 1
            ? assistantToolCallTurn("c1", "probe")
            : assistantTextTurn("all done");
        yield {
          type: "inference.done",
          seq: opts.nextSeq(),
          data: { turn, usage: emptyUsage(), source: TEST_SOURCE },
        } satisfies InferenceEvent;
      },
    });

    reactor.start();
    reactor.deliver(inboundMessage());

    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error("timed out waiting for reactor.done")),
        2000,
      );
      const check = () => {
        if (events.some((e) => e.type === "reactor.done")) {
          clearTimeout(deadline);
          resolve();
          return;
        }
        setTimeout(check, 10);
      };
      check();
    });

    const lastTurnHasToolResult = (turns: ConversationTurn[]): boolean => {
      const last = turns[turns.length - 1];
      return (
        last !== undefined && last.content.some((b) => b.type === "tool_result")
      );
    };

    // Some commit captured the tool cycle with the tool_result as its final
    // turn — the exchange was durable before the second inference.
    const toolCycleCommit = commits.find(lastTurnHasToolResult);
    expect(toolCycleCommit).toBeDefined();
    if (toolCycleCommit === undefined) return;

    // That durable snapshot includes the assistant tool_call turn the result
    // answers, so a rebuild reloads a well-formed exchange.
    const hasAssistantToolCall = toolCycleCommit.some(
      (t) =>
        t.role === "assistant" && t.content.some((b) => b.type === "tool_call"),
    );
    expect(hasAssistantToolCall).toBe(true);

    // Both inferences ran, so the durable tool-cycle snapshot landed mid-cycle
    // rather than only at the terminal.
    expect(inferenceCount).toBe(2);
  });
});
