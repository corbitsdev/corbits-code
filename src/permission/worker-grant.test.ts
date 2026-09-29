import { describe, test, expect } from "bun:test";

import { WORKER_CANNOT_COMPLETE_APPROVAL } from "./decline-markers.js";
import {
  WORKER_GRANT_TTL_MS,
  WorkerGrantStore,
  buildRetryMessage,
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

  test("tampered session/cwd fail closed; tampered args fall through to the gate", () => {
    const store = new WorkerGrantStore();
    const envelope = store.register(createDeniedCallEnvelope(descriptor()));
    store.consumeOnAllow({
      sessionId: "worker-1",
      canonicalTool: "run_shell",
      args: { ...ARGS },
      cwd: CWD,
      now: 1_000_001,
    });
    // Same fingerprint, owning session, wrong directory: the covering session
    // grant is not cwd-scoped, so the backstop must refuse the ride.
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
    // Same fingerprint, different session: must replay from the owning session.
    const sessionTamper = store.precheck({
      sessionId: "worker-2",
      canonicalTool: "run_shell",
      args: { ...ARGS },
      cwd: CWD,
      now: 1_000_002,
    });
    expect(sessionTamper.ok).toBe(false);
    if (sessionTamper.ok) throw new Error("expected blocker");
    expect(sessionTamper.blocker).toContain("worker-1");
    // Different fingerprint (tampered args or tool): not this envelope — the
    // gate denies downstream with a fresh deny since no grant covers it.
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

  test("cross-session replay of a pending envelope fails closed", () => {
    const store = new WorkerGrantStore();
    store.register(createDeniedCallEnvelope(descriptor()));
    const result = store.precheck({
      sessionId: "worker-2",
      canonicalTool: "run_shell",
      args: { ...ARGS },
      cwd: CWD,
      now: 1_000_001,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected blocker");
    expect(result.blocker).toContain("worker-1");
  });

  test("expiry fails closed, lazily and via sweep", () => {
    const store = new WorkerGrantStore();
    const envelope = store.register(createDeniedCallEnvelope(descriptor()));
    const after = envelope.expiresAt + 1;
    const result = store.precheck({
      sessionId: "worker-1",
      canonicalTool: "run_shell",
      args: { ...ARGS },
      cwd: CWD,
      now: after,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected blocker");
    expect(result.blocker).toContain("expired");
    expect(envelope.status).toBe("expired");

    const second = store.register(
      createDeniedCallEnvelope(descriptor({ callId: "call-2" })),
    );
    expect(store.sweepExpired(second.expiresAt + 1)).toBe(1);
    expect(second.status).toBe("expired");
  });

  test("decline fails closed; headless declineAllForSession covers the session", () => {
    const store = new WorkerGrantStore();
    const envelope = store.register(createDeniedCallEnvelope(descriptor()));
    expect(store.decline(envelope.requestId, "operator said no")).toBe(true);
    expect(store.decline(envelope.requestId, "again")).toBe(false);
    const result = store.precheck({
      sessionId: "worker-1",
      canonicalTool: "run_shell",
      args: { ...ARGS },
      cwd: CWD,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected blocker");
    expect(result.blocker).toContain("declined");

    store.register(createDeniedCallEnvelope(descriptor({ callId: "call-9" })));
    expect(store.declineAllForSession("worker-1", "headless")).toBe(1);
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
    expect(store.attachToAsk("worker-1", "ask-7")).toBe(envelope);
    expect(envelope.questionId).toBe("ask-7");
    expect(envelope.status).toBe("pending");
    expect(store.byQuestion("ask-7")).toBe(envelope);
    expect(store.attachToAsk("worker-9", "ask-8")).toBeUndefined();
    expect(envelope.audit.map((event) => event.event)).toEqual([
      "denied",
      "asked",
    ]);
  });

  test("audit trail orders deny → ask → consume", () => {
    const store = new WorkerGrantStore();
    const envelope = store.register(createDeniedCallEnvelope(descriptor()));
    store.attachToAsk("worker-1", "ask-1");
    store.consumeOnAllow({
      sessionId: "worker-1",
      canonicalTool: "run_shell",
      args: { ...ARGS },
      cwd: CWD,
      now: 1_000_001,
    });
    expect(
      store.auditTrail(envelope.requestId).map((event) => event.event),
    ).toEqual(["denied", "asked", "consumed"]);
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

describe("buildRetryMessage", () => {
  test("carries exact args + questionId ref from the envelope", () => {
    const store = new WorkerGrantStore();
    const envelope = store.register(createDeniedCallEnvelope(descriptor()));
    store.attachToAsk("worker-1", "ask-3");
    const message = buildRetryMessage(envelope);
    expect(message).toContain(envelope.requestId);
    expect(message).toContain("ask-3");
    expect(message).toContain(JSON.stringify(ARGS));
  });
});
