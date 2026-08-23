import { expect, test, describe } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  BoundedShellOutput,
  DEFAULT_SHELL_TIMEOUT_MS,
  MAX_SHELL_OUTPUT_BYTES,
  advertiseShellGuardTimeout,
  resolveShellTimeoutMs,
  runGuardedShell,
  shellGuardPlugin,
} from "./shell-guard-plugin.js";

const neverAbort = () => new AbortController().signal;

function toolContentTrimmed(result: ToolResult): string {
  const content = result.content;
  return (typeof content === "string" ? content : String(content)).trim();
}

describe("runGuardedShell", () => {
  test("captures stdout", async () => {
    const { output, exitCode } = await runGuardedShell({ command: "echo hello" }, neverAbort());
    expect(exitCode).toBe(0);
    expect(output).toContain("hello");
  });

  test("defaults to a 15s timeout", () => {
    expect(DEFAULT_SHELL_TIMEOUT_MS).toBe(15_000);
  });

  test("merges settings.env into the spawn environment on top of process.env", async () => {
    const { output } = await runGuardedShell(
      { command: "echo $CORBITS_TEST_ENV_VAR", env: { CORBITS_TEST_ENV_VAR: "from-settings" } },
      neverAbort(),
    );
    expect(output).toContain("from-settings");
  });

  test("still inherits process.env when settings.env is provided", async () => {
    const { output } = await runGuardedShell(
      { command: "echo $PATH", env: { CORBITS_TEST_ENV_VAR: "x" } },
      neverAbort(),
    );
    expect(output.trim().length).toBeGreaterThan(0);
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

  test("truncates with head+tail when output exceeds the byte cap", async () => {
    expect(MAX_SHELL_OUTPUT_BYTES).toBe(512_000);
    const cap = 8_192;
    const { output, outputTruncated, exitCode } = await runGuardedShell(
      {
        command: "python3 -c \"print('START' + 'a' * 20000 + 'END' + 'b' * 20000)\"",
        timeout: 5_000,
        maxOutputBytes: cap,
      },
      neverAbort(),
    );
    expect(outputTruncated).toBe(true);
    expect(exitCode).toBe(0);
    expect(output).toContain("START");
    expect(output).toMatch(/END|bbbb/);
    expect(output).toMatch(/command output truncated/);
    expect(output.length).toBeLessThan(cap + 512);
  });

  test("does not return the full oversized payload when truncated", async () => {
    const cap = 4_096;
    const { output, outputTruncated } = await runGuardedShell(
      {
        command: "python3 -c \"print('x' * 600000)\"",
        timeout: 5_000,
        maxOutputBytes: cap,
      },
      neverAbort(),
    );
    expect(outputTruncated).toBe(true);
    expect(output.length).toBeLessThan(cap + 512);
    expect(output).toMatch(/command output truncated/);
  });

  test("BoundedShellOutput keeps head and tail slices under cap", () => {
    const cap = 200;
    const collector = new BoundedShellOutput(cap);
    const chunk = Buffer.from("a".repeat(80));
    expect(collector.append(chunk)).toBe(false);
    expect(collector.append(chunk)).toBe(false);
    expect(collector.append(chunk)).toBe(true);
    const { output, truncated } = collector.build();
    expect(truncated).toBe(true);
    expect(output.startsWith("a")).toBe(true);
    expect(output).toMatch(/command output truncated/);
    expect(output.length).toBeLessThanOrEqual(cap + 256);
  });

  test("timeout kills grandchildren in a shell pipeline", async () => {
    if (process.platform === "win32") return;
    const token = `ic_guard_orphan_${randomUUID()}`;
    const cmd = `bash -c 'IC_GUARD_TAG=${token} sleep 600 & IC_GUARD_TAG=${token} exec sleep 600'`;
    await runGuardedShell({ command: cmd, timeout: 250 }, neverAbort());
    await new Promise((r) => setTimeout(r, 300));
    const probe = spawnSync("pgrep", ["-f", token], { encoding: "utf8" });
    expect(probe.stdout?.trim() ?? "").toBe("");
    expect(probe.status).not.toBe(0);
  });

  test("abort kills grandchildren in a shell pipeline", async () => {
    if (process.platform === "win32") return;
    const token = `ic_guard_abort_${randomUUID()}`;
    const cmd = `bash -c 'IC_GUARD_TAG=${token} sleep 600 & IC_GUARD_TAG=${token} exec sleep 600'`;
    const controller = new AbortController();
    const promise = runGuardedShell({ command: cmd, timeout: 30_000 }, controller.signal);
    setTimeout(() => controller.abort(), 80);
    await expect(promise).rejects.toThrow(/aborted/);
    await new Promise((r) => setTimeout(r, 300));
    const probe = spawnSync("pgrep", ["-f", token], { encoding: "utf8" });
    expect(probe.stdout?.trim() ?? "").toBe("");
    expect(probe.status).not.toBe(0);
  });

  test("abort kills the process group", async () => {
    const controller = new AbortController();
    const promise = runGuardedShell({ command: "sleep 60", timeout: 30_000 }, controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(promise).rejects.toThrow(/aborted/);
  });
});

describe("resolveShellTimeoutMs", () => {
  test("omitted timeout uses the 15s default", () => {
    expect(resolveShellTimeoutMs(undefined, DEFAULT_SHELL_TIMEOUT_MS)).toBe(15_000);
    expect(resolveShellTimeoutMs(undefined, DEFAULT_SHELL_TIMEOUT_MS, undefined)).toBe(
      DEFAULT_SHELL_TIMEOUT_MS,
    );
  });

  test("non-positive requested timeout falls back to default", () => {
    expect(resolveShellTimeoutMs(0, DEFAULT_SHELL_TIMEOUT_MS)).toBe(DEFAULT_SHELL_TIMEOUT_MS);
    expect(resolveShellTimeoutMs(-1, DEFAULT_SHELL_TIMEOUT_MS)).toBe(DEFAULT_SHELL_TIMEOUT_MS);
  });

  test("requested timeout well above 10 minutes is not clamped when maxMs is omitted", () => {
    expect(resolveShellTimeoutMs(5_400_000, DEFAULT_SHELL_TIMEOUT_MS)).toBe(5_400_000);
    expect(resolveShellTimeoutMs(5_400_000, DEFAULT_SHELL_TIMEOUT_MS, undefined)).toBe(5_400_000);
    expect(resolveShellTimeoutMs(900_000, DEFAULT_SHELL_TIMEOUT_MS)).toBe(900_000);
  });

  test("configured maxMs still clamps", () => {
    expect(resolveShellTimeoutMs(900_000, DEFAULT_SHELL_TIMEOUT_MS, 100)).toBe(100);
    expect(resolveShellTimeoutMs(5_400_000, DEFAULT_SHELL_TIMEOUT_MS, 600_000)).toBe(600_000);
    expect(resolveShellTimeoutMs(undefined, DEFAULT_SHELL_TIMEOUT_MS, 100)).toBe(100);
  });

  test("requested below maxMs is unchanged", () => {
    expect(resolveShellTimeoutMs(1_000, DEFAULT_SHELL_TIMEOUT_MS, 600_000)).toBe(1_000);
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

  test("plugin-level env is applied to run_shell's spawn environment", async () => {
    const handler = shellGuardPlugin(process.cwd(), undefined, {
      CORBITS_TEST_ENV_VAR: "plugin-env",
    }).middleware!(fallback);
    const result = await handler(
      { id: "c-env", name: "run_shell", arguments: { command: "echo $CORBITS_TEST_ENV_VAR" } },
      neverAbort(),
    );
    expect(result.content).toContain("plugin-env");
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
    const handler = shellGuardPlugin(process.cwd(), { maxMs: 100 }).middleware!(fallback);
    const result = await handler(
      { id: "c2b", name: "run_shell", arguments: { command: "sleep 60", timeout: 900_000 } },
      neverAbort(),
    );
    expect(result.content).toMatch(/timed out after 100ms/);
  });

  test("applies a configured default timeout when none is passed", async () => {
    const handler = shellGuardPlugin(process.cwd(), { defaultMs: 90 }).middleware!(fallback);
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

  test("passes through stock read_file timeout copy without rewriting", async () => {
    const stockTimeout = async (call: ToolCall): Promise<ToolResult> => ({
      callId: call.id,
      content:
        "     1\tpartial\n\nread_file [timed out before completing] for big.log — use a smaller offset/limit. This is not an empty file.",
      isError: true,
    });
    const handler = shellGuardPlugin(process.cwd()).middleware!(stockTimeout);
    const result = await handler(
      { id: "c3b", name: "read_file", arguments: { path: "big.log" } },
      neverAbort(),
    );
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("[timed out before completing]");
    expect(String(result.content)).toContain("not an empty file");
  });

  test("applies a search-tool budget via abort signal", async () => {
    let sawAbort = false;
    const slow = async (_call: ToolCall, signal: AbortSignal): Promise<ToolResult> =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ callId: "c4", content: "too-late" }), 5_000);
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

  test("rejects retaining cwd outside the session workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "ic-escape-cwd-"));
    const handler = shellGuardPlugin(root).middleware!(fallback);
    const escaped = await handler(
      { id: "e1", name: "run_shell", arguments: { command: "cd .. && pwd" } },
      neverAbort(),
    );
    expect(escaped.isError).toBe(true);
    expect(escaped.content).toMatch(/outside the session workspace/);
    const stillRoot = await handler(
      { id: "e2", name: "run_shell", arguments: { command: "pwd" } },
      neverAbort(),
    );
    expect(toolContentTrimmed(stillRoot)).toBe(realpathSync(root));
  });

  test("allowOutsideCwd getter allows retaining cwd outside the session workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "ic-escape-cwd-yolo-"));
    let allow = false;
    const handler = shellGuardPlugin(root, undefined, undefined, {
      allowOutsideCwd: () => allow,
    }).middleware!(fallback);
    const blocked = await handler(
      { id: "e1", name: "run_shell", arguments: { command: "cd .. && pwd" } },
      neverAbort(),
    );
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toMatch(/outside the session workspace/);

    allow = true;
    const allowed = await handler(
      { id: "e2", name: "run_shell", arguments: { command: "cd .. && pwd" } },
      neverAbort(),
    );
    expect(allowed.isError).not.toBe(true);
    expect(toolContentTrimmed(allowed)).toBe(realpathSync(join(root, "..")));
  });

  test("retains cwd from cd even when the command exits non-zero", async () => {
    const root = await mkdtemp(join(tmpdir(), "ic-cd-fail-"));
    const nested = join(root, "nested");
    await mkdir(nested);
    const handler = shellGuardPlugin(root).middleware!(fallback);
    const fail = await handler(
      { id: "cf1", name: "run_shell", arguments: { command: "cd nested && false" } },
      neverAbort(),
    );
    expect(String(fail.content)).toMatch(/exit code/);
    const pwd = await handler(
      { id: "cf2", name: "run_shell", arguments: { command: "pwd" } },
      neverAbort(),
    );
    expect(String(pwd.content).trim()).toBe(realpathSync(nested));
  });

  test("retains cwd across successive run_shell calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "ic-retain-cwd-"));
    const sub = join(root, "nested");
    await mkdir(sub);
    const handler = shellGuardPlugin(root).middleware!(fallback);
    const cdResult = await handler(
      { id: "cd1", name: "run_shell", arguments: { command: "cd nested" } },
      neverAbort(),
    );
    expect(cdResult.isError).toBeUndefined();
    const pwdResult = await handler(
      { id: "pwd1", name: "run_shell", arguments: { command: "pwd" } },
      neverAbort(),
    );
    expect(toolContentTrimmed(pwdResult)).toBe(realpathSync(sub));
  });

  test("per-call cwd override does not change retained cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "ic-override-cwd-"));
    const sub = join(root, "other");
    await mkdir(sub);
    const handler = shellGuardPlugin(root).middleware!(fallback);
    await handler(
      { id: "o1", name: "run_shell", arguments: { command: "cd other" } },
      neverAbort(),
    );
    const override = await handler(
      {
        id: "o2",
        name: "run_shell",
        arguments: { command: "pwd", cwd: root },
      },
      neverAbort(),
    );
    expect(toolContentTrimmed(override)).toBe(realpathSync(root));
    const retained = await handler(
      { id: "o3", name: "run_shell", arguments: { command: "pwd" } },
      neverAbort(),
    );
    expect(toolContentTrimmed(retained)).toBe(realpathSync(sub));
  });

  test("separate plugin instances keep isolated retained cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "ic-isolate-cwd-"));
    const a = join(root, "a");
    const b = join(root, "b");
    await mkdir(a);
    await mkdir(b);
    const handlerA = shellGuardPlugin(root).middleware!(fallback);
    const handlerB = shellGuardPlugin(root).middleware!(fallback);
    await handlerA({ id: "ia", name: "run_shell", arguments: { command: "cd a" } }, neverAbort());
    await handlerB({ id: "ib", name: "run_shell", arguments: { command: "cd b" } }, neverAbort());
    const pwdA = await handlerA(
      { id: "pa", name: "run_shell", arguments: { command: "pwd" } },
      neverAbort(),
    );
    const pwdB = await handlerB(
      { id: "pb", name: "run_shell", arguments: { command: "pwd" } },
      neverAbort(),
    );
    expect(toolContentTrimmed(pwdA)).toBe(realpathSync(a));
    expect(toolContentTrimmed(pwdB)).toBe(realpathSync(b));
  });

  test("serializes concurrent run_shell so retained cwd stays coherent", async () => {
    const root = await mkdtemp(join(tmpdir(), "ic-serial-cwd-"));
    const nested = join(root, "nested");
    await mkdir(nested);
    const handler = shellGuardPlugin(root).middleware!(fallback);
    // Barrier: hold a non-cd command open while a cd is enqueued behind it.
    // Without serialization the waiter would finish after cd and clobber cwd.
    const release = join(root, "release");
    const waitCmd = `while [ ! -f ${JSON.stringify(release)} ]; do :; done; true`;
    const waitPromise = handler(
      { id: "s1", name: "run_shell", arguments: { command: waitCmd } },
      neverAbort(),
    );
    // Give the waiter a chance to enter the busy loop before enqueuing cd.
    await new Promise((r) => setTimeout(r, 30));
    const cdPromise = handler(
      { id: "s2", name: "run_shell", arguments: { command: "cd nested" } },
      neverAbort(),
    );
    // Release the waiter; under serialization cd runs only after it finishes.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(release, "go");
    await Promise.all([waitPromise, cdPromise]);
    const pwd = await handler(
      { id: "s3", name: "run_shell", arguments: { command: "pwd" } },
      neverAbort(),
    );
    expect(toolContentTrimmed(pwd)).toBe(realpathSync(nested));
  });

  test("serializes concurrent absolute cds in enqueue order", async () => {
    const root = await mkdtemp(join(tmpdir(), "ic-serial-fifo-"));
    const a = join(root, "a");
    const b = join(root, "b");
    await mkdir(a);
    await mkdir(b);
    const handler = shellGuardPlugin(root).middleware!(fallback);
    await Promise.all([
      handler(
        { id: "f1", name: "run_shell", arguments: { command: `cd ${JSON.stringify(a)}` } },
        neverAbort(),
      ),
      handler(
        { id: "f2", name: "run_shell", arguments: { command: `cd ${JSON.stringify(b)}` } },
        neverAbort(),
      ),
    ]);
    const pwd = await handler(
      { id: "f3", name: "run_shell", arguments: { command: "pwd" } },
      neverAbort(),
    );
    // Last enqueued cd wins under serial execution.
    expect(toolContentTrimmed(pwd)).toBe(realpathSync(b));
  });

  test("surfaces a clear error when retained cwd is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "ic-missing-cwd-"));
    const handler = shellGuardPlugin(root).middleware!(fallback);
    const gone = join(root, "removed");
    await mkdir(gone);
    await handler(
      { id: "m1", name: "run_shell", arguments: { command: `cd ${gone}` } },
      neverAbort(),
    );
    const { rm } = await import("node:fs/promises");
    await rm(gone, { recursive: true, force: true });
    const result = await handler(
      { id: "m2", name: "run_shell", arguments: { command: "pwd" } },
      neverAbort(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Shell working directory does not exist/);
    expect(result.content).toContain("removed");
  });

  test("per-call relative cwd resolves against session root not process cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "ic-percall-cwd-"));
    const marker = join(root, "markerdir");
    await mkdir(marker);
    const { writeFile } = await import("node:fs/promises");
    const { chdir } = await import("node:process");
    await writeFile(join(marker, "tag"), "session-tag");
    const otherRoot = await mkdtemp(join(tmpdir(), "ic-process-cwd-"));
    const otherMarker = join(otherRoot, "markerdir");
    await mkdir(otherMarker);
    await writeFile(join(otherMarker, "tag"), "wrong-tag");
    const prev = process.cwd();
    try {
      await chdir(otherRoot);
      const handler = shellGuardPlugin(root).middleware!(fallback);
      const result = await handler(
        {
          id: "pc1",
          name: "run_shell",
          arguments: { command: "cat tag", cwd: "markerdir" },
        },
        neverAbort(),
      );
      expect(String(result.content)).toContain("session-tag");
      expect(String(result.content)).not.toContain("wrong-tag");
    } finally {
      await chdir(prev);
    }
  });

  test("treats timeout 0 as the configured default", async () => {
    const handler = shellGuardPlugin(process.cwd(), { defaultMs: 90, maxMs: 100 }).middleware!(
      fallback,
    );
    const result = await handler(
      { id: "tz", name: "run_shell", arguments: { command: "sleep 60", timeout: 0 } },
      neverAbort(),
    );
    expect(result.content).toMatch(/timed out after 90ms/);
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
