import { describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { type Agent } from "@intx/agent";
import { getLogger } from "@intx/log";
import type { InferenceSource } from "@intx/types/runtime";

import * as codexSession from "../../auth/codex/session.js";
import { createChatDirector } from "../../agent/director.js";
import { createSubAgentSessionStore } from "../../subagent/session-store.js";
import type {
  ReactorAction,
  ReactorCapabilities,
  ReactorInboundEvent,
  ReactorState,
} from "@intx/types/runtime";
import { LOG_NAMESPACE_ROOT } from "../../branding.js";
import { defined } from "../../../tests/helpers/defined.js";
import {
  createDeliveryGeneration,
  createSessionOperationQueue,
} from "../delivery-queue.js";
import {
  createRunLifecycle,
  finalizeTUIRun,
  resetSessionForRotation,
} from "./exit.js";
import type { RunnerServices, RunnerState } from "./state.js";

function stubQuit(args: {
  awaitTail: () => Promise<void>;
  shutdownRuntime: () => Promise<void>;
}): {
  state: RunnerState;
  services: RunnerServices;
} {
  const state = {
    host: {
      waitUntilExit: async () => undefined,
    },
    shutdownRuntime: args.shutdownRuntime,
    runError: undefined,
    streamPromise: Promise.resolve(),
    config: { cwd: "/tmp", task: "t" },
    sessionId: "s",
    startedAt: 1,
    runTaskTitle: "t",
    connectedMcpServers: [],
    liveSource: { id: "p", model: "m" },
  } as unknown as RunnerState;
  const services = {
    sessionOps: {
      enqueue: async () => undefined,
      awaitTail: args.awaitTail,
    },
    cycleRecorder: { dispose: async () => "" },
    mcpConnectController: new AbortController(),
    runSink: {
      getTurnCollector: () => null,
      getRunError: () => undefined,
      getStatus: () => "done",
      getTurnCount: () => 0,
      getTokenUsage: () => ({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        thinking: 0,
      }),
      getToolCallCount: () => 0,
    },
    crashGuard: { markFinalized: () => undefined, isFinalized: () => false },
    activeRunHandle: { task: "", startedAt: 0, turnsUsed: 0, model: "" },
    hookManager: { dispatchPostRun: async () => undefined },
    liveSessionMode: "orchestrator",
  } as unknown as RunnerServices;
  return { state, services };
}

describe("finalizeTUIRun quit order", () => {
  test("starts runtime shutdown without waiting on a hung session-op tail", async () => {
    const order: string[] = [];
    let settleTail: ((err: Error) => void) | undefined;
    const hungTail = new Promise<void>((_, reject) => {
      settleTail = reject;
    });
    const { state, services } = stubQuit({
      awaitTail: async () => {
        order.push("tail");
        await hungTail;
      },
      shutdownRuntime: async () => {
        order.push("shutdown");
      },
    });

    const pending = finalizeTUIRun(state, services);
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(order[0]).toBe("shutdown");
    } finally {
      defined(settleTail, "settleTail")(new Error("stop"));
    }
    await expect(pending).rejects.toThrow("stop");
  });

  test("logs a runtime shutdown failure instead of swallowing it", async () => {
    const logger = getLogger([LOG_NAMESPACE_ROOT, "tui"]);
    const errorSpy = spyOn(logger, "error");
    let settleTail: ((err: Error) => void) | undefined;
    const hungTail = new Promise<void>((_, reject) => {
      settleTail = reject;
    });
    const { state, services } = stubQuit({
      awaitTail: () => hungTail,
      shutdownRuntime: async () => {
        throw new Error("plugin dispose failed");
      },
    });

    const pending = finalizeTUIRun(state, services);
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(errorSpy).toHaveBeenCalled();
      const logged = errorSpy.mock
        .calls as unknown as readonly (readonly unknown[])[];
      const first = logged[0];
      expect(first).toBeDefined();
      expect(String(first?.[0])).toMatch(/shutdown/i);
      expect(first?.[1]).toEqual({ error: "plugin dispose failed" });
    } finally {
      errorSpy.mockRestore();
      defined(settleTail, "settleTail")(new Error("stop"));
    }
    await expect(pending).rejects.toThrow("stop");
  });
});

