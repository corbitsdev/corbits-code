import { afterEach, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config/index.js";
import {
  resetPricingMetadataRefreshForTests,
  schedulePricingMetadataRefresh,
} from "../../src/cost/pricing-metadata.js";
import { execSessionEndProperties, runExec } from "../../src/exec/runner.js";
import {
  clearActiveRun,
  getActiveRun,
  setActiveRun,
} from "../../src/session/active-run.js";
import {
  activateHeldTelemetry,
  type FirstRunDeps,
} from "../../src/telemetry/first-run.js";
import {
  createTelemetry,
  NOOP_TELEMETRY,
  type Telemetry,
  type TelemetryEvent,
} from "../../src/telemetry/index.js";
import { setTelemetry } from "../../src/telemetry/singleton.js";
import { defined } from "../helpers/defined.js";
import {
  withMockedHomedir,
  withMockedModuleDuring,
} from "../helpers/mock-module.js";
import { createTempDirs } from "../helpers/temporary-dirs.js";

afterEach(() => {
  setTelemetry(NOOP_TELEMETRY);
});

interface BatchBody {
  api_key: string;
  batch: {
    event: string;
    timestamp: string;
    properties: Record<string, unknown>;
  }[];
}

function recordingFetch() {
  const bodies: BatchBody[] = [];
  const fetchFn = ((_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string) as BatchBody);
    return Promise.resolve(new Response("1", { status: 200 }));
  }) as unknown as typeof fetch;
  return {
    fetchFn,
    events: () => bodies.flatMap((body) => body.batch),
  };
}

function settingsWithId() {
  return { providers: {}, telemetry: { installationId: "id" } };
}

test("cli_start allowlist passes surface through and strips everything else", async () => {
  const { fetchFn, events } = recordingFetch();
  const telemetry = createTelemetry({
    settings: settingsWithId(),
    env: {},
    fetchFn,
    apiKey: "test-key",
  });
  telemetry.capture("cli_start", { surface: "exec", prompt: "must-not-leave" });
  await telemetry.flush();
  expect(events()).toHaveLength(1);
  const body = defined(events()[0], "telemetry event");
  expect(body.event).toBe("cli_start");
  expect(body.properties.surface).toBe("exec");
  expect(body.properties.prompt).toBeUndefined();
});

test("session_end allowlist passes the exec-shaped payload and strips extras", async () => {
  const { fetchFn, events } = recordingFetch();
  const telemetry = createTelemetry({
    settings: settingsWithId(),
    env: {},
    fetchFn,
    apiKey: "test-key",
  });
  telemetry.capture("session_end", {
    status: "done",
    turn_count: 2,
    duration_ms: 150,
    session_mode: "exec",
    exit_reason: "done",
    task: "must-not-leave",
  });
  await telemetry.flush();
  expect(events()).toHaveLength(1);
  const body = defined(events()[0], "telemetry event");
  expect(body.properties.status).toBe("done");
  expect(body.properties.turn_count).toBe(2);
  expect(body.properties.duration_ms).toBe(150);
  expect(body.properties.session_mode).toBe("exec");
  expect(body.properties.exit_reason).toBe("done");
  expect(body.properties.task).toBeUndefined();
});

function recordingFirstRunDeps() {
  const { fetchFn, events } = recordingFetch();
  let instance: Telemetry | undefined;
  const deps: FirstRunDeps = {
    loadSettings: async () => settingsWithId(),
    markTelemetryNoticeShown: async () => undefined,
    createTelemetry: (opts) =>
      createTelemetry({ ...opts, env: {}, apiKey: "test-key", fetchFn }),
    setTelemetry: (telemetry) => {
      instance = telemetry;
    },
  };
  return { deps, getInstance: () => instance, events };
}

test("activateHeldTelemetry fires the held cli_start with tui surface by default", async () => {
  const { deps, getInstance, events } = recordingFirstRunDeps();
  await activateHeldTelemetry("/fake/path", () => true, deps);
  await defined(getInstance(), "telemetry instance").flush();
  const cliStarts = events().filter((event) => event.event === "cli_start");
  expect(cliStarts).toHaveLength(1);
  expect(defined(cliStarts[0], "cli_start").properties.surface).toBe("tui");
});

