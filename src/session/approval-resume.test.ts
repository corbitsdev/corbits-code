import { describe, expect, mock, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, SendResult } from "@intx/agent";
import type {
  ApprovalSnapshot,
  ContextStore,
  PendingOperation,
  ConversationTurn,
  InboundMessage,
} from "@intx/types/runtime";

import type { PermissionGate } from "../permission/gate.js";
import { createExtraDeniedPathMatcher } from "../plugins/secret-guard-plugin.js";
import {
  APPROVAL_DROPPED_NOTICE,
  createApprovalResume,
  createSuspendedApprovalRecovery,
  requestFromApprovalSnapshot,
  resolveParkedCallIdFromStore,
  resolveSuspendedApprovalFromStore,
} from "./approval-resume.js";
import { createSessionOperationQueue } from "../tui/delivery-queue.js";
import { defined } from "../../testkit/defined.js";
import {
  approvalTimeoutTurn as timeoutTurn,
  assistantToolCallTurn as assistantTurn,
  createApprovalResumeHarness,
  decisionBody,
  deliveredCorrelationId,
  shellApprovalSnapshot as shellSnapshot,
  suspendedResult as suspension,
  userTextTurn,
} from "../../testkit/approval-resume-harness.js";

function setup(args: {
  preTurns: ConversationTurn[];
  onGate: (turns: ConversationTurn[]) => void;
  resolveParkedCallId?: (correlationId: string) => string | undefined;
}) {
  const { agent, gate, delivered } = createApprovalResumeHarness({
    turns: args.preTurns,
    onGate: args.onGate,
  });
  const resume = createApprovalResume({
    getAgent: () => agent,
    gate,
    resolveParkedCallId:
      args.resolveParkedCallId ??
      ((correlationId) => (correlationId === "corr-A" ? "call-A" : undefined)),
  });
  return { resume, delivered };
}

function fileSnapshot(name: string): ApprovalSnapshot {
  return {
    name,
    description: "write a file",
    inputSchema: {},
    arguments: { path: "src/a.ts", content: "x" },
  };
}

describe("requestFromApprovalSnapshot aliased file tools", () => {
  test("parked default.write_file resume is file-scoped like write_file", () => {
    const write = requestFromApprovalSnapshot(
      fileSnapshot("write_file"),
      "corr-write",
    );
    const aliased = requestFromApprovalSnapshot(
      fileSnapshot("default.write_file"),
      "corr-alias",
    );
    expect(write?.tool).toBe("write_file");
    expect(write?.scopes.map((scope) => scope.id)).toEqual(["exact", "dir"]);
    expect(write?.scopes.map((scope) => scope.pattern)).toEqual([
      "src/a.ts",
      "src/*",
    ]);
    expect(aliased).toEqual(write);
  });
});