const liveSource: InferenceSource = {
  id: "codex/work",
  provider: "openai",
  baseURL: "https://example.test",
  credentialId: "codex/work",
  model: "m",
};

function recordingAgent(sends: string[]): Agent {
  return {
    send: async (content) => {
      sends.push(typeof content === "string" ? content : String(content));
      return { type: "reply", reply: "", turn: {} as never };
    },
    stream: async function* stream() {
      yield* [];
    },
    deliver: () => undefined,
    close: async () => undefined,
    setSource: () => undefined,
    setSources: () => undefined,
    history: async () => [],
    checkpoints: async () => [],
    readAt: async () => [],
    get blobReader() {
      return {} as Agent["blobReader"];
    },
  };
}

function stubSendLifecycle(agent: Agent): {
  state: RunnerState;
  services: RunnerServices;
} {
  const state = {
    runTaskTitle: "keep-title",
    liveSource,
    connectedMcpServers: [],
    config: { cwd: "/tmp", task: "keep-title" },
    sessionId: "s",
    startedAt: 1,
    inFlight: 0,
    fatalBuildError: null,
    sendAborted: false,
    initialCodexProfile: "work",
    initialXaiProfile: undefined,
    stampProvider: { fn: undefined },
  } as unknown as RunnerState;
  const services = {
    crashGuard: {
      isFinalized: () => true,
      setPartialFlush: () => undefined,
    },
    cycleRecorder: {
      dispose: async () => "",
      handleEvent: () => undefined,
    },
    providerFailureAttempts: {},
    correlationAcceptance: { observe: () => undefined },
    runSink: { sink: () => undefined },
    sessionCost: { addTurn: () => undefined },
    buildAgent: async () => agent,
    emitter: new EventEmitter(),
    sessionOps: createSessionOperationQueue(),
    deliveryGeneration: createDeliveryGeneration(),
    toolset: { setToolPromoter: () => undefined },
    subAgentSessions: { cancelAll: async () => [] },
    activeRunHandle: { task: "", startedAt: 0, model: "" },
  } as unknown as RunnerServices;
  return { state, services };
}

function hangCodexRefresh(): {
  settle: (value: { access: string }) => void;
  spy: ReturnType<typeof spyOn>;
} {
  let settle: ((value: { access: string }) => void) | undefined;
  const spy = spyOn(codexSession, "getValidCodexToken").mockImplementation(
    () =>
      new Promise<{ access: string }>((resolve) => {
        settle = resolve;
      }),
  );
  return {
    spy,
    settle: (value) => defined(settle, "settleRefresh")(value),
  };
}

describe("agentProxy.send vs /clear", () => {
  test("a /clear during hung OAuth after awaitTail does not send into the rebuilt agent", async () => {
    const oldSends: string[] = [];
    const newSends: string[] = [];
    const oldAgent = recordingAgent(oldSends);
    const newAgent = recordingAgent(newSends);
    const { state, services } = stubSendLifecycle(oldAgent);
    const hung = hangCodexRefresh();
    try {
      const { agentProxy } = await createRunLifecycle(state, services);
      const pending = agentProxy.send("keep me out of the new session");
      await Promise.resolve();
      await Promise.resolve();

      resetSessionForRotation(state, services);
      state.currentAgent = newAgent;
      hung.settle({ access: "fresh-token" });
      await Promise.allSettled([pending]);

      expect(newSends).toEqual([]);
      expect(oldSends).toEqual([]);
    } finally {
      hung.spy.mockRestore();
    }
  });

  test("hung OAuth after awaitTail still sends when the session is not rotated", async () => {
    const sends: string[] = [];
    const { state, services } = stubSendLifecycle(recordingAgent(sends));
    const hung = hangCodexRefresh();
    try {
      const { agentProxy } = await createRunLifecycle(state, services);
      const pending = agentProxy.send("deliver this");
      await Promise.resolve();
      await Promise.resolve();
      hung.settle({ access: "fresh-token" });
      await pending;
      expect(sends).toEqual(["deliver this"]);
    } finally {
      hung.spy.mockRestore();
    }
  });
});

const rebuildMockState: ReactorState = {} as unknown as ReactorState;

