/**
 * run.ts must actually wire ask_director park into compact-continue deferral
 * and SubAgentDirector.observeAskPending. Pure latch / director tests cannot
 * see those two call sites — removing either would still pass them.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DirectorFactory } from "@intx/agent";
import type {
  ReactorAction,
  ReactorCapabilities,
  ReactorInboundEvent,
  ReactorState,
} from "@intx/types/runtime";

import { withMockedModuleDuring } from "../../tests/helpers/mock-module.js";
import { defined } from "../../tests/helpers/defined.js";
import { createPermissionGate } from "../permission/gate.js";
import type { RunSubAgentParams } from "./types.js";
import type { AskDirectorState } from "./ask-director.js";
import { SubAgentDirector } from "./nudge-director.js";

const testPermissionGate = createPermissionGate({
  approvals: [],
  interactive: false,
  skipPermissions: true,
  reactorGated: false,
});

function createHangingStubAgent(deliverLog: unknown[]) {
  return {
    async send(_content: string, optsSend?: { signal?: AbortSignal }) {
      return await new Promise((_, reject) => {
        if (optsSend?.signal?.aborted === true) {
          reject(
            optsSend.signal.reason instanceof Error
              ? optsSend.signal.reason
              : new Error("aborted"),
          );
          return;
        }
        optsSend?.signal?.addEventListener(
          "abort",
          () => {
            const reason = optsSend.signal?.reason;
            reject(reason instanceof Error ? reason : new Error("aborted"));
          },
          { once: true },
        );
      });
    },
    stream: () =>
      (async function* () {
        yield* [];
      })(),
    deliver: (message: unknown) => {
      deliverLog.push(message);
    },
    close: async () => undefined,
    setSource: () => undefined,
    setSources: () => undefined,
    history: async () => [],
    checkpoints: async () => [],
    readAt: async () => [],
    blobReader: {},
  };
}

function capabilities(): ReactorCapabilities {
  return {
    infer: (options) =>
      ({
        type: "infer",
        ...(options !== undefined ? { options } : {}),
      }) as ReactorAction,
    executeTools: (calls, parallel, addToHistory) =>
      ({
        type: "execute_tools",
        calls,
        parallel,
        addToHistory,
      }) as ReactorAction,
    suspend: (gate) => ({ type: "suspend", gate }) as ReactorAction,
    fork: (mode, forkId) => ({ type: "fork", mode, forkId }) as ReactorAction,
    emit: (eventType, data) =>
      ({ type: "emit", eventType, data }) as ReactorAction,
    reply: (content) => ({ type: "reply", content }) as ReactorAction,
    checkpoint: (message = "") =>
      ({ type: "checkpoint", message }) as ReactorAction,
    compact: (compactor, reason) =>
      ({ type: "compact", compactor, reason }) as ReactorAction,
    wait: () => ({ type: "wait" }) as ReactorAction,
    done: () => ({ type: "done" }) as ReactorAction,
  };
}

function emptyContinuation(): ReactorInboundEvent {
  return {
    type: "message.received",
    message: { role: "user", content: "" },
  } as unknown as ReactorInboundEvent;
}

function actions(result: ReactorAction | ReactorAction[]): ReactorAction[] {
  return Array.isArray(result) ? result : [result];
}

describe("runSubAgent ask_director compact-continue wiring", () => {
  test("park defers compact continue; flush and observeAskPending are actually called", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cl8045-ask-continue-"));
    const deliverLog: unknown[] = [];
    let flushCalls = 0;
    let requestContinuation: (() => void) | undefined;
    let capturedAskHandler:
      | ((
          rawArgs: Record<string, unknown>,
          signal: AbortSignal,
        ) => Promise<string> | string)
      | undefined;
    let capturedFactory: DirectorFactory | undefined;
    const state = { turns: [] } as unknown as ReactorState;

    const outcome = await withMockedModuleDuring(
      import.meta.resolve("./ask-director.js"),
      (real: typeof import("./ask-director.js")) => ({
        ...real,
        createDeferredContinuation: () => {
          const latch = real.createDeferredContinuation();
          return {
            request: (askState: AskDirectorState, deliver: () => void) => {
              latch.request(askState, deliver);
            },
            flush: (askState: AskDirectorState, deliver: () => void) => {
              flushCalls += 1;
              latch.flush(askState, deliver);
            },
          };
        },
      }),
      async () =>
        await withMockedModuleDuring(
          import.meta.resolve("../agent/compaction.js"),
          (real: typeof import("../agent/compaction.js")) => ({
            ...real,
            createCompactionGovernor: (
              request: (() => void) | undefined,
              ...rest: unknown[]
            ) => {
              requestContinuation = request;
              return (
                real.createCompactionGovernor as (
                  ...args: unknown[]
                ) => ReturnType<typeof real.createCompactionGovernor>
              )(request, ...rest);
            },
          }),
          async () =>
            await withMockedModuleDuring(
              import.meta.resolve("@intx/agent"),
              (real: typeof import("@intx/agent")) => ({
                ...real,
                defineDirector: (
                  opts: Parameters<typeof real.defineDirector>[0],
                ) => {
                  capturedFactory = opts.factory;
                  return real.defineDirector(opts);
                },
                stringTool: (args: Parameters<typeof real.stringTool>[0]) => {
                  const tool = real.stringTool(args);
                  if (args.definition.name === "ask_director") {
                    capturedAskHandler = args.handler;
                  }
                  return tool;
                },
              }),
              async () =>
                await withMockedModuleDuring(
                  import.meta.resolve("../agent/live-tool-dispatch.js"),
                  (real: typeof import("../agent/live-tool-dispatch.js")) => ({
                    ...real,
                    createAgentWithLiveToolDispatch: async () =>
                      createHangingStubAgent(deliverLog) as unknown as Awaited<
                        ReturnType<typeof real.createAgentWithLiveToolDispatch>
                      >,
                  }),
                  async () => {
                    const { runSubAgent } = await import("./run.js");
                    let resolveAsk: ((answer: string) => void) | undefined;
                    let handles:
                      | {
                          close: (ms?: number) => Promise<void>;
                        }
                      | undefined;

                    const params: RunSubAgentParams = {
                      cwd,
                      workdirBase: join(cwd, ".ctx"),
                      permissionGate: testPermissionGate,
                      provider: {
                        providerName: "test",
                        baseURL: "http://localhost",
                        model: "test-model",
                      },
                      description: "ask-director continue wiring",
                      prompt: "hold for ask_director",
                      persist: true,
                      tier: "leaf",
                      askDirectorPort: {
                        register: () =>
                          new Promise<string>((resolve) => {
                            resolveAsk = resolve;
                          }),
                        cancel: () => undefined,
                      },
                      onAgentReady: (h) => {
                        handles = h;
                      },
                    };

                    const runPromise = runSubAgent(params);
                    for (let i = 0; i < 500 && handles === undefined; i++) {
                      await new Promise((resolve) => setTimeout(resolve, 1));
                    }
                    if (handles === undefined) {
                      throw new Error("onAgentReady never fired");
                    }
                    if (capturedFactory === undefined) {
                      throw new Error("defineDirector factory not seen");
                    }
                    if (capturedAskHandler === undefined) {
                      throw new Error("ask_director tool was not mounted");
                    }

                    const director = capturedFactory({}, {} as never, {
                      systemPrompt: "system",
                      toolDefinitions: [],
                      compactorNames: [],
                    });
                    if (!(director instanceof SubAgentDirector)) {
                      throw new Error(
                        "factory did not return SubAgentDirector",
                      );
                    }
                    if (requestContinuation === undefined) {
                      throw new Error("requestContinuation was not captured");
                    }

                    const askPromise = capturedAskHandler(
                      { question: "which file?" },
                      new AbortController().signal,
                    );
                    for (let i = 0; i < 500 && resolveAsk === undefined; i++) {
                      await new Promise((resolve) => setTimeout(resolve, 1));
                    }
                    if (resolveAsk === undefined) {
                      throw new Error("ask_director never registered");
                    }

                    const parkedPing = actions(
                      await director.decide(
                        emptyContinuation(),
                        state,
                        capabilities(),
                      ),
                    );
                    expect(parkedPing).toEqual([{ type: "wait" }]);
                    expect(
                      parkedPing.some((action) => action.type === "infer"),
                    ).toBe(false);

                    const deliveredWhileParked = deliverLog.length;
                    requestContinuation();
                    expect(deliverLog.length).toBe(deliveredWhileParked);

                    defined(resolveAsk)("src/foo.ts");
                    expect(await askPromise).toBe("src/foo.ts");
                    expect(flushCalls).toBeGreaterThan(0);
                    expect(deliverLog.length).toBe(deliveredWhileParked + 1);

                    await handles.close().catch(() => undefined);
                    await runPromise.catch(() => undefined);
                    return { flushCalls, delivered: deliverLog.length };
                  },
                ),
            ),
        ),
    );

    expect(outcome.flushCalls).toBeGreaterThan(0);
    expect(outcome.delivered).toBe(1);
  });
});
