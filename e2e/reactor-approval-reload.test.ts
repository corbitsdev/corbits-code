/**
 * A settled ask (approved, rejected, or timed out) whose agent is rebuilt
 * from the same store, before the next cycle commit or at the run's end
 * where the TUI's deferred reload fires, must not leave the parked call's
 * pending operation behind: the rebuilt reactor would re-arm its gate and, at
 * the original deadline, answer an already-answered call with "approval timed
 * out".
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";

import type { ReactorEmittedEvent } from "@intx/inference";
import type { ConversationTurn, InferenceSource } from "@intx/types/runtime";

import type { MCPClient } from "../src/mcp/client.js";
import { mcpClientTools } from "../src/mcp/plugin.js";
import { createPermissionGate } from "../src/permission/gate.js";
import { createReactorAuthorize } from "../src/permission/reactor-authorize.js";
import {
  APPROVAL_DROPPED_NOTICE,
  createApprovalResume,
  resolveParkedCallIdFromStore,
  type ApprovalResume,
} from "../src/session/approval-resume.js";
import {
  DROPPED_APPROVAL_SETTLED_EVENT,
  type DroppedApprovalCalls,
} from "../src/agent/director.js";
import { createQueuedApprovalDeliver } from "../src/tui/approval-delivery.js";
import {
  createDeliveryGeneration,
  createSessionOperationQueue,
} from "../src/tui/delivery-queue.js";
import { startInterruptRebuild } from "../src/tui/runner/exit.js";
import {
  closeIntegrationSession,
  openIntegrationSession,
  rebuildIntegrationSession,
  runUntilDone,
  runUntilSuspended,
  type IntegrationSession,
  type OpenIntegrationSessionOpts,
} from "./integration-harness.js";

// Ask-tier, but answered locally: nothing listens on the discard port.
const CLOSED_PORT_PROBE = "curl -sS --max-time 1 http://127.0.0.1:9/";
const SAVE_ISSUE = "mcp__linear__save_issue";
const CREATE_LABEL = "mcp__linear__create_label";

function linearClient(calls: Record<string, unknown>[]): MCPClient {
  return {
    serverName: "linear",
    tools: [
      {
        name: "save_issue",
        description: "create or update a linear issue",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string" } },
        },
      },
    ],
    async callResult(_toolName, args) {
      calls.push(args);
      return { blocks: [{ type: "text", text: "SAVED-1" }], isError: false };
    },
    async close() {
      return undefined;
    },
  };
}

function labelClient(): MCPClient {
  return {
    serverName: "linear",
    tools: [
      {
        name: "create_label",
        description: "create a linear label",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    async callResult() {
      return { blocks: [], isError: false };
    },
    async close() {
      return undefined;
    },
  };
}

// Reactor gates run on the real clock (setTimeout + Date.now), not the
// inference harness clock, so the approval deadline is driven here. Only
// timers at least this long are held; everything shorter keeps real timing.
const HELD_TIMER_MIN_MS = 30 * 60_000;

interface HeldTimer {
  dueAt: number;
  fire: () => void;
  cleared: boolean;
}

function holdLongTimers() {
  const realNow = Date.now.bind(Date);
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let offset = 0;
  const held = new Map<object, HeldTimer>();
  const now = spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  const set = spyOn(globalThis, "setTimeout").mockImplementation(((
    fire: () => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === undefined || delay < HELD_TIMER_MIN_MS) {
      return realSetTimeout(fire, delay, ...args);
    }
    const handle = {};
    held.set(handle, { dueAt: Date.now() + delay, fire, cleared: false });
    return handle;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(((
    handle: Parameters<typeof clearTimeout>[0],
  ) => {
    const timer =
      typeof handle === "object" && handle !== null
        ? held.get(handle)
        : undefined;
    if (timer !== undefined) {
      timer.cleared = true;
      return;
    }
    realClearTimeout(handle);
  }) as typeof clearTimeout);
  return {
    /** Move the clock to `at` without firing held timers. */
    shift(at: number): void {
      offset = at - realNow();
    },
    /** Move the clock to `at` and fire every held timer due by then. */
    advanceTo(at: number): void {
      offset = at - realNow();
      for (const timer of held.values()) {
        if (timer.cleared || timer.dueAt > at) continue;
        timer.cleared = true;
        timer.fire();
      }
    },
    restore(): void {
      clear.mockRestore();
      set.mockRestore();
      now.mockRestore();
    },
  };
}