test("activateHeldTelemetry forwards an explicit exec surface on cli_start", async () => {
  const { deps, getInstance, events } = recordingFirstRunDeps();
  await activateHeldTelemetry("/fake/path", () => true, deps, "exec");
  await defined(getInstance(), "telemetry instance").flush();
  const cliStarts = events().filter((event) => event.event === "cli_start");
  expect(cliStarts).toHaveLength(1);
  expect(defined(cliStarts[0], "cli_start").properties.surface).toBe("exec");
});

test("execSessionEndProperties mirrors the TUI exit_reason contract", () => {
  expect(
    execSessionEndProperties(
      {
        exitCode: 0,
        sessionId: "s",
        text: "ok",
        status: "done",
        durationMs: 150,
        turnsUsed: 3,
      },
      0,
      0,
    ),
  ).toEqual({
    status: "done",
    turn_count: 3,
    duration_ms: 150,
    session_mode: "exec",
    exit_reason: "done",
  });
  const failed = execSessionEndProperties(undefined, Date.now() - 40, 1);
  expect(failed.status).toBe("failed");
  expect(failed.turn_count).toBe(1);
  expect(failed.session_mode).toBe("exec");
  expect(failed.exit_reason).toBe("error");
  expect(typeof failed.duration_ms).toBe("number");
  const cancelled = execSessionEndProperties(
    {
      exitCode: 1,
      sessionId: "s",
      text: "",
      status: "cancelled",
      durationMs: 90,
      turnsUsed: 2,
    },
    0,
    0,
  );
  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.exit_reason).toBe("cancelled");
});

function silenceStderr(): () => void {
  const original = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  return () => {
    process.stderr.write = original;
  };
}

function bareConfig(task: string): Config {
  return {
    command: "exec",
    task,
    cwd: process.cwd(),
    configured: true,
    providerName: "test",
    model: "test",
    providers: {},
    dangerouslySkipPermissions: true,
    autoMode: false,
    sessionId: "test-session",
  } as unknown as Config;
}

test("runExec with a missing prompt emits exactly one failed exec session_end", async () => {
  const { fetchFn, events } = recordingFetch();
  const telemetry = createTelemetry({
    settings: settingsWithId(),
    env: {},
    fetchFn,
    apiKey: "test-key",
  });
  setTelemetry(telemetry);
  const restoreStderr = silenceStderr();
  try {
    const result = await runExec(bareConfig("   "));
    expect(result.status).toBe("failed");
  } finally {
    restoreStderr();
  }
  await telemetry.flush();
  const ends = events().filter((event) => event.event === "session_end");
  expect(ends).toHaveLength(1);
  const body = defined(ends[0], "session_end");
  expect(body.properties.status).toBe("failed");
  expect(body.properties.turn_count).toBe(0);
  expect(body.properties.duration_ms).toBe(0);
  expect(body.properties.session_mode).toBe("exec");
  expect(body.properties.exit_reason).toBe("error");
});

test("runExec bootstrap failure emits exactly one failed exec session_end", async () => {
  const previous = getActiveRun();
  clearActiveRun();
  const { cwd, home, cleanup } = createTempDirs(
    "corbits-session-end-cwd-",
    "corbits-session-end-home-",
  );
  const { fetchFn, events } = recordingFetch();
  const telemetry = createTelemetry({
    settings: settingsWithId(),
    env: {},
    fetchFn,
    apiKey: "test-key",
  });
  setTelemetry(telemetry);
  const restoreStderr = silenceStderr();
  try {
    await withMockedHomedir(home, async () => {
      await withMockedModuleDuring(
        import.meta.resolve("../../src/session/assemble-runtime.js"),
        (real: typeof import("../../src/session/assemble-runtime.js")) => ({
          ...real,
          assembleInferenceBase: () =>
            Promise.reject(new Error("bootstrap failed")),
        }),
        async () => {
          const { runExec: runExecUnderMock } =
            await import("../../src/exec/runner.js");
          const result = await runExecUnderMock({
            ...bareConfig("do the thing"),
            cwd,
            sessionId: "exec-session-end-fail",
          });
          expect(result.exitCode).toBe(1);
          expect(result.status).toBe("failed");
        },
      );
    });
  } finally {
    restoreStderr();
    if (previous !== null) setActiveRun(previous);
    else clearActiveRun();
    cleanup();
  }
  await telemetry.flush();
  const ends = events().filter((event) => event.event === "session_end");
  expect(ends).toHaveLength(1);
  const body = defined(ends[0], "session_end");
  expect(body.properties.status).toBe("failed");
  expect(body.properties.session_mode).toBe("exec");
  expect(body.properties.exit_reason).toBe("error");
});

