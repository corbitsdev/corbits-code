/**
 * Regression guard: lifecycle-tools.test.ts proves interrupt_agent /
 * resume_agent behave correctly against *fake registered closures* at the
 * tool/store layer — it never exercises run.ts's real wiring, where
 * `followup` calls `agent!.send()` on the same live agent object created by
 * `createAgentWithLiveToolDispatch`. A future refactor could make
 * `resume_agent` rebuild the agent instead of reusing it (exactly the
 * regression this feature exists to prevent — a rebuilt agent means the
 * worker re-reads the codebase from scratch) without failing any existing
 * test.
 *
 * This test drives the real `runSubAgent` (run.ts) end to end with the one
 * real dependency that would require live inference credentials —
 * `createAgentWithLiveToolDispatch` — replaced by a stub `Agent`. Everything
 * else (tool assembly, environment gathering, the dispatch brief, the
 * onAgentReady wiring, the interrupt/followup closures themselves) is the
 * genuine run.ts code path.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withMockedModuleDuring } from "../../tests/helpers/mock-module.js";
import { createPermissionGate } from "../permission/gate.js";
import type { RunSubAgentParams } from "./types.js";

const testPermissionGate = createPermissionGate({
  approvals: [],
  interactive: false,
  skipPermissions: true,
});

async function tmpCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cl6997-live-agent-"));
}

/** Minimal stand-in for the vendored `Agent` (dist/agent.d.ts), instrumented
 * to prove reuse: `sendLog` accumulates every message across BOTH the
 * original send and the later followup send, and rejects like the real
 * `Agent.send`'s documented `signal` option when its signal fires. */
function createStubAgent(opts?: { hangFromSend?: number }) {
  const sendLog: string[] = [];
  const abortedSends: boolean[] = [];
  return {
    sendLog,
    abortedSends,
    async send(content: string, optsSend?: { signal?: AbortSignal }) {
      sendLog.push(content);
      const index = sendLog.length - 1;
      abortedSends[index] = false;
      return await new Promise((resolve, reject) => {
        const abort = (reason: unknown) => {
          abortedSends[index] = true;
          reject(reason instanceof Error ? reason : new Error("aborted"));
        };
        if (optsSend?.signal?.aborted === true) {
          abort(optsSend.signal.reason);
          return;
        }
        const hang = opts?.hangFromSend !== undefined && sendLog.length >= opts.hangFromSend;
        const timer = hang
          ? undefined
          : setTimeout(
              () =>
                resolve({
                  reply: `reply #${sendLog.length}`,
                  turn: { role: "assistant", content: [] },
                }),
              20,
            );
        optsSend?.signal?.addEventListener(
          "abort",
          () => {
            if (timer !== undefined) clearTimeout(timer);
            abort(optsSend.signal!.reason);
          },
          { once: true },
        );
      });
    },
    stream: () => (async function* () {})(),
    deliver: () => {},
    close: async () => {},
    setSource: () => {},
    setSources: () => {},
    history: async () => [],
    checkpoints: async () => [],
    readAt: async () => [],
    blobReader: {},
  };
}