const rebuildMockCapabilities: ReactorCapabilities = {
  infer: (options) =>
    ({
      type: "infer",
      ...(options !== undefined ? { options } : {}),
    }) as ReactorAction,
  executeTools: (calls) => ({ type: "execute_tools", calls }),
  suspend: (gate) => ({ type: "suspend", gate }),
  fork: (mode, forkId) => ({ type: "fork", mode, forkId }),
  emit: (eventType, data) => ({ type: "emit", eventType, data }),
  reply: (content) => ({ type: "reply", content }),
  checkpoint: (message = "") => ({ type: "checkpoint", message }),
  compact: (compactor, reason) => ({ type: "compact", compactor, reason }),
  wait: () => ({ type: "wait" }),
  done: () => ({ type: "done" }),
};

function rebuildManageTasksEvent(): ReactorInboundEvent {
  return {
    type: "inference.done",
    turn: {
      role: "assistant",
      model: "test",
      timestamp: 0,
      content: [
        {
          type: "tool_call",
          id: "m",
          name: "manage_tasks",
          arguments: {
            action: "create",
            tasks: [{ id: "t1", title: "work", status: "doing" }],
          },
        },
      ],
    },
    usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    source: { model: "test-model" },
  } as unknown as ReactorInboundEvent;
}

function rebuildTextTurn(): ReactorInboundEvent {
  return {
    type: "inference.done",
    turn: {
      role: "assistant",
      model: "test",
      timestamp: 0,
      content: [{ type: "text", text: "all set" }],
    },
    usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    source: { model: "test-model" },
  } as unknown as ReactorInboundEvent;
}

describe("rebuild re-syncs idle-with-fleet while drained", () => {
  test("reload-if-idle and interrupt rebuilds resume the open-task nudge with no fleet transition", async () => {
    const store = createSubAgentSessionStore();
    const directorHolder: RunnerServices["directorHolder"] = {};
    const agent = recordingAgent([]);
    const { state, services } = stubSendLifecycle(agent);
    services.directorHolder =
      directorHolder as unknown as RunnerServices["directorHolder"];
    services.subAgentSessions =
      store as unknown as RunnerServices["subAgentSessions"];
    services.workflowHost = {
      reattach: () => undefined,
    } as unknown as RunnerServices["workflowHost"];
    services.cycleRecorder = {
      dispose: async () => "",
      reset: () => undefined,
      handleEvent: () => undefined,
    } as unknown as RunnerServices["cycleRecorder"];
    services.buildAgent = (async () => {
      // Every rebuild mints a fresh director from the static true seed (fleet
      // lanes may appear mid-session), exactly like the TUI session assembly.
      directorHolder.instance = createChatDirector("base", [], {
        allowIdleWithFleet: true,
      });
      return agent;
    }) as unknown as RunnerServices["buildAgent"];
    const fleetEvents: unknown[] = [];
    services.emitter.on("event", (event: { type: string }) => {
      if (event.type === "fleet") fleetEvents.push(event);
    });
    await createRunLifecycle(state, services);
    const expectOpenTaskNudge = async (): Promise<void> => {
      const director = defined(
        directorHolder.instance,
        "directorHolder.instance",
      );
      await director.decide(
        rebuildManageTasksEvent(),
        rebuildMockState,
        rebuildMockCapabilities,
      );
      const actions = await director.decide(
        rebuildTextTurn(),
        rebuildMockState,
        rebuildMockCapabilities,
      );
      const list = Array.isArray(actions) ? actions : [actions];
      expect(list.some((action) => action.type === "infer")).toBe(true);
    };
    // Drained fleet: the idle reload rebuilds onto the static true seed.
    state.pendingReload = true;
    defined(state.reloadIfIdle, "reloadIfIdle")();
    await services.sessionOps.awaitTail();
    expect(state.fatalBuildError).toBeNull();
    await expectOpenTaskNudge();
    // The interrupt rebuild inherits the same seed.
    defined(state.interrupt, "interrupt")();
    await services.sessionOps.awaitTail();
    expect(state.fatalBuildError).toBeNull();
    await expectOpenTaskNudge();
    expect(store.list()).toEqual([]);
    expect(fleetEvents).toEqual([]);
  });
});
