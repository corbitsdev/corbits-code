/**
 * run.ts must thread grant_request_id from the ask_director tool call through
 * the leaf handler into handleAskDirector and out the askDirectorPort.
 * Dropping it at the schema or the handler silently forces every production
 * ask down the legacy first-pending path, so this test drives the real
 * handler path end to end — unit tests on handleAskDirector alone cannot
 * see the two call sites this covers.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DirectorFactory } from "@intx/agent";

import { withMockedModuleDuring } from "../../testkit/mock-module.js";
import { createPermissionGate } from "../permission/gate.js";
import type { RunSubAgentParams } from "./types.js";

const testPermissionGate = createPermissionGate({
  approvals: [],
  interactive: false,
  skipPermissions: true,
  reactorGated: false,
});

/** Valid policy payload for the run/grant fixtures (Blocker 1). */
const assessed = {
  policyVersion: "1",
  classification: "director_resolvable",
  blockedOutcome: "cannot choose a target branch",
  unavailableDirectorPath: "the director has no branch map",
  permittedAlternatives: [
    {
      attempted: "check the branch list",
      result: "ambiguous",
      comparableConfidence: false,
    },
  ],
  minimumAddition: "a branch decision",
  declineConsequence: "implementation stays on the current branch",
} as const;

function createHangingStubAgent() {
  return {
    async send(_content: string, optsSend?: { signal?: AbortSignal }) {
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
            const reason = optsSend.signal?.reason;
            reject(reason instanceof Error ? reason : new Error("aborted"));
          },
          { once: true },
        );
      });
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

describe("runSubAgent ask_director grant_request_id threading", () => {
  test("leaf forwards grant_request_id to the port; an assessed ask without one stays unnamed", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cl9475-ask-grant-"));
    const registered: {
      question: string;
      questionId: string;
      grantRequestId?: string;
      assessment?: unknown;
    }[] = [];
    let capturedAskHandler:
      | ((
          rawArgs: Record<string, unknown>,
          signal: AbortSignal,
        ) => Promise<string> | string)
      | undefined;
    let capturedFactory: DirectorFactory | undefined;
    let handles: { close: (ms?: number) => Promise<void> } | undefined;

    const outcome = await withMockedModuleDuring(
      import.meta.resolve("@intx/agent"),
      (real: typeof import("@intx/agent")) => ({
        ...real,
        defineDirector: (opts: Parameters<typeof real.defineDirector>[0]) => {
          capturedFactory = opts.factory;
          return real.defineDirector(opts);
        },
        stringTool: (args: Parameters<typeof real.stringTool>[0]) => {
          const tool = real.stringTool(args);
          if (args.definition.name === "ask_director") {
            capturedAskHandler = args.handler;
          }
          return tool;
        },
      }),
      async () =>
        await withMockedModuleDuring(
          import.meta.resolve("../agent/live-tool-dispatch.js"),
          (real: typeof import("../agent/live-tool-dispatch.js")) => ({
            ...real,
            createAgentWithLiveToolDispatch: async () =>
              createHangingStubAgent() as unknown as Awaited<
                ReturnType<typeof real.createAgentWithLiveToolDispatch>
              >,
          }),
          async () => {
            const { runSubAgent } = await import("./run.js");

            const params: RunSubAgentParams = {
              cwd,
              workdirBase: join(cwd, ".ctx"),
              permissionGate: testPermissionGate,
              provider: {
                providerName: "test",
                baseURL: "http://localhost",
                model: "test-model",
              },
              description: "ask_director grant threading",
              prompt: "hold for ask_director",
              persist: true,
              tier: "leaf",
              askDirectorPort: {
                register: (input) => {
                  registered.push({ ...input });
                  return Promise.resolve(`answer:${registered.length}`);
                },
                cancel: () => undefined,
              },
              onAgentReady: (h) => {
                handles = h;
              },
            };

            const runPromise = runSubAgent(params);
            for (let i = 0; i < 500 && handles === undefined; i++) {
              await new Promise((resolve) => setTimeout(resolve, 1));
            }
            if (handles === undefined)
              throw new Error("onAgentReady never fired");
            if (capturedFactory === undefined)
              throw new Error("defineDirector factory not seen");
            if (capturedAskHandler === undefined)
              throw new Error("ask_director tool was not mounted");

            // Exercise the factory so the leaf tool wiring is live.
            capturedFactory({}, {} as never, {
              systemPrompt: "system",
              toolDefinitions: [],
              compactorNames: [],
            });

            const named = await capturedAskHandler(
              {
                question: "may I retry?",
                grant_request_id: "grant-123",
                escalation: assessed,
              },
              new AbortController().signal,
            );
            expect(named).toBe("answer:1");

            const unnamed = await capturedAskHandler(
              {
                question: "plain question",
                escalation: assessed,
              },
              new AbortController().signal,
            );
            expect(unnamed).toBe("answer:2");

            await handles.close().catch(() => undefined);
            await runPromise.catch(() => undefined);
            return { registered };
          },
        ),
    );

    expect(outcome.registered.length).toBe(2);
    expect(outcome.registered[0]?.question).toBe("may I retry?");
    expect(outcome.registered[0]?.grantRequestId).toBe("grant-123");
    expect(outcome.registered[0]?.assessment).toMatchObject({
      policyVersion: "1",
      classification: "director_resolvable",
    });
    expect(outcome.registered[1]?.question).toBe("plain question");
    expect(outcome.registered[1]?.grantRequestId).toBeUndefined();
    expect(outcome.registered[1]?.assessment).toMatchObject({
      policyVersion: "1",
      classification: "director_resolvable",
    });
  });
});
