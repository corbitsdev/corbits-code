import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { withMockedModule } from "../../testkit/mock-module.js";
import { createBackgroundShellRegistry } from "../shell/background-shell.js";
import {
  createShellSandbox,
  type SandboxManagerLike,
  type ShellSandbox,
} from "../shell/sandbox-config.js";
import { runGuardedShell } from "./shell-guard-plugin.js";
import type { Settings } from "../config/settings.js";

// Spawn interception: child_process is mocked for this file so every test can
// observe (or rule out) the actual spawn. The real spawn shim is used for
// spawnSync-style calls that nothing in this file performs.
interface SpawnCall {
  command: string;
  args?: string[];
  options: Record<string, unknown> | undefined;
}

const spawnCalls: SpawnCall[] = [];

function fakeChild(): ChildProcess {
  // runGuardedShell only needs an eventing child with piped stdout/stderr and
  // a pid for the group-kill path; no real process runs behind it.
  const events = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = {
    pid: 42,
    stdout,
    stderr,
    on: events.on.bind(events),
    once: events.once.bind(events),
    removeListener: events.removeListener.bind(events),
  };
  queueMicrotask(() => {
    stdout.emit("data", Buffer.from("ok\n"));
    events.emit("close", 0, null);
  });
  return child as unknown as ChildProcess;
}

await withMockedModule("node:child_process", (real) => ({
  ...real,
  // spawn's two call forms (`spawn(cmd, opts)` here; `spawn(cmd, args, opts)`
  // for argv spawn sites) — record both as (command, args, options).
  spawn: (
    command: string,
    argsOrOptions: string[] | Record<string, unknown> | undefined,
    maybeOptions: Record<string, unknown> | undefined,
  ) => {
    const isArgv = Array.isArray(argsOrOptions);
    spawnCalls.push({
      command,
      ...(isArgv ? { args: argsOrOptions } : {}),
      options: (isArgv ? maybeOptions : argsOrOptions) as
        | Record<string, unknown>
        | undefined,
    });
    return fakeChild();
  },
}));

const cwd = tmpdir();

function settingsWithSandbox(
  enabled: boolean,
  allowedHosts?: string[],
): Settings {
  return {
    providers: {},
    ...(enabled || allowedHosts !== undefined
      ? {
          shell: {
            sandbox: {
              ...(enabled ? { enabled: true } : {}),
              ...(allowedHosts !== undefined
                ? { network: { allowedHosts } }
                : {}),
            },
          },
        }
      : {}),
  };
}

function fakeManager(
  overrides: Partial<SandboxManagerLike> = {},
): SandboxManagerLike & {
  initCalls: number;
  wraps: string[];
  argvWraps: string[];
  ask: (host: string, port?: number) => Promise<boolean>;
} {
  const state = {
    initCalls: 0,
    wraps: [] as string[],
    argvWraps: [] as string[],
    ask: async (_host: string, _port?: number): Promise<boolean> => true,
  };
  return {
    get initCalls() {
      return state.initCalls;
    },
    wraps: state.wraps,
    argvWraps: state.argvWraps,
    get ask() {
      return state.ask;
    },
    initialize: async (_config, askCallback) => {
      state.initCalls += 1;
      if (askCallback !== undefined)
        state.ask = async (host, port) => askCallback({ host, port });
    },
    wrapWithSandbox: async (command: string) => {
      state.wraps.push(command);
      if (overrides.wrapWithSandbox !== undefined)
        return overrides.wrapWithSandbox(command);
      return `srt ${command}`;
    },
    wrapWithSandboxArgv: async (command: string) => {
      state.argvWraps.push(command);
      if (overrides.wrapWithSandboxArgv !== undefined)
        return overrides.wrapWithSandboxArgv(command);
      return { argv: ["/bin/sh", "-c", command], env: {} };
    },
    isSupportedPlatform: () => overrides.isSupportedPlatform?.() ?? true,
    reset: async () => {
      await overrides.reset?.();
    },
  };
}

/** createShellSandbox returns undefined when disabled; these tests require it enabled. */
function mustSandbox(options: {
  sessionRoot: string;
  settings: Settings;
  gate: ReturnType<typeof stubGate>;
  manager: SandboxManagerLike;
}): ShellSandbox {
  const sandbox = createShellSandbox(options);
  if (sandbox === undefined) throw new Error("expected sandbox to be enabled");
  return sandbox;
}

// createShellSandbox resolves gate.evaluate; a stub gate records the routed ask.
function stubGate(allowed: boolean) {
  const calls: { name: string; url: string }[] = [];
  return {
    calls,
    evaluate: async (call: {
      name: string;
      arguments: Record<string, unknown>;
    }) => {
      calls.push({
        name: call.name,
        url: String(call.arguments["url"] ?? ""),
      });
      return allowed
        ? { allowed: true as const }
        : { allowed: false as const, reason: "denied" };
    },
  };
}

