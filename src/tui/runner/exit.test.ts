import { describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { type Agent } from "@intx/agent";
import { getLogger } from "@intx/log";
import type { InferenceSource } from "@intx/types/runtime";

import * as codexSession from "../../auth/codex/session.js";
import { createChatDirector } from "../../agent/director.js";
import * as sessionIndex from "../../session/index.js";
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
  resyncIdleWithFleetFlag,
} from "./exit.js";
import {
  COMPACTION_ABORTED_REASON,
  createCompactionLifecycle,
} from "../../session/compaction-lifecycle.js";
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

  test("aborts the in-flight compact before runtime shutdown so quit cannot stall", async () => {
    const order: string[] = [];
    let settleTail: ((err: Error) => void) | undefined;
    const hungTail = new Promise<void>((_, reject) => {
      settleTail = reject;
    });
    const lifecycle = createCompactionLifecycle();
    const wrapped = lifecycle.wrapCompactor({
      name: "hang",
      version: "0",
      apply: () =>
        new Promise<never>(() => {
          // Never settles on purpose: the quit abort must win the race.
        }),
    });
    const pending = wrapped.apply([], {} as never);
    expect(lifecycle.isCompacting()).toBe(true);
    const { state, services } = stubQuit({
      awaitTail: async () => {
        order.push("tail");
        await hungTail;
      },
      shutdownRuntime: async () => {
        order.push("shutdown");
        // Shutdown drains the compact: with the abort first this resolves
        // promptly instead of stalling quit behind the hung summary call.
        await pending;
        order.push("shutdown-settled");
      },
    });
    state.compactionLifecycle = {
      abortCompaction: (reason: string) => {
        order.push(`abort:${reason}`);
        lifecycle.abortCompaction(reason);
      },
    } as unknown as NonNullable<RunnerState["compactionLifecycle"]>;

    const done = finalizeTUIRun(state, services);
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(order).toEqual([
        "abort:quit",
        "shutdown",
        "shutdown-settled",
        "tail",
      ]);
      const result = await pending;
      expect(result.record.reason).toBe(COMPACTION_ABORTED_REASON);
      expect(lifecycle.isCompacting()).toBe(false);
    } finally {
      defined(settleTail, "settleTail")(new Error("stop"));
    }
    await expect(done).rejects.toThrow("stop");
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
    directorHolder: {},
    subAgentSessions: { cancelAll: async () => [], list: () => [] },
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
  test("seed then fleet-0 does not leave idle-with-fleet stuck true", async () => {
    const store = createSubAgentSessionStore();
    const director = createChatDirector("base", [], {
      allowIdleWithFleet: true,
    });
    resyncIdleWithFleetFlag({
      directorHolder: { instance: director },
      subAgentSessions: store,
    });
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
  });

  test("first assemble with a drained fleet does not leave idle-with-fleet stuck true", async () => {
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
      directorHolder.instance = createChatDirector("base", [], {
        allowIdleWithFleet: true,
      });
      return agent;
    }) as unknown as RunnerServices["buildAgent"];
    await createRunLifecycle(state, services);
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
  });

  test("interrupt during an in-flight compaction aborts the compact and rebuilds so the next send works", async () => {
    const directorHolder: RunnerServices["directorHolder"] = {};
    const sends: string[] = [];
    const agent = recordingAgent(sends);
    const { state, services } = stubSendLifecycle(agent);
    services.directorHolder =
      directorHolder as unknown as RunnerServices["directorHolder"];
    services.subAgentSessions = {
      cancelAll: async () => [],
      list: () => [],
    } as unknown as RunnerServices["subAgentSessions"];
    services.workflowHost = {
      reattach: () => undefined,
    } as unknown as RunnerServices["workflowHost"];
    services.cycleRecorder = {
      dispose: async () => "",
      reset: () => undefined,
      handleEvent: () => undefined,
    } as unknown as RunnerServices["cycleRecorder"];
    services.buildAgent = (async () => {
      directorHolder.instance = createChatDirector("base", [], {
        allowIdleWithFleet: true,
      });
      return agent;
    }) as unknown as RunnerServices["buildAgent"];
    await createRunLifecycle(state, services);
    // A fold is mid-flight on the reactor when the operator interrupts: the
    // wrapped compact hangs on its summary call.
    const lifecycle = createCompactionLifecycle();
    state.compactionLifecycle = lifecycle;
    const notices: string[] = [];
    state.systemNotice = (text: string) => {
      notices.push(text);
    };
    const wrapped = lifecycle.wrapCompactor({
      name: "hang",
      version: "0",
      apply: () =>
        new Promise<never>(() => {
          // Never settles on purpose: the interrupt gate must win the race.
        }),
    });
    const pending = wrapped.apply([], {} as never);
    expect(lifecycle.isCompacting()).toBe(true);
    // CL-8220: the gate aborts the compact first instead of parking the
    // interrupt behind the unobservable reactor, then rebuilds as usual.
    defined(state.interrupt, "interrupt")();
    // The abort wins the apply race: the compact returns a no-op fold instead
    // of parking behind the hung summary call, and the flag clears.
    const aborted = await pending;
    expect(aborted.record.reason).toBe(COMPACTION_ABORTED_REASON);
    expect(lifecycle.isCompacting()).toBe(false);
    await services.sessionOps.awaitTail();
    expect(state.fatalBuildError).toBeNull();
    expect(notices.some((notice) => notice.includes("interrupting"))).toBe(
      true,
    );
    // The rebuilt session accepts the resend — no hop was dropped.
    const codexRefresh = spyOn(
      codexSession,
      "getValidCodexToken",
    ).mockResolvedValue({ access: "fresh-token" });
    try {
      await defined(state.agentProxy, "agentProxy").send("after interrupt");
    } finally {
      codexRefresh.mockRestore();
    }
    expect(sends).toContain("after interrupt");
  });

  test("rotation during an in-flight compaction aborts the compact and rotates so the next send works", async () => {
    const store = createSubAgentSessionStore();
    const directorHolder: RunnerServices["directorHolder"] = {};
    const sends: string[] = [];
    const agent = recordingAgent(sends);
    const { state, services } = stubSendLifecycle(agent);
    services.directorHolder =
      directorHolder as unknown as RunnerServices["directorHolder"];
    services.subAgentSessions =
      store as unknown as RunnerServices["subAgentSessions"];
    services.workflowHost = {
      reattach: () => undefined,
      reset: () => undefined,
    } as unknown as RunnerServices["workflowHost"];
    services.cycleRecorder = {
      dispose: async () => "",
      reset: () => undefined,
      handleEvent: () => undefined,
    } as unknown as RunnerServices["cycleRecorder"];
    services.buildSessionSources = () => ({
      sources: [liveSource],
      defaultSource: liveSource.id,
      selected: liveSource,
    });
    services.permissionGate = {
      reset: () => undefined,
    } as unknown as RunnerServices["permissionGate"];
    services.runSink = {
      sink: () => undefined,
      reset: () => undefined,
    } as unknown as RunnerServices["runSink"];
    services.sessionCost = {
      addTurn: () => undefined,
      reset: () => undefined,
    } as unknown as RunnerServices["sessionCost"];
    services.activatedToolNames = {
      clear: () => undefined,
      activate: () => false,
      list: () => [],
    } as unknown as RunnerServices["activatedToolNames"];
    services.hostHolder = {} as unknown as RunnerServices["hostHolder"];
    services.buildAgent = (async () => {
      directorHolder.instance = createChatDirector("base", [], {
        allowIdleWithFleet: true,
      });
      return agent;
    }) as unknown as RunnerServices["buildAgent"];
    const initDir = spyOn(sessionIndex, "initSessionDir").mockImplementation(
      async () => "/tmp/rotated-session",
    );
    const contextDir = spyOn(
      sessionIndex,
      "sessionContextDir",
    ).mockImplementation(() => "/tmp/rotated-session/context");
    try {
      await createRunLifecycle(state, services);
      // A fold is mid-flight on the reactor when the operator rotates: the
      // wrapped compact hangs on its summary call.
      const lifecycle = createCompactionLifecycle();
      state.compactionLifecycle = lifecycle;
      const wrapped = lifecycle.wrapCompactor({
        name: "hang",
        version: "0",
        apply: () =>
          new Promise<never>(() => {
            // Never settles on purpose: the rotation gate must win the race.
          }),
      });
      const pending = wrapped.apply([], {} as never);
      expect(lifecycle.isCompacting()).toBe(true);
      // The rotation aborts the compact first instead of parking behind the
      // hung summary call, then rebuilds onto the fresh session as usual.
      defined(state.newSession, "newSession")();
      const aborted = await pending;
      expect(aborted.record.reason).toBe(COMPACTION_ABORTED_REASON);
      expect(lifecycle.isCompacting()).toBe(false);
      await services.sessionOps.awaitTail();
      expect(state.fatalBuildError).toBeNull();
      // The rotated session accepts the resend — no hop was dropped.
      const codexRefresh = spyOn(
        codexSession,
        "getValidCodexToken",
      ).mockResolvedValue({ access: "fresh-token" });
      try {
        await defined(state.agentProxy, "agentProxy").send("after rotation");
      } finally {
        codexRefresh.mockRestore();
      }
      expect(sends).toContain("after rotation");
    } finally {
      initDir.mockRestore();
      contextDir.mockRestore();
    }
  });

  test("a failed interrupt rebuild un-poisons the lifecycle so later compacts run", async () => {
    const directorHolder: RunnerServices["directorHolder"] = {};
    const agent = recordingAgent([]);
    const { state, services } = stubSendLifecycle(agent);
    services.directorHolder =
      directorHolder as unknown as RunnerServices["directorHolder"];
    services.subAgentSessions = {
      cancelAll: async () => [],
      list: () => [],
    } as unknown as RunnerServices["subAgentSessions"];
    services.workflowHost = {
      reattach: () => undefined,
    } as unknown as RunnerServices["workflowHost"];
    services.cycleRecorder = {
      dispose: async () => "",
      reset: () => undefined,
      handleEvent: () => undefined,
    } as unknown as RunnerServices["cycleRecorder"];
    services.buildAgent = (async () => {
      directorHolder.instance = createChatDirector("base", [], {
        allowIdleWithFleet: true,
      });
      return agent;
    }) as unknown as RunnerServices["buildAgent"];
    await createRunLifecycle(state, services);
    const lifecycle = createCompactionLifecycle();
    state.compactionLifecycle = lifecycle;
    // The replacement agent fails to build: the rebuild never reaches
    // onBuilt/reset, so the catch's poison guard must un-poison instead.
    services.buildAgent = (async () => {
      throw new Error("build blew up");
    }) as unknown as RunnerServices["buildAgent"];
    const hanging = lifecycle.wrapCompactor({
      name: "hang",
      version: "0",
      apply: () =>
        new Promise<never>(() => {
          // Never settles on purpose: the interrupt gate must win the race.
        }),
    });
    const pending = hanging.apply([], {} as never);
    expect(lifecycle.isCompacting()).toBe(true);
    defined(state.interrupt, "interrupt")();
    const aborted = await pending;
    expect(aborted.record.reason).toBe(COMPACTION_ABORTED_REASON);
    await services.sessionOps.awaitTail();
    // The failure still surfaces…
    expect(state.fatalBuildError).not.toBeNull();
    // …but the lifecycle is usable: the signal is fresh and the next compact
    // runs its inner run instead of silently no-op.
    expect(lifecycle.getSignal().aborted).toBe(false);
    let innerCalls = 0;
    const live = lifecycle.wrapCompactor({
      name: "live",
      version: "0",
      apply: async (input) => {
        innerCalls += 1;
        return {
          output: input,
          record: {
            strategy: "live",
            version: "0",
            parameters: {},
            reason: "folded",
            decisions: { summarizedTurnCount: 1 },
          },
        };
      },
    });
    const result = await live.apply([], {} as never);
    expect(innerCalls).toBe(1);
    expect(result.record.reason).toBe("folded");
  });

  test("a failed reload-if-idle rebuild un-poisons the lifecycle", async () => {
    const directorHolder: RunnerServices["directorHolder"] = {};
    const agent = recordingAgent([]);
    const { state, services } = stubSendLifecycle(agent);
    services.directorHolder =
      directorHolder as unknown as RunnerServices["directorHolder"];
    services.subAgentSessions = {
      cancelAll: async () => [],
      list: () => [],
    } as unknown as RunnerServices["subAgentSessions"];
    services.workflowHost = {
      reattach: () => undefined,
    } as unknown as RunnerServices["workflowHost"];
    services.cycleRecorder = {
      dispose: async () => "",
      reset: () => undefined,
      handleEvent: () => undefined,
    } as unknown as RunnerServices["cycleRecorder"];
    services.buildAgent = (async () => {
      directorHolder.instance = createChatDirector("base", [], {
        allowIdleWithFleet: true,
      });
      return agent;
    }) as unknown as RunnerServices["buildAgent"];
    await createRunLifecycle(state, services);
    const lifecycle = createCompactionLifecycle();
    state.compactionLifecycle = lifecycle;
    // Poisoned by an earlier abort whose rebuild never landed…
    lifecycle.abortCompaction("operator interrupt");
    expect(lifecycle.getSignal().aborted).toBe(true);
    services.buildAgent = (async () => {
      throw new Error("build blew up");
    }) as unknown as RunnerServices["buildAgent"];
    state.pendingReload = true;
    defined(state.reloadIfIdle, "reloadIfIdle")();
    await services.sessionOps.awaitTail();
    // …the failure surfaces, but the catch's poison guard mints a fresh
    // signal so later compacts work instead of silently no-op.
    expect(state.fatalBuildError).not.toBeNull();
    expect(lifecycle.getSignal().aborted).toBe(false);
  });

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

  test("newSession/clear with a drained fleet still nudges open tasks after rotation", async () => {
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
      reset: () => undefined,
    } as unknown as RunnerServices["workflowHost"];
    services.cycleRecorder = {
      dispose: async () => "",
      reset: () => undefined,
      handleEvent: () => undefined,
    } as unknown as RunnerServices["cycleRecorder"];
    services.buildSessionSources = () => ({
      sources: [liveSource],
      defaultSource: liveSource.id,
      selected: liveSource,
    });
    services.permissionGate = {
      reset: () => undefined,
    } as unknown as RunnerServices["permissionGate"];
    services.runSink = {
      sink: () => undefined,
      reset: () => undefined,
    } as unknown as RunnerServices["runSink"];
    services.sessionCost = {
      addTurn: () => undefined,
      reset: () => undefined,
    } as unknown as RunnerServices["sessionCost"];
    services.activatedToolNames = {
      clear: () => undefined,
      activate: () => false,
      list: () => [],
    } as unknown as RunnerServices["activatedToolNames"];
    services.hostHolder = {} as unknown as RunnerServices["hostHolder"];
    services.buildAgent = (async () => {
      directorHolder.instance = createChatDirector("base", [], {
        allowIdleWithFleet: true,
      });
      return agent;
    }) as unknown as RunnerServices["buildAgent"];
    const initDir = spyOn(sessionIndex, "initSessionDir").mockImplementation(
      async () => "/tmp/rotated-session",
    );
    const contextDir = spyOn(
      sessionIndex,
      "sessionContextDir",
    ).mockImplementation(() => "/tmp/rotated-session/context");
    try {
      await createRunLifecycle(state, services);
      defined(state.newSession, "newSession")();
      await services.sessionOps.awaitTail();
      expect(state.fatalBuildError).toBeNull();
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
    } finally {
      initDir.mockRestore();
      contextDir.mockRestore();
    }
  });
});
