import { describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { AgentContextLockError, type Agent } from "@intx/agent";
import type { InferenceSource } from "@intx/types/runtime";

import * as codexSession from "../../auth/codex/session.js";
import * as xaiSession from "../../auth/xai/session.js";
import {
  readSourceCredentialMaterial,
  registerSourceCredentialRecord,
} from "../../config/source-credentials.js";
import { createChatDirector } from "../../agent/director.js";
import * as sessionIndex from "../../session/index.js";
import { createSubAgentSessionStore } from "../../subagent/session-store.js";
import type {
  ReactorAction,
  ReactorCapabilities,
  ReactorInboundEvent,
  ReactorState,
} from "@intx/types/runtime";
import { defined } from "../../testkit/defined.js";
import {
  withMockedHomedir,
  withMockedModuleDuring,
} from "../../testkit/mock-module.js";
import { createTempDirs } from "../../testkit/temporary-dirs.js";
import {
  createDeliveryGeneration,
  createSessionOperationQueue,
} from "../delivery-queue.js";
import {
  agentRebuildFailure,
  closeAgentForRebuild,
  createRunLifecycle,
  finalizeTUIRun,
  resetSessionForRotation,
  resyncIdleWithFleetFlag,
  startInterruptRebuild,
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
    activatedToolNames: { list: () => [] },
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

describe("finalizeTUIRun resume hint", () => {
  // stderr channel, line format, and the shared once-flag live in
  // src/session/resume-hint.test.ts; here only the finalize call site is
  // pinned: the hint goes out once, after the session-op tail drains.
  test("invokes printResumeHint once with the session id after the tail", async () => {
    const order: string[] = [];
    const calls: string[] = [];
    const { state, services } = stubQuit({
      awaitTail: async () => void order.push("tail"),
      shutdownRuntime: async () => undefined,
    });
    const dirs = createTempDirs(
      "corbits-resume-hint-cwd-",
      "corbits-resume-hint-home-",
    );
    (state.config as { cwd: string }).cwd = dirs.cwd;
    try {
      await withMockedModuleDuring(
        import.meta.resolve("../../session/resume-hint.js"),
        (real: typeof import("../../session/resume-hint.js")) => ({
          ...real,
          printResumeHint: (sessionId: string) => {
            calls.push(sessionId);
            order.push("hint");
          },
        }),
        () =>
          withMockedHomedir(dirs.home, () => finalizeTUIRun(state, services)),
      );
    } finally {
      dirs.cleanup();
    }
    expect(calls).toEqual([state.sessionId]);
    expect(order).toEqual(["tail", "hint"]);
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
  registerSourceCredentialRecord(liveSource.credentialId, {
    provenance: { kind: "oauth", provider: "codex", profile: "work" },
    material: { secret: "stale-token" },
  });
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

  for (const provider of ["codex", "xai"] as const) {
    test(`${provider}/shadow API-key send never resolves same-slug OAuth`, async () => {
      const sends: string[] = [];
      const { state, services } = stubSendLifecycle(recordingAgent(sends));
      const source: InferenceSource = {
        id: `${provider}/shadow`,
        provider: "openai-compatible",
        baseURL: "https://relay.example/v1",
        credentialId: `${provider}/shadow`,
        model: "relay-model",
      };
      state.liveSource = source;
      state.config = {
        ...state.config,
        providers: [
          {
            name: `${provider}/shadow`,
            baseURL: "https://oauth.example/v1",
            apiKey: "oauth-token",
            models: ["relay-model"],
            ...(provider === "codex"
              ? { codexProfile: "shadow" }
              : { xaiProfile: "shadow" }),
          },
        ],
      };
      registerSourceCredentialRecord(source.credentialId, {
        provenance: { kind: "api-key" },
        material: { secret: "explicit-api-key" },
      });
      const codexResolver = spyOn(
        codexSession,
        "getValidCodexToken",
      ).mockRejectedValue(new Error("must not resolve Codex OAuth"));
      const xaiResolver = spyOn(
        xaiSession,
        "getValidXaiToken",
      ).mockRejectedValue(new Error("must not resolve xAI OAuth"));

      try {
        const { agentProxy } = await createRunLifecycle(state, services);
        await agentProxy.send("use explicit authorization");
        expect(sends).toEqual(["use explicit authorization"]);
        expect(codexResolver).not.toHaveBeenCalled();
        expect(xaiResolver).not.toHaveBeenCalled();
        expect(readSourceCredentialMaterial(source.credentialId).secret).toBe(
          "explicit-api-key",
        );
      } finally {
        codexResolver.mockRestore();
        xaiResolver.mockRestore();
      }
    });
  }
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

// CL-5753: an interrupt can hit close() while reactor.abort()/sendQueue.drain()
// are mid-teardown, throwing before @intx/agent's close() ever reaches
// lock.release(). Once that happens the agent is already marked closed, so a
// retried close() is a silent no-op that can never free the lock either — the
// workdir's lock is stuck held for the rest of the process. The next
// buildAgent() for that same workdir is then guaranteed to throw
// AgentContextLockError ("an agent is already open for workdir: ..."), which
// is the crash from the ticket. These tests cover the two functions the
// runner now routes every rebuild through so that failure is reported in
// plain language rather than escaping as an unhandled rejection.
describe("rebuild close helpers", () => {
  function stubAgent(closeImpl: () => Promise<void>): Agent {
    return { close: closeImpl } as unknown as Agent;
  }

  test("closeAgentForRebuild reports a failed close without throwing", async () => {
    const agent = stubAgent(() =>
      Promise.reject(new AgentContextLockError("/tmp/workdir")),
    );
    const closedCleanly = await closeAgentForRebuild(agent, "interrupt");
    expect(closedCleanly).toBe(false);
  });

  test("closeAgentForRebuild reports success when close() resolves", async () => {
    const agent = stubAgent(() => Promise.resolve());
    const closedCleanly = await closeAgentForRebuild(agent, "interrupt");
    expect(closedCleanly).toBe(true);
  });

  test("agentRebuildFailure turns a stale-lock AgentContextLockError into a plain-language message", () => {
    // Simulates the second acquisition throwing after a failed close left the
    // lock held: buildAgent() surfaces AgentContextLockError, which must not
    // reach the caller as a raw stack trace.
    const err = agentRebuildFailure(new AgentContextLockError("/tmp/workdir"));
    expect(err.message).not.toContain("already open");
    expect(err.message).toMatch(/restart/i);
  });

  test("agentRebuildFailure passes other errors through unchanged", () => {
    const original = new Error("network unreachable");
    expect(agentRebuildFailure(original)).toBe(original);
  });

  test("a failed close followed by a lock error never surfaces as a raw AgentContextLockError", async () => {
    // End-to-end shape of the fix: close() throws (lock leaked in-process),
    // the rebuild site short-circuits instead of calling buildAgent() again,
    // and the resulting error is the plain-language one — never the raw
    // AgentContextLockError a bare `throw` would have produced.
    const agent = stubAgent(() =>
      Promise.reject(new AgentContextLockError("/tmp/workdir")),
    );
    let rebuildError: Error | null = null;
    try {
      const closedCleanly = await closeAgentForRebuild(agent, "interrupt");
      if (!closedCleanly) {
        throw new AgentContextLockError("/tmp/workdir");
      }
    } catch (err) {
      rebuildError = agentRebuildFailure(err);
    }
    expect(rebuildError).not.toBeNull();
    expect(rebuildError).not.toBeInstanceOf(AgentContextLockError);
    expect(defined(rebuildError, "rebuild error").message).toMatch(/restart/i);
  });

  // reloadIfIdle itself is a closure captured inside runTUI's single
  // ~2500-line scope (currentAgent, buildAgent, streamPromise,
  // workflowController, pendingReload/inFlight, fatalBuildError, etc. are all
  // local variables of that function), with no seam to construct or call it
  // in isolation short of standing up the full TUI runner — provider config,
  // plugin discovery, MCP wiring, and a real OpenTUI host. What can be driven
  // directly, and is exactly the failure this bug reports, is the real
  // `delivery-queue.ts` queue exercised the same way every rebuild site uses
  // it: `void enqueueOp(async () => { try { ... } catch (err) {
  // fatalBuildError = ... } })`. `enqueue` is `tail = tail.then(op, op);
  // return tail;` — if `op` rejects and nothing internally catches it, that
  // returned promise is the only thing that ever observes the rejection, and
  // `void` discards it, which is precisely how the unhandled rejection in the
  // ticket escaped.
  //
  // A true negative control (reproducing reloadIfIdle's pre-fix shape — no
  // try/catch around the queued op — and asserting the rejection escapes) was
  // attempted here and deliberately removed: bun:test installs its own
  // `unhandledRejection` listener that fails whichever test is running the
  // instant one fires, regardless of what that test asserts, so a test
  // designed to prove an unhandled rejection *does* escape cannot pass in
  // this harness — it is intercepted before the assertion runs. The test
  // below is the harness-compatible half of that pair: same real queue, same
  // real helpers, proving the fixed shape produces no such failure.
  test("a rejecting reload op through the real delivery-queue never triggers an unhandled rejection", async () => {
    const { enqueue, awaitTail } = createSessionOperationQueue();
    const agent = stubAgent(() =>
      Promise.reject(new AgentContextLockError("/tmp/workdir")),
    );

    let unhandled: unknown = null;
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled = reason;
    };
    process.on("unhandledRejection", onUnhandledRejection);

    let fatalBuildError: Error | null = null;
    try {
      // Mirrors reloadIfIdle's body verbatim: close the current agent through
      // closeAgentForRebuild, skip buildAgent() and throw instead of
      // re-acquiring on a failed close, and land any failure in
      // fatalBuildError via agentRebuildFailure — all behind `void enqueueOp`,
      // exactly as the runner calls it.
      void enqueue(async () => {
        try {
          const closedCleanly = await closeAgentForRebuild(agent, "reload");
          if (!closedCleanly) {
            throw new AgentContextLockError("/tmp/workdir");
          }
        } catch (err) {
          fatalBuildError = agentRebuildFailure(err);
        }
      });

      await awaitTail();
      // Give any unhandled rejection queued by the engine a chance to fire
      // before asserting its absence — it lands on a later microtask/macrotask
      // than the awaited queue settlement.
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }

    expect(unhandled).toBeNull();
    expect(fatalBuildError).not.toBeNull();
    expect(fatalBuildError).not.toBeInstanceOf(AgentContextLockError);
    expect(
      defined<Error>(fatalBuildError, "fatal build error").message,
    ).toMatch(/restart/i);
  });

  // Overlay accept/decline tests stub bump() inside resolveSuspended, so
  // deleting the interrupt-site bump would not fail them. Drive the interrupt
  // helper itself.
  test("interrupt bumps delivery generation before enqueueing rebuild", () => {
    const order: string[] = [];
    startInterruptRebuild({
      deliveryGeneration: {
        bump: () => {
          order.push("bump");
        },
      },
      markSendAborted: () => {
        order.push("abort");
      },
      enqueue: (op) => {
        order.push("enqueue");
        return op();
      },
      rebuild: async () => {
        order.push("rebuild");
      },
    });
    expect(order[0]).toBe("bump");
    expect(order.indexOf("enqueue")).toBeGreaterThan(0);
  });
});