describe("shell sandbox: runGuardedShell wrap seam", () => {
  test("disabled: the spawn path is untouched — same command string, same options", async () => {
    spawnCalls.length = 0;
    const noopController = new AbortController();
    const result = await runGuardedShell(
      {
        command: "echo passthrough-check",
        cwd,
        env: { FOO: "bar" },
      },
      noopController.signal,
    );
    expect(result.exitCode).toBe(0);
    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0];
    if (call === undefined) throw new Error("no spawn recorded");
    // Command text is byte-identical; options keep the pre-sandbox shape
    // (checked field-wise so the assertion does not depend on process.env).
    expect(call.command).toBe("echo passthrough-check");
    expect(call.args).toBeUndefined();
    const options = call.options ?? {};
    expect(options).toEqual({
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      cwd,
      detached: process.platform !== "win32",
      env: { ...process.env, FOO: "bar" },
    });
  });

  test("enabled but the sandbox cannot wrap: fail closed, never raw spawn", async () => {
    spawnCalls.length = 0;
    const manager = fakeManager({
      isSupportedPlatform: () => false,
    });
    const sandbox = mustSandbox({
      sessionRoot: cwd,
      settings: settingsWithSandbox(true),
      gate: stubGate(true),
      manager,
    });
    expect(sandbox).toBeDefined();
    const noopController = new AbortController();
    const result = await runGuardedShell(
      { command: "echo should-not-run", cwd, sandbox },
      noopController.signal,
    ).then(
      (ok) => ok,
      (err: unknown) => err,
    );
    expect(result).toBeInstanceOf(Error);
    const message = result instanceof Error ? result.message : String(result);
    expect(message).toContain("shell sandbox is enabled but unavailable");
    expect(message).toContain("The command was not run");
    // The raw command must never reach spawn — the whole point of fail closed.
    expect(spawnCalls).toHaveLength(0);
  });

  test("enabled: spawn receives the wrapped command", async () => {
    spawnCalls.length = 0;
    const manager = fakeManager();
    const sandbox = mustSandbox({
      sessionRoot: cwd,
      settings: settingsWithSandbox(true),
      gate: stubGate(true),
      manager,
    });
    const noopController = new AbortController();
    const result = await runGuardedShell(
      { command: "echo wrapped-check", cwd, sandbox },
      noopController.signal,
    );
    expect(result.exitCode).toBe(0);
    expect(manager.initCalls).toBe(1);
    const call = spawnCalls[0];
    if (call === undefined) throw new Error("no spawn recorded");
    expect(call.command).toBe("srt echo wrapped-check");
  });

  test("enabled: the sandbox initializes once across commands", async () => {
    spawnCalls.length = 0;
    const manager = fakeManager();
    const sandbox = mustSandbox({
      sessionRoot: cwd,
      settings: settingsWithSandbox(true),
      gate: stubGate(true),
      manager,
    });
    const signal = new AbortController().signal;
    await runGuardedShell({ command: "echo one", cwd, sandbox }, signal);
    await runGuardedShell({ command: "echo two", cwd, sandbox }, signal);
    expect(manager.initCalls).toBe(1);
    expect(manager.wraps.length).toBe(2);
  });

  test("network ask outside the allowlist routes through the permission gate", async () => {
    const gate = stubGate(true);
    const manager = fakeManager();
    const sandbox = mustSandbox({
      sessionRoot: cwd,
      settings: settingsWithSandbox(true, ["api.example.com"]),
      gate,
      manager,
    });
    const signal = new AbortController().signal;
    await runGuardedShell({ command: "echo probe", cwd, sandbox }, signal);
    const allowed = await manager.ask("unmatched.example.net", 443);
    expect(allowed).toBe(true);
    expect(gate.calls).toEqual([
      {
        name: "web_fetch",
        url: "https://unmatched.example.net:443",
      },
    ]);
  });
});

describe("shell sandbox: background shell registry seam", () => {
  test("without a sandbox handle: start is unchanged — raw command spawns", async () => {
    spawnCalls.length = 0;
    const registry = createBackgroundShellRegistry();
    const started = await registry.start({ command: "echo raw-bg", cwd });
    expect("error" in started).toBe(false);
    const call = spawnCalls[0];
    if (call === undefined) throw new Error("no spawn recorded");
    expect(call.command).toBe("echo raw-bg");
    registry.disposeAll();
  });

  test("sandbox wrap failure returns the fail-closed error and spawns nothing", async () => {
    spawnCalls.length = 0;
    const manager = fakeManager({
      isSupportedPlatform: () => false,
    });
    const sandbox = mustSandbox({
      sessionRoot: cwd,
      settings: settingsWithSandbox(true),
      gate: stubGate(true),
      manager,
    });
    const registry = createBackgroundShellRegistry({ sandbox });
    const started = await registry.start({ command: "echo denied-bg", cwd });
    expect("error" in started).toBe(true);
    if (!("error" in started)) throw new Error("expected error result");
    expect(started.error).toContain("shell sandbox is enabled but unavailable");
    expect(spawnCalls).toHaveLength(0);
  });

  test("sandbox wrap success spawns the wrapped command", async () => {
    spawnCalls.length = 0;
    const manager = fakeManager();
    const sandbox = mustSandbox({
      sessionRoot: cwd,
      settings: settingsWithSandbox(true),
      gate: stubGate(true),
      manager,
    });
    const registry = createBackgroundShellRegistry({ sandbox });
    const started = await registry.start({ command: "echo wrapped-bg", cwd });
    expect("error" in started).toBe(false);
    const call = spawnCalls[0];
    if (call === undefined) throw new Error("no spawn recorded");
    expect(call.command).toBe("srt echo wrapped-bg");
    expect(manager.initCalls).toBe(1);
    registry.disposeAll();
  });
});
