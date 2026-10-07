/**
 * Shared scaffolding for the runSubAgent probe tests: stub-Agent plumbing for
 * the live-tool-dispatch mock, default run params, a failing local provider,
 * and a condition poller.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withMockedModuleDuring } from "../../testkit/mock-module.js";
import { testPermissionGate } from "./fleet-test-harness.js";
import type { RunSubAgentParams } from "./types.js";

export function tmpSubAgentCwd(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/**
 * The no-op tail every stub Agent shares — stream/deliver/close/etc. Tests
 * spread this and override `send` (and occasionally `stream`/`deliver`/`close`)
 * with the behavior under test.
 */
export function stubAgent(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

/**
 * Mock `createAgentWithLiveToolDispatch` for the duration of `body` so the
 * real runSubAgent wiring runs against `stub` instead of a live agent. `stub`
 * may be the agent object itself or a factory invoked with the dispatch args.
 */
export async function withStubbedAgent<T>(
  stub: unknown | ((...args: unknown[]) => unknown),
  body: () => Promise<T>,
): Promise<T> {
  return withMockedModuleDuring(
    import.meta.resolve("../agent/live-tool-dispatch.js"),
    (real: typeof import("../agent/live-tool-dispatch.js")) => ({
      ...real,
      createAgentWithLiveToolDispatch: async (...args: unknown[]) => {
        const agent =
          typeof stub === "function"
            ? await (stub as (...a: unknown[]) => unknown)(...args)
            : stub;
        return agent as Awaited<
          ReturnType<typeof real.createAgentWithLiveToolDispatch>
        >;
      },
    }),
    body,
  );
}

/** runSubAgent's onAgentReady handle bundle. */
export type RunProbeHandles = Parameters<
  NonNullable<RunSubAgentParams["onAgentReady"]>
>[0];

/** Capture onAgentReady handles; `require` throws if the callback never fired. */
export function captureRunHandles() {
  let captured: RunProbeHandles | undefined;
  return {
    onAgentReady: (handles: RunProbeHandles) => {
      captured = handles;
    },
    peek: () => captured,
    require(): RunProbeHandles {
      if (captured === undefined) throw new Error("onAgentReady never fired");
      return captured;
    },
  };
}

/** RunSubAgentParams defaults shared by the run-probe tests. */
export function baseRunParams(
  cwd: string,
  overrides: Partial<RunSubAgentParams> = {},
): RunSubAgentParams {
  return {
    cwd,
    workdirBase: join(cwd, ".ctx"),
    permissionGate: testPermissionGate,
    provider: {
      providerName: "test",
      baseURL: "http://localhost",
      model: "test-model",
    },
    description: "probe",
    prompt: "no-op",
    ...overrides,
  };
}

/**
 * Wrap createPosixTools so `dispose` is replaced for the duration of `body` —
 * the persist-close probes need a dispose that hangs, throws, or just records.
 */
export async function withPosixDispose<T>(
  dispose: () => Promise<void>,
  body: () => Promise<T>,
): Promise<T> {
  return withMockedModuleDuring(
    import.meta.resolve("@intx/tools-posix"),
    (real: typeof import("@intx/tools-posix")) => ({
      ...real,
      createPosixTools: (opts: Parameters<typeof real.createPosixTools>[0]) =>
        Object.assign(real.createPosixTools(opts), { dispose }),
    }),
    body,
  );
}

/**
 * Drive `run` against a local provider that fails every request as
 * credential_failure (never retried), so mount decisions run while the
 * inference send fails in one local round trip instead of paying retry
 * backoff. Assertions downstream are timing-independent.
 */
export async function runWithFailingInference(
  run: (baseURL: string) => Promise<unknown>,
): Promise<void> {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(JSON.stringify({ error: { message: "probe" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
  });
  try {
    await run(server.url.origin);
  } finally {
    server.stop(true);
  }
}

/**
 * Poll `condition` until it holds or `attempts` ticks pass.
 */
export async function pollUntil(
  condition: () => boolean | Promise<boolean>,
  opts: { attempts?: number; intervalMs?: number; message?: string } = {},
): Promise<void> {
  const attempts = opts.attempts ?? 500;
  for (let i = 0; i < attempts; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, opts.intervalMs ?? 1));
  }
  throw new Error(opts.message ?? "condition was not reached");
}
