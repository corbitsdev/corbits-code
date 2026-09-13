/**
 * Steering rotation: runSubAgent mints the submit_result turn token at leaf
 * dispatch and rotates it on every followup steer, so a worker holding the
 * dispatched token cannot submit after its turn was superseded. The pure
 * evaluator half (old token rejected, budget reset) is covered in
 * submit-result.test.ts; this test drives the real runSubAgent wiring end to
 * end — the one seam the pure tests cannot see is whether followup actually
 * mints, swaps, and re-states the token. Same stub-agent pattern as
 * followup-live-agent.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withMockedModuleDuring } from "../../tests/helpers/mock-module.js";
import { defined } from "../../tests/helpers/defined.js";
import { createPermissionGate } from "../permission/gate.js";
import type { RunSubAgentParams } from "./types.js";

const testPermissionGate = createPermissionGate({
  approvals: [],
  interactive: false,
  skipPermissions: true,
  reactorGated: false,
});

/** First send hangs (the run stays alive for steering); later sends resolve. */
function createRotatingStubAgent(sendLog: string[]) {
  return {
    async send(content: string, optsSend?: { signal?: AbortSignal }) {
      sendLog.push(content);
      if (sendLog.length === 1) {
        return await new Promise((_, reject) => {
          if (optsSend?.signal?.aborted === true) {
            reject(
              optsSend.signal.reason instanceof Error
                ? optsSend.signal.reason
                : new Error("aborted"),
            );
            return;
          }
          optsSend?.signal?.addEventListener(
            "abort",
            () => {
              const reason = defined(optsSend.signal).reason;
              reject(reason instanceof Error ? reason : new Error("aborted"));
            },
            { once: true },
          );
        });
      }
      return {
        type: "reply" as const,
        reply: `reply #${sendLog.length}`,
        turn: { role: "assistant", content: [] },
      };
    },
    stream: () =>
      (async function* () {
        yield* [];
      })(),
    deliver: () => undefined,
    close: async () => undefined,
    setSource: () => undefined,
    setSources: () => undefined,
    history: async () => [],
    checkpoints: async () => [],
    readAt: async () => [],
    blobReader: {},
  };
}

function tokenOfSend(send: string): string | undefined {
  return send.match(/^## Turn token\n(.+)$/m)?.[1];
}

describe("submit_result token rotation on steering", () => {
  test("followup rotates the leaf turn token and states the replacement in the steer", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cl6946-token-rotation-"));
    const sendLog: string[] = [];

    const outcome = await withMockedModuleDuring(
      import.meta.resolve("../agent/live-tool-dispatch.js"),
      (real: typeof import("../agent/live-tool-dispatch.js")) => ({
        ...real,
        createAgentWithLiveToolDispatch: async () =>
          createRotatingStubAgent(sendLog) as unknown as Awaited<
            ReturnType<typeof real.createAgentWithLiveToolDispatch>
          >,
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
          provider: {
            providerName: "test",
            baseURL: "http://localhost",
            model: "test-model",
          },
          description: "token rotation probe",
          prompt: "hold for steering",
          persist: true,
          tier: "leaf",
          onAgentReady: (h) => {
            handles = h;
          },
        };

        const runPromise = runSubAgent(params);
        for (let i = 0; i < 500 && sendLog.length < 1; i++) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        if (handles === undefined) throw new Error("onAgentReady never fired");

        const reply = await handles.followup("new orders: pivot to X");
        // followup replaced the per-turn interrupt controller, so interrupt()
        // can no longer reach the still-hung first send — close() aborts the
        // run controller instead and settles the run for cleanup. Both can
        // reject with the abort reason; settlement is all we need.
        await handles.close().catch(() => undefined);
        await runPromise.catch(() => undefined);
        return { reply };
      },
    );

    expect(outcome.reply).toBe("reply #2");
    expect(sendLog.length).toBe(2);

    // The dispatched brief states the first token; the steer carries the
    // followup message plus a DIFFERENT token — the old one dies here.
    const dispatched = tokenOfSend(defined(sendLog[0]));
    const steered = tokenOfSend(defined(sendLog[1]));
    expect(dispatched).toBeDefined();
    expect(steered).toBeDefined();
    expect(defined(steered)).not.toBe(defined(dispatched));
    expect(defined(sendLog[1]).startsWith("new orders: pivot to X")).toBe(true);
    expect(defined(sendLog[1])).toContain(`turn_token="${defined(steered)}"`);
  });
});
