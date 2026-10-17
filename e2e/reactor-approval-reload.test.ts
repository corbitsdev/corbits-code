/**
 * An approved ask whose agent is rebuilt from the same store before the next
 * cycle commit (the TUI's deferred reload) must not leave the parked call's
 * pending operation behind: the rebuilt reactor would re-arm its gate and, at
 * the original deadline, answer an already-answered call with "approval timed
 * out".
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";

import type { ReactorEmittedEvent } from "@intx/inference";
import type { ConversationTurn } from "@intx/types/runtime";

import { createPermissionGate } from "../src/permission/gate.js";
import { createReactorAuthorize } from "../src/permission/reactor-authorize.js";
import {
  createApprovalResume,
  resolveParkedCallIdFromStore,
} from "../src/session/approval-resume.js";
import {
  closeIntegrationSession,
  openIntegrationSession,
  rebuildIntegrationSession,
  runUntilDone,
  runUntilSuspended,
  type IntegrationSession,
} from "./integration-harness.js";

// Ask-tier, but answered locally: nothing listens on the discard port.
const CLOSED_PORT_PROBE = "curl -sS --max-time 1 http://127.0.0.1:9/";

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

/**
 * Parks `command` on an ask, approves it, and once `reloadWhen` holds for
 * the approved run, rebuilds the agent on the same store. The model turn
 * after the approved result stays open, so the reload always lands before
 * the reply terminal commits the cycle.
 */
async function approveThenReload(
  command: string,
  reloadWhen: (
    session: IntegrationSession,
    events: ReactorEmittedEvent[],
  ) => boolean,
): Promise<Reloaded> {
  const ctx = deferredApprovalGate();
  const sessionOpts = {
    permissionGate: ctx.gate,
    authorize: createReactorAuthorize(ctx.gate),
  };
  let session = await openIntegrationSession(sessionOpts);
  cleanups.push(() => closeIntegrationSession(session));

  session.harness.scenario.replyOnce("anthropic", {
    toolCalls: [{ name: "run_shell", args: { command } }],
  });
  session.harness.scenario.stall();

  const turn = await runUntilSuspended(session, "Probe the local port.");
  if (turn.result.type !== "suspended") throw new Error("did not park");
  const { correlationId } = turn.result;
  const parked = (await session.storage.load()).pendingOperations.find(
    (op) => op.correlationId === correlationId,
  );
  const callId = parked?.suspendedCall?.id;
  const deadline = parked?.timeoutAt;
  if (callId === undefined || deadline === undefined) {
    throw new Error("parked call has no persisted call id or deadline");
  }

  const resume = createApprovalResume({
    getAgent: () => session.agent,
    gate: ctx.gate,
    resolveParkedCallId: (id) =>
      resolveParkedCallIdFromStore(session.storage, id),
  });
  const handling = resume.handle(turn.result);
  await waitFor(ctx.asked, "approval prompt");
  ctx.approve();
  expect(await handling).toBe(true);
  void session.harness
    .run({ wallClockBudgetMs: 30_000 })
    .catch(() => undefined);
  const before = session;
  await waitFor(() => reloadWhen(before, turn.events), "reload point");

  const clock = holdLongTimers();
  cleanups.push(() => clock.restore());
  session = await rebuildIntegrationSession(session, sessionOpts);
  return { session, events: collect(session), callId, deadline, clock };
}

/** Moves past the original approval deadline and lets the reactor react. */
async function passDeadline(reloaded: Reloaded): Promise<void> {
  reloaded.clock.advanceTo(reloaded.deadline + 1_000);
  await reloaded.session.harness
    .run({ wallClockBudgetMs: 2_000 })
    .catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("integration: approving an ask, then reloading the agent", () => {
  test.serial(
    "after the approved result: the rebuilt agent continues, and the old deadline adds no result",
    async () => {
      const reloaded = await approveThenReload(
        CLOSED_PORT_PROBE,
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

  // The reload interrupts the approved call, which the closing reactor
  // answers itself. What an interrupted call should report is not pinned
  // here; only that the old deadline cannot add a second result.
  test.serial(
    "during the approved call: the old deadline adds no second result",
    async () => {
      const reloaded = await approveThenReload(
        `sleep 20; ${CLOSED_PORT_PROBE}`,
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
});