function writeSandboxSettings(root: string): void {
  const settingsDir = join(root, "home", ".corbits");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(
    join(settingsDir, "settings.json"),
    JSON.stringify({
      providers: {
        "test-provider": {
          baseURL: "http://localhost:1234",
          apiKey: "test-key",
          models: ["test-model"],
          defaultModel: "test-model",
        },
      },
      defaultProvider: "test-provider",
    }),
  );
  mkdirSync(join(root, "project"), { recursive: true });
}

async function withoutTelemetryKills(fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ["CORBITS_TELEMETRY", "DO_NOT_TRACK"]) {
    saved[key] = process.env[key];
    Reflect.deleteProperty(process.env, key);
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
}

async function cliStartSurfaces(
  subcommand: readonly string[],
  rest: readonly string[] = [],
): Promise<unknown[]> {
  const sandbox = mkdtempSync(join(tmpdir(), "corbits-session-end-cli-"));
  writeSandboxSettings(sandbox);
  resetPricingMetadataRefreshForTests();
  schedulePricingMetadataRefresh({
    cachePath: join(
      sandbox,
      "home",
      ".corbits",
      "cache",
      "models-pricing.json",
    ),
    fetchImpl: () => Promise.reject(new Error("network disabled in tests")),
  });
  const captured: {
    event: TelemetryEvent;
    properties: Record<string, unknown> | undefined;
  }[] = [];
  const stub: Telemetry = {
    enabled: true,
    installationId: "test-installation",
    capture: (event, properties) => {
      captured.push({ event, properties });
    },
    captureIntentional: () => false,
    flush: async () => undefined,
    discard: () => undefined,
  };
  try {
    await withoutTelemetryKills(async () => {
      await withMockedModuleDuring(
        import.meta.resolve("../../src/telemetry/index.js"),
        (real: typeof import("../../src/telemetry/index.js")) => ({
          ...real,
          telemetryDisabledByEnv: () => false,
          createTelemetry: () => stub,
        }),
        async () => {
          await withMockedModuleDuring(
            import.meta.resolve("../../src/config/settings.js"),
            (real: typeof import("../../src/config/settings.js")) => ({
              ...real,
              ensureTelemetrySettings: async () => ({
                providers: {},
                telemetry: {
                  installationId: "test-installation",
                  noticeShown: true,
                },
              }),
              globalSettingsPath: () => join(sandbox, "global.json"),
            }),
            async () => {
              const { mainWithRunners } = await import("../../src/index.js");
              const runTUI = mock((_config: Config) => Promise.resolve(0));
              const runExec = mock((_config: Config) => Promise.resolve(0));
              const runOnboarding = mock(() => Promise.resolve(0));
              await mainWithRunners(
                [
                  ...subcommand,
                  "--cwd",
                  join(sandbox, "project"),
                  "--config",
                  join(sandbox, "home", ".corbits", "settings.json"),
                  ...rest,
                ],
                { runTUI, runExec, runOnboarding },
              );
            },
          );
        },
      );
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
  return captured
    .filter((entry) => entry.event === "cli_start")
    .map((entry) => entry.properties?.surface);
}

test("startup cli_start carries surface exec on the exec path", async () => {
  expect(await cliStartSurfaces(["exec"], ["say hello"])).toEqual(["exec"]);
});

test("startup cli_start carries surface tui on the interactive path", async () => {
  expect(await cliStartSurfaces([])).toEqual(["tui"]);
});
