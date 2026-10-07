import { describe, test, expect } from "bun:test";

import { WORKER_CANNOT_COMPLETE_APPROVAL } from "./decline-markers.js";
import {
  WORKER_GRANT_TTL_MS,
  WorkerGrantStore,
  createDeniedCallEnvelope,
  fingerprintDeniedCall,
  formatWorkerDenyWithGrantId,
} from "./worker-grant.js";

const ARGS = { command: "npm test" };
const CWD = "/tmp/worker-grant-unit";

function descriptor(
  overrides: Partial<Parameters<typeof createDeniedCallEnvelope>[0]> = {},
) {
  return {
    callId: "call-1",
    tool: "run_shell",
    action: "Run",
    subject: "npm test",
    args: { ...ARGS },
    cwd: CWD,
    workerSessionId: "worker-1",
    now: 1_000_000,
    ...overrides,
  };
}

describe("fingerprintDeniedCall", () => {
  test("is stable across key order", () => {
    const a = fingerprintDeniedCall("run_shell", { x: 1, y: 2 }, CWD);
    const b = fingerprintDeniedCall("run_shell", { y: 2, x: 1 }, CWD);
    expect(a).toBe(b);
  });

  test("is path-aware: relative args resolve against cwd", () => {
    const a = fingerprintDeniedCall(
      "read_file",
      { path: "sub/../notes.md" },
      "/repo",
    );
    const b = fingerprintDeniedCall("read_file", { path: "notes.md" }, "/repo");
    expect(a).toBe(b);
  });

  test("differs across args and tool (cwd binds at precheck, not in the hash)", () => {
    const base = fingerprintDeniedCall("run_shell", ARGS, CWD);
    expect(
      fingerprintDeniedCall("run_shell", { command: "npm run evil" }, CWD),
    ).not.toBe(base);
    expect(fingerprintDeniedCall("read_file", ARGS, CWD)).not.toBe(base);
    expect(
      fingerprintDeniedCall("read_file", { path: "a.md" }, "/repo") ===
        fingerprintDeniedCall("read_file", { path: "b.md" }, "/repo"),
    ).toBe(false);
  });
});

describe("formatWorkerDenyWithGrantId", () => {
  test("keeps deny + approval text, names only the requestId", () => {
    const requestId = "11111111-2222-4333-8444-555555555555";
    const reason = formatWorkerDenyWithGrantId(
      `deny: Run (npm test) requires a parent permission grant; ${WORKER_CANNOT_COMPLETE_APPROVAL}`,
      requestId,
    );
    expect(reason).toContain("deny");
    expect(reason).toContain(WORKER_CANNOT_COMPLETE_APPROVAL);
    expect(reason).toContain(requestId);
    expect(reason).not.toContain("npm test --secret=hunter2");
  });
});