describe("interrupt_agent / resume_agent reuse the same live agent", () => {
  test("followup after interrupt sends into the SAME agent instance — not a rebuilt one", async () => {
    const cwd = await tmpCwd();
    let constructions = 0;
    let capturedAgent: ReturnType<typeof createStubAgent> | undefined;

    const outcome = await withMockedModuleDuring(
      import.meta.resolve("../agent/live-tool-dispatch.js"),
      (real: typeof import("../agent/live-tool-dispatch.js")) => ({
        ...real,
        createAgentWithLiveToolDispatch: async () => {
          constructions++;
          const stub = createStubAgent();
          capturedAgent = stub;
          return stub as unknown as Awaited<
            ReturnType<typeof real.createAgentWithLiveToolDispatch>
          >;
        },
      }),
      async () => {
        const { runSubAgent } = await import("./run.js");

        let handles:
          | {
              close: (ms?: number) => Promise<void>;
              interrupt: () => void;
              followup: (message: string) => Promise<string>;
            }
          | undefined;

        const params: RunSubAgentParams = {
          cwd,
          workdirBase: join(cwd, ".ctx"),
          permissionGate: testPermissionGate,
          provider: { providerName: "test", baseURL: "http://localhost", model: "test-model" },
          description: "live-agent reuse probe",
          prompt: "explore the codebase for the bug",
          persist: true,
          onAgentReady: (h) => {
            handles = h;
          },
        };

        const runPromise = runSubAgent(params);

        // onAgentReady fires before agent.send() is awaited; poll briefly
        // rather than assume a fixed number of ticks.
        for (let i = 0; i < 500 && handles === undefined; i++) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        if (handles === undefined) throw new Error("onAgentReady never fired");

        handles.interrupt();
        const interruptedResult = await runPromise;

        const reply = await handles.followup("do X instead, not what the original prompt said");
        return { interruptedResult, reply };
      },
    );

    expect(outcome.interruptedResult.interrupted).toBe(true);
    // Exactly one agent was ever constructed across the interrupted turn and
    // the followup — a rebuild would show up here as constructions === 2.
    expect(constructions).toBe(1);
    expect(capturedAgent).toBeDefined();

    // The load-bearing assertion: the SAME agent's message log holds both
    // the original turn's prompt and the followup message, proving the
    // followup was sent into the same live object rather than a fresh one
    // with empty history.
    expect(capturedAgent!.sendLog.length).toBe(2);
    expect(capturedAgent!.sendLog[0]).toContain("explore the codebase for the bug");
    expect(capturedAgent!.sendLog[1]).toBe("do X instead, not what the original prompt said");
    expect(outcome.reply).toBe("reply #2");
  });

  test("interrupt_agent aborts the resumed followup agent.send", async () => {
    const cwd = await tmpCwd();
    let constructions = 0;
    let capturedAgent: ReturnType<typeof createStubAgent> | undefined;

    const outcome = await withMockedModuleDuring(
      import.meta.resolve("../agent/live-tool-dispatch.js"),
      (real: typeof import("../agent/live-tool-dispatch.js")) => ({
        ...real,
        createAgentWithLiveToolDispatch: async () => {
          constructions++;
          const stub = createStubAgent({ hangFromSend: 2 });
          capturedAgent = stub;
          return stub as unknown as Awaited<
            ReturnType<typeof real.createAgentWithLiveToolDispatch>
          >;
        },
      }),
      async () => {
        const { runSubAgent } = await import("./run.js");

        let handles:
          | {
              close: (ms?: number) => Promise<void>;
              interrupt: () => void;
              followup: (message: string) => Promise<string>;
            }
          | undefined;

        const params: RunSubAgentParams = {
          cwd,
          workdirBase: join(cwd, ".ctx"),
          permissionGate: testPermissionGate,
          provider: { providerName: "test", baseURL: "http://localhost", model: "test-model" },
          description: "live-agent followup interrupt probe",
          prompt: "finish the first turn",
          persist: true,
          onAgentReady: (h) => {
            handles = h;
          },
        };

        const first = await runSubAgent(params);
        if (handles === undefined) throw new Error("onAgentReady never fired");

        const followupPromise = handles.followup("now do the second turn");
        for (let i = 0; i < 500 && (capturedAgent?.sendLog.length ?? 0) < 2; i++) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        handles.interrupt();
        const followup = await followupPromise.then(
          (reply) => ({ ok: true as const, reply }),
          (err: unknown) => ({
            ok: false as const,
            message: err instanceof Error ? err.message : String(err),
          }),
        );
        return { first, followup };
      },
    );

    expect(outcome.first.agentRetained).toBe(true);
    expect(constructions).toBe(1);
    expect(capturedAgent?.sendLog.length).toBe(2);
    expect(capturedAgent?.sendLog[1]).toBe("now do the second turn");
    expect(capturedAgent?.abortedSends[1]).toBe(true);
    expect(outcome.followup.ok).toBe(false);
    if (outcome.followup.ok) throw new Error("expected followup send to abort");
    expect(outcome.followup.message).toContain("interrupted by interrupt_agent");
  });
});