function deferredApprovalGate() {
  let release: ((outcome: { allow: boolean }) => void) | undefined;
  return {
    asked: () => release !== undefined,
    gate: createPermissionGate({
      approvals: [],
      interactive: true,
      skipPermissions: false,
      auto: false,
      reactorGated: true,
      requestApproval: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    }),
    approve: () => release?.({ allow: true }),
    reject: () => release?.({ allow: false }),
  };
}

async function waitFor(
  predicate: () => boolean,
  what: string,
  ms = 5_000,
): Promise<void> {
  const deadline = performance.now() + ms;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function toolResultsFor(
  turns: readonly ConversationTurn[],
  callId: string,
): string[] {
  return turns
    .flatMap((turn) => turn.content)
    .flatMap((block) =>
      block.type === "tool_result" && block.callId === callId
        ? [JSON.stringify(block.content)]
        : [],
    );
}

interface RequestMessage {
  content: string | { type: string; id?: string; tool_use_id?: string }[];
}

/** The block types naming `callId` in the last model request, in order. */
async function lastRequestBlocksFor(
  session: IntegrationSession,
  callId: string,
): Promise<string[]> {
  const request = session.harness.scenario.matchedRequests().at(-1);
  if (request === undefined) throw new Error("no routed requests");
  const body = JSON.parse(
    await (request.clone() as unknown as Request).text(),
  ) as { messages: RequestMessage[] };
  return body.messages.flatMap((message) =>
    typeof message.content === "string"
      ? []
      : message.content.flatMap((block) =>
          block.id === callId || block.tool_use_id === callId
            ? [block.type]
            : [],
        ),
  );
}

function collect(session: IntegrationSession): ReactorEmittedEvent[] {
  const events: ReactorEmittedEvent[] = [];
  void (async () => {
    for await (const event of session.agent.stream()) events.push(event);
  })().catch(() => undefined);
  return events;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Reloaded {
  session: IntegrationSession;
  /** Events from the rebuilt agent, collected from its start. */
  events: ReactorEmittedEvent[];
  callId: string;
  deadline: number;
  clock: ReturnType<typeof holdLongTimers>;
}

interface DecideThenReloadOpts {
  /**
   * How the parked call is settled. `expire` never opens the approval
   * prompt; the reactor's own deadline answers the call.
   */
  decision?: "approve" | "reject" | "expire";
  /**
   * The model's reply after the settled call. Without it the next model
   * turn stays open, so the reload lands before the cycle commits; with it
   * the run can end, which is where the TUI's deferred reload fires.
   */
  replyAfterDecision?: string;
  /** Runs on the opened session before the call is scripted. */
  prepare?: (session: IntegrationSession) => Promise<void>;
  /** Runs while the approval prompt is live, before it is decided. */
  afterApprovalOpened?: (session: IntegrationSession) => void;
  /**
   * Rebuild over the same toolset, as the TUI does for an MCP tool-set
   * change. Reopening from the store builds a fresh toolset, which would
   * drop tools mounted on the old one.
   */
  rebuildInPlace?: boolean;
}

/**
 * Opens a session and parks `call` on an ask. `live.session` is the agent's
 * current session; a rebuild replaces it, and cleanup closes whichever is
 * current.
 */
async function parkOnAsk(
  call: { name: string; args: Record<string, unknown> },
  opts: Pick<DecideThenReloadOpts, "replyAfterDecision" | "prepare"> & {
    adapter?: Adapter;
    droppedApprovalCalls?: DroppedApprovalCalls;
  },
) {
  const provider = opts.adapter?.provider ?? "anthropic";
  // Held from before the park so the expire case can fire the original gate
  // timer; the approve and reject cases clear it unfired.
  const clock = holdLongTimers();
  cleanups.push(() => clock.restore());
  const ctx = deferredApprovalGate();
  const sessionOpts = {
    ...opts.adapter?.sessionOpts,
    permissionGate: ctx.gate,
    authorize: createReactorAuthorize(ctx.gate),
    pinToolSetAtBuild: true,
    ...(opts.droppedApprovalCalls !== undefined
      ? { droppedApprovalCalls: opts.droppedApprovalCalls }
      : {}),
  };
  const live = { session: await openIntegrationSession(sessionOpts) };
  cleanups.push(() => closeIntegrationSession(live.session));
  await opts.prepare?.(live.session);

  live.session.harness.scenario.replyOnce(provider, {
    toolCalls: [call],
  });
  if (opts.replyAfterDecision === undefined)
    live.session.harness.scenario.stall();
  else
    live.session.harness.scenario.replyOnce(provider, {
      text: opts.replyAfterDecision,
    });

  const turn = await runUntilSuspended(live.session, "Probe the local port.");
  const suspended = turn.result;
  if (suspended.type !== "suspended") throw new Error("did not park");
  const parked = (await live.session.storage.load()).pendingOperations.find(
    (op) => op.correlationId === suspended.correlationId,
  );
  const callId = parked?.suspendedCall?.id;
  const deadline = parked?.timeoutAt;
  if (callId === undefined || deadline === undefined) {
    throw new Error("parked call has no persisted call id or deadline");
  }
  return {
    live,
    sessionOpts,
    ctx,
    clock,
    suspended,
    events: turn.events,
    callId,
    deadline,
  };
}

/**
 * Parks `call` on an ask, settles it per `opts.decision` (approve by
 * default), and once `reloadWhen` holds for the settled run, rebuilds the
 * agent on the same store. `reloadWhen` sees only events from after the
 * decision.
 */
async function decideThenReload(
  call: { name: string; args: Record<string, unknown> },
  reloadWhen: (
    session: IntegrationSession,
    events: ReactorEmittedEvent[],
  ) => boolean,
  opts: DecideThenReloadOpts = {},
): Promise<Reloaded> {
  const { live, sessionOpts, ctx, clock, suspended, events, callId, deadline } =
    await parkOnAsk(call, opts);

  const decision = opts.decision ?? "approve";
  const decidedAt = events.length;
  if (decision === "expire") {
    clock.advanceTo(deadline + 1_000);
  } else {
    const resume = createApprovalResume({
      getAgent: () => live.session.agent,
      gate: ctx.gate,
      resolveParkedCallId: (id) =>
        resolveParkedCallIdFromStore(live.session.storage, id),
    });
    const handling = resume.handle(suspended);
    await waitFor(ctx.asked, "approval prompt");
    opts.afterApprovalOpened?.(live.session);
    if (decision === "approve") ctx.approve();
    else ctx.reject();
    expect(await handling).toBe(true);
  }
  void live.session.harness
    .run({ wallClockBudgetMs: 30_000 })
    .catch(() => undefined);
  const before = live.session;
  await waitFor(
    () => reloadWhen(before, events.slice(decidedAt)),
    "reload point",
  );

  if (opts.rebuildInPlace === true) await live.session.rebuild();
  else
    live.session = await rebuildIntegrationSession(live.session, sessionOpts);
  return {
    session: live.session,
    events: collect(live.session),
    callId,
    deadline,
    clock,
  };
}

interface Adapter {
  name: string;
  provider: "anthropic" | "openai";
  sessionOpts: Partial<OpenIntegrationSessionOpts>;
}

const OPENAI_SOURCE: InferenceSource = {
  id: "openai:integration",
  provider: "openai",
  baseURL: "https://api.openai.com/v1",
  credentialId: "openai:integration",
  model: "gpt-integration",
};

const NATIVE_ANTHROPIC: Adapter = {
  name: "native Anthropic",
  provider: "anthropic",
  sessionOpts: {},
};

const ADAPTERS: Adapter[] = [
  NATIVE_ANTHROPIC,
  {
    name: "OpenAI-shaped",
    provider: "openai",
    sessionOpts: {
      sources: [OPENAI_SOURCE],
      credentialRecords: {
        [OPENAI_SOURCE.credentialId]: {
          provenance: { kind: "api-key" },
          material: { secret: "openai-integration-key" },
        },
      },
    },
  },
];

interface Dropped extends Reloaded {
  resume: ApprovalResume;
  correlationId: string;
  /** Events from the parked agent, up to its close. */
  parkedEvents: ReactorEmittedEvent[];
  /** The calls the closed agent's store still showed parked at the rebuild. */
  parkedAtRebuild: (string | undefined)[];
}

/** Where the interrupt lands relative to the operator's decision. */
type InterruptPoint =
  /** Before the prompt opens, while the approval resolves its parked call. */
  | "resolving-call"
  /** After an approval, while it waits behind a busy session queue. */
  | "decision-queued";

/**
 * Parks `call` on an ask, then interrupts at `opts.interruptWhile` (while
 * the approval resolves its parked call, by default), so no decision reaches
 * a reactor that runs it. The rebuild settles the drop on the rebuilt agent,
 * as the TUI's interrupt does, and no reply is scripted for it.
 */
async function dropThenInterrupt(
  call: { name: string; args: Record<string, unknown> },
  adapter: Adapter,
  opts: {
    /**
     * The interrupt lands just before the deadline: it has passed by the
     * time the rebuilt reactor rehydrates, and the settle's store read is
     * slower than that reactor's own.
     */
    deadlinePassesDuringRebuild?: boolean;
    interruptWhile?: InterruptPoint;
  } = {},
): Promise<Dropped> {
  const interruptWhile = opts.interruptWhile ?? "resolving-call";
  // Every build's director claims from the resume, which needs the session.
  let claimFrom: ApprovalResume | undefined;
  const droppedCalls: DroppedApprovalCalls = {
    claim: (callId) => claimFrom?.droppedCalls.claim(callId) === true,
  };
  const {
    live,
    sessionOpts,
    ctx,
    clock,
    suspended,
    events: parkedEvents,
    callId,
    deadline,
  } = await parkOnAsk(call, { adapter, droppedApprovalCalls: droppedCalls });
  const parkedCancel = { fn: undefined as (() => void) | undefined };
  const generation = createDeliveryGeneration(() => parkedCancel.fn?.());
  let releaseCallId: (() => void) | undefined;
  const callIdResolved = new Promise<void>((resolve) => {
    releaseCallId = resolve;
  });
  const { enqueue, awaitTail } = createSessionOperationQueue();
  let decisionQueued: (() => void) | undefined;
  const queued = new Promise<void>((resolve) => {
    decisionQueued = resolve;
  });
  const resume = createApprovalResume({
    getAgent: () => live.session.agent,
    gate: ctx.gate,
    captureGeneration: generation.capture,
    registerParkedCancel: (cancel) => {
      parkedCancel.fn = cancel;
    },
    resolveParkedCallId: () => callIdResolved.then(() => callId),
    // As the TUI does: behind the session's other operations.
    deliver: createQueuedApprovalDeliver({
      enqueue: (op) => {
        const queuedOp = enqueue(op);
        decisionQueued?.();
        return queuedOp;
      },
      fatalBuildError: () => null,
      deliverer: {
        deliver: async (message) => live.session.agent.deliver(message),
      },
    }),
  });
  claimFrom = resume;
  const handling = resume.handle(suspended);

  let releaseBusy: (() => void) | undefined;
  if (interruptWhile !== "resolving-call") {
    releaseCallId?.();
    await waitFor(ctx.asked, "approval prompt");
  }
  if (interruptWhile === "decision-queued") {
    // Any earlier operation holds the queue, as a send or another deliver would.
    void enqueue(
      () =>
        new Promise<void>((resolve) => {
          releaseBusy = resolve;
        }),
    );
    ctx.approve();
    await queued;
  }
  let events: ReactorEmittedEvent[] = [];
  let parkedAtRebuild: (string | undefined)[] = [];
  startInterruptRebuild({
    deliveryGeneration: generation,
    markSendAborted: () => undefined,
    enqueue,
    rebuild: async () => {
      if (opts.deadlinePassesDuringRebuild === true) {
        clock.shift(deadline + 1_000);
      }
      parkedAtRebuild = (
        await live.session.storage.load()
      ).pendingOperations.map((op) => op.suspendedCall?.id);
      await resume.prepareRebuild(live.session.storage);
      live.session = await rebuildIntegrationSession(live.session, sessionOpts);
      events = collect(live.session);
      const storage = live.session.storage;
      await resume.settleOn(
        live.session.agent,
        opts.deadlinePassesDuringRebuild === true
          ? {
              load: async () => {
                await new Promise((resolve) => setTimeout(resolve, 50));
                return storage.load();
              },
            }
          : storage,
      );
    },
  });
  releaseCallId?.();
  releaseBusy?.();
  expect(await handling).toBe(true);
  await awaitTail();

  await waitFor(
    () => events.some((e) => String(e.type) === DROPPED_APPROVAL_SETTLED_EVENT),
    "dropped approval settled",
  );
  // The settle is announced before the wait terminal's cycle commit lands.
  const settledAt = performance.now();
  while (
    toolResultsFor(await committedTurns(live.session), callId).length === 0
  ) {
    if (performance.now() - settledAt > 5_000) {
      throw new Error("timed out: dropped approval committed");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return {
    session: live.session,
    events,
    callId,
    deadline,
    clock,
    resume,
    correlationId: suspended.correlationId,
    parkedEvents,
    parkedAtRebuild,
  };
}

/** The turns in the store's newest commit. */
async function committedTurns(
  session: IntegrationSession,
): Promise<ConversationTurn[]> {
  const [newest] = await session.agent.checkpoints(1);
  if (newest === undefined) throw new Error("no commits");
  return session.agent.readAt(newest.hash);
}

// Past both the original deadline and a full approval window freshly armed
// at the reload, so either re-arm would have fired.
const FRESH_WINDOW_PASSED_MS = 2 * 60 * 60_000;

/** Moves past the original approval deadline and lets the reactor react. */
async function passDeadline(
  reloaded: Reloaded,
  at = reloaded.deadline + 1_000,
): Promise<void> {
  reloaded.clock.advanceTo(at);
  await reloaded.session.harness
    .run({ wallClockBudgetMs: 2_000 })
    .catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("integration: approving an ask, then reloading the agent", () => {
  test.serial(
    "after the approved result: the rebuilt agent continues, and the old deadline adds no result",
    async () => {
      const reloaded = await decideThenReload(
        { name: "run_shell", args: { command: CLOSED_PORT_PROBE } },
        (session) => session.harness.scenario.matchedRequests().length === 2,
      );
      const { session, callId } = reloaded;
      expect(
        toolResultsFor(await session.agent.history(), callId),
      ).toHaveLength(1);

      session.harness.scenario.replyOnce("anthropic", { text: "Port closed." });
      const followUp = await runUntilDone(session, "Continue.");
      expect(followUp.reply).toBe("Port closed.");

      await passDeadline(reloaded);
      expect(reloaded.events.filter((e) => e.type === "reactor.error")).toEqual(
        [],
      );
      const results = toolResultsFor(await session.agent.history(), callId);
      expect(results).toHaveLength(1);
      expect(results.join("")).not.toContain("approval timed out");
    },
    20_000,
  );

  test.serial(
    "an approved parked MCP call remains settled across a pending tool-set change, reopen, and original deadline",
    async () => {
      const calls: Record<string, unknown>[] = [];
      const reloaded = await decideThenReload(
        { name: SAVE_ISSUE, args: { title: "late approval" } },
        (session) => session.harness.scenario.matchedRequests().length === 2,
        {
          prepare: async (session) => {
            session.toolset.dynamicRunner.addTools(
              mcpClientTools(linearClient(calls)),
            );
            await session.rebuild();
          },
          afterApprovalOpened: (session) => {
            // The prompt is live before this MCP change requests its reload.
            session.toolset.dynamicRunner.addTools(
              mcpClientTools(labelClient()),
            );
            expect(
              session.toolset.dynamicRunner.agentToolSetDrift().added,
            ).toContain(CREATE_LABEL);
          },
          rebuildInPlace: true,
        },
      );
      const { session, callId } = reloaded;
      const rebuiltTools = session.toolset.dynamicRunner
        .agentDefinitions()
        .map((definition) => definition.name);
      expect(rebuiltTools).toContain(SAVE_ISSUE);
      expect(rebuiltTools).toContain(CREATE_LABEL);
      expect(calls).toEqual([{ title: "late approval" }]);
      expect(
        toolResultsFor(await session.agent.history(), callId),
      ).toHaveLength(1);

      session.harness.scenario.replyOnce("anthropic", { text: "Saved." });
      const followUp = await runUntilDone(session, "Continue.");
      expect(followUp.reply).toBe("Saved.");

      await passDeadline(reloaded);
      expect(reloaded.events.filter((e) => e.type === "reactor.error")).toEqual(
        [],
      );
      const results = toolResultsFor(await session.agent.history(), callId);
      expect(calls).toEqual([{ title: "late approval" }]);
      expect(results).toHaveLength(1);
      expect(results.join("")).not.toContain("approval timed out");
    },
    20_000,
  );

  // The reload interrupts the approved call, which the closing reactor
  // answers itself. What an interrupted call should report is not pinned
  // here; only that the old deadline cannot add a second result.
  test.serial(
    "during the approved call: the old deadline adds no second result",
    async () => {
      const reloaded = await decideThenReload(
        {
          name: "run_shell",
          args: { command: `sleep 20; ${CLOSED_PORT_PROBE}` },
        },
        (_session, events) => events.some((e) => e.type === "tool.start"),
      );
      const { session, callId } = reloaded;
      expect(
        toolResultsFor(await session.agent.history(), callId),
      ).toHaveLength(1);

      await passDeadline(reloaded);
      expect(reloaded.events.filter((e) => e.type === "reactor.error")).toEqual(
        [],
      );
      expect(
        toolResultsFor(await session.agent.history(), callId),
      ).toHaveLength(1);
    },
    20_000,
  );

  // The TUI defers an MCP tool-set rebuild until the approval-resumed run
  // ends (reloadIfIdle in src/tui/runner/exit.ts, covered by its runner
  // tests). The harness has no TUI runner, so this rebuilds in place at that
  // same boundary, gated on an added tool, one of the drifts reloadIfIdle
  // rebuilds for.
  test.serial(
    "an approved MCP call stays settled when the deferred tool-set rebuild fires at the run's end",
    async () => {
      const calls: Record<string, unknown>[] = [];
      const reloaded = await decideThenReload(
        { name: SAVE_ISSUE, args: { title: "late approval" } },
        (session, events) =>
          events.some((e) => e.type === "message.run.ended") &&
          session.toolset.dynamicRunner.agentToolSetDrift().added.length > 0,
        {
          replyAfterDecision: "Saved.",
          prepare: async (session) => {
            session.toolset.dynamicRunner.addTools(
              mcpClientTools(linearClient(calls)),
            );
            await session.rebuild();
          },
          afterApprovalOpened: (session) => {
            session.toolset.dynamicRunner.addTools(
              mcpClientTools(labelClient()),
            );
          },
          rebuildInPlace: true,
        },
      );
      const { session, callId } = reloaded;
      expect(session.toolset.dynamicRunner.agentToolSetDrift().added).toEqual(
        [],
      );
      expect(
        session.toolset.dynamicRunner
          .agentDefinitions()
          .map((definition) => definition.name),
      ).toContain(CREATE_LABEL);
      expect(calls).toEqual([{ title: "late approval" }]);
      expect(
        toolResultsFor(await session.agent.history(), callId),
      ).toHaveLength(1);

      session.harness.scenario.replyOnce("anthropic", { text: "Done." });
      const followUp = await runUntilDone(session, "Continue.");
      expect(followUp.reply).toBe("Done.");

      await passDeadline(reloaded);
      expect(reloaded.events.filter((e) => e.type === "reactor.error")).toEqual(
        [],
      );
      const results = toolResultsFor(await session.agent.history(), callId);
      expect(calls).toEqual([{ title: "late approval" }]);
      expect(results).toHaveLength(1);
      expect(results.join("")).not.toContain("approval timed out");
    },
    20_000,
  );
});

// Reloads once the model's next turn has started, before the cycle commits:
// where an interrupt or session rotation lands mid-run.
describe("integration: an ask settled without running, then reloading the agent before the cycle commits", () => {
  const continuationStarted = (session: IntegrationSession): boolean =>
    session.harness.scenario.matchedRequests().length === 2;

  test.serial(
    "after a rejection: the rebuilt agent sends the denial once, and the old deadline adds no result",
    async () => {
      const reloaded = await decideThenReload(
        { name: "run_shell", args: { command: CLOSED_PORT_PROBE } },
        continuationStarted,
        { decision: "reject" },
      );
      const { session, callId } = reloaded;
      expect((await session.storage.load()).pendingOperations).toEqual([]);
      const settled = toolResultsFor(await session.agent.history(), callId);
      expect(settled).toHaveLength(1);
      expect(settled.join("")).toContain("denied by approver");

      await passDeadline(reloaded);
      expect(toolResultsFor(await session.agent.history(), callId)).toEqual(
        settled,
      );

      session.harness.scenario.replyOnce("anthropic", { text: "Done." });
      const followUp = await runUntilDone(session, "Continue.");
      expect(followUp.reply).toBe("Done.");
      expect(await lastRequestBlocksFor(session, callId)).toEqual([
        "tool_use",
        "tool_result",
      ]);
      expect(reloaded.events.filter((e) => e.type === "reactor.error")).toEqual(
        [],
      );
    },
    20_000,
  );

  test.serial(
    "after the deadline answers it: the rebuilt agent loads the timeout result and no parked call",
    async () => {
      const reloaded = await decideThenReload(
        { name: "run_shell", args: { command: CLOSED_PORT_PROBE } },
        continuationStarted,
        { decision: "expire" },
      );
      const { session, callId } = reloaded;
      // Read before the rebuilt agent runs: a parked call it loaded would be
      // re-armed at the already-past deadline and answered by the rebuilt
      // reactor itself, which would hide the lost result.
      expect((await session.storage.load()).pendingOperations).toEqual([]);
      const settled = toolResultsFor(await session.agent.history(), callId);
      expect(settled).toHaveLength(1);
      expect(settled.join("")).toContain("approval timed out");

      await passDeadline(reloaded, reloaded.deadline + FRESH_WINDOW_PASSED_MS);
      expect(toolResultsFor(await session.agent.history(), callId)).toEqual(
        settled,
      );

      session.harness.scenario.replyOnce("anthropic", { text: "Done." });
      const followUp = await runUntilDone(session, "Continue.");
      expect(followUp.reply).toBe("Done.");
      expect(await lastRequestBlocksFor(session, callId)).toEqual([
        "tool_use",
        "tool_result",
      ]);
    },
    20_000,
  );
});

// The loop is busy on a second message's inference when the rejection is
// accepted, so the close's abort is served first and only the shutdown flush
// writes the rejection's result. The reactor leaves the approval record
// behind; the session store must close it on load.
describe("integration: a rejection the reactor accepted but never ran, then reopening the agent", () => {
  test.serial(
    "the reopened agent loads the denial once and no parked call, and the old deadline adds no result",
    async () => {
      const {
        live,
        sessionOpts,
        ctx,
        clock,
        suspended,
        events,
        callId,
        deadline,
      } = await parkOnAsk(
        { name: "run_shell", args: { command: CLOSED_PORT_PROBE } },
        {},
      );

      void live.session.agent.send("Still there?").catch(() => undefined);
      await waitFor(
        () => live.session.harness.scenario.matchedRequests().length === 2,
        "second message's inference",
      );
      const resume = createApprovalResume({
        getAgent: () => live.session.agent,
        gate: ctx.gate,
        resolveParkedCallId: (id) =>
          resolveParkedCallIdFromStore(live.session.storage, id),
      });
      const handling = resume.handle(suspended);
      await waitFor(ctx.asked, "approval prompt");
      ctx.reject();
      expect(await handling).toBe(true);
      await waitFor(
        () => events.some((e) => e.type === "message.correlated"),
        "rejection accepted",
      );

      live.session = await rebuildIntegrationSession(live.session, sessionOpts);
      const { session } = live;
      expect((await session.storage.load()).pendingOperations).toEqual([]);
      const settled = toolResultsFor(await session.agent.history(), callId);
      expect(settled).toHaveLength(1);
      expect(settled.join("")).toContain("denied by approver");

      const reloaded = {
        session,
        events: collect(session),
        callId,
        deadline,
        clock,
      };
      await passDeadline(reloaded, deadline + FRESH_WINDOW_PASSED_MS);
      expect(reloaded.events.filter((e) => e.type === "reactor.error")).toEqual(
        [],
      );
      expect(toolResultsFor(await session.agent.history(), callId)).toEqual(
        settled,
      );
    },
    20_000,
  );
});

// Reloads at the run's end, where the TUI's deferred reload fires.
describe("integration: an ask settled without running, then reloading the agent at the run's end", () => {
  const runEnded = (
    _session: IntegrationSession,
    events: ReactorEmittedEvent[],
  ): boolean => events.some((e) => e.type === "message.run.ended");

  test.serial(
    "after a rejection: the rebuilt agent continues, and the old deadline adds no result",
    async () => {
      const reloaded = await decideThenReload(
        { name: "run_shell", args: { command: CLOSED_PORT_PROBE } },
        runEnded,
        { decision: "reject", replyAfterDecision: "Skipped." },
      );
      const { session, callId } = reloaded;
      const settled = toolResultsFor(await session.agent.history(), callId);
      expect(settled).toHaveLength(1);
      expect(settled.join("")).toContain("denied by approver");

      session.harness.scenario.replyOnce("anthropic", { text: "Done." });
      const followUp = await runUntilDone(session, "Continue.");
      expect(followUp.reply).toBe("Done.");

      await passDeadline(reloaded);
      expect(reloaded.events.filter((e) => e.type === "reactor.error")).toEqual(
        [],
      );
      const results = toolResultsFor(await session.agent.history(), callId);
      expect(results).toEqual(settled);
      expect(results.join("")).not.toContain("approval timed out");
    },
    20_000,
  );

  test.serial(
    "after the deadline answers it: the rebuilt agent continues, and no later deadline adds a second result",
    async () => {
      const reloaded = await decideThenReload(
        { name: "run_shell", args: { command: CLOSED_PORT_PROBE } },
        runEnded,
        { decision: "expire", replyAfterDecision: "Timed out." },
      );
      const { session, callId } = reloaded;
      const settled = toolResultsFor(await session.agent.history(), callId);
      expect(settled).toHaveLength(1);
      expect(settled.join("")).toContain("approval timed out");

      session.harness.scenario.replyOnce("anthropic", { text: "Done." });
      const followUp = await runUntilDone(session, "Continue.");
      expect(followUp.reply).toBe("Done.");

      await passDeadline(reloaded, reloaded.deadline + FRESH_WINDOW_PASSED_MS);
      expect(reloaded.events.filter((e) => e.type === "reactor.error")).toEqual(
        [],
      );
      expect(toolResultsFor(await session.agent.history(), callId)).toEqual(
        settled,
      );
    },
    20_000,
  );
});

describe("integration: an ask dropped by an interrupt, then settled on the rebuilt agent", () => {
  for (const adapter of ADAPTERS) {
    test.serial(
      `${adapter.name}: the drop settles with no model turn, and the next send carries it once`,
      async () => {
        const reloaded = await dropThenInterrupt(
          { name: "run_shell", args: { command: CLOSED_PORT_PROBE } },
          adapter,
        );
        const { session, callId, events, resume } = reloaded;
        const requests = () => session.harness.scenario.matchedRequests();

        expect((await session.storage.load()).pendingOperations).toEqual([]);
        const settled = toolResultsFor(await session.agent.history(), callId);
        expect(settled).toHaveLength(1);
        expect(settled.join("")).toContain(APPROVAL_DROPPED_NOTICE);
        expect(toolResultsFor(await committedTurns(session), callId)).toEqual(
          settled,
        );
        expect(requests()).toHaveLength(0);
        expect(events.filter((e) => e.type === "inference.start")).toEqual([]);
        expect(resume.droppedCalls.claim(callId)).toBe(false);

        await passDeadline(reloaded);
        expect(toolResultsFor(await session.agent.history(), callId)).toEqual(
          settled,
        );
        expect(requests()).toHaveLength(0);

        session.harness.scenario.replyOnce(adapter.provider, {
          text: "Noted.",
        });
        const followUp = await runUntilDone(session, "Continue.");
        expect(followUp.reply).toBe("Noted.");
        const [request] = requests();
        expect(requests()).toHaveLength(1);
        if (request === undefined) throw new Error("no request");
        const body = await (request.clone() as unknown as Request).text();
        // Once as the tool call, once as its result.
        expect(body.split(callId).length - 1).toBe(2);
        expect(body.indexOf(APPROVAL_DROPPED_NOTICE)).toBeGreaterThan(-1);
        expect(body.indexOf(APPROVAL_DROPPED_NOTICE)).toBeLessThan(
          body.lastIndexOf("Continue."),
        );
        expect(events.filter((e) => e.type === "reactor.error")).toEqual([]);
      },
      20_000,
    );
  }

  test.serial(
    "a drop whose deadline passes during the rebuild settles with no model turn",
    async () => {
      const reloaded = await dropThenInterrupt(
        { name: "run_shell", args: { command: CLOSED_PORT_PROBE } },
        NATIVE_ANTHROPIC,
        { deadlinePassesDuringRebuild: true },
      );
      const { session, callId, events } = reloaded;

      expect((await session.storage.load()).pendingOperations).toEqual([]);
      expect(
        toolResultsFor(await session.agent.history(), callId),
      ).toHaveLength(1);
      expect(session.harness.scenario.matchedRequests()).toHaveLength(0);
      expect(events.filter((e) => e.type === "inference.start")).toEqual([]);
    },
    20_000,
  );

  /** The approved call never ran, and the rebuilt agent settled it once. */
  async function expectSettledWithoutRunning(reloaded: Dropped): Promise<void> {
    const { session, callId, events, parkedEvents } = reloaded;
    expect(reloaded.parkedAtRebuild).toEqual([callId]);
    expect(parkedEvents.filter((e) => e.type === "tool.start")).toEqual([]);
    expect((await session.storage.load()).pendingOperations).toEqual([]);
    const settled = toolResultsFor(await session.agent.history(), callId);
    expect(settled).toHaveLength(1);
    expect(settled.join("")).toContain(APPROVAL_DROPPED_NOTICE);
    expect(session.harness.scenario.matchedRequests()).toHaveLength(0);
    expect(events.filter((e) => e.type === "inference.start")).toEqual([]);

    await passDeadline(reloaded, reloaded.deadline + FRESH_WINDOW_PASSED_MS);
    expect(toolResultsFor(await session.agent.history(), callId)).toEqual(
      settled,
    );
    expect(events.filter((e) => e.type === "reactor.error")).toEqual([]);
  }

  test.serial(
    "an approval the interrupt skips while it waits for delivery settles with no model turn",
    async () => {
      const reloaded = await dropThenInterrupt(
        { name: "run_shell", args: { command: CLOSED_PORT_PROBE } },
        NATIVE_ANTHROPIC,
        { interruptWhile: "decision-queued" },
      );

      await expectSettledWithoutRunning(reloaded);
      expect(reloaded.resume.status(reloaded.correlationId)).not.toBe(
        "handed-over",
      );
    },
    20_000,
  );
});