describe("WorkerGrantStore lifecycle", () => {
  test("register → pending with ~10min expiry and denied audit", () => {
    const store = new WorkerGrantStore();
    const envelope = store.register(createDeniedCallEnvelope(descriptor()));
    expect(envelope.status).toBe("pending");
    expect(envelope.expiresAt - envelope.createdAt).toBe(WORKER_GRANT_TTL_MS);
    expect(envelope.audit.map((event) => event.event)).toEqual(["denied"]);
    expect(store.peek(envelope.requestId)).toBe(envelope);
  });

  test("pending own envelope prechecks ok; unknown calls pass through", () => {
    const store = new WorkerGrantStore();
    store.register(createDeniedCallEnvelope(descriptor()));
    expect(
      store.precheck({
        sessionId: "worker-1",
        canonicalTool: "run_shell",
        args: { ...ARGS },
        cwd: CWD,
        now: 1_000_001,
      }),
    ).toEqual({ ok: true });
    expect(
      store.precheck({
        sessionId: "worker-1",
        canonicalTool: "run_shell",
        args: { command: "unrelated" },
        cwd: CWD,
      }),
    ).toEqual({ ok: true });
  });

  test("consumeOnAllow consumes once; replay fails closed as consumed", () => {
    const store = new WorkerGrantStore();
    const envelope = store.register(createDeniedCallEnvelope(descriptor()));
    const identity = {
      sessionId: "worker-1",
      canonicalTool: "run_shell",
      args: { ...ARGS },
      cwd: CWD,
      now: 1_000_001,
    };
    expect(store.consumeOnAllow(identity)?.requestId).toBe(envelope.requestId);
    expect(envelope.status).toBe("consumed");
    expect(store.consumeOnAllow(identity)).toBeUndefined();
    const replay = store.precheck(identity);
    expect(replay.ok).toBe(false);
    if (replay.ok) throw new Error("expected blocker");
    expect(replay.blocker).toContain(envelope.requestId);
    expect(replay.blocker).toContain("already consumed");
  });

  test("tampered cwd fails closed; sibling session falls through to its own round", () => {
    const store = new WorkerGrantStore();
    const envelope = store.register(createDeniedCallEnvelope(descriptor()));
    store.consumeOnAllow({
      sessionId: "worker-1",
      canonicalTool: "run_shell",
      args: { ...ARGS },
      cwd: CWD,
      now: 1_000_001,
    });
    // Same call, wrong cwd: the session grant is not cwd-scoped, so the
    // backstop refuses.
    const cwdTamper = store.precheck({
      sessionId: "worker-1",
      canonicalTool: "run_shell",
      args: { ...ARGS },
      cwd: "/elsewhere",
      now: 1_000_002,
    });
    expect(cwdTamper.ok).toBe(false);
    if (cwdTamper.ok) throw new Error("expected blocker");
    expect(cwdTamper.blocker).toContain(CWD);
    // A sibling session is never vetoed: it falls through to its own round.
    const sessionFallthrough = store.precheck({
      sessionId: "worker-2",
      canonicalTool: "run_shell",
      args: { ...ARGS },
      cwd: CWD,
      now: 1_000_002,
    });
    expect(sessionFallthrough).toEqual({ ok: true });
    // Tampered args or tool: a different fingerprint, so the gate denies
    // fresh downstream.
    for (const identity of [
      {
        sessionId: "worker-1",
        canonicalTool: "run_shell",
        args: { command: "npm run evil" },
        cwd: CWD,
        now: 1_000_002,
      },
      {
        sessionId: "worker-1",
        canonicalTool: "read_file",
        args: { ...ARGS },
        cwd: CWD,
        now: 1_000_002,
      },
    ]) {
      expect(store.precheck(identity)).toEqual({ ok: true });
    }
    expect(envelope.status).toBe("consumed");
  });

  test("another session's envelope never vetoes this session's round", () => {
    const store = new WorkerGrantStore();
    store.register(createDeniedCallEnvelope(descriptor()));
    const result = store.precheck({
      sessionId: "worker-2",
      canonicalTool: "run_shell",
      args: { ...ARGS },
      cwd: CWD,
      now: 1_000_001,
    });
    expect(result).toEqual({ ok: true });
  });

  test("expiry yields a fresh gate round, never a blackhole", () => {
    const store = new WorkerGrantStore();
    const envelope = store.register(createDeniedCallEnvelope(descriptor()));
    const after = envelope.expiresAt + 1;
    // A lapsed window passes through: the gate denies fresh and mints a new
    // envelope.
    expect(
      store.precheck({
        sessionId: "worker-1",
        canonicalTool: "run_shell",
        args: { ...ARGS },
        cwd: CWD,
        now: after,
      }),
    ).toEqual({ ok: true });
    expect(envelope.status).toBe("expired");
    expect(envelope.audit.map((event) => event.event)).toEqual([
      "denied",
      "expired",
    ]);

    const second = store.register(
      createDeniedCallEnvelope(descriptor({ callId: "call-2" })),
    );
    expect(store.sweepExpired(second.expiresAt + 1)).toBe(1);
    expect(second.status).toBe("expired");
  });

  test("post-expiry re-issue mints a fresh envelope for the same exact call", () => {
    const store = new WorkerGrantStore();
    const first = store.register(createDeniedCallEnvelope(descriptor()));
    const after = first.expiresAt + 1;
    expect(store.sweepExpired(after)).toBe(1);
    expect(first.status).toBe("expired");
    // The retry denies fresh: a new envelope with a new id.
    const reissue = store.register(
      createDeniedCallEnvelope(
        descriptor({ callId: "call-2", now: after + 1_000 }),
      ),
    );
    expect(reissue.requestId).not.toBe(first.requestId);
    expect(reissue.status).toBe("pending");
    const identity = {
      sessionId: "worker-1",
      canonicalTool: "run_shell",
      args: { ...ARGS },
      cwd: CWD,
      now: after + 1_001,
    };
    expect(store.precheck(identity)).toEqual({ ok: true });
    expect(store.consumeOnAllow(identity)?.requestId).toBe(reissue.requestId);
    expect(reissue.status).toBe("consumed");
    expect(first.status).toBe("expired");
  });

  test("read sites never surface an expired denial without an explicit sweep", () => {
    const store = new WorkerGrantStore();
    const envelope = store.register(createDeniedCallEnvelope(descriptor()));
    const after = envelope.expiresAt + 1;
    // No sweepExpired call here: each read enforces the TTL itself.
    expect(
      store.pendingMatch("worker-1", "run_shell", { ...ARGS }, CWD, after),
    ).toBeUndefined();
    expect(
      store.attachToAsk("worker-1", "ask-late", undefined, after),
    ).toBeUndefined();
    expect(store.pendingForSession("worker-1", after)).toBeUndefined();
    expect(envelope.status).toBe("expired");
    expect(envelope.audit.map((event) => event.event)).toEqual([
      "denied",
      "expired",
    ]);
    expect(envelope.questionId).toBeUndefined();
  });

  test("interrupt invalidation tombstones pending envelopes", () => {
    const store = new WorkerGrantStore();
    const envelope = store.register(createDeniedCallEnvelope(descriptor()));
    expect(store.invalidateSession("worker-1", "operator interrupt")).toBe(1);
    expect(envelope.status).toBe("interrupted");
    const result = store.precheck({
      sessionId: "worker-1",
      canonicalTool: "run_shell",
      args: { ...ARGS },
      cwd: CWD,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected blocker");
    expect(result.blocker).toContain("interrupt");
    expect(store.invalidateSession("worker-1", "again")).toBe(0);
  });

  test("attachToAsk stamps the questionId and keeps pending", () => {
    const store = new WorkerGrantStore();
    const envelope = store.register(createDeniedCallEnvelope(descriptor()));
    // Reads pin the clock: fixture now predates wall time, so an unpinned
    // read would sweep the envelope as expired.
    expect(store.attachToAsk("worker-1", "ask-7", undefined, 1_000_001)).toBe(
      envelope,
    );
    expect(envelope.questionId).toBe("ask-7");
    expect(envelope.status).toBe("pending");
    expect(store.peek(envelope.requestId)).toBe(envelope);
    expect(
      store.attachToAsk("worker-9", "ask-8", undefined, 1_000_001),
    ).toBeUndefined();
    expect(envelope.audit.map((event) => event.event)).toEqual([
      "denied",
      "asked",
    ]);
  });

  describe("two-denies correlation", () => {
    function twoDenies() {
      const store = new WorkerGrantStore();
      const envelopeA = store.register(
        createDeniedCallEnvelope(
          descriptor({ callId: "call-A", args: { command: "npm test" } }),
        ),
      );
      const envelopeB = store.register(
        createDeniedCallEnvelope(
          descriptor({ callId: "call-B", args: { command: "npm run lint" } }),
        ),
      );
      return { store, envelopeA, envelopeB };
    }

    test("named ask binds its exact denial, not the first pending", () => {
      const { store, envelopeA, envelopeB } = twoDenies();
      expect(
        store.attachToAsk("worker-1", "ask-B", envelopeB.requestId, 1_000_001),
      ).toBe(envelopeB);
      expect(envelopeB.questionId).toBe("ask-B");
      expect(envelopeA.questionId).toBeUndefined();
      expect(store.peek(envelopeB.requestId)?.questionId).toBe("ask-B");
    });

    test("unnamed ask keeps the legacy first-pending bind", () => {
      const { store, envelopeA, envelopeB } = twoDenies();
      expect(store.attachToAsk("worker-1", "ask-x", undefined, 1_000_001)).toBe(
        envelopeA,
      );
      expect(envelopeA.questionId).toBe("ask-x");
      expect(envelopeB.questionId).toBeUndefined();
    });

    test("bogus id fails closed with no fallback to another denial", () => {
      const { store, envelopeA, envelopeB } = twoDenies();
      expect(
        store.attachToAsk("worker-1", "ask-x", "not-a-real-id", 1_000_001),
      ).toBeUndefined();
      expect(envelopeA.questionId).toBeUndefined();
      expect(envelopeB.questionId).toBeUndefined();
    });

    test("cross-session id fails closed with no fallback", () => {
      const { store, envelopeA, envelopeB } = twoDenies();
      const other = store.register(
        createDeniedCallEnvelope(
          descriptor({
            callId: "call-other",
            args: { command: "npm run build" },
            workerSessionId: "worker-9",
          }),
        ),
      );
      expect(
        store.attachToAsk("worker-1", "ask-x", other.requestId, 1_000_001),
      ).toBeUndefined();
      expect(envelopeA.questionId).toBeUndefined();
      expect(envelopeB.questionId).toBeUndefined();
      expect(other.questionId).toBeUndefined();
    });
  });

  test("audit trail orders deny → ask → consume", () => {
    const store = new WorkerGrantStore();
    const envelope = store.register(createDeniedCallEnvelope(descriptor()));
    store.attachToAsk("worker-1", "ask-1", undefined, 1_000_001);
    store.consumeOnAllow({
      sessionId: "worker-1",
      canonicalTool: "run_shell",
      args: { ...ARGS },
      cwd: CWD,
      now: 1_000_001,
    });
    expect(envelope.audit.map((event) => event.event)).toEqual([
      "denied",
      "asked",
      "consumed",
    ]);
  });

  test("no text API: state moves only on typed identities, never prose", () => {
    const store = new WorkerGrantStore();
    const envelope = store.register(createDeniedCallEnvelope(descriptor()));
    const echo =
      `send_input answer: grant request ${envelope.requestId} approved ` +
      `with ${JSON.stringify(ARGS)}`;
    expect(
      typeof (store as unknown as Record<string, unknown>)["fromProse"],
    ).toBe("undefined");
    expect(
      typeof (store as unknown as Record<string, unknown>)["parseText"],
    ).toBe("undefined");
    expect(echo.length).toBeGreaterThan(0);
    expect(envelope.status).toBe("pending");
    expect(
      store.precheck({
        sessionId: "worker-1",
        canonicalTool: "run_shell",
        args: { ...ARGS },
        cwd: CWD,
        now: 1_000_001,
      }),
    ).toEqual({ ok: true });
  });
});

describe("WorkerGrantStore.runExclusive", () => {
  test("serializes same-key holders: no overlap, FIFO, error still releases", async () => {
    const store = new WorkerGrantStore();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = store.runExclusive("k", async () => {
      events.push("first-start");
      await firstGate;
      events.push("first-end");
      return "first";
    });
    const second = store.runExclusive("k", async () => {
      events.push("second-start");
      events.push("second-end");
      return "second";
    });
    // The second holder must not start while the first holds the turn.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events).toEqual(["first-start"]);
    releaseFirst();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(events).toEqual([
      "first-start",
      "first-end",
      "second-start",
      "second-end",
    ]);

    // A throwing holder still releases: the next waiter proceeds.
    const failing = store.runExclusive("k", async () => {
      throw new Error("boom");
    });
    const after = store.runExclusive("k", async () => "after");
    await expect(failing).rejects.toThrow("boom");
    await expect(after).resolves.toBe("after");
  });

  test("different keys do not block each other", async () => {
    const store = new WorkerGrantStore();
    const order: string[] = [];
    await Promise.all([
      store.runExclusive("a", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("a");
      }),
      store.runExclusive("b", async () => {
        order.push("b");
      }),
    ]);
    expect(order).toEqual(["b", "a"]);
  });
});
