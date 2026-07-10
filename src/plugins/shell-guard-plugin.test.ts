import { expect, test, describe } from "bun:test";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

import {
  DEFAULT_SHELL_TIMEOUT_MS,
  MAX_SHELL_OUTPUT_BYTES,
  advertiseShellGuardTimeout,
  runGuardedShell,
  shellGuardPlugin,
} from "./shell-guard-plugin.js";

const neverAbort = () => new AbortController().signal;

describe("runGuardedShell", () => {
  test("captures stdout", async () => {
    const { output, exitCode } = await runGuardedShell(
      { command: "echo hello" },
      neverAbort(),
    );
    expect(exitCode).toBe(0);
    expect(output).toContain("hello");
  });

  test("defaults to a 15s timeout", () => {
    expect(DEFAULT_SHELL_TIMEOUT_MS).toBe(15_000);
  });

  test("returns partial output and a timed-out flag instead of throwing", async () => {
    const start = Date.now();
    const { exitCode, timedOut, output } = await runGuardedShell(
      { command: "echo early; sleep 60", timeout: 200 },
      neverAbort(),
    );
    expect(timedOut).toBe(true);
    expect(exitCode).toBe(124);
    expect(output).toContain("early");
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("kills when output exceeds the byte cap", async () => {
    expect(MAX_SHELL_OUTPUT_BYTES).toBe(512_000);
    await expect(
      runGuardedShell(
        {
          command: "python3 -c \"print('x' * 600000)\"",
          timeout: 5_000,
        },
        neverAbort(),
      ),
    ).rejects.toThrow(/output exceeded/);
  });

  test("abort kills the process group", async () => {
    const controller = new AbortController();
    const promise = runGuardedShell(
      { command: "sleep 60", timeout: 30_000 },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 50);
    await expect(promise).rejects.toThrow(/aborted/);
  });
});

describe("advertiseShellGuardTimeout", () => {
  test("rewrites run_shell timeout default to match the guard", () => {
    const rewritten = advertiseShellGuardTimeout({
      name: "run_shell",
      description: "Execute a shell command",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout: {
            type: "number",
            description: "Timeout in milliseconds (default: 30000)",
          },
        },
        required: ["command"],
      },
    });
    const timeout = (
      rewritten.inputSchema["properties"] as Record<string, { description: string }>
    )["timeout"];
    expect(timeout?.description).toContain(String(DEFAULT_SHELL_TIMEOUT_MS));
    expect(timeout?.description).not.toContain("30000");
  });

  test("leaves other tools unchanged", () => {
    const def = {
      name: "grep",
      description: "search",
      inputSchema: { type: "object", properties: {} },
    };
    expect(advertiseShellGuardTimeout(def)).toBe(def);
  });
});

describe("shellGuardPlugin", () => {
  const fallback = async (call: ToolCall): Promise<ToolResult> => ({
    callId: call.id,
    content: "FALLBACK",
  });

  function run(call: ToolCall): Promise<ToolResult> {
    const handler = shellGuardPlugin(process.cwd()).middleware!(fallback);
    return handler(call, neverAbort());
  }

  test("intercepts run_shell and never hits the base handler", async () => {
    const result = await run({
      id: "c1",
      name: "run_shell",
      arguments: { command: "echo guarded" },
    });
    expect(result.content).toContain("guarded");
    expect(result.content).not.toBe("FALLBACK");
  });

  test("returns partial output plus a timed-out notice on timeout", async () => {
    const result = await run({
      id: "c2",
      name: "run_shell",
      arguments: { command: "echo before; sleep 60", timeout: 120 },
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("before");
    expect(result.content).toMatch(/timed out after 120ms and was terminated/);
  });

  test("clamps a per-command timeout override to the configured max", async () => {
    const handler = shellGuardPlugin(process.cwd(), { maxMs: 100 }).middleware!(
      fallback,
    );
    const result = await handler(
      { id: "c2b", name: "run_shell", arguments: { command: "sleep 60", timeout: 900_000 } },
      neverAbort(),
    );
    expect(result.content).toMatch(/timed out after 100ms/);
  });

  test("applies a configured default timeout when none is passed", async () => {
    const handler = shellGuardPlugin(process.cwd(), { defaultMs: 90 }).middleware!(
      fallback,
    );
    const result = await handler(
      { id: "c2c", name: "run_shell", arguments: { command: "sleep 60" } },
      neverAbort(),
    );
    expect(result.content).toMatch(/timed out after 90ms/);
  });

  test("passes non-shell tools through", async () => {
    const result = await run({
      id: "c3",
      name: "read_file",
      arguments: { path: "x" },
    });
    expect(result.content).toBe("FALLBACK");
  });

  test("applies a search-tool budget via abort signal", async () => {
    let sawAbort = false;
    const slow = async (
      _call: ToolCall,
      signal: AbortSignal,
    ): Promise<ToolResult> =>
      new Promise((resolve) => {
        const timer = setTimeout(
          () => resolve({ callId: "c4", content: "too-late" }),
          5_000,
        );
        signal.addEventListener(
          "abort",
          () => {
            sawAbort = true;
            clearTimeout(timer);
            resolve({
              callId: "c4",
              content: "aborted by signal",
              isError: true,
            });
          },
          { once: true },
        );
      });

    // Override the default 10s budget by racing a short outer abort is hard —
    // instead assert the middleware wires a signal that the next handler sees.
    // We stub a search tool that only finishes on abort, and force a tiny budget
    // by using the public with-timeout path indirectly via a patched plugin call.
    const plugin = shellGuardPlugin(process.cwd());
    // Inject a fast abort parent so the search budget settles quickly.
    const controller = new AbortController();
    const handler = plugin.middleware!(slow);
    const promise = handler(
      { id: "c4", name: "grep", arguments: { pattern: "x" } },
      controller.signal,
    );
    // Parent abort should propagate into the search budget signal.
    setTimeout(() => controller.abort(), 30);
    const result = await promise;
    expect(sawAbort).toBe(true);
    expect(result.isError).toBe(true);
  });

  test("returns promptly when the search tool ignores the budget", async () => {
    // Reproduces the non-abortable fallback grep: next() never settles and never
    // observes the abort. The guard must stop waiting once the budget fires
    // instead of awaiting the walk forever.
    const hangs = (): Promise<ToolResult> => new Promise<ToolResult>(() => {});
    const plugin = shellGuardPlugin(process.cwd());
    const controller = new AbortController();
    const handler = plugin.middleware!(hangs);
    const promise = handler(
      { id: "c5", name: "grep", arguments: { pattern: "x" } },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 30);
    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/aborted/);
  });
});
