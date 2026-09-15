import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createInboundMessage } from "@intx/mime";
import type {
  ContextStore,
  InboundMessage,
  PendingOperation,
  ReactorInboundEvent,
  ReactorState,
} from "@intx/types/runtime";
import {
  createReactor,
  type ReactorConfig,
  type ReactorEmittedEvent,
} from "../../vendor/intx-inference/src/reactor.js";
import { createDefaultDependencies } from "../../vendor/intx-inference/src/providers/index.js";
import { createSessionOperationQueue } from "../../src/tui/delivery-queue.js";

const call = { id: "parked-call", name: "test_tool", arguments: {} };
const epoch = 100_000;
function pending(
  timeoutAt: number | undefined = epoch + 1000,
): PendingOperation {
  return {
    correlationId: "approval",
    kind: "approval",
    gateId: "gate",
    registeredAt: epoch,
    suspendedCall: call,
    ...(timeoutAt === undefined ? {} : { timeoutAt }),
  };
}
function decision(
  outcome: "approved" | "rejected" = "approved",
): InboundMessage {
  const message = createInboundMessage({
    from: "signal@local",
    to: "agent@local",
    correlationId: "approval",
    content: JSON.stringify({ outcome }),
  });
  message.headers.interchangeType =
    outcome === "approved" ? "approval.granted" : "approval.denied";
  return message;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function drain() {
  for (let i = 0; i < 100; i++) await Promise.resolve(undefined);
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function harness(
  options: {
    op?: PendingOperation;
    validator?: ReactorConfig["correlationValidator"];
    grant?: () => void;
    event?: (event: ReactorEmittedEvent) => void;
  } = {},
) {
  let now = epoch;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const timers: (() => void)[] = [];
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
  ) => {
    timers.push(callback);
    return timers.length;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(
    (): void => undefined,
  );
  const events: ReactorEmittedEvent[] = [];
  const directed: ReactorInboundEvent[] = [];
  const snapshots: ReactorState[] = [];
  const grants: string[] = [];
  const tools: string[] = [];
  let hold: Promise<void> | undefined;
  const closing = deferred<undefined>();
  const store: ContextStore = {
    load: async () => ({
      turns: [
        {
          role: "assistant",
          content: [{ type: "tool_call", ...call }],
          timestamp: epoch,
        },
      ],
      pendingOperations: [options.op ?? pending()],
      tokenUsage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        thinking: 0,
      },
      connectorState: null,
    }),
    setConnectorState: () => undefined,
    commit: async ({ message }) => ({ hash: "test", message, timestamp: now }),
    branch: async () => undefined,
    log: async () => [],
    readAt: async () => [],
    writeBlob: async () => undefined,
    readBlob: async () => {
      throw new Error("unused");
    },
    writePrompt: async () => undefined,
    writeResponse: async () => undefined,
    writeManifest: async () => undefined,
    writeTurns: async () => undefined,
    writeMetadata: async () => undefined,
    readManifestHistory: async () => [],
  };
  const reactor = createReactor({
    sessionId: "atomic-approval",
    source: {
      id: "test",
      provider: "anthropic",
      model: "test",
      baseURL: "https://example.com",
      credentialId: "test",
    },
    deps: createDefaultDependencies(),
    contextStore: store,
    gateTimeout: 1000,
    ...(options.validator === undefined
      ? {}
      : { correlationValidator: options.validator }),
    beforeToolExtensions: [
      {
        beforeTool: async () => ({ type: "allow" }),
        grantOneShot(id) {
          grants.push(id);
          options.grant?.();
        },
      },
    ],
    toolRunner: {
      async run(tool) {
        tools.push(tool.id);
        return { callId: tool.id, content: "executed" };
      },
    },
    onEvent(event) {
      events.push(event);
      options.event?.(event);
    },
    director: {
      async decide(event, state, caps) {
        directed.push(event);
        snapshots.push(state);
        if (hold !== undefined) await Promise.race([hold, closing.promise]);
        if (event.type === "resume.execute_tools")
          return caps.executeTools(event.calls, false, true);
        return caps.wait();
      },
    },
  });
  cleanups.push(async () => {
    closing.resolve(undefined);
    hold = undefined;
    reactor.abort("admin_kill");
    await drain();
    timer.mockRestore();
    clear.mockRestore();
    clock.mockRestore();
  });
  reactor.start();
  await drain();
  expect(events.some((e) => e.type === "reactor.start")).toBe(true);
  return {
    reactor,
    events,
    directed,
    snapshots,
    grants,
    tools,
    advance(value: number) {
      now = value;
    },
    expire() {
      now = epoch + 1000;
      const fire = timers[0];
      if (!fire) throw new Error("gate timer missing");
      fire();
    },
    hold(value: Promise<void> | undefined) {
      hold = value;
    },
  };
}
function accepted(h: Awaited<ReturnType<typeof harness>>) {
  return h.events.filter((e) => e.type === "message.correlated");
}
function received(h: Awaited<ReturnType<typeof harness>>) {
  return h.events.filter((e) => e.type === "message.received");
}
function resumes(h: Awaited<ReturnType<typeof harness>>) {
  return h.directed.filter(
    (e) => e.type === "resume.execute_tools" || e.type === "resume.tool_result",
  );
}
function expectDiscard(h: Awaited<ReturnType<typeof harness>>) {
  expect(accepted(h)).toHaveLength(0);
  expect(received(h)).toHaveLength(0);
  expect(h.grants).toHaveLength(0);
  expect(h.tools).toHaveLength(0);
}

describe("atomic typed approval acceptance", () => {
  test("expiry before timeout result publication cannot become ordinary input", async () => {
    const h = await harness();
    const hold = deferred<undefined>();
    h.hold(hold.promise);
    h.reactor.deliver(
      createInboundMessage({
        from: "user@local",
        to: "agent@local",
        content: "hold director",
      }),
    );
    await drain();
    h.expire();
    const stale = decision();
    stale.content = "not JSON";
    h.reactor.deliver(stale);
    await drain();
    expect(accepted(h)).toHaveLength(0);
    expect(received(h)).toHaveLength(1);
    expect(h.grants).toHaveLength(0);
    expect(h.tools).toHaveLength(0);
    expect(resumes(h)).toHaveLength(0);
    hold.resolve(undefined);
    h.hold(undefined);
    await drain();
    expect(resumes(h)).toHaveLength(1);
    expect(JSON.stringify(h.snapshots.at(-1)?.turns)).toContain(
      "approval timed out",
    );
    expect(JSON.stringify(h.snapshots.at(-1)?.turns)).not.toContain("not JSON");
  });
  test("actual session operation queue drains an expired approval to Reactor.deliver", async () => {
    const h = await harness();
    const queue = createSessionOperationQueue();
    const held = deferred<undefined>();
    queue.enqueue(() => held.promise);
    queue.enqueue(async () => {
      h.reactor.deliver(decision());
    });
    await drain();
    h.expire();
    held.resolve(undefined);
    await queue.awaitTail();
    await drain();
    expectDiscard(h);
    expect(resumes(h)).toHaveLength(1);
  });
  test("expiry during validator await discards the claimed decision", async () => {
    const valid = deferred<boolean>();
    const h = await harness({ validator: { validate: () => valid.promise } });
    h.reactor.deliver(decision());
    await drain();
    h.expire();
    valid.resolve(true);
    await drain();
    expectDiscard(h);
    expect(resumes(h)).toHaveLength(1);
  });
  for (const outcome of ["approved", "rejected"] as const)
    test(`live ${outcome} and concurrent/postconsumption duplicates resume once`, async () => {
      const valid = deferred<boolean>();
      const h = await harness({ validator: { validate: () => valid.promise } });
      h.reactor.deliver(decision(outcome));
      h.reactor.deliver(decision(outcome));
      valid.resolve(true);
      await drain();
      h.reactor.deliver(decision(outcome));
      await drain();
      expect(accepted(h)).toHaveLength(1);
      expect(received(h)).toHaveLength(0);
      expect(resumes(h)).toHaveLength(1);
      expect(h.grants).toHaveLength(outcome === "approved" ? 1 : 0);
      expect(h.tools).toHaveLength(outcome === "approved" ? 1 : 0);
      expect(JSON.stringify(h.snapshots.at(-1)?.turns)).toContain(
        outcome === "approved" ? "executed" : "denied by approver",
      );
    });
  for (const deadline of [epoch - 1, epoch])
    test(`persisted deadline ${deadline} is not revived by the clamped timer`, async () => {
      const h = await harness({ op: pending(deadline) });
      h.reactor.deliver(decision());
      await drain();
      expectDiscard(h);
      expect(resumes(h)).toHaveLength(0);
    });
  test("deadline equality wins before actual timer callback", async () => {
    const h = await harness();
    h.advance(epoch + 1000);
    h.reactor.deliver(decision());
    await drain();
    expectDiscard(h);
    expect(resumes(h)).toHaveLength(0);
  });
  test("termination during validation prevents successful acceptance", async () => {
    const valid = deferred<boolean>();
    const h = await harness({ validator: { validate: () => valid.promise } });
    h.reactor.deliver(decision());
    h.reactor.abort("admin_kill");
    await drain();
    valid.resolve(true);
    await drain();
    expectDiscard(h);
    expect(resumes(h)).toHaveLength(0);
  });
  for (const failure of ["false", "throw"] as const)
    test(`validator ${failure} releases claim for valid retry`, async () => {
      let first = true;
      const h = await harness({
        validator: {
          async validate() {
            if (!first) return true;
            first = false;
            if (failure === "throw") throw new Error("validator failed");
            return false;
          },
        },
      });
      h.reactor.deliver(decision());
      await drain();
      expectDiscard(h);
      h.reactor.deliver(decision());
      await drain();
      expect(accepted(h)).toHaveLength(1);
      expect(resumes(h)).toHaveLength(1);
      expect(h.tools).toHaveLength(1);
    });
  for (const suspended of [true, false])
    test(`contradictory header/body with suspendedCall=${suspended} cannot resume`, async () => {
      const op = pending();
      if (!suspended) delete op.suspendedCall;
      const h = await harness({ op });
      const message = decision();
      message.content = JSON.stringify({ outcome: "rejected" });
      h.reactor.deliver(message);
      await drain();
      expectDiscard(h);
      expect(resumes(h)).toHaveLength(0);
      if (suspended)
        expect(h.events.some((e) => e.type === "reactor.error")).toBe(true);
    });
  for (const callback of ["grant", "event"] as const)
    test(`synchronous duplicate from ${callback} does not resume twice`, async () => {
      let deliver = (): void => undefined;
      const duplicate = () => deliver();
      const h = await harness(
        callback === "grant"
          ? { grant: duplicate }
          : {
              event: (event) => {
                if (event.type === "message.correlated") duplicate();
              },
            },
      );
      deliver = () => h.reactor.deliver(decision());
      h.reactor.deliver(decision());
      await drain();
      expect(accepted(h)).toHaveLength(1);
      expect(received(h)).toHaveLength(0);
      expect(h.grants).toHaveLength(1);
      expect(h.tools).toHaveLength(1);
      expect(resumes(h)).toHaveLength(1);
    });
  for (const action of ["throw", "abort"] as const)
    test(`grant hook ${action} cannot publish successful acceptance`, async () => {
      let abort = (): void => undefined;
      const h = await harness({
        grant() {
          if (action === "throw") throw new Error("grant failed");
          abort();
        },
      });
      abort = () => h.reactor.abort("admin_kill");
      h.reactor.deliver(decision());
      await drain();
      expect(accepted(h)).toHaveLength(0);
      expect(received(h)).toHaveLength(0);
      expect(h.grants).toHaveLength(1);
      expect(h.tools).toHaveLength(0);
      expect(resumes(h)).toHaveLength(0);
    });
  for (const action of ["throw", "abort"] as const)
    test(`acceptance observer ${action} happens after consumption, without a second resume`, async () => {
      let reenter = (): void => undefined;
      const h = await harness({
        event(event) {
          if (event.type !== "message.correlated") return;
          reenter();
          if (action === "throw") throw new Error("observer failed");
        },
      });
      reenter = () => {
        h.reactor.deliver(decision());
        if (action === "abort") h.reactor.abort("admin_kill");
      };
      h.reactor.deliver(decision());
      await drain();
      expect(accepted(h)).toHaveLength(1);
      expect(received(h)).toHaveLength(0);
      expect(h.grants).toHaveLength(1);
      expect(resumes(h).length).toBeLessThanOrEqual(1);
      expect(h.tools.length).toBeLessThanOrEqual(1);
      expect(h.events.some((e) => e.type === "reactor.done")).toBe(true);
    });
  test("gate deadline applies when the operation has no persisted deadline", async () => {
    const op = pending();
    delete op.timeoutAt;
    const h = await harness({ op });
    h.advance(epoch + 1000);
    h.reactor.deliver(decision());
    await drain();
    expectDiscard(h);
    expect(resumes(h)).toHaveLength(0);
  });
  test("grant callback advancing the clock cannot accept an expired operation", async () => {
    let expire = (): void => undefined;
    const h = await harness({ grant: () => expire() });
    expire = () => h.advance(epoch + 1000);
    h.reactor.deliver(decision());
    await drain();
    expect(accepted(h)).toHaveLength(0);
    expect(received(h)).toHaveLength(0);
    expect(h.grants).toHaveLength(1);
    expect(h.tools).toHaveLength(0);
    expect(resumes(h)).toHaveLength(0);
  });
  for (const correlation of [undefined, "unknown"])
    test(`typed unknown correlation ${correlation} discards before parsing`, async () => {
      const h = await harness();
      const message = decision();
      message.content = "malformed";
      if (correlation === undefined)
        delete message.headers.interchangeCorrelationId;
      else message.headers.interchangeCorrelationId = correlation;
      h.reactor.deliver(message);
      await drain();
      expectDiscard(h);
      expect(resumes(h)).toHaveLength(0);
      expect(h.events.some((e) => e.type === "reactor.error")).toBe(false);
    });
  test("live malformed typed decisions retain the fatal error policy", async () => {
    const h = await harness();
    const message = decision();
    message.content = "malformed";
    h.reactor.deliver(message);
    await drain();
    expectDiscard(h);
    expect(resumes(h)).toHaveLength(0);
    expect(h.events.some((e) => e.type === "reactor.error")).toBe(true);
    expect(h.events.some((e) => e.type === "reactor.done")).toBe(true);
  });
  for (const failure of ["false", "throw"] as const)
    test(`nonapproval validator ${failure} retains ordinary fallback`, async () => {
      const h = await harness({
        validator: {
          async validate() {
            if (failure === "throw") throw new Error("invalid sender");
            return false;
          },
        },
      });
      const message = decision();
      message.headers.interchangeType = "offering.response";
      h.reactor.deliver(message);
      await drain();
      expect(received(h)).toHaveLength(1);
      expect(accepted(h)).toHaveLength(0);
      expect(h.grants).toHaveLength(0);
      expect(resumes(h)).toHaveLength(0);
    });
  test("ordinary unknown correlations, approval-shaped text and nonapproval responses retain routing", async () => {
    const op = pending();
    delete op.suspendedCall;
    const h = await harness({ op });
    for (const correlationId of [undefined, "unknown"]) {
      h.reactor.deliver(
        createInboundMessage({
          from: "user@local",
          to: "agent@local",
          content: JSON.stringify({ outcome: "approved" }),
          ...(correlationId === undefined ? {} : { correlationId }),
        }),
      );
    }
    h.reactor.deliver(
      createInboundMessage({
        from: "worker@local",
        to: "agent@local",
        content: "async response",
        correlationId: "approval",
      }),
    );
    await drain();
    expect(received(h)).toHaveLength(2);
    expect(accepted(h)).toHaveLength(1);
    expect(h.grants).toHaveLength(0);
    expect(h.tools).toHaveLength(0);
    expect(JSON.stringify(h.snapshots.at(-1)?.turns)).toContain(
      "async response",
    );
    expect(JSON.stringify(h.snapshots.at(-1)?.turns)).toContain("approved");
  });
});
