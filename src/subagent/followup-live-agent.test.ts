/**
 * Regression guard: lifecycle-tools.test.ts proves interrupt_agent /
 * resume_agent against fake registered closures, but never exercises run.ts
 * wiring, where `followup` calls `agent.send()` on the same live agent
 * object. A future refactor could rebuild the agent on resume (forcing a
 * full codebase re-read) without failing any existing test.
 *
 * This drives the real runSubAgent end to end, replacing only
 * `createAgentWithLiveToolDispatch` — the one dependency needing live
 * credentials — with a stub `Agent`.
 */
import { describe, expect, test } from "bun:test";

import { defined } from "../../testkit/defined.js";
import { errorMessage } from "../agent/error-message.js";
import {
  baseRunParams,
  captureRunHandles,
  pollUntil,
  stubAgent,
  tmpSubAgentCwd,
  withStubbedAgent,
} from "./run-test-harness.js";

/** Stand-in for the vendored `Agent`, instrumented to prove reuse:
 * `sendLog` accumulates every message across both sends, and send rejects
 * on its signal like the real `Agent.send`. */
function createStubAgent(opts?: { hangFromSend?: number }) {
  const sendLog: string[] = [];
  const abortedSends: boolean[] = [];
  return {
    sendLog,
    abortedSends,
    send: async (content: string, optsSend?: { signal?: AbortSignal }) => {
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
        const hang =
          opts?.hangFromSend !== undefined &&
          sendLog.length >= opts.hangFromSend;
        const timer = hang
          ? undefined
          : setTimeout(
              () =>
                resolve({
                  type: "reply" as const,
                  reply: `reply #${sendLog.length}`,
                  turn: { role: "assistant", content: [] },
                }),
              20,
            );
        optsSend?.signal?.addEventListener(
          "abort",
          () => {
            if (timer !== undefined) clearTimeout(timer);
            abort(defined(optsSend.signal).reason);
          },
          { once: true },
        );
      });
    },
    ...stubAgent(),
  };
}

describe("interrupt_agent / resume_agent reuse the same live agent", () => {
  test("followup after interrupt sends into the SAME agent instance — not a rebuilt one", async () => {
    const cwd = await tmpSubAgentCwd("cl6997-live-agent-");
    let constructions = 0;
    let capturedAgent: ReturnType<typeof createStubAgent> | undefined;

    const outcome = await withStubbedAgent(
      async () => {
        constructions++;
        const stub = createStubAgent();
        capturedAgent = stub;
        return stub;
      },
      async () => {
        const { runSubAgent } = await import("./run.js");
        const handles = captureRunHandles();
        const runPromise = runSubAgent(
          baseRunParams(cwd, {
            description: "live-agent reuse probe",
            prompt: "explore the codebase for the bug",
            persist: true,
            onAgentReady: handles.onAgentReady,
          }),
        );

        // onAgentReady fires before agent.send() is awaited; poll briefly
        // rather than assume a fixed number of ticks.
        await pollUntil(() => handles.peek() !== undefined, {
          message: "onAgentReady never fired",
        });

        handles.require().interrupt();
        const interruptedResult = await runPromise;

        const reply = await handles
          .require()
          .followup("do X instead, not what the original prompt said");
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
    expect(defined(capturedAgent).sendLog.length).toBe(2);
    expect(defined(capturedAgent).sendLog[0]).toContain(
      "explore the codebase for the bug",
    );
    expect(defined(capturedAgent).sendLog[1]).toBe(
      "do X instead, not what the original prompt said",
    );
    expect(outcome.reply).toBe("reply #2");
  });

  test("interrupt_agent salvage is stopReason interrupted, not cancelled", async () => {
    const cwd = await tmpSubAgentCwd("cl6997-live-agent-");
    let capturedAgent: ReturnType<typeof createStubAgent> | undefined;

    const outcome = await withStubbedAgent(
      async () => {
        const stub = createStubAgent({ hangFromSend: 1 });
        capturedAgent = stub;
        return stub;
      },
      async () => {
        const { runSubAgent } = await import("./run.js");
        const handles = captureRunHandles();
        const runPromise = runSubAgent(
          baseRunParams(cwd, {
            description: "interrupt salvage stopReason probe",
            prompt: "hang until interrupted",
            persist: true,
            onAgentReady: handles.onAgentReady,
          }),
        );
        await pollUntil(() => (capturedAgent?.sendLog.length ?? 0) >= 1);
        handles.require().interrupt();
        return runPromise;
      },
    );

    expect(capturedAgent?.abortedSends[0]).toBe(true);
    expect(outcome.stopReason).toBe("interrupted");
    expect(outcome.stopReason).not.toBe("cancelled");
    expect(outcome.interrupted).toBe(true);
    expect(outcome.report).toContain("resume_agent");
    expect(outcome.report).toContain("still-live");
    expect(outcome.report).not.toContain("MAY spawn one successor");
    expect(outcome.report).not.toContain("wait for the operator");
  });

  test("interrupt_agent aborts the resumed followup agent.send", async () => {
    const cwd = await tmpSubAgentCwd("cl6997-live-agent-");
    let constructions = 0;
    let capturedAgent: ReturnType<typeof createStubAgent> | undefined;

    const outcome = await withStubbedAgent(
      async () => {
        constructions++;
        const stub = createStubAgent({ hangFromSend: 2 });
        capturedAgent = stub;
        return stub;
      },
      async () => {
        const { runSubAgent } = await import("./run.js");
        const handles = captureRunHandles();
        const first = await runSubAgent(
          baseRunParams(cwd, {
            description: "live-agent followup interrupt probe",
            prompt: "finish the first turn",
            persist: true,
            onAgentReady: handles.onAgentReady,
          }),
        );

        const followupPromise = handles
          .require()
          .followup("now do the second turn");
        await pollUntil(() => (capturedAgent?.sendLog.length ?? 0) >= 2);
        handles.require().interrupt();
        const followup = await followupPromise.then(
          (reply) => ({ ok: true as const, reply }),
          (err: unknown) => ({
            ok: false as const,
            message: errorMessage(err),
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
    expect(outcome.followup.message).toContain(
      "interrupted by interrupt_agent",
    );
  });
});