describe("requestFromApprovalSnapshot secret persist scopes", () => {
  test("static secret shell strips persist scopes without extras", () => {
    const request = requestFromApprovalSnapshot(
      shellSnapshot("cat .env"),
      "corr-env",
    );
    expect(request?.tool).toBe("run_shell");
    expect(request?.scopes).toEqual([]);
  });

  test("non-secret shell keeps persist scopes", () => {
    const request = requestFromApprovalSnapshot(
      shellSnapshot("cat README.md"),
      "corr-readme",
    );
    expect(request?.tool).toBe("run_shell");
    expect(request?.scopes.length).toBeGreaterThan(0);
  });

  test("extras-secret shell strips persist scopes", async () => {
    const parent = await mkdtemp(join(tmpdir(), "cl9386-resume-extras-"));
    const cwd = join(parent, "ws");
    const customConfig = join(cwd, "operator-config.json");
    try {
      await mkdir(cwd, { recursive: true });
      await writeFile(
        customConfig,
        `${JSON.stringify({ dangerouslySkipPermissions: true }, null, 2)}\n`,
      );
      const request = requestFromApprovalSnapshot(
        shellSnapshot("cat operator-config.json"),
        "corr-extras",
        {
          cwd,
          isExtraDenied: createExtraDeniedPathMatcher([customConfig]),
        },
      );
      expect(request?.tool).toBe("run_shell");
      expect(request?.scopes).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("pin: custom config path without extras keeps persist scopes", () => {
    const request = requestFromApprovalSnapshot(
      shellSnapshot("cat operator-config.json"),
      "corr-no-extras",
    );
    expect(request?.tool).toBe("run_shell");
    expect(request?.scopes.length).toBeGreaterThan(0);
  });
});

describe("requestFromApprovalSnapshot secret shell scopes", () => {
  for (const command of [
    "echo ok; FILE=.envrc cat $FILE",
    'bash -c "grep --file=.envrc needle"',
    'echo "$(cat .envrc)"',
    "awk -f.flaskenv input.txt",
    "sed -nf.envrc input.txt",
    "sed --fil=.envrc input.txt",
    "egrep -Jf.envrc needle",
    "grep -2f.flaskenv needle",
    "sed -anf.envrc input.txt",
    "{ awk -f.flaskenv input.txt; }",
    "! grep -Tf.envrc needle",
    "grep -Xf.envrc needle",
    "grep -uf.envrc needle",
    "cat $'.envrc'",
    "bash -c \"cat \\$'.envrc'\"",
    "bash -lc \"cat \\$'.envrc'\"",
    "bash -lc \"cat \\$'.flaskenv'\"",
    "zsh -yc \"cat \\$'.envrc'\"",
    "dash -Vc \"cat \\$'.flaskenv'\"",
    "ksh -Gc \"cat \\$'.envrc'\"",
    `bash -c "cat "'.envrc'`,
    `sh -cc "cat "'.flaskenv'`,
    "cat $'notes\\cQ'",
    'bash -c "$CMD"',
  ]) {
    test(`does not persist guarded shell: ${command}`, () => {
      const request = requestFromApprovalSnapshot(
        shellSnapshot(command),
        "corr-secret",
      );

      expect(request?.scopes).toEqual([]);
    });
  }

  test("retains persistent scopes for an ordinary command", () => {
    const request = requestFromApprovalSnapshot(
      shellSnapshot("echo ok && cat README.md"),
      "corr-ordinary",
    );

    expect(request?.scopes.length).toBeGreaterThan(0);
  });

  test("uses the gate cwd to guard a benign symlink after reconstruction", () => {
    const cwd = mkdtempSync(join(tmpdir(), "approval-resume-cwd-"));
    try {
      writeFileSync(join(cwd, ".envrc"), "SECRET=value\n");
      symlinkSync(join(cwd, ".envrc"), join(cwd, "notes"));

      const request = requestFromApprovalSnapshot(
        shellSnapshot("cat notes"),
        "corr-symlink",
        { cwd },
      );

      expect(cwd).not.toBe(process.cwd());
      expect(request?.cwd).toBe(cwd);
      expect(request?.scopes).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("approval decision intent headers", () => {
  for (const allow of [true, false]) {
    test(`preserves ${allow ? "granted" : "denied"} intent and correlation through the session queue`, async () => {
      const delivered: InboundMessage[] = [];
      const queue = createSessionOperationQueue();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      queue.enqueue(() => held);
      const agent = {
        history: async () => [],
        deliver: (message: InboundMessage) => {
          delivered.push(message);
        },
      };
      const gate = {
        resolveSuspended: async () => ({ allow, message: "decision reason" }),
      } as unknown as PermissionGate;
      const resume = createApprovalResume({
        getAgent: () => agent,
        gate,
        resolveParkedCallId: () => "typed-call",
        deliver: (message) =>
          queue.enqueue(async () => {
            agent.deliver(message);
          }),
      });
      const handling = resume.handle(
        suspension("typed-correlation", "echo alpha"),
      );
      expect(delivered).toHaveLength(0);
      release();
      expect(await handling).toBe(true);
      await queue.awaitTail();
      expect(delivered).toHaveLength(1);
      const message = delivered[0];
      if (message === undefined) throw new Error("expected decision");
      expect(message.headers.interchangeType).toBe(
        allow ? "approval.granted" : "approval.denied",
      );
      expect(deliveredCorrelationId(message)).toBe("typed-correlation");
      expect(decisionBody(message).outcome).toBe(
        allow ? "approved" : "rejected",
      );
      if (!allow)
        expect(JSON.parse(message.content ?? "").message).toBe(
          "decision reason",
        );
    });
  }
});

describe("approval-resume parallel-parked approvals", () => {
  for (const timedOutCallId of ["call-B", "call-A"]) {
    test(`a ${timedOutCallId} timeout ${timedOutCallId === "call-B" ? "still delivers" : "drops"} A's decision`, async () => {
      const { resume, delivered } = setup({
        preTurns: [
          assistantTurn([
            { id: "call-A", name: "run_shell", command: "echo alpha" },
            { id: "call-B", name: "run_shell", command: "echo bravo" },
          ]),
        ],
        onGate: (turns) => {
          turns.push(timeoutTurn(timedOutCallId));
        },
      });

      const handled = await resume.handle(suspension("corr-A", "echo alpha"));

      expect(handled).toBe(true);
      if (timedOutCallId === "call-A") {
        // A genuinely late decision for the parked call itself must drop.
        expect(delivered).toHaveLength(0);
        return;
      }
      expect(delivered).toHaveLength(1);
      const message = delivered[0];
      if (message === undefined)
        throw new Error("expected a delivered decision");
      expect(deliveredCorrelationId(message)).toBe("corr-A");
      expect(decisionBody(message).outcome).toBe("approved");
    });
  }

  test("history throw after the operator answers still delivers", async () => {
    const turns = [
      assistantTurn([
        { id: "call-A", name: "run_shell", command: "echo alpha" },
      ]),
    ];
    const delivered: InboundMessage[] = [];
    let historyCalls = 0;
    const resume = createApprovalResume({
      getAgent: () =>
        ({
          history: async () => {
            historyCalls += 1;
            if (historyCalls > 1) throw new Error("history unavailable");
            return turns;
          },
          deliver: (message: InboundMessage) => {
            delivered.push(message);
          },
        }) as Pick<Agent, "deliver" | "history">,
      gate: {
        resolveSuspended: async () => ({ allow: true }),
      } as unknown as PermissionGate,
      resolveParkedCallId: () => "call-A",
    });

    expect(await resume.handle(suspension("corr-A", "echo alpha"))).toBe(true);
    expect(delivered).toHaveLength(1);
    const message = delivered[0];
    if (message === undefined) throw new Error("expected a delivered decision");
    expect(deliveredCorrelationId(message)).toBe("corr-A");
    expect(decisionBody(message).outcome).toBe("approved");
  });

  test("pending-operation lookup identifies the parked call without history tool calls", async () => {
    const { resume, delivered } = setup({
      preTurns: [userTextTurn("run two shell commands")],
      onGate: (turns) => {
        turns.push(timeoutTurn("call-B"));
      },
      resolveParkedCallId: (correlationId) =>
        correlationId === "corr-A" ? "call-A" : undefined,
    });

    const handled = await resume.handle(suspension("corr-A", "echo alpha"));

    expect(handled).toBe(true);
    expect(delivered).toHaveLength(1);
    const message = delivered[0];
    if (message === undefined) throw new Error("expected a delivered decision");
    expect(deliveredCorrelationId(message)).toBe("corr-A");
    expect(decisionBody(message).outcome).toBe("approved");
  });

  test("identical name+args twin: sibling timeout still delivers", async () => {
    const { resume, delivered } = setup({
      preTurns: [
        assistantTurn([
          { id: "call-A", name: "run_shell", command: "echo same" },
          { id: "call-B", name: "run_shell", command: "echo same" },
        ]),
      ],
      onGate: (turns) => {
        turns.push(timeoutTurn("call-B"));
      },
    });

    const handled = await resume.handle(suspension("corr-A", "echo same"));

    expect(handled).toBe(true);
    expect(delivered).toHaveLength(1);
  });

  test("identical name+args twin: own timeout with unanswered twin drops", async () => {
    const pending = new Map([
      ["corr-A", "call-A"],
      ["corr-B", "call-B"],
    ]);
    const { resume, delivered } = setup({
      resolveParkedCallId: (correlationId) => pending.get(correlationId),
      preTurns: [
        assistantTurn([
          { id: "call-A", name: "run_shell", command: "echo same" },
          { id: "call-B", name: "run_shell", command: "echo same" },
        ]),
      ],
      onGate: (turns) => {
        pending.delete("corr-A");
        turns.push(timeoutTurn("call-A"));
      },
    });

    const handled = await resume.handle(suspension("corr-A", "echo same"));

    expect(handled).toBe(true);
    expect(delivered).toHaveLength(0);
    expect(await resume.handle(suspension("corr-B", "echo same"))).toBe(true);
    expect(delivered).toHaveLength(1);
    const message = delivered[0];
    if (message === undefined) throw new Error("expected B decision");
    expect(deliveredCorrelationId(message)).toBe("corr-B");
  });
});

function storeWith(
  pendingOperations: PendingOperation[],
): Pick<ContextStore, "load"> {
  return {
    load: async () => ({
      turns: [],
      pendingOperations,
      tokenUsage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        thinking: 0,
      },
      connectorState: null,
    }),
  };
}

const operation: PendingOperation = {
  correlationId: "corr-A",
  kind: "approval",
  registeredAt: 1,
  gateId: "gate-A",
  suspendedCall: {
    id: "call-A",
    name: "run_shell",
    arguments: { command: "echo same" },
  },
  approvalSnapshot: {
    name: "run_shell",
    description: "run shell",
    inputSchema: {},
    arguments: { command: "echo same" },
  },
};

describe("persisted approval identity", () => {
  test("requires exactly one matching approval with a suspended call", async () => {
    expect(
      await resolveParkedCallIdFromStore(storeWith([operation]), "corr-A"),
    ).toBe("call-A");
    expect(
      await resolveParkedCallIdFromStore(storeWith([operation]), "corr-B"),
    ).toBeUndefined();
    expect(
      await resolveParkedCallIdFromStore(storeWith([]), "corr-A"),
    ).toBeUndefined();
    expect(
      await resolveParkedCallIdFromStore(
        storeWith([operation, operation]),
        "corr-A",
      ),
    ).toBeUndefined();
    const { suspendedCall: _call, ...withoutCall } = operation;
    expect(
      await resolveParkedCallIdFromStore(storeWith([withoutCall]), "corr-A"),
    ).toBeUndefined();
    expect(
      await resolveParkedCallIdFromStore(
        storeWith([operation, withoutCall]),
        "corr-A",
      ),
    ).toBeUndefined();
  });
});

describe("persisted suspended approval proof", () => {
  test("requires an exact persisted snapshot and parked call", async () => {
    const result = suspension("corr-A", "echo same");
    expect(
      await resolveSuspendedApprovalFromStore(storeWith([operation]), result),
    ).toEqual({
      ok: true,
      parkedCallId: "call-A",
    });

    const mismatch: PendingOperation = {
      ...operation,
      approvalSnapshot: {
        name: "run_shell",
        description: "run shell",
        inputSchema: {},
        arguments: { command: "secret" },
      },
    };
    expect(
      await resolveSuspendedApprovalFromStore(storeWith([mismatch]), result),
    ).toEqual({ ok: false, code: "snapshot-mismatch" });
    expect(
      await resolveSuspendedApprovalFromStore(
        storeWith([operation, operation]),
        result,
      ),
    ).toEqual({ ok: false, code: "ambiguous-pending" });
  });
});

describe("suspended approval recovery", () => {
  const gateEvent = {
    reason: "approval",
    correlationId: "corr-A",
    approvalSnapshot: shellSnapshot("echo same"),
  } as const;
  const parkedTurns = (): ConversationTurn[] => [
    assistantTurn([{ id: "call-A", name: "run_shell", command: "echo same" }]),
  ];

  // The real approval handler over a fake agent and a gate the test controls,
  // so statuses and deliveries come from production code, not mocks.
  function recovery(
    args: {
      turns?: ConversationTurn[];
      pending?: PendingOperation[];
      gate?: "deferred" | "allow";
    } = {},
  ) {
    const harness = createApprovalResumeHarness({
      turns: args.turns ?? parkedTurns(),
    });
    let agentLive = true;
    let gateCalls = 0;
    let release!: (outcome: { allow: boolean }) => void;
    const gate = {
      resolveSuspended: async () => {
        gateCalls += 1;
        if (args.gate === "allow") return { allow: true };
        return await new Promise<{ allow: boolean }>((resolve) => {
          release = resolve;
        });
      },
    } as unknown as PermissionGate;
    const resume = createApprovalResume({
      getAgent: () =>
        (agentLive ? harness.agent : undefined) as unknown as Agent,
      gate,
      resolveParkedCallId: (correlationId) =>
        correlationId === "corr-A" ? "call-A" : undefined,
    });
    const recoveryHandle = createSuspendedApprovalRecovery({
      storage: () => storeWith(args.pending ?? [operation]),
      resume,
    });
    return {
      resume,
      recovery: recoveryHandle,
      delivered: harness.delivered,
      gateCalls: () => gateCalls,
      release: (allow = true) => release({ allow }),
      setAgentLive: (live: boolean) => {
        agentLive = live;
      },
    };
  }
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  const result = suspension("corr-A", "echo same");

  test("a gate parked outside a send reaches the operator and delivers their decision", async () => {
    const t = recovery();
    t.recovery.observeParked(gateEvent, () => true);
    await flush();

    expect(t.gateCalls()).toBe(1);
    expect(t.resume.status("corr-A")).toBe("in-flight");
    t.release(true);
    await flush();

    expect(t.resume.status("corr-A")).toBe("handed-over");
    expect(t.delivered).toHaveLength(1);
    const message = defined(t.delivered[0]);
    expect(deliveredCorrelationId(message)).toBe("corr-A");
    expect(decisionBody(message).outcome).toBe("approved");
    // Settled, so nothing is left for the watchdog to re-present.
    expect((await t.recovery.tryResumeOnce()).code).toBe("no-candidate");
  });

  test("a declined decision is delivered as declined and never as approved", async () => {
    const t = recovery();
    t.recovery.observeParked(gateEvent, () => true);
    await flush();
    t.release(false);
    await flush();

    expect(t.delivered.map((m) => decisionBody(m).outcome)).toEqual([
      "rejected",
    ]);
  });

  test.each([
    ["a non-approval gate", { ...gateEvent, reason: "input" }],
    ["a gate with no correlation", { ...gateEvent, correlationId: undefined }],
    ["a gate with no snapshot", { ...gateEvent, approvalSnapshot: undefined }],
  ])("ignores %s", async (_name, event) => {
    const t = recovery({ gate: "allow" });
    t.recovery.observeParked(event, () => true);
    await flush();

    expect(t.gateCalls()).toBe(0);
    expect(t.delivered).toEqual([]);
  });

  test("shares one presentation with a send that already owns the suspension", async () => {
    const t = recovery();
    const fromSend = t.resume.handle(result);
    await flush();
    t.recovery.observeParked(gateEvent, () => true);
    await flush();

    expect(t.gateCalls()).toBe(1);
    t.release(true);
    await fromSend;
    expect(t.delivered).toHaveLength(1);
  });

  test("re-presents a parked approval whose first presentation failed", async () => {
    const t = recovery({ gate: "allow" });
    t.setAgentLive(false);
    t.recovery.observeParked(gateEvent, () => true);
    await flush();
    expect(t.gateCalls()).toBe(0);
    expect(t.resume.status("corr-A")).toBe("idle");

    t.setAgentLive(true);
    let presenting = 0;
    const outcome = await t.recovery.tryResumeOnce(() => {
      presenting += 1;
    });

    expect(outcome).toEqual({ handled: true, code: "resumed" });
    expect(presenting).toBe(1);
    expect(t.delivered).toHaveLength(1);
    expect(decisionBody(defined(t.delivered[0])).outcome).toBe("approved");
    // One attempt per capture, and the resume cleared its candidate.
    expect((await t.recovery.tryResumeOnce()).handled).toBe(false);
    expect(t.delivered).toHaveLength(1);
  });

  test("never re-presents over an in-flight presentation", async () => {
    const t = recovery();
    t.recovery.capture(result, () => true);
    const first = t.resume.handle(result);
    await flush();

    const outcome = await t.recovery.tryResumeOnce();
    expect(outcome).toEqual({ handled: false, code: "settlement-in-flight" });
    expect(t.gateCalls()).toBe(1);
    t.release(true);
    await first;
  });

  test("never re-delivers a decision that was already handed over", async () => {
    const t = recovery({ gate: "allow" });
    t.recovery.capture(result, () => true);
    await t.resume.handle(result);
    expect(t.delivered).toHaveLength(1);

    const outcome = await t.recovery.tryResumeOnce();
    expect(outcome).toEqual({ handled: false, code: "settlement-handed-over" });
    expect(t.delivered).toHaveLength(1);
  });

  test("a rejected parked call is never re-presented after handedOver", async () => {
    const t = recovery();
    t.recovery.capture(result, () => true);
    const pending = t.resume.handle(result);
    await flush();
    expect(t.gateCalls()).toBe(1);

    // The operator declines; the rejected decision is delivered and handed over.
    t.release(false);
    await pending;
    expect(t.resume.status("corr-A")).toBe("handed-over");
    expect(t.delivered.map((m) => decisionBody(m).outcome)).toEqual([
      "rejected",
    ]);

    // A later watchdog attempt refuses rather than re-presenting or re-delivering.
    const outcome = await t.recovery.tryResumeOnce();
    expect(outcome).toEqual({ handled: false, code: "settlement-handed-over" });
    expect(t.gateCalls()).toBe(1);
    expect(t.delivered).toHaveLength(1);

    // A later observeParked of the same gate is likewise a no-op: the decision
    // was handed over, so the operator is never asked again.
    t.recovery.observeParked(gateEvent, () => true);
    await flush();
    expect(t.gateCalls()).toBe(1);
    expect(t.delivered).toHaveLength(1);
    expect(t.resume.status("corr-A")).toBe("handed-over");
  });

  test("does not count a dropped decision as resumed", async () => {
    const t = recovery({
      gate: "allow",
      turns: [...parkedTurns(), timeoutTurn("call-A")],
    });
    t.recovery.capture(result, () => true);

    const outcome = await t.recovery.tryResumeOnce();
    expect(outcome).toEqual({ handled: false, code: "not-delivered" });
    expect(t.delivered).toEqual([]);
  });

  test("reports why an unproven approval was refused, without payload", async () => {
    const missing = recovery({ gate: "allow", pending: [] });
    missing.recovery.capture(result, () => true);
    expect(await missing.recovery.tryResumeOnce()).toEqual({
      handled: false,
      code: "unverified-not-pending",
    });

    const mismatch = recovery({
      gate: "allow",
      pending: [
        {
          ...operation,
          approvalSnapshot: shellSnapshot("secret"),
        },
      ],
    });
    mismatch.recovery.capture(result, () => true);
    const outcome = await mismatch.recovery.tryResumeOnce();
    expect(outcome.code).toBe("unverified-snapshot-mismatch");
    expect(JSON.stringify(outcome)).not.toContain("secret");
    expect(mismatch.delivered).toEqual([]);
  });

  test("a stale generation or a cleared capture never presents", async () => {
    const stale = recovery({ gate: "allow" });
    stale.recovery.capture(result, () => false);
    expect((await stale.recovery.tryResumeOnce()).code).toBe("stale");

    const cleared = recovery({ gate: "allow" });
    cleared.recovery.capture(result, () => true);
    cleared.recovery.clear();
    expect((await cleared.recovery.tryResumeOnce()).code).toBe("no-candidate");

    for (const t of [stale, cleared]) {
      expect(t.gateCalls()).toBe(0);
      expect(t.delivered).toEqual([]);
    }
  });

  test("a generation that changes during verification drops the attempt", async () => {
    let current = true;
    const t = recovery({ gate: "allow" });
    const resume = createSuspendedApprovalRecovery({
      storage: () => ({
        load: async () => {
          current = false;
          return await storeWith([operation]).load();
        },
      }),
      resume: t.resume,
    });
    resume.capture(result, () => current);

    expect((await resume.tryResumeOnce()).code).toBe("stale");
    expect(t.gateCalls()).toBe(0);
  });
});

test("missing or ambiguous stored identity never falls back to an identical history call", async () => {
  for (const pending of [[], [operation, operation]]) {
    const deliver = mock((_message: InboundMessage): void => undefined);
    const resolveSuspended = mock(async () => ({ allow: true }));
    const resume = createApprovalResume({
      getAgent: () => ({
        deliver,
        history: async () => [
          assistantTurn([
            { id: "call-B", name: "run_shell", command: "echo same" },
          ]),
        ],
      }),
      resolveParkedCallId: (id) =>
        resolveParkedCallIdFromStore(storeWith(pending), id),
      gate: { resolveSuspended } as unknown as PermissionGate,
    });
    expect(await resume.handle(suspension("corr-A", "echo same"))).toBe(true);
    expect(resolveSuspended).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  }
});

function deferredResume() {
  const lookup = Promise.withResolvers<string | undefined>();
  const deliver = mock((_message: InboundMessage): void => undefined);
  const history = mock(async (): Promise<ConversationTurn[]> => []);
  const resolveSuspended = mock(async () => ({ allow: true }));
  const resolveParkedCallId = mock(() => lookup.promise);
  const onDropped = mock((_text: string): void => undefined);
  let cancel: (() => void) | undefined;
  let current = true;
  const resume = createApprovalResume({
    getAgent: () => ({ deliver, history }),
    resolveParkedCallId,
    gate: { resolveSuspended } as unknown as PermissionGate,
    captureGeneration: () => () => current,
    onDropped,
    registerParkedCancel: (registered) => {
      cancel = registered;
    },
  });
  return {
    lookup,
    deliver,
    onDropped,
    history,
    resolveSuspended,
    resolveParkedCallId,
    resume,
    cancel: () => cancel?.(),
    registered: () => cancel,
    invalidate: () => {
      current = false;
    },
  };
}

describe("approval identity ordering", () => {
  test("resolves once before opening the gate", async () => {
    const ctx = deferredResume();
    const handling = ctx.resume.handle(suspension("corr-A", "echo same"));
    expect(ctx.resolveSuspended).not.toHaveBeenCalled();
    expect(ctx.history).not.toHaveBeenCalled();
    ctx.lookup.resolve("call-A");
    expect(await handling).toBe(true);
    expect(ctx.resolveParkedCallId).toHaveBeenCalledTimes(1);
    expect(ctx.resolveSuspended).toHaveBeenCalledTimes(1);
    expect(ctx.deliver).toHaveBeenCalledTimes(1);
    expect(ctx.registered()).toBeUndefined();
  });

  for (const cancel of [true, false]) {
    test(`${cancel ? "registered cancellation" : "generation change"} during lookup never delivers or opens gate`, async () => {
      const ctx = deferredResume();
      const handling = ctx.resume.handle(suspension("corr-A", "echo same"));
      expect(ctx.registered()).toBeDefined();
      if (cancel) ctx.cancel();
      else ctx.invalidate();
      expect(ctx.deliver).not.toHaveBeenCalled();
      ctx.lookup.resolve("call-A");
      expect(await handling).toBe(true);
      expect(ctx.deliver).not.toHaveBeenCalled();
      expect(ctx.resolveSuspended).not.toHaveBeenCalled();
      expect(ctx.registered()).toBeUndefined();
    });
  }

  test("generation change during initial history never delivers", async () => {
    const ctx = deferredResume();
    ctx.history.mockImplementation(async () => {
      ctx.invalidate();
      return [];
    });
    const handling = ctx.resume.handle(suspension("corr-A", "echo same"));
    ctx.lookup.resolve("call-A");
    expect(await handling).toBe(true);
    expect(ctx.resolveSuspended).not.toHaveBeenCalled();
    expect(ctx.deliver).not.toHaveBeenCalled();
  });

  test("generation change during post-gate history cannot deliver an approval", async () => {
    const ctx = deferredResume();
    ctx.history.mockResolvedValueOnce([]).mockImplementationOnce(async () => {
      ctx.invalidate();
      return [];
    });
    const handling = ctx.resume.handle(suspension("corr-A", "echo same"));
    ctx.lookup.resolve("call-A");
    expect(await handling).toBe(true);
    expect(ctx.deliver).toHaveBeenCalledTimes(1);
    const message = ctx.deliver.mock.calls[0]?.[0];
    if (message === undefined)
      throw new Error("expected cancellation rejection");
    expect(decisionBody(message).outcome).toBe("rejected");
  });

  for (const timedOutCallId of ["call-A", "call-B"]) {
    test(`generation change during post-gate history with ${timedOutCallId} timeout preserves exact-call cancellation`, async () => {
      const ctx = deferredResume();
      const reading = Promise.withResolvers<undefined>();
      const history = Promise.withResolvers<ConversationTurn[]>();
      ctx.history.mockResolvedValueOnce([]).mockImplementationOnce(() => {
        reading.resolve(undefined);
        return history.promise;
      });
      const handling = ctx.resume.handle(suspension("corr-A", "echo same"));
      ctx.lookup.resolve("call-A");
      await reading.promise;
      expect(ctx.resolveSuspended).toHaveBeenCalledTimes(1);
      expect(ctx.registered()).toBeUndefined();
      ctx.invalidate();
      history.resolve([timeoutTurn(timedOutCallId)]);
      expect(await handling).toBe(true);
      expect(ctx.onDropped).toHaveBeenCalledTimes(1);
      expect(ctx.onDropped).toHaveBeenCalledWith(APPROVAL_DROPPED_NOTICE);
      expect(ctx.registered()).toBeUndefined();
      if (timedOutCallId === "call-A") {
        expect(ctx.deliver).not.toHaveBeenCalled();
      } else {
        expect(ctx.deliver).toHaveBeenCalledTimes(1);
        const message = ctx.deliver.mock.calls[0]?.[0];
        if (message === undefined)
          throw new Error("expected live-call cancellation rejection");
        expect(deliveredCorrelationId(message)).toBe("corr-A");
        expect(decisionBody(message)).toEqual({
          outcome: "rejected",
          message: APPROVAL_DROPPED_NOTICE,
        });
      }
    });
  }

  test("uses the captured agent for both history reads and direct delivery", async () => {
    const agent = {
      deliver: mock((_message: InboundMessage): void => undefined),
      history: mock(async () => []),
    };
    const other = {
      deliver: mock((_message: InboundMessage): void => undefined),
      history: mock(async () => []),
    };
    const getAgent = mock(() => agent)
      .mockReturnValueOnce(agent)
      .mockReturnValue(other);
    const resume = createApprovalResume({
      getAgent,
      resolveParkedCallId: () => "call-A",
      gate: {
        resolveSuspended: async () => ({ allow: true }),
      } as unknown as PermissionGate,
    });
    expect(await resume.handle(suspension("corr-A", "echo same"))).toBe(true);
    expect(getAgent).toHaveBeenCalledTimes(1);
    expect(agent.history).toHaveBeenCalledTimes(2);
    expect(agent.deliver).toHaveBeenCalledTimes(1);
    expect(other.history).not.toHaveBeenCalled();
    expect(other.deliver).not.toHaveBeenCalled();
  });

  test("does not claim atomic expiry detection before a timeout result is observed", async () => {
    const pending = new Map([["corr-A", "call-A"]]);
    const { resume, delivered } = setup({
      preTurns: [],
      resolveParkedCallId: (id) => pending.get(id),
      onGate: () => {
        pending.clear();
      },
    });
    // Reactor correlation removal precedes queued timeout publication. History
    // alone cannot close this interval; atomic admission belongs to the reactor.
    expect(await resume.handle(suspension("corr-A", "echo same"))).toBe(true);
    expect(delivered).toHaveLength(1);
  });

  test("load errors propagate and clear registration without rejection delivery", async () => {
    const ctx = deferredResume();
    const error = new Error("store unavailable");
    const handling = ctx.resume.handle(suspension("corr-A", "echo same"));
    ctx.lookup.reject(error);
    await expect(handling).rejects.toBe(error);
    expect(ctx.registered()).toBeUndefined();
    expect(ctx.deliver).not.toHaveBeenCalled();
    expect(ctx.resolveSuspended).not.toHaveBeenCalled();
    await expect(
      resolveParkedCallIdFromStore(
        {
          load: async () => {
            throw error;
          },
        },
        "corr-A",
      ),
    ).rejects.toBe(error);
  });

  for (const snapshot of [
    undefined,
    { name: 42 },
    { name: "run_shell", arguments: { command: 42 } },
  ]) {
    for (const identity of ["missing", "expired", "live"] as const) {
      test(`invalid snapshot ${JSON.stringify(snapshot)} with ${identity} identity`, async () => {
        const ctx = deferredResume();
        if (identity === "expired")
          ctx.history.mockResolvedValue([timeoutTurn("call-A")]);
        const result = {
          type: "suspended",
          correlationId: "corr-A",
          approvalSnapshot: snapshot,
        } as unknown as SendResult;
        const handling = ctx.resume.handle(result);
        ctx.lookup.resolve(identity === "missing" ? undefined : "call-A");
        expect(await handling).toBe(true);
        expect(ctx.resolveSuspended).not.toHaveBeenCalled();
        expect(ctx.deliver).toHaveBeenCalledTimes(identity === "live" ? 1 : 0);
        if (identity === "live") {
          const message = ctx.deliver.mock.calls[0]?.[0];
          if (message === undefined) throw new Error("expected rejection");
          expect(decisionBody(message).outcome).toBe("rejected");
        }
      });
    }
  }

  test("observed exact timeout during lookup prevents the gate and delivery", async () => {
    const ctx = deferredResume();
    const handling = ctx.resume.handle(suspension("corr-A", "echo same"));
    ctx.history.mockResolvedValue([timeoutTurn("call-A")]);
    ctx.lookup.resolve("call-A");
    expect(await handling).toBe(true);
    expect(ctx.resolveSuspended).not.toHaveBeenCalled();
    expect(ctx.deliver).not.toHaveBeenCalled();
  });
});

describe("approval resume retry re-await", () => {
  function retryHarness(outcome: { allow: boolean; message?: string }) {
    const delivered: InboundMessage[] = [];
    const deliver = mock((message: InboundMessage): void => {
      delivered.push(message);
    });
    const resolveSuspended = mock(async () => outcome);
    const resume = createApprovalResume({
      getAgent: () => ({
        deliver,
        history: async () => [],
      }),
      resolveParkedCallId: () => "call-A",
      gate: { resolveSuspended } as unknown as PermissionGate,
    });
    return { resume, delivered, deliver, resolveSuspended };
  }

  function onlyDecision(delivered: InboundMessage[]): InboundMessage {
    const message = delivered[0];
    if (message === undefined) throw new Error("expected a delivered decision");
    return message;
  }

  test("retry after a delivered acceptance reuses it exactly once", async () => {
    const { resume, delivered, resolveSuspended } = retryHarness({
      allow: true,
    });
    expect(await resume.handle(suspension("corr-A", "echo alpha"))).toBe(true);
    expect(resolveSuspended).toHaveBeenCalledTimes(1);
    expect(delivered).toHaveLength(1);
    expect(decisionBody(onlyDecision(delivered)).outcome).toBe("approved");

    expect(await resume.handle(suspension("corr-A", "echo alpha"))).toBe(true);
    expect(resolveSuspended).toHaveBeenCalledTimes(1);
    expect(delivered).toHaveLength(1);
  });

  test("late duplicate acceptance after a rejected decision is a no-op", async () => {
    const { resume, delivered, resolveSuspended } = retryHarness({
      allow: false,
      message: "not today",
    });
    expect(await resume.handle(suspension("corr-A", "echo alpha"))).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(decisionBody(onlyDecision(delivered)).outcome).toBe("rejected");

    expect(await resume.handle(suspension("corr-A", "echo alpha"))).toBe(true);
    expect(await resume.handle(suspension("corr-A", "echo alpha"))).toBe(true);
    expect(resolveSuspended).toHaveBeenCalledTimes(1);
    expect(delivered).toHaveLength(1);
  });

  test("distinct correlations gate and deliver independently", async () => {
    const { resume, delivered, resolveSuspended } = retryHarness({
      allow: true,
    });
    expect(await resume.handle(suspension("corr-A", "echo alpha"))).toBe(true);
    expect(await resume.handle(suspension("corr-B", "echo beta"))).toBe(true);
    expect(resolveSuspended).toHaveBeenCalledTimes(2);
    expect(delivered).toHaveLength(2);
  });

  test("retry without acceptance still gates", async () => {
    const delivered: InboundMessage[] = [];
    const deliver = mock((message: InboundMessage): void => {
      delivered.push(message);
    });
    deliver.mockImplementationOnce(() => {
      throw new Error("agent is done");
    });
    const resolveSuspended = mock(async () => ({ allow: true }));
    const resume = createApprovalResume({
      getAgent: () => ({
        deliver,
        history: async () => [],
      }),
      resolveParkedCallId: () => "call-A",
      gate: { resolveSuspended } as unknown as PermissionGate,
    });
    await expect(
      resume.handle(suspension("corr-A", "echo alpha")),
    ).rejects.toThrow("agent is done");
    expect(delivered).toHaveLength(0);
    expect(resolveSuspended).toHaveBeenCalledTimes(1);

    expect(await resume.handle(suspension("corr-A", "echo alpha"))).toBe(true);
    expect(resolveSuspended).toHaveBeenCalledTimes(2);
    expect(delivered).toHaveLength(1);
  });

  test("concurrent duplicate handles share one gate and one deliver", async () => {
    const gate = Promise.withResolvers<{ allow: boolean }>();
    const delivered: InboundMessage[] = [];
    const deliver = mock((message: InboundMessage): void => {
      delivered.push(message);
    });
    const resolveSuspended = mock(() => gate.promise);
    const resume = createApprovalResume({
      getAgent: () => ({
        deliver,
        history: async () => [],
      }),
      resolveParkedCallId: () => "call-A",
      gate: { resolveSuspended } as unknown as PermissionGate,
    });
    const first = resume.handle(suspension("corr-A", "echo alpha"));
    const second = resume.handle(suspension("corr-A", "echo alpha"));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(resolveSuspended).toHaveBeenCalledTimes(1);
    gate.resolve({ allow: true });
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(resolveSuspended).toHaveBeenCalledTimes(1);
    expect(delivered).toHaveLength(1);
  });

  // Concurrent duplicates share one in-flight rejection (one gate, zero
  // deliveries), then a retry re-gates and delivers exactly once, and later
  // retries memoize.
  test("a shared rejection re-gates once, delivers once, then memoizes", async () => {
    const gate = Promise.withResolvers<{ allow: boolean }>();
    const { resume, delivered, resolveSuspended } = retryHarness({
      allow: true,
    });
    resolveSuspended.mockImplementationOnce(() => gate.promise);
    const failure = new Error("gate exploded");
    const first = resume.handle(suspension("corr-A", "echo alpha"));
    const second = resume.handle(suspension("corr-A", "echo alpha"));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(resolveSuspended).toHaveBeenCalledTimes(1);
    gate.reject(failure);
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    expect(resolveSuspended).toHaveBeenCalledTimes(1);
    expect(delivered).toHaveLength(0);

    expect(await resume.handle(suspension("corr-A", "echo alpha"))).toBe(true);
    expect(resolveSuspended).toHaveBeenCalledTimes(2);
    expect(delivered).toHaveLength(1);
    expect(decisionBody(onlyDecision(delivered)).outcome).toBe("approved");

    expect(await resume.handle(suspension("corr-A", "echo alpha"))).toBe(true);
    expect(resolveSuspended).toHaveBeenCalledTimes(2);
    expect(delivered).toHaveLength(1);
  });
});
